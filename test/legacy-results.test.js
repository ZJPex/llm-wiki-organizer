import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,rm,rename} from 'node:fs/promises';
import {migrationFixture} from './helpers/migration-fixture.js';
import {httpFixtureScope} from './helpers/http-fixture-scope.js';
import {listenForBrowser} from './helpers/http-server.js';
import {createApp} from '../src/server.mjs';
import {createWorkspaceService} from '../src/workspace.js';
import {createBatchService} from '../src/batches.js';
import {createPlanningService} from '../src/planning.js';
import {createInboxStrategy} from '../src/inbox.js';
import {createBatchStore} from '../src/batch-store.js';

async function fixture(t){
 const f=await migrationFixture(t,{retained:true}),scope=httpFixtureScope(t,f.root);
 const sourceRoot=path.join(f.root,'inbox'),artifactRoot=path.join(f.root,'artifacts'),configPath=path.join(f.root,'config.json');
 await mkdir(sourceRoot);await mkdir(artifactRoot);await writeFile(path.join(sourceRoot,'a.md'),'材料解释缓存一致性、索引维护以及请求失败之后保留成功结果的恢复条件。');
 await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test'}}));
 await mkdir(path.join(f.root,'upstream/src/lib'),{recursive:true});await writeFile(path.join(f.root,'upstream/src/lib/source-watch-defaults.json'),JSON.stringify({enabled:false,autoIngest:false,includeExtensions:['.md'],excludeExtensions:[],excludeDirs:[],excludeGlobs:[]}));
 const settings={libraryPath:f.backup.originalPath,sourceRoot,artifactRoot,configPath,wikiSourcePath:path.join(f.root,'upstream')},calls=[];
 async function start(planningName='planning',beforeRequest=()=>{}){
  const planning=createPlanningService({stateDirectory:path.join(f.root,planningName),generate:async(_,request)=>{
   calls.push(request.stage);await beforeRequest(request);if(request.stage==='category-search')return {candidates:['']};
   if(request.stage==='category-choice')return {category:'',reason:'缓存主题',evidence:[request.content.evidence[0]],uncertain:false};
   return {title:'缓存主题',summary:request.content,evidence:[request.content.slice(0,12)],uncertain:false};
  }}),batches=createBatchService({planning,stateDirectory:path.join(f.root,'batches'),strategies:{inbox:createInboxStrategy()}}),workspace=createWorkspaceService({batches,stateDirectory:path.join(f.root,'settings')});
  const server=createApp({batches,workspace});scope.add(server);await listenForBrowser(server);
  const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session')).json();
  const request=async(action,input={})=>{const response=await fetch(base+'/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input),signal:AbortSignal.timeout(10000)}),body=await response.json();if(!response.ok)throw Object.assign(new Error(body.error),body);return body;};
  return {request,server};
 }
 const service=await start(),saved=await service.request('workspace/save',settings);
 async function legacy(name='人工缓存.md',request=service.request){
  let batch=await request('batches/create',{...settings,mode:'inbox'});
  batch=await request('batches/analyzeNext',{batchId:batch.batchId,revision:batch.revision});
  batch=await request('batches/classifyNext',{batchId:batch.batchId,revision:batch.revision});
  batch=await request('batches/reviewItem',{batchId:batch.batchId,revision:batch.revision,sourceId:batch.sources[0].sourceId,action:'confirmPlan',name,category:'',manuallyEdited:true});
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
 const reviewed=await restarted.request('inbox/review',{id:f.id,itemId:item.itemId,name:'人工缓存.md',category:'',reviewBasis:restored.items[0].reviewBasis});assert.equal(reviewed.items[0].status,'confirmed');assert.equal(f.calls.length,before);
});

test('同一正文的人工结果冲突必须明确选择来源，重复选择幂等，原确认和恢复入口保留',async t=>{
 const f=await fixture(t),first=await f.legacy('人工第一份.md'),other=await f.start('other-planning'),second=await f.legacy('人工第二份.md',other.request),before=f.calls.length;
 const scanned=await f.request('inbox/scan',{id:f.id}),item=scanned.items[0];
 assert.equal(item.status,'legacy-conflict');assert.equal(item.analysis,undefined);assert.deepEqual(item.legacyChoices.map(value=>value.name).sort(),['人工第一份.md','人工第二份.md']);
 await assert.rejects(f.request('inbox/start',{id:f.id,itemIds:[item.itemId]}),{code:'LEGACY_CHOICE_REQUIRED'});
 const originId=first.batchId+':'+first.sources[0].sourceId;
 const chosen=await f.request('inbox/chooseLegacy',{id:f.id,itemId:item.itemId,originId});assert.equal(chosen.items[0].suggestion,'人工第一份.md');
 const again=await f.request('inbox/chooseLegacy',{id:f.id,itemId:item.itemId,originId});assert.equal(again.items[0].itemId,item.itemId);assert.equal(again.items[0].history.length,2);assert.equal(f.calls.length,before);
 const original=await f.request('batches/get',{batchId:second.batchId});assert.equal(original.sources[0].confirmedName,'人工第二份.md');
 const history=await f.request('inbox/history',{id:f.id});assert.equal(history.records.length,2);assert.ok(history.records.every(value=>value.recoveryUrl.startsWith('/task-report?batchId=')));assert.equal(JSON.stringify(history).includes(f.root),false);
});

test('失效正文保留历史；更换来源目录不复用旧审核身份；归档目标移走或删除仍可读取完整收件箱',async t=>{
 const f=await fixture(t);await f.legacy();const before=f.calls.length;
 await writeFile(path.join(f.sourceRoot,'a.md'),'正文已经改变，新的主题是消息队列与消费顺序。');
 const invalid=await f.request('inbox/scan',{id:f.id});assert.equal(invalid.items[0].status,'pending');assert.equal(invalid.items[0].analysis,undefined);assert.match(invalid.items[0].history[0].reason,/正文已变化/);assert.equal(f.calls.length,before);
 const otherRoot=path.join(f.root,'other-inbox');await mkdir(otherRoot);await rename(path.join(f.sourceRoot,'a.md'),path.join(otherRoot,'a.md'));
 await f.request('workspace/save',{...f.settings,sourceRoot:otherRoot});
 const changed=await f.request('inbox/scan',{id:f.id});assert.notEqual(changed.items[0].itemId,invalid.items[0].itemId);assert.equal(changed.items[0].status,'pending');
 const history=await f.request('inbox/history',{id:f.id});assert.ok(history.records.length);
 await f.request('inbox/start',{id:f.id,itemIds:[changed.items[0].itemId]});
 let ready;for(let i=0;i<100;i++){ready=await f.request('inbox/list',{id:f.id});if(ready.items[0].status==='reviewable')break;await new Promise(resolve=>setTimeout(resolve,20));}
 const item=ready.items[0];const reviewed=await f.request('inbox/review',{id:f.id,itemId:item.itemId,name:'当前审核.md',category:'',reviewBasis:item.reviewBasis});
 await f.request('inbox/archive',{id:f.id,itemIds:[item.itemId],requestId:'archive',approved:true,writersPaused:true});
 await rm(reviewed.items[0].targetPath);
 const listed=await f.request('inbox/list',{id:f.id});assert.equal(listed.items[0].status,'archived');assert.equal(listed.items[0].archiveAvailability,'missing');
 const rescanned=await f.request('inbox/scan',{id:f.id});assert.equal(rescanned.items.length,1);assert.equal(rescanned.items[0].status,'archived');
});

test('无法证明分析版本或物理身份的旧结果只留历史，未完成执行现场必须从原任务恢复',async t=>{
 for(const scenario of ['version','identity','execution']){
  const f=await fixture(t),old=await f.legacy(),store=createBatchStore({stateDirectory:path.join(f.root,'batches')});
  await store.update(old.batchId,old.revision,batch=>{
   if(scenario==='version')delete batch.sources[0].analysisVersion;
   if(scenario==='identity')delete batch.sources[0].fileIdentity;
   if(scenario==='execution')batch.slices=[{sliceId:'pending',status:'applying',originalResultPath:path.join(f.root,'secret-original-result.json')}];
   return batch;
  });
  const before=f.calls.length,scanned=await f.request('inbox/scan',{id:f.id}),item=scanned.items[0];
  assert.equal(item.analysis,undefined);assert.equal(item.history[0].valid,false);assert.match(item.history[0].reason,scenario==='version'?/版本/:scenario==='identity'?/身份/:/执行现场/);assert.equal(f.calls.length,before);
  if(scenario==='execution'){
   assert.equal(item.status,'legacy-recovery');await assert.rejects(f.request('inbox/start',{id:f.id,itemIds:[item.itemId]}),{code:'EXECUTION_INTERRUPTED'});
   const original=await f.request('batches/get',{batchId:old.batchId});assert.equal(original.slices[0].status,'applying');assert.equal(original.slices[0].originalResultPath,path.join(f.root,'secret-original-result.json'));
   const history=await f.request('inbox/history',{id:f.id});assert.equal(JSON.stringify(history).includes(f.root),false);
  }
 }
});

test('首次扫描前已能从知识库访问旧任务历史；模型配置改变不能接入旧分析',async t=>{
 const f=await fixture(t),old=await f.legacy(),before=f.calls.length;
 const history=await f.request('inbox/history',{id:f.id});assert.equal(history.records[0].originId,old.batchId+':'+old.sources[0].sourceId);assert.equal(history.records[0].valid,false);
 await writeFile(f.settings.configPath,JSON.stringify({llmConfig:{provider:'custom',model:'changed',apiKey:'private-key'}}));
 const scanned=await f.request('inbox/scan',{id:f.id});assert.equal(scanned.items[0].status,'pending');assert.equal(scanned.items[0].analysis,undefined);assert.match(scanned.items[0].history[0].reason,/模型配置/);assert.equal(f.calls.length,before);assert.equal(JSON.stringify(scanned.items[0].history).includes('private-key'),false);
});

test('同一知识库设置 ID 下项目身份替换撤销审核身份，未变正文仅作为待重审草稿复用',async t=>{
 const f=await fixture(t);await f.legacy();const first=await f.request('inbox/scan',{id:f.id}),item=first.items[0];
 await f.request('inbox/review',{id:f.id,itemId:item.itemId,name:'人工缓存.md',category:'',reviewBasis:item.reviewBasis});const before=f.calls.length;
 await writeFile(path.join(f.settings.libraryPath,'.llm-wiki/project.json'),JSON.stringify({id:'replacement-project',createdAt:2}));
 await assert.rejects(f.request('inbox/list',{id:f.id}),{code:'LIBRARY_CHANGED'});
 const saved=await f.request('workspace/save',f.settings);assert.equal(saved.id,f.id);
 const changed=await f.request('inbox/scan',{id:f.id});assert.notEqual(changed.items[0].itemId,item.itemId);assert.equal(changed.items[0].status,'needs-classification');assert.equal(changed.items[0].suggestion,'人工缓存.md');assert.ok(changed.items[0].analysis);assert.equal(f.calls.length,before);
 await assert.rejects(f.request('inbox/review',{id:f.id,itemId:item.itemId,name:'人工缓存.md',category:'',reviewBasis:item.reviewBasis}),{code:'INVALID_SELECTION'});
});

test('接入正文已持久而收件箱关联未保存时，再扫描复用同一接入结果且不增建任务',async t=>{
 const f=await fixture(t);await f.legacy();await f.request('inbox/scan',{id:f.id});
 const before=await f.request('batches/list',{}),calls=f.calls.length,store=createBatchStore({stateDirectory:path.join(f.root,'settings/inbox')});
 const saved=(await store.list({limit:50})).records[0];await store.update(saved.batchId,saved.revision,value=>({...value,items:[]}));
 await f.scope.close(f.server);const restarted=await f.start();const scanned=await restarted.request('inbox/scan',{id:f.id});assert.equal(scanned.items[0].suggestion,'人工缓存.md');
 const after=await restarted.request('batches/list',{});assert.deepEqual(after.records.map(value=>value.batchId).sort(),before.records.map(value=>value.batchId).sort());assert.equal(f.calls.length,calls);
});

test('已接入的旧正文遇到模型语义配置变化后撤销可执行建议，保留历史且刷新不发请求',async t=>{
 const f=await fixture(t);await f.legacy();const initial=await f.request('inbox/scan',{id:f.id}),before=f.calls.length;
 await writeFile(f.settings.configPath,JSON.stringify({llmConfig:{provider:'custom',model:'different'}}));
 const changed=await f.request('inbox/scan',{id:f.id});assert.equal(changed.items[0].itemId,initial.items[0].itemId);assert.equal(changed.items[0].status,'pending');assert.equal(changed.items[0].analysis,undefined);assert.match(changed.items[0].invalidatedReason,/模型配置/);assert.ok(changed.items[0].history.length);assert.equal(f.calls.length,before);
});

test('历史摘要不输出配置凭据或旧结果中的私有绝对路径',async t=>{
 const f=await fixture(t);await writeFile(f.settings.configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test',apiKey:'private-key'}}));const old=await f.legacy();
 const store=createBatchStore({stateDirectory:path.join(f.root,'batches')});await store.update(old.batchId,old.revision,value=>{value.sources[0].confirmedName='private-key.md';value.sources[0].tags=['private-key',path.join(f.root,'private-data')];return value;});
 const history=await f.request('inbox/history',{id:f.id}),text=JSON.stringify(history);assert.equal(text.includes('private-key'),false);assert.equal(text.includes(f.root.replaceAll('\\','\\\\')),false);assert.match(text,/已隐藏/);
});

test('旧任务仍在派发时不复制其结果或重复开始；静止后再刷新直接复用',async t=>{
 const f=await fixture(t);let release,reached;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>reached=resolve);
 const active=await f.start('ongoing',async request=>{if(request.stage==='category-choice'){reached();await gate;}});
 const old=await active.request('batches/create',{...f.settings,mode:'inbox'});await active.request('batches/startAnalysis',{batchId:old.batchId});await ready;
 try{
  const before=f.calls.length,scan=await f.request('inbox/scan',{id:f.id});assert.equal(scan.items[0].status,'legacy-active');assert.equal(scan.items[0].analysis,undefined);assert.equal(f.calls.length,before);
  await assert.rejects(f.request('inbox/start',{id:f.id,itemIds:[scan.items[0].itemId]}),{code:'BATCH_BUSY'});
 }finally{
  release();for(let i=0;i<100;i++){const state=await active.request('batches/get',{batchId:old.batchId});if(!['running','pausing'].includes(state.analysisJob.status))break;await new Promise(resolve=>setTimeout(resolve,20));}
 }
 const scan=await f.request('inbox/scan',{id:f.id});assert.ok(scan.items[0].analysis);assert.ok(['needs-classification','reviewable'].includes(scan.items[0].status));
});

test('接入后新增的人工确认也保留为来源；知识库身份改变后不能静默丢弃或按新旧覆盖',async t=>{
 const f=await fixture(t);await f.legacy();const scanned=await f.request('inbox/scan',{id:f.id}),item=scanned.items[0];
 await f.request('inbox/review',{id:f.id,itemId:item.itemId,name:'再次人工修改.md',category:'',reviewBasis:item.reviewBasis,manuallyEdited:true});
 await writeFile(path.join(f.settings.libraryPath,'.llm-wiki/project.json'),JSON.stringify({id:'replacement-project',createdAt:2}));await f.request('workspace/save',f.settings);
 const changed=await f.request('inbox/scan',{id:f.id});assert.equal(changed.items[0].status,'legacy-conflict');assert.deepEqual(changed.items[0].legacyChoices.map(value=>value.name).sort(),['人工缓存.md','再次人工修改.md']);assert.equal(changed.items[0].legacyChoices.every(value=>value.confirmed===false),true);
});
