import test from 'node:test';
import assert from 'node:assert/strict';
import { requireOriginalSuccess } from '../scripts/upstream-frontend/external-original.mjs';

// 这些是证据门禁单元测试数据，不作为真实上游执行证明。
const proof = {upstreamCommit:'e8082119649e6a8e1cf85eaf289adcabfdf39d4e',result:{changedTasks:[],queue:{tasks:[]}},events:[]};
const items = [{id:'one',from:'raw/sources/a.md',to:'raw/sources/b.md',expectedHash:'source-hash',status:'selected'}, {id:'two',from:'raw/sources/c.md',to:'raw/sources/d.md',expectedHash:'other-hash',status:'excluded'}];
const record = () => ({status:'partial',targetRole:'original',phase:'verified-original',modelAttempts:[],items:items.map(item=>({...item,status:item.status==='selected'?'succeeded':item.status})),beforeProof:structuredClone(proof),afterProof:structuredClone(proof)});

test('原库前端门禁允许全部所选项成功的partial，拒绝扩大排除范围和不完整执行', () => {
  assert.doesNotThrow(()=>requireOriginalSuccess(record(),items,'original'));
  for (const status of ['failed','applied-unverified','not-run']) {
    const value=record();value.items[0].status=status;
    assert.throws(()=>requireOriginalSuccess(value,items,'original'),/未成功/);
  }
  const expanded=record();expanded.items[1].status='succeeded';
  assert.throws(()=>requireOriginalSuccess(expanded,items,'original'),/扩大范围/);
});
test('原库前端门禁拒绝副本角色、模型尝试和伪静默扫描', () => {
  const wrongRole=record();wrongRole.targetRole='validation';
  assert.throws(()=>requireOriginalSuccess(wrongRole,items,'original'),/尚未成功/);
  const model=record();model.modelAttempts.push('generation');
  assert.throws(()=>requireOriginalSuccess(model,items,'original'),/尚未成功/);
  for (const mutate of [value=>value.afterProof.result.changedTasks.push({}),value=>value.afterProof.events.push({event:'file-sync://changed'}),value=>value.afterProof.result.queue.tasks.push({status:'pending'}),value=>value.afterProof.upstreamCommit='other']) {
    const value=record();mutate(value);assert.throws(()=>requireOriginalSuccess(value,items,'original'),/零变化证据/);
  }
});
