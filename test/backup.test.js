import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createApp } from '../src/server.mjs';
import { createBackup, verifyBackup } from '../src/backup.js';
import { digest, inventory, preflight } from '../src/compatibility.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'organizer-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryPath = path.join(root, 'library');
  const wikiSourcePath = path.join(root, 'source');
  for (const dir of ['raw/sources','wiki','.llm-wiki/page-history','.llm-wiki/lancedb','attachments','empty']) await mkdir(path.join(libraryPath, dir), { recursive: true });
  await mkdir(wikiSourcePath);
  await writeFile(path.join(wikiSourcePath, 'package.json'), '{"name":"llm-wiki","version":"0.6.11"}');
  await writeFile(path.join(wikiSourcePath, 'fixture'), 'format');
  const sourceManifest = { version: '0.6.11', commit: 'test', files: { fixture: digest('format') } };
  const inspect = input => preflight(input, { sourceManifest });
  const write = (file, value) => writeFile(path.join(libraryPath, file), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  await write('raw/sources/old.md', '# 历史源');
  await write('wiki/shared.md', '原知识正文');
  await write('attachments/image.png', Buffer.from([0, 1, 2, 255]));
  await write('.llm-wiki/page-history/before.md', '历史正文');
  await write('.llm-wiki/lancedb/index.bin', Buffer.from([88, 1, 0, 55]));
  await write('.llm-wiki/project.json', { id: 'original-project-uuid', createdAt: 1 });
  await write('.llm-wiki/ingest-cache.json', { entries: { 'old.md': { hash: digest('# 历史源'), timestamp: 1, filesWritten: [path.join(libraryPath, 'wiki/shared.md')] } } });
  await write('.llm-wiki/ingest-queue.json', [{ projectId: 'original-project-uuid', status: 'failed', sourcePath: 'raw/sources/old.md' }]);
  await write('.llm-wiki/file-change-queue.json', { version: 1, tasks: [] });
  await write('.llm-wiki/file-snapshot.json', { version: 1, updatedAt: 1, files: {} });
  const input = { libraryPath, wikiSourcePath, backupPath: path.join(root, 'backup'), validationPath: path.join(root, 'validation'), writersPaused: true };
  const run = (override = {}, deps = {}) => createBackup({ ...input, ...override }, { inspect, ...deps });
  return { root, input, run, inspect, write };
}

