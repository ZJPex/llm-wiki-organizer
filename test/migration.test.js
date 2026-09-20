import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createBackup } from '../src/backup.js';
import { digest, inventory, preflight } from '../src/compatibility.js';
import { createMigrationService } from '../src/migration.js';
import { modelGuard, nativeRescanVerifier, UPSTREAM_COMMIT } from '../src/migration-verifier.js';
import { summaryCandidates } from '../src/source-format.js';
import { createApp } from '../src/server.mjs';
const execute = promisify(execFile);
const quiet = async () => ({ upstreamCommit: UPSTREAM_COMMIT, result: { changedTasks: [], queue: { version: 1, tasks: [] } }, events: [] });

export { migrationFixture } from './helpers/migration-fixture.js';
import { migrationFixture } from './helpers/migration-fixture.js';

test('HTTP 审核后仅迁移验证副本，同步 sources／摘要／缓存／快照，保留正文和无关任务', async t => {
  const f = await migrationFixture(t);
  const service = createMigrationService({ verify: quiet });
  const app = createApp({ migration: service }); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  assert.match(await (await fetch(`${base}/migration`)).text(), /name="oldPath"/);
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const call = async (action, input) => (await fetch(`${base}/api/migration/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organizer-Token': token }, body: JSON.stringify(input) })).json();
  const plan = await call('plan', f.input);
  assert.equal(plan.status, 'awaiting-review');
  assert.equal((await call('execute', { planId: plan.planId })).code, 'REVIEW_REQUIRED');
  const result = await call('execute', { planId: plan.planId, approved: true, writersPaused: true });
  assert.equal(result.status, 'complete', JSON.stringify(result.error));
  assert.deepEqual(result.modelAttempts, []);
  assert.equal(result.originalExecutionAllowed, false);
  assert.equal((await inventory(f.backup.originalPath)).hash, f.backup.baseline.hash);
  assert.equal((await inventory(f.backup.backupPath)).hash, f.backup.baseline.hash);
  const cache = JSON.parse(await readFile(path.join(f.backup.validationPath, '.llm-wiki/ingest-cache.json'), 'utf8'));
  assert.equal(cache.entries['old.md'], undefined); assert.equal(cache.entries['主题/new.md'].timestamp, 123);
  const content = await readFile(path.join(f.backup.validationPath, 'wiki/concept.md'), 'utf8');
  assert.match(content, /sources: \["主题\/new.md"\]/); assert.ok(content.endsWith('保持知识正文。'));
  const tasks = JSON.parse(await readFile(path.join(f.backup.validationPath, '.llm-wiki/ingest-queue.json'), 'utf8'));
  assert.equal(tasks[0].sourcePath, f.input.newPath); assert.equal(tasks[1].sourcePath, 'raw/sources/unrelated.txt');
  await assert.rejects(lstat(path.join(f.backup.validationPath, f.input.oldPath)), { code: 'ENOENT' });
});

test('旧版摘要候选由真实规则定位且改为新 canonical', async t => {
  const f = await migrationFixture(t, { oldIdentity: '课程/章节.md' });
  const service = createMigrationService({ verify: quiet });
  const plan = await service.plan(f.input);
  assert.equal(plan.summaryMapping.oldPath, f.summary);
  assert.equal((await service.execute({ planId: plan.planId, approved: true, writersPaused: true })).status, 'complete');
});

test('目标存在、非法路径和源变化拒绝；不覆盖或执行陈旧方案', async t => {
  const f = await migrationFixture(t);
  const service = createMigrationService({ verify: quiet });
  for (const newPath of ['raw/sources/../x.md', 'raw/sources/CON.md', '/tmp/x.md', 'raw/sources/bad?.md']) await assert.rejects(service.plan({ ...f.input, newPath }), { code: 'INVALID_MAPPING' });
  const plan = await service.plan(f.input);
  await writeFile(path.join(f.backup.validationPath, f.input.oldPath), '新增修改');
  await assert.rejects(service.execute({ planId: plan.planId, approved: true, writersPaused: true }));
  assert.equal(await readFile(path.join(f.backup.validationPath, f.input.oldPath), 'utf8'), '新增修改');
});

test('缺失验证器、中途故障和被捕获模型尝试均不会报成功', async t => {
  const f = await migrationFixture(t);
  const unavailable = createMigrationService({ verify: nativeRescanVerifier('') });
  const unavailablePlan = await unavailable.plan(f.input);
  const unavailableResult = await unavailable.execute({ planId: unavailablePlan.planId, approved: true, writersPaused: true });
  assert.equal(unavailableResult.error.code, 'VERIFIER_UNAVAILABLE');
  assert.equal((await inventory(f.backup.validationPath)).hash, f.backup.validationBaseline.hash);
  const service = createMigrationService({ verify: async ({ models }) => { await models.embed().catch(() => {}); return quiet(); } });
  const plan = await service.plan(f.input);
  const failed = await service.execute({ planId: plan.planId, approved: true, writersPaused: true });
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'MODEL_ATTEMPT'); assert.equal(failed.modelAttempts.length, 1);
  const failureService = createMigrationService({ verify: quiet, checkpoint: async () => { throw new Error('注入写入故障'); } });
  const next = await failureService.plan(f.input);
  const failure = await failureService.execute({ planId: next.planId, approved: true, writersPaused: true });
  assert.equal(failure.status, 'failed');
  const journal = JSON.parse(await readFile(failure.journalPath, 'utf8'));
  assert.ok(journal.preimages.length); assert.ok(journal.completed.length);
  assert.equal((await inventory(f.backup.originalPath)).hash, f.backup.baseline.hash);
});

test('模型守卫分别记录生成、视觉与嵌入出口', async () => {
  const guard = modelGuard();
  for (const name of ['generate','vision','embed']) await assert.rejects(guard[name]());
  assert.deepEqual(guard.attempts.map(x => x.kind), ['generation','vision','embedding']);
});

test('链接、共享产出、向量索引和已有目标均明确拒绝', async t => {
  const cases = [
    ['UNSUPPORTED_LINKS', async ({ write }) => write('wiki/concept.md', '---\nsources: ["old.md"]\nrelated: <a href="old.md">link</a>\n---\n正文')],
    ['SHARED_OUTPUT', async ({ write, summary }) => write('.llm-wiki/ingest-cache.json', { entries: { 'old.md': { hash: digest('# 已摄取的短源'), timestamp: 1, filesWritten: [summary, 'wiki/concept.md'] }, 'other.md': { hash: digest('other'), timestamp: 1, filesWritten: ['wiki/concept.md'] } } })],
    ['UNSUPPORTED_INDEX', async ({ libraryPath }) => { await mkdir(path.join(libraryPath, '.llm-wiki/lancedb')); await writeFile(path.join(libraryPath, '.llm-wiki/lancedb/index'), 'binary'); }],
    ['TARGET_EXISTS', async ({ write }) => write('raw/sources/existing.md', '已有目标')],
  ];
  for (const [code, decorate] of cases) {
    const f = await migrationFixture(t, { decorate });
    const service = createMigrationService({ verify: quiet });
    await assert.rejects(service.plan({ ...f.input, ...(code === 'TARGET_EXISTS' ? { newPath: 'raw/sources/existing.md' } : {}) }), { code });
    assert.equal((await inventory(f.backup.validationPath)).hash, f.backup.validationBaseline.hash);
  }
});

test('真实上游 Rust 重扫验证实际迁移后的短源副本', { skip: !process.env.ORGANIZER_RESCAN_BINARY && process.env.ORGANIZER_TEST_WSL_RESCAN !== '1' }, async t => {
  const f = await migrationFixture(t, { retained: process.env.ORGANIZER_KEEP_PROOF === '1' });
  const verify = process.env.ORGANIZER_RESCAN_BINARY ? nativeRescanVerifier() : async ({ validationPath, projectId }) => {
    const linux = validationPath.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
    const { stdout } = await execute('wsl.exe', ['-d', 'Ubuntu-24.04', '--', '/tmp/organizer-spec-1/rescan-target/debug/organizer-upstream-rescan', '--validation-copy', linux, projectId], { windowsHide: true });
    return JSON.parse(stdout);
  };
  const service = createMigrationService({ verify });
  const plan = await service.plan(f.input);
  const result = await service.execute({ planId: plan.planId, approved: true, writersPaused: true });
  assert.equal(result.status, 'complete', JSON.stringify(result.error));
  assert.deepEqual(result.afterProof.result.changedTasks, []);
  assert.equal(result.afterProof.events.some(event => event.event === 'file-sync://changed'), false);
  if (process.env.ORGANIZER_KEEP_PROOF === '1') console.log(`T3_PROOF=${JSON.stringify({ validationPath: f.backup.validationPath, reportPath: f.backup.reportPath, journalPath: result.journalPath })}`);
});
