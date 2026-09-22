import {listenForBrowser} from './helpers/http-server.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile,lstat} from 'node:fs/promises';
import {createInboxStrategy} from '../src/inbox.js';
import {createPlanningService} from '../src/planning.js';
import {migrationFixture} from './helpers/migration-fixture.js';
import {inventory} from '../src/compatibility.js';
import {preflight,digest} from '../src/compatibility.js';
import {createBatchService} from '../src/batches.js';
import {createApp} from '../src/server.mjs';
import {createBackup} from '../src/backup.js';
import {createMigrationService} from '../src/migration.js';
import {createRecoveryService} from '../src/recovery.js';
import {createOriginalExecutionService} from '../src/original-execution.js';
import {UPSTREAM_COMMIT,nativeRescanVerifier} from '../src/migration-verifier.js';

async function fixture(t,{autoIngest=true,checkpoint,internal=false,history=false}={}) {
 const f=await migrationFixture(t),libraryPath=f.backup.originalPath,sourceRoot=internal?path.join(libraryPath,'raw/sources/inbox'):path.join(f.root,'inbox');
 await mkdir(sourceRoot,{recursive:true});await mkdir(path.join(libraryPath,'raw/sources/001 缓存'));
 const text='# 缓存与索引\n缓存失效需要协调索引更新，使用完整哈希校验并保留失败现场，以便定位问题和重试恢复。';
 await writeFile(path.join(sourceRoot,'录屏.md'),text);
 const configPath=path.join(f.root,'app-state.json');await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test',customEndpoint:'https://example.invalid/v1'},sourceWatchConfig:{enabled:true,autoIngest}}));
 const wikiSourcePath=path.join(f.root,'upstream');await mkdir(path.join(wikiSourcePath,'src/lib'),{recursive:true});await writeFile(path.join(wikiSourcePath,'src/lib/source-watch-defaults.json'),JSON.stringify({enabled:true,autoIngest:true,includeExtensions:['md'],excludeExtensions:[],excludeDirs:[],excludeGlobs:[],maxFileSizeMb:100}));
 const calls=[];const planning=createPlanningService({stateDirectory:path.join(f.root,'planning'),generate:async(_config,request)=>{calls.push(request.stage);if(request.stage==='category-search')return {candidates:['001 缓存']};if(request.stage==='category-choice')return {category:'001 缓存',reason:'同一缓存主题',evidence:[request.content.evidence[0]],uncertain:false};if(request.stage==='evolution')return {canContain:false,parentAffected:false,operations:[{type:'add',parent:'',label:'一致性',files:history?['old.md']:[],problem:'当前分类过宽',benefit:'更容易定位一致性资料'}],reason:'新增必要分类'};return {title:'缓存一致性',summary:request.content,evidence:[request.content.slice(0,12)],uncertain:false};}});
 const strategy=createInboxStrategy({checkpoint}),batch={batchId:'inbox-fixture',libraryPath,sourceRoot,wikiSourcePath,configPath,artifactRoot:path.join(f.root,'artifacts')};await mkdir(batch.artifactRoot);
 const discovered=await strategy.discover({input:batch});Object.assign(batch,discovered);batch.sources=batch.sources.map((item,index)=>({...item,sourceId:`source-${index}`}));
 return {f,batch,planning,strategy,calls,text};
}
async function reviewed(value,{evolve=false}={}) {
 const {batch,planning,strategy}=value;const source=batch.sources[0];
 Object.assign(source,await strategy.analyze({batch,source,planning}));
 for(const input of [{action:'confirmName',name:'缓存一致性.md'},{action:'classify'},...(evolve?[{action:'evolve',category:''},{action:'confirmEvolution'}]:[]),{action:'confirmCategory',category:evolve?'002 一致性':'001 缓存'}]) {
  const patch=await strategy.review({batch,source,input,planning});Object.assign(source,patch.sourcePatch);Object.assign(batch.flow,patch.flowPatch);
 }
 const slice={sliceId:'slice-one',...await strategy.prepare({batch,selected:[source],planning})};return {source,slice};
}

