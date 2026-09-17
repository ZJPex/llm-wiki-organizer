import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {createHash} from 'node:crypto';

const guard = vi.hoisted(() => ({ calls: [] as string[], scans: [] as any[] }));
function forbidden(kind: string): never { guard.calls.push(kind); throw new Error(`禁止的迁移副作用：${kind}`); }
function scan(projectId: string, projectPath: string, config?: unknown) {
  const command = JSON.parse(process.env.UPSTREAM_RESCAN_COMMAND || '[]');
  if (!Array.isArray(command) || !command.length) throw new Error('缺少真实 Rust UPSTREAM_RESCAN_COMMAND JSON 数组');
  const root = process.env.UPSTREAM_RESCAN_WSL === '1'
    ? projectPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
    : projectPath;
  const output = execFileSync(command[0], [...command.slice(1), '--validation-copy', root, projectId, ...(config ? [JSON.stringify(config)] : [])], {encoding:'utf8'});
  const report = JSON.parse(output);
  if (report.upstreamCommit !== 'e8082119649e6a8e1cf85eaf289adcabfdf39d4e') throw new Error('不是固定上游重扫程序');
  guard.scans.push(report);
  return report.result;
}
vi.mock('@/commands/file-sync', () => ({
  rescanProjectFiles: async (id: string, root: string, config: unknown) => scan(id, root, config),
  startProjectFileWatcher: () => forbidden('意外启动真实桌面 watcher'),
  stopProjectFileWatcher: async () => {},
}));
vi.mock('@tauri-apps/api/event', () => ({listen: async () => () => {}}));
vi.mock('@tauri-apps/api/core', () => ({invoke: () => forbidden('原生命令或 CLI 模型')}));
vi.mock('@tauri-apps/plugin-http', () => ({fetch: () => forbidden('原生 HTTP')}));
vi.mock('@/lib/llm-client', () => ({streamChat: () => forbidden('生成模型')}));
vi.mock('@/lib/image-caption-pipeline', () => ({captionMarkdownImages: () => forbidden('视觉模型'), loadCaptionCache: () => forbidden('视觉缓存入口')}));
vi.mock('@/lib/embedding', () => ({fetchEmbedding: () => forbidden('嵌入模型'), embedPage: () => forbidden('嵌入写入'), removePageEmbedding: () => forbidden('向量删除')}));
vi.mock('@/lib/source-lifecycle', () => ({
  cleanupDeletedWikiPages: () => forbidden('Wiki 级联删除'),
  deleteSourceFiles: () => forbidden('来源级联删除'),
  enqueueSourceIngest: () => forbidden('摄取入队'),
  migrateSourcePath: () => forbidden('上游隐式迁移'),
  isIngestableSourcePath: (value: string) => value.endsWith('.md'),
}));
vi.mock('@/commands/fs', () => ({readFile: (file: string) => fs.readFile(file, 'utf8')}));
// 展示层树刷新不参与摄取/迁移决策，避免需要真实 Tauri UI。
vi.mock('@/lib/project-file-tree-refresh', () => ({refreshProjectFileTree: async () => {}}));

