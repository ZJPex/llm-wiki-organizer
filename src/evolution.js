import path from 'node:path';
import { inventory } from './compatibility.js';
import { categoryCatalog, planDigest } from './categories.js';

const parentOf = value => path.posix.dirname(value) === '.' ? '' : path.posix.dirname(value);
const inside = (value, parent) => value === parent || value.startsWith(`${parent}/`);
const codeOf = value => /^(\d+(?:\.\d+)*)\s/.exec(path.posix.basename(value))?.[1];
function labelOf(value) { return path.posix.basename(value).replace(/^\d+(?:\.\d+)*\s+/, ''); }
function validLabel(label) { if (typeof label !== 'string' || !label.trim() || /[<>:"/\\|?*\x00-\x1f]/.test(label) || /[. ]$/.test(label)) throw new Error('分类名称无效'); return label.trim(); }

export function nextCategoryPath(paths, parent, label) {
  validLabel(label);
  if (parent && !paths.includes(parent)) throw new Error('分类父级不存在');
  const prefix = parent ? codeOf(parent) : '';
  if (parent && !prefix) throw new Error('父级缺少完整编号，需先人工整理编号');
  const siblingCodes = paths.filter(p => p && parentOf(p) === parent).map(codeOf).filter(Boolean);
  if (new Set(siblingCodes).size !== siblingCodes.length) throw new Error('现有同级编号冲突，请先人工核验');
  const used = new Set(paths.filter(p => p && parentOf(p) === parent).map(p => { const code = codeOf(p); return code ? Number(code.split('.').at(-1)) : null; }));
  let number = 1; while (used.has(number)) number++;
  const code = prefix ? `${prefix}.${String(number).padStart(2, '0')}` : String(number).padStart(3, '0');
  return parent ? `${parent}/${code} ${label.trim()}` : `${code} ${label.trim()}`;
}

// 输出冻结目录与文件映射，不执行文件操作，可由迁移批次复用。
export function compileEvolution(catalog, baseline, operations, confirmedNames = {}) {
  const paths = catalog.categories.map(c => c.path);
  const generated = [...paths];
  const directoryMappings = [], explicitFiles = new Map(), touched = new Set();
  const newDirectories = [];
  function allocate(parent, label, ignore = null) {
    const normalized = label.toLowerCase().replace(/\s+/g, '');
    const equivalent = catalog.categories.find(c => c.path !== ignore && [labelOf(c.path), ...c.aliases].some(n => n.toLowerCase().replace(/\s+/g, '') === normalized));
    if (generated.some(p => p && p !== ignore && labelOf(p).toLowerCase().replace(/\s+/g, '') === normalized)) throw new Error('已存在同名分类，请复用或合并');
    if (equivalent) throw new Error('已存在同义分类，请复用或合并');
    const result = nextCategoryPath(generated, parent, label); generated.push(result); newDirectories.push(result); return result;
  }
  function relocate(from, to, merge = false) {
    if (!from || !paths.includes(from) || inside(to, from)) throw new Error('分类迁移源或父级无效');
    const affected = paths.filter(p => inside(p, from));
    for (const old of affected) {
      if (touched.has(old)) throw new Error('多个目录变更互相重叠，请拆批审核'); touched.add(old);
      let target = to;
      if (old !== from) {
        const tail = old.slice(from.length + 1).split('/');
        let oldParent = from;
        for (const segment of tail) {
          const oldCode = codeOf(segment), parentCode = codeOf(oldParent), newCode = codeOf(target);
          if (!oldCode || !parentCode || !newCode || !oldCode.startsWith(`${parentCode}.`)) throw new Error('后代编号不完整，不能自动传播');
          target += `/${newCode}.${oldCode.slice(parentCode.length + 1)} ${labelOf(segment)}`;
          oldParent += `/${segment}`;
        }
      }
      if (target !== to && generated.some(p => p !== target && parentOf(p) === parentOf(target) && codeOf(p) === codeOf(target))) throw new Error('后代编号冲突');
      if (generated.some(p => p.toLowerCase() === target.toLowerCase()) && !(merge && old === from) && target !== to) throw new Error('目录编号或目标发生冲突');
      if (!generated.includes(target)) generated.push(target);
      directoryMappings.push({ from: old, to: target });
    }
  }
  for (const operation of operations) {
    if (!operation || !['add', 'split', 'merge', 'move'].includes(operation.type) || typeof operation.problem !== 'string' || !operation.problem.trim() || typeof operation.benefit !== 'string' || !operation.benefit.trim()) throw new Error('每项调整必须说明问题与查找收益');
    if (operation.type === 'move') relocate(operation.from, allocate(operation.parent, operation.label ?? labelOf(operation.from), operation.from));
    if (operation.type === 'merge') { if (!paths.includes(operation.to) || !operation.to) throw new Error('合并目标不存在'); relocate(operation.from, operation.to, true); }
    if (operation.type === 'add' || operation.type === 'split') {
      const groups = operation.type === 'add' ? [operation] : operation.groups;
      if (!Array.isArray(groups) || !groups.length || (operation.type === 'split' && !paths.includes(operation.from))) throw new Error('拆分方案无效');
      for (const group of groups) {
        const target = allocate(operation.type === 'split' ? operation.from : operation.parent, group.label);
        if (!Array.isArray(group.files)) throw new Error('新增或拆分必须列明文件归属');
        for (const file of group.files) {
          if (!baseline.files.some(f => f.path === file) || explicitFiles.has(file) || (operation.type === 'split' && parentOf(file) !== operation.from)) throw new Error('文件分配无效或重复');
          explicitFiles.set(file, target);
        }
      }
    }
  }
  const fileMappings = [];
  for (const file of baseline.files) {
    const mapping = directoryMappings.find(m => m.from === parentOf(file.path));
    const targetDirectory = explicitFiles.get(file.path) ?? mapping?.to;
    if (targetDirectory === undefined) continue;
    const name = confirmedNames[file.path] ?? path.posix.basename(file.path);
    if (typeof name !== 'string' || !name || /[<>:\"/\\|?*\x00-\x1f]/.test(name) || name === '.' || name === '..') throw new Error('确认名称不能改变路径边界');
    const target = targetDirectory ? `${targetDirectory}/${name}` : name;
    fileMappings.push({ from: file.path, to: target, hash: file.hash, confirmedName: confirmedNames[file.path] ?? null });
  }
  const destinations = new Set();
  for (const file of fileMappings) {
    const key = file.to.toLowerCase();
    if (destinations.has(key) || baseline.files.some(f => f.path.toLowerCase() === key && f.path !== file.from && !fileMappings.some(m => m.from === f.path))) throw new Error('受影响文件目标冲突，不能覆盖');
    destinations.add(key);
  }
  return { directoryMappings, newDirectories, fileMappings };
}

export async function proposeEvolution({ entry, root, startCategory, generate, config }) {
  const catalog = await categoryCatalog(root);
  if (!catalog.categories.some(c => c.path === startCategory)) throw new Error('起始分类不存在');
  const baseline = await inventory(root);
  const visited = [], operations = [];
  let scope = startCategory;
  if (!entry.analysis || entry.analysis.uncertain) return { catalog, baseline, visited, operations, reason: '内容证据不足，保留待审核' };
  while (true) {
    const local = catalog.categories.filter(c => c.path === scope || parentOf(c.path) === scope || entry.classification?.considered?.includes(c.path));
    const result = await generate(config, { stage: 'evolution', content: entry.analysis, scope, categories: local, materials: baseline.files.filter(f => parentOf(f.path) === scope).map(f => f.path) });
    if (typeof result.canContain !== 'boolean' || typeof result.parentAffected !== 'boolean' || !Array.isArray(result.operations) || typeof result.reason !== 'string') throw new Error('演化响应无效');
    visited.push({ scope, reason: result.reason });
    if (result.canContain) { if (result.operations.length || result.parentAffected) throw new Error('可容纳的分类应停止调整'); break; }
    for (const operation of result.operations) {
      const affected = operation.from ?? operation.parent;
      if (!local.some(c => c.path === affected)) throw new Error('调整超出已检查的相关区域');
      operations.push(operation);
    }
    if (!result.parentAffected || !scope) break;
    scope = parentOf(scope);
  }
  if ((await categoryCatalog(root)).hash !== catalog.hash || (await inventory(root)).hash !== baseline.hash) throw new Error('规划期间分类或材料变化');
  return { catalog, baseline, visited, operations, reason: visited.at(-1)?.reason };
}

export function freezeEvolution(proposal, operations, confirmedNames) {
  const compiled = compileEvolution(proposal.catalog, proposal.baseline, operations, confirmedNames);
  const plan = { schemaVersion: 1, categoryRoot: proposal.catalog.root, catalogHash: proposal.catalog.hash, baselineHash: proposal.baseline.hash, operations, visited: proposal.visited, ...compiled };
  return { ...plan, planHash: planDigest(plan) };
}
