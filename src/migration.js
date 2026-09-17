import { copyFile, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inventory } from './compatibility.js';
import { safePath, verifyBackup } from './backup.js';
import { sourceFrontmatter, summaryCandidates } from './source-format.js';
import { modelGuard, nativeRescanVerifier, requireQuietRescan } from './migration-verifier.js';
import { analyzeLinks as repairLinks } from './links.js';
import { analyzeSharedOutputs, migrateAllCacheOutputs } from './shared-outputs.js';
import { analyzeIndexes, executeIndexMigration, indexPlanReport } from './indexes.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const key = value => value.replaceAll('\\', '/').toLowerCase();
const within = (root, target) => key(target) === key(root) || key(target).startsWith(`${key(root)}/`);
const md5 = value => createHash('md5').update(value).digest('hex');
const activeValidationRoots = new Set();
function relativeRaw(input) {
  if (typeof input !== 'string' || !input.startsWith('raw/sources/') || !/\.md$/i.test(input)) fail('INVALID_MAPPING', '映射必须为 raw/sources 下的 Markdown 相对路径');
  const parts = input.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part.length > 255)) fail('INVALID_MAPPING', '路径包含越界、Windows 非法名称或保留名');
  return input;
}
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

export function createMigrationService({ verify = nativeRescanVerifier(), checkpoint = async () => {}, analyzeLinks = repairLinks, analyzeShared = analyzeSharedOutputs, analyzeIndex = analyzeIndexes } = {}) {
  const plans = new Map();
  async function plan(input) {
    if (input.writersPaused !== true) fail('WRITERS_NOT_PAUSED', '请先暂停全部外部写入');
    const backup = await loadReport(input.reportPath);
    const root = backup.validationPath;
    const oldPath = relativeRaw(input.oldPath);
    const newPath = relativeRaw(input.newPath);
    if (key(oldPath) === key(newPath)) fail('UNSUPPORTED_CASE_RENAME', '本阶段不支持同路径或仅大小写改名');
    const baseline = await inventory(root);
    const files = new Map(baseline.files.map(file => [file.path, file]));
    if (!files.has(oldPath)) fail('SOURCE_MISSING', '旧源不存在');
    const conflicts = target => [...files.keys()].some(name => key(name) === key(target));
    if (conflicts(newPath)) fail('TARGET_EXISTS', '新位置已存在，不覆盖文件');

    const oldIdentity = oldPath.slice('raw/sources/'.length);
    const newIdentity = newPath.slice('raw/sources/'.length);
    const state = async name => JSON.parse(await readFile(path.join(root, '.llm-wiki', name), 'utf8'));
    const cache = await state('ingest-cache.json');
    const entry = cache.entries?.[oldIdentity];
    if (!entry || entry.hash !== files.get(oldPath).hash || !Array.isArray(entry.filesWritten) || !entry.filesWritten.length) fail('SOURCE_CHANGED', '源未摄取、内容变化或缓存关联不完整');
    if (cache.entries[newIdentity]) fail('TARGET_EXISTS', '新身份已有摄取记录');
    const outputs = entry.filesWritten.map(file => relativeOutput(root, file));
    if (outputs.some(file => !files.has(file) || !file.startsWith('wiki/') || !file.endsWith('.md'))) fail('UNKNOWN_ASSOCIATION', '缓存产出缺失或非 Wiki Markdown');
    const shared = await analyzeShared({ cache, oldIdentity, outputs, files, relativeOutput: value => relativeOutput(root, value) });
    const candidates = summaryCandidates(oldIdentity).map(slug => `wiki/sources/${slug}.md`).filter(file => files.has(file));
    if (candidates.length !== 1 || !outputs.includes(candidates[0])) fail('UNKNOWN_SUMMARY', '摘要缺失、多候选并存或未被缓存关联');
    const oldSummary = candidates[0];
    const newSummary = `wiki/sources/${summaryCandidates(newIdentity)[0]}.md`;
    if (oldSummary !== newSummary && conflicts(newSummary)) fail('TARGET_EXISTS', '目标摘要已存在');
    const moves = [{ from: oldPath, to: newPath }, ...(oldSummary === newSummary ? [] : [{ from: oldSummary, to: newSummary }])];
    const changes = new Map();
    const affectedPages = [];
    const documents = [];
    const sameBasenames = baseline.files.filter(file => file.path.startsWith('raw/sources/') && key(path.posix.basename(file.path)) === key(path.posix.basename(oldIdentity))).length;
    const referenceIdentity = value => value.replaceAll('\\', '/').replace(/^raw\/sources\//i, '');
    for (const file of baseline.files.filter(file => /\.md$/i.test(file.path))) {
      const text = await readFile(path.join(root, file.path), 'utf8');
      const frontmatter = sourceFrontmatter(text);
      documents.push({ path: file.path, text, frontmatter });
      if (file.path.startsWith('wiki/')) {
        const matches = source => key(referenceIdentity(source)) === key(oldIdentity) || (sameBasenames === 1 && !referenceIdentity(source).includes('/') && key(referenceIdentity(source)) === key(path.posix.basename(oldIdentity)));
        if (frontmatter.sources.some(matches)) {
          const updated = frontmatter.replace(frontmatter.sources.map(source => matches(source) ? newIdentity : source));
          if (sourceFrontmatter(updated).body !== frontmatter.body) fail('BODY_CHANGED', '知识正文不应变化');
          changes.set(file.path, updated); affectedPages.push(file.path);
        }
      }
    }
    const links = await analyzeLinks({ root, baseline, documents, moves, changes, affectedPages });
    const changedRaw = [...changes.keys()].filter(file => file.startsWith('raw/sources/') && /\.md$/i.test(file));
    const uncachedReferences = [];
    for (const file of changedRaw) {
      const identity = file.slice('raw/sources/'.length);
      const existing = cache.entries[identity];
      if (!existing) { uncachedReferences.push(file); continue; }
      if (existing.hash !== files.get(file).hash) fail('SOURCE_CHANGED', '引用文件的摄取缓存已过期，不能覆盖其内容变化');
      existing.hash = createHash('sha256').update(changes.get(file)).digest('hex');
    }
    if (outputs.some(file => !affectedPages.includes(file))) fail('MISSING_SOURCE_REFERENCE', '缓存产出缺少可唯一确定的 sources 引用');
    const indexPlan = await analyzeIndex({ baseline, root, oldPath, newPath, moves, changes });
    const knownState = new Set(['.llm-wiki/project.json', '.llm-wiki/ingest-cache.json', '.llm-wiki/file-snapshot.json', '.llm-wiki/ingest-queue.json', '.llm-wiki/file-change-queue.json']);
    for (const file of baseline.files.filter(file => file.path.startsWith('.llm-wiki/') && !knownState.has(file.path) && !indexPlan.knownStatePaths.includes(file.path))) {
      const text = await readFile(path.join(root, file.path), 'utf8');
      if ([oldIdentity, oldSummary, path.posix.basename(oldSummary)].some(value => text.includes(value))) fail('UNKNOWN_STATE_REFERENCE', '未适配状态引用了受影响源或摘要');
    }
    for (const [name, transform] of [['ingest-queue.json', value => value], ['file-change-queue.json', value => value.tasks]]) {
      const value = await state(name); const queue = transform(value);
      if (!Array.isArray(queue) || queue.some(task => ['pending', 'processing'].includes(task.status))) fail('BUSY', '存在未完成队列任务');
      let changed = false;
      for (const task of queue) for (const field of ['sourcePath', 'path']) {
        if (task[field] === oldPath) { task[field] = newPath; changed = true; }
        else if (task[field] === oldSummary) { task[field] = newSummary; changed = true; }
        else if (typeof task[field] === 'string' && task[field].includes(oldIdentity)) fail('UNKNOWN_TASK_PATH', '任务使用未适配路径格式');
      }
      if (changed) changes.set(`.llm-wiki/${name}`, JSON.stringify(value, null, 2));
    }
    const updatedCaches = migrateAllCacheOutputs(cache, root, oldIdentity, newIdentity, oldSummary, newSummary, value => relativeOutput(root, value));
    changes.set('.llm-wiki/ingest-cache.json', JSON.stringify(cache, null, 2));
    const snapshot = await state('file-snapshot.json');
    if (snapshot.version !== 1 || !snapshot.files || !snapshot.files[oldPath]) fail('UNKNOWN_SNAPSHOT', '源快照不存在或版本未知');
    for (const file of [oldPath, ...affectedPages]) {
      const record = snapshot.files[file];
      const data = await readFile(path.join(root, file));
      if (!record || record.hash !== md5(data) || record.size !== data.length) fail('STALE_SNAPSHOT', '受影响文件快照与内容不一致');
    }
    const id = randomUUID();
    const result = { planId: id, status: 'awaiting-review', batchId: backup.batchId, validationPath: root, mapping: { oldPath, newPath }, summaryMapping: { oldPath: oldSummary, newPath: newSummary }, affectedPages, links, uncachedReferences,
      associations: { ...shared, updatedCaches }, indexes: indexPlanReport(indexPlan),
      operations: [...moves.map(move => ({ type: 'move', ...move })), ...[...changes.keys()].map(file => ({ type: links?.repairs.some(repair => repair.path === file) ? 'links' : 'metadata', path: file })), { type: 'snapshot', path: '.llm-wiki/file-snapshot.json' }], baselineHash: baseline.hash, originalExecutionAllowed: false };
    plans.set(id, { result, backup, reportPath: input.reportPath, baseline, moves, changes, snapshot, indexPlan, used: false });
    return result;
  }
  async function executePlan(input) {
    const current = plans.get(input.planId);
    if (!current || current.used || input.approved !== true || input.writersPaused !== true) fail('REVIEW_REQUIRED', '计划不存在、已使用或尚未审核确认');
    const { backup, baseline, moves, changes, snapshot, indexPlan } = current;
    await loadReport(current.reportPath);
    if ((await inventory(backup.validationPath)).hash !== baseline.hash) fail('STALE_PLAN', '计划后验证副本发生变化');
    current.used = true;
    const guard = modelGuard();
    const result = { ...current.result, status: 'failed', phase: 'verification-before', modelAttempts: guard.attempts, originalExecutionAllowed: false, journalPath: `${backup.validationPath}.migration-${input.planId}.json` };
    const journal = { ...result, backupReportPath: current.reportPath, beforeBaseline: baseline, preimages: [], completed: [] };
    const persist = async () => {
      const temporary = `${result.journalPath}.tmp-${randomUUID()}`;
      await writeFile(temporary, JSON.stringify(journal, null, 2), { flag: 'wx' });
      await rename(temporary, result.journalPath);
    };
    await writeFile(result.journalPath, JSON.stringify(journal, null, 2), { flag: 'wx' });
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
        await safePath(path.dirname(path.join(backup.validationPath, file)));
        await writeFile(path.join(backup.validationPath, file), content);
        journal.completed.push({ type: 'write', path: file }); await persist(); await checkpoint('write', { file, models: guard });
      }
      for (const move of moves) {
        const target = path.join(backup.validationPath, move.to);
        await mkdir(path.dirname(target), { recursive: true }); await safePath(path.dirname(target));
        await copyFile(path.join(backup.validationPath, move.from), target, constants.COPYFILE_EXCL);
        journal.completed.push({ type: 'copy', ...move }); await persist();
        await unlink(path.join(backup.validationPath, move.from));
        journal.completed.push({ type: 'unlink', path: move.from }); await persist(); await checkpoint('move', { ...move, models: guard });
        snapshot.files[move.to] = snapshot.files[move.from]; delete snapshot.files[move.from];
      }
      for (const file of new Set([moves[0].to, ...current.result.affectedPages.map(file => moves.find(move => move.from === file)?.to ?? file)])) {
        const full = path.join(backup.validationPath, file); const bytes = await readFile(full); const stat = await lstat(full);
        snapshot.files[file] = { ...snapshot.files[file], hash: md5(bytes), size: bytes.length, mtimeMs: Math.trunc(stat.mtimeMs) };
      }
      result.indexProof = await executeIndexMigration(backup.validationPath, indexPlan);
      journal.completed.push({ type: 'indexes', proof: result.indexProof }); await persist();
      snapshot.updatedAt = Date.now();
      await writeFile(path.join(backup.validationPath, '.llm-wiki/file-snapshot.json'), JSON.stringify(snapshot, null, 2));
      journal.completed.push({ type: 'snapshot' }); journal.phase = result.phase = 'verification-after'; await persist();
      result.afterProof = await runProof();
      if (guard.attempts.length) fail('MODEL_ATTEMPT', '迁移或验证期间尝试调用模型');
      await verifyBackup(backup.originalPath, backup.baseline, backup.directories);
      await verifyBackup(backup.backupPath, backup.baseline, backup.directories);
      result.afterBaseline = await inventory(backup.validationPath);
      result.status = 'complete'; result.phase = 'verified-copy';
    } catch (error) { result.error = { code: error.code ?? 'MIGRATION_FAILED', message: error.message }; }
    Object.assign(journal, result); await persist();
    return result;
  }
  async function execute(input) {
    const current = plans.get(input.planId);
    if (!current) fail('REVIEW_REQUIRED', '计划不存在或已失效');
    const target = key(current.backup.validationPath);
    if (activeValidationRoots.has(target)) fail('MIGRATION_BUSY', '该验证副本已有正在执行的迁移');
    activeValidationRoots.add(target);
    try { return await executePlan(input); }
    finally { activeValidationRoots.delete(target); }
  }
  return { plan, execute, buildPlan: plan, executeValidation: execute };
}
