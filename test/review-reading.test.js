import test from 'node:test';
import assert from 'node:assert/strict';
import {createInboxDocument} from './helpers/page-dom.js';
import {mountReviewWorkspace} from '../public/review-workspace.js';

async function pageFixture(t,{count=2}={}){
 const document=createInboxDocument(),storage=new Map(),requests=[];
 const sources=Array.from({length:count},(_,i)=>({sourceId:String(i),identity:`材料${i}.md`,currentIdentity:`材料${i}.md`,currentPath:`/inbox/材料${i}.md`,hash:`hash${i}`,status:'classified',ingestStatus:'new',suggestion:`建议${i}.md`,analysis:{uncertain:false,summary:`摘要${i}`,evidence:i?[]:['来自真实正文的证据']},classification:{category:'001 分类',reason:`分类依据${i}`,options:['','001 分类']}}));
 const batch={batchId:'reading',revision:1,phase:'file-review',libraryPath:'/library',sources,nextCursor:null,flow:{}};
 for(const [key,value] of Object.entries({document,sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)}})){
  const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else delete globalThis[key];});
 }
 t.mock.method(globalThis,'setInterval',()=>0);
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url==='/api/session')return {json:async()=>({token:'test'})};
  requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>structuredClone(batch)};
 });
 const host=document.createElement('main');document.body.append(host);const workspace=await mountReviewWorkspace(host,'reading');
 return {document,host,batch,requests,workspace,button:text=>host.querySelectorAll('button').find(node=>(node.getAttribute('aria-label')??node.textContent)===text),input:label=>host.querySelectorAll('input').find(node=>node.getAttribute('aria-label')===label)};
}

test('队列阅读与勾选独立，中央显示真实摘要证据，详情默认收起并正确切换及恢复焦点',async t=>{
 const p=await pageFixture(t),detail=()=>p.host.querySelector('[aria-label="材料证据详情"]');
 assert.equal(detail().hidden,true);
 assert.ok(p.input('新名称 材料0.md'));assert.equal(p.input('新名称 材料1.md'),undefined);
 assert.match(p.host.textContent,/来自真实正文的证据/);
 await p.button('阅读 材料1.md').click();
 assert.equal(p.input('选择 材料1.md').checked,false);
 assert.equal(p.input('新名称 材料1.md').value,'建议1.md');
 assert.match(p.host.textContent,/尚无原文证据/);
 await p.button('详情').click();assert.equal(detail().hidden,false);assert.match(detail().textContent,/分类依据1/);
 await p.button('阅读 材料0.md').click();assert.match(detail().textContent,/分类依据0/);assert.doesNotMatch(detail().textContent,/分类依据1/);
 await p.button('关闭详情').click();assert.equal(detail().hidden,true);assert.equal(p.document.activeElement,p.button('详情'));
 assert.ok(p.requests.every(request=>request.url.endsWith('/get')));
});

test('详情收起时目录问题仍可见，展开后上下文动作继续调用原审核接口',async t=>{
 const p=await pageFixture(t);p.batch.sources[0].evolution={status:'proposed',operations:[{type:'add',parent:'001 分类',label:'子分类',problem:'现有目录混合两种查找目的',benefit:'区分使用场景'}]};
 await p.workspace.refresh();
 assert.equal(p.host.querySelector('[aria-label="材料证据详情"]').hidden,true);
 assert.match(p.host.querySelector('[role="note"]').textContent,/现有目录混合两种查找目的/);
 await p.button('详情').click();await p.button('确认这份目录调整').click();
 await p.document.waitFor(()=>p.requests.some(r=>r.body.action==='confirmEvolution'));
 await p.document.waitFor(()=>!p.button('本项保留原处').disabled);
 await p.button('本项保留原处').click();await p.document.waitFor(()=>p.requests.some(r=>r.body.action==='exclude'));
 assert.ok(p.requests.filter(r=>r.body.action).every(r=>r.url.endsWith('/reviewItem')&&r.body.sourceId==='0'));
});

