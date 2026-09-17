import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { categoryCatalog, planDigest } from './categories.js';
import { compileEvolution } from './evolution.js';
import { canonicalPath } from './filesystem-paths.js';
import { inventory } from './compatibility.js';
import { sourceFrontmatter, summaryCandidates } from './source-format.js';
import { indexPlanReport } from './indexes.js';

const key = value => value.replaceAll('\\', '/').toLowerCase();
const fail = (code, message, details = {}) => { throw Object.assign(new Error(message), { code, ...details }); };
const hash = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
function validPath(value, passive = false) {
  if (typeof value !== 'string' || !value.startsWith('raw/sources/') || (!passive && !/\.md$/i.test(value))) fail('INVALID_MAPPING', '映射必须位于 raw/sources，主动整理仅支持 Markdown');
  if (value.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part.length > 255)) fail('INVALID_MAPPING', '路径包含非法名称或越界');
  return value;
}
function outputPath(root, value) {
  if (typeof value !== 'string') fail('UNKNOWN_ASSOCIATION', '缓存产出路径未知');
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    if (!key(value).startsWith(`${key(root)}/`)) fail('EXTERNAL_ASSOCIATION', '缓存产出不在工作库中');
    return value.replaceAll('\\', '/').slice(root.replaceAll('\\', '/').length + 1);
  }
  if (value.includes('\\') || value.split('/').includes('..')) fail('EXTERNAL_ASSOCIATION', '缓存产出包含非规范路径');
  return value;
}

async function requestedMappings(input, backup, baseline) {
  let supplied = input.mappings;
  let evolution = null;
  if (input.evolutionPlan) {
    const frozen = input.evolutionPlan;
    const { planHash, ...content } = frozen;
    if (!planHash || planDigest(content) !== planHash) fail('INVALID_EVOLUTION', '分类演化计划哈希无效');
    const originalRoot = await canonicalPath(frozen.categoryRoot);
    const prefix = path.relative(backup.originalPath, originalRoot).replaceAll('\\', '/');
    if (prefix !== 'raw/sources' && !prefix.startsWith('raw/sources/')) fail('INVALID_EVOLUTION', '分类根不在原库 Raw 内');
    const root = path.join(backup.validationPath, prefix);
    const catalog = await categoryCatalog(root), sourceBaseline = await inventory(root);
    if (catalog.hash !== frozen.catalogHash || sourceBaseline.hash !== frozen.baselineHash) fail('STALE_EVOLUTION', '分类目录或文件基线已变化');
    const confirmedNames = Object.fromEntries(frozen.fileMappings.filter(m => m.confirmedName).map(m => [m.from, m.confirmedName]));
    const compiled = compileEvolution(catalog, sourceBaseline, frozen.operations, confirmedNames);
    if (JSON.stringify(compiled.fileMappings) !== JSON.stringify(frozen.fileMappings) || JSON.stringify(compiled.directoryMappings) !== JSON.stringify(frozen.directoryMappings)) fail('INVALID_EVOLUTION', '演化映射与操作不一致');
    const base = compiled.fileMappings.map(m => ({ ...m, from: `${prefix}/${m.from}`, to: `${prefix}/${m.to}`, passive: !/\.md$/i.test(m.from) }));
    if (supplied) {
      if (!Array.isArray(supplied) || supplied.some(m => !base.some(item => item.from === m.from))) fail('INVALID_EVOLUTION', '修改项不属于冻结演化范围');
      supplied = base.map(item => {
        const edited = supplied.find(m => m.from === item.from);
        if (edited && path.posix.basename(edited.to) !== path.posix.basename(item.to)) fail('CONFIRMED_NAME_CHANGED', '目录调整不得改变已冻结文件名');
        return { ...item, ...edited, passive: item.passive };
      });
    } else supplied = base;
    evolution = { planHash, directoryMappings: compiled.directoryMappings.map(m => ({ from: `${prefix}/${m.from}`, to: `${prefix}/${m.to}` })), newDirectories: compiled.newDirectories.map(dir => `${prefix}/${dir}`) };
  }
  if (!supplied) supplied = [{ from: input.oldPath, to: input.newPath }];
  if (!Array.isArray(supplied) || !supplied.length || supplied.length > 1000) fail('INVALID_MAPPING', '批次需包含 1 至 1000 条明确映射');
  const ids = new Set();
  const items = supplied.map((item, index) => {
    const id = String(item.id ?? item.from ?? index);
    if (ids.has(id)) fail('INVALID_MAPPING', '批次项目标识重复'); ids.add(id);
    return { id, from: item.from, to: item.to, passive: !!(evolution && item.passive), expectedHash: item.hash ?? baseline.files.find(f => f.path === item.from)?.hash,
      status: item.enabled === false || input.exclusions?.includes(id) || input.exclusions?.includes(item.from) ? 'excluded' : 'pending' };
  });
  return { items, evolution };
}

