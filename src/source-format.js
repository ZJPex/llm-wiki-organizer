// 固定 0.6.11 source-identity.ts 的摘要规则；哈希按 JavaScript UTF-16 编码单元计算。
function hashIdentity(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(36);
}
export function summaryCandidates(identity) {
  const parts = identity.replace(/\.[^/.]+$/, '').split('/').map(x => x.trim()).filter(Boolean);
  if (parts.length <= 1) return [parts[0] || 'source'];
  const hash = hashIdentity(identity);
  const make = mode => {
    const slug = parts.map(part => {
      if (mode === 'legacy') { const encoded = encodeURIComponent(part); return `${encoded.length}-${encoded}`; }
      const structural = part.normalize('NFKC').trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').replace(/^-|-$/g, '').toLowerCase();
      const readable = structural.replace(/-+/g, '-') || 'source';
      return `${Array.from(mode === 'previous' ? readable : structural || 'source').length}-${readable}`;
    }).join('--');
    const full = `${slug}--${hash}`;
    if (mode === 'legacy' || full.length <= 120) return full;
    return `${slug.slice(0, 120 - hash.length - 2).replace(/-+$/, '') || 'source'}--${hash}`;
  };
  return [...new Set(['canonical', 'previous', 'legacy'].map(make))];
}

const invalid = () => { throw Object.assign(new Error('sources 前言包含未支持的 YAML 格式'), { code: 'UNKNOWN_SOURCES' }); };
function scalar(value) {
  value = value.trim();
  if (value.startsWith('"')) { try { const parsed = JSON.parse(value); if (typeof parsed !== 'string') invalid(); return parsed; } catch { invalid(); } }
  if (value.startsWith("'")) { if (!/^'(?:[^']|'')*'$/.test(value)) invalid(); return value.slice(1, -1).replaceAll("''", "'"); }
  if (!value || /[\[\]{}#&*!|>]/.test(value)) invalid();
  return value;
}
export function sourceFrontmatter(content) {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---)(?:\r?\n|$)/.exec(content);
  if (!match) return { sources: [], body: content, replace: () => invalid() };
  const fm = match[2];
  const fields = [...fm.matchAll(/^sources:[^\r\n]*(?:\r?\n[ \t]+-[^\r\n]*)*/gm)];
  if (fields.length > 1) invalid();
  if (!fields.length) return { sources: [], body: content.slice(match[0].length), replace: () => invalid() };
  const field = fields[0];
  const text = field[0].slice('sources:'.length).trim();
  let sources;
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) invalid();
    const values = text.slice(1, -1).match(/"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^,]+/g) ?? [];
    sources = values.map(scalar);
  } else if (text.startsWith('-')) sources = text.split(/\r?\n/).map(line => scalar(line.replace(/^\s*-\s+/, '')));
  else invalid();
  return { sources, body: content.slice(match[0].length), replace(values) {
    const next = fm.slice(0, field.index) + `sources: ${JSON.stringify(values)}` + fm.slice(field.index + field[0].length);
    return match[1] + next + content.slice(match[1].length + fm.length);
  } };
}
