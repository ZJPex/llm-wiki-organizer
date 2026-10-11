import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../src/server.mjs';
import {createPlanningService} from '../src/planning.js';
import {listenForBrowser} from './helpers/http-server.js';
import {migrationFixture} from './helpers/migration-fixture.js';
import {createBatchService} from '../src/batches.js';
import {createInboxStrategy} from '../src/inbox.js';
import {createWorkspaceService} from '../src/workspace.js';

const answer=request=>request.stage==='category-search'?{candidates:['']}:request.stage==='category-choice'?{category:'',reason:'正文主用途',evidence:request.content.evidence,uncertain:false}:{title:'缓存恢复',summary:request.content.slice(0,30),evidence:[request.content.slice(0,20)],uncertain:false};
async function waitFor(read,predicate){let value;for(let attempt=0;attempt<250;attempt++){value=await read();if(predicate(value))return value;await delay(10);}throw new Error('等待公开状态超时 '+JSON.stringify(value));}
async function fixture(t,respond,{batch=false}={}){
 const cleanups=[],migration=batch?await migrationFixture({after:callback=>cleanups.push(callback)}):null,root=migration?.root??await mkdtemp(path.join(os.tmpdir(),'model-failure-')),servers=[];
 t.after(async()=>{for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(migration){for(const cleanup of cleanups)await cleanup();}else await rm(root,{recursive:true,force:true});});
 const calls=[];let active=0,peak=0;
 const provider=http.createServer(async(req,res)=>{active++;peak=Math.max(peak,active);try{let body='';for await(const part of req)body+=part;const payload=JSON.parse(body),request=JSON.parse(payload.messages[1].content);calls.push({model:payload.model,request,time:Date.now()});const result=await respond({model:payload.model,request,calls});res.writeHead(result?.status??200,{'Content-Type':'application/json',...result?.headers});res.end(JSON.stringify(result?.status?result.body??{error:{message:'secret-key-and-provider-response'}}:{choices:[{message:{content:JSON.stringify(answer(request))}}]}));}finally{active--;}});
 servers.push(provider);await listenForBrowser(provider);
 const sourceRoot=path.join(root,'sources');await mkdir(sourceRoot);const configPath=path.join(root,'config.json');
 const config={llmConfig:{provider:'custom',model:'test',customEndpoint:`http://127.0.0.1:${provider.address().port}/v1`,apiKey:'private-key',maxContextSize:1024}};await writeFile(configPath,JSON.stringify(config));
 const planning=createPlanningService({stateDirectory:path.join(root,'planning')}),batches=batch?createBatchService({planning,stateDirectory:path.join(root,'batches'),strategies:{inbox:createInboxStrategy()}}):undefined,workspace=batch?createWorkspaceService({batches,stateDirectory:path.join(root,'settings')}):undefined,server=createApp({planning,batches,workspace});servers.push(server);await listenForBrowser(server);
 const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session')).json();
 const call=async(route,input={})=>{const response=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input),signal:AbortSignal.timeout(15000)});return {status:response.status,value:await response.json()};};
 const libraryInput=async()=>{const artifactRoot=path.join(root,'artifacts');await mkdir(artifactRoot,{recursive:true});return {sourceRoot,artifactRoot,configPath,libraryPath:migration.backup.originalPath,wikiSourcePath:path.join(root,'upstream')};};
 const createBatch=async()=>(await call('batches/create',{mode:'inbox',...await libraryInput()})).value;
 const createInbox=async()=>{const saved=(await call('workspace/save',await libraryInput())).value;return (await call('inbox/scan',{id:saved.id})).value;};
 return {root,sourceRoot,configPath,config,calls,call,createBatch,createInbox,peak:()=>peak,input:{sourceRoot,libraryPath:sourceRoot,configPath,identity:'long.md'}};
}

test('真实 HTTP 429 有限退避释放共享额度，后续成功且重复分析复用结果',async t=>{
 let firstContent;
 const f=await fixture(t,({request,calls})=>{firstContent??=request.content;return request.content===firstContent&&calls.filter(call=>call.request.content===firstContent).length<3?{status:429,headers:{'Retry-After':'0.2'}}:undefined;});
 await writeFile(path.join(f.sourceRoot,'long.md'),Array.from({length:60},(_,index)=>`第${index}部分正文讨论缓存一致性、失败恢复与共享索引维护机制。`).join(''));
 await f.call('model-concurrency/set',{limit:1});const pending=f.call('planning/analyze',f.input);
 const waiting=await waitFor(()=>f.call('model-concurrency/get'),value=>value.value.retrying>0);
 assert.equal(waiting.value.active,0);assert.equal(waiting.value.rateLimited,true);
 const result=await pending;assert.equal(result.status,200);assert.equal(f.peak(),1);
 const attempts=f.calls.filter(call=>call.request.content===firstContent);assert.equal(attempts.length,3);assert.ok(attempts[1].time-attempts[0].time>=150);
 assert.equal((await f.call('model-concurrency/get')).value.retrying,0);
 const count=f.calls.length;assert.equal((await f.call('planning/analyze',f.input)).value.reused,true);assert.equal(f.calls.length,count);
 assert.doesNotMatch(JSON.stringify(result.value),/private-key|secret-key-and-provider-response|127\.0\.0\.1/);
});