test('批次 HTTP 批量推荐分类时可查询当前阶段，结果仅待审核且不会重复推荐',async t=>{
 const value=await fixture(t),{f,batch:input}=value;
 let batch,call,seen=[];
 const planning=createPlanningService({stateDirectory:path.join(f.root,'classify-planning'),generate:async(_,request)=>{
  if(request.stage.startsWith('category-') && (await call('get',{batchId:batch.batchId})).phase==='classification-running'){
   const live=await call('get',{batchId:batch.batchId});
   assert.equal(live.phase,'classification-running');assert.equal(live.interrupted,false);
   seen.push(live.flow.classificationCurrent.stage);
   assert.equal(live.classificationProgress.remaining,1);
  }
  if(request.stage==='category-search')return {candidates:['001 缓存']};
  if(request.stage==='category-choice')return {category:'001 缓存',reason:'缓存主题',evidence:[request.content.evidence[0]],uncertain:false};
  return {title:'缓存一致性',summary:'缓存主题',evidence:[request.content.slice(0,10)],uncertain:false};
 }});
 const server=createApp({batches:createBatchService({stateDirectory:path.join(f.root,'classify-batches'),planning,strategies:{inbox:value.strategy}})});
 await listenForBrowser(server);t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session')).json();
 call=async(action,input)=>{const response=await fetch(base+'/api/batches/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;};
 batch=await call('create',{...input,mode:'inbox'});
 batch=await call('analyzeNext',{batchId:batch.batchId,revision:batch.revision});
 batch=await call('reviewItem',{batchId:batch.batchId,revision:batch.revision,sourceId:batch.sources[0].sourceId,action:'confirmName',name:'缓存一致性.md'});
 batch=await call('classifyNext',{batchId:batch.batchId,revision:batch.revision});
 assert.deepEqual(seen,['search','choice']);assert.equal(batch.classificationProgress.remaining,0);assert.equal(batch.classificationProgress.completed,1);
 assert.equal(batch.sources[0].classification.category,'001 缓存');assert.equal(batch.sources[0].status,'classified');assert.equal(batch.sources[0].selected,false);
 assert.equal(batch.flow.classificationCurrent.status,'complete');
 batch=await call('classifyNext',{batchId:batch.batchId,revision:batch.revision});assert.equal(seen.length,2);
 assert.equal(await readFile(path.join(input.sourceRoot,'录屏.md'),'utf8'),value.text);
});

test('分析中公开读取分段进度，重分析仅处理指定的信息不足材料且不复用旧结果',async t=>{
 const value=await fixture(t),{batch:input,f}=value;
 let service,initial,calls=0,uncertain=true,observed=false;
 const planning=createPlanningService({stateDirectory:path.join(f.root,'progress-planning'),generate:async(_,request)=>{
  if(request.stage==='category-search')return {candidates:['001 缓存']};
  if(request.stage==='category-choice')return {category:'001 缓存',reason:'全文主题',evidence:request.content.evidence,uncertain:false};
  calls++;
  const live=await service.get({batchId:initial.batchId});
  assert.equal(live.phase,'analysis-running');assert.equal(live.interrupted,false);
  assert.equal(live.flow.analysisCurrent.stage,'segment');
  assert.equal(live.flow.analysisCurrent.step,1);assert.equal(live.flow.analysisCurrent.totalSteps,1);
  assert.ok(live.flow.analysisCurrent.startedAt);observed=true;
  return {title:'缓存一致性',summary:'缓存主题',evidence:[request.content.slice(0,10)],uncertain};
 }});
 service=createBatchService({stateDirectory:path.join(f.root,'progress-batches'),strategies:{inbox:value.strategy},planning});
 initial=await service.create({...input,mode:'inbox'});
 let result=await service.analyzeNext({batchId:initial.batchId,revision:initial.revision});
 assert.ok(observed);assert.equal(result.sources[0].status,'needs-information');assert.equal(result.flow.analysisCurrent.status,'complete');
 uncertain=false;
 result=await service.analyzeNext({batchId:result.batchId,revision:result.revision,sourceId:result.sources[0].sourceId,retryUncertain:true,limit:1});
 assert.equal(calls,2);assert.equal(result.sources[0].status,'classified');assert.equal(result.sources[0].suggestion,'缓存一致性.md');
 assert.equal(await readFile(path.join(input.sourceRoot,'录屏.md'),'utf8'),value.text);
});

for(const autoIngest of [true,false])test(`Inbox新材料按分析/名字/分类/归档推进，首次摄取开关=${autoIngest}且重启不重复归档`,async t=>{
 const value=await fixture(t,{autoIngest}),{batch,strategy,planning,calls,text}=value;
 const cacheBefore=await readFile(path.join(batch.libraryPath,'.llm-wiki/ingest-cache.json'),'utf8'),queueBefore=await readFile(path.join(batch.libraryPath,'.llm-wiki/ingest-queue.json'),'utf8');
 const {source,slice}=await reviewed(value);assert.deepEqual(calls,['segment','category-search','category-choice','category-search','category-choice']);assert.equal(slice.historicalRequest,null);
 const result=await strategy.archive({batch,slice,artifactDirectory:batch.artifactRoot});assert.equal(result.status,'complete',JSON.stringify(result.error));assert.equal(await readFile(source.targetPath,'utf8'),text);await assert.rejects(lstat(source.currentPath),{code:'ENOENT'});
 assert.deepEqual(result.newIngestRequests,[]);assert.equal(result.watchConfig.disposition,autoIngest?'awaiting-wiki-policy':'archived-without-ingest-request');
 assert.equal(await readFile(path.join(batch.libraryPath,'.llm-wiki/ingest-cache.json'),'utf8'),cacheBefore);assert.equal(await readFile(path.join(batch.libraryPath,'.llm-wiki/ingest-queue.json'),'utf8'),queueBefore);
 const repeated=await createInboxStrategy().archive({batch,slice,artifactDirectory:batch.artifactRoot});assert.equal(repeated.status,'complete');assert.equal(repeated.committedMappings.length,1);
});

test('Inbox必要局部演化先审核，新增归档不改变已确认名字',async t=>{
 const value=await fixture(t),{source,slice}=await reviewed(value,{evolve:true});assert.equal(slice.historicalRequest,null);assert.ok(source.targetPath.includes('002 一致性'));assert.equal(path.basename(source.targetPath),'缓存一致性.md');
 const result=await value.strategy.archive({batch:value.batch,slice,artifactDirectory:value.batch.artifactRoot});assert.equal(result.status,'complete',JSON.stringify(result.error));
});

test('Inbox拒绝未按顺序、重名、陈旧来源和设置变化，失败保留来源',async t=>{
 const value=await fixture(t),{batch,strategy,planning}=value;const source=batch.sources[0];
 await assert.rejects(strategy.review({batch,source,planning,input:{action:'classify'}}),/证据不足/);
 const {slice}=await reviewed(value);await writeFile(source.targetPath,'existing');let result=await strategy.archive({batch,slice,artifactDirectory:batch.artifactRoot});assert.equal(result.status,'failed');assert.equal(await readFile(source.targetPath,'utf8'),'existing');assert.equal(await readFile(source.currentPath,'utf8'),value.text);
 const stale=await fixture(t);const ready=await reviewed(stale);await writeFile(ready.source.currentPath,'changed');await assert.rejects(stale.strategy.prepare({batch:stale.batch,selected:[ready.source]}),/变化/);
 const settings=await fixture(t);const planned=await reviewed(settings);const config=JSON.parse(await readFile(settings.batch.configPath,'utf8'));config.sourceWatchConfig.autoIngest=false;await writeFile(settings.batch.configPath,JSON.stringify(config));result=await settings.strategy.archive({batch:settings.batch,slice:planned.slice,artifactDirectory:settings.batch.artifactRoot});assert.equal(result.error.code,'STALE_SETTINGS');await lstat(planned.source.currentPath);
});

test('Inbox复制后故障保留来源与可重放日志；历史阶段失败禁止提前归档新增',async t=>{
 const value=await fixture(t,{checkpoint:async stage=>{if(stage==='copied')throw new Error('模拟复制后退出');}}),{slice,source}=await reviewed(value);
 const failed=await value.strategy.archive({batch:value.batch,slice,artifactDirectory:value.batch.artifactRoot});assert.equal(failed.status,'failed');await lstat(source.currentPath);assert.equal(await readFile(source.targetPath,'utf8'),value.text);
 const continued=await createInboxStrategy().archive({batch:value.batch,slice,artifactDirectory:value.batch.artifactRoot});assert.equal(continued.status,'complete');await assert.rejects(lstat(source.currentPath),{code:'ENOENT'});
 const history=await fixture(t),ready=await reviewed(history);ready.slice.historicalRequest={mappings:[{from:'raw/sources/old.md',to:'raw/sources/new.md'}]};ready.slice.historicalResult={status:'failed'};
 const blocked=await history.strategy.archive({batch:history.batch,slice:ready.slice,artifactDirectory:history.batch.artifactRoot});assert.equal(blocked.error.code,'HISTORY_REQUIRED');await lstat(ready.source.currentPath);await assert.rejects(lstat(ready.source.targetPath),{code:'ENOENT'});
});

test('库内缺cache但已有待执行任务不能当新文件，外部同内容不猜历史',async t=>{
 const internal=await fixture(t,{internal:true});await writeFile(path.join(internal.batch.libraryPath,'.llm-wiki/ingest-queue.json'),JSON.stringify([{sourcePath:'raw/sources/inbox/录屏.md',status:'pending'}]));
 const found=await internal.strategy.discover({input:internal.batch});assert.equal(found.sources[0].ingestStatus,'uncertain');assert.equal(found.flow.busy,true);
 const external=await fixture(t);await writeFile(external.batch.sources[0].currentPath,'# 已摄取的短源');const outside=await external.strategy.discover({input:external.batch});assert.equal(outside.sources[0].ingestStatus,'new');
 await assert.rejects(external.strategy.discover({input:{...external.batch,sourceRoot:path.join(external.batch.libraryPath,'wiki')}}),{code:'INVALID_INBOX'});
 await assert.rejects(external.strategy.discover({input:{...external.batch,sourceRoot:external.f.root}}),{code:'INVALID_INBOX'});
});

test('冻结后新来源被摄取或新增关联，最终归档必须失效并保源',async t=>{
 for(const relation of ['cache','wiki'])await t.test(relation,async t=>{
  const value=await fixture(t,{internal:true}),{slice,source}=await reviewed(value),library=value.batch.libraryPath;
  if(relation==='cache'){const file=path.join(library,'.llm-wiki/ingest-cache.json'),cache=JSON.parse(await readFile(file,'utf8'));cache.entries['inbox/录屏.md']={hash:source.hash,timestamp:2,filesWritten:['wiki/new.md']};await writeFile(file,JSON.stringify(cache));}
  await writeFile(path.join(library,'wiki/new.md'),'---\nsources: ["inbox/录屏.md"]\n---\n新关联');
  const result=await value.strategy.archive({batch:value.batch,slice,artifactDirectory:value.batch.artifactRoot});assert.equal(result.status,'failed');assert.equal(result.error.code,'STALE_ASSOCIATION');await lstat(source.currentPath);await assert.rejects(lstat(source.targetPath),{code:'ENOENT'});
 });
});

test('新增归档遇本地图片、材料引用或未移动材料反链时明确保留，HTTP外链不阻塞',async t=>{
 for(const kind of ['image','html','outgoing','backlink','http'])await t.test(kind,async t=>{
  const value=await fixture(t),source=value.batch.sources[0];
  if(kind==='image'){await writeFile(path.join(value.batch.sourceRoot,'image.png'),'image');await writeFile(source.currentPath,value.text+'\n![图](image.png)');}
  if(kind==='html')await writeFile(source.currentPath,value.text+'\n<img src=image.png>');
  if(kind==='outgoing')await writeFile(source.currentPath,value.text+'\n[材料](other.md)');
  if(kind==='backlink')await writeFile(path.join(value.batch.sourceRoot,'other.md'),'[引用](录屏.md)');
  if(kind==='http')await writeFile(source.currentPath,value.text+'\n[网址](https://example.com/page)');
  source.hash=digest(await readFile(source.currentPath));
  if(kind==='http'){const {slice}=await reviewed(value);assert.equal((await value.strategy.archive({batch:value.batch,slice,artifactDirectory:value.batch.artifactRoot})).status,'complete');}
  else{await assert.rejects(reviewed(value),{code:'UNSUPPORTED_NEW_LINKS'});await lstat(source.currentPath);}
 });
});

for(const history of [false,true])test(`公开Inbox批次完整闭环：牵动历史=${history}，阶段分离、重启复用与身份名字同步`,async t=>{
 let interrupted=false;
 const value=await fixture(t,{history,checkpoint:async stage=>{if(!history&&stage==='copied'&&!interrupted){interrupted=true;throw new Error('公开入口模拟归档中断');}}}),{batch:input,strategy,planning,f}=value;
 const quiet=async()=>({upstreamCommit:UPSTREAM_COMMIT,result:{changedTasks:[],queue:{version:1,tasks:[]}},events:[]});
 const verify=process.env.ORGANIZER_RESCAN_BINARY?nativeRescanVerifier():quiet;
 const options={strategies:{inbox:strategy},planning,stateDirectory:path.join(f.root,'batch-state'),backup:args=>createBackup(args,{inspect:args=>preflight(args,{sourceManifest:{version:'0.6.11',commit:UPSTREAM_COMMIT,files:{fixture:digest('verified-test-format')}}})}),migration:createMigrationService({verify}),recovery:createRecoveryService({verify}),original:createOriginalExecutionService({verify})};
 const server=createApp({batches:createBatchService(options)});await listenForBrowser(server);t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(`${base}/api/session`)).json();
 assert.equal((await fetch(`${base}/inbox`)).status,200);assert.ok((await(await fetch(`${base}/inbox.js`)).text()).includes('requestBatch as api'));
 let batch;
 const call=async(action,extra={},expected=200)=>{const response=await fetch(`${base}/api/batches/${action}`,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify({batchId:batch?.batchId,revision:batch?.revision,...extra})});const body=await response.json();assert.equal(response.status,expected,JSON.stringify(body));if(expected===200)batch=body;return body;};
 await call('create',{...input,mode:'inbox'});await call('analyzeNext',{limit:5});const sourceId=batch.sources[0].sourceId;
 for(const extra of [{action:'confirmName',name:'缓存一致性.md'},{action:'classify'},...(history?[{action:'evolve',category:''},{action:'confirmEvolution'}]:[]),{action:'confirmCategory',category:history?'002 一致性':'001 缓存'}])await call('reviewItem',{sourceId,...extra});
 await call('prepareSlice',{writersPaused:true});const sliceId=batch.slices[0].sliceId;
 await call('validateSlice',{sliceId,approved:true,writersPaused:true});assert.ok(await lstat(path.join(input.sourceRoot,'录屏.md')));
 if(history)assert.equal(batch.slices[0].validationResult.status,'complete');
 await call('prepareOriginal',{sliceId,writersPaused:true});if(!history){await call('applySlice',{sliceId,approved:true,writersPaused:true},400);await call('get');assert.equal(batch.slices[0].status,'failed');await lstat(path.join(input.sourceRoot,'录屏.md'));}
 await call('applySlice',{sliceId,approved:true,writersPaused:true});assert.equal(batch.slices[0].status,'complete');assert.equal(batch.sources[0].status,'succeeded');assert.deepEqual(batch.slices[0].archiveResult.newIngestRequests,[]);
 if(history){assert.deepEqual(batch.slices[0].historicalResult.modelAttempts,[]);assert.equal(await readFile(path.join(input.libraryPath,'raw/sources/002 一致性/old.md'),'utf8'),'# 已摄取的短源');}
 const targetRoot=path.join(input.libraryPath,'raw/sources'),state=await planning.list({sourceRoot:targetRoot,libraryPath:input.libraryPath});assert.equal(state.entries[batch.sources[0].currentIdentity].confirmedName,'缓存一致性.md');
 const restarted=createBatchService(options);const repeat=await restarted.applySlice({batchId:batch.batchId,revision:batch.revision,sliceId,approved:true,writersPaused:true});assert.equal(repeat.slices[0].status,'complete');assert.equal(repeat.sources[0].sourceId,sourceId);
});

