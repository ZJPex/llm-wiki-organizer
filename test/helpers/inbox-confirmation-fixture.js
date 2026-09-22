import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {migrationFixture} from './migration-fixture.js';
import {listenForBrowser} from './http-server.js';
import {createPlanningService} from '../../src/planning.js';
import {createInboxStrategy} from '../../src/inbox.js';
import {createBatchService} from '../../src/batches.js';
import {createBatchStore} from '../../src/batch-store.js';
import {createApp} from '../../src/server.mjs';

export async function inboxConfirmationFixture(t,{operations=[]}={}) {
 const f=await migrationFixture(t),libraryPath=f.backup.originalPath;
 const sourceRoot=path.join(f.root,'inbox'),artifactRoot=path.join(f.root,'artifacts');
 await mkdir(sourceRoot);await mkdir(artifactRoot);
 await mkdir(path.join(libraryPath,'raw/sources/001 缓存'));
 for(const name of ['a','b','root','unknown','unnamed','excluded','reviewed'])
  await writeFile(path.join(sourceRoot,name+'.md'),`[${name}] 这份材料讨论缓存一致性、索引维护与失败恢复。`);
 const configPath=path.join(f.root,'config.json');
 await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test'}}));
 const planning=createPlanningService({stateDirectory:path.join(f.root,'planning'),generate:async(_,request)=>{
  if(request.stage==='category-search')return {candidates:['','001 缓存']};
  if(request.stage==='category-choice')return {category:request.content.summary.includes('[unknown]')?null:request.content.summary.includes('[root]')?'':'001 缓存',reason:'正文主题',evidence:[request.content.evidence[0]],uncertain:false};
  if(request.stage==='evolution')return {canContain:!operations.length,parentAffected:false,operations,reason:'按明确范围调整'};
  return {title:'缓存主题',summary:request.content,evidence:[request.content.slice(0,12)],uncertain:false};
 }});
 const server=createApp({batches:createBatchService({stateDirectory:path.join(f.root,'batches'),planning,strategies:{inbox:createInboxStrategy()}})});
 await listenForBrowser(server);t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const request=async(action,input)=>{
  const {token}=await(await fetch(base+'/api/session')).json();
  const response=await fetch(base+'/api/batches/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)});
  const result=await response.json();
  if(!response.ok)throw Object.assign(new Error(result.error),result,{httpStatus:response.status});
  return result;
 };
 let batch=await request('create',{mode:'inbox',libraryPath,sourceRoot,artifactRoot,wikiSourcePath:path.join(f.root,'upstream'),configPath});
 const call=async(action,input={})=>batch=await request(action,{batchId:batch.batchId,revision:batch.revision,...input});
 await call('analyzeNext',{limit:5});await call('analyzeNext',{limit:5});
 for(const source of batch.sources.filter(item=>item.identity!=='unnamed.md')){
  await call('reviewItem',{sourceId:source.sourceId,action:'confirmName',name:source.identity});
  await call('reviewItem',{sourceId:source.sourceId,action:'classify'});
 }
 await call('reviewItem',{sourceId:batch.sources.find(s=>s.identity==='excluded.md').sourceId,action:'exclude'});
 await call('reviewItem',{sourceId:batch.sources.find(s=>s.identity==='reviewed.md').sourceId,action:'confirmCategory',category:''});
 // 构造重启后读取到的中断快照；测试断言仍通过 HTTP 公共视图完成。
 const interruptedExecution=async()=>{
  const store=createBatchStore({stateDirectory:path.join(f.root,'batches')});
  await store.update(batch.batchId,batch.revision,record=>({...record,slices:[{sliceId:'interrupted',status:'applying'}]}));
  await call('get');
 };
 return {base,sourceRoot,libraryPath,root:f.root,request,call,getBatch:()=>batch,interruptedExecution};
}
