import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {migrationFixture} from './helpers/migration-fixture.js';

async function child(t,root,blockAt=0){
 const process=fork(new URL('./helpers/background-server.mjs',import.meta.url),[root,String(blockAt)],{stdio:['ignore','ignore','pipe','ipc']});
 let errors='';process.stderr.on('data',bytes=>{errors+=bytes;});
 const base=await new Promise((resolve,reject)=>{process.on('message',value=>{if(value.base)resolve(value.base);});process.once('exit',code=>reject(new Error(`子进程退出 ${code}: ${errors}`)));});
 const stop=async()=>{if(process.exitCode!==null||process.signalCode!==null)return;const closed=once(process,'exit');process.kill();await closed;};t.after(stop);
 const request=async(action,input)=>{const {token}=await(await fetch(base+'/api/session')).json();const response=await fetch(base+'/api/batches/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)});const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error),result);return result;};
 return {request,stop,release:()=>process.send('release')};
}
async function waitFor(read,predicate){let last;for(let attempt=0;attempt<200;attempt++){const value=await read();last=value;if(predicate(value))return value;await delay(25);}throw new Error('等待后台状态超时 '+JSON.stringify(last?.analysisJob??last));}
async function fixture(t){const f=await migrationFixture(t),sourceRoot=path.join(f.root,'inbox'),artifactRoot=path.join(f.root,'artifacts');await mkdir(sourceRoot);await mkdir(artifactRoot);for(const name of ['a','b','c'])await writeFile(path.join(sourceRoot,name+'.md'),`${name}：这份材料讨论缓存一致性、索引维护与失败恢复。`);const configPath=path.join(f.root,'config.json');await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'fixed-test'}}));return {...f,input:{mode:'inbox',libraryPath:f.backup.originalPath,sourceRoot,artifactRoot,configPath,wikiSourcePath:path.join(f.root,'upstream')}};}
const calls=async root=>(await readFile(path.join(root,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);

test('HTTP 后台作业脱离页面、并发启动幂等、知识库互斥、请求边界暂停继续',async t=>{
 const f=await fixture(t),server=await child(t,f.root,1),request=server.request;
 const batch=await request('create',f.input),id={batchId:batch.batchId};
 await Promise.all(Array.from({length:6},()=>request('startAnalysis',id)));
 await waitFor(()=>request('get',id),value=>value.flow.analysisCurrent?.stage==='segment');
 const another=await request('create',f.input);
 await assert.rejects(request('startAnalysis',{batchId:another.batchId}),{code:'BATCH_BUSY'});
 const live=await request('get',id);await assert.rejects(request('analyzeNext',{...id,revision:live.revision}),{code:'BATCH_BUSY'});
 const pausing=await request('pauseAnalysis',id);assert.equal(pausing.analysisJob.status,'pausing');assert.equal(pausing.analysisJob.boundary,'model-request');
 server.release();const paused=await waitFor(()=>request('get',id),value=>value.analysisJob.status==='paused');assert.equal(paused.analysisProgress.remaining,2);assert.equal((await calls(f.root)).length,1);
 await request('continueAnalysis',id);
 // 不再轮询或保持页面请求，服务自行处理后续材料。
 await delay(700);
 const complete=await waitFor(()=>request('get',id),value=>value.analysisJob.status==='complete');assert.equal(complete.analysisProgress.remaining,0);assert.equal((await calls(f.root)).length,3);
 if(complete.sources.every(source=>source.classification)){const modelCalls=(await readFile(path.join(f.root,'model-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(modelCalls.filter(value=>value.stage==='category-choice').length,3);}
 await request('startAnalysis',id);await waitFor(()=>request('get',id),value=>value.analysisJob.status==='complete');assert.equal((await calls(f.root)).length,3);
 await writeFile(path.join(f.input.sourceRoot,'a.md'),'更新材料：这一版重新解释缓存一致性的完整边界。');await request('startAnalysis',id);await waitFor(()=>request('get',id),value=>value.analysisJob.status==='complete');const revised=await calls(f.root);assert.equal(revised.filter(value=>value.identity==='a.md').length,2);assert.equal(revised.length,4);
});

test('真实进程中断后等待手动继续，复用第一份有效结果并标记在途材料',async t=>{
 const f=await fixture(t),first=await child(t,f.root,2),batch=await first.request('create',f.input),id={batchId:batch.batchId};await first.request('startAnalysis',id);
 await waitFor(()=>first.request('get',id),value=>value.flow.analysisCurrent?.identity==='b.md'&&value.flow.analysisCurrent.stage==='segment');await waitFor(()=>calls(f.root),value=>value.length===2);await first.stop();
 const second=await child(t,f.root),interrupted=await second.request('get',id);assert.equal(interrupted.analysisJob.status,'interrupted');assert.ok(interrupted.analysisJob.uncertainSourceId);assert.deepEqual(interrupted.analysisJob.allowedActions,['continueAnalysis']);
 await delay(200);assert.equal((await calls(f.root)).length,2);
 await second.request('continueAnalysis',id);await waitFor(()=>second.request('get',id),value=>value.analysisJob.status==='complete');const records=await calls(f.root);assert.equal(records.filter(value=>value.identity==='a.md').length,1);assert.equal(records.filter(value=>value.identity==='c.md').length,1);
});

test('首次重构公开启动入口同样由服务分析',async t=>{
 const f=await fixture(t),server=await child(t,f.root),batch=await server.request('create',{...f.input,mode:'restructure',sourceRoot:path.join(f.input.libraryPath,'raw/sources')});await server.request('startAnalysis',{batchId:batch.batchId});const result=await waitFor(()=>server.request('get',{batchId:batch.batchId}),value=>value.analysisJob.status==='complete');assert.equal(result.analysisProgress.remaining,0);assert.ok(result.analysisProgress.total>0);
});
