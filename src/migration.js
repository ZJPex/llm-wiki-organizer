import {executionGroups,createExpectedState} from './execution-groups.js';
import { copyFile, lstat, mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inventory } from './compatibility.js';
import { safePath, verifyBackup } from './backup.js';
import { modelGuard, nativeRescanVerifier, requireQuietRescan } from './migration-verifier.js';
import { analyzeLinks as repairLinks } from './links.js';
import { analyzeSharedOutputs } from './shared-outputs.js';
import { analyzeIndexes, executeIndexMigration } from './indexes.js';
import { compileBatchPlan } from './batch-plan.js';
import { planDigest } from './categories.js';
import { canonicalPath } from './filesystem-paths.js';
import {recordKind,relocateRecord} from './relocation-records.js';
import {atomicRename} from './atomic-rename.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const key = value => value.replaceAll('\\', '/').toLowerCase();
const within = (root, target) => key(target) === key(root) || key(target).startsWith(`${key(root)}/`);
const md5 = value => createHash('md5').update(value).digest('hex');
const activeValidationRoots = new Set();
function relativeOutput(root, value) {
  if (typeof value !== 'string') fail('UNKNOWN_ASSOCIATION', '产出路径类型未知');
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    if (!within(root, value)) fail('EXTERNAL_ASSOCIATION', '产出不在验证副本内');
    return value.replaceAll('\\', '/').slice(root.replaceAll('\\', '/').length + 1);
  }
  if (value.includes('\\') || value.split('/').includes('..')) fail('EXTERNAL_ASSOCIATION', '产出路径无法规范化');
  return value;
}
async function loadReport(reportPath) {
  if (typeof reportPath !== 'string' || !path.isAbsolute(reportPath)) fail('INVALID_REPORT', '请选择已完成备份的结果报告绝对路径');
  const backup = JSON.parse(await readFile(reportPath, 'utf8'));
  if (backup.status !== 'complete' || !backup.backupVerified || !backup.validationVerified || !backup.version?.verifiedSource || !backup.relocation?.validationProjectId) fail('INVALID_REPORT', '备份或验证副本尚未通过校验');
  const roots = await Promise.all([backup.originalPath, backup.backupPath, backup.validationPath].map(root => safePath(root)));
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) if (within(roots[i], roots[j]) || within(roots[j], roots[i])) fail('OVERLAPPING_PATHS', '三份数据位置不独立');
  if (roots.some((root, i) => key(root) !== key([backup.originalPath, backup.backupPath, backup.validationPath][i]))) fail('INVALID_REPORT', '报告路径发生重定向');
  await verifyBackup(backup.backupPath, backup.baseline, backup.directories);
  await verifyBackup(backup.originalPath, backup.baseline, backup.directories);
  await verifyBackup(backup.validationPath, backup.validationBaseline, backup.directories);
  const identity = JSON.parse(await readFile(path.join(backup.validationPath, '.llm-wiki/project.json'), 'utf8'));
  if (identity.id !== backup.relocation.validationProjectId || identity.id === backup.relocation.originalProjectId) fail('INVALID_IDENTITY', '验证副本缺少独立身份');
  return backup;
}

