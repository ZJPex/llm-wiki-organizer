import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlanningService } from '../src/planning.js';
import { createApp } from '../src/server.mjs';
import { readModelConfig } from '../src/model-config.js';

test('HTTP 批次命名后跨分支复用现有分类并冻结单一目标，不改 Raw', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'categories-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const sourceRoot = path.join(temp, 'sources'); const categoryRoot = path.join(temp, 'categories');
  await mkdir(sourceRoot); await mkdir(path.join(categoryRoot, '100 项目'), { recursive: true }); await mkdir(path.join(categoryRoot, '300 计算机', '301 Agent'), { recursive: true });
  await writeFile(path.join(categoryRoot, '300 计算机', '301 Agent', '.category.json'), JSON.stringify({ description: '智能体的开发、工具调用与工程化实践', aliases: ['AI Agent', '智能体'] }));
  const configPath = path.join(temp, 'app-state.json'); await writeFile(configPath, JSON.stringify({ llmConfig: { provider: 'custom', model: 'fake', customEndpoint: 'https://example.invalid/v1' } }));
  const contents = { '项目甲.md': '本文围绕智能体工具调用与工程实践展开，项目甲只是示例，正文讨论的是智能体技术。', '跨主题.md': '材料同时涉及烹饪与数据库，缺少明显主主题，无法可靠确定一个主要归属。', '标题.md': '# 仅标题' };
  for (const [identity, content] of Object.entries(contents)) await writeFile(path.join(sourceRoot, identity), content);
  const calls = [];
  const generate = async (_, req) => {
    calls.push(req);
    if (req.stage === 'category-search') return { candidates: req.categories.filter(c => c.aliases.includes('智能体')).map(c => c.path) };
    if (req.stage === 'category-choice') return { category: '300 计算机/301 Agent', reason: '正文讨论智能体工具调用，复用跨分支同义分类，项目仅为案例', evidence: req.content.evidence, uncertain: false };
    return { title: '智能体实践', summary: req.content, evidence: [req.content], uncertain: req.identity === '跨主题.md' };
  };
  const stateDirectory = path.join(temp, 'state'); const planning = createPlanningService({ generate, stateDirectory });
  const app = createApp({ planning }); await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`; const { token } = await (await fetch(`${base}/api/session`)).json();
  const input = { sourceRoot, libraryPath: sourceRoot, categoryRoot, configPath, identity: '项目甲.md' };
  async function call(action, extra = {}) { const response = await fetch(`${base}/api/planning/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organizer-Token': token }, body: JSON.stringify({ ...input, ...extra }) }); return { status: response.status, data: await response.json() }; }
  assert.match(await (await fetch(`${base}/planning-ui.js`)).text(), /confirmCategory/);
  assert.equal((await call('classify')).status, 400);
  await call('analyze'); await call('confirm', { name: '项目甲 第03章 智能体.MD' });
  const proposed = await call('classify'); assert.equal(proposed.status, 200); assert.equal(proposed.data.classification.category, '300 计算机/301 Agent'); assert.equal(proposed.data.confirmedName, '项目甲 第03章 智能体.MD');
  assert.ok(calls.find(c => c.stage === 'category-choice').categories.some(c => c.description.includes('工程化')));
  assert.equal((await call('confirmCategory', { category: '不存在' })).status, 400);
  const approved = await call('confirmCategory', { category: '100 项目' }); assert.equal(approved.status, 200); assert.equal(approved.data.frozenPlan.finalPath, path.join(categoryRoot, '100 项目', '项目甲 第03章 智能体.MD'));
  await mkdir(path.join(sourceRoot, 'other')); await writeFile(path.join(sourceRoot, 'other', '另一个.md'), contents['项目甲.md']);
  await call('analyze', { identity: 'other/另一个.md' }); await call('confirm', { identity: 'other/另一个.md', name: '项目甲 第03章 智能体.MD' }); await call('classify', { identity: 'other/另一个.md' }); assert.equal((await call('confirmCategory', { identity: 'other/另一个.md', category: '100 项目' })).status, 400);
  const restarted = createPlanningService({ generate, stateDirectory }); assert.deepEqual((await restarted.list(input)).entries['项目甲.md'].frozenPlan, approved.data.frozenPlan);
  await writeFile(path.join(categoryRoot, '300 计算机', '301 Agent', '项目甲 第03章 智能体.MD'), '已有'); assert.equal((await call('confirmCategory', { category: '300 计算机/301 Agent' })).status, 400);
  for (const identity of ['跨主题.md', '标题.md']) { await call('analyze', { identity }); await call('confirm', { identity, name: identity }); const count = calls.length; const low = await call('classify', { identity }); assert.equal(low.data.classification.category, null); assert.equal(low.data.classification.status, 'needs-review'); assert.equal(calls.length, count); }
  await mkdir(path.join(categoryRoot, '400 新分类')); assert.equal((await call('confirmCategory', { category: '100 项目' })).status, 400);
  await call('classify'); await writeFile(path.join(sourceRoot, '项目甲.md'), contents['项目甲.md'] + '变化'); assert.equal((await call('confirmCategory', { category: '100 项目' })).status, 400);
  for (const identity of ['跨主题.md', '标题.md']) assert.equal(await readFile(path.join(sourceRoot, identity), 'utf8'), contents[identity]);
});

test('已删除预设回退全局，启用项目覆盖仍抑制任务路由', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'config-fallback-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const configPath = path.join(temp, 'app-state.json');
  const state = { llmConfig: { provider: 'openai', model: 'global', apiKey: 'secret' }, recentProjects: [{ id: 'p', path: temp }], taskModelRouting: { ingestPresetId: 'custom-deleted' } };
  await writeFile(configPath, JSON.stringify(state)); assert.equal((await readModelConfig({ configPath, libraryPath: temp })).model, 'global');
  state.projectLlmOverrides = { p: { enabled: true, presetId: 'custom-deleted', model: 'ignored' } }; state.taskModelRouting.ingestPresetId = 'deepseek'; await writeFile(configPath, JSON.stringify(state)); assert.equal((await readModelConfig({ configPath, libraryPath: temp })).model, 'global');
  state.projectLlmOverrides.p.presetId = 'anthropic'; await writeFile(configPath, JSON.stringify(state)); await assert.rejects(readModelConfig({ configPath, libraryPath: temp }), /未受支持/);
});