/** 对同一个冻结基线构造全部最终状态；不执行模型或文件写入。 */
export async function compileBatchPlan(input, backup, baseline, adapters) {
  const root = backup.validationPath, files = new Map(baseline.files.map(file => [file.path, file]));
  const { items, evolution } = await requestedMappings(input, backup, baseline);
  const single = !input.mappings && !input.evolutionPlan;
  const state = async name => JSON.parse(await readFile(path.join(root, '.llm-wiki', name), 'utf8'));
  const originalCache = await state('ingest-cache.json');
  // Windows 缓存可能使用同一目录的短路径；先还原真实位置再核验库内关联。
  for (const entry of Object.values(originalCache.entries ?? {})) {
    if (Array.isArray(entry?.filesWritten)) entry.filesWritten = await Promise.all(entry.filesWritten.map(async value =>
      typeof value === 'string' && (path.isAbsolute(value) || path.win32.isAbsolute(value)) ? await canonicalPath(value) : value));
  }
  const documents = await Promise.all(baseline.files.filter(file => /\.md$/i.test(file.path)).map(async file => { const text = await readFile(path.join(root, file.path), 'utf8'); return { path: file.path, text, frontmatter: sourceFrontmatter(text) }; }));
  const dependencies = [];
  const block = (item, code, message) => { if (item.status === 'pending') { item.status = 'blocked'; item.reason = { code, message }; } };
  for (const item of items.filter(item => ['pending', 'excluded'].includes(item.status))) {
    try {
      validPath(item.from, item.passive); validPath(item.to, item.passive);
      if (item.from === item.to) fail('INVALID_MAPPING', '新旧路径完全相同');
      if (!files.has(item.from)) fail('SOURCE_MISSING', '源不存在');
      if (item.expectedHash && item.expectedHash !== files.get(item.from).hash) fail('SOURCE_CHANGED', '源内容与冻结映射不同');
      const identity = item.from.slice(12), next = item.to.slice(12);
      if (item.passive) { if (originalCache.entries[identity]) fail('UNSUPPORTED_SOURCE', '随目录移动的非 Markdown 材料已有摄取记录'); continue; }
      const entry = originalCache.entries[identity];
      if (!entry || entry.hash !== files.get(item.from).hash || !Array.isArray(entry.filesWritten) || !entry.filesWritten.length) fail('SOURCE_CHANGED', '源未摄取、内容已变化或关联缺失');
      const outputs = entry.filesWritten.map(value => outputPath(root, value));
      if (outputs.some(file => !files.has(file) || !file.startsWith('wiki/') || !/\.md$/i.test(file))) fail('UNKNOWN_ASSOCIATION', '缓存产出缺失或类型未知');
      const shared = await adapters.analyzeShared({ cache: originalCache, oldIdentity: identity, outputs, files, relativeOutput: value => outputPath(root, value) });
      const candidates = summaryCandidates(identity).map(slug => `wiki/sources/${slug}.md`).filter(file => files.has(file));
      if (candidates.length !== 1 || !outputs.includes(candidates[0])) fail('UNKNOWN_SUMMARY', '摘要缺失、歧义或未关联');
      item.source = { identity, next, outputs, shared, summaryFrom: candidates[0], summaryTo: `wiki/sources/${summaryCandidates(next)[0]}.md` };
    } catch (error) { block(item, error.code ?? 'UNSAFE_ITEM', error.message); }
  }
  const allMoves = () => items.flatMap(item => [{ from: item.from, to: item.to, itemId: item.id, passive: item.passive }, ...(item.source && item.source.summaryFrom !== item.source.summaryTo ? [{ from: item.source.summaryFrom, to: item.source.summaryTo, itemId: item.id }] : [])]).filter(move => typeof move.from === 'string' && typeof move.to === 'string');
  // 目标占位者必须一并迁走；排除或不安全沿依赖边传播。
  for (const move of allMoves()) {
    const item = items.find(item => item.id === move.itemId);
    if (item.status !== 'pending') continue;
    const duplicates = allMoves().filter(other => other.itemId !== move.itemId && (key(other.to) === key(move.to) || key(other.from) === key(move.from)));
    if (duplicates.length) { block(item, 'TARGET_EXISTS', '批内源或目标重复'); for (const other of duplicates) block(items.find(item => item.id === other.itemId), 'TARGET_EXISTS', '批内源或目标重复'); }
    const existing = baseline.files.find(file => key(file.path) === key(move.to));
    if (existing && key(existing.path) !== key(move.from)) {
      const vacating = allMoves().find(other => key(other.from) === key(existing.path));
      if (!vacating) block(item, 'TARGET_EXISTS', '目标被无关文件占用');
      else dependencies.push({ itemId: item.id, requires: vacating.itemId, reason: '目标须由另一项腾空' });
    }
    if (baseline.files.some(file => key(move.to).startsWith(`${key(file.path)}/`))) block(item, 'TARGET_EXISTS', '目标祖先是文件');
    if (backup.directories.some(dir => key(dir) === key(move.to))) block(item, 'TARGET_EXISTS', '目标名称是已有目录');
    for (const dir of backup.directories.filter(dir => key(move.to).startsWith(`${key(dir)}/`) && !move.to.startsWith(`${dir}/`))) {
      for (const occupant of baseline.files.filter(file => file.path.startsWith(`${dir}/`))) {
        const vacating = allMoves().find(other => other.from === occupant.path);
        if (!vacating) block(item, 'DIRECTORY_CASE_CONFLICT', '目录大小写调整仍有未迁移后代');
        else if (vacating.itemId !== item.id) dependencies.push({ itemId: item.id, requires: vacating.itemId, reason: '目录大小写调整需要全部后代迁出' });
      }
    }
  }
  function propagate() {
    let changed;
    do { changed = false; for (const edge of dependencies) {
      const item = items.find(i => i.id === edge.itemId), required = items.find(i => i.id === edge.requires);
      if (item.status === 'pending' && required.status !== 'pending') { block(item, 'DEPENDENCY_BLOCKED', `依赖项目 ${required.id} 被排除或不安全`); changed = true; }
    } } while (changed);
  }
  let compiled;
  while (true) {
    propagate(); const selected = items.filter(item => item.status === 'pending');
    if (!selected.length) break;
    const moves = allMoves().filter(move => selected.some(item => item.id === move.itemId));
    try {
      const cache = structuredClone(originalCache), changes = new Map(), affectedPages = [];
      const sourceItems = selected.filter(item => item.source);
      const sourceByIdentity = new Map(sourceItems.map(item => [item.source.identity, item.source.next]));
      const moveLookup = new Map(moves.map(move => [move.from, move.to]));
      for (const document of documents.filter(d => d.path.startsWith('wiki/'))) {
        const replacements = document.frontmatter.sources.map(source => {
          const identity = source.replaceAll('\\', '/').replace(/^raw\/sources\//i, '');
          const item = sourceItems.find(item => key(item.source.identity) === key(identity) || (!identity.includes('/') && path.posix.basename(item.source.identity).toLowerCase() === identity.toLowerCase() && baseline.files.filter(file => file.path.startsWith('raw/sources/') && key(path.posix.basename(file.path)) === key(identity)).length === 1));
          return item?.source.next ?? source;
        });
        if (JSON.stringify(replacements) !== JSON.stringify(document.frontmatter.sources)) { changes.set(document.path, document.frontmatter.replace(replacements)); affectedPages.push(document.path); }
      }
      for (const item of sourceItems) {
        if (!affectedPages.includes(item.source.summaryFrom)) fail('MISSING_SOURCE_REFERENCE', '本源摘要缺少可确定的 sources 引用', { affectedItemIds: [item.id] });
        for (const file of item.source.outputs.filter(file => !affectedPages.includes(file))) {
          const references = documents.find(document => document.path === file)?.frontmatter.sources;
          if (!references?.length || references.some(source => {
            const identity = source.replace(/^raw\/sources\//, '');
            const entry = originalCache.entries[identity];
            return !entry || files.get(`raw/sources/${identity}`)?.hash !== entry.hash;
          })) fail('MISSING_SOURCE_REFERENCE', '共享缓存产出缺少可验证的其他来源', { affectedItemIds: [item.id] });
        }
      }
      const links = await adapters.analyzeLinks({ root, baseline, documents, moves, changes, affectedPages });
      const uncachedReferences = [];
      for (const [file, text] of changes) if (file.startsWith('raw/sources/') && /\.md$/i.test(file)) {
        const existing = cache.entries[file.slice(12)];
        if (!existing) { uncachedReferences.push(file); continue; }
        if (existing.hash !== files.get(file).hash) fail('SOURCE_CHANGED', '反向引用来源的缓存已过期');
        existing.hash = hash(text);
      }
      const indexPlan = await adapters.analyzeIndex({ baseline, root, moves, changes });
      const known = new Set(['.llm-wiki/project.json', '.llm-wiki/ingest-cache.json', '.llm-wiki/file-snapshot.json', '.llm-wiki/ingest-queue.json', '.llm-wiki/file-change-queue.json', ...indexPlan.knownStatePaths]);
      for (const file of baseline.files.filter(file => file.path.startsWith('.llm-wiki/') && !known.has(file.path))) {
        const text = await readFile(path.join(root, file.path), 'utf8');
        const affected = sourceItems.filter(item => [item.source.identity, item.source.summaryFrom, path.posix.basename(item.source.summaryFrom)].some(value => text.includes(value)));
        if (affected.length) fail('UNKNOWN_STATE_REFERENCE', '未知状态引用了受影响材料', { affectedItemIds: affected.map(item => item.id) });
      }
      for (const [name, field] of [['ingest-queue.json', null], ['file-change-queue.json', 'tasks']]) {
        const value = await state(name), queue = field ? value[field] : value;
        if (!Array.isArray(queue) || queue.some(task => ['pending', 'processing'].includes(task.status))) fail('BUSY', '队列仍有待处理任务');
        let touched = false;
        for (const task of queue) for (const property of ['sourcePath', 'path']) if (typeof task[property] === 'string') {
          const next = moveLookup.get(task[property]);
          if (next) { task[property] = next; touched = true; }
          else if (sourceItems.some(item => task[property].includes(item.source.identity))) fail('UNKNOWN_TASK_PATH', '任务路径格式未知');
        }
        if (touched) changes.set(`.llm-wiki/${name}`, JSON.stringify(value, null, 2));
      }
      const nextEntries = {}, updatedCaches = [];
      for (const [identity, entry] of Object.entries(cache.entries)) {
        const nextIdentity = sourceByIdentity.get(identity) ?? identity;
        if (Object.hasOwn(nextEntries, nextIdentity)) fail('TARGET_EXISTS', '最终缓存身份冲突');
        let touched = identity !== nextIdentity;
        const filesWritten = entry.filesWritten.map(value => { const relative = outputPath(root, value), next = moveLookup.get(relative); if (!next) return value; touched = true; return path.isAbsolute(value) || path.win32.isAbsolute(value) ? `${root.replaceAll('\\', '/')}/${next}` : next; });
        nextEntries[nextIdentity] = { ...entry, filesWritten }; if (touched) updatedCaches.push(nextIdentity);
      }
      cache.entries = nextEntries; changes.set('.llm-wiki/ingest-cache.json', JSON.stringify(cache, null, 2));
      const snapshot = await state('file-snapshot.json');
      if (snapshot.version !== 1 || !snapshot.files) fail('UNKNOWN_SNAPSHOT', '快照格式未知');
      const snapshotTargets = new Set([...moves.filter(move => snapshot.files[move.from] || /\.md$/i.test(move.from)).map(move => move.from), ...affectedPages]);
      for (const file of snapshotTargets) {
        const record = snapshot.files[file], bytes = await readFile(path.join(root, file));
        if (!record || record.hash !== hash(bytes, 'md5') || record.size !== bytes.length) fail('STALE_SNAPSHOT', '受影响文件的快照不匹配');
      }
      compiled = { moves, changes, snapshot, indexPlan, snapshotTargets: [...snapshotTargets], affectedPages, links, uncachedReferences, associations: { sharedSources: sourceItems.flatMap(item => item.source.shared.sharedSources), updatedCaches }, indexes: indexPlanReport(indexPlan) };
      break;
    } catch (error) {
      if (single) throw error;
      const affectedIds = error.affectedItemIds ?? selected.map(item => item.id);
      const affected = selected.filter(item => affectedIds.includes(item.id) || affectedIds.includes(item.from));
      for (const item of affected.length ? affected : selected) block(item, error.code ?? 'UNSAFE_BATCH', error.message);
    }
  }
  if (single && !compiled) { const reason = items.find(item => item.reason)?.reason; fail(reason?.code ?? 'EMPTY_BATCH', reason?.message ?? '没有可执行项目'); }
  return { ...compiled, items: items.map(({ source, ...item }) => ({ ...item, status: item.status === 'pending' ? 'selected' : item.status })), dependencies, evolution, selectedSources: items.filter(item => item.status === 'pending' && item.source).map(item => ({ itemId: item.id, from: item.from, to: item.to, summaryFrom: item.source.summaryFrom, summaryTo: item.source.summaryTo })), single };
}
