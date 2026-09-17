import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { connect, makeArrowTable } from '@lancedb/lancedb';
import { Schema, Field, Utf8, Uint32, Float32, FixedSizeList } from 'apache-arrow';
import { migrationFixture } from './helpers/migration-fixture.js';
import { createMigrationService } from '../src/migration.js';
import { createApp } from '../src/server.mjs';
import { digest, inventory } from '../src/compatibility.js';
import { categoryCatalog } from '../src/categories.js';
import { freezeEvolution } from '../src/evolution.js';
import { summaryCandidates, sourceFrontmatter } from '../src/source-format.js';
import { UPSTREAM_COMMIT, nativeRescanVerifier } from '../src/migration-verifier.js';
const execute = promisify(execFile);
const quiet = async () => ({ upstreamCommit: UPSTREAM_COMMIT, result: { changedTasks: [], queue: { version: 1, tasks: [] } }, events: [] });

async function batchFixture(t, { indexed = false, retained = false, empty = false, ambiguous = false } = {}) {
  return migrationFixture(t, { retained, decorate: async ({ write, libraryPath }) => {
    const second = empty ? '' : '# 已摄取的短源';
    await write('raw/sources/b.md', second);
    await write('raw/sources/c.md', '独立材料');
    await write('raw/sources/navigation.md', ambiguous ? '[[old]]' : '[[raw/sources/old|第一份]] 与 [另一份](b.md#标题)');
    await write('wiki/sources/b.md', '---\nsources: ["b.md"]\n---\nB摘要正文');
    await write('wiki/sources/c.md', '---\nsources: ["c.md"]\n---\nC摘要正文');
    await write('wiki/concept.md', '---\nsources: ["old.md","b.md"]\n---\n共享知识正文');
    await write('.llm-wiki/ingest-cache.json', { entries: {
      'old.md': { hash: digest('# 已摄取的短源'), timestamp: 1, filesWritten: ['wiki/sources/old.md', 'wiki/concept.md'] },
      'b.md': { hash: digest(second), timestamp: 2, filesWritten: ['wiki/sources/b.md', 'wiki/concept.md', 'wiki/sources/old.md'] },
      'c.md': { hash: digest('独立材料'), timestamp: 3, filesWritten: ['wiki/sources/c.md'] },
    } });
    if (indexed) {
      const vector = new Field('vector', new FixedSizeList(3, new Field('item', new Float32(), true)), false);
      const db = await connect(path.join(libraryPath, '.llm-wiki/lancedb'));
      await db.createTable('wiki_vectors', makeArrowTable([{ page_id: 'old', vector: [1, 0, 0] }, { page_id: 'b', vector: [0, 1, 0] }, { page_id: 'concept', vector: [0, 0, 1] }], { schema: new Schema([new Field('page_id', new Utf8(), false), vector]) }));
      await db.createTable('wiki_chunks_v2', makeArrowTable([{ chunk_id: 'old#0', page_id: 'old', chunk_index: 0, chunk_text: '保持摘要正文。', heading_path: '', vector: [1, 0, 0] }, { chunk_id: 'b#0', page_id: 'b', chunk_index: 0, chunk_text: 'B摘要正文', heading_path: '', vector: [0, 1, 0] }], { schema: new Schema([new Field('chunk_id', new Utf8(), false), new Field('page_id', new Utf8(), false), new Field('chunk_index', new Uint32(), false), new Field('chunk_text', new Utf8(), false), new Field('heading_path', new Utf8(), false), vector]) }));
    }
  } });
}
const swap = [{ id: 'first', from: 'raw/sources/old.md', to: 'raw/sources/b.md' }, { id: 'second', from: 'raw/sources/b.md', to: 'raw/sources/old.md' }];

