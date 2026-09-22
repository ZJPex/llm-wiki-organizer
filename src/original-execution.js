import path from 'node:path';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import {atomicRename} from './atomic-rename.js';
import { createHash, randomUUID } from 'node:crypto';
import { readRecoveryEvidence } from './recovery.js';
import { safePath, verifyBackup } from './backup.js';
import { inventory } from './compatibility.js';
import { planDigest } from './categories.js';
import { compileBatchPlan } from './batch-plan.js';
import { describeLogicalPlan, executeCompiledMigration } from './migration.js';
import { analyzeLinks } from './links.js';
import { analyzeSharedOutputs } from './shared-outputs.js';
import { analyzeIndexes } from './indexes.js';
import { nativeRescanVerifier, requireQuietRescan } from './migration-verifier.js';
import { canonicalPath } from './filesystem-paths.js';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const hashFile = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const activeRoots = new Set();
const same = (a,b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
async function evidencePaths(input){const result={...input};for(const key of ['planManifestPath','validationJournalPath','recoveryReportPath']){if(typeof input[key]!=='string'||!path.isAbsolute(input[key]))fail('INVALID_EVIDENCE','证据必须为绝对路径');result[key]=await canonicalPath(input[key]);}return result;}
async function json(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('INVALID_EVIDENCE', '证据必须为绝对路径');
  await safePath(path.dirname(file)); const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('INVALID_EVIDENCE', '证据必须为独立普通文件');
  return JSON.parse(await readFile(file, 'utf8'));
}
function checkHash(record, field) { const { [field]: expected, ...data } = record; if (!expected || planDigest(data) !== expected) fail('INVALID_EVIDENCE', '证据哈希不一致'); }
async function persist(file, data) { delete data.resultHash; data.resultHash = planDigest(data); const temporary = `${file}.tmp-${randomUUID()}`; await writeFile(temporary, JSON.stringify(data,null,2), { flag:'wx' }); await atomicRename(temporary,file); }
function requireSuccess(journal, manifest) {
  if (!['complete','partial'].includes(journal.status) || journal.phase !== 'verified-copy' || journal.targetRole !== 'validation' || journal.modelAttempts?.length !== 0) fail('VALIDATION_REQUIRED', '验证副本尚未成功或存在模型尝试');
  const items = manifest.logicalPlan.items, selected = items.filter(item => item.status === 'selected');
  if (!selected.length || !Array.isArray(journal.items) || journal.items.length !== items.length) fail('VALIDATION_REQUIRED', '缺少已成功的冻结执行范围');
  for (const item of items) {
    const actual = journal.items.find(value => value.id === item.id);
    if (!actual || actual.from !== item.from || actual.to !== item.to || actual.status !== (item.status === 'selected' ? 'succeeded' : item.status)) fail('VALIDATION_REQUIRED', '所选项目未全部成功或验证范围变化');
  }
  requireQuietRescan(journal.beforeProof); requireQuietRescan(journal.afterProof);
  if (manifest.logicalPlan.indexes?.status === 'ready' && (journal.indexProof?.status !== 'verified' || journal.indexProof.tables.some(table => !table.vectorsPreserved))) fail('VALIDATION_REQUIRED', '索引验证未通过');
  return selected;
}
async function evidence(input) {
  input=await evidencePaths(input);
  if (input.writersPaused !== true) fail('WRITERS_NOT_PAUSED', '原库执行前必须暂停全部外部写入');
  const value = await readRecoveryEvidence(input.validationJournalPath), { journal, manifest, backup } = value;
  if (!same(input.planManifestPath, journal.planManifestPath) || !same(manifest.targetRoot, backup.validationPath) || journal.batchId !== backup.batchId) fail('INVALID_EVIDENCE', '计划、验证日志与备份不是同一批');
  const selected = requireSuccess(journal, manifest);
  const recovery = await json(input.recoveryReportPath); checkHash(recovery,'reportHash');
  const recoveryPlan = await json(recovery.recoveryPlanPath); checkHash(recoveryPlan,'recoveryPlanHash');
  if (recovery.recoveryPlanHash !== recoveryPlan.recoveryPlanHash || !same(input.recoveryReportPath,`${recovery.recoveryPlanPath}.result.json`) || recovery.status !== 'complete' || recovery.mode !== 'new-directory' || recovery.targetRole !== 'validation' || !recovery.backupUnchanged || recovery.modelAttempts?.length !== 0) fail('RECOVERY_REQUIRED', '须先通过保留验证副本的独立目录恢复演练');
  if (recovery.logicalPlanHash !== manifest.logicalPlanHash || recovery.planManifestHash !== manifest.manifestHash || recovery.backupManifestHash !== manifest.backupManifestHash || recovery.batchId !== backup.batchId || !same(recovery.sourceJournalPath,input.validationJournalPath) || recovery.sourceJournalHash !== await hashFile(input.validationJournalPath)) fail('INVALID_EVIDENCE', '恢复演练未绑定本次成功验证证据');
  requireQuietRescan(recovery.verification?.proof);
  if (!same(recovery.targetRoot,backup.validationPath) || same(recovery.restoreRoot,backup.originalPath) || same(recovery.restoreRoot,backup.backupPath) || same(recovery.restoreRoot,backup.validationPath)) fail('INVALID_EVIDENCE', '恢复工作目录不独立');
  await safePath(recovery.restoreRoot);
  if ((await inventory(recovery.restoreRoot)).hash !== recovery.afterBaseline?.hash) fail('STALE_EVIDENCE', '恢复演练目录已改变');
  if ((await inventory(backup.validationPath)).hash !== journal.afterBaseline?.hash) fail('STALE_EVIDENCE', '迁移后验证副本已改变');
  await verifyBackup(backup.originalPath,backup.baseline,backup.directories);
  const originalIdentity = await json(path.join(backup.originalPath,'.llm-wiki/project.json'));
  const validationIdentity = await json(path.join(backup.validationPath,'.llm-wiki/project.json'));
  if (originalIdentity.id !== backup.relocation.originalProjectId || validationIdentity.id !== backup.relocation.validationProjectId || originalIdentity.id === validationIdentity.id) fail('INVALID_IDENTITY', '原库与验证副本身份不正确');
  const pointer = await json(`${backup.validationPath}.active-plan.json`);
  if (pointer.planId !== manifest.planId || pointer.logicalPlanHash !== manifest.logicalPlanHash) fail('STALE_EVIDENCE', '验证方案已被替换');
  return { ...value, recovery, selected };
}

export function createOriginalExecutionService({ verify = nativeRescanVerifier(), checkpoint = async () => {} } = {}) {
  async function compile(input) {
    const proof = await evidence(input), { backup, manifest } = proof;
    // 仅物理执行上下文变化；不修改原库身份，也不复制副本状态到原库。
    const physical = { ...backup, validationPath: backup.originalPath, relocation: { ...backup.relocation, validationProjectId: backup.relocation.originalProjectId } };
    const baseline = await inventory(backup.originalPath);
    const compiled = await compileBatchPlan(manifest.request,physical,baseline,{ analyzeLinks,analyzeShared:analyzeSharedOutputs,analyzeIndex:analyzeIndexes });
    const description = await describeLogicalPlan(compiled,physical,manifest.request.executionGroupSize);
    if (planDigest(description.logicalPlan) !== manifest.logicalPlanHash) fail('PLAN_MISMATCH', '原库确定性方案与已验证冻结决策不同');
    await verifyBackup(backup.originalPath,backup.baseline,backup.directories);
    return { ...proof, physical, baseline, compiled, description };
  }
  async function prepare(input) {
    input=await evidencePaths(input);
    const proof = await compile(input), { backup, manifest, journal, recovery, selected } = proof;
    const id = input.authorizationId??randomUUID();if(!/^[0-9a-f-]{36}$/i.test(id))fail('INVALID_AUTHORIZATION','授权标识无效');const authorizationPlanPath = `${backup.originalPath}.authorization-${id}.json`;
    const record = { schemaVersion:1, authorizationId:id, authorizationPlanPath, status:'awaiting-review', planId:manifest.planId, logicalPlanHash:manifest.logicalPlanHash, planManifestHash:manifest.manifestHash,
      planManifestPath:input.planManifestPath, validationJournalPath:input.validationJournalPath, validationJournalHash:await hashFile(input.validationJournalPath), recoveryReportPath:input.recoveryReportPath, recoveryReportHash:recovery.reportHash,
      backupManifestHash:manifest.backupManifestHash, originalPath:backup.originalPath, backupPath:backup.backupPath, validationPath:backup.validationPath, recoveryPath:recovery.restoreRoot, originalProjectId:backup.relocation.originalProjectId,
      baselineHash:backup.baseline.hash, validationAfterHash:journal.afterBaseline.hash, batchId:backup.batchId, items:manifest.logicalPlan.items, selectedItems:selected, directories:manifest.logicalPlan.directories, links:manifest.logicalPlan.links, indexes:manifest.logicalPlan.indexes };
    record.authorizationHash = planDigest(record); await writeFile(authorizationPlanPath,JSON.stringify(record,null,2),{flag:'wx'}); return record;
  }
  async function execute(input) {
    if (input.approved !== true || input.writersPaused !== true) fail('REVIEW_REQUIRED','请审核原库方案并暂停全部写入');
    if(typeof input.authorizationPlanPath!=='string'||!path.isAbsolute(input.authorizationPlanPath))fail('INVALID_EVIDENCE','审核方案必须为绝对路径');
    input={...input,authorizationPlanPath:await canonicalPath(input.authorizationPlanPath)};
    const authorization = await json(input.authorizationPlanPath); checkHash(authorization,'authorizationHash');
    if (!same(input.authorizationPlanPath,authorization.authorizationPlanPath) || !same(input.authorizationPlanPath,`${authorization.originalPath}.authorization-${authorization.authorizationId}.json`)) fail('INVALID_EVIDENCE','原库审核文件位置无效');
    const root = authorization.originalPath.toLowerCase(); if (activeRoots.has(root)) fail('ORIGINAL_BUSY','原库已有正在执行的任务'); activeRoots.add(root);
    try {
      const proof = await compile({...authorization,writersPaused:true});
      const { backup,manifest,journal,recovery,physical,baseline,compiled,description } = proof;
      if (authorization.logicalPlanHash !== manifest.logicalPlanHash || authorization.planManifestHash !== manifest.manifestHash || authorization.baselineHash !== baseline.hash || authorization.backupManifestHash !== manifest.backupManifestHash || authorization.validationJournalHash !== await hashFile(authorization.validationJournalPath) || authorization.recoveryReportHash !== recovery.reportHash || !same(authorization.originalPath,backup.originalPath)) fail('STALE_EVIDENCE','原库审核后证据已变化');
      const resultPath = `${input.authorizationPlanPath}.result.json`, journalPath = `${backup.originalPath}.migration-${manifest.planId}.json`;
      const pending = { schemaVersion:1,status:'running',authorizationPlanPath:input.authorizationPlanPath,authorizationHash:authorization.authorizationHash,resultPath,journalPath,originalPath:backup.originalPath,backupPath:backup.backupPath,validationPath:backup.validationPath,recoveryPath:recovery.restoreRoot,logicalPlanHash:manifest.logicalPlanHash,planId:manifest.planId,targetRole:'original',targetRoot:backup.originalPath,recovery:{url:'/recovery',journalPath,automaticRollback:false} };
      pending.resultHash=planDigest(pending); await writeFile(resultPath,JSON.stringify(pending,null,2),{flag:'wx'});
      const current = { ...compiled,backup:physical,baseline,record:manifest,reportPath:manifest.backupReportPath,activePlanPath:`${backup.validationPath}.active-plan.json`,used:false,
        result:{planId:manifest.planId,planManifestPath:authorization.planManifestPath,logicalPlanHash:manifest.logicalPlanHash,batchId:backup.batchId,items:compiled.items,executionGroups:manifest.logicalPlan.executionGroups,directoryMappings:description.directoryMappings,newDirectories:description.newDirectories,indexes:compiled.indexes,links:compiled.links,originalPath:backup.originalPath,authorizationPlanPath:input.authorizationPlanPath} };
      let result;
      try {
        result=await executeCompiledMigration(current,{planId:manifest.planId,approved:true,writersPaused:true},{verify,checkpoint,targetRole:'original',revalidate:()=>evidence({...authorization,writersPaused:true}),verifyProtected:async()=>{
          if ((await inventory(backup.validationPath)).hash!==journal.afterBaseline.hash) fail('STALE_EVIDENCE','执行期间验证副本变化');
          if ((await json(path.join(backup.originalPath,'.llm-wiki/project.json'))).id!==backup.relocation.originalProjectId) fail('INVALID_IDENTITY','原库身份被改变');
        }});
      } catch(error) { result={status:'failed',error:{code:error.code??'ORIGINAL_FAILED',message:error.message},journalPath}; }
      const report={...pending,...result,status:result.status,targetRole:'original',targetRoot:backup.originalPath,originalPath:backup.originalPath,backupPath:backup.backupPath,validationPath:backup.validationPath,recoveryPath:recovery.restoreRoot,resultPath,recovery:{url:'/recovery',journalPath,automaticRollback:false}}; await persist(resultPath,report); return report;
    } finally { activeRoots.delete(root); }
  }
  async function get({resultPath}) {
    if(typeof resultPath!=='string'||!path.isAbsolute(resultPath))fail('INVALID_EVIDENCE','结果必须为绝对路径');resultPath=await canonicalPath(resultPath);
    const report=await json(resultPath);checkHash(report,'resultHash');if(!same(resultPath,`${report.authorizationPlanPath}.result.json`))fail('INVALID_EVIDENCE','结果路径无效');
    const authorization=await json(report.authorizationPlanPath);checkHash(authorization,'authorizationHash');
    if(report.authorizationHash!==authorization.authorizationHash)fail('INVALID_EVIDENCE','结果与审核记录不一致');
    if(report.status==='running'){
      try{
        const {journal}=await readRecoveryEvidence(report.journalPath);
        if(journal.targetRole!=='original'||journal.logicalPlanHash!==authorization.logicalPlanHash||journal.planId!==authorization.planId)fail('INVALID_EVIDENCE','执行日志不属于本次审核');
        // 查询不重试写操作；仅公开阶段和状态，不暴露恢复所需的正文原像。
        return {...report,status:journal.status,phase:journal.phase,items:journal.items,executionGroups:journal.executionGroups,groupProgress:journal.groupProgress,error:journal.error,modelAttempts:journal.modelAttempts,interrupted:!activeRoots.has(authorization.originalPath.toLowerCase())};
      }catch(error){if(error.code!=='ENOENT')throw error;}
    }
    return report;
  }
  return {prepare,execute,get,prepareOriginalExecution:prepare,executeOriginal:execute};
}
