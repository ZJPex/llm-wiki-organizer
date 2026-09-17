import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { migrationFixture } from './helpers/migration-fixture.js';
import { createMigrationService } from '../src/migration.js';
import { createApp } from '../src/server.mjs';
import { digest, inventory } from '../src/compatibility.js';
import { nativeRescanVerifier, UPSTREAM_COMMIT } from '../src/migration-verifier.js';
const execute = promisify(execFile);
const quiet = async () => ({ upstreamCommit: UPSTREAM_COMMIT, result: { changedTasks: [], queue: { version: 1, tasks: [] } }, events: [] });

async function fixture(t) {
  return migrationFixture(t, { oldIdentity: 'course/ch1.md', decorate: async ({ write, libraryPath, summary }) => {
    await mkdir(path.join(libraryPath, 'raw/images'), { recursive: true });
    await write('raw/images/one (1).png', 'image bytes');
    const content = '# 第1章\r\n[同行](../peer.md#标题)\r\n![图片](../../images/one%20%281%29.png)\r\n[外部](C:/code/project.md)\r\n[旧失效](missing.md)\r\n`[[course/ch1]]`\r\n';
    await write('raw/sources/course/ch1.md', content);
    await write('raw/sources/peer.md', '同行内容');
    const navigation = '# 导航\n- [[course/ch1#章节|第一章]]\n- [章节](course/ch1.md#章节 "保留标题")\n[引用][chapter]\n[chapter]: course/ch1.md#章节 "引用标题"\n';
    await write('raw/sources/navigation.md', navigation);
    await write('raw/sources/inbox.md', '[[course/ch1#^block|待摄取导航]]');
    await write('wiki/navigation.md', `[源](../raw/sources/course/ch1.md#章节)\n[摘要](../${summary}#概览)\n[旧失效](../gone.md)\n`);
    await write('.llm-wiki/ingest-cache.json', { entries: { 'course/ch1.md': { hash: digest(content), timestamp: 123, filesWritten: [summary, 'wiki/concept.md'] }, 'navigation.md': { hash: digest(navigation), timestamp: 456, filesWritten: [] } } });
  } });
}

test('HTTP 迁移同时等价修复双链、相对图片、引用式与未移动 Raw/Wiki 反链', async t => {
  const f = await fixture(t);
  const migration = createMigrationService({ verify: quiet }); const app = createApp({ migration }); app.listen(0, '127.0.0.1'); await once(app, 'listening'); t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`, { token } = await (await fetch(`${base}/api/session`)).json();
  const call = async (action, input) => { const response = await fetch(`${base}/api/migration/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organizer-Token': token }, body: JSON.stringify(input) }); return response.json(); };
  const plan = await call('plan', { ...f.input, newPath: 'raw/sources/主题/深入/new.md' });
  assert.equal(plan.status, 'awaiting-review', JSON.stringify(plan));
  assert.ok(plan.links.repairs.some(r => r.path === 'raw/sources/navigation.md'));
  assert.ok(plan.links.repairs.some(r => r.path === 'wiki/navigation.md'));
  assert.ok(plan.links.repairs.some(r => r.before.includes('png')));
  assert.deepEqual(plan.links.newlyBroken, []); assert.equal(plan.links.preexistingBroken.length, 2);
  assert.deepEqual(plan.uncachedReferences, ['raw/sources/inbox.md']);
  const result = await call('execute', { planId: plan.planId, writersPaused: true, approved: true }); assert.equal(result.status, 'complete', JSON.stringify(result.error));
  const read = file => readFile(path.join(f.backup.validationPath, file), 'utf8');
  const body = await read('raw/sources/主题/深入/new.md'); assert.match(body, /\.\.\/\.\.\/\.\.\/images\/one%20%281%29.png/); assert.ok(body.includes('[外部](C:/code/project.md)')); assert.ok(body.includes('[旧失效](missing.md)')); assert.ok(body.includes('`[[course/ch1]]`')); assert.ok(body.startsWith('# 第1章\r\n'));
  const navigation = await read('raw/sources/navigation.md'); assert.ok(navigation.includes('[[raw/sources/主题/深入/new#章节|第一章]]')); assert.ok(navigation.includes('#章节 "保留标题")')); assert.ok(navigation.includes('#章节 "引用标题"'));
  const cache = JSON.parse(await read('.llm-wiki/ingest-cache.json'));
  assert.equal(cache.entries['主题/深入/new.md'].hash, digest(body)); assert.equal(cache.entries['navigation.md'].hash, digest(navigation)); assert.equal(cache.entries['navigation.md'].timestamp, 456); assert.equal(cache.entries['inbox.md'], undefined);
  const snapshot = JSON.parse(await read('.llm-wiki/file-snapshot.json'));
  for (const file of ['raw/sources/主题/深入/new.md', 'raw/sources/navigation.md', 'raw/sources/inbox.md', 'wiki/navigation.md']) assert.equal(snapshot.files[file].hash, createHash('md5').update(await read(file)).digest('hex'));
  assert.equal((await inventory(f.backup.originalPath)).hash, f.backup.baseline.hash); assert.equal((await inventory(f.backup.backupPath)).hash, f.backup.baseline.hash);
});

test('同名目标歧义阻止依赖迁移，不猜测或覆盖；代码示例不作为链接', async t => {
  const f = await migrationFixture(t, { oldIdentity: 'one/a.md', decorate: async ({ write, libraryPath }) => { await mkdir(path.join(libraryPath, 'raw/sources/two')); await write('raw/sources/two/a.md', '另一材料'); await write('raw/sources/nav.md', '[[a#章|同名]]'); } });
  const service = createMigrationService({ verify: quiet }); await assert.rejects(service.plan(f.input), { code: 'AMBIGUOUS_LINK' }); assert.equal((await inventory(f.backup.validationPath)).hash, f.backup.validationBaseline.hash);
});

test('真实 Rust 重扫链接修复后的迁移副本，没有新增摄取任务', { skip: !process.env.ORGANIZER_RESCAN_BINARY && process.env.ORGANIZER_TEST_WSL_RESCAN !== '1' }, async t => {
  const f = await fixture(t);
  const verify = process.env.ORGANIZER_RESCAN_BINARY ? nativeRescanVerifier() : async ({ validationPath, projectId }) => {
    const linux = validationPath.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
    const { stdout } = await execute('wsl.exe', ['-d', 'Ubuntu-24.04', '--', '/tmp/organizer-spec-1/rescan-target/debug/organizer-upstream-rescan', '--validation-copy', linux, projectId], { windowsHide: true }); return JSON.parse(stdout);
  };
  const service = createMigrationService({ verify }); const plan = await service.plan({ ...f.input, newPath: 'raw/sources/主题/深入/new.md' }); const result = await service.execute({ planId: plan.planId, approved: true, writersPaused: true });
  assert.equal(result.status, 'complete', JSON.stringify(result.error)); assert.deepEqual(result.afterProof.result.changedTasks, []); assert.deepEqual(result.modelAttempts, []);
});
