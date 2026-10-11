import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {migrationFixture} from './helpers/migration-fixture.js';
async function fixture(t){const f=await migrationFixture(t),sourceRoot=path.join(f.root,'inbox'),artifactRoot=path.join(f.root,'artifacts');await mkdir(sourceRoot);await mkdir(artifactRoot);const content=Array.from({length:6},(_,i)=>`缓存一致性段${i}`+'原'.repeat(248)).join('');await writeFile(path.join(sourceRoot,'long.md'),content);const configPath=path.join(f.root,'config.json');await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'version-one',apiKey:'private-marker',maxContextSize:1024}}));return {...f,input:{mode:'inbox',libraryPath:f.backup.originalPath,sourceRoot,artifactRoot,configPath,wikiSourcePath:path.join(f.root,'upstream')}};}
async function child(t,root,blockAt=0){const process=fork(new URL('./helpers/checkpoint-server.mjs',import.meta.url),[root,String(blockAt)],{stdio:['ignore','ignore','pipe','ipc']});let errors='';process.stderr.on('data',value=>errors+=value);const base=await new Promise((resolve,reject)=>{process.on('message',value=>resolve(value.base));process.once('exit',code=>reject(new Error(`服务退出 ${code}：${errors}`)));});const stop=async()=>{if(process.exitCode!==null||process.signalCode!==null)return;const closed=once(process,'exit');process.kill();await closed;};t.after(stop);const call=async(route,input={})=>{const {token}=await(await fetch(base+'/api/session')).json();const response=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)});const answer=await response.json();if(!response.ok)throw Object.assign(new Error(answer.error),answer);return answer;};return {call,stop,release:()=>process.send('release')};}
async function waitFor(read,predicate){for(let i=0;i<200;i++){const value=await read();if(predicate(value))return value;await delay(15);}throw new Error('等待检查点超时');}
const calls=async root=>(await readFile(path.join(root,'checkpoint-calls.jsonl'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;})).trim().split('\n').filter(Boolean).map(JSON.parse);
test('部分分段成功后真实服务退出，重启不调用且重复继续仅补未完成分段',async t=>{
 const f=await fixture(t),first=await child(t,f.root,2);await first.call('model-concurrency/set',{limit:1});const batch=await first.call('batches/create',f.input),id={batchId:batch.batchId};await first.call('batches/startAnalysis',id);
 await waitFor(()=>first.call('batches/get',id),value=>value.flow.analysisCurrent?.completed===1);const before=await calls(f.root);assert.equal(before.length,2);await first.stop();
 const second=await child(t,f.root),interrupted=await second.call('batches/get',id);assert.equal(interrupted.analysisJob.status,'interrupted');await delay(100);assert.equal((await calls(f.root)).length,2);
 await Promise.all(Array.from({length:4},()=>second.call('batches/continueAnalysis',id)));const complete=await waitFor(()=>second.call('batches/get',id),value=>value.analysisJob.status==='complete');assert.equal(complete.sources[0].suggestion,'缓存一致性.md');
 const all=await calls(f.root);assert.equal(all.filter(call=>call.contentHash===before[0].contentHash&&call.stage==='segment').length,1);assert.equal(all.filter(call=>call.stage==='segment').length,7);
 const state=await second.call('planning/list',{...f.input});assert.ok(!JSON.stringify(state).includes('private-marker'));
});
test('仅修改额度复用全文，模型配置与原文变化重算且保留人工名称',async t=>{
 const f=await fixture(t),server=await child(t,f.root),batch=await server.call('batches/create',f.input),id={batchId:batch.batchId};
 const complete=async()=>{await server.call('batches/startAnalysis',id);return waitFor(()=>server.call('batches/get',id),value=>value.analysisJob.status==='complete');};
 let result=await complete(),count=(await calls(f.root)).length;
 result=await server.call('batches/confirmPlans',{...id,revision:result.revision,items:[{sourceId:result.sources[0].sourceId,name:'人工名称.md',category:'',manuallyEdited:true}]});
 await server.call('model-concurrency/set',{limit:1});await complete();assert.equal((await calls(f.root)).length,count);
 await writeFile(f.input.configPath,JSON.stringify({llmConfig:{provider:'custom',model:'version-two',apiKey:'private-marker',maxContextSize:1024}}));
 result=await complete();const changed=await calls(f.root);assert.equal(changed.filter(call=>call.stage==='segment'&&call.model==='version-two').length,6);assert.equal(result.sources[0].confirmedName,'人工名称.md');assert.equal(result.sources[0].selected,false);
 count=changed.length;await writeFile(path.join(f.input.sourceRoot,'long.md'),'新版正文讨论缓存一致性，修订输入并核对失败恢复的证据。');result=await complete();assert.ok((await calls(f.root)).length>count);assert.equal(result.sources[0].confirmedName,'人工名称.md');
});
test('汇总成功后进程中断，继续复用全部分段和同轮成功汇总',async t=>{
 const f=await fixture(t),first=await child(t,f.root,8);await first.call('model-concurrency/set',{limit:1});const batch=await first.call('batches/create',f.input),id={batchId:batch.batchId};await first.call('batches/startAnalysis',id);
 await waitFor(()=>first.call('batches/get',id),value=>value.flow.analysisCurrent?.stage==='synthesis'&&value.flow.analysisCurrent.completed===1);const before=await calls(f.root);assert.equal(before.length,8);await first.stop();
 const second=await child(t,f.root);await second.call('batches/continueAnalysis',id);await waitFor(()=>second.call('batches/get',id),value=>value.analysisJob.status==='complete');const after=await calls(f.root);
 assert.equal(after.filter(call=>call.stage==='segment').length,6);assert.equal(after.filter(call=>call.stage==='synthesis'&&call.contentHash===before[6].contentHash).length,1);assert.equal(after.filter(call=>call.stage==='synthesis').length,4);
});
test('暂停等待在途分段落盘再归零，继续补齐余段而不重跑成功段',async t=>{
 const f=await fixture(t),server=await child(t,f.root,1);await server.call('model-concurrency/set',{limit:1});const batch=await server.call('batches/create',f.input),id={batchId:batch.batchId};await server.call('batches/startAnalysis',id);await waitFor(()=>calls(f.root),value=>value.length===1);
 assert.equal((await server.call('batches/pauseAnalysis',id)).analysisJob.status,'pausing');await delay(30);assert.equal((await server.call('batches/get',id)).analysisJob.status,'pausing');server.release();await waitFor(()=>server.call('batches/get',id),value=>value.analysisJob.status==='paused');assert.equal((await calls(f.root)).length,1);
 const saved=await server.call('planning/list',f.input);assert.equal(Object.keys(saved.checkpoints['long.md'].results).length,1);
 await server.call('batches/continueAnalysis',id);await waitFor(()=>server.call('batches/get',id),value=>value.analysisJob.status==='complete');assert.equal((await calls(f.root)).filter(call=>call.stage==='segment').length,6);
});
test('模型配置变化时旧在途结果迟到，不能覆盖新配置结果',async t=>{
 const f=await fixture(t),server=await child(t,f.root,1),input={...f.input,identity:'long.md'};const old=server.call('planning/analyze',input).then(value=>({value}),error=>({error}));await waitFor(()=>calls(f.root),value=>value.length>=1);
 await writeFile(f.input.configPath,JSON.stringify({llmConfig:{provider:'custom',model:'version-two',apiKey:'private-marker',maxContextSize:1024}}));const current=await server.call('planning/analyze',input);server.release();assert.ok((await old).error);
 const listed=await server.call('planning/list',input);assert.deepEqual(listed.entries['long.md'].analysisVersion,current.analysisVersion);assert.equal(listed.entries['long.md'].suggestion,'缓存一致性.md');assert.ok(!JSON.stringify(listed).includes('private-marker'));
});
for(const oldFormat of ['missing-version','old-rules'])test(`旧缓存 ${oldFormat} 保守重算，保留已确认名称及无关执行证据`,async t=>{
 const f=await fixture(t),first=await child(t,f.root),input={...f.input,identity:'long.md'};await first.call('planning/analyze',input);await first.call('planning/confirm',{...input,name:'人工确认.md'});const count=(await calls(f.root)).length;await first.stop();
 const file=path.join(f.root,'planning',(await readdir(path.join(f.root,'planning'))).find(name=>/^[0-9a-f]{64}\.json$/.test(name))),saved=JSON.parse(await readFile(file,'utf8'));if(oldFormat==='missing-version'){delete saved.entries['long.md'].analysisVersion;delete saved.checkpoints;}else{saved.entries['long.md'].analysisVersion.rules='previous-rules';saved.checkpoints['long.md'].analysisVersion.rules='previous-rules';}saved.entries['retained.md']={executionId:'completed-archive',confirmedName:'历史确认.md',frozenPlan:{planHash:'existing-proof'}};await writeFile(file,JSON.stringify(saved));
 const second=await child(t,f.root),result=await second.call('planning/analyze',input);assert.equal(result.confirmedName,'人工确认.md');assert.equal((await calls(f.root)).length-count,9);const listed=await second.call('planning/list',input);assert.equal(listed.entries['retained.md'].executionId,'completed-archive');assert.equal(listed.entries['retained.md'].frozenPlan.planHash,'existing-proof');
});
