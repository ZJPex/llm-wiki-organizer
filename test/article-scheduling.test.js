import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {migrationFixture} from './helpers/migration-fixture.js';
import {listenForBrowser} from './helpers/http-server.js';
import {createApp} from '../src/server.mjs';
import {createPlanningService} from '../src/planning.js';
import {createBatchService} from '../src/batches.js';
import {createInboxStrategy} from '../src/inbox.js';

async function waitFor(read,predicate){let value;for(let attempt=0;attempt<200;attempt++){value=await read();if(predicate(value))return value;await delay(10);}throw new Error('等待公开状态超时 '+JSON.stringify(value));}
async function fixture(t,generate){
 const f=await migrationFixture(t),planning=createPlanningService({stateDirectory:path.join(f.root,'planning'),generate});
 const batches=createBatchService({planning,stateDirectory:path.join(f.root,'batches'),strategies:{inbox:createInboxStrategy()}}),server=createApp({planning,batches});
 await listenForBrowser(server);t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session')).json();
 const call=async(route,input={})=>{const response=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)}),value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error),value);return value;};
 const library=async(files,{libraryPath=f.backup.originalPath,wikiSourcePath=path.join(f.root,'upstream')}={})=>{
  const sourceRoot=path.join(f.root,'inbox-'+Math.random()),artifactRoot=path.join(f.root,'artifacts-'+Math.random());await mkdir(sourceRoot);await mkdir(artifactRoot);
  for(const [name,text] of Object.entries(files))await writeFile(path.join(sourceRoot,name),text);
  const configPath=path.join(f.root,'config.json');await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test',maxContextSize:1024}}));
  return call('batches/create',{mode:'inbox',sourceRoot,artifactRoot,configPath,libraryPath,wikiSourcePath});
 };
 return {call,library,root:f.root};
}
const answer=request=>request.stage==='category-search'?{candidates:['']}:request.stage==='category-choice'?{category:'',reason:'正文说明了缓存一致性用途',evidence:[request.content.evidence[0]],uncertain:false}:{title:'缓存资料',summary:request.content.slice(0,40),evidence:[request.content.slice(0,20)],uncertain:false};

test('公开后台多篇公平推进，短文完成立即可审核而长文仍在处理，全局额度不相乘',async t=>{
 const calls=[],blocked=[];let releaseAll=false,active=0,peak=0;
 const f=await fixture(t,async(_,request)=>{calls.push(request);active++;peak=Math.max(peak,active);if(request.stage==='segment'&&request.identity==='a-long.md'&&!releaseAll)await new Promise(resolve=>blocked.push(resolve));active--;return answer(request);});
 t.after(()=>{releaseAll=true;blocked.forEach(resolve=>resolve());});
 const batch=await f.library({'a-long.md':'长文说明缓存一致性、索引维护与恢复机制。'.repeat(100),'b-short.md':'短文说明缓存一致性、索引维护与恢复机制，给出明确的学习用途。'}),id={batchId:batch.batchId};
 await f.call('model-concurrency/set',{limit:2});await f.call('batches/startAnalysis',id);
 try{
  await waitFor(()=>f.call('batches/get',id),value=>value.modelConcurrency.queued===7);blocked[0]();
  await waitFor(()=>f.call('batches/get',id),value=>value.sources.find(source=>source.identity==='b-short.md')?.progress?.stage==='search'&&value.modelConcurrency.queued===6);blocked[1]();
  await waitFor(()=>f.call('batches/get',id),value=>value.sources.find(source=>source.identity==='b-short.md')?.progress?.stage==='choice'&&value.modelConcurrency.queued===5);blocked[2]();
  const partial=await waitFor(()=>f.call('batches/get',id),value=>value.sources.find(source=>source.identity==='b-short.md')?.classification);
  assert.equal(partial.analysisJob.status,'running');assert.equal(partial.sources.find(source=>source.identity==='a-long.md').analysis,undefined);
  assert.equal(partial.sources.find(source=>source.identity==='b-short.md').classification.category,'');
  assert.ok(partial.sources.find(source=>source.identity==='a-long.md').progress?.stage);
  assert.equal(peak,2);assert.ok(calls.some(request=>request.identity==='b-short.md'));
  releaseAll=true;blocked.forEach(resolve=>resolve());
  const complete=await waitFor(()=>f.call('batches/get',id),value=>value.analysisJob.status==='complete');
  assert.equal(complete.sources.filter(source=>source.classification).length,2);assert.equal(complete.analysisProgress.remaining,0);assert.equal(complete.modelConcurrency.active,0);
 }finally{releaseAll=true;blocked.forEach(resolve=>resolve());}
});

