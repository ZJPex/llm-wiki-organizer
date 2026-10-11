import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {migrationFixture} from './helpers/migration-fixture.js';
import {listenForBrowser} from './helpers/http-server.js';
import {createApp} from '../src/server.mjs';
import {createPlanningService} from '../src/planning.js';
import {createBatchService} from '../src/batches.js';
import {createInboxStrategy} from '../src/inbox.js';
import {createWorkspaceService} from '../src/workspace.js';

async function waitFor(read,predicate){for(let i=0;i<200;i++){const value=await read();if(predicate(value))return value;await delay(15);}throw new Error('等待审核状态超时');}
const answer=request=>request.stage==='category-search'?{candidates:['']}:request.stage==='category-choice'?{category:'',reason:'全文用途',evidence:request.content.evidence,uncertain:false}:{title:'缓存资料',summary:request.content.slice(0,40),evidence:[request.content.slice(0,20)],uncertain:false};
async function fixture(t,generate){
 const f=await migrationFixture(t,{retained:true}),sourceRoot=path.join(f.root,'inbox'),artifactRoot=path.join(f.root,'artifacts'),configPath=path.join(f.root,'config.json');
 await mkdir(sourceRoot);await mkdir(artifactRoot);await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test',maxContextSize:1024}}));
 const planning=createPlanningService({stateDirectory:path.join(f.root,'planning'),generate}),batches=createBatchService({planning,stateDirectory:path.join(f.root,'batches'),strategies:{inbox:createInboxStrategy()}}),workspace=createWorkspaceService({batches,stateDirectory:path.join(f.root,'settings')}),server=createApp({planning,batches,workspace});
 await listenForBrowser(server);t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(f.root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session')).json();
 const call=async(action,input={})=>{const response=await fetch(base+'/api/'+action,{signal:AbortSignal.timeout(5000),method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)}),result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error),result);return result;};
 const settings={sourceRoot,artifactRoot,configPath,libraryPath:f.backup.originalPath,wikiSourcePath:path.join(f.root,'upstream')};return {...f,sourceRoot,settings,call,create:(extra={})=>call('batches/create',{mode:'inbox',...settings,...extra})};
}
test('整批仍分析时保存已完成材料审核，其他结果回写保留人工授权且归档仍被阻止',async t=>{
 let open=false;const pending=[];
 const f=await fixture(t,async(_,request)=>{if(request.identity==='b.md'&&!open)await new Promise(resolve=>pending.push(resolve));return answer(request);});
 const release=()=>{open=true;pending.forEach(resolve=>resolve());};
 try{
  await writeFile(path.join(f.sourceRoot,'a.md'),'正文说明缓存一致性与失败恢复的用途，提供完整可核验的证据。');await writeFile(path.join(f.sourceRoot,'b.md'),'另一份正文说明索引维护与数据可靠性，继续处理时保持其他审核。');
  const batch=await f.create(),id={batchId:batch.batchId};await f.call('batches/startAnalysis',id);
  const partial=await waitFor(()=>f.call('batches/get',id),value=>value.sources[0].classification&&value.sources[1].progress?.status==='running');
  const reviewed=await f.call('batches/confirmPlans',{...id,revision:batch.revision,items:[{sourceId:partial.sources[0].sourceId,reviewBasis:partial.sources[0].reviewBasis,name:'人工名称.md',category:'',tags:['可靠性'],manuallyEdited:true}]});
  assert.equal(reviewed.analysisJob.status,'running');assert.equal(reviewed.sources[0].status,'reviewed');assert.equal(reviewed.sources[0].selected,true);
  await assert.rejects(f.call('batches/confirmNewArchive',{...id,revision:reviewed.revision,writersPaused:true,requestId:'running-review',items:[{sourceId:reviewed.sources[0].sourceId,name:'人工名称.md',category:''}]}),{code:'BATCH_BUSY'});
  assert.match(await readFile(path.join(f.sourceRoot,'a.md'),'utf8'),/缓存一致性/);
  release();const complete=await waitFor(()=>f.call('batches/get',id),value=>value.analysisJob.status==='complete');
  assert.equal(complete.sources[0].confirmedName,'人工名称.md');assert.equal(complete.sources[0].status,'reviewed');assert.equal(complete.sources[0].selected,true);assert.deepEqual(complete.sources[0].tags,['可靠性']);assert.ok(complete.sources[1].classification);
 }finally{release();}
});
test('收件箱保存必须携带所见依据，进度更新允许保存而已陈旧草稿不能复用新授权',async t=>{
 let open=false;const pending=[],release=()=>{open=true;pending.forEach(resolve=>resolve());};const f=await fixture(t,async(_,request)=>{if(request.identity==='b.md'&&!open)await new Promise(resolve=>pending.push(resolve));return answer(request);});let id;
 try{
  for(const name of ['a','b'])await writeFile(path.join(f.sourceRoot,name+'.md'),'正文说明缓存一致性与恢复用途，给出可核验的全文证据。');id=(await f.call('workspace/save',f.settings)).id;
  const scanned=await f.call('inbox/scan',{id});await f.call('inbox/start',{id,itemIds:scanned.items.map(item=>item.itemId)});
  const ready=await waitFor(()=>f.call('inbox/list',{id}),value=>value.items.find(item=>item.identity==='a.md')?.status==='reviewable'),item=ready.items.find(item=>item.identity==='a.md');
  await assert.rejects(f.call('inbox/review',{id,itemId:item.itemId,name:'人工确认.md',category:''}),{code:'REVIEW_REQUIRED'});
  const reviewed=await f.call('inbox/review',{id,itemId:item.itemId,reviewBasis:item.reviewBasis,name:'人工确认.md',category:''});assert.equal(reviewed.analysisActive,true);assert.equal(reviewed.items.find(value=>value.itemId===item.itemId).status,'confirmed');
  await assert.rejects(f.call('inbox/review',{id,itemId:item.itemId,reviewBasis:item.reviewBasis,name:'人工确认.md',category:''}),{code:'STALE_REVIEW'});
 }finally{release();if(id)await waitFor(()=>f.call('inbox/list',{id}),value=>!value.analysisActive).catch(()=>{});}
});
test('同库新材料分析期间仍可审核旧完成材料，正在暂停也不能归档',async t=>{
 let open=false;const pending=[],release=()=>{open=true;pending.forEach(resolve=>resolve());};const f=await fixture(t,async(_,request)=>{if(request.identity==='b.md'&&!open)await new Promise(resolve=>pending.push(resolve));return answer(request);});
 try{
  await writeFile(path.join(f.sourceRoot,'a.md'),'已有材料说明缓存一致性与可靠恢复的用途，有完整分析证据。');const old=await f.create({includeIdentities:['a.md']}),oldId={batchId:old.batchId};await f.call('batches/startAnalysis',oldId);const ready=await waitFor(()=>f.call('batches/get',oldId),value=>value.analysisJob.status==='complete');
  await writeFile(path.join(f.sourceRoot,'b.md'),'新材料说明另一种索引维护用途，正在分析时允许保存已有审核。');const next=await f.create({includeIdentities:['b.md']}),nextId={batchId:next.batchId};await f.call('batches/startAnalysis',nextId);await waitFor(()=>Promise.resolve(pending.length),value=>value>0);
  await f.call('batches/pauseAnalysis',nextId);
  const reviewed=await f.call('batches/reviewItem',{...oldId,revision:ready.revision,reviewBasis:ready.sources[0].reviewBasis,sourceId:ready.sources[0].sourceId,action:'confirmPlan',name:'旧材料审核.md',category:''});assert.equal(reviewed.sources[0].selected,true);
  await assert.rejects(f.call('batches/confirmNewArchive',{...oldId,revision:reviewed.revision,writersPaused:true,requestId:'old-while-pausing',items:[{sourceId:reviewed.sources[0].sourceId,name:'旧材料审核.md',category:''}]}),{code:'BATCH_BUSY'});
  release();await waitFor(()=>f.call('batches/get',nextId),value=>value.analysisJob.status==='paused');assert.match(await readFile(path.join(f.sourceRoot,'a.md'),'utf8'),/已有材料/);
 }finally{release();}
});
test('正文基线变化撤销选择和执行授权，保留已确认名并拒绝旧依据再次授权',async t=>{
 const f=await fixture(t,async(_,request)=>answer(request)),file=path.join(f.sourceRoot,'a.md');await writeFile(file,'正文说明缓存一致性与失败恢复的用途，给出明确的核验证据。');
 const batch=await f.create(),id={batchId:batch.batchId};await f.call('batches/startAnalysis',id);const ready=await waitFor(()=>f.call('batches/get',id),value=>value.analysisJob.status==='complete'),source=ready.sources[0];
 const reviewed=await f.call('batches/reviewItem',{...id,revision:ready.revision,reviewBasis:source.reviewBasis,sourceId:source.sourceId,action:'confirmPlan',name:'已确认.md',category:''});
 await writeFile(file,'新版正文讨论另一种用途，旧摘要分类不能代替新依据审核。');
 await assert.rejects(f.call('batches/reviewItem',{...id,revision:reviewed.revision,reviewBasis:reviewed.sources[0].reviewBasis,sourceId:source.sourceId,action:'confirmPlan',name:'已确认.md',category:''}),{code:'REVIEW_INVALIDATED'});
 const invalidated=await f.call('batches/get',id);assert.equal(invalidated.sources[0].selected,false);assert.equal(invalidated.sources[0].status,'needs-analysis');assert.equal(invalidated.sources[0].targetPath,undefined);assert.equal(invalidated.sources[0].confirmedName,'已确认.md');
 await assert.rejects(f.call('batches/reviewItem',{...id,revision:invalidated.revision,reviewBasis:source.reviewBasis,sourceId:source.sourceId,action:'confirmPlan',name:'已确认.md',category:''}),{code:'STALE_REVIEW'});
 assert.match(await readFile(file,'utf8'),/新版正文/);
});
