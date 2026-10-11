import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import {historyFixture} from './helpers/history-fixture.js';
import {reconcileReviewDraft} from '../public/review-workspace.js';

test('混合批正文变化只重分析当前材料，关联变化保留正文分析与其他审核',async t=>{
 const f=await historyFixture(t,{mixed:true}),old=f.getBatch(),calls=f.modelCalls();
 const changed=old.sources.find(s=>s.identity==='new.md'),associated=old.sources.find(s=>s.identity==='old.md');
 await writeFile(changed.currentPath,'缓存正文内容发生真实改变，需要重新读取证据。');
 await writeFile(path.join(f.libraryPath,'wiki/sources/old.md'),'---\nsources: ["old.md"]\n---\n历史关联页面变化');
 let b=await f.call('refreshReview');
 assert.equal(b.sources.find(s=>s.sourceId===changed.sourceId).status,'needs-analysis');
 assert.equal(b.sources.find(s=>s.sourceId===changed.sourceId).analysis,undefined);
 assert.deepEqual(b.sources.find(s=>s.sourceId===associated.sourceId).analysis,associated.analysis);
 assert.equal(b.sources.filter(s=>s.status==='reviewed').length,2);assert.equal(f.modelCalls(),calls);
 assert.ok(b.invalidations.reasons.some(r=>r.code==='ASSOCIATION_CHANGED'));
 const versions=b.sources.map(s=>s.reviewVersion);b=await f.call('refreshReview');assert.deepEqual(b.sources.map(s=>s.reviewVersion),versions);
 await f.call('analyzeNext',{limit:5});assert.equal(f.modelCalls()-calls,3);
});
test('共享原库基线变化撤销验证并拒绝旧授权，保留逐份审核',async t=>{
 const f=await historyFixture(t);await f.call('startHistoryValidation',{planHash:f.getBatch().historyPlan.planHash,writersPaused:true});const old=await f.wait();assert.equal(old.historyValidation.status,'awaiting-apply');
 await writeFile(path.join(f.libraryPath,'额外记录.txt'),'外部写入');let b=await f.call('refreshReview');assert.equal(b.historyValidation.status,'stale');assert.equal(b.counts.reviewed,3);
 assert.ok(b.invalidations.reasons.some(r=>r.code==='SHARED_BASELINE_CHANGED'));
 await f.call('applyHistoryPlan',{planHash:old.historyPlan.planHash,evidenceDigest:old.historyValidation.evidenceDigest,writersPaused:true,approved:true},400);await f.call('get');
 await f.call('continueHistoryValidation',{planHash:f.getBatch().historyPlan.planHash,writersPaused:true});b=await f.wait();assert.equal(b.historyValidation.status,'awaiting-apply',JSON.stringify(b.historyValidation));assert.equal(b.historyValidation.attemptCount,2);
});
test('无关分类新增经依赖证明保留人工目标和全部正文，重复检查不重复失效',async t=>{
 const f=await historyFixture(t),before=f.getBatch();await mkdir(path.join(f.libraryPath,'raw/sources/002 网络'));
 let b=await f.call('refreshReview');assert.equal(b.counts.reviewed,3);assert.equal(b.sources.filter(s=>s.analysis).length,3);assert.ok(b.sources.every(s=>s.classification&&s.selected));assert.equal(b.invalidations.retainedClassificationSourceIds.length,3);
 assert.deepEqual(b.sources.map(s=>s.analysis),before.sources.map(s=>s.analysis));const versions=b.sources.map(s=>s.reviewVersion);b=await f.call('refreshReview');assert.deepEqual(b.sources.map(s=>s.reviewVersion),versions);
});
test('同正文新审核版本撤销旧选择且保留手动名称',()=>{
 const draft=reconcileReviewDraft({hash:'a',reviewVersion:2,reviewResetCategory:true},{hash:'a',reviewVersion:1,name:'手工.md',category:'旧目录',selected:true,manual:true});assert.equal(draft.selected,false);assert.equal(draft.name,'手工.md');assert.equal(draft.category,'旧目录');assert.equal(draft.invalidated,true);
});

test('目录演化成员关联变化完整阻断依赖组，独立新增审核仍有效',async t=>{
 const {createBatchStore}=await import('../src/batch-store.js');const f=await historyFixture(t,{mixed:true}),b=f.getBatch(),store=createBatchStore({stateDirectory:f.stateDirectory});
 await store.update(b.batchId,b.revision,record=>{record.flow.evolutionPlan={planHash:'test-directory-plan',fileMappings:record.sources.filter(s=>s.ingestStatus==='historical').map(s=>({from:s.identity,to:'001 缓存/'+s.confirmedName}))};return record;});await f.call('get');
 await writeFile(path.join(f.libraryPath,'wiki/sources/old.md'),'---\nsources: ["old.md"]\n---\n变更关联');const refreshed=await f.call('refreshReview');assert.equal(refreshed.sources.find(s=>s.identity==='new.md').status,'reviewed');assert.ok(refreshed.sources.filter(s=>s.ingestStatus==='historical').every(s=>!s.selected));assert.equal(refreshed.historyPlan.evolutionPlanHash,null);assert.equal(refreshed.historyPlan.blockerCount,0);assert.ok(refreshed.sources.filter(s=>s.ingestStatus==='historical').every(s=>s.directoryDependency));assert.ok(refreshed.invalidations.reasons.some(r=>r.scope==='directory'));assert.equal(f.modelCalls(),12);
});

test('分类重荐保留手改草稿供重审，新会话正确恢复已审核选择',()=>{
 let draft=reconcileReviewDraft({hash:'a',reviewVersion:2,reviewResetCategory:true},{hash:'a',reviewVersion:1,name:'手改.md',category:'失效目录',selected:true,manual:true});
 draft=reconcileReviewDraft({hash:'a',reviewVersion:2,reviewResetCategory:true,classification:{category:'002 新分类'}},draft);assert.equal(draft.name,'手改.md');assert.equal(draft.category,'失效目录');assert.equal(draft.selected,false);assert.equal(draft.invalidated,true);
 const restored=reconcileReviewDraft({hash:'a',reviewVersion:2,reviewResetCategory:true,status:'reviewed',selected:true,confirmedName:'确认.md',classification:{category:'002 新分类'}});assert.equal(restored.selected,true);assert.equal(restored.reviewVersion,2);
});
