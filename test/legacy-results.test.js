import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {migrationFixture} from './helpers/migration-fixture.js';
import {httpFixtureScope} from './helpers/http-fixture-scope.js';
import {listenForBrowser} from './helpers/http-server.js';
import {createApp} from '../src/server.mjs';
import {createWorkspaceService} from '../src/workspace.js';
import {createBatchService} from '../src/batches.js';
import {createPlanningService} from '../src/planning.js';
import {createInboxStrategy} from '../src/inbox.js';

async function fixture(t){
 const f=await migrationFixture(t,{retained:true}),scope=httpFixtureScope(t,f.root);
 const sourceRoot=path.join(f.root,'inbox'),artifactRoot=path.join(f.root,'artifacts'),configPath=path.join(f.root,'config.json');
 await mkdir(sourceRoot);await mkdir(artifactRoot);await writeFile(path.join(sourceRoot,'a.md'),'材料解释缓存一致性、索引维护以及请求失败之后保留成功结果的恢复条件。');
 await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test'}}));
 const settings={libraryPath:f.backup.originalPath,sourceRoot,artifactRoot,configPath,wikiSourcePath:path.join(f.root,'upstream')},calls=[];
 async function start(){
  const planning=createPlanningService({stateDirectory:path.join(f.root,'planning'),generate:async(_,request)=>{
   calls.push(request.stage);if(request.stage==='category-search')return {candidates:['']};
   if(request.stage==='category-choice')return {category:'',reason:'缓存主题',evidence:[request.content.evidence[0]],uncertain:false};
   return {title:'缓存主题',summary:request.content,evidence:[request.content.slice(0,12)],uncertain:false};
  }}),batches=createBatchService({planning,stateDirectory:path.join(f.root,'batches'),strategies:{inbox:createInboxStrategy()}}),workspace=createWorkspaceService({batches,stateDirectory:path.join(f.root,'settings')});
  const server=createApp({batches,workspace});scope.add(server);await listenForBrowser(server);
  const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session')).json();
  const request=async(action,input={})=>{const response=await fetch(base+'/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input),signal:AbortSignal.timeout(10000)}),body=await response.json();if(!response.ok)throw Object.assign(new Error(body.error),body);return body;};
  return {request,server};
 }
 const service=await start(),saved=await service.request('workspace/save',settings);
 async function legacy(name='人工缓存.md'){
  let batch=await service.request('batches/create',{...settings,mode:'inbox'});
  batch=await service.request('batches/analyzeNext',{batchId:batch.batchId,revision:batch.revision});
  batch=await service.request('batches/classifyNext',{batchId:batch.batchId,revision:batch.revision});
  batch=await service.request('batches/reviewItem',{batchId:batch.batchId,revision:batch.revision,sourceId:batch.sources[0].sourceId,action:'confirmPlan',name,category:'',manuallyEdited:true});
  return batch;
 }
 return {...f,...service,scope,start,legacy,id:saved.id,settings,sourceRoot,calls};
}

test('旧任务的有效正文直接进入收件箱；无库身份证据的人工确认保留草稿并重审，重复扫描和重启零模型请求',async t=>{
 const f=await fixture(t),old=await f.legacy(),before=f.calls.length;
 const result=await f.request('inbox/scan',{id:f.id}),item=result.items[0];
 assert.equal(item.analysis.summary,'材料解释缓存一致性、索引维护以及请求失败之后保留成功结果的恢复条件。');
 assert.equal(item.suggestion,'人工缓存.md');assert.equal(item.status,'needs-classification');assert.match(item.invalidatedReason,/知识库身份/);
 assert.equal(f.calls.length,before);assert.equal(item.history[0].originId,old.batchId+':'+old.sources[0].sourceId);
 const repeated=await f.request('inbox/scan',{id:f.id});assert.equal(repeated.items[0].itemId,item.itemId);assert.equal(repeated.items[0].history.length,1);
 await f.scope.close(f.server);const restarted=await f.start();const restored=await restarted.request('inbox/list',{id:f.id});assert.equal(restored.items[0].analysis.summary,item.analysis.summary);assert.equal(f.calls.length,before);
 const reviewed=await restarted.request('inbox/review',{id:f.id,itemId:item.itemId,name:'人工缓存.md',category:''});assert.equal(reviewed.items[0].status,'confirmed');assert.equal(f.calls.length,before);
});
