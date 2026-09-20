import fs from 'node:fs/promises';
import path from 'node:path';

const commit = 'e8082119649e6a8e1cf85eaf289adcabfdf39d4e';
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
function quiet(proof) {
  requireValue(proof?.upstreamCommit === commit && Array.isArray(proof?.result?.changedTasks) && !proof.result.changedTasks.length && Array.isArray(proof?.events) && !proof.events.some(event => event.event === 'file-sync://changed') && Array.isArray(proof?.result?.queue?.tasks) && !proof.result.queue.tasks.some(task => ['pending','processing'].includes(task.status)), '正式执行缺少固定上游零变化证据');
}
export function requireOriginalSuccess(record, items, role) {
  requireValue(['complete','partial'].includes(record.status) && record.targetRole === role && record.phase === `verified-${role === 'original' ? 'original' : 'copy'}` && Array.isArray(record.modelAttempts) && !record.modelAttempts.length, '正式执行或副本验证尚未成功');
  requireValue(Array.isArray(items) && items.some(item => item.status === 'selected') && Array.isArray(record.items) && record.items.length === items.length, '缺少冻结执行范围');
  for (const item of items) {
    const actual = record.items.find(value => value.id === item.id);
    requireValue(actual && actual.from === item.from && actual.to === item.to && actual.expectedHash === item.expectedHash && actual.status === (item.status === 'selected' ? 'succeeded' : item.status), '执行结果扩大范围或存在未成功项目');
  }
  quiet(record.beforeProof); quiet(record.afterProof);
}