export function createMigrationService({ verify = nativeRescanVerifier(), checkpoint = async () => {}, analyzeLinks = repairLinks, analyzeShared = analyzeSharedOutputs, analyzeIndex = analyzeIndexes,executionGroupSize=20 } = {}) {
  const plans = new Map();
  async function plan(input, restored = null) {
    if (input.writersPaused !== true) fail('WRITERS_NOT_PAUSED', '请先暂停全部外部写入');
    input={...input,executionGroupSize:input.executionGroupSize??executionGroupSize};
    const backup = await loadReport(input.reportPath);
    const baseline = await inventory(backup.validationPath);
    const compiled = await compileBatchPlan(input, backup, baseline, { analyzeLinks, analyzeShared, analyzeIndex });
    const id = restored?.planId ?? randomUUID();
    const { logicalPlan, directoryMappings, newDirectories } = await describeLogicalPlan(compiled, backup,input.executionGroupSize);
    const logicalPlanHash = planDigest(logicalPlan);
    if (restored && (restored.logicalPlanHash !== logicalPlanHash || restored.baselineHash !== baseline.hash)) fail('STALE_PLAN', '持久化计划与当前确定性结果不一致');
    const planManifestPath = `${backup.validationPath}.plan-${id}.json`;
    const request = Object.fromEntries(['reportPath', 'oldPath', 'newPath', 'mappings', 'evolutionPlan', 'exclusions', 'linkResolutions','executionGroupSize'].filter(name => input[name] !== undefined).map(name => [name, input[name]]));
    request.writersPaused = true;
    const backupManifestHash = createHash('sha256').update(await readFile(input.reportPath)).digest('hex');
    const record = { schemaVersion: 1, planId: id, logicalPlanHash, logicalPlan, baselineHash: baseline.hash, beforeBaseline: baseline, backupReportPath: input.reportPath, backupManifestHash, request, targetRole: 'validation', targetRoot: backup.validationPath };
    record.manifestHash = planDigest(record);
    if (!restored) {
      await writeFile(planManifestPath, JSON.stringify(record, null, 2), { flag: 'wx' });
      const activePath = `${backup.validationPath}.active-plan.json`;
      const previous = await readFile(activePath, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (previous && (JSON.parse(previous).schemaVersion !== 1 || JSON.parse(previous).targetRoot !== backup.validationPath)) fail('INVALID_PLAN', '活动计划文件不属于当前验证副本');
      const temporary = `${activePath}.tmp-${randomUUID()}`;
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, targetRoot: backup.validationPath, planId: id, logicalPlanHash }), { flag: 'wx' });
      await atomicRename(temporary, activePath);
    }
    else if (record.manifestHash !== restored.manifestHash) fail('STALE_PLAN', '计划清单或备份报告已改变');
    const first = compiled.selectedSources[0];
    const result = { planId: id, planManifestPath, logicalPlanHash, planHash: logicalPlanHash, status: compiled.moves?.length ? 'awaiting-review' : 'blocked', batchId: backup.batchId,
      validationPath: backup.validationPath, mapping: first ? { oldPath: first.from, newPath: first.to } : null, summaryMapping: first ? { oldPath: first.summaryFrom, newPath: first.summaryTo } : null,
      items: compiled.items, dependencies: compiled.dependencies, executionGroups:logicalPlan.executionGroups,directoryMappings, newDirectories,
      affectedPages: compiled.affectedPages ?? [], links: compiled.links ?? null, uncachedReferences: compiled.uncachedReferences ?? [], associations: compiled.associations ?? {}, indexes: compiled.indexes ?? { status: 'absent', tables: [], pageMoves: [] },
      operations: [...(compiled.moves ?? []).map(move => ({ type: 'move', ...move })), ...[...(compiled.changes?.keys() ?? [])].map(file => ({ type: compiled.links?.repairs.some(repair => repair.path === file) ? 'links' : 'metadata', path: file })), { type: 'snapshot', path: '.llm-wiki/file-snapshot.json' }], baselineHash: baseline.hash, originalExecutionAllowed: false };
    plans.set(id, { ...compiled, result, backup, reportPath: input.reportPath, baseline, used: false, record });
    return structuredClone(result);
  }

  async function execute(input) {
    if (!plans.has(input.planId) && input.planManifestPath) {
      const record = JSON.parse(await readFile(input.planManifestPath, 'utf8'));
      const { manifestHash, ...rest } = record;
      if (record.schemaVersion !== 1 || planDigest(rest) !== manifestHash || record.planId !== input.planId) fail('INVALID_PLAN', '持久化计划损坏或标识不符');
      if (key(await canonicalPath(input.planManifestPath)) !== key(await canonicalPath(`${record.targetRoot}.plan-${record.planId}.json`))) fail('INVALID_PLAN', '计划文件位置与记录不符');
      await plan(record.request, record);
    }
    const current = plans.get(input.planId);
    if (!current) fail('REVIEW_REQUIRED', '计划不存在或已失效');
    const target = key(current.backup.validationPath);
    if (activeValidationRoots.has(target)) fail('MIGRATION_BUSY', '该验证副本已有正在执行的迁移');
    activeValidationRoots.add(target);
    try { return await executeCompiledMigration(current, input, { verify, checkpoint }); }
    finally { activeValidationRoots.delete(target); }
  }
  return { plan, execute, buildPlan: plan, executeValidation: execute };
}