test('局部分段有限重试耗尽后文章失败、其他文章可审核，手动重试仅补检查点缺口',async t=>{
 let broken=true,badContent;
 const f=await fixture(t,({request})=>{if(request.identity==='a-long.md'&&request.stage==='segment'){badContent??=request.content;if(broken&&request.content===badContent)return {status:503};}}, {batch:true});
 await writeFile(path.join(f.sourceRoot,'a-long.md'),Array.from({length:60},(_,index)=>`第${index}段缓存一致性与失败恢复，详细说明索引维护。`).join(''));
 await writeFile(path.join(f.sourceRoot,'b-short.md'),'正文说明缓存一致性与故障恢复，结合索引维护解释其学习用途和方法。');
 const batch=await f.createBatch(),id={batchId:batch.batchId};await f.call('model-concurrency/set',{limit:2});await f.call('batches/startAnalysis',id);
 const ended=await waitFor(()=>f.call('batches/get',id),value=>value.value.analysisJob.status==='failed');
 assert.equal(ended.value.sources.find(source=>source.identity==='a-long.md').status,'analysis-failed');assert.equal(ended.value.sources.find(source=>source.identity==='b-short.md').classification.category,'');
 assert.equal(ended.value.analysisJob.inFlight,0);assert.equal(f.calls.filter(call=>call.request.content===badContent).length,3);assert.equal(ended.value.analysisJob.error.code,'MODEL_TEMPORARY_FAILURE');
 const successful=f.calls.filter(call=>call.request.identity==='a-long.md'&&call.request.stage==='segment'&&call.request.content!==badContent).map(call=>call.request.content),before=f.calls.length;await delay(100);assert.equal(f.calls.length,before);
 broken=false;await Promise.all(Array.from({length:4},()=>f.call('batches/continueAnalysis',id)));
 const complete=await waitFor(()=>f.call('batches/get',id),value=>value.value.analysisJob.status==='complete');assert.equal(complete.value.sources.filter(source=>source.classification).length,2);
 for(const content of successful)assert.equal(f.calls.filter(call=>call.request.content===content).length,1);
 assert.equal(f.calls.filter(call=>call.request.content===badContent).length,4);assert.ok(f.peak()<=2);
});

test('真实 HTTP 鉴权公共故障停止同配置排队请求，其他配置继续且公开错误不泄密',async t=>{
 const f=await fixture(t,({model})=>model==='test'?{status:401}:undefined);
 const content=Array.from({length:50},(_,index)=>`第${index}段正文说明缓存一致性与失败恢复，保护共享索引。`).join('');
 await writeFile(path.join(f.sourceRoot,'long.md'),content);await writeFile(path.join(f.sourceRoot,'other.md'),content);
 const otherConfig=path.join(f.root,'other-config.json');await writeFile(otherConfig,JSON.stringify({llmConfig:{...f.config.llmConfig,model:'healthy'}}));
 await f.call('model-concurrency/set',{limit:1});
 const [failed,healthy]=await Promise.all([f.call('planning/analyze',f.input),f.call('planning/analyze',{...f.input,identity:'other.md',configPath:otherConfig})]);
 assert.equal(failed.status,400);assert.match(failed.value.error,/鉴权/);assert.equal(healthy.status,200);
 assert.equal(f.calls.filter(call=>call.model==='test').length,1);assert.ok(f.calls.some(call=>call.model==='healthy'));
 const ended=await f.call('model-concurrency/get');assert.equal(ended.value.active,0);assert.equal(ended.value.queued,0);assert.equal(ended.value.modelFaults[0].code,'MODEL_AUTH_FAILED');
 assert.doesNotMatch(JSON.stringify([failed.value,ended.value]),/private-key|secret-key-and-provider-response|127\.0\.0\.1/);
});

test('文章终止错误立即取消自身排队分段，但保存已发出成功段并继续其他文章',async t=>{
 let badContent,broken=true;
 const f=await fixture(t,async({request})=>{if(request.identity==='a-long.md'&&request.stage==='segment'){badContent??=request.content;if(broken&&request.content===badContent)return {status:400};if(broken)await delay(100);}},{batch:true});
 await writeFile(path.join(f.sourceRoot,'a-long.md'),Array.from({length:100},(_,index)=>`第${index}段缓存一致性与失败恢复，详细说明索引维护。`).join(''));await writeFile(path.join(f.sourceRoot,'b-short.md'),'正文说明缓存一致性与故障恢复，结合索引维护解释其学习用途和方法。');
 const batch=await f.createBatch(),id={batchId:batch.batchId};await f.call('model-concurrency/set',{limit:2});await f.call('batches/startAnalysis',id);
 const failed=await waitFor(()=>f.call('batches/get',id),value=>value.value.analysisJob.status==='failed');assert.equal(failed.value.sources.find(source=>source.identity==='b-short.md').classification.category,'');
 const started=f.calls.filter(call=>call.request.identity==='a-long.md');assert.equal(started.length,2);const saved=started.find(call=>call.request.content!==badContent).request.content;
 broken=false;await f.call('batches/continueAnalysis',id);await waitFor(()=>f.call('batches/get',id),value=>value.value.analysisJob.status==='complete');assert.equal(f.calls.filter(call=>call.request.content===saved).length,1);
});