// 只接受真实 T8 结果链；不将原库包装成独立副本或恢复结果。
export async function validateOriginalExecution({root, manifestFile, resultFile}, helpers) {
  const {check, matches, key, inside, digest} = helpers;
  async function json(file) {
    requireValue(typeof file === 'string' && path.isAbsolute(file), '原库证据路径必须是绝对路径');
    for (let parent=path.dirname(file);;) {
      requireValue(!(await fs.lstat(parent)).isSymbolicLink(), '证据祖先目录含连接');
      const next=path.dirname(parent); if(next===parent)break; parent=next;
    }
    const stat = await fs.lstat(file);
    requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, '原库证据必须是独立普通文件');
    return JSON.parse(await fs.readFile(file,'utf8'));
  }
  const result = await json(manifestFile); check(result,'resultHash');
  const authorization = await json(result.authorizationPlanPath); check(authorization,'authorizationHash');
  const manifest = await json(authorization.planManifestPath); check(manifest,'manifestHash');
  const journal = await json(result.journalPath), validation = await json(authorization.validationJournalPath);
  const backup = await json(manifest.backupReportPath);
  const recovery = await json(authorization.recoveryReportPath); check(recovery,'reportHash');
  const recoveryPlan = await json(recovery.recoveryPlanPath); check(recoveryPlan,'recoveryPlanHash');
  const items = manifest.logicalPlan?.items;
  requireOriginalSuccess(result,items,'original'); requireOriginalSuccess(journal,items,'original'); requireOriginalSuccess(validation,items,'validation');
  requireValue(key(root) === key(result.originalPath) && key(root) === key(result.targetRoot) && key(root) === key(authorization.originalPath) && key(root) === key(backup.originalPath), '请求路径不是已审核原库');
  requireValue(key(manifestFile) === key(result.resultPath) && key(manifestFile) === key(`${result.authorizationPlanPath}.result.json`) && key(result.authorizationPlanPath) === key(authorization.authorizationPlanPath) && key(result.authorizationPlanPath) === key(`${root}.authorization-${authorization.authorizationId}.json`) && key(result.journalPath) === key(`${root}.migration-${manifest.planId}.json`), '正式执行证据位置不一致');
  requireValue(result.authorizationHash === authorization.authorizationHash && result.logicalPlanHash === manifest.logicalPlanHash && digest(JSON.stringify(manifest.logicalPlan)) === manifest.logicalPlanHash && authorization.logicalPlanHash === manifest.logicalPlanHash && authorization.planManifestHash === manifest.manifestHash && authorization.backupManifestHash === manifest.backupManifestHash && digest(await fs.readFile(manifest.backupReportPath)) === manifest.backupManifestHash, '正式执行计划或备份证据不一致');
  for (const value of [result,journal,validation]) requireValue(value.planId === manifest.planId && value.logicalPlanHash === manifest.logicalPlanHash && value.batchId === backup.batchId && value.planManifestPath && key(value.planManifestPath) === key(authorization.planManifestPath), '执行日志与冻结计划不一致');
  for (const value of [journal,validation]) requireValue(value.planManifestHash === manifest.manifestHash && value.backupManifestHash === manifest.backupManifestHash, '执行日志引用已变化');
  requireValue(journal.afterBaseline?.hash === result.afterBaseline?.hash && authorization.validationAfterHash === validation.afterBaseline?.hash && authorization.validationJournalHash === digest(await fs.readFile(authorization.validationJournalPath)) && key(validation.targetRoot) === key(backup.validationPath) && key(journal.targetRoot) === key(root), '执行后基线或角色不一致');
  requireValue(recovery.status === 'complete' && recovery.mode === 'new-directory' && recovery.targetRole === 'validation' && recovery.backupUnchanged && recovery.modelAttempts?.length === 0 && recovery.reportHash === authorization.recoveryReportHash && recovery.recoveryPlanHash === recoveryPlan.recoveryPlanHash && recovery.logicalPlanHash === manifest.logicalPlanHash && recovery.planManifestHash === manifest.manifestHash && recovery.backupManifestHash === manifest.backupManifestHash && recovery.sourceJournalHash === authorization.validationJournalHash && key(recovery.sourceJournalPath) === key(authorization.validationJournalPath) && key(recovery.restoreRoot) === key(authorization.recoveryPath) && key(recovery.restoreRoot) === key(recoveryPlan.destination), '原库执行缺少同计划完整恢复演练');
  quiet(recovery.verification?.proof);
  requireValue(backup.status === 'complete' && backup.backupVerified && backup.validationVerified && backup.version?.verifiedSource && authorization.baselineHash === backup.baseline?.hash, '备份基线未经校验');
  const roots = [backup.originalPath,backup.backupPath,backup.validationPath,recovery.restoreRoot];
  requireValue(roots.every(value => typeof value === 'string' && path.isAbsolute(value)), '数据目录格式无效');
  for (let i=0;i<roots.length;i++) for (let j=i+1;j<roots.length;j++) requireValue(!inside(roots[i],roots[j]) && !inside(roots[j],roots[i]), '原库、备份、副本与恢复目录存在重叠');
  requireValue(!roots.some(value => inside(value,resultFile)), '输出报告不能写入数据目录');
  requireValue(key(result.backupPath) === key(backup.backupPath) && key(authorization.backupPath) === key(backup.backupPath) && key(result.validationPath) === key(backup.validationPath) && key(authorization.validationPath) === key(backup.validationPath), '三目录证据不一致');
  await matches(root,result.afterBaseline); await matches(backup.backupPath,backup.baseline); await matches(backup.validationPath,validation.afterBaseline); await matches(recovery.restoreRoot,recovery.afterBaseline);
  const ids = await Promise.all(roots.map(async value => (await json(path.join(value,'.llm-wiki/project.json'))).id));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  requireValue(ids.every(id => uuid.test(id)) && ids[0] === authorization.originalProjectId && ids[0] === backup.relocation?.originalProjectId && ids[1] === ids[0] && ids[2] === backup.relocation?.validationProjectId && ids[0] !== ids[2] && ids[3] === recovery.projectId && ids[3] !== ids[0] && ids[3] !== ids[2], '原库 UUID 被替换或副本身份未隔离');
  return {root,projectId:ids[0],resultFile,targetRole:'original',originalResultHash:result.resultHash,authorizationHash:authorization.authorizationHash,logicalPlanHash:manifest.logicalPlanHash};
}