test('页面入口创建完整备份和独立重定位副本，源和备份字节不变', async t => {
  const f = await fixture(t);
  const before = await inventory(f.input.libraryPath);
  const app = createApp({ backup: input => createBackup(input, { inspect: f.inspect }) });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  assert.match(await (await fetch(`${base}/backup`)).text(), /name="backupPath"/);
  assert.match(await (await fetch(`${base}/backup.js`)).text(), /\/api\/backup/);
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const report = await (await fetch(`${base}/api/backup`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organizer-Token': token }, body: JSON.stringify(f.input) })).json();
  assert.equal(report.status, 'complete', JSON.stringify(report.errors));
  assert.equal(report.migrationAllowed, false);
  assert.equal(report.relocation.runtimeValidated, false);
  assert.deepEqual(await inventory(f.input.backupPath), before);
  assert.equal((await lstat(path.join(f.input.backupPath, 'empty'))).isDirectory(), true);
  const identity = JSON.parse(await readFile(path.join(f.input.validationPath, '.llm-wiki/project.json'), 'utf8'));
  assert.notEqual(identity.id, 'original-project-uuid');
  const cache = JSON.parse(await readFile(path.join(f.input.validationPath, '.llm-wiki/ingest-cache.json'), 'utf8'));
  assert.ok(cache.entries['old.md'].filesWritten[0].startsWith((await realpath(f.input.validationPath)).replaceAll('\\', '/')));
  await writeFile(path.join(f.input.validationPath, 'wiki/shared.md'), '副本独立写入');
  assert.deepEqual(await inventory(f.input.libraryPath), before);
  assert.deepEqual(await inventory(f.input.backupPath), before);
  assert.equal(JSON.parse(await readFile(report.reportPath, 'utf8')).batchId, report.batchId);
});

test('目标重叠或存在不会覆盖原文件', async t => {
  const f = await fixture(t);
  assert.equal((await f.run({ backupPath: path.join(f.input.libraryPath, 'nested') })).errors[0].code, 'OVERLAPPING_PATHS');
  assert.equal((await f.run({ validationPath: f.input.backupPath })).errors[0].code, 'OVERLAPPING_PATHS');
  await mkdir(f.input.backupPath);
  await writeFile(path.join(f.input.backupPath, 'keep'), '保留');
  assert.equal((await f.run()).errors[0].code, 'DESTINATION_EXISTS');
  assert.equal(await readFile(path.join(f.input.backupPath, 'keep'), 'utf8'), '保留');
});

test('未暂停、摄取任务和数据库日志阻止复制', async t => {
  const f = await fixture(t);
  assert.equal((await f.run({ writersPaused: false })).errors[0].code, 'WRITERS_NOT_PAUSED');
  await f.write('.llm-wiki/ingest-queue.json', [{ status: 'processing' }]);
  assert.equal((await f.run()).errors[0].code, 'PREFLIGHT_BLOCKED');
  await f.write('.llm-wiki/ingest-queue.json', []);
  await f.write('.llm-wiki/index.db-wal', '未收尾');
  assert.equal((await f.run()).errors[0].code, 'DATABASE_BUSY');
  await assert.rejects(lstat(f.input.backupPath), { code: 'ENOENT' });
});

test('空间不足发生于任何目标复制之前', async t => {
  const f = await fixture(t);
  const report = await f.run({}, { space: async () => ({ bsize: 1, bavail: 0 }) });
  assert.equal(report.errors[0].code, 'INSUFFICIENT_SPACE');
  await assert.rejects(lstat(f.input.backupPath), { code: 'ENOENT' });
});

test('复制中断可追踪，源库未变，失败现场不清理', async t => {
  const f = await fixture(t);
  const before = await inventory(f.input.libraryPath);
  let calls = 0;
  const report = await f.run({}, { copy: async (...args) => { if (++calls === 2) throw Object.assign(new Error('模拟中断'), { code: 'EIO' }); await copyFile(...args); } });
  assert.equal(report.status, 'failed'); assert.equal(report.phase, 'backup');
  assert.equal(report.backupVerified, false);
  assert.deepEqual(await inventory(f.input.libraryPath), before);
  assert.equal(JSON.parse(await readFile(report.reportPath, 'utf8')).status, 'failed');
  assert.equal((await lstat(f.input.backupPath)).isDirectory(), true);
});

test('缺失或损坏复制拒绝校验，保留源文件', async t => {
  const f = await fixture(t);
  const before = await inventory(f.input.libraryPath);
  const report = await f.run({}, { copy: async (from, to) => writeFile(to, '损坏') });
  assert.equal(report.errors[0].code, 'HASH_MISMATCH');
  assert.deepEqual(await inventory(f.input.libraryPath), before);
  await assert.rejects(verifyBackup(f.input.backupPath, before), { code: 'HASH_MISMATCH' });
});

test('原库并发变化使已复制结果失效', async t => {
  const f = await fixture(t);
  const report = await f.run({}, { checkpoint: async phase => { if (phase === 'backup-copied') await f.write('raw/sources/old.md', '外部新增修改'); } });
  assert.equal(report.errors[0].code, 'ORIGINAL_CHANGED');
  assert.equal(report.validationVerified, false);
  assert.equal(await readFile(path.join(f.input.libraryPath, 'raw/sources/old.md'), 'utf8'), '外部新增修改');
});

test('未知状态绝对路径拒绝启用副本，完整备份仍保留', async t => {
  const f = await fixture(t);
  await f.write('.llm-wiki/unknown.json', { writeTarget: f.input.libraryPath });
  const before = await inventory(f.input.libraryPath);
  const report = await f.run();
  assert.equal(report.errors[0].code, 'UNKNOWN_RELOCATION');
  assert.equal(report.backupVerified, true); assert.equal(report.validationVerified, false);
  assert.deepEqual(await inventory(f.input.backupPath), before);
});

test('目录连接祖先与硬链接文件均被拒绝', async t => {
  const f = await fixture(t);
  const alias = path.join(f.root, 'alias');
  await symlink(f.input.libraryPath, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.run({ libraryPath: alias })).errors[0].code, 'LINK_PATH');
  await link(path.join(f.input.libraryPath, 'wiki/shared.md'), path.join(f.input.libraryPath, 'wiki/hardlink.md'));
  assert.equal((await f.run()).errors[0].code, 'LINK_DATA');
});
