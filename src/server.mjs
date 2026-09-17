import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { preflight } from './compatibility.js';
import { createBackup } from './backup.js';
import { createPlanningService } from './planning.js';

export function createApp({ inspect = preflight, backup = createBackup, planning = createPlanningService() } = {}) {
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
      const assets = { '/': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/style.css': ['style.css','text/css'], '/backup': ['backup.html','text/html'], '/backup.js': ['backup.js','text/javascript'], '/planning-ui.js': ['planning-ui.js','text/javascript'] };
      if (req.method === 'GET' && assets[req.url]) {
        const [file, type] = assets[req.url];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return res.end(await readFile(new URL(`../public/${file}`, import.meta.url)));
      }
      const planningAction = /^\/api\/planning\/(analyze|confirm|list|classify|confirmCategory|evolve|confirmEvolution)$/.exec(req.url)?.[1];
      if (req.method !== 'POST' || (!['/api/preflight', '/api/backup'].includes(req.url) && !planningAction)) return send(404, { error: '入口不存在' });
      if (req.headers['x-organizer-token'] !== token || req.headers['content-type'] !== 'application/json') return send(403, { error: '会话校验失败，请刷新本地页面' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) return send(413, { error: '请求过大' }); }
      let input;
      try { input = JSON.parse(body); } catch { return send(400, { error: '请求格式无效' }); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return send(400, { error: '请求格式无效' });
      if (planningAction) { try { return send(200, await planning[planningAction](input)); } catch { return send(400, { error: '命名操作失败：请检查配置支持范围、源文件变化、证据、名称及冲突；未修改来源。' }); } }
      return send(200, await (req.url === '/api/backup' ? backup : inspect)(input));
    } catch { send(500, { error: '读取失败，请检查目录权限或重试' }); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApp();
  app.listen(Number(process.env.PORT || 4317), '127.0.0.1', () => console.log(`整理器：http://127.0.0.1:${app.address().port}`));
}
