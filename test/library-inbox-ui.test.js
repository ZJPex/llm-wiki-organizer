import test from 'node:test';
import assert from 'node:assert/strict';
import {createInboxDocument} from './helpers/page-dom.js';
import {createLibraryInboxHome} from '../public/library-inbox.js';

test('收件箱页面明确勾选后启动，保存建议和人工编辑，再确认归档，重载保留状态',async t=>{
 const document=createInboxDocument();const old=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{value:document,configurable:true});t.after(()=>old?Object.defineProperty(globalThis,'document',old):delete globalThis.document);
 t.mock.method(globalThis,'setInterval',()=>0);
 const tasks=document.createElement('div'),featured=document.createElement('div'),more=document.createElement('button');document.body.replaceChildren(tasks,featured,more);
 let items=[],calls=[];
 const source={itemId:'source-a',identity:'a.md',status:'pending',available:true};
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  const input=JSON.parse(options?.body??'{}');calls.push({url,input});
  if(url==='/api/session')return {ok:true,json:async()=>({token:'test'})};
  if(url==='/api/inbox/scan')items=[{...source},{...source,itemId:'source-b',identity:'b.md'}];
  if(url==='/api/inbox/start'){assert.deepEqual(input.itemIds,['source-a']);items[0]={...items[0],status:'reviewable',suggestion:'建议名称.md',analysis:{summary:'已读取的全文摘要'},classification:{category:'',options:['','001 缓存'],reason:'正文主题'},targetPath:'/raw/建议名称.md'};}
  if(url==='/api/inbox/review'){assert.equal(input.name,'人工名称.md');assert.equal(input.category,'001 缓存');assert.deepEqual(input.tags,['数据库','可靠性']);items[0]={...items[0],tags:input.tags,status:'confirmed',suggestion:input.name,classification:{...items[0].classification,category:input.category},targetPath:'/raw/001 缓存/人工名称.md'};}
  if(url==='/api/inbox/archive'){assert.equal(input.writersPaused,true);assert.equal(input.approved,true);items[0]={...items[0],status:'archived'};}
  return {ok:true,json:async()=>structuredClone({libraryId:'library',items})};
 });
 const home=createLibraryInboxHome({tasks,featured,more,getLibrary:()=>({id:'library',valid:true}),history:()=>{}});
 await home.load();assert.match(tasks.textContent,/点击“刷新发现文件”/);assert.equal(calls.some(call=>call.url==='/api/inbox/scan'),false);
 await home.scan();assert.match(tasks.textContent,/a.md/);assert.equal(calls.some(call=>call.url==='/api/inbox/start'),false);
 const selected=tasks.querySelector('article').querySelector('input');selected.checked=true;await selected.dispatchEvent({type:'change'});
 const button=label=>tasks.querySelectorAll('button').find(node=>node.textContent===label);
 await button('开始整理所选文件').click();assert.match(tasks.textContent,/可审核/);assert.match(tasks.textContent,/已读取的全文摘要/);
 const name=tasks.querySelector('article').querySelectorAll('input').find(node=>node.type!=='checkbox');name.value='人工名称.md';await name.dispatchEvent({type:'input'});
 const category=tasks.querySelector('article').querySelector('select');category.value='001 缓存';await category.dispatchEvent({type:'change'});
 const tags=tasks.querySelector('article').querySelectorAll('input').find(node=>node.getAttribute('aria-label')==='主题标签 a.md');tags.value='数据库、可靠性';await tags.dispatchEvent({type:'input'});
 await home.load();assert.equal(tasks.querySelector('article').querySelectorAll('input').find(node=>node.type!=='checkbox').value,'人工名称.md');
 await button('保存所选审核').click();assert.match(tasks.textContent,/已确认待归档/);assert.equal(calls.some(call=>call.url==='/api/inbox/archive'),false);
 const paused=tasks.querySelector('#inbox-writers-paused');paused.checked=true;await paused.dispatchEvent({type:'change'});
 await button('确认归档所选文件').click();assert.match(tasks.textContent,/已归档/);assert.match(tasks.textContent,/001 缓存\/人工名称.md/);assert.match(tasks.textContent,/主题标签：数据库、可靠性/);
 await home.load();assert.match(tasks.textContent,/已归档/);assert.equal(items[1].status,'pending');
});
