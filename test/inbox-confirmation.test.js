import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,lstat,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {inboxConfirmationFixture} from './helpers/inbox-confirmation-fixture.js';

test('一键确认覆盖整批明确推荐，保留未分类、未命名、已排除及已有人工审核，只保存方案不归档',async t=>{
 const f=await inboxConfirmationFixture(t);
 const page=await f.call('get',{limit:1});
 assert.equal(page.sources.length,1);
 const result=await f.call('confirmRecommendedCategories');
 assert.deepEqual(result.flow.categoryConfirmation,{status:'complete',total:3,completed:3,confirmed:3,failed:0,skipped:4});
 const batch=await f.call('get',{limit:50});
 for(const identity of ['a.md','b.md','root.md']){
  const source=batch.sources.find(s=>s.identity===identity);
  assert.equal(source.status,'reviewed');assert.equal(source.selected,true);
  assert.equal(source.targetPath,path.join(f.libraryPath,'raw/sources',identity==='root.md'?'':'001 缓存',identity));
  assert.match(await readFile(path.join(f.sourceRoot,identity),'utf8'),/缓存一致性/);
  await assert.rejects(lstat(source.targetPath),{code:'ENOENT'});
 }
 assert.deepEqual(Object.fromEntries(batch.sources.map(s=>[s.identity,s.status])),{
  'a.md':'reviewed','b.md':'reviewed','root.md':'reviewed','unknown.md':'classified','unnamed.md':'classified','excluded.md':'excluded','reviewed.md':'reviewed'
 });
 assert.equal(batch.sources.find(s=>s.identity==='reviewed.md').targetPath,path.join(f.libraryPath,'raw/sources/reviewed.md'));
 assert.equal(batch.slices.length,0);
 const repeated=await f.call('confirmRecommendedCategories');
 assert.equal(repeated.flow.categoryConfirmation.confirmed,0);
 assert.equal(repeated.confirmableCategoryCount,0);
});

test('批量确认遇到目标冲突停止并报告，保留已成功审核，修复后仅重试剩余项',async t=>{
 const f=await inboxConfirmationFixture(t);
 const target=path.join(f.libraryPath,'raw/sources/001 缓存/b.md');
 await writeFile(target,'原有文件不能覆盖');
 await assert.rejects(f.call('confirmRecommendedCategories'),/存在|覆盖/);
 const failed=await f.call('get');
 assert.deepEqual(failed.flow.categoryConfirmation,{status:'failed',total:3,completed:2,confirmed:1,failed:1,skipped:4});
 assert.equal(failed.sources.find(s=>s.identity==='a.md').status,'reviewed');
 const source=failed.sources.find(s=>s.identity==='b.md');
 assert.equal(source.status,'classified');assert.equal(source.selected,false);
 assert.match(source.categoryConfirmationError,/存在|覆盖/);
 assert.equal(failed.sources.find(s=>s.identity==='root.md').status,'classified');
 assert.equal(await readFile(target,'utf8'),'原有文件不能覆盖');
 await unlink(target);
 const retried=await f.call('confirmRecommendedCategories');
 assert.equal(retried.flow.categoryConfirmation.confirmed,2);
 assert.equal(retried.sources.find(s=>s.identity==='b.md').categoryConfirmationError,undefined);
});

test('目录演化保持单独人工审核，存在已审核演化方案时不批量沿用旧推荐',async t=>{
 const f=await inboxConfirmationFixture(t);
 const sourceId=f.getBatch().sources.find(s=>s.identity==='a.md').sourceId;
 const evolving=await f.call('reviewItem',{sourceId,action:'evolve',category:'001 缓存'});
 assert.equal(evolving.confirmableCategoryCount,2);
 const approved=await f.call('reviewItem',{sourceId,action:'confirmEvolution'});
 assert.equal(approved.confirmableCategoryCount,0);
 await assert.rejects(f.call('confirmRecommendedCategories'),{code:'EVOLUTION_REVIEW_REQUIRED'});
 const unchanged=await f.call('get');
 assert.equal(unchanged.counts.reviewed,1);
});

test('批量确认拒绝陈旧批次和变化来源，不将过期分析标记为已审核',async t=>{
 const f=await inboxConfirmationFixture(t),initial=f.getBatch();
 await assert.rejects(f.request('confirmRecommendedCategories',{batchId:initial.batchId,revision:initial.revision-1}),{code:'STALE_BATCH'});
 await writeFile(path.join(f.sourceRoot,'a.md'),'正文已改成另一个主题');
 await assert.rejects(f.call('confirmRecommendedCategories'),/变化|改变/);
 const batch=await f.call('get');
 const source=batch.sources.find(s=>s.identity==='a.md');
 assert.equal(source.status,'needs-analysis');assert.equal(source.selected,false);
 assert.equal(batch.counts.reviewed,1);
 assert.equal(batch.flow.categoryConfirmation.confirmed,0);
 assert.equal(batch.flow.categoryConfirmation.status,'failed');
});

test('中断执行阻止批量审核时不显示仍在确认，保留执行现场',async t=>{
 const f=await inboxConfirmationFixture(t);await f.interruptedExecution();
 await assert.rejects(f.call('confirmRecommendedCategories'),{code:'EXECUTION_INTERRUPTED'});
 const batch=await f.call('get');
 assert.notEqual(batch.flow.categoryConfirmation?.status,'running');
 assert.equal(batch.slices[0].status,'applying');assert.equal(batch.counts.reviewed,1);
});