test('HTTP 新材料审核后关联变化持久失效；复制后重启不得删除已摄取来源',async t=>{
 for(const stage of ['fresh','before-archive','copied'])await t.test(stage,async t=>{
  const value=await fixture(t,{internal:true,checkpoint:async checkpoint=>{if(stage==='copied'&&checkpoint==='copied')throw new Error('模拟复制后退出');}}),{batch:input,planning,f}=value;
  const options={planning,stateDirectory:path.join(f.root,'public-batch-state'),strategies:{inbox:value.strategy}};
  let server,base,token,batch;
  async function start(){server=createApp({batches:createBatchService(options)});await listenForBrowser(server);base=`http://127.0.0.1:${server.address().port}`;({token}=await(await fetch(`${base}/api/session`)).json());}
  await start();t.after(()=>new Promise(resolve=>server.close(resolve)));
  async function call(action,extra={},expected=200){const response=await fetch(`${base}/api/batches/${action}`,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify({batchId:batch?.batchId,revision:batch?.revision,...extra})});const body=await response.json();assert.equal(response.status,expected,JSON.stringify(body));if(expected===200)batch=body;return body;}
  await call('create',{...input,mode:'inbox'});await call('analyzeNext');const source=batch.sources[0];
  for(const patch of [{action:'confirmName',name:'缓存一致性.md'},{action:'classify'},{action:'confirmCategory',category:'001 缓存'}])await call('reviewItem',{sourceId:source.sourceId,...patch});
  let sliceId;
  if(stage!=='fresh'){await call('prepareSlice',{writersPaused:true});sliceId=batch.slices[0].sliceId;await call('validateSlice',{sliceId,approved:true,writersPaused:true});await call('prepareOriginal',{sliceId,writersPaused:true});}
  if(stage==='copied'){await call('applySlice',{sliceId,approved:true,writersPaused:true},400);await call('get');assert.equal(batch.slices[0].archiveResult.items[0].status,'copied');await new Promise(resolve=>server.close(resolve));options.strategies={inbox:createInboxStrategy()};await start();}
  const cachePath=path.join(input.libraryPath,'.llm-wiki/ingest-cache.json'),cache=JSON.parse(await readFile(cachePath,'utf8'));cache.entries['inbox/录屏.md']={hash:source.hash,timestamp:2,filesWritten:['wiki/new.md']};await writeFile(cachePath,JSON.stringify(cache));await writeFile(path.join(input.libraryPath,'wiki/new.md'),'---\nsources: ["inbox/录屏.md"]\n---\n刚完成摄取');
  await call(stage==='fresh'?'prepareSlice':'applySlice',{sliceId,approved:true,writersPaused:true},400);await call('get');
  assert.equal(batch.error.code,stage==='fresh'?'REVIEW_INVALIDATED':'ARCHIVE_FAILED');assert.equal(batch.phase,'needs-review');
  if(stage==='fresh'){assert.equal(batch.sources[0].status,'classified');assert.equal(batch.sources[0].ingestStatus,'historical');assert.ok(batch.sources[0].analysis);assert.equal(batch.sources[0].selected,false);}else assert.equal(batch.slices[0].archiveResult.error.code,'STALE_ASSOCIATION');
  assert.equal(await readFile(source.currentPath,'utf8'),value.text);assert.equal(JSON.parse(await readFile(cachePath,'utf8')).entries['inbox/录屏.md'].timestamp,2);
  if(stage==='copied')assert.equal(await readFile(path.join(input.libraryPath,'raw/sources/001 缓存/缓存一致性.md'),'utf8'),value.text);
 });
});
