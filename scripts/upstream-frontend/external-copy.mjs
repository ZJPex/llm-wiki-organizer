import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
async function readJson(file){return JSON.parse(await fs.readFile(file,'utf8'));}
function check(record,field){const {[field]:expected,...unsigned}=record;if(digest(JSON.stringify(unsigned))!==expected)throw new Error('恢复证据哈希不匹配');}
async function matches(root,baseline){await noLinks(root);const found=[];async function scan(relative){for(const name of(await fs.readdir(path.join(root,relative))).sort()){const item=path.join(relative,name);if((await fs.lstat(path.join(root,item))).isDirectory())await scan(item);else{const bytes=await fs.readFile(path.join(root,item));found.push({path:item.replaceAll('\\','/'),size:bytes.length,hash:digest(bytes)});}}}await scan('');if(digest(JSON.stringify(found))!==baseline?.hash)throw new Error('恢复副本或备份内容已变化');}
const key = value => path.resolve(value).replaceAll('\\', '/').toLowerCase();
const inside = (a,b) => key(b) === key(a) || key(b).startsWith(key(a) + '/');
async function noLinks(root) {
  let current = root;
  while (true) {
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('验证路径含符号链接或目录连接');
    const next = path.dirname(current); if (next === current) break; current = next;
  }
  for (const entry of await fs.readdir(root, {withFileTypes:true})) {
    const item = path.join(root,entry.name), stat = await fs.lstat(item);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('验证副本含链接，拒绝运行');
    if (stat.isDirectory()) await noLinks(item);
  }
}
export async function validateExternalCopy(env) {
  const root = env.UPSTREAM_VALIDATION_COPY, manifestFile = env.UPSTREAM_VALIDATION_MANIFEST, resultFile = env.UPSTREAM_VALIDATION_RESULT;
  for (const p of [root,manifestFile,resultFile]) if (!p || !path.isAbsolute(p)) throw new Error('外部副本、备份报告和输出报告必须显式给出绝对路径');
  const manifest = JSON.parse(await fs.readFile(manifestFile,'utf8'));
  if(manifest.recoveryId){
    check(manifest,'reportHash');
    const plan=await readJson(manifest.recoveryPlanPath);check(plan,'recoveryPlanHash');
    const journal=await readJson(manifest.sourceJournalPath),migration=await readJson(manifest.planManifestPath);check(migration,'manifestHash');
    const backup=await readJson(manifest.backupReportPath);
    if(manifest.status!=='complete'||manifest.mode!=='new-directory'||manifest.targetRole!=='validation'||manifest.modelAttempts?.length||!manifest.backupUnchanged||plan.recoveryPlanHash!==manifest.recoveryPlanHash||digest(await fs.readFile(manifest.sourceJournalPath))!==manifest.sourceJournalHash||migration.manifestHash!==manifest.planManifestHash||journal.planManifestHash!==manifest.planManifestHash||digest(await fs.readFile(manifest.backupReportPath))!==manifest.backupManifestHash||migration.backupManifestHash!==manifest.backupManifestHash||manifest.logicalPlanHash!==migration.logicalPlanHash||key(root)!==key(manifest.restoreRoot)||key(root)!==key(plan.destination))throw new Error('仅接受完整且证据一致的独立验证恢复报告');
    const roots=[backup.originalPath,backup.backupPath,backup.validationPath,root,manifest.scenePath];
    for(let i=0;i<roots.length;i++)for(let j=i+1;j<roots.length;j++)if(inside(roots[i],roots[j])||inside(roots[j],roots[i]))throw new Error('恢复目录与受保护位置重叠');
    if(roots.some(p=>inside(p,resultFile)))throw new Error('报告不能写入数据目录');
    await matches(root,manifest.afterBaseline);await matches(backup.backupPath,backup.baseline);
    const id=(await readJson(path.join(root,'.llm-wiki/project.json'))).id;
    if(id!==manifest.projectId||id!==plan.targetProjectId||id===backup.relocation.originalProjectId||id===backup.relocation.validationProjectId)throw new Error('恢复副本身份未隔离');
    return {root,projectId:id,resultFile,recoveryReportHash:manifest.reportHash};
  }
  const roots = [manifest.originalPath,manifest.backupPath,manifest.validationPath];
  if (manifest.status !== 'complete' || !manifest.backupVerified || !manifest.validationVerified || roots.some(p => !p || !path.isAbsolute(p))) throw new Error('必须提供成功且已校验的三份数据备份报告');
  if (key(root) !== key(manifest.validationPath)) throw new Error('请求路径不是报告中的验证副本');
  for(let i=0;i<3;i++) for(let j=i+1;j<3;j++) if(inside(roots[i],roots[j]) || inside(roots[j],roots[i])) throw new Error('三份数据存在路径重叠');
  if (roots.some(p => inside(p,resultFile))) throw new Error('输出报告不能位于三份数据目录内');
  await noLinks(root);
  const ids = await Promise.all(roots.map(async p => JSON.parse(await fs.readFile(path.join(p,'.llm-wiki/project.json'),'utf8')).id));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(ids[2]) || ids[2] !== manifest.relocation?.validationProjectId || ids[0] !== manifest.relocation?.originalProjectId || ids[1] !== ids[0] || ids[2] === ids[0]) throw new Error('验证副本没有独立且可核验的项目 UUID');
  return {root,projectId:ids[2],resultFile};
}
