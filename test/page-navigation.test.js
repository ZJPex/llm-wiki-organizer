import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/server.mjs';
import {listenForBrowser} from './helpers/http-server.js';

test('全部流程页面提供统一导航，跨页可直达分类与设置，图标资源可加载',async t=>{
 const server=createApp();await listenForBrowser(server);t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 for(const route of ['/','/task-report','/recovery','/preflight','/backup','/migration','/batch-migration','/original','/inbox','/restructure']){
  const response=await fetch(base+route);assert.equal(response.status,200,route);
  const html=await response.text();assert.match(html,/aria-label="主要导航"/,route);
  assert.match(html,/href="\/recovery"/,route);assert.match(html,/href="\/preflight"/,route);
  if(route!=='/'){
   assert.match(html,/href="\/\?view=browse"/,route);assert.match(html,/href="\/\?view=settings"/,route);
  }else assert.match(html,/id="home-nav"/,route);
 }
 for(const name of ['book','document','folder','history','settings','shield','refresh']){
  const response=await fetch(`${base}/icons/${name}.svg`);assert.equal(response.status,200,name);
  assert.match(response.headers.get('content-type'),/image\/svg\+xml/);
 }
});

test('设置直达页面在脚本和知识库请求完成前也不展示任务首页',async t=>{
 const server=createApp();await listenForBrowser(server);t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/?view=settings`);
 const html=await response.text();
 assert.match(html,/<span id="page-label">知识库设置<\/span>/);
 assert.match(html,/<h1 id="title">知识库设置<\/h1>/);
 assert.match(html,/<section id="home" hidden/);
 assert.match(html,/<form id="start" hidden/);
 assert.match(html,/<button id="settings-nav" aria-current="page"/);
});
test('未允许的view参数包括对象继承属性均安全回到首页',async t=>{
 const server=createApp();await listenForBrowser(server);t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const base=`http://127.0.0.1:${server.address().port}`;
 for(const view of ['constructor','__proto__','toString','task-workspace','unknown']){
  const response=await fetch(`${base}/?view=${encodeURIComponent(view)}`,{signal:AbortSignal.timeout(2000)}),html=await response.text();assert.equal(response.status,200,view);
  assert.match(html,/<span id="page-label">知识库收件箱<\/span>/);
 }
});
