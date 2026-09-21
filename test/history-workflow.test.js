import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {migrationFixture} from './helpers/migration-fixture.js';
import {listenForBrowser} from './helpers/http-server.js';
import {createApp} from '../src/server.mjs';
import {createBatchService} from '../src/batches.js';
import {createBatchStore} from '../src/batch-store.js';
import {createPlanningService} from '../src/planning.js';
import {createInboxStrategy} from '../src/inbox.js';
import {createBackup} from '../src/backup.js';
import {createMigrationService} from '../src/migration.js';
import {createRecoveryService} from '../src/recovery.js';
import {UPSTREAM_COMMIT} from '../src/migration-verifier.js';
import {inventory,preflight,digest} from '../src/compatibility.js';

async function fixture(t,{failValidation=false,backupGate}={}){
 const text='缓存一致性需要协调索引维护，完整保留知识正文与摄取状态以保证历史迁移安全。';
 const f=await migrationFixture(t,{decorate:async({write,libraryPath})=>{
  await mkdir(path.join(libraryPath,'raw/sources/001 缓存'));
  const cache=JSON.parse(await readFile(path.join(libraryPath,'.llm-wiki/ingest-cache.json'),'utf8'));
  for(const name of ['old','second','third']){await write(`raw/sources/${name}.md`,text);if(name==='old'){cache.entries['old.md'].hash=digest(text);continue;}await write(`wiki/sources/${name}.md`,`---\nsources: ["${name}.md"]\n---\n原知识正文不修改。`);cache.entries[name+'.md']={hash:digest(text),timestamp:1,filesWritten:[`wiki/sources/${name}.md`]};}
  await write('.llm-wiki/ingest-cache.json',cache);
 }});
 const libraryPath=f.backup.originalPath,sourceRoot=path.join(libraryPath,'raw/sources'),wikiSourcePath=path.join(f.root,'upstream'),artifactRoot=path.join(f.root,'history-artifacts'),configPath=path.join(f.root,'history-config.json'),stateDirectory=path.join(f.root,'history-state');await mkdir(artifactRoot);await mkdir(path.join(wikiSourcePath,'src/lib'),{recursive:true});
 await writeFile(path.join(wikiSourcePath,'src/lib/source-watch-defaults.json'),JSON.stringify({enabled:false,autoIngest:false,includeExtensions:['md'],excludeExtensions:[],excludeDirs:[],excludeGlobs:[]}));await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'fixed'},sourceWatchConfig:{enabled:false,autoIngest:false}}));
 let modelCalls=0,fail=failValidation,server,base,token,batch;
 const quiet=async()=>({upstreamCommit:UPSTREAM_COMMIT,result:{changedTasks:[],queue:{version:1,tasks:[]}},events:[]});
 const planning=createPlanningService({stateDirectory:path.join(f.root,'history-planning'),generate:async(_,request)=>{modelCalls++;if(request.stage==='category-search')return {candidates:['001 缓存']};if(request.stage==='category-choice')return {category:'001 缓存',reason:'全文缓存主题',evidence:request.content.evidence,uncertain:false};return {title:request.identity.replace('.md','')+'缓存',summary:request.content,evidence:[request.content],uncertain:false};}});
 const options={stateDirectory,planning,strategies:{inbox:createInboxStrategy()},backup:async input=>{await backupGate?.();return createBackup(input,{inspect:input=>preflight(input,{sourceManifest:{version:'0.6.11',commit:UPSTREAM_COMMIT,files:{fixture:digest('verified-test-format')}}})});},migration:createMigrationService({verify:async(...args)=>{if(fail)throw new Error('注入完整验证失败');return quiet(...args);}}),recovery:createRecoveryService({verify:quiet})};
 const open=async()=>{server=createApp({batches:createBatchService(options)});await listenForBrowser(server);base=`http://127.0.0.1:${server.address().port}`;({token}=await(await fetch(base+'/api/session')).json());};await open();t.after(()=>new Promise(resolve=>server.close(resolve)));
 const call=async(action,extra={},expected=200)=>{const response=await fetch(base+'/api/batches/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify({batchId:batch?.batchId,revision:batch?.revision,...extra})});const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));if(expected===200)batch=result;return result;};
 await call('create',{mode:'inbox',libraryPath,sourceRoot,wikiSourcePath,artifactRoot,configPath});await call('analyzeNext',{limit:5});assert.equal(batch.counts.classified,3);await call('confirmPlans',{items:batch.sources.map(source=>({sourceId:source.sourceId,name:source.suggestion,category:'001 缓存'}))});
 const wait=async()=>{for(let i=0;i<400;i++){await call('get');if(batch.historyValidation.status!=='running')return batch;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('历史验证未完成');};
 return {f,libraryPath,artifactRoot,call,wait,stateDirectory,getBatch:()=>batch,modelCalls:()=>modelCalls,repair:()=>{fail=false;},restart:async()=>{await new Promise(resolve=>server.close(resolve));await open();}};
}

test('公开历史方案后台一次串联完整备份、三份材料验证和恢复，断页继续，原库不动且停待应用',async t=>{
 const f=await fixture(t),before=await inventory(f.libraryPath),calls=f.modelCalls();
 await f.call('startHistoryValidation',{planHash:f.getBatch().historyPlan.planHash},400);assert.equal((await readdir(f.artifactRoot)).length,0);
 await f.call('startHistoryValidation',{planHash:'旧方案',writersPaused:true},400);assert.equal((await readdir(f.artifactRoot)).length,0);
 await f.call('startHistoryValidation',{planHash:f.getBatch().historyPlan.planHash,writersPaused:true});const hash=f.getBatch().historyValidation.planHash;
 await f.restart();const result=await f.wait();assert.equal(result.historyValidation.status,'awaiting-apply',JSON.stringify(result.historyValidation));assert.equal(result.historyValidation.planHash,hash);assert.equal(result.historyValidation.selectedCount,3);assert.equal(result.slices.length,1);assert.equal(result.slices[0].validationResult.items.length,3);assert.equal(result.slices[0].validationResult.status,'complete');assert.equal(result.slices[0].authorizationPlanPath,undefined);assert.ok(result.historyValidation.evidenceDigest);assert.equal((await inventory(f.libraryPath)).hash,before.hash);assert.equal(f.modelCalls(),calls);
 await f.call('startHistoryValidation',{planHash:hash,writersPaused:true});assert.equal(f.getBatch().historyValidation.attemptCount,1);assert.equal((await readdir(f.artifactRoot)).length,1);
 const journal=f.getBatch().historyValidation.validationJournalPath;await writeFile(journal,(await readFile(journal,'utf8')).replace('"status": "complete"','"status": "partial"'));await f.call('startHistoryValidation',{planHash:hash,writersPaused:true},400);assert.equal((await inventory(f.libraryPath)).hash,before.hash);
});

test('验证失败保存完整现场，服务新实例不自动续作，用户继续以独立新尝试验证同一方案',async t=>{
 const f=await fixture(t,{failValidation:true}),before=await inventory(f.libraryPath);await f.call('startHistoryValidation',{planHash:f.getBatch().historyPlan.planHash,writersPaused:true});let result=await f.wait();assert.equal(result.historyValidation.status,'failed');assert.equal(result.historyValidation.stage,'validation');const oldReport=result.historyValidation.backupReportPath,oldBytes=await readFile(oldReport,'utf8');assert.equal(result.historyValidation.evidenceDigest,null);assert.equal((await inventory(f.libraryPath)).hash,before.hash);
 await f.restart();await f.call('get');assert.equal(f.getBatch().historyValidation.status,'failed');await f.call('continueHistoryValidation',{planHash:f.getBatch().historyPlan.planHash},400);f.repair();await f.call('continueHistoryValidation',{planHash:f.getBatch().historyPlan.planHash,writersPaused:true});result=await f.wait();assert.equal(result.historyValidation.status,'awaiting-apply',JSON.stringify(result.historyValidation));assert.equal(result.historyValidation.attemptCount,2);assert.notEqual(result.historyValidation.backupReportPath,oldReport);assert.equal(await readFile(oldReport,'utf8'),oldBytes);assert.equal((await inventory(f.libraryPath)).hash,before.hash);
});

test('磁盘中断状态须手动续作，复用完整证据；目录调整未审核成员不能扩大范围',async t=>{
 const f=await fixture(t);await f.call('startHistoryValidation',{planHash:f.getBatch().historyPlan.planHash,writersPaused:true});await f.wait();const store=createBatchStore({stateDirectory:f.stateDirectory});let batch=f.getBatch();const evidence=batch.historyValidation.evidenceDigest;
 await store.update(batch.batchId,batch.revision,record=>{record.flow.historyValidation.status='running';record.flow.historyValidation.stage='checking-evidence';return record;});await f.restart();await f.call('get');assert.equal(f.getBatch().historyValidation.status,'interrupted');await f.call('continueHistoryValidation',{planHash:f.getBatch().historyPlan.planHash,writersPaused:true});await f.wait();assert.equal(f.getBatch().historyValidation.status,'awaiting-apply');assert.equal(f.getBatch().historyValidation.evidenceDigest,evidence);assert.equal(f.getBatch().historyValidation.attemptCount,1);
 batch=f.getBatch();await store.update(batch.batchId,batch.revision,record=>{record.flow.evolutionPlan={planHash:'directory-change',fileMappings:[{from:'unselected.md',to:'001 缓存/unselected.md'}]};return record;});await f.call('get');assert.equal(f.getBatch().historyPlan.blockerCount,1);await f.call('startHistoryValidation',{planHash:f.getBatch().historyPlan.planHash,writersPaused:true},400);assert.equal((await readdir(f.artifactRoot)).length,1);
});

test('后台历史验证全程互斥，完整选择替换明确排除旧审核材料',async t=>{
 let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const f=await fixture(t,{backupGate:async()=>{entered();await gate;}});t.after(()=>release());
 const initial=f.getBatch(),only=initial.sources[0],oldHash=initial.historyPlan.planHash;
 await f.call('confirmPlans',{replaceSelection:true,items:[{sourceId:only.sourceId,name:only.confirmedName,category:only.classification.category}]});
 assert.equal(f.getBatch().historyPlan.selectedCount,1);assert.notEqual(f.getBatch().historyPlan.planHash,oldHash);assert.equal(f.getBatch().sources.filter(source=>source.selected).length,1);
 await f.call('startHistoryValidation',{planHash:oldHash,writersPaused:true},400);
 await f.call('startHistoryValidation',{planHash:f.getBatch().historyPlan.planHash,writersPaused:true});await started;await f.call('get');
 assert.equal((await f.call('startAnalysis',{},400)).code,'BATCH_BUSY');
 assert.equal((await f.call('reviewItem',{sourceId:only.sourceId,action:'exclude'},400)).code,'BATCH_BUSY');
 assert.equal((await f.call('prepareSlice',{writersPaused:true},400)).code,'BATCH_BUSY');
 await f.call('startHistoryValidation',{planHash:f.getBatch().historyPlan.planHash,writersPaused:true});
 release();const result=await f.wait();assert.equal(result.historyValidation.status,'awaiting-apply',JSON.stringify(result.historyValidation));assert.equal(result.historyValidation.selectedCount,1);assert.equal(result.slices[0].validationResult.items.length,1);
});
