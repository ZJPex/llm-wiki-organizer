import { readFile, readdir, realpath, lstat, mkdir, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { categoryCatalog, recommendCategory, finalTarget, planDigest } from './categories.js';
import { readModelConfig, generateWithModel } from './model-config.js';
const hash = value => createHash('sha256').update(value).digest('hex');
export function validateName(name) {
  if (typeof name !== 'string' || name.length > 240 || !/\.md$/i.test(name) || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name) || !name.slice(0, -3).trim()) throw new Error('名称不符合 Windows Markdown 文件名规则');
  return name;
}
async function sourceFile(root, identity) {
  if (typeof identity !== 'string' || !/\.md$/i.test(identity) || identity.includes('\\') || identity.split('/').some(p => !p || p === '.' || p === '..') || path.isAbsolute(identity)) throw new Error('源身份无效');
  const base = await realpath(root);
  let file = base;
  for (const part of identity.split('/')) { file = path.join(file, part); if ((await lstat(file)).isSymbolicLink()) throw new Error('拒绝符号链接来源'); }
  if (!path.relative(base, await realpath(file)).startsWith('..')) return file;
  throw new Error('来源超出范围');
}
function analysisView(text) {
  // 仅分析视图降权：原文件及元数据从不写回。
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').split(/\r?\n/).filter(line => !/^\s*(播放量|点赞|收藏数|推荐视频|相关推荐|下载次数)\s*[:：]/.test(line)).join('\n');
}
function kindOf(view) {
  const lines = view.split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) return 'blank';
  if (lines.every(s => /^#{1,6}\s/.test(s))) return 'title-only';
  if (lines.some(s => /\[\[.+?\]\]|\[.+?\]\(.+?\)/.test(s)) && lines.every(s => /^#|\[\[.+?\]\]|\[.+?\]\(.+?\)/.test(s))) return 'navigation';
  if (view.replace(/[\s\d\p{P}\p{S}]/gu, '').length < 20) return 'noise';
  return 'body';
}
function checkedAnalysis(result, text) {
  if (!result || typeof result.title !== 'string' || typeof result.summary !== 'string' || !Array.isArray(result.evidence) || result.evidence.some(e => typeof e !== 'string' || !e || !text.includes(e))) throw new Error('模型分析缺少可核验的原文证据');
  return { title: result.title, summary: result.summary, evidence: result.evidence, uncertain: result.uncertain !== false || !result.evidence.length };
}

export function createPlanningService({ generate = generateWithModel, stateDirectory = path.join(os.homedir(), '.llm-wiki-organizer') } = {}) {
  // 串行状态变更，避免同一进程内审核互相覆盖。
  let queue = Promise.resolve();
  const serial = fn => { const pending = queue.then(fn); queue = pending.catch(() => {}); return pending; };
  async function state(root, libraryPath) {
    const canonical = await realpath(root);
    const location = path.resolve(stateDirectory);
    if (libraryPath) { const library = await realpath(libraryPath); const inside = path.relative(library, location); if (!inside || (!inside.startsWith('..') && !path.isAbsolute(inside))) throw new Error('方案状态目录必须在知识库之外'); }
    const relative = path.relative(canonical, location);
    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('方案状态目录必须在源目录之外');
    const file = path.join(location, `${hash(canonical)}.json`);
    try { return { file, data: JSON.parse(await readFile(file, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw e; return { file, data: { schemaVersion: 1, entries: {} } }; }
  }
  async function persist(file, data) { await mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(data, null, 2), { flag: 'wx' }); await rename(temporary, file); }
  return {
    analyze: input => serial(async () => {
      const { sourceRoot, identity } = input;
      const file = await sourceFile(sourceRoot, identity);
      const text = await readFile(file, 'utf8');
      const sourceHash = hash(text);
      const saved = await state(sourceRoot, input.libraryPath);
      const prior = saved.data.entries[identity];
      if (prior?.hash === sourceHash) return { ...prior, reused: true };
      const view = analysisView(text);
      const kind = kindOf(view);
      const seriesPattern = /第[零一二三四五六七八九十百千0-9]+[章节课讲]|(?:chapter|lesson|part)\s*\d+/gi;
      const heading = view.split('\n').find(line => /^#{1,6}\s/.test(line)) ?? '';
      const identityHints = [...new Set((path.basename(identity) + ' ' + heading).match(seriesPattern) ?? [])];
      const entry = { identity, hash: sourceHash, kind, identityHints, segments: [], suggestion: null, confirmedName: prior?.confirmedName ?? null, reviewRequired: true };
      if (['body', 'navigation'].includes(kind)) {
        const config = await readModelConfig(input);
        const size = Math.max(256, Math.min(8000, Math.floor((config.maxContextSize ?? 16000) / 4)));
        for (let start = 0; start < view.length; start += size) {
          const content = view.slice(start, start + size);
          entry.segments.push({ start, end: Math.min(start + size, view.length), ...checkedAnalysis(await generate(config, { stage: 'segment', content, identity }), content) });
        }
        // 分层归并使每一段均参与，避免把超长全文再次塞入一个上下文。
        let summaries = entry.segments;
        while (summaries.length > 1) {
          const next = [];
          for (let offset = 0; offset < summaries.length; offset += 4) {
            const group = summaries.slice(offset, offset + 4);
            const content = group.map(s => `${s.summary}\n${s.evidence.join('\n')}`).join('\n');
            const result = checkedAnalysis(await generate(config, { stage: 'synthesis', content, identity }), content);
            next.push({ ...result, uncertain: result.uncertain || group.some(s => s.uncertain) });
          }
          summaries = next;
        }
        entry.analysis = summaries[0];
        if (!entry.analysis.uncertain && !entry.confirmedName) {
          const proposed = `${entry.analysis.title}${path.extname(identity)}`;
          try { validateName(proposed); if (identityHints.every(hint => proposed.toLowerCase().includes(hint.toLowerCase()))) entry.suggestion = proposed; else entry.warning = '建议遗漏章节或系列编号，请结合原文人工命名'; } catch { entry.warning = '模型名称无效，请人工修改'; }
        }
      }
      if (!entry.suggestion && !entry.confirmedName) entry.warning ??= '证据不足或主题不明确，请人工处理；源文件及关联保持原样';
      if (hash(await readFile(file, 'utf8')) !== sourceHash) throw new Error('分析过程中源文件变化，请重试');
      saved.data.entries[identity] = entry;
      await persist(saved.file, saved.data);
      return entry;
    }),
    confirm: input => serial(async () => {
      const { sourceRoot, identity, name } = input;
      validateName(name);
      const file = await sourceFile(sourceRoot, identity);
      const saved = await state(sourceRoot, input.libraryPath);
      const entry = saved.data.entries[identity];
      if (!entry || entry.hash !== hash(await readFile(file, 'utf8'))) throw new Error('源文件已变化，必须重新分析');
      if (entry.confirmedName && entry.confirmedName !== name && !input.allowRenameConfirmed) throw new Error('已确认名称默认固定，需明确允许重新命名');
      const collision = (await readdir(path.dirname(file))).some(p => p.toLowerCase() === name.toLowerCase() && p !== path.basename(file));
      const duplicate = Object.values(saved.data.entries).some(e => e.identity !== identity && path.dirname(e.identity) === path.dirname(identity) && e.confirmedName?.toLowerCase() === name.toLowerCase());
      if (collision || duplicate) throw new Error('目标名称已存在，不能覆盖');
      if (entry.confirmedName !== name) { delete entry.classification; delete entry.frozenPlan; } entry.confirmedName = name; entry.reviewRequired = false;
      await persist(saved.file, saved.data);
      return entry;
    }),
    classify: input => serial(async () => {
      const saved = await state(input.sourceRoot, input.libraryPath);
      const file = await sourceFile(input.sourceRoot, input.identity);
      const entry = saved.data.entries[input.identity];
      if (!entry?.confirmedName || entry.reviewRequired) throw new Error('请先确认当前文件名');
      if (entry.hash !== hash(await readFile(file, 'utf8'))) throw new Error('源文件变化，请重新分析');
      await state(input.sourceRoot, input.categoryRoot);
      const catalog = await categoryCatalog(input.categoryRoot);
      const config = entry.analysis && !entry.analysis.uncertain ? await readModelConfig(input) : null;
      const recommendation = await recommendCategory({ entry, catalog, config, generate });
      if (entry.hash !== hash(await readFile(file, 'utf8')) || (await categoryCatalog(input.categoryRoot)).hash !== catalog.hash) throw new Error('分类规划期间基线变化');
      entry.classification = { ...recommendation, catalogRoot: catalog.root, catalogHash: catalog.hash, options: catalog.categories.map(c => c.path), finalPath: recommendation.category === null ? null : path.join(catalog.root, recommendation.category, entry.confirmedName) };
      delete entry.frozenPlan;
      await persist(saved.file, saved.data);
      return entry;
    }),
    confirmCategory: input => serial(async () => {
      const saved = await state(input.sourceRoot, input.libraryPath);
      const file = await sourceFile(input.sourceRoot, input.identity);
      const entry = saved.data.entries[input.identity];
      if (!entry?.confirmedName || !entry.classification || entry.hash !== hash(await readFile(file, 'utf8'))) throw new Error('计划缺失或源基线变化');
      const catalog = await categoryCatalog(entry.classification.catalogRoot);
      if (catalog.hash !== entry.classification.catalogHash) throw new Error('分类树或说明已变化，请重新规划');
      validateName(entry.confirmedName);
      const target = await finalTarget(catalog, input.category, entry.confirmedName, file);
      if (Object.values(saved.data.entries).some(e => e.identity !== entry.identity && e.frozenPlan?.finalPath.toLowerCase() === target.toLowerCase())) throw new Error('批次内目标重名');
      const frozen = { schemaVersion: 1, identity: entry.identity, sourcePath: file, sourceHash: entry.hash, name: entry.confirmedName, category: input.category, categoryRoot: catalog.root, catalogHash: catalog.hash, finalPath: target };
      entry.frozenPlan = { ...frozen, planHash: planDigest(frozen) };
      entry.classification = { ...entry.classification, category: input.category, finalPath: target, status: 'confirmed' };
      await persist(saved.file, saved.data);
      return entry;
    }),
    list: input => serial(async () => (await state(input.sourceRoot, input.libraryPath)).data),
  };
}