test('重新创建服务后首次读取批次就显示保存的并发额度，来源变化拒绝迟到建议',async t=>{
 let release,open=false;
 const generate=async(_,request)=>{if(!open&&request.stage==='segment')await new Promise(resolve=>{release=resolve;});return answer(request);};
 const f=await fixture(t,generate),batch=await f.library({'source.md':'正文说明缓存一致性、索引维护与失败恢复，提供可靠的分析证据。'}),id={batchId:batch.batchId};
 try{
  await f.call('model-concurrency/set',{limit:5});await f.call('batches/startAnalysis',id);
  await waitFor(()=>Promise.resolve(Boolean(release)),value=>value);
  await writeFile(path.join(batch.sourceRoot,'source.md'),'更新正文说明完全不同的主用途，旧分析不能成为当前建议。');open=true;release();
  const failed=await waitFor(()=>f.call('batches/get',id),value=>value.analysisJob.status==='failed');assert.equal(failed.sources[0].analysis,undefined);assert.equal(failed.sources[0].classification,undefined);
  const planning=createPlanningService({stateDirectory:path.join(f.root,'planning'),generate}),batches=createBatchService({planning,stateDirectory:path.join(f.root,'batches'),strategies:{inbox:createInboxStrategy()}}),server=createApp({planning,batches});
  await listenForBrowser(server);t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session')).json();
  const response=await fetch(base+'/api/batches/get',{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(id)}),restarted=await response.json();
  assert.equal(response.status,200);assert.equal(restarted.modelConcurrency.limit,5);assert.equal(restarted.analysisJob.inFlight,0);
 }finally{open=true;release?.();}
});

test('不同知识库公平共享额度，重复启动不增加请求，暂停一库不停止另一库且仍阻断归档',async t=>{
 const calls=[],pending=[];let open=false,active=0,peak=0;
 const f=await fixture(t,async(_,request)=>{calls.push(request);active++;peak=Math.max(peak,active);if(!open)await new Promise(resolve=>pending.push(resolve));active--;return answer(request);});
 t.after(()=>{open=true;pending.forEach(resolve=>resolve());});
 const text='正文详细说明缓存一致性、索引维护与失败恢复。'.repeat(70);
 const first=await f.library({'a.md':text,'b.md':text}),id={batchId:first.batchId};
 const other=await migrationFixture(t),second=await f.library({'c.md':text},{libraryPath:other.backup.originalPath,wikiSourcePath:path.join(other.root,'upstream')});
 try{
  await Promise.all(Array.from({length:4},()=>f.call('batches/startAnalysis',id)));await f.call('batches/startAnalysis',{batchId:second.batchId});
  await waitFor(()=>f.call('model-concurrency/get'),value=>value.active===3&&value.queued>6);
  let released=0;
  await waitFor(async()=>{if(pending[released])pending[released++]();return new Set(calls.filter(request=>request.stage==='segment').map(request=>request.identity)).size;},value=>value===3);
  const rival=await f.library({'a.md':text});await assert.rejects(f.call('batches/startAnalysis',{batchId:rival.batchId}),{code:'BATCH_BUSY'});
  const pause=await f.call('batches/pauseAnalysis',id);assert.equal(pause.analysisJob.status,'pausing');
  await assert.rejects(f.call('batches/prepareSlice',{...id,revision:pause.revision,writersPaused:true}),error=>['BATCH_BUSY','STALE_BATCH'].includes(error.code));
  const before=calls.filter(request=>['a.md','b.md'].includes(request.identity)).length;
  open=true;pending.forEach(resolve=>resolve());
  const paused=await waitFor(()=>f.call('batches/get',id),value=>value.analysisJob.status==='paused');
  const completed=await waitFor(()=>f.call('batches/get',{batchId:second.batchId}),value=>value.analysisJob.status==='complete');
  assert.equal(paused.analysisJob.inFlight,0);assert.equal(completed.sources[0].classification.category,'');assert.equal(peak,3);
  assert.equal(calls.filter(request=>['a.md','b.md'].includes(request.identity)).length,before);
 }finally{open=true;pending.forEach(resolve=>resolve());}
});