test('切换、筛选、分页和刷新保留手改草稿；审核版本失效取消选择，源变化重置草稿',async t=>{
 const p=await pageFixture(t,{count:22});
 const name=p.input('新名称 材料0.md');name.value='人工标题.md';await name.dispatchEvent({type:'input'});
 await p.button('Raw 根目录').click();
 const selected=p.input('选择 材料0.md');selected.checked=true;await selected.dispatchEvent({type:'change'});
 await p.button('阅读 材料1.md').click();await p.button('下一页').click();await p.document.waitFor(()=>!!p.input('新名称 材料20.md'));
 const search=p.input('按名称查找');search.value='人工标题';await search.dispatchEvent({type:'input'});
 assert.equal(p.input('新名称 材料0.md').value,'人工标题.md');assert.equal(p.input('主分类 材料0.md').value,'');assert.equal(p.input('选择 材料0.md').checked,true);
 p.batch.sources[0].suggestion='后台新建议.md';await p.workspace.refresh();assert.equal(p.input('新名称 材料0.md').value,'人工标题.md');
 p.batch.sources[0].reviewVersion=2;await p.workspace.refresh();assert.equal(p.input('选择 材料0.md').checked,false);assert.equal(p.input('新名称 材料0.md').value,'人工标题.md');
 search.value='不存在';await search.dispatchEvent({type:'input'});assert.match(p.host.querySelector('[aria-label="当前材料阅读"]').textContent,/没有符合条件的材料/);
 search.value='';await search.dispatchEvent({type:'input'});p.batch.sources[0].hash='changed';await p.workspace.refresh();assert.equal(p.input('新名称 材料0.md').value,'后台新建议.md');
});

test('合成知识库中通过页面保存人工名称和分类，读取证据与审核不会移动原文件',async t=>{
 const {inboxConfirmationFixture}=await import('./helpers/inbox-confirmation-fixture.js');
 const {readFile,readdir}=await import('node:fs/promises');
 const f=await inboxConfirmationFixture(t),document=createInboxDocument(),storage=new Map();
 for(const [key,value] of Object.entries({document,sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)}})){
  const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else delete globalThis[key];});
 }
 t.mock.method(globalThis,'setInterval',()=>0);const nativeFetch=globalThis.fetch;
 t.mock.method(globalThis,'fetch',(url,options)=>nativeFetch(new URL(url,f.base),options));
 const before=await readdir(f.sourceRoot),host=document.createElement('main');document.body.append(host);
 await mountReviewWorkspace(host,f.getBatch().batchId);
 const button=text=>host.querySelectorAll('button').find(n=>(n.getAttribute('aria-label')??n.textContent)===text);
 const input=label=>host.querySelectorAll('input').find(n=>n.getAttribute('aria-label')===label);
 await button('阅读 unnamed.md').click();const name=input('新名称 unnamed.md');assert.equal(name.disabled,false);name.value='人工缓存实践.md';await name.dispatchEvent({type:'input'});
 await button('Raw 根目录').click();await button('详情').click();await button('确认此名称并评估目录调整').click();
 await document.waitFor(()=>input('新名称 unnamed.md').disabled&&!button('本项保留原处').disabled);
 let actual=await f.call('get');const source=actual.sources.find(s=>s.identity==='unnamed.md');assert.equal(source.confirmedName,'人工缓存实践.md');assert.equal(input('主分类 unnamed.md').value,'');
 // 目录评估本身不冻结分类；沿原确认接口保存页面保留的人工草稿。
 await button('确认这份目录调整').click();await document.waitFor(()=>!button('本项保留原处').disabled);await f.call('get');
 actual=await f.call('confirmPlans',{items:[{sourceId:source.sourceId,name:input('新名称 unnamed.md').value,category:input('主分类 unnamed.md').value,manuallyEdited:true}]});
 assert.equal(actual.sources.find(s=>s.sourceId===source.sourceId).classification.category,'');
 assert.deepEqual(await readdir(f.sourceRoot),before);assert.match(await readFile(source.currentPath,'utf8'),/缓存一致性/);
 await button('阅读 excluded.md').click();assert.equal(input('新名称 excluded.md').disabled,true);assert.equal(input('主分类 excluded.md').disabled,true);
});

