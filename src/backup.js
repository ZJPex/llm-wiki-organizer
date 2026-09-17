import { access, copyFile, lstat, mkdir, readFile, readdir, realpath, statfs, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inventory, preflight } from './compatibility.js';
import { canonicalPath } from './filesystem-paths.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const normalize = value => value.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
const contains = (parent, child) => normalize(child) === normalize(parent) || normalize(child).startsWith(`${normalize(parent)}/`);

// 沿所有祖先检查连接，realpath 本身会吞掉目录连接信息。
export async function safePath(input, { missingLeaf = false } = {}) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) fail('INVALID_PATH', '所有位置必须使用绝对路径');
  const absolute = path.resolve(input);
  const parts = [];
  for (let current = absolute; ; current = path.dirname(current)) {
    parts.unshift(current);
    if (path.dirname(current) === current) break;
  }
  for (const current of parts) {
    const stat = await lstat(current).catch(error => {
      if (error.code === 'ENOENT' && missingLeaf && current === absolute) return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) fail('LINK_PATH', '路径或祖先包含符号链接／目录连接');
    if (stat && !stat.isDirectory()) fail('INVALID_PATH', '所选位置或祖先不是目录');
  }
  if (missingLeaf) return path.join(await realpath(path.dirname(absolute)), path.basename(absolute));
  return realpath(absolute);
}

export async function layout(root) {
  const directories = [];
  async function scan(relative) {
    const full = path.join(root, relative);
    const stat = await lstat(full);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) fail('LINK_DATA', '知识库包含链接或共享硬链接文件');
    if (stat.isDirectory()) {
      if (relative) directories.push(relative.split(path.sep).join('/'));
      for (const name of (await readdir(full)).sort()) await scan(path.join(relative, name));
    } else if (!stat.isFile()) fail('SPECIAL_FILE', '知识库包含不支持的特殊文件');
  }
  await scan('');
  return directories;
}

export async function verifyBackup(backupPath, expected, expectedDirectories) {
  await safePath(backupPath);
  const actual = await inventory(backupPath);
  if (!expected || actual.hash !== expected.hash) fail('HASH_MISMATCH', '备份清单或内容哈希不一致');
  const directories = await layout(backupPath);
  if (expectedDirectories && JSON.stringify(directories) !== JSON.stringify(expectedDirectories)) fail('DIRECTORY_MISMATCH', '备份目录清单不一致');
  return actual;
}

export async function copyTree(source, destination, baseline, directories, copy = copyFile) {
  for (const dir of directories) await mkdir(path.join(destination, dir), { recursive: true });
  for (const file of baseline.files) {
    const from = path.join(source, file.path);
    const to = path.join(destination, file.path);
    await safePath(path.dirname(from));
    await safePath(path.dirname(to));
    const stat = await lstat(from);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) fail('LINK_DATA', '复制前源文件类型或共享状态发生变化');
    await copy(from, to, constants.COPYFILE_EXCL);
    const target = await lstat(to);
    if (target.nlink !== 1 || (stat.dev === target.dev && stat.ino === target.ino)) fail('SHARED_DATA', '副本与源文件共享可写数据');
  }
  await verifyBackup(destination, baseline, directories);
}

