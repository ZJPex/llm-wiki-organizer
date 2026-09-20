import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAll } from '../public/analyze-all.js';

test('一次操作串行分析全部 105 份，使用新版本继续且不依赖列表分页', async () => {
  let batch = { batchId: 'batch', revision: 1, sources: [], analysisProgress: { remaining: 105 } }, calls = 0;
  const result = await analyzeAll({ getBatch: () => batch, stopped: () => false, update: value => { batch = value; }, request: async (action, input) => {
    assert.equal(action, 'analyzeNext'); assert.equal(input.revision, batch.revision);
    assert.equal(input.stopOnFailure, true); calls++;
    return { ...batch, revision: batch.revision + 7, analysisProgress: { remaining: Math.max(0, batch.analysisProgress.remaining - input.limit) } };
  } });
  assert.equal(result, 'complete'); assert.equal(calls, 21);
});

test('暂停等待当前组完成，继续仅处理剩余；错误和无进展均停止', async () => {
  let batch = { batchId: 'batch', revision: 1, analysisProgress: { remaining: 10 } }, paused = false, calls = 0;
  const options = { getBatch: () => batch, stopped: () => paused, update: value => { batch = value; }, request: async () => {
    calls++; paused = true; return { ...batch, revision: batch.revision + 1, analysisProgress: { remaining: batch.analysisProgress.remaining - 5 } };
  } };
  assert.equal(await analyzeAll(options), 'paused'); assert.equal(calls, 1);
  paused = false; assert.equal(await analyzeAll(options), 'complete'); assert.equal(calls, 2);
  batch.analysisProgress.remaining = 5; paused = false;
  await assert.rejects(analyzeAll({ ...options, request: async () => { throw new Error('模型失败'); } }), /模型失败/);
  await assert.rejects(analyzeAll({ ...options, request: async () => batch }), /未取得新进展/);
});
