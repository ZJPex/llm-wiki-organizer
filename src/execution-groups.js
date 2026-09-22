import path from 'node:path';
import {createHash} from 'node:crypto';
import {inventory} from './compatibility.js';
import {layout} from './backup.js';
import {planDigest} from './categories.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function executionGroups(moves,size=20){
 size=Math.max(1,Math.min(100,Math.floor(Number(size)||20)));
 const groups=[];for(let start=0;start<moves.length;start+=size){const indexes=moves.slice(start,start+size).map((_,offset)=>start+offset);groups.push({groupId:`group-${groups.length+1}`,moveIndexes:indexes,itemIds:[...new Set(indexes.map(index=>moves[index].itemId))]});}return groups;
}
// 预期状态只能从原始清单和已冻结操作推导，绝不把读取到的任意现状提升为可信基线。
export function createExpectedState(baseline,directories){
 const files=new Map(baseline.files.map(file=>[file.path,file.hash])),dirs=new Set(directories);
 const addParents=file=>{for(let dir=path.posix.dirname(file);dir!=='.';dir=path.posix.dirname(dir))dirs.add(dir);};
 const snapshot=()=>({files:[...files].sort(([a],[b])=>a.localeCompare(b)).map(([path,hash])=>({path,hash})),directories:[...dirs].sort()});
 return {
  hash:file=>files.get(file),write:(file,content)=>{files.set(file,hash(content));addParents(file);},place:(file,digest)=>{files.set(file,digest);addParents(file);},remove:file=>files.delete(file),
  directory:dir=>{dirs.add(dir);addParents(dir);},removeDirectory:dir=>{if(![...files.keys(),...dirs].some(file=>file.startsWith(dir+'/')))dirs.delete(dir);},
  snapshot,
  async verify(root){const actual=await inventory(root),actualDirs=await layout(root),expected=snapshot();const got={files:actual.files.map(file=>({path:file.path,hash:file.hash})).sort((a,b)=>a.path.localeCompare(b.path)),directories:actualDirs.sort()};if(planDigest(got)!==planDigest(expected))throw Object.assign(new Error('执行分批边界检测到未由冻结操作和日志证明的外部变化，保留现场并停止'),{code:'UNEXPECTED_CHANGE'});return planDigest(expected);}
 };
}