// 仅修改已核验的结构化位置。未知字段中的绝对路径或旧库身份阻止验证副本启用。
export async function relocateValidationCopy(validationPath, originalPath, { originalAliases = [], targetId = randomUUID(), expectedSourceId, prepareOnly = false } = {}) {
  const state = name => path.join(validationPath, '.llm-wiki', name);
  let identity;
  try { identity = JSON.parse(await readFile(state('project.json'), 'utf8')); }
  catch { fail('UNKNOWN_IDENTITY', '缺少可校验的 project.json，不能隔离验证副本身份'); }
  if (typeof identity.id !== 'string' || !identity.id || !Number.isFinite(identity.createdAt)) fail('UNKNOWN_IDENTITY', 'project.json 格式无法安全重定位');
  const oldId = identity.id;
  if (expectedSourceId !== undefined && oldId !== expectedSourceId) fail('UNKNOWN_IDENTITY', '重定位来源身份与冻结证据不符');
  if (typeof targetId !== 'string' || !targetId) fail('UNKNOWN_IDENTITY', '重定位目标身份无效');
  const newId = targetId;
  const changes = [];
  const data = new Map();
  async function load(name) {
    try { const value = JSON.parse(await readFile(state(name), 'utf8')); data.set(`.llm-wiki/${name}`, value); return value; }
    catch { fail('UNKNOWN_STATE', `无法重定位状态：${name}`); }
  }
  data.set('.llm-wiki/project.json', { ...identity, id: newId });
  const cache = await load('ingest-cache.json');
  if (!cache.entries || typeof cache.entries !== 'object' || Array.isArray(cache.entries)) fail('UNKNOWN_STATE', '缓存结构未知');
  for (const entry of Object.values(cache.entries)) {
    if (!Array.isArray(entry.filesWritten)) fail('UNKNOWN_STATE', '缓存产出路径未知');
    entry.filesWritten = await Promise.all(entry.filesWritten.map(async file => {
      if (typeof file !== 'string') fail('UNKNOWN_STATE', '缓存产出路径未知');
      if (path.isAbsolute(file) || path.win32.isAbsolute(file)) {
        const canonical = await canonicalPath(file);
        if (!contains(originalPath, canonical)) fail('EXTERNAL_ASSOCIATION', '缓存产出指向知识库之外');
        return path.join(validationPath, path.relative(originalPath, canonical)).replaceAll('\\', '/');
      }
      if (file.replaceAll('\\', '/').split('/').includes('..')) fail('EXTERNAL_ASSOCIATION', '缓存产出包含父目录跳转');
      return file;
    }));
  }
  const queues = [await load('ingest-queue.json'), (await load('file-change-queue.json')).tasks];
  for (const queue of queues) {
    if (!Array.isArray(queue)) fail('UNKNOWN_STATE', '队列结构未知');
    for (const task of queue) {
      if (['pending', 'processing'].includes(task.status)) fail('BUSY', '副本含待处理任务，禁止启用');
      if (task.projectId !== oldId) fail('UNKNOWN_IDENTITY', '队列任务指向其他知识库身份');
      for (const key of ['sourcePath', 'path']) if (task[key] !== undefined && (typeof task[key] !== 'string' || path.isAbsolute(task[key]) || path.win32.isAbsolute(task[key]) || task[key].replaceAll('\\', '/').split('/').includes('..'))) fail('EXTERNAL_ASSOCIATION', '队列来源不是安全的库内相对路径');
      task.projectId = newId;
    }
  }
  const first = await inventory(validationPath);
  const oldPaths = [originalPath, ...originalAliases].flatMap(root => [root, root.replaceAll('\\', '/'), root.replaceAll('/', '\\')]).flatMap(value => [value, JSON.stringify(value).slice(1, -1)]);
  for (const file of first.files) {
    const transformed = data.has(file.path) ? JSON.stringify(data.get(file.path), null, 2) : null;
    const bytes = transformed === null ? await readFile(path.join(validationPath, file.path)) : Buffer.from(transformed);
    const texts = [bytes.toString('utf8'), bytes.toString('utf16le')];
    if (texts.some(text => oldPaths.filter(root => normalize(root) !== normalize(validationPath)).some(root => text.toLowerCase().includes(root.toLowerCase())) || (newId !== oldId && text.includes(oldId)))) {
      fail('UNKNOWN_RELOCATION', `发现未适配的原库路径或身份引用：${file.path}`);
    }
  }
  if (prepareOnly) return { stateContents: Object.fromEntries([...data].map(([file,value])=>[path.posix.basename(file),Buffer.from(JSON.stringify(value,null,2)).toString('base64')])) };
  for (const [file, value] of data) {
    await writeFile(path.join(validationPath, file), JSON.stringify(value, null, 2));
    changes.push(file);
  }
  return { originalProjectId: oldId, validationProjectId: newId, changedFiles: changes,
    runtimeValidated: false, requiresIsolatedRuntime: true };
}