export async function describeLogicalPlan(compiled, backup,groupSize=20) {
    const directoryMappings = (compiled.evolution?.directoryMappings ?? []).filter(directory => compiled.moves?.some(move => move.from.startsWith(`${directory.from}/`)));
    const newDirectories = (compiled.evolution?.newDirectories ?? []).filter(directory => compiled.moves?.some(move => move.to.startsWith(`${directory}/`)));

    const logicalChanges = await Promise.all([...(compiled.changes ?? new Map())].map(async ([file, text]) => {
      if(recordKind(file)){
        const record=await relocateRecord(file,Buffer.from(text),{originalPath:backup.validationPath,validationPath:'@library'});
        return {path:file,content:record.bytes.toString('utf8')};
      }
      if (file === '.llm-wiki/ingest-cache.json') {
        const data = JSON.parse(text);
        for (const entry of Object.values(data.entries)) entry.filesWritten = entry.filesWritten.map(value => path.isAbsolute(value) || path.win32.isAbsolute(value) ? `@library/${relativeOutput(backup.validationPath, value)}` : value);
        return { path: file, content: JSON.stringify(data) };
      }
      if (file === '.llm-wiki/ingest-queue.json' || file === '.llm-wiki/file-change-queue.json') {
        const data = JSON.parse(text), tasks = Array.isArray(data) ? data : data.tasks;
        for (const task of tasks) if (task.projectId === backup.relocation.validationProjectId) task.projectId = '@project';
        return { path: file, content: JSON.stringify(data) };
      }
      return { path: file, content: text };
    }));
    const logicalPlan = { schemaVersion: 1, executionGroups:executionGroups(compiled.moves??[],groupSize),items: compiled.items, dependencies: compiled.dependencies, moves: compiled.moves ?? [], selectedSources: compiled.selectedSources,
      directories: { mappings: directoryMappings, create: newDirectories },
      changes: logicalChanges, links: compiled.links ?? null, indexes: compiled.indexes ?? null };
    return { logicalPlan, directoryMappings, newDirectories };
}

