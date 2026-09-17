import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/server.mjs';
import { preflight, inventory, digest } from '../src/compatibility.js';

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'organizer-t1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryPath = path.join(root, 'library');
  const wikiSourcePath = path.join(root, 'source');
  for (const dir of ['raw/sources/topic', 'wiki', '.llm-wiki']) await mkdir(path.join(libraryPath, dir), { recursive: true });
  await mkdir(wikiSourcePath);
  await writeFile(path.join(wikiSourcePath, 'package.json'), JSON.stringify({ name: 'llm-wiki', version: '0.6.11' }));
  await writeFile(path.join(wikiSourcePath, 'fixture.ts'), '源码指纹测试替身\n第二行\n');
  const sourceManifest = { version: '0.6.11', commit: 'test-only', files: { 'fixture.ts': digest('源码指纹测试替身\n第二行\n') } };
  const write = (file, value) => writeFile(path.join(libraryPath, file), typeof value === 'string' ? value : JSON.stringify(value));
  await write('raw/sources/录屏_1920.md', '# 保留的历史材料');
  await write('raw/sources/topic/new.md', '# 新材料');
  await write('wiki/shared.md', '既有知识正文');
  await write('.llm-wiki/ingest-cache.json', { entries: { '录屏_1920.md': { hash: digest('# 保留的历史材料'), timestamp: 1, filesWritten: ['wiki/shared.md'] } } });
  await write('.llm-wiki/file-snapshot.json', { version: 1, updatedAt: 1, files: {} });
  await write('.llm-wiki/file-change-queue.json', { version: 1, tasks: [] });
  await write('.llm-wiki/ingest-queue.json', []);
  await write('.llm-wiki/private-config.json', { apiKey: 'SECRET-DO-NOT-DISPLAY' });
  const app = createApp({ inspect: input => preflight(input, { sourceManifest }) });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const request = async (override = {}) => (await fetch(`${base}/api/preflight`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organizer-Token': token }, body: JSON.stringify({ libraryPath, wikiSourcePath, writersPaused: true, ...override }) })).json();
  return { libraryPath, wikiSourcePath, request, base, write };
}

test('页面表单到预检入口：真实缓存结构识别根目录历史源并保存只读基线', async t => {
  const f = await setup(t);
  const page = await (await fetch(f.base)).text();
  assert.match(page, /name="libraryPath"/); assert.match(page, /\/app.js/);
  assert.match(await (await fetch(`${f.base}/app.js`)).text(), /\/api\/preflight/);
  const before = await inventory(f.libraryPath);
  const report = await f.request();
  assert.equal(report.markdownCount, 2); assert.equal(report.ingestedCount, 1);
  assert.equal(report.sources.find(s => s.identity === '录屏_1920.md').status, 'ingested');
  assert.equal(report.version.verifiedSource, true);
  assert.deepEqual(report.blockers.map(b => b.code), ['MIGRATION_UNVERIFIED']);
  assert.equal(report.canMigrate, false);
  assert.equal(JSON.stringify(report).includes('SECRET-DO-NOT-DISPLAY'), false);
  assert.deepEqual(await inventory(f.libraryPath), before);
  assert.equal(report.baseline.hash, before.hash);
});

test('无效目录、缺失状态和未知版本明确阻塞', async t => {
  const f = await setup(t);
  assert.ok((await f.request({ libraryPath: path.join(f.libraryPath, 'absent') })).blockers.some(b => b.code === 'INVALID_LIBRARY'));
  await rm(path.join(f.libraryPath, '.llm-wiki/ingest-cache.json'));
  const missing = await f.request();
  assert.ok(missing.blockers.some(b => b.code === 'MISSING_STATE'));
  assert.ok(missing.sources.every(s => s.status === 'unknown'));
  await writeFile(path.join(f.wikiSourcePath, 'package.json'), '{"name":"llm-wiki","version":"9.9.9"}');
  assert.ok((await f.request()).blockers.some(b => b.code === 'UNKNOWN_VERSION'));
});

test('缺失关联、忙碌与未暂停写入不被误报成功', async t => {
  const f = await setup(t);
  await rm(path.join(f.libraryPath, 'wiki/shared.md'));
  await f.write('.llm-wiki/ingest-queue.json', [{ status: 'processing' }]);
  const report = await f.request({ writersPaused: false });
  for (const code of ['MISSING_ASSOCIATION','BUSY','WRITERS_NOT_PAUSED']) assert.ok(report.blockers.some(b => b.code === code));
});

test('跨站请求和无会话请求无法访问本地路径', async t => {
  const f = await setup(t);
  assert.equal((await fetch(`${f.base}/api/preflight`, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(`${f.base}/api/session`, { headers: { Origin: 'https://example.com' } })).status, 403);
});

test('相同源码的 LF 与 CRLF 检出共享版本指纹，内容变化仍被拒绝', async t => {
  const f = await setup(t);
  assert.equal((await f.request()).version.verifiedSource, true);
  await writeFile(path.join(f.wikiSourcePath, 'fixture.ts'), '源码指纹测试替身\r\n第二行\r\n');
  assert.equal((await f.request()).version.verifiedSource, true);
  await writeFile(path.join(f.wikiSourcePath, 'fixture.ts'), '源码指纹测试替身\n改变第二行\n');
  assert.equal((await f.request()).version.verifiedSource, false);
});
