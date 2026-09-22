import path from 'node:path';
const key = value => value.toLowerCase();
const fail = (code, message, details = {}) => { throw Object.assign(new Error(message), { code, ...details }); };

function visibleMarkdown(text) {
  // 保持字符位置，只遮住代码字面量，避免把示例当作真实导航修复。
  return text.replace(/<!--[\s\S]*?-->/g, value => value.replace(/[^\n]/g, ' ')).replace(/(^|\n)([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2\3[^\n]*(?=\n|$)|$)/g, value => value.replace(/[^\n]/g, ' '))
    .replace(/(`+)([^`]|(?!\1)`)*?\1/g, value => value.replace(/[^\n]/g, ' '));
}
function escaped(text, index) { let count = 0; while (index > 0 && text[--index] === '\\') count++; return count % 2 === 1; }
function tokens(text) {
  const visible = visibleMarkdown(text), found = [];
  for (const match of visible.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
    if (escaped(visible, match.index + match[0].indexOf('[['))) continue;
    const inner = match[1], destination = inner.split('|')[0];
    const start = match.index + match[0].indexOf('[[') + 2;
    found.push({ kind: 'wiki', start, end: start + destination.length, value: destination });
  }
  // 内联链接目标支持括号配对与 Markdown 反斜线转义；标题和标签不参与替换。
  const brackets = [];
  for (let index = 0; index < visible.length; index++) {
    if (escaped(visible, index)) continue;
    if (visible[index] === '\n') { brackets.length = 0; continue; }
    if (visible[index] === '[') { brackets.push(index); continue; }
    if (visible[index] !== ']' || !brackets.length) continue;
    brackets.pop();
    if (visible[index + 1] !== '(') continue;
    // 保留外层标签的括号栈，同时识别图片自身与包裹图片的链接。
    let start = index + 2;
    while (/\s/.test(visible[start] ?? '') && start < visible.length) start++;
    const angle = visible[start] === '<'; if (angle) start++;
    let end = start, depth = 0;
    for (; end < visible.length; end++) {
      const c = visible[end];
      if (c === '\\') { end++; continue; }
      if (angle ? c === '>' : c === ')' && depth === 0 || /\s/.test(c)) break;
      if (!angle && c === '(') depth++;
      if (!angle && c === ')') depth--;
    }
    if (end > start) found.push({ kind: 'markdown', start, end, openParen: index + 1, value: text.slice(start, end) });
  }
  for (const match of visible.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm)) {
    const raw = match[1], angle = raw.startsWith('<'), value = angle ? raw.slice(1, -1) : raw;
    const start = match.index + match[0].lastIndexOf(raw) + (angle ? 1 : 0);
    found.push({ kind: 'markdown', start, end: start + value.length, value });
  }
  return { visible, tokens: found.sort((a, b) => a.start - b.start) };
}
function destination(value) {
  const index = value.search(/[?#]/);
  const raw = index < 0 ? value : value.slice(0, index), suffix = index < 0 ? '' : value.slice(index);
  let decoded;
  try { decoded = decodeURIComponent(raw.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/g, '$1')); } catch { return { invalid: true, raw, suffix }; }
  return { raw, suffix, decoded, external: /^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i.test(decoded) };
}
// 供新增归档的保守边界使用，复用与历史迁移相同的代码遮罩及链接目标解码。
export function localReferences(text) {
  const parsed=tokens(text);
  const references=parsed.tokens.map(token=>({...token,...destination(token.value)}));
  for(const match of parsed.visible.matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)){const value=match[1]??match[2]??match[3];references.push({kind:'html',value,...destination(value)});}
  return references.filter(reference=>!reference.external&&(reference.invalid||reference.decoded));
}
const fileIndexes = new WeakMap();
function fileIndex(files) {
  if (fileIndexes.has(files)) return fileIndexes.get(files);
  const exact = new Map(), suffix = new Map(), order = new Map();
  const add = (map, name, file) => { const bucket = map.get(name) ?? []; bucket.push(file); map.set(name, bucket); };
  files.forEach((file, index) => {
    order.set(file, index);add(exact, key(file), file);
    const parts = key(file).split('/');
    for (let i = 1; i < parts.length; i++) add(suffix, parts.slice(i).join('/'), file);
  });
  const result = { exact, suffix, order };fileIndexes.set(files, result);return result;
}
function candidates(file, token, files) {
  const target = destination(token.value);
  if (target.invalid) return { ...target, candidates: [] };
  if (target.external) return { ...target, candidates: [], external: true };
  if (!target.decoded) return { ...target, candidates: [file], self: true };
  const normalize = value => path.posix.normalize(value).replace(/^\.\//, '');
  // 每轮规划只建两份路径索引，避免每个链接反复扫描全库。
  const index = fileIndex(files);
  const lookup = (map, value, implicitMd) => [...new Set([...(map.get(key(value)) ?? []), ...(implicitMd ? map.get(key(`${value}.md`)) ?? [] : [])])].sort((a, b) => index.order.get(a) - index.order.get(b));
  const match = value => lookup(index.exact, value, !path.posix.extname(target.decoded));
  if (token.kind === 'markdown') return { ...target, candidates: match(normalize(path.posix.join(path.posix.dirname(file), target.decoded))) };
  if (/^\.\.?\//.test(target.decoded)) return { ...target, candidates: match(normalize(path.posix.join(path.posix.dirname(file), target.decoded))) };
  const exact = match(normalize(target.decoded));
  if (exact.length) return { ...target, candidates: exact };
  const suffix = normalize(target.decoded);
  const matches = lookup(index.suffix, suffix, !path.posix.extname(suffix));
  // 上游 Wiki 阅读器的知识链接在 wiki 内查找；显式根路径仍由上面的精确匹配处理。
  const wikiMatches = file.startsWith('wiki/') ? matches.filter(p => p.startsWith('wiki/')) : [];
  return { ...target, candidates: wikiMatches.length ? wikiMatches : matches };
}
function render(token, resolved, documentAfter, targetAfter) {
  if (resolved.self) return token.value;
  if (token.kind === 'wiki') return `${!path.posix.extname(resolved.decoded) && /\.md$/i.test(targetAfter) ? targetAfter.slice(0, -3) : targetAfter}${resolved.suffix}`;
  const relative = path.posix.relative(path.posix.dirname(documentAfter), targetAfter) || path.posix.basename(targetAfter);
  return `${relative.split('/').map(part => encodeURIComponent(part).replace(/[()]/g, c => '%' + c.charCodeAt(0).toString(16))).join('/')}${resolved.suffix}`;
}

export function analyzeLinks({ baseline, documents, moves, changes, affectedPages, resolutions = [] }) {
  if (!Array.isArray(resolutions)) fail('INVALID_LINK_RESOLUTION', '链接选择必须为数组');
  const choices = new Map();
  for (const choice of resolutions) {
    if (!choice || !['path', 'link', 'target'].every(name => typeof choice[name] === 'string' && choice[name])) fail('INVALID_LINK_RESOLUTION', '链接选择缺少文件、链接或目标');
    const id = JSON.stringify([choice.path, choice.link]);
    if (choices.has(id)) fail('INVALID_LINK_RESOLUTION', '同一链接不能重复指定目标');
    choices.set(id, choice);
  }
  const usedChoices = new Set();
  const files = baseline.files.map(f => f.path);
  const moved = value => moves.find(move => key(move.from) === key(value))?.to ?? value;
  const afterFiles = files.map(moved);
  const repairs = [], preexistingBroken = [], preexistingAmbiguous = [];
  for (const document of documents) {
    const text = changes.get(document.path) ?? document.text;
    const documentAfter = moved(document.path);
    const parsed = tokens(text);
    const possiblyAffected = documentAfter !== document.path || moves.some(move => parsed.visible.includes(path.posix.basename(move.from).replace(/\.md$/i, '')));
    const unsupportedInline = [...parsed.visible.matchAll(/\]\(/g)].some(match => !escaped(parsed.visible, parsed.visible.lastIndexOf('[', match.index)) && !/^\s*\)/.test(parsed.visible.slice(match.index + 2)) && !parsed.tokens.some(token => token.openParen === match.index + 1));
    if (possiblyAffected && unsupportedInline) fail('UNSUPPORTED_LINKS', `文件 ${document.path} 含无法唯一解析的链接结构，需人工核验`);
    // HTML/无法解析的链接仍保守阻止依赖迁移，避免把未支持格式当无链接。
    if (/\b(?:href|src)\s*=/i.test(parsed.visible) && possiblyAffected) fail('UNSUPPORTED_LINKS', `文件 ${document.path} 包含受影响的 HTML 链接，需人工处理该依赖迁移`);
    const originalLines = text.split('\n');
    if (possiblyAffected && parsed.visible.split('\n').some((line, index) => /^(?: {4}|\t)/.test(originalLines[index]) && /\[\[|\]\(/.test(line))) fail('UNSUPPORTED_LINKS', `文件 ${document.path} 的缩进代码或嵌套列表需人工核验`);
    const edits = [];
    for (const token of parsed.tokens) {
      const resolved = candidates(document.path, token, files);
      const choiceId = JSON.stringify([document.path, token.value]);
      const choice = choices.get(choiceId);
      if (choice) {
        if (token.kind !== 'wiki' || resolved.candidates.length < 2 || !resolved.candidates.includes(choice.target)) fail('INVALID_LINK_RESOLUTION', '指定目标必须属于该双链的现有歧义候选');
        resolved.candidates = [choice.target];
        usedChoices.add(choiceId);
      }
      if (resolved.external) continue;
      if (resolved.invalid) fail('UNSUPPORTED_LINKS', `文件 ${document.path} 的链接编码无法解析`);
      if (!resolved.candidates.length) { preexistingBroken.push({ path: document.path, link: token.value }); continue; }
      if (resolved.candidates.length !== 1) {
        const after = candidates(documentAfter, token, afterFiles);
        const sameCandidates = resolved.candidates.length === after.candidates.length && resolved.candidates.every(target => after.candidates.includes(target));
        if (resolved.candidates.some(target => moved(target) !== target) || !sameCandidates) fail('AMBIGUOUS_LINK', `文件 ${document.path} 的链接 ${token.value} 有多个目标，已跳过依赖迁移`, { path: document.path, candidates: resolved.candidates, affectedItemIds: moves.filter(move => move.from === document.path || resolved.candidates.includes(move.from)).map(move => move.itemId ?? move.from) });
        preexistingAmbiguous.push({ path: document.path, link: token.value, candidates: resolved.candidates }); continue;
      }
      const targetBefore = resolved.candidates[0], targetAfter = moved(targetBefore);
      const unchanged = candidates(documentAfter, token, afterFiles);
      if (!choice && unchanged.candidates.length === 1 && unchanged.candidates[0] === targetAfter) continue;
      const replacement = render(token, resolved, documentAfter, targetAfter);
      const checked = candidates(documentAfter, { ...token, value: replacement }, afterFiles);
      if (checked.candidates.length !== 1 || checked.candidates[0] !== targetAfter) fail('LINK_EQUIVALENCE', `文件 ${document.path} 的链接无法证明等价迁移`);
      if (replacement !== token.value) {
        edits.push({ ...token, replacement });
        repairs.push({ path: document.path, finalPath: documentAfter, kind: token.kind, before: token.value, after: replacement, targetBefore, targetAfter, ...(choice ? { explicitlyResolved: true } : {}) });
      }
    }
    if (edits.length) {
      let updated = text;
      for (const edit of edits.reverse()) updated = updated.slice(0, edit.start) + edit.replacement + updated.slice(edit.end);
      changes.set(document.path, updated);
      if (!affectedPages.includes(document.path)) affectedPages.push(document.path);
    }
  }
  if (usedChoices.size !== choices.size) fail('INVALID_LINK_RESOLUTION', '指定的歧义链接已改变或不存在，请重新检查');
  return { repairs, preexistingBroken, preexistingAmbiguous, newlyBroken: [] };
}
