import path from 'node:path';
import os from 'node:os';
import {readFile,lstat,readdir} from 'node:fs/promises';
import {createBatchStore,batchFail,within} from './batch-store.js';
import {safePath} from './backup.js';
import {canonicalPath} from './filesystem-paths.js';
import {readModelConfig} from './model-config.js';
import {categoryCatalog} from './categories.js';

// 仅持久化位置与知识库身份；模型配置始终从 Wiki 只读加载。
export function createWorkspaceService({batches,stateDirectory=path.join(os.homedir(),'.llm-wiki-organizer','libraries')}={}) {
 const store=createBatchStore({stateDirectory});
 const fields=['libraryPath','sourceRoot','wikiSourcePath','configPath','artifactRoot'];
 const publicRecord=record=>({id:record.batchId,revision:record.revision,...Object.fromEntries(fields.map(key=>[key,record[key]]))});
 async function validate(input) {
  const result={};
  for(const field of fields.filter(key=>key!=='configPath')) {
   try{result[field]=await safePath(input[field]);}catch{batchFail('INVALID_SETTINGS',`请修正 ${field}：需要有效的绝对目录路径`);}
  }
  await safePath(path.join(result.libraryPath,'raw/sources'));
  await safePath(path.join(result.libraryPath,'.llm-wiki'));
  if(within(result.sourceRoot,result.libraryPath)||(within(result.libraryPath,result.sourceRoot)&&!within(path.join(result.libraryPath,'raw/sources'),result.sourceRoot)))batchFail('INVALID_INBOX','库内收件箱必须位于 raw/sources；外部收件箱必须与知识库独立');
  const state=await canonicalPath(stateDirectory);
  for(const root of [result.libraryPath,result.sourceRoot,result.wikiSourcePath])
   if(within(root,result.artifactRoot)||within(result.artifactRoot,root)||within(root,state)||within(state,root)||within(result.artifactRoot,state)||within(state,result.artifactRoot))batchFail('OVERLAPPING_PATHS','设置状态与备份目录必须独立于知识库、来源和源码，并彼此隔离');
  try {
   await safePath(path.dirname(input.configPath));
   const stat=await lstat(input.configPath);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error();
   result.configPath=await canonicalPath(input.configPath);
   await readModelConfig(result);
  }catch{batchFail('INVALID_CONFIG','请补齐或修正 Wiki 配置文件，需包含受支持的有效模型配置；无需复制密钥');}
  const project=JSON.parse(await readFile(path.join(result.libraryPath,'.llm-wiki/project.json'),'utf8'));
  if(typeof project.id!=='string'||!project.id)batchFail('INVALID_LIBRARY','知识库缺少有效项目身份');
  const stat=await lstat(result.libraryPath);
  result.libraryIdentity=JSON.stringify([project.id,String(stat.dev),String(stat.ino),stat.birthtimeMs]);
  if(input.libraryIdentity&&input.libraryIdentity!==result.libraryIdentity)batchFail('LIBRARY_CHANGED','原位置的知识库身份已变化，请重新核对并保存设置');
  return result;
 }
 async function checked(id){const record=await store.get(id);await validate(record);return record;}
 async function all(){const records=[];let cursor=0;do{const page=await store.list({cursor,limit:50});records.push(...page.records);cursor=page.nextCursor;}while(cursor!==null);return records;}
 return {
  list:async()=>({libraries:await Promise.all((await all()).map(async record=>{try{await validate(record);return {...publicRecord(record),valid:true};}catch(error){return {...publicRecord(record),valid:false,error:error.message};}}))}),
  save:async input=>{
   const value=await validate(input);
   const existing=(await all()).find(record=>within(record.libraryPath,value.libraryPath)&&within(value.libraryPath,record.libraryPath));
   if(input.id&&input.id!==existing?.batchId)batchFail('LIBRARY_MISMATCH','保存的设置不能切换到其他知识库，请新增知识库');
   const record=existing?await store.update(existing.batchId,input.revision??existing.revision,()=>({...existing,...value})):await store.create(value);
   return {...publicRecord(record),valid:true};
  },
  create:async input=>{const record=await checked(input.id);if(!['inbox','restructure'].includes(input.mode))batchFail('INVALID_MODE','请选择整理方式');return batches.create({...Object.fromEntries(fields.map(key=>[key,record[key]])),mode:input.mode,sourceRoot:input.mode==='restructure'?path.join(record.libraryPath,'raw/sources'):record.sourceRoot});},
  categories:async input=>{
   const record=await checked(input.id),root=path.join(record.libraryPath,'raw/sources');
   const catalog=await categoryCatalog(root),category=input.category??'';
   if(!catalog.categories.some(item=>item.path===category))batchFail('INVALID_CATEGORY','分类不存在');
   const entries=await readdir(path.join(root,category),{withFileTypes:true});
   const files=entries.filter(entry=>entry.isFile()&&/\.md$/i.test(entry.name)).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0).map(entry=>({name:entry.name,path:path.join(root,category,entry.name)}));
   const cursor=Math.max(0,Number(input.cursor)||0),limit=50;
   return {categories:catalog.categories,category,files:files.slice(cursor,cursor+limit),total:files.length,nextCursor:cursor+limit<files.length?cursor+limit:null};
  },
 };
}
