import { readdir, readFile, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {themeTags} from './classification-result.js';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// 只读取目录及分类说明，不分析其他源文件正文。
export async function categoryCatalog(root) {
  if (!path.isAbsolute(root)) throw new Error('分类根必须是绝对路径');
  if ((await lstat(root)).isSymbolicLink()) throw new Error('分类根不能是链接');
  const canonical = await realpath(root);
  const categories = [];
  async function walk(relative) {
    const directory = path.join(canonical, relative);
    let description = '', aliases = [];
    try {
      const metadataPath = path.join(directory, '.category.json');
      if ((await lstat(metadataPath)).isSymbolicLink()) throw new Error('分类说明不能是链接');
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
      if (typeof metadata.description !== 'string' || !Array.isArray(metadata.aliases ?? []) || (metadata.aliases ?? []).some(x => typeof x !== 'string')) throw new Error('分类说明格式无效');
      description = metadata.description; aliases = metadata.aliases ?? [];
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    categories.push({ path: relative, description, aliases });
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error('分类树含链接，拒绝规划');
      if (entry.isDirectory() && !entry.name.startsWith('.')) await walk(relative ? `${relative}/${entry.name}` : entry.name);
    }
  }
  await walk('');
  return { root: canonical, categories, hash: digest(categories) };
}

export async function recommendCategory({ entry, catalog, config, generate, onProgress }) {
  if (!entry.analysis || entry.analysis.uncertain || !['body', 'navigation'].includes(entry.kind)) return { status: 'needs-review', category: null, decision:'insufficient-evidence',tags:[],reason: '正文信息或可核验引用不足，保留原处', considered: [] };
  const content = { summary: entry.analysis.summary, evidence: entry.analysis.evidence };
  const selected = new Set(),unmatched=[];
  // 逐批只检索分类名与同义名，允许跨分支；详细说明仅进入相关候选阶段。
  for (let start = 0; start < catalog.categories.length; start += 60) {
    await onProgress?.({stage:'search',step:Math.floor(start/60)+1,totalSteps:Math.ceil(catalog.categories.length/60)});
    const candidates = catalog.categories.slice(start, start + 60).map(({ path, aliases }) => ({ path, aliases }));
    const result = await generate(config, { stage: 'category-search', content, categories: candidates });
    if (!Array.isArray(result.candidates) || result.candidates.length > 8 || result.candidates.some(p => typeof p !== 'string' || !candidates.some(c => c.path === p))) throw new Error('分类检索必须返回现有候选');
    if(result.decision!==undefined&&!['existing','missing-category','cross-topic','insufficient-evidence','undetermined'].includes(result.decision))throw new Error('分类检索判定类型无效');
    result.candidates.forEach(p => selected.add(p));
    if(!result.candidates.length)unmatched.push({decision:result.decision,reason:typeof result.reason==='string'?result.reason.trim():'',tags:themeTags(result.tags)});
  }
  if (!selected.size){
    const decision=unmatched.some(result=>result.decision==='insufficient-evidence')?'insufficient-evidence':unmatched.some(result=>result.decision==='cross-topic')?'cross-topic':unmatched.every(result=>result.decision==='missing-category'&&result.reason)?'missing-category':'undetermined';
    return { status: 'needs-review', category: null, decision,tags:themeTags([...new Set(unmatched.flatMap(result=>result.tags))].slice(0,12)),reason:unmatched.map(result=>result.reason).filter(Boolean).join('；')||'未找到可靠的已有候选；尚无法判断类别缺失还是主次不清，请人工核实', evidence:[],considered: [] };
  }
  if (selected.size > 24) return { status: 'needs-review', category: null, decision:'undetermined',tags:[],reason: '相关类别过多，请人工缩小分类范围', considered: [...selected] };
  const candidates = catalog.categories.filter(c => selected.has(c.path));
  await onProgress?.({stage:'choice'});
  const result = await generate(config, { stage: 'category-choice', content, categories: candidates });
  if (typeof result.reason !== 'string' || typeof result.uncertain !== 'boolean' || (result.category !== null && !candidates.some(c => c.path === result.category))) throw new Error('分类选择响应无效');
  if (!Array.isArray(result.evidence) || result.evidence.some(e => typeof e !== 'string' || !content.evidence.some(source => source.includes(e)) || !e)) throw new Error('分类理由必须有既有分析证据');
  if(result.decision!==undefined&&!['existing','missing-category','cross-topic','insufficient-evidence','undetermined'].includes(result.decision))throw new Error('分类判定类型无效');
  const uncertain = result.uncertain || result.category === null || !result.evidence.length;
  const decision=!result.evidence.length?'insufficient-evidence':result.decision??(uncertain?'undetermined':'existing');
  const unresolved=uncertain||decision!=='existing';
  return { status: 'needs-review', category: unresolved ? null : result.category, decision:unresolved&&decision==='existing'?'undetermined':decision,tags:themeTags(result.tags),reason: result.reason.trim()||'模型未提供可靠的归属理由，请人工判断', evidence: result.evidence, considered: [...selected] };
}

export async function finalTarget(catalog, category, name, originalFile) {
  if (typeof category !== 'string' || !catalog.categories.some(c => c.path === category)) throw new Error('仅能选择已有分类');
  const directory = path.join(catalog.root, category);
  const finalPath = path.join(directory, name);
  for (const existing of await readdir(directory)) {
    if (existing.toLowerCase() === name.toLowerCase() && path.join(directory, existing) !== originalFile) throw new Error('最终路径已存在，不能覆盖');
  }
  return finalPath;
}
export const planDigest = digest;