test('公共鉴权故障等待用户手动恢复，重复继续只重新派发一次',async t=>{
 let unavailable=true;const f=await fixture(t,()=>unavailable?{status:401}:undefined,{batch:true});
 await writeFile(path.join(f.sourceRoot,'source.md'),'正文说明缓存一致性与故障恢复，结合索引维护解释其学习用途和方法。');const batch=await f.createBatch(),id={batchId:batch.batchId};await f.call('batches/startAnalysis',id);
 const failed=await waitFor(()=>f.call('batches/get',id),value=>value.value.analysisJob.status==='failed');assert.equal(failed.value.analysisJob.error.code,'MODEL_AUTH_FAILED');const count=f.calls.length;await delay(100);assert.equal(f.calls.length,count);
 unavailable=false;await Promise.all(Array.from({length:4},()=>f.call('batches/continueAnalysis',id)));
 const completed=await waitFor(()=>f.call('batches/get',id),value=>value.value.analysisJob.status!=='running');assert.equal(completed.value.analysisJob.status,'complete');assert.equal(f.calls.filter(call=>call.request.stage==='segment').length,2);
});

test('退避到期前暂停不得发出重试，手动继续以新的有限尝试补齐',async t=>{
 let unavailable=true;const f=await fixture(t,()=>unavailable?{status:503}:undefined,{batch:true});
 await writeFile(path.join(f.sourceRoot,'source.md'),'正文说明缓存一致性与故障恢复，结合索引维护解释其学习用途和方法。');const batch=await f.createBatch(),id={batchId:batch.batchId};await f.call('batches/startAnalysis',id);
 await waitFor(()=>f.call('model-concurrency/get'),value=>value.value.retrying===1);const paused=await f.call('batches/pauseAnalysis',id);assert.equal(paused.value.analysisJob.status,'pausing');
 await waitFor(()=>f.call('batches/get',id),value=>value.value.analysisJob.status==='paused');assert.equal(f.calls.length,1);assert.equal((await f.call('model-concurrency/get')).value.active,0);
 unavailable=false;await f.call('batches/continueAnalysis',id);const complete=await waitFor(()=>f.call('batches/get',id),value=>value.value.analysisJob.status==='complete');assert.equal(complete.value.sources[0].classification.category,'');assert.equal(f.calls.filter(call=>call.request.stage==='segment').length,2);
});

test('真实 HTTP 429 的明确额度故障直接停止该配置，不作限流重试',async t=>{
 const f=await fixture(t,()=>({status:429,body:{error:{code:'insufficient_quota',message:'private quota body'}}}));await writeFile(path.join(f.sourceRoot,'long.md'),Array.from({length:50},(_,index)=>`第${index}段缓存一致性与失败恢复，详细说明索引维护。`).join(''));
 await f.call('model-concurrency/set',{limit:1});const failed=await f.call('planning/analyze',f.input);assert.equal(failed.value.code,'MODEL_QUOTA_EXHAUSTED');assert.equal(f.calls.length,1);assert.doesNotMatch(JSON.stringify(failed.value),/private quota body/);
});

test('公开收件箱两个文件失败后只重试所选文件，未选失败保留且任务明确结束',async t=>{
 let broken=true;const f=await fixture(t,()=>broken?{status:400}:undefined,{batch:true});
 for(const name of ['first.md','second.md'])await writeFile(path.join(f.sourceRoot,name),name+'正文说明缓存一致性与故障恢复，结合索引维护解释其学习用途和方法。');
 const inbox=await f.createInbox(),id={id:inbox.libraryId};await f.call('inbox/start',{...id,itemIds:inbox.items.map(item=>item.itemId)});
 const failed=await waitFor(()=>f.call('inbox/list',id),value=>value.value.items.every(item=>item.status==='failed')),first=failed.value.items.find(item=>item.identity==='first.md');
 const unselectedCalls=f.calls.filter(call=>call.request.identity==='second.md').length;broken=false;await f.call('inbox/start',{...id,itemIds:[first.itemId]});
 const restored=await waitFor(()=>f.call('inbox/list',id),value=>value.value.items.find(item=>item.itemId===first.itemId).status==='reviewable');
 assert.equal(restored.value.items.find(item=>item.identity==='second.md').status,'failed');assert.equal(f.calls.filter(call=>call.request.identity==='second.md').length,unselectedCalls);
 const page=(await f.call('batches/list')).value,ended=await waitFor(()=>f.call('batches/get',{batchId:page.records[0].batchId}),value=>!['running','pausing'].includes(value.value.analysisJob.status));assert.equal(ended.value.analysisJob.status,'partial');assert.deepEqual(ended.value.analysisJob.sourceIds,[ended.value.sources.find(source=>source.identity==='first.md').sourceId]);assert.deepEqual(ended.value.analysisJob.allowedActions,['continueAnalysis']);
});
