// 临时界面原型：独立服务只提供示例页面，不连接整理器 API。
import http from 'node:http';
import { readFile } from 'node:fs/promises';

if (process.env.NODE_ENV === 'production') throw new Error('此临时原型只用于本地设计评估。');
const files = new Map([
  ['/', ['organizer-prototype.html', 'text/html']],
  ['/inbox', ['organizer-prototype.html', 'text/html']],
  ['/restructure', ['organizer-prototype.html', 'text/html']],
  ['/recovery', ['organizer-prototype.html', 'text/html']],
  ['/organizer-prototype.css', ['organizer-prototype.css', 'text/css']],
  ['/organizer-prototype.js', ['organizer-prototype.js', 'text/javascript']],
]);
const server = http.createServer(async (req, res) => {
  const file = files.get(new URL(req.url, 'http://localhost').pathname);
  if (req.method !== 'GET' || !file) { res.writeHead(404); return res.end('原型未提供此操作'); }
  res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(await readFile(new URL(`../public/${file[0]}`, import.meta.url)));
});
server.listen(4328, '127.0.0.1', () => console.log('界面原型：http://127.0.0.1:4328/?variant=A'));