import { rescanProjectFileSync, stopProjectFileSync } from '@/lib/project-file-sync';
import { useWikiStore } from '@/stores/wiki-store';
import { useFileSyncStore } from '@/stores/file-sync-store';
let root: string;
let external: any;
const externalMode = Boolean(process.env.UPSTREAM_VALIDATION_COPY);
let project: {id:string;name:string;path:string};
const watch = {enabled:true,autoIngest:true,includeExtensions:['md']};
beforeEach(async () => {
  guard.calls.length = 0; guard.scans.length = 0;
  vi.stubGlobal('fetch', () => forbidden('网络 fetch'));
  await stopProjectFileSync();
  if (externalMode) {
    const {validateExternalCopy} = await import('./external-copy.mjs');
    external = await validateExternalCopy(process.env);
    root = external.root;
    project = {id:external.projectId,name:'外部隔离副本',path:root.replaceAll('\\','/')};
    useWikiStore.setState({project,selectedFile:null});
    return;
  }
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'organizer-frontend-proof-'));
  project = {id:'isolated-frontend-proof', name:'隔离验证', path:root.replace(/\\/g,'/')};
  await fs.mkdir(path.join(root,'raw/sources'), {recursive:true});
  await fs.writeFile(path.join(root,'raw/sources/sample.md'), 'short');
  scan(project.id, project.path, watch); // 真实上游初始扫描建立快照，随后才评估静默行为。
  guard.scans.length = 0;
  useWikiStore.setState({project, selectedFile:null});
});
afterEach(async () => {
  await stopProjectFileSync();
  vi.unstubAllGlobals();
  if (!externalMode) await fs.rm(root, {recursive:true,force:true});
});
describe.skipIf(externalMode)('真实 Rust 重扫结果由固定上游前端消费', () => {
  it('无变化副本：真实扫描无任务，前端没有请求任何危险入口', async () => {
    await rescanProjectFileSync(project, watch as any);
    expect(guard.scans).toHaveLength(1);
    expect(guard.scans[0].result.changedTasks).toEqual([]);
    expect(guard.calls).toEqual([]);
    expect(useFileSyncStore.getState().lastError).toBeNull();
  });
  it('未维护快照的短文件改名：即使上游捕获错误，删除与摄取尝试仍被独立记录', async () => {
    await fs.rename(path.join(root,'raw/sources/sample.md'),path.join(root,'raw/sources/renamed.md'));
    await rescanProjectFileSync(project, watch as any);
    expect(guard.scans[0].result.changedTasks).toHaveLength(2);
    expect(guard.calls).toContain('来源级联删除');
    expect(guard.calls).toContain('摄取入队');
  });
  it('未维护快照的长文件改名：上游隐式迁移尝试也算失败', async () => {
    await fs.writeFile(path.join(root,'raw/sources/sample.md'), 'A sufficiently long source exceeding thirty two bytes.');
    scan(project.id,project.path,watch);
    await fs.rename(path.join(root,'raw/sources/sample.md'),path.join(root,'raw/sources/renamed.md'));
    await rescanProjectFileSync(project, watch as any);
    expect(guard.calls).toContain('上游隐式迁移');
    expect(useFileSyncStore.getState().lastError).toContain('禁止的迁移副作用');
  });
  it('各模型与网络守卫独立自检，任何尝试都在抛错前计数', async () => {
    const llm = await import('@/lib/llm-client');
    const image = await import('@/lib/image-caption-pipeline');
    const vector = await import('@/lib/embedding');
    const http = await import('@tauri-apps/plugin-http');
    const native = await import('@tauri-apps/api/core');
    for (const call of [() => (llm.streamChat as any)(), () => (image.captionMarkdownImages as any)(), () => (vector.fetchEmbedding as any)(), () => fetch('https://invalid.example'), () => (http.fetch as any)(), () => native.invoke('llm')]) expect(call).toThrow();
    expect(guard.calls).toEqual(['生成模型','视觉模型','嵌入模型','网络 fetch','原生 HTTP','原生命令或 CLI 模型']);
  });
});

describe.runIf(externalMode)('显式外部验证副本', () => {
  it('真实重扫和前端消费不产生迁移副作用', async () => {
    const preserved=await Promise.all(['file-snapshot.json','file-change-queue.json'].map(async name=>({name,file:path.join(root,'.llm-wiki',name),bytes:await fs.readFile(path.join(root,'.llm-wiki',name))})));
    let error: string | null = null;
    try { await rescanProjectFileSync(project, watch as any); }
    catch (caught) { error = String(caught); }
    finally {for(const file of preserved)await fs.writeFile(file.file,file.bytes);}
    const stateHashes=await Promise.all(preserved.map(async file=>({path:file.name,before:createHash('sha256').update(file.bytes).digest('hex'),after:createHash('sha256').update(await fs.readFile(file.file)).digest('hex')})));
    const proof = {schemaVersion:1,projectId:project.id,validationPath:root,error,attempts:[...guard.calls],frontendSideEffects:[...guard.calls],rustProof:guard.scans[0] ?? null,stateHashes,recoveryReportHash:external.recoveryReportHash??null};
    await fs.writeFile(external.resultFile,JSON.stringify(proof,null,2),{flag:'wx'});
    expect(error).toBeNull();
    expect(guard.scans).toHaveLength(1);
    expect(proof.rustProof.result.changedTasks).toEqual([]);
    expect(proof.rustProof.result.queue.tasks).toEqual([]);
    expect(proof.attempts).toEqual([]);
    expect(useFileSyncStore.getState().lastError).toBeNull();
  });
});