test('批量交换同内容来源与真实向量ID：一次编译共享缓存/反链，重启服务可执行冻结清单', async t => {
  const f = await batchFixture(t, { indexed: true });
  const firstService = createMigrationService({ verify: quiet });
  const app = createApp({ migration: firstService }); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => new Promise(resolve => app.close(resolve)));
  const url = `http://127.0.0.1:${app.address().port}`;
  assert.match(await (await fetch(`${url}/batch-migration`)).text(), /重新计算并冻结方案/);
  const { token } = await (await fetch(`${url}/api/session`)).json();
  const plan = await (await fetch(`${url}/api/migration/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organizer-Token': token }, body: JSON.stringify({ reportPath: f.backup.reportPath, mappings: swap, writersPaused: true }) })).json();
  assert.equal(plan.items.filter(item => item.status === 'selected').length, 2);
  const manifest = JSON.parse(await readFile(plan.planManifestPath, 'utf8'));
  assert.equal(manifest.logicalPlanHash, plan.logicalPlanHash);
  assert.equal(JSON.stringify(manifest.logicalPlan).includes(f.backup.validationPath), false);
  const result = await createMigrationService({ verify: quiet }).execute({ planId: plan.planId, planManifestPath: plan.planManifestPath, planHash: plan.logicalPlanHash, approved: true, writersPaused: true });
  assert.equal(result.status, 'complete', JSON.stringify(result.error));
  assert.ok(result.items.every(item => item.status === 'succeeded'));
  const cache = JSON.parse(await readFile(path.join(f.backup.validationPath, '.llm-wiki/ingest-cache.json'), 'utf8'));
  assert.equal(cache.entries['b.md'].timestamp, 1); assert.equal(cache.entries['old.md'].timestamp, 2);
  assert.ok(cache.entries['old.md'].filesWritten.includes('wiki/sources/b.md'));
  assert.deepEqual(sourceFrontmatter(await readFile(path.join(f.backup.validationPath, 'wiki/concept.md'), 'utf8')).sources, ['b.md', 'old.md']);
  assert.match(await readFile(path.join(f.backup.validationPath, 'raw/sources/navigation.md'), 'utf8'), /raw\/sources\/b\|第一份/);
  const db = await connect(path.join(f.backup.validationPath, '.llm-wiki/lancedb'));
  for (const name of ['wiki_vectors', 'wiki_chunks_v2']) assert.equal((await (await db.openTable(name)).vectorSearch([1, 0, 0]).limit(1).toArray())[0].page_id, 'b');
  assert.equal((await inventory(f.backup.originalPath)).hash, f.backup.baseline.hash);
  assert.equal((await inventory(f.backup.backupPath)).hash, f.backup.baseline.hash);
});

test('排除占位依赖后仅执行独立安全子集，报告 partial 而非整批成功', async t => {
  const f = await batchFixture(t);
  const service = createMigrationService({ verify: quiet });
  const plan = await service.plan({ reportPath: f.backup.reportPath, mappings: [...swap, { id: 'independent', from: 'raw/sources/c.md', to: 'raw/sources/d.md' }], exclusions: ['second'], writersPaused: true });
  assert.equal(plan.items.find(item => item.id === 'first').reason.code, 'DEPENDENCY_BLOCKED');
  assert.equal(plan.items.find(item => item.id === 'second').status, 'excluded');
  const result = await service.execute({ planId: plan.planId, approved: true, writersPaused: true });
  assert.equal(result.status, 'partial'); assert.equal(result.items.find(item => item.id === 'independent').status, 'succeeded');
  assert.equal(await readFile(path.join(f.backup.validationPath, 'raw/sources/old.md'), 'utf8'), '# 已摄取的短源');
});

test('大小写改名及空源保持身份与结果，阶段中断保留完整 journal/staging', async t => {
  const f = await batchFixture(t, { empty: true });
  const service = createMigrationService({ verify: quiet });
  const plan = await service.plan({ reportPath: f.backup.reportPath, mappings: [{ from: 'raw/sources/b.md', to: 'raw/sources/B.md' }], writersPaused: true });
  assert.equal(plan.status, 'awaiting-review', JSON.stringify(plan.items));
  const result = await service.execute({ planId: plan.planId, approved: true, writersPaused: true });
  assert.equal(result.status, 'complete', JSON.stringify(result.error));
  assert.ok(result.afterBaseline.files.some(file => file.path === 'raw/sources/B.md'));
  assert.equal(await readFile(path.join(f.backup.validationPath, 'raw/sources/B.md'), 'utf8'), '');
  const other = await batchFixture(t);
  const failing = createMigrationService({ verify: quiet, checkpoint: async stage => { if (stage === 'move') throw new Error('模拟中断'); } });
  const failedPlan = await failing.plan({ reportPath: other.backup.reportPath, mappings: swap, writersPaused: true });
  const failed = await failing.execute({ planId: failedPlan.planId, approved: true, writersPaused: true });
  assert.equal(failed.status, 'failed'); assert.ok(failed.items.every(item => item.status !== 'succeeded'));
  const journal = JSON.parse(await readFile(failed.journalPath, 'utf8'));
  assert.ok(journal.intents.length); assert.ok(journal.preimages.length); assert.ok((await lstat(journal.stagingPath)).isDirectory());
  assert.equal(journal.targetRole, 'validation'); assert.equal(journal.planManifestPath, failedPlan.planManifestPath);
});

test('歧义只阻塞受影响映射；修改目标重规划以及清单篡改不会执行旧方案', async t => {
  const f = await batchFixture(t, { ambiguous: true });
  const service = createMigrationService({ verify: quiet });
  const mappings = [{ id: 'ambiguous', from: 'raw/sources/old.md', to: 'raw/sources/new.md' }, { id: 'safe', from: 'raw/sources/c.md', to: 'raw/sources/d.md' }];
  const plan = await service.plan({ reportPath: f.backup.reportPath, mappings, writersPaused: true });
  assert.equal(plan.items.find(item => item.id === 'ambiguous').reason.code, 'AMBIGUOUS_LINK');
  assert.equal(plan.items.find(item => item.id === 'safe').status, 'selected');
  const amended = await service.plan({ reportPath: f.backup.reportPath, mappings: mappings.map(item => item.id === 'safe' ? { ...item, to: 'raw/sources/e.md' } : item), writersPaused: true });
  assert.notEqual(amended.logicalPlanHash, plan.logicalPlanHash);
  await assert.rejects(service.execute({ planId: plan.planId, approved: true, writersPaused: true }), { code: 'STALE_PLAN' });
  const record = JSON.parse(await readFile(amended.planManifestPath, 'utf8')); record.logicalPlan.items[0].to = 'raw/sources/forged.md';
  await writeFile(amended.planManifestPath, JSON.stringify(record));
  await assert.rejects(createMigrationService({ verify: quiet }).execute({ planId: amended.planId, planManifestPath: amended.planManifestPath, approved: true, writersPaused: true }), { code: 'INVALID_PLAN' });
  assert.equal((await inventory(f.backup.validationPath)).hash, f.backup.validationBaseline.hash);
});

test('冻结目录演化填最小空号并同步完整后代前缀，确认文件名不变', async t => {
  const oldIdentity = '001 原主题/001.02 子主题/固定名.md';
  const f = await migrationFixture(t, { oldIdentity, decorate: async ({ libraryPath }) => { for (const dir of ['003 目标', '003 目标/003.01 已有', '003 目标/003.03 其他']) await mkdir(path.join(libraryPath, 'raw/sources', dir), { recursive: true }); } });
  const categoryRoot = path.join(f.backup.originalPath, 'raw/sources');
  const catalog = await categoryCatalog(categoryRoot), baseline = await inventory(categoryRoot);
  const operations = [{ type: 'move', from: '001 原主题', parent: '003 目标', label: '原主题', problem: '归属调整', benefit: '同主题集中查找' }];
  const frozen = freezeEvolution({ catalog, baseline, visited: [] }, operations, { [oldIdentity]: '固定名.md' });
  const service = createMigrationService({ verify: quiet });
  const plan = await service.plan({ reportPath: f.backup.reportPath, evolutionPlan: frozen, writersPaused: true });
  assert.ok(plan.items[0].to.includes('003.02 原主题/003.02.02 子主题/固定名.md'));
  const result = await service.execute({ planId: plan.planId, approved: true, writersPaused: true });
  assert.equal(result.status, 'complete', JSON.stringify(result.error));
  assert.ok((await lstat(path.join(f.backup.validationPath, 'raw/sources/003 目标/003.03 其他'))).isDirectory());
});

test('真实 Rust 重扫批量交换与反链、共享向量迁移后的副本', { skip: !process.env.ORGANIZER_RESCAN_BINARY && process.env.ORGANIZER_TEST_WSL_RESCAN !== '1' }, async t => {
  const f = await batchFixture(t, { indexed: true, retained: process.env.ORGANIZER_KEEP_PROOF === '1' });
  const verify = process.env.ORGANIZER_RESCAN_BINARY ? nativeRescanVerifier() : async ({ validationPath, projectId }) => {
    const linux = validationPath.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
    const { stdout } = await execute('wsl.exe', ['-d', 'Ubuntu-24.04', '--', '/tmp/organizer-spec-1/rescan-target/debug/organizer-upstream-rescan', '--validation-copy', linux, projectId], { windowsHide: true }); return JSON.parse(stdout);
  };
  const service = createMigrationService({ verify });
  const plan = await service.plan({ reportPath: f.backup.reportPath, mappings: swap, writersPaused: true });
  const result = await service.execute({ planId: plan.planId, approved: true, writersPaused: true });
  assert.equal(result.status, 'complete', JSON.stringify(result.error)); assert.deepEqual(result.afterProof.result.changedTasks, []); assert.deepEqual(result.modelAttempts, []);
  if (process.env.ORGANIZER_KEEP_PROOF === '1') console.log(`T6_PROOF=${JSON.stringify({ validationPath: f.backup.validationPath, reportPath: f.backup.reportPath, journalPath: result.journalPath, planManifestPath: plan.planManifestPath })}`);
});