export async function executeCompiledMigration(current, input, { verify = nativeRescanVerifier(), checkpoint = async () => {}, targetRole = 'validation', revalidate, verifyProtected } = {}) {
    if (!current || current.used || input.approved !== true || input.writersPaused !== true) fail('REVIEW_REQUIRED', '计划不存在、已使用或尚未审核确认');
    if (!current.moves?.length) fail('EMPTY_BATCH', '批次没有可执行项目');
    if (input.planHash && input.planHash !== current.result.logicalPlanHash) fail('STALE_PLAN', '审核的计划哈希不匹配');
    const { backup, baseline, moves, changes, snapshot, indexPlan } = current;
    const persisted = JSON.parse(await readFile(current.result.planManifestPath, 'utf8'));
    const { manifestHash, ...persistedContent } = persisted;
    if (planDigest(persistedContent) !== manifestHash || manifestHash !== current.record.manifestHash) fail('INVALID_PLAN', '冻结计划文件已损坏或改变');
    const active = JSON.parse(await readFile(current.activePlanPath ?? `${backup.validationPath}.active-plan.json`, 'utf8'));
    if (active.planId !== input.planId || active.logicalPlanHash !== current.result.logicalPlanHash) fail('STALE_PLAN', '该方案已被重新审核的方案取代');
    if (createHash('sha256').update(await readFile(current.reportPath)).digest('hex') !== current.record.backupManifestHash) fail('STALE_PLAN', '备份报告在审核后改变');
    if (revalidate) await revalidate(); else await loadReport(current.reportPath);
    if ((await inventory(backup.validationPath)).hash !== baseline.hash) fail('STALE_PLAN', '计划后验证副本发生变化');
    current.used = true;
    const groups=structuredClone(current.record.logicalPlan.executionGroups??executionGroups(moves));
    if(JSON.stringify(groups.flatMap(group=>group.moveIndexes))!==JSON.stringify(moves.map((_,index)=>index)))fail('INVALID_PLAN','执行分组没有完整覆盖冻结操作');
    const expected=createExpectedState(baseline,backup.directories);
    const guard = modelGuard();
    const result = { ...structuredClone(current.result), status: 'failed', phase: 'verification-before', modelAttempts: guard.attempts, originalExecutionAllowed: false, journalPath: `${backup.validationPath}.migration-${input.planId}.json` };
    result.items = result.items.map(item => ({ ...item, status: item.status === 'selected' ? 'pending' : item.status }));
    result.executionGroups=groups.map(group=>({...group,status:'pending'}));
    const journal = { ...result, backupReportPath: current.reportPath, backupManifestHash: current.record.backupManifestHash, targetRole, targetRoot: backup.validationPath, planManifestPath: result.planManifestPath, planManifestHash: current.record.manifestHash, beforeBaseline: baseline, preimages: [], intents: [], completed: [] };
    const persist = async () => {
      const temporary = `${result.journalPath}.tmp-${randomUUID()}`;
      await writeFile(temporary, JSON.stringify(journal, null, 2), { flag: 'wx' });
      await atomicRename(temporary, result.journalPath);
    };
    await writeFile(result.journalPath, JSON.stringify(journal, null, 2), { flag: 'wx' });
    const groupBoundary=async(stage,group,done=false)=>{
      await checkpoint('group-'+stage+(done?'-complete':'-before'),{groupId:group.groupId,moveIndexes:group.moveIndexes,root:backup.validationPath,targetRole,models:guard});
      const expectedStateHash=await expected.verify(backup.validationPath);
      journal.expectedState=expected.snapshot();journal.expectedStateHash=expectedStateHash;
      journal.groupProgress={stage,groupId:group.groupId,completed:done};
      const state=result.executionGroups.find(value=>value.groupId===group.groupId);state.status=done?(stage==='stage'?'staged':'placed'):stage+'-running';
      journal.executionGroups=result.executionGroups;await persist();await new Promise(resolve=>setImmediate(resolve));
    };
    const intent = async value => { journal.intents.push(value); await persist(); };
    async function runProof() {
      const preserved = await Promise.all(['file-snapshot.json', 'file-change-queue.json'].map(async name => ({ file: path.join(backup.validationPath, '.llm-wiki', name), bytes: await readFile(path.join(backup.validationPath, '.llm-wiki', name)) })));
      const proof = requireQuietRescan(await verify({ validationPath: backup.validationPath, projectId: backup.relocation.validationProjectId, models: guard }));
      if (guard.attempts.length) fail('MODEL_ATTEMPT', '验证期间尝试调用模型');
      // 上游重扫会刷新 updatedAt 并清理完成任务；只保留验证证据，恢复原有无关状态。
      for (const value of preserved) await writeFile(value.file, value.bytes);
      return proof;
    }
    try {
      result.beforeProof = await runProof();
      if (guard.attempts.length) fail('MODEL_ATTEMPT', '验证期间尝试调用模型');
      const afterRescan = await inventory(backup.validationPath);
      if (afterRescan.hash !== baseline.hash) fail('VERIFIER_MUTATION', '预验证改变了知识库正文或其他状态');
      const affected = new Set([...moves.map(move => move.from), ...changes.keys(), ...indexPlan.knownStatePaths, '.llm-wiki/file-snapshot.json']);
      for (const file of affected) journal.preimages.push({ path: file, contentBase64: (await readFile(path.join(backup.validationPath, file))).toString('base64') });
      journal.phase = result.phase = 'writing'; await persist();
      for (const [file, content] of changes) {
        for (const item of result.items) if (item.status === 'pending') item.status = 'applied-unverified';
        await intent({ type: 'write', path: file });
        await safePath(path.dirname(path.join(backup.validationPath, file)));
        await writeFile(path.join(backup.validationPath, file), content);
        expected.write(file,content);
        journal.completed.push({ type: 'write', path: file }); await persist(); await checkpoint('write', { file, models: guard });
      }
      const staging = `${backup.validationPath}.staging-${input.planId}`;
      journal.stagingPath = staging; await intent({ type: 'create-staging', path: staging });
      await safePath(staging, { missingLeaf: true }); await mkdir(staging);
      // 先保存所有最终字节，再解除全部旧路径占位，支持大小写改名与交换。
      const stagedHashes=new Map();
      for(const group of groups){await groupBoundary('stage',group);
      for (const index of group.moveIndexes) {const move=moves[index];stagedHashes.set(index,expected.hash(move.from));
        const staged = path.join(staging, String(index));
        await intent({ type: 'stage', path: staged, ...move });
        await copyFile(path.join(backup.validationPath, move.from), staged, constants.COPYFILE_EXCL);
        journal.completed.push({ type: 'stage', path: staged, ...move }); await persist(); await checkpoint('stage', { ...move, models: guard });
      }await groupBoundary('stage',group,true);}
      for (const move of moves) {
        await intent({ type: 'unlink', path: move.from, itemId: move.itemId });
        await unlink(path.join(backup.validationPath, move.from));expected.remove(move.from);
        journal.completed.push({ type: 'unlink', path: move.from, itemId: move.itemId }); await persist();
      }
      const oldDirectories = new Set(current.result.directoryMappings.map(item => item.from));
      for (const move of moves) for (let dir = path.posix.dirname(move.from); dir.startsWith('raw/sources/'); dir = path.posix.dirname(dir)) oldDirectories.add(dir);
      for (const dir of [...oldDirectories].sort((a, b) => b.length - a.length)) {
        await intent({ type: 'remove-empty-directory', path: dir });
        try { await rmdir(path.join(backup.validationPath, dir)); expected.removeDirectory(dir);journal.completed.push({ type: 'remove-empty-directory', path: dir }); await persist(); }
        catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
      }
      for (const dir of current.result.newDirectories) { await intent({ type: 'create-directory', path: dir }); await mkdir(path.join(backup.validationPath, dir), { recursive: true }); await safePath(path.join(backup.validationPath, dir));expected.directory(dir); }
      const originalSnapshotFiles = { ...snapshot.files };
      for (const move of moves) delete snapshot.files[move.from];
      for(const group of groups){await groupBoundary('place',group);
      for (const index of group.moveIndexes) {const move=moves[index];
        const target = path.join(backup.validationPath, move.to);
        await intent({ type: 'place', ...move });
        await mkdir(path.dirname(target), { recursive: true }); await safePath(path.dirname(target));
        await copyFile(path.join(staging, String(index)), target, constants.COPYFILE_EXCL);expected.place(move.to,stagedHashes.get(index));
        if (originalSnapshotFiles[move.from]) snapshot.files[move.to] = originalSnapshotFiles[move.from];
        const item = result.items.find(item => item.id === move.itemId); if (item) item.status = 'applied-unverified';
        journal.items = result.items; journal.completed.push({ type: 'copy', ...move }); await persist(); await checkpoint('move', { ...move, models: guard });
      }await groupBoundary('place',group,true);}
      for (const file of new Set(current.snapshotTargets.map(file => moves.find(move => move.from === file)?.to ?? file))) {
        const full = path.join(backup.validationPath, file); const bytes = await readFile(full); const stat = await lstat(full);
        snapshot.files[file] = { ...snapshot.files[file], hash: md5(bytes), size: bytes.length, mtimeMs: Math.trunc(stat.mtimeMs) };
      }
      await intent({ type: 'indexes', plan: current.result.indexes });
      result.indexProof = await executeIndexMigration(backup.validationPath, indexPlan);
      journal.completed.push({ type: 'indexes', proof: result.indexProof }); await persist();
      snapshot.updatedAt = Date.now();
      await intent({ type: 'snapshot' });
      await writeFile(path.join(backup.validationPath, '.llm-wiki/file-snapshot.json'), JSON.stringify(snapshot, null, 2));
      journal.completed.push({ type: 'snapshot' }); journal.phase = result.phase = 'verification-after'; await persist();
      result.afterProof = await runProof();
      if (guard.attempts.length) fail('MODEL_ATTEMPT', '迁移或验证期间尝试调用模型');
      if (verifyProtected) await verifyProtected(); else await verifyBackup(backup.originalPath, backup.baseline, backup.directories);
      await verifyBackup(backup.backupPath, backup.baseline, backup.directories);
      result.afterBaseline = await inventory(backup.validationPath);
      for (const [index] of moves.entries()) await unlink(path.join(staging, String(index)));
      await rmdir(staging);
      result.items = result.items.map(item => ({ ...item, status: ['pending', 'applied-unverified'].includes(item.status) ? 'succeeded' : item.status }));
      result.executionGroups=result.executionGroups.map(group=>({...group,status:'verified'}));
      result.status = result.items.every(item => item.status === 'succeeded') ? 'complete' : 'partial'; result.phase = targetRole === 'original' ? 'verified-original' : 'verified-copy';
    } catch (error) {
      result.error = { code: error.code ?? 'MIGRATION_FAILED', message: error.message };
      const failedItem = journal.intents.at(-1)?.itemId;
      result.items = result.items.map(item => ({ ...item, status: item.id === failedItem ? 'failed' : item.status === 'pending' ? 'not-run' : item.status }));
    }
    Object.assign(journal, result); await persist();
    return result;
  }
