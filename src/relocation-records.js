import path from 'node:path';
import {canonicalPath} from './filesystem-paths.js';

const fail = message => { throw Object.assign(new Error(message), {code:'UNKNOWN_RELOCATION'}); };
const normalize = value => value.replaceAll('\\','/').replace(/\/$/,'');
const same = value => process.platform === 'win32' ? value.toLowerCase() : value;
export const dormantState = file => /^\.llm-wiki\/\.(?:file-change-queue|file-snapshot)\.json\.\d+\.tmp$/.test(file);
export function historyKey(relative) {
  let hash=0xcbf29ce484222325n;
  for(const byte of Buffer.from(relative)){hash^=BigInt(byte);hash=BigInt.asUintN(64,hash*0x100000001b3n);}
  return hash.toString(16).padStart(16,'0');
}
export function recordKind(file) {
  if (/^\.llm-wiki\/history\/[a-f0-9]{16}\.json$/.test(file)) return 'history';
  if (/^\.llm-wiki\/chats\/conv_[\w-]+\.json$/.test(file)) return 'chat';
  if (file === '.llm-wiki/review.json') return 'review';
  return null;
}

// 只改上游明确用于定位文件的结构化字段。历史正文用于回顾，不做字符串替换。
export async function relocateRecord(file, bytes, {originalPath, originalAliases = [], validationPath, pathMoves = new Map()}) {
  const kind = recordKind(file);
  if (!kind) return null;
  let rows;
  try { rows = JSON.parse(bytes.toString('utf8')); } catch { fail(`历史记录 JSON 无效：${file}`); }
  if (!Array.isArray(rows)) fail(`历史记录格式未知：${file}`);
  if(kind==='history'&&new Set(rows.map(row=>row?.path)).size>1)fail(`同一历史文件包含多个来源路径：${file}`);
  const before = JSON.stringify(rows), scan = structuredClone(rows);
  const roots = await Promise.all([originalPath,...originalAliases].map(async root => normalize(await canonicalPath(root))));
  const target = normalize(validationPath);
  let destinationFile=file, sourceRelative;
  async function location(value) {
    if (typeof value !== 'string' || !value || value.includes('\0')) fail(`历史记录路径格式无效：${file}`);
    if (/^https?:\/\//i.test(value)) return value;
    const normalized = normalize(value);
    if (normalized.split('/').includes('..')) fail(`历史记录路径包含父目录跳转：${file}`);
    if (!path.isAbsolute(value) && !path.win32.isAbsolute(value)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(value)) fail(`历史记录路径协议或盘符形式未知：${file}`);
      return pathMoves.get(path.posix.normalize(normalized)) ?? value;
    }
    const absolute = normalize(await canonicalPath(value));
    const root = roots.find(root => same(absolute) === same(root) || same(absolute).startsWith(same(root)+'/'));
    if (!root) fail(`历史记录路径位于原库之外：${file}`);
    const relative=absolute.slice(root.length).replace(/^\//,'');
    return target + (relative ? '/'+(pathMoves.get(relative)??relative) : '');
  }
  const field = async (row, view, name) => { if (row[name] !== undefined) {row[name] = await location(row[name]);view[name]='';} };
  const list = async (row, view, name) => {
    if (row[name] === undefined) return;
    if (!Array.isArray(row[name])) fail(`历史记录路径列表无效：${file}`);
    row[name] = await Promise.all(row[name].map(location));view[name]=[];
  };
  const prose = (row, view, name) => {
    if (row[name] !== undefined) {
      if (typeof row[name] !== 'string') fail(`历史记录正文格式无效：${file}`);
      view[name] = '';
    }
  };
  for (let i=0;i<rows.length;i++) {
    const row=rows[i], view=scan[i];
    if (!row || Array.isArray(row) || typeof row !== 'object' || typeof row.id !== 'string') fail(`历史记录条目无效：${file}`);
    if (kind === 'history') {
      if (typeof row.path !== 'string' || (!path.isAbsolute(row.path)&&!path.win32.isAbsolute(row.path)) || typeof row.content !== 'string' || !Number.isFinite(row.timestamp) || typeof row.author !== 'string' || typeof row.tool !== 'string') fail(`文件历史格式未知：${file}`);
      const oldPath=row.path;
      await field(row,view,'path'); prose(row,view,'content');
      if(pathMoves.size){
        const absolute=normalize(await canonicalPath(oldPath)),root=roots.find(root=>same(absolute).startsWith(same(root)+'/'));
        if(!root)fail(`文件历史路径不能归属原库：${file}`);
        const relative=absolute.slice(root.length+1),next=pathMoves.get(relative);
        if(next&&next!==relative){
          const style=[relative,relative.replaceAll('/','\\')].find(value=>historyKey(value)===path.posix.basename(file,'.json'));
          if(style===undefined)fail(`文件历史查找键与路径不一致：${file}`);
          const key=historyKey(style.includes('\\')?next.replaceAll('/','\\'):next);
          const proposed=`.llm-wiki/history/${key}.json`;
          if(destinationFile!==file&&destinationFile!==proposed)fail(`同一历史文件包含不同目标路径：${file}`);
          destinationFile=proposed;sourceRelative=relative;
        }
      }
    } else if (kind === 'chat') {
      if (!['user','assistant','system'].includes(row.role) || typeof row.content !== 'string' || typeof row.conversationId !== 'string' || !Number.isFinite(row.timestamp)) fail(`聊天记录格式未知：${file}`);
      prose(row,view,'content'); await list(row,view,'contextFiles');
      if (row.references !== undefined) {
        if (!Array.isArray(row.references)) fail(`聊天引用格式未知：${file}`);
        for (let n=0;n<row.references.length;n++) {
          const ref=row.references[n], refView=view.references[n];
          if (!ref || typeof ref.path !== 'string' || typeof ref.title !== 'string') fail(`聊天引用条目无效：${file}`);
          await field(ref,refView,'path'); prose(ref,refView,'title'); prose(ref,refView,'snippet');
        }
      }
    } else {
      if (typeof row.title !== 'string' || typeof row.description !== 'string' || typeof row.resolved !== 'boolean' || !Number.isFinite(row.createdAt) || !Array.isArray(row.options)) fail(`审核记录格式未知：${file}`);
      await field(row,view,'sourcePath'); await list(row,view,'affectedPages');
      prose(row,view,'title'); prose(row,view,'description');
    }
  }
  return {kind,destinationFile,sourceRelative,bytes:JSON.stringify(rows)===before?bytes:Buffer.from(JSON.stringify(rows,null,2)),scanBytes:Buffer.from(JSON.stringify(scan))};
}
