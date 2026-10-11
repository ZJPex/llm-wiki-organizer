import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../src/server.mjs';
import {createPlanningService} from '../src/planning.js';
import {listenForBrowser} from './helpers/http-server.js';
import {migrationFixture} from './helpers/migration-fixture.js';
import {createBatchService} from '../src/batches.js';
import {createInboxStrategy} from '../src/inbox.js';

async function fixture(t,generate){
 const root=await mkdtemp(path.join(os.tmpdir(),'concurrency-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const sourceRoot=path.join(root,'sources');await mkdir(sourceRoot);
 const configPath=path.join(root,'config.json');await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test',maxContextSize:1024}}));
 const stateDirectory=path.join(root,'state');
 const open=async()=>{const planning=createPlanningService({generate,stateDirectory});const server=createApp({planning});await listenForBrowser(server);t.after(()=>new Promise(resolve=>server.close(resolve)));const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session')).json();return async(route,input={},authenticated=true)=>{const response=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json',...(authenticated?{'X-Organizer-Token':token}:{})},body:JSON.stringify(input)});return {status:response.status,value:await response.json()};};};
 return {root,sourceRoot,configPath,stateDirectory,open,input:{sourceRoot,libraryPath:sourceRoot,configPath,identity:'long.md'}};
}
test('服务并发设置由会话保护、严格校验并跨重启持久化',async t=>{
 const f=await fixture(t),call=await f.open();
 assert.equal((await call('model-concurrency/get')).value.limit,3);
 assert.equal((await call('model-concurrency/set',{limit:5},false)).status,403);
 for(const limit of [0,-1,1.5,'4',null])assert.equal((await call('model-concurrency/set',{limit})).status,400);
 assert.equal((await call('model-concurrency/set',{limit:5})).value.limit,5);
 assert.equal((await(await f.open())('model-concurrency/get')).value.limit,5);
});
test('后台暂停立即停止新分段与分类，等待在途归零后才可归档',async t=>{
 const f=await migrationFixture(t),sourceRoot=path.join(f.root,'inbox'),artifactRoot=path.join(f.root,'artifacts');await mkdir(sourceRoot);await mkdir(artifactRoot);
 await writeFile(path.join(sourceRoot,'long.md'),'缓存一致性与故障恢复。'.repeat(180));const configPath=path.join(f.root,'config.json');await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test',maxContextSize:1024}}));
 const calls=[],pending=[];let released=false;
 const planning=createPlanningService({stateDirectory:path.join(f.root,'planning'),generate:async(_,req)=>{calls.push(req);if(!released)await new Promise(resolve=>pending.push(resolve));return {title:'缓存一致性',summary:req.content.slice(0,30),evidence:[req.content.slice(0,20)],uncertain:false};}});
 const batches=createBatchService({planning,stateDirectory:path.join(f.root,'batches'),strategies:{inbox:createInboxStrategy()}}),server=createApp({planning,batches});await listenForBrowser(server);
 const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session')).json();const call=async(action,input)=>{const response=await fetch(base+'/api/batches/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)});return {status:response.status,value:await response.json()};};
 try{
 const created=(await call('create',{mode:'inbox',sourceRoot,artifactRoot,configPath,libraryPath:f.backup.originalPath,wikiSourcePath:path.join(f.root,'upstream')})).value,id={batchId:created.batchId};await call('startAnalysis',id);await waitFor(()=>calls.length===3);
 const pausing=(await call('pauseAnalysis',id)).value;assert.equal(pausing.analysisJob.status,'pausing');assert.equal(pausing.analysisJob.boundary,'model-request');
 assert.equal((await call('prepareSlice',{...id,revision:pausing.revision,writersPaused:true})).value.code,'BATCH_BUSY');
 released=true;pending.forEach(resolve=>resolve());let paused;
 for(let i=0;i<100;i++){paused=(await call('get',id)).value;if(paused.analysisJob.status==='paused')break;await delay(10);}
 assert.equal(paused.analysisJob.status,'paused');assert.equal(calls.length,3);assert.equal(paused.analysisProgress.failed,0);assert.equal(paused.modelConcurrency.active,0);
 }finally{released=true;pending.forEach(resolve=>resolve());await new Promise(resolve=>server.close(resolve));}
});
async function waitFor(predicate){for(let i=0;i<150;i++){if(predicate())return;await delay(10);}throw new Error('等待模型请求超时');}
test('HTTP 长文分段和同轮汇总重叠、动态调速且乱序仍完整归位',async t=>{
 const calls=[],pending=[];let released=false,active=0,peak=0;
 const generate=async(_,request)=>{active++;peak=Math.max(peak,active);calls.push(request);if(!released)await new Promise(resolve=>pending.push({request,resolve}));active--;return {title:'缓存一致性',summary:request.content.slice(0,30),evidence:[request.content.slice(0,20)],uncertain:false};};
 const f=await fixture(t,generate),call=await f.open(),content=Array.from({length:9},(_,i)=>`第${i}段缓存一致性`+'原'.repeat(248)).join('');
 await writeFile(path.join(f.sourceRoot,'long.md'),content);t.after(()=>{released=true;pending.forEach(p=>p.resolve());});
 await call('model-concurrency/set',{limit:1});const result=call('planning/analyze',f.input);
 try{
 await waitFor(()=>pending.length===1);await call('model-concurrency/set',{limit:3});await waitFor(()=>pending.length===3);
 const lowered=await call('model-concurrency/set',{limit:1});assert.equal(lowered.value.active,3);assert.equal(lowered.value.converging,true);
 pending[2].resolve();pending[1].resolve();await delay(30);assert.equal(calls.length,3);
 await call('model-concurrency/set',{limit:3});pending[0].resolve();
 await waitFor(()=>pending.length===6);pending.slice(3).reverse().forEach(p=>p.resolve());
 await waitFor(()=>pending.length===9);pending.slice(6).reverse().forEach(p=>p.resolve());
 await waitFor(()=>pending.filter(p=>p.request.stage==='synthesis').length===3);
 assert.equal(calls.filter(r=>r.stage==='segment').length,9);assert.equal(calls.filter(r=>r.stage==='synthesis').length,3);
 released=true;pending.slice(9).reverse().forEach(p=>p.resolve());
 const answer=await result;assert.equal(answer.status,200);assert.equal(peak,3);
 assert.equal(answer.value.segments.map(s=>content.slice(s.start,s.end)).join(''),content);
 assert.equal(answer.value.segments[0].summary,content.slice(0,30));
 assert.equal(calls.length,13);assert.equal(answer.value.suggestion,'缓存一致性.md');
 }finally{released=true;pending.forEach(p=>p.resolve());await result;}
});
test('不同知识库、API 与 CLI 配置的公开入口共享占位，审核保存不等待另篇模型',async t=>{
 const pending=[],providers=[];let block=false,released=false,active=0,peak=0;
 const f=await fixture(t,async(config,req)=>{active++;peak=Math.max(peak,active);providers.push(config.provider);if(block&&!released)await new Promise(resolve=>pending.push(resolve));active--;return {title:'缓存一致性',summary:req.content.slice(0,30),evidence:[req.content.slice(0,20)],uncertain:false};}),call=await f.open();
 await writeFile(path.join(f.sourceRoot,'short.md'),'这份正文讨论缓存一致性与故障恢复，核对索引维护过程中需要遵守的数据边界。');await call('planning/analyze',{...f.input,identity:'short.md'});
 const second=path.join(f.root,'second');await mkdir(second);const cliConfig=path.join(f.root,'cli.json');await writeFile(cliConfig,JSON.stringify({llmConfig:{provider:'codex-cli',model:'test',maxContextSize:1024}}));
 for(const root of [f.sourceRoot,second])await writeFile(path.join(root,'long.md'),'全文讨论缓存一致性与故障恢复。'.repeat(100));
 block=true;const first=call('planning/analyze',f.input),other=call('planning/analyze',{sourceRoot:second,libraryPath:second,identity:'long.md',configPath:cliConfig});
 try{await waitFor(()=>pending.length===3);const snapshot=(await call('model-concurrency/get')).value;assert.equal(snapshot.active,3);
 const confirmed=await Promise.race([call('planning/confirm',{...f.input,identity:'short.md',name:'人工名称.md'}),delay(1000).then(()=>({status:'timeout'}))]);assert.equal(confirmed.status,200);
 released=true;pending.reverse().forEach(resolve=>resolve());assert.equal((await first).status,200);assert.equal((await other).status,200);assert.equal(peak,3);assert.ok(providers.includes('codex-cli')&&providers.includes('custom'));
 const listed=(await call('planning/list',f.input)).value;assert.equal(listed.entries['short.md'].confirmedName,'人工名称.md');assert.ok(listed.entries['long.md'].analysis);
 }finally{released=true;pending.forEach(resolve=>resolve());await Promise.all([first,other]);}
});
