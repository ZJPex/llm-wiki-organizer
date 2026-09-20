import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createBackup } from '../../src/backup.js';
import { digest, inventory, preflight } from '../../src/compatibility.js';
import { UPSTREAM_COMMIT } from '../../src/migration-verifier.js';
import { summaryCandidates } from '../../src/source-format.js';
export async function migrationFixture(t, { oldIdentity = 'old.md', retained = false, decorate = async () => {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'organizer-migration-'));
  if (!retained) t.after(() => rm(root, { recursive: true, force: true }));
  const libraryPath = path.join(root, 'library');
  const wikiSourcePath = path.join(root, 'upstream');
  for (const dir of ['raw/sources', 'wiki/sources', '.llm-wiki']) await mkdir(path.join(libraryPath, dir), { recursive: true });
  await mkdir(path.dirname(path.join(libraryPath, 'raw/sources', oldIdentity)), { recursive: true });
  await mkdir(wikiSourcePath);
  await writeFile(path.join(wikiSourcePath, 'package.json'), '{"name":"llm-wiki","version":"0.6.11"}');
  await writeFile(path.join(wikiSourcePath, 'fixture'), 'verified-test-format');
  const sourceManifest = { version: '0.6.11', commit: UPSTREAM_COMMIT, files: { fixture: digest('verified-test-format') } };
  const inspect = input => preflight(input, { sourceManifest });
  const write = async (file, data) => writeFile(path.join(libraryPath, file), typeof data === 'string' ? data : JSON.stringify(data));
  const oldPath = `raw/sources/${oldIdentity}`;
  const summary = `wiki/sources/${summaryCandidates(oldIdentity).at(-1)}.md`;
  await write(oldPath, '# 已摄取的短源');
  await write(summary, `---\nsources: ["${oldIdentity}"]\ntitle: 原摘要\n---\n保持摘要正文。`);
  await write('wiki/concept.md', `---\nsources:\n  - "${oldIdentity}"\ntitle: 概念\n---\n保持知识正文。`);
  await write('.llm-wiki/project.json', { id: 'original-uuid', createdAt: 1 });
  await write('.llm-wiki/ingest-cache.json', { entries: { [oldIdentity]: { hash: digest('# 已摄取的短源'), timestamp: 123, filesWritten: [summary, 'wiki/concept.md'] } } });
  await write('.llm-wiki/ingest-queue.json', [{ projectId: 'original-uuid', sourcePath: oldPath, status: 'failed' }, { projectId: 'original-uuid', sourcePath: 'raw/sources/unrelated.txt', status: 'cancelled' }]);
  await write('.llm-wiki/file-change-queue.json', { version: 1, tasks: [] });
  await decorate({ write, libraryPath, summary });
  const files = {};
  for (const file of (await inventory(libraryPath)).files.filter(file => /\.md$/i.test(file.path)).map(file => file.path)) {
    const data = await readFile(path.join(libraryPath, file)); const stat = await lstat(path.join(libraryPath, file));
    files[file] = { hash: createHash('md5').update(data).digest('hex'), size: data.length, mtimeMs: Math.trunc(stat.mtimeMs) };
  }
  await write('.llm-wiki/file-snapshot.json', { version: 1, updatedAt: 1, files });
  const backupInput = { libraryPath, wikiSourcePath, backupPath: path.join(root, 'backup'), validationPath: path.join(root, 'validation'), writersPaused: true };
  const backup = await createBackup(backupInput, { inspect });
  assert.equal(backup.status, 'complete', JSON.stringify(backup.errors));
  const input = { reportPath: backup.reportPath, oldPath, newPath: 'raw/sources/主题/new.md', writersPaused: true };
  return { root, backup, input, oldIdentity, summary };
}
