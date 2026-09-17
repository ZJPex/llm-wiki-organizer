import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {safePath,layout} from './backup.js';
import {inventory} from './compatibility.js';
import {sourceFrontmatter} from './source-format.js';
import {within,batchFail} from './batch-store.js';
export async function discoverSources({libraryPath,sourceRoot}){
 const library=await safePath(libraryPath),root=await safePath(sourceRoot),raw=path.join(library,'raw/sources');await layout(root);
 const read=async name=>JSON.parse(await readFile(path.join(library,'.llm-wiki',name),'utf8'));
 const cache=await read('ingest-cache.json'),ingest=await read('ingest-queue.json'),changes=await read('file-change-queue.json');
 if(!cache.entries||Array.isArray(cache.entries)||!Array.isArray(ingest)||!Array.isArray(changes.tasks))batchFail('UNKNOWN_ASSOCIATION','摄取状态格式无法判定');
 const tasks=[...ingest,...changes.tasks],busy=tasks.some(task=>['pending','processing','running','queued'].includes(task.status));
 const wiki=await inventory(path.join(library,'wiki')),references=[];
 for(const file of wiki.files.filter(file=>/\.md$/i.test(file.path))){const fm=sourceFrontmatter(await readFile(path.join(library,'wiki',file.path),'utf8'));references.push(...fm.sources);}
 const baseline=await inventory(root),sources=[];
 for(const file of baseline.files.filter(file=>/\.md$/i.test(file.path))){
  const currentPath=path.join(root,file.path),rawIdentity=within(raw,currentPath)?path.relative(raw,currentPath).replaceAll('\\','/'):null;
  const entry=rawIdentity?cache.entries[rawIdentity]:null;
  const linked=rawIdentity&&references.some(value=>{const identity=value.replaceAll('\\','/').replace(/^raw\/sources\//,'');return identity===rawIdentity||(!identity.includes('/')&&path.posix.basename(rawIdentity)===identity);});
  const queued=rawIdentity&&tasks.some(task=>[task.sourcePath,task.path,task.oldPath,task.newPath].some(value=>value===rawIdentity||value===`raw/sources/${rawIdentity}`));
  const ingestStatus=entry?'historical':linked||queued?'uncertain':'new';
  sources.push({identity:file.path,currentIdentity:file.path,currentPath,hash:file.hash,rawIdentity,ingestStatus,busy,status:ingestStatus==='uncertain'?'blocked':'pending',skipReason:ingestStatus==='uncertain'?'缺少摄取缓存但存在页面关联或任务，不能按新文件归档':null});
 }
 return {sources,flow:{busy,sourceBaselineHash:baseline.hash}};
}
