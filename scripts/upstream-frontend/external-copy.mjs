import fs from 'node:fs/promises';
import path from 'node:path';
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
