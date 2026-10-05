import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {safePath,layout} from './backup.js';
import {inventory} from './compatibility.js';
import {sourceFrontmatter} from './source-format.js';
import {within,batchFail} from './batch-store.js';
import {planDigest} from './categories.js';
export function assertSourceAssociation(expected,current){
 if(!current||!expected.associationHash||current.ingestStatus!==expected.ingestStatus||current.associationHash!==expected.associationHash)batchFail('STALE_ASSOCIATION','来源摄取身份或关联记录已变化，请重新分析、审核并选择对应的安全迁移流程');
}
export async function discoverSources({libraryPath,sourceRoot,includeIdentities=[]}){
 const library=await safePath(libraryPath),root=await safePath(sourceRoot),raw=path.join(library,'raw/sources');await layout(root);
 const read=async name=>JSON.parse(await readFile(path.join(library,'.llm-wiki',name),'utf8'));
 const cache=await read('ingest-cache.json'),ingest=await read('ingest-queue.json'),changes=await read('file-change-queue.json');
 if(!cache.entries||Array.isArray(cache.entries)||!Array.isArray(ingest)||!Array.isArray(changes.tasks))batchFail('UNKNOWN_ASSOCIATION','摄取状态格式无法判定');
 const tasks=[...ingest,...changes.tasks],busy=tasks.some(task=>['pending','processing','running','queued'].includes(task.status));
 // 外部收件箱没有 Raw 身份，不参与 Wiki 关联；避免为新增材料读取整库正文。
 // 根目录包含 Raw 时仍保留扫描，不能漏掉混合范围中的历史材料。
 const needsWiki=within(raw,root)||within(root,raw);
 const wiki=needsWiki?await inventory(path.join(library,'wiki')):{files:[]},references=[];
 for(const file of wiki.files.filter(file=>/\.md$/i.test(file.path))){const fm=sourceFrontmatter(await readFile(path.join(library,'wiki',file.path),'utf8'));references.push({path:file.path,hash:file.hash,sources:fm.sources});}
 const baseline=await inventory(root),sources=[];
 const candidates=baseline.files.filter(file=>/\.md$/i.test(file.path));
 for(const identity of includeIdentities){if(typeof identity!=='string'||path.isAbsolute(identity)||identity.includes('\\')||identity.split('/').some(part=>!part||part==='.'||part==='..'))batchFail('INVALID_SOURCE','待核验来源身份无效');if(!candidates.some(file=>file.path===identity))candidates.push({path:identity,hash:null});}
 for(const file of candidates){
  const currentPath=path.join(root,file.path),rawIdentity=within(raw,currentPath)?path.relative(raw,currentPath).replaceAll('\\','/'):null;
  const entry=rawIdentity?cache.entries[rawIdentity]:null;
  const linked=rawIdentity?references.filter(page=>page.sources.some(value=>{const identity=value.replaceAll('\\','/').replace(/^raw\/sources\//,'');return identity===rawIdentity||(!identity.includes('/')&&path.posix.basename(rawIdentity)===identity);})):[];
  const queued=rawIdentity?tasks.filter(task=>[task.sourcePath,task.path,task.oldPath,task.newPath].some(value=>value===rawIdentity||value===`raw/sources/${rawIdentity}`||(typeof value==='string'&&path.isAbsolute(value)&&path.resolve(value).toLowerCase()===path.resolve(currentPath).toLowerCase()))):[];
  const ingestStatus=entry?'historical':linked.length||queued.length?'uncertain':'new';
  const outputs=(entry?.filesWritten??[]).map(output=>{const relative=path.isAbsolute(output)?path.relative(library,output).replaceAll('\\','/'):output;return {path:relative,hash:wiki.files.find(item=>`wiki/${item.path}`===relative)?.hash??null};});
  const associationHash=planDigest({rawIdentity,entry:entry??null,linked,queued,outputs});
  sources.push({identity:file.path,currentIdentity:file.path,currentPath,hash:file.hash,rawIdentity,ingestStatus,associationHash,busy,status:ingestStatus==='uncertain'?'blocked':'pending',skipReason:ingestStatus==='uncertain'?'缺少摄取缓存但存在页面关联或任务，不能按新文件归档':null});
 }
 return {sources,flow:{busy,sourceBaselineHash:baseline.hash}};
}
