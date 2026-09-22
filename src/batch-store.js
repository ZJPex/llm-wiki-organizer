import path from 'node:path';
import {atomicRename} from './atomic-rename.js';
import os from 'node:os';
import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {canonicalPath} from './filesystem-paths.js';
import {safePath} from './backup.js';
import {planDigest} from './categories.js';
export const batchFail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export const pathKey=value=>path.resolve(value).replaceAll('\\','/').toLowerCase();
export const within=(root,file)=>pathKey(root)===pathKey(file)||pathKey(file).startsWith(pathKey(root)+'/');
const queues=new Map();
export function createBatchStore({stateDirectory=path.join(os.homedir(),'.llm-wiki-organizer','batches')}={}){
 if(!path.isAbsolute(stateDirectory))batchFail('INVALID_PATH','批次状态目录必须为绝对路径');
 async function location(){const root=path.resolve(stateDirectory);let parent=root;while(!await lstat(parent).catch(e=>{if(e.code==='ENOENT')return null;throw e;}))parent=path.dirname(parent);await safePath(parent);await mkdir(root,{recursive:true});return safePath(root);}
 function id(value){if(typeof value!=='string'||! /^[0-9a-f-]{36}$/i.test(value))batchFail('INVALID_BATCH','批次标识无效');return value;}
 async function read(batchId){const root=await location(),file=path.join(root,`${id(batchId)}.json`);const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)batchFail('INVALID_BATCH','批次记录不能为链接');const record=JSON.parse(await readFile(file,'utf8'));const {recordHash,...unsigned}=record;if(planDigest(unsigned)!==recordHash||record.batchId!==batchId)batchFail('INVALID_BATCH','批次记录损坏');return record;}
 async function save(record,exclusive=false){const root=await location();delete record.recordHash;record.recordHash=planDigest(record);const file=path.join(root,`${id(record.batchId)}.json`);if(exclusive)await writeFile(file,JSON.stringify(record,null,2),{flag:'wx'});else{const temporary=`${file}.${randomUUID()}.tmp`;await writeFile(temporary,JSON.stringify(record,null,2),{flag:'wx'});await atomicRename(temporary,file);}return record;}
 async function serial(batchId,action){const key=path.join(await canonicalPath(stateDirectory),batchId),previous=queues.get(key)??Promise.resolve();const next=previous.catch(()=>{}).then(action);queues.set(key,next);try{return await next;}finally{if(queues.get(key)===next)queues.delete(key);}}
 // 校验、读取与同步投影共用写入队列，防止原子替换释放旧 inode，或终态落盘后误读旧执行权。
 // 投影只计算当前快照，不得在其中再次调用本批次的读写操作。
 const get=(batchId,project=record=>record)=>serial(id(batchId),async()=>project(await read(batchId)));
 return {directory:stateDirectory,create:record=>{const next={...record,schemaVersion:1,batchId:randomUUID(),revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};return serial(next.batchId,()=>save(next,true));},get,
  update:(batchId,revision,mutator)=>serial(id(batchId),async()=>{const record=await read(batchId);if(record.revision!==revision)batchFail('STALE_BATCH','批次已有新版本，请重新读取并审核');const next=await mutator(structuredClone(record));if(!next||next.batchId!==record.batchId)batchFail('INVALID_BATCH','不允许替换批次身份');return save({...next,revision:record.revision+1,updatedAt:new Date().toISOString()});}),
  list:async({cursor=0,limit=25}={},project=record=>record)=>{limit=Math.max(1,Math.min(50,Number(limit)||25));const root=await location(),names=(await readdir(root)).filter(name=>/^[0-9a-f-]{36}\.json$/i.test(name)).sort();const offset=Math.max(0,Number(cursor)||0);return {records:await Promise.all(names.slice(offset,offset+limit).map(name=>get(name.slice(0,-5),project))),nextCursor:offset+limit<names.length?offset+limit:null};}
 };
}
