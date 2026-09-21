import test from 'node:test';
import assert from 'node:assert/strict';
import {loadReview,reviewReason,confirmReview} from '../public/bulk-review.js';

test('全量清单跨越材料与分类分页，拒绝变化版本',async()=>{
 const batch={batchId:'one',revision:7};
 const request=async(_,input)=>({revision:7,sources:input.cursor===0?[{sourceId:'a'}]:[{sourceId:'b'}],nextCursor:input.cursor===0?50:null,flow:{tree:{status:'approved',nodes:input.treeCursor===0?[{nodeId:'x'}]:[{nodeId:'y'}],nextCursor:input.treeCursor===0?50:null}}});
 const result=await loadReview(batch,request);assert.equal(result.sources.length,2);assert.equal(result.nodes.length,2);
 await assert.rejects(loadReview(batch,async()=>({revision:8})),/批次已变化/);
 assert.ok(reviewReason({status:'analysis-failed'}));assert.ok(reviewReason({status:'analyzed',ingestStatus:'uncertain'}));
 assert.equal(reviewReason({status:'analyzed',ingestStatus:'historical',proposedNodeId:'x',analysis:{suggestion:'a.md',uncertain:false}}),'');
});

test('一次确认有效方案，保留未纳入项，逐项失败后使用核验的新版本继续',async()=>{
 let revision=7;const calls=[];
 const request=async(action,input)=>{
  if(action==='get')return {revision};
  assert.equal(input.revision,revision);calls.push(input);revision++;
  if(input.sourceId==='conflict')throw Object.assign(new Error('目标冲突'),{revision,code:'TARGET_EXISTS'});
  return {revision};
 };
 const rows=[{sourceId:'a',include:true},{sourceId:'leave',include:false},{sourceId:'conflict',include:true,identity:'冲突材料'},{sourceId:'b',include:true},{sourceId:'exclude',include:false,wasSelected:true}];
 const result=await confirmReview({batchId:'one',revision},rows,request,()=>{});
 assert.equal(result.confirmed,2);assert.equal(result.failures.length,1);assert.deepEqual(calls.map(c=>c.sourceId),['a','conflict','b','exclude']);assert.equal(calls.at(-1).action,'exclude');
 await assert.rejects(confirmReview({revision:1},[{include:true}],async()=>{throw Object.assign(new Error(),{code:'STALE_BATCH'});},()=>{}),/已停止/);
});
