import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { createPlanningService } from '../src/planning.js';

test('HTTP 命名方案：全文覆盖、配置优先级、审核与重启复用、来源不变', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'planning-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const sourceRoot = path.join(temp, 'sources'); await mkdir(sourceRoot);
  const stateDirectory = path.join(temp, 'state');
  const configPath = path.join(temp, 'app-state.json');
  const config = { llmConfig: { provider: 'openai', apiKey: 'global-secret', model: 'global' }, recentProjects: [{ id: 'wiki', path: sourceRoot }], projectLlmOverrides: { wiki: { enabled: true, presetId: 'custom', model: 'project-model' } }, taskModelRouting: { ingestPresetId: 'deepseek' }, providerConfigs: { custom: { apiKey: 'project-secret', model: 'preset-model', baseUrl: 'https://example.invalid/v1', maxContextSize: 1024 }, deepseek: { apiKey: 'route-secret', model: 'route-model' } } };
  await writeFile(configPath, JSON.stringify(config));
  const content = '# 项目甲 第03章\n' + '这里讲述缓存与索引协作，资料中保留完整原文证据。'.repeat(40) + '\n结尾讨论一致性校验与失败恢复。';
  await writeFile(path.join(sourceRoot, '1080p.md'), content);
  let requests = [];
  const generate = async (effective, request) => { requests.push({ effective, request }); return { title: '项目甲 第03章 缓存与索引', summary: request.content.slice(0, 50), evidence: [request.content.slice(0, 15)], uncertain: false }; };
  const planning = createPlanningService({ generate, stateDirectory });
  const server = createApp({ planning }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const input = { sourceRoot, libraryPath: sourceRoot, configPath, identity: '1080p.md' };
  const call = async (action, extra = {}) => { const response = await fetch(`${base}/api/planning/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organizer-Token': token }, body: JSON.stringify({ ...input, ...extra }) }); return { status: response.status, value: await response.json() }; };
  assert.equal((await fetch(`${base}/planning-ui.js`)).status, 200);
  assert.equal((await fetch(`${base}/api/planning/analyze`, { method: 'POST' })).status, 403);
  const result = await call('analyze'); assert.equal(result.status, 200); assert.ok(result.value.segments.length > 2);
  assert.equal(requests.filter(r => r.request.stage === 'segment').map(r => r.request.content).join(''), content);
  assert.ok(requests.every(r => r.effective.model === 'project-model' && r.effective.apiKey === 'project-secret'));
  assert.ok(!JSON.stringify(result).includes('secret'));
  const count = requests.length; assert.equal((await call('analyze')).value.reused, true); assert.equal(requests.length, count);
  assert.equal((await call('confirm', { name: 'CON.md' })).status, 400);
  await writeFile(path.join(sourceRoot, 'occupied.md'), 'existing'); assert.equal((await call('confirm', { name: 'OCCUPIED.md' })).status, 400);
  assert.equal((await call('confirm', { name: '项目甲 第03章 缓存.md' })).status, 200);
  const restarted = createPlanningService({ generate, stateDirectory });
  assert.equal((await restarted.analyze(input)).confirmedName, '项目甲 第03章 缓存.md');
  assert.equal(await readFile(path.join(sourceRoot, '1080p.md'), 'utf8'), content);
  const files = await readdir(stateDirectory); assert.ok(!(await readFile(path.join(stateDirectory, files[0]), 'utf8')).includes('secret'));
  await writeFile(path.join(sourceRoot, '1080p.md'), content + '已变'); assert.equal((await call('confirm', { name: 'changed.md' })).status, 400);
  const registryAlias = path.join(temp, 'registry-alias'); await symlink(sourceRoot, registryAlias, 'junction');
  config.recentProjects[0].path = process.platform === 'win32' ? registryAlias.toUpperCase() : registryAlias;
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(path.join(sourceRoot, 'alias.md'), content);
  assert.equal((await call('analyze', { identity: 'alias.md' })).status, 200);
  assert.equal(requests.at(-1).effective.model, 'project-model');
  assert.equal(requests.at(-1).effective.apiKey, 'project-secret');
  config.projectLlmOverrides.wiki.enabled = false; await writeFile(configPath, JSON.stringify(config));
  await writeFile(path.join(sourceRoot, 'route.md'), content); await call('analyze', { identity: 'route.md' }); assert.equal(requests.at(-1).effective.model, 'route-model');
});

test('不同低信息来源、未知协议和错误证据均不产生自动改名', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'planning-kind-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const sourceRoot = path.join(temp, 'sources'); await mkdir(sourceRoot);
  const configPath = path.join(temp, 'app-state.json'); await writeFile(configPath, JSON.stringify({ llmConfig: { provider: 'custom', model: 'test', customEndpoint: 'https://example.invalid/v1' } }));
  let calls = 0;
  const planning = createPlanningService({ stateDirectory: path.join(temp, 'state'), generate: async (_, req) => { calls++; return { title: '导航', summary: req.content, evidence: [req.content], uncertain: true }; } });
  for (const [identity, text, kind] of [['blank.md', ' \n', 'blank'], ['title.md', '# 标题', 'title-only'], ['noise.md', '嗯嗯啊 123', 'noise'], ['nav.md', '# 索引\n- [[缓存]]\n- [恢复](restore.md)', 'navigation']]) {
    await writeFile(path.join(sourceRoot, identity), text);
    const result = await planning.analyze({ sourceRoot, libraryPath: sourceRoot, configPath, identity }); assert.equal(result.kind, kind); assert.equal(result.suggestion, null); assert.equal(await readFile(path.join(sourceRoot, identity), 'utf8'), text);
  }
  assert.equal(calls, 1);
  await writeFile(configPath, JSON.stringify({ llmConfig: { provider: 'anthropic', model: 'test', apiKey: 'secret' } }));
  await writeFile(path.join(sourceRoot, 'unsupported.md'), '这里是一份足够长的真实材料，用于明确验证不支持的供应商不能被误调用。');
  await assert.rejects(planning.analyze({ sourceRoot, libraryPath: sourceRoot, configPath, identity: 'unsupported.md' }), /只支持/);
  assert.equal(calls, 1);
});

test('拒绝库内状态、伪造证据与并发源变化，已确认名称不妨碍重新分析', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'planning-guards-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const libraryPath = path.join(temp, 'library'); const sourceRoot = path.join(libraryPath, 'raw', 'sources'); await mkdir(sourceRoot, { recursive: true });
  const identity = 'chapter.MD'; const file = path.join(sourceRoot, identity);
  const content = '# 第03章\n这里是一份讨论索引校验与失败恢复的真实材料，章节中的内容需要完整分析与复用。';
  await writeFile(file, content);
  const configPath = path.join(temp, 'app-state.json'); await writeFile(configPath, JSON.stringify({ llmConfig: { provider: 'custom', model: 'test', customEndpoint: 'https://example.invalid/v1' } }));
  const input = { sourceRoot, identity, libraryPath, configPath };
  let mode = 'good', calls = 0;
  const generate = async (_, req) => { calls++; if (mode === 'mutate') await writeFile(file, content + '并发变化'); return { title: '第03章 索引', summary: '索引校验', evidence: [mode === 'fake' ? '原文没有的证据' : req.content.slice(0, 10)], uncertain: false }; };
  await assert.rejects(createPlanningService({ generate, stateDirectory: path.join(libraryPath, '.organizer') }).analyze(input), /知识库之外/);
  assert.equal(calls, 0);
  const planner = createPlanningService({ generate, stateDirectory: path.join(temp, 'state') });
  mode = 'fake'; await assert.rejects(planner.analyze(input), /原文证据/);
  mode = 'mutate'; await assert.rejects(planner.analyze(input), /源文件变化/);
  mode = 'good'; await writeFile(file, content);
  const analyzed = await planner.analyze(input); assert.equal(analyzed.suggestion, '第03章 索引.MD');
  await assert.rejects(planner.confirm({ ...input, name: '非法/name.MD' }), /Windows/);
  await assert.rejects(planner.confirm({ ...input, name: '索引.txt' }), /Windows/);
  await planner.confirm({ ...input, name: '第03章 已确认.MD' });
  await writeFile(file, content + '新增后文讨论归档分类。'); const before = calls;
  const updated = await planner.analyze(input); assert.ok(calls > before); assert.ok(updated.segments.length); assert.equal(updated.confirmedName, '第03章 已确认.MD'); assert.equal(updated.suggestion, null);
  await assert.rejects(planner.confirm({ ...input, name: '新名字.MD' }), /默认固定/);
});

test('模型证据首次不精确时强化逐字符约束并只重试一次', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'planning-evidence-retry-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const sourceRoot = path.join(temp, 'sources'); await mkdir(sourceRoot);
  const identity = '缓存一致性.md'; const content = '这份材料讨论缓存与数据库之间的一致性校验，并保留可逐字符核对的失败恢复依据。';
  await writeFile(path.join(sourceRoot, identity), content);
  const configPath = path.join(temp, 'app-state.json'); await writeFile(configPath, JSON.stringify({ llmConfig: { provider: 'custom', model: 'test', customEndpoint: 'https://example.invalid/v1' } }));
  const requests = [];
  const generate = async (_, request) => {
    requests.push(request);
    if (!request.evidenceRequirement) return { title: '缓存一致性', summary: '第一次把证据改写了', evidence: ['原文中不存在的改写证据'], uncertain: false };
    return { title: '缓存一致性', summary: '第二次保留精确证据', evidence: [request.content.slice(0, 12)], uncertain: false };
  };
  const result = await createPlanningService({ generate, stateDirectory: path.join(temp, 'state') }).analyze({ sourceRoot, libraryPath: sourceRoot, configPath, identity });
  assert.equal(requests.length, 2);
  assert.match(requests[1].evidenceRequirement, /连续.*逐字符/);
  assert.equal(result.analysis.summary, '第二次保留精确证据');
});
