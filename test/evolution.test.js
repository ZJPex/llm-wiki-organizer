import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { createPlanningService } from '../src/planning.js';
import { compileEvolution, nextCategoryPath } from '../src/evolution.js';

test('HTTP 演化按需停止及向父传播，完整编号和受影响材料经审核冻结，Raw 不变', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'evolution-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'raw');
  for (const directory of ['100 技术/100.01 基础', '100 技术/100.03 其他', '300 项目/300.01 智能体/300.01.01 工具']) await mkdir(path.join(root, directory), { recursive: true });
  const identity = '300 项目/300.01 智能体/材料.md'; const content = '材料讨论智能体工具调用与工程实践，归属按主题查找比项目更清楚，原文与确认名称需要保留。';
  await writeFile(path.join(root, identity), content); await writeFile(path.join(root, '300 项目/300.01 智能体/300.01.01 工具/旧材料.md'), '历史材料');
  const configPath = path.join(temp, 'app-state.json'); await writeFile(configPath, JSON.stringify({ llmConfig: { provider: 'custom', model: 'test', customEndpoint: 'https://example.invalid/v1' } }));
  let stop = true; const scopes = [];
  const generate = async (_, req) => {
    if (req.stage !== 'evolution') return { title: '智能体', summary: content, evidence: [content], uncertain: false };
    scopes.push(req.scope);
    if (stop || req.scope === '300 项目') return { canContain: true, parentAffected: false, reason: '现有父分类仍可容纳，不继续扩大检查', operations: [] };
    return { canContain: false, parentAffected: true, reason: '项目分支内主题资料分散，影响父分类说明', operations: [{ type: 'move', from: '300 项目/300.01 智能体', parent: '100 技术', label: '智能体', problem: '主题被项目目录隔开', benefit: '统一按智能体技术查找', }] };
  };
  const planning = createPlanningService({ generate, stateDirectory: path.join(temp, 'state') });
  const app = createApp({ planning }); await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`; const { token } = await (await fetch(`${base}/api/session`)).json();
  const input = { sourceRoot: root, libraryPath: root, categoryRoot: root, configPath, identity, startCategory: '300 项目/300.01 智能体' };
  async function call(action, extra = {}) { const response = await fetch(`${base}/api/planning/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organizer-Token': token }, body: JSON.stringify({ ...input, ...extra }) }); return { status: response.status, data: await response.json() }; }
  await call('analyze'); await call('confirm', { name: '项目甲 第03章 智能体.md' });
  const stopped = await call('evolve'); assert.equal(stopped.status, 200); assert.equal(stopped.data.operations.length, 0); assert.equal(scopes.length, 1);
  stop = false; const proposal = await call('evolve'); assert.equal(proposal.status, 200); assert.deepEqual(proposal.data.visited.map(v => v.scope), ['300 项目/300.01 智能体', '300 项目']);
  const preview = await call('confirmEvolution', { operations: proposal.data.operations, previewOnly: true }); assert.equal(preview.status, 200);
  assert.equal(preview.data.preview.fileMappings.length, 2);
  assert.ok(preview.data.preview.fileMappings.some(m => m.to === '100 技术/100.02 智能体/100.02.01 工具/旧材料.md'));
  assert.ok(preview.data.preview.fileMappings.some(m => m.to.endsWith('/项目甲 第03章 智能体.md')));
  const frozen = await call('confirmEvolution', { operations: proposal.data.operations }); assert.equal(frozen.status, 200); assert.equal(frozen.data.status, 'confirmed');
  assert.equal(await readFile(path.join(root, identity), 'utf8'), content);
  const excluded = await call('confirmEvolution', { operations: [] }); assert.equal(excluded.data.frozenPlan.fileMappings.length, 0);
  await writeFile(path.join(root, '300 项目/300.01 智能体/300.01.01 工具/旧材料.md'), '外部修改'); assert.equal((await call('confirmEvolution', { operations: proposal.data.operations })).status, 400);
  const ui = await (await fetch(`${base}/planning-ui.js`)).text(); assert.match(ui, /原文证据/); assert.doesNotMatch(ui, /textContent = JSON.stringify\(result/);
});

test('纯目录映射：最小空号、同义复用、拆分和编号冲突均有确定性约束', () => {
  const catalog = { root: '/raw', categories: [{ path: '', aliases: [] }, { path: '100 技术', aliases: [] }, { path: '100 技术/100.01 Agent', aliases: ['智能体'] }, { path: '100 技术/100.03 工具', aliases: [] }, { path: '200 其他', aliases: [] }] };
  const baseline = { files: [{ path: '200 其他/a.md', hash: 'a' }, { path: '100 技术/100.01 Agent/a.md', hash: 'b' }] };
  assert.equal(nextCategoryPath(catalog.categories.map(c => c.path), '100 技术', '新主题'), '100 技术/100.02 新主题');
  assert.throws(() => compileEvolution(catalog, baseline, [{ type: 'add', parent: '100 技术', label: '智能体', files: [], problem: '重复', benefit: '找资料' }]), /同义/);
  assert.throws(() => nextCategoryPath(['', '100 技术', '100 技术/100.01 A', '100 技术/100.01 B'], '100 技术', '新类别'), /编号冲突/);
  const split = compileEvolution(catalog, baseline, [{ type: 'split', from: '200 其他', groups: [{ label: '新主题', files: ['200 其他/a.md'] }], problem: '混杂', benefit: '主题查找' }]); assert.equal(split.fileMappings[0].to, '200 其他/200.01 新主题/a.md');
  assert.throws(() => compileEvolution(catalog, baseline, [{ type: 'merge', from: '200 其他', to: '100 技术/100.01 Agent', problem: '同义重复', benefit: '集中查找' }]), /冲突/);
  assert.throws(() => compileEvolution(catalog, baseline, [{ type: 'add', parent: '100 技术', label: '新主题', files: [], problem: '', benefit: '另一个分法' }]), /问题与查找收益/);
});
