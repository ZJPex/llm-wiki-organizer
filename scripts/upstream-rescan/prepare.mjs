import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仅替换桌面事件边界，重扫、队列与哈希算法逐字来自固定上游。
const [upstream, destination] = process.argv.slice(2);
if (!upstream || !destination) throw new Error('用法：node prepare.mjs <上游源码目录> <全新临时构建目录>');
const here = path.dirname(fileURLToPath(import.meta.url));
async function verified(relative, expected) {
  const text = (await readFile(path.join(upstream, relative), 'utf8')).replace(/\r\n/g, '\n');
  if (createHash('sha256').update(text).digest('hex') !== expected) throw new Error(`固定上游源码校验失败：${relative}`);
  return text;
}
const core = await verified('src-tauri/src/commands/file_sync.rs', '0e3f24f3dd9d9bf84411809b712d02a81204012ddec13ecbc8f86662af1eb117');
const defaults = await verified('src/lib/source-watch-defaults.json', '7ae0b0dfeef0cfbf80d56243a5b13acc259ea1b1828176fa6c7090b008cde408');
await mkdir(destination); // 禁止覆盖已有构建目录。
await mkdir(path.join(destination, 'src'));
await copyFile(path.join(here, 'Cargo.toml'), path.join(destination, 'Cargo.toml'));
await copyFile(path.join(here, 'Cargo.lock'), path.join(destination, 'Cargo.lock'));
await copyFile(path.join(here, 'main.rs'), path.join(destination, 'src/main.rs'));
await writeFile(path.join(destination, 'src/source-watch-defaults.json'), defaults);
await writeFile(path.join(destination, 'src/core.rs'), core
  .replace('use tauri::{AppHandle, Emitter, State};', 'use crate::tauri::{AppHandle, Emitter, State};')
  .replaceAll('#[tauri::command]\n', '')
  .replace('../../../src/lib/source-watch-defaults.json', 'source-watch-defaults.json'));
console.log(JSON.stringify({ upstreamCommit: 'e8082119649e6a8e1cf85eaf289adcabfdf39d4e', normalizedSourceSha256: '0e3f24f3dd9d9bf84411809b712d02a81204012ddec13ecbc8f86662af1eb117', destination }));

