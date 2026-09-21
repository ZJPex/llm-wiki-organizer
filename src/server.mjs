import http from 'node:http';
import {createWorkspaceService} from './workspace.js';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { preflight } from './compatibility.js';
import { createBackup } from './backup.js';
import { createPlanningService } from './planning.js';

import { createMigrationService } from './migration.js';
import {createBatchService} from './batches.js';
import {createRestructureStrategy} from './restructure.js';
import {createInboxStrategy} from './inbox.js';
import { createRecoveryService } from './recovery.js';
import { createOriginalExecutionService } from './original-execution.js';

export function createApp({ inspect = preflight, backup = createBackup, planning = createPlanningService(), migration = createMigrationService(), recovery = createRecoveryService(), original = createOriginalExecutionService(), batches = null, workspace = null } = {}) {
  batches??=createBatchService({planning,backup,migration,recovery,original,strategies:{restructure:createRestructureStrategy(),inbox:createInboxStrategy()}});
  workspace??=createWorkspaceService({batches});
  const token = randomBytes(32).toString('hex');
  return http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${req.socket.localPort}`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'");
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    if (req.headers.host !== `127.0.0.1:${req.socket.localPort}` || (req.headers.origin && req.headers.origin !== origin)) return send(403, { error: '仅接受本地页面请求' });
    try {
      if (req.method === 'GET' && req.url === '/api/session') return send(200, { token });
      if (req.method === 'GET' && ['/original','/original.js'].includes(req.url)) {
        const script=req.url.endsWith('.js');res.writeHead(200,{'Content-Type':`${script?'text/javascript':'text/html'}; charset=utf-8`});
        return res.end(await readFile(new URL(`../public/original.${script?'js':'html'}`,import.meta.url)));
      }
      const assets = { '/review-workspace.js':['review-workspace.js','text/javascript'], '/classify-all.js': ['classify-all.js','text/javascript'], '/bulk-review.js': ['bulk-review.js','text/javascript'], '/tree-progress.js': ['tree-progress.js','text/javascript'], '/analyze-all.js': ['analyze-all.js','text/javascript'], '/restructure': ['restructure.html','text/html'], '/restructure.js': ['restructure.js','text/javascript'], '/batch-ui.js': ['batch-ui.js','text/javascript'], '/preflight': ['index.html','text/html'], '/inbox': ['inbox.html','text/html'], '/inbox.js': ['inbox.js','text/javascript'], '/recovery': ['recovery.html','text/html'], '/recovery.js': ['recovery.js','text/javascript'], '/batch-migration': ['batch-migration.html','text/html'], '/batch-migration.js': ['batch-migration.js','text/javascript'], '/': ['workspace.html','text/html'], '/workspace.js':['workspace.js','text/javascript'], '/workspace.css':['workspace.css','text/css'], '/app.js': ['app.js','text/javascript'], '/style.css': ['style.css','text/css'], '/backup': ['backup.html','text/html'], '/backup.js': ['backup.js','text/javascript'], '/migration': ['migration.html','text/html'], '/migration.js': ['migration.js','text/javascript'], '/planning-ui.js': ['planning-ui.js','text/javascript'] };
      if (req.method === 'GET' && assets[req.url.split('?')[0]]) {
        const [file, type] = assets[req.url.split('?')[0]];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return res.end(await readFile(new URL(`../public/${file}`, import.meta.url)));
      }
      const workspaceAction = /^\/api\/workspace\/(list|save|create|categories)$/.exec(req.url)?.[1];
      const planningAction = /^\/api\/planning\/(analyze|confirm|list|classify|confirmCategory|evolve|confirmEvolution)$/.exec(req.url)?.[1];
      const batchAction = /^\/api\/batches\/(create|get|list|analyzeNext|classifyNext|confirmRecommendedCategories|confirmPlans|reviewItem|treeAction|prepareSlice|replanSlice|validateSlice|cancelSlice|prepareOriginal|applySlice)$/.exec(req.url)?.[1];
      const recoveryAction = /^\/api\/recovery\/(inspect|plan|execute|get)$/.exec(req.url)?.[1];
      const migrationAction = /^\/api\/migration\/(plan|execute)$/.exec(req.url)?.[1];
      const originalAction = /^\/api\/original\/(prepare|execute|get)$/.exec(req.url)?.[1];
      if (req.method !== 'POST' || (!['/api/preflight', '/api/backup'].includes(req.url) && !migrationAction && !planningAction && !recoveryAction && !originalAction && !batchAction && !workspaceAction)) return send(404, { error: '入口不存在' });
      if (req.headers['x-organizer-token'] !== token || req.headers['content-type'] !== 'application/json') return send(403, { error: '会话校验失败，请刷新本地页面' });
      let body = '';
      const bodyLimit = migrationAction ? 2 * 1024 * 1024 : 16384;
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > bodyLimit) return send(413, { error: '请求过大' }); }
      let input;
      try { input = JSON.parse(body); } catch { return send(400, { error: '请求格式无效' }); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return send(400, { error: '请求格式无效' });
      if (workspaceAction) { try { return send(200,await workspace[workspaceAction](input)); } catch(error) { return send(400,{error:error.message,code:error.code??'SETTINGS_FAILED'}); } }
      if (originalAction) { try { return send(200,await original[originalAction](input)); } catch(error) { return send(400,{error:error.message,code:error.code??'ORIGINAL_FAILED'}); } }
      if (batchAction) { try { if(!batches)throw new Error('批次服务尚未配置'); return send(200,await batches[batchAction](input)); } catch(error) { return send(400,{error:error.message,code:error.code??'BATCH_FAILED',batchId:error.batchId,revision:error.revision}); } }
      if (planningAction) { try { return send(200, await planning[planningAction](input)); } catch { return send(400, { error: '命名操作失败：请检查配置支持范围、源文件变化、证据、名称及冲突；未修改来源。' }); } }
      if (recoveryAction) { try { return send(200, await recovery[recoveryAction](input)); } catch(error) { return send(400, {error:error.message,code:error.code??'RECOVERY_FAILED'}); } }
      if (migrationAction) {
        try { return send(200, await migration[migrationAction](input)); }
        catch (error) { return send(400, { error: error.message, code: error.code ?? 'MIGRATION_FAILED' }); }
      }
      return send(200, await (req.url === '/api/backup' ? backup : inspect)(input));
    } catch { send(500, { error: '读取失败，请检查目录权限或重试' }); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApp();
  app.listen(Number(process.env.PORT || 4317), '127.0.0.1', () => console.log(`整理器：http://127.0.0.1:${app.address().port}`));
}

