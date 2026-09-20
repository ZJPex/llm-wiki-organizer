import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalPath } from './filesystem-paths.js';

export const digest = data => createHash('sha256').update(data).digest('hex');
const manifest = JSON.parse(await readFile(new URL('./upstream-manifest.json', import.meta.url), 'utf8'));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// 拒绝符号链接及目录连接，避免扫描跳出用户选择的知识库。
export async function inventory(root) {
  const files = [];
  async function walk(relative) {
    const full = path.join(root, relative);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) throw new Error('知识库包含符号链接或目录连接，无法建立安全基线');
    if (stat.isDirectory()) {
      for (const name of (await readdir(full)).sort()) await walk(path.join(relative, name));
    } else if (stat.isFile()) {
      const data = await readFile(full);
      files.push({ path: relative.split(path.sep).join('/'), size: data.length, hash: digest(data) });
    } else throw new Error('知识库包含不支持的特殊文件');
  }
  await walk('');
  return { files, hash: digest(JSON.stringify(files)) };
}

export async function preflight({ libraryPath, wikiSourcePath, writersPaused = false } = {}, { sourceManifest = manifest } = {}) {
  const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), blockers: [], sources: [],
    version: { detected: null, supported: ['0.6.11'], verifiedSource: false, libraryVersion: 'unknown', migrationVerified: false },
    associations: {}, baseline: null, canMigrate: false };
  const block = (code, message) => report.blockers.push({ code, message });
  try {
    if (typeof libraryPath !== 'string' || !path.isAbsolute(libraryPath)) throw new Error('请选择知识库绝对路径');
    if ((await lstat(libraryPath)).isSymbolicLink()) throw new Error('知识库根目录不能是目录连接');
    report.libraryPath = await realpath(libraryPath);
    if (!(await lstat(report.libraryPath)).isDirectory()) throw new Error('知识库路径不是目录');
    const first = await inventory(report.libraryPath);
    const byPath = new Map(first.files.map(file => [file.path, file]));
    for (const dir of ['raw/sources', 'wiki', '.llm-wiki']) {
      if (!(await lstat(path.join(report.libraryPath, dir)).catch(() => null))?.isDirectory()) block('INVALID_LIBRARY', `缺少知识库目录：${dir}`);
    }
    try {
      const pkg = JSON.parse(await readFile(path.join(wikiSourcePath, 'package.json'), 'utf8'));
      report.version.detected = pkg.version;
      if (pkg.name !== 'llm-wiki' || pkg.version !== sourceManifest.version) throw new Error();
      for (const [file, hash] of Object.entries(sourceManifest.files)) {
        if (digest((await readFile(path.join(wikiSourcePath, file), 'utf8')).replace(/\r\n/g, '\n')) !== hash) throw new Error();
      }
      report.version.verifiedSource = true;
      report.version.sourceCommit = sourceManifest.commit;
    } catch { block('UNKNOWN_VERSION', 'Wiki 源码版本未知或格式指纹不匹配；仅支持已核验的 0.6.11 源码格式'); }
    async function state(name, validate) {
      try {
        const value = JSON.parse(await readFile(path.join(report.libraryPath, '.llm-wiki', name), 'utf8'));
        if (!validate(value)) throw new Error();
        return value;
      } catch { block('MISSING_STATE', `关联状态缺失或格式无效：${name}`); return null; }
    }
    const cache = await state('ingest-cache.json', x => object(x) && object(x.entries) && Object.values(x.entries).every(e => object(e) && /^[a-f0-9]{64}$/i.test(e.hash) && Number.isFinite(e.timestamp) && Array.isArray(e.filesWritten) && e.filesWritten.every(f => typeof f === 'string')));
    const queue = await state('ingest-queue.json', x => Array.isArray(x) && x.every(t => object(t) && ['pending','processing','done','failed','cancelled'].includes(t.status)));
    const snapshot = await state('file-snapshot.json', x => object(x) && x.version === 1 && object(x.files));
    const changes = await state('file-change-queue.json', x => object(x) && x.version === 1 && Array.isArray(x.tasks) && x.tasks.every(t => object(t) && ['pending','processing','done','failed','superseded'].includes(t.status)));
    report.associations = { cacheEntries: cache ? Object.keys(cache.entries).length : null, snapshotFiles: snapshot ? Object.keys(snapshot.files).length : null,
      ingestTasks: queue?.length ?? null, changeTasks: changes?.tasks.length ?? null, wikiFiles: first.files.filter(f => f.path.startsWith('wiki/')).length };
    if ([...(queue ?? []), ...(changes?.tasks ?? [])].some(t => ['pending','processing'].includes(t.status))) block('BUSY', '存在等待或正在处理的摄取／文件变更任务');
    if (!writersPaused) block('WRITERS_NOT_PAUSED', '尚未确认 Wiki、Obsidian 和同步程序等写入已暂停；磁盘状态不能证明进程空闲');
    for (const file of first.files.filter(f => f.path.startsWith('raw/sources/') && /\.md$/i.test(f.path))) {
      const identity = file.path.slice('raw/sources/'.length);
      const entry = cache?.entries[identity];
      let status = cache ? 'new' : 'unknown';
      if (entry) {
        status = 'ingested';
        if (entry.hash !== file.hash) { status = 'changed'; block('SOURCE_CHANGED', `已摄取源内容变化：${identity}`); }
        for (const output of entry.filesWritten) {
          const relative = path.relative(report.libraryPath, await canonicalPath(path.resolve(report.libraryPath, output))).split(path.sep).join('/');
          if (!byPath.has(relative)) { status = 'missing-association'; block('MISSING_ASSOCIATION', `已摄取源缺少库内产出：${identity}`); }
        }
      }
      report.sources.push({ identity, path: file.path, size: file.size, hash: file.hash, status });
    }
    report.markdownCount = report.sources.length;
    report.ingestedCount = report.sources.filter(s => cache?.entries[s.identity]).length;
    const second = await inventory(report.libraryPath);
    if (second.hash !== first.hash) block('BASELINE_CHANGED', '扫描期间知识库发生变化，请暂停写入后重试');
    else report.baseline = { algorithm: 'sha256', ...first };
  } catch (error) { block('INVALID_LIBRARY', ['ENOENT','ENOTDIR','EACCES'].includes(error.code) ? '知识库目录不存在或无法读取' : error.message); }
  block('MIGRATION_UNVERIFIED', '只读预检不代表迁移兼容；库内没有可信应用版本记录，尚未通过隔离副本重启验证');
  return report;
}