/** 完整离线备份；注入点仅供程序测试，不能由 HTTP JSON 提供。 */
export async function createBackup(input, { inspect = preflight, copy = copyFile, space = statfs, checkpoint = async () => {} } = {}) {
  const report = { schemaVersion: 1, batchId: randomUUID(), startedAt: new Date().toISOString(), status: 'failed', phase: 'preflight',
    originalPath: null, backupPath: null, validationPath: null, backupVerified: false, validationVerified: false, originalUntouched: true,
    migrationAllowed: false, errors: [], warnings: ['仅支持外部写入已停止的离线目录；确认与哈希扫描不是跨进程排他锁。验证副本仍须使用隔离的 Wiki 配置与注册表运行。'] };
  let reportPath;
  let reportOwned = false;
  try {
    if (input?.writersPaused !== true) fail('WRITERS_NOT_PAUSED', '必须先停止 Wiki、Obsidian、同步程序等全部写入');
    report.originalPath = await safePath(input.libraryPath);
    report.backupPath = await safePath(input.backupPath, { missingLeaf: true });
    report.validationPath = await safePath(input.validationPath, { missingLeaf: true });
    const roots = [report.originalPath, report.backupPath, report.validationPath];
    for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
      if (contains(roots[i], roots[j]) || contains(roots[j], roots[i])) fail('OVERLAPPING_PATHS', '原库、恢复备份和验证副本必须互不嵌套且不同名');
    }
    for (const root of roots.slice(1)) {
      if (await lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) fail('DESTINATION_EXISTS', '目标已存在，禁止覆盖旧备份或验证副本');
      await access(path.dirname(root), constants.W_OK);
    }
    const checked = await inspect({ ...input, libraryPath: report.originalPath });
    const blockers = checked.blockers.filter(b => b.code !== 'MIGRATION_UNVERIFIED');
    if (blockers.length || !checked.baseline) fail('PREFLIGHT_BLOCKED', blockers.map(b => b.message).join('；') || '缺少一致基线');
    report.version = checked.version;
    report.baseline = checked.baseline;
    report.directories = await layout(report.originalPath);
    // 活动数据库的未收尾写入不以普通复制代替数据库一致性保证。
    if (report.baseline.files.some(f => /(?:-wal|-shm|\.lock|LOCK)$/i.test(f.path))) fail('DATABASE_BUSY', '检测到数据库日志或锁文件，请完成关闭后重试');
    const required = report.baseline.files.reduce((sum, file) => sum + file.size, 0) + 1024 * 1024;
    const volumes = new Map();
    for (const destination of roots.slice(1)) {
      const parent = path.dirname(destination);
      const stats = await space(parent);
      const device = (await lstat(parent)).dev;
      const request = volumes.get(device) ?? { required: 0, available: Number(stats.bavail) * Number(stats.bsize) };
      request.required += required;
      request.available = Math.min(request.available, Number(stats.bavail) * Number(stats.bsize));
      volumes.set(device, request);
    }
    for (const value of volumes.values()) if (!Number.isFinite(value.available) || value.available < value.required) fail('INSUFFICIENT_SPACE', '磁盘剩余空间不足，无法同时保存恢复备份和验证副本');
    reportPath = `${report.backupPath}.organizer-report.json`;
    await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
    reportOwned = true;
    report.reportPath = reportPath;
    report.phase = 'backup';
    await mkdir(report.backupPath);
    await copyTree(report.originalPath, report.backupPath, report.baseline, report.directories, copy);
    await checkpoint('backup-copied', report);
    if ((await inventory(report.originalPath)).hash !== report.baseline.hash) fail('ORIGINAL_CHANGED', '备份期间原库发生变化，当前副本不可用于迁移');
    report.backupVerified = true;
    report.phase = 'validation-copy';
    await mkdir(report.validationPath);
    await copyTree(report.backupPath, report.validationPath, report.baseline, report.directories, copy);
    report.phase = 'relocation';
    report.relocation = await relocateValidationCopy(report.validationPath, report.originalPath, { originalAliases: [input.libraryPath] });
    await checkpoint('validation-relocated', report);
    await verifyBackup(report.backupPath, report.baseline, report.directories);
    if ((await inventory(report.originalPath)).hash !== report.baseline.hash) fail('ORIGINAL_CHANGED', '创建验证副本期间原库发生变化');
    if (JSON.stringify(await layout(report.originalPath)) !== JSON.stringify(report.directories)) fail('ORIGINAL_CHANGED', '原库目录结构发生变化');
    report.validationBaseline = await inventory(report.validationPath);
    report.validationVerified = true;
    report.phase = 'complete';
    report.status = 'complete';
  } catch (error) {
    report.errors.push({ code: error.code ?? 'BACKUP_FAILED', message: ['EACCES','EPERM','ENOSPC','ENOENT','EEXIST'].includes(error.code) ? `文件系统操作失败（${error.code}），已保留现场` : error.message });
  }
  report.finishedAt = new Date().toISOString();
  if (reportOwned) {
    try { await writeFile(reportPath, JSON.stringify(report, null, 2)); }
    catch { report.status = 'failed'; report.errors.push({ code: 'REPORT_WRITE_FAILED', message: '无法持久化结果报告，禁止后续执行' }); }
  }
  return report;
}
