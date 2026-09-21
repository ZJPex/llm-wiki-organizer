import {historyFixture} from './helpers/history-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,readdir} from 'node:fs/promises';
import {createBatchStore} from '../src/batch-store.js';
import {inventory} from '../src/compatibility.js';
const fixture=historyFixture;

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
