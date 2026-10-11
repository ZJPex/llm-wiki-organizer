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

test('新增分类完整展示父级名称收益，明确接受后随审核提交，历史调整另列说明',async t=>{
 const document=createInboxDocument(),old=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{value:document,configurable:true});t.after(()=>old?Object.defineProperty(globalThis,'document',old):delete globalThis.document);t.mock.method(globalThis,'setInterval',()=>0);
 const tasks=document.createElement('div'),featured=document.createElement('div'),more=document.createElement('button');document.body.replaceChildren(tasks,featured,more);let review;
 const item={itemId:'new',identity:'新主题.md',status:'reviewable',available:true,suggestion:'新主题.md',classification:{category:'001 缓存/001.01 一致性',decision:'missing-category',options:['','001 缓存'],newCategory:{proposalHash:'frozen-proposal',path:'001 缓存/001.01 一致性',parent:'001 缓存',label:'一致性',reason:'正文专门比较一致性策略',benefit:'便于直接查找一致性实践'},adjustments:[{type:'rename',from:'002 数据库',to:'数据库技术',reason:'统一术语',benefit:'方便历史查找',affectedCategories:['002 数据库'],requiresHistoryValidation:true}]}};
 t.mock.method(globalThis,'fetch',async(url,options)=>{if(url==='/api/session')return {ok:true,json:async()=>({token:'test'})};if(url==='/api/inbox/review')review=JSON.parse(options.body);return {ok:true,json:async()=>({libraryId:'library',items:[item]})};});
 const home=createLibraryInboxHome({tasks,featured,more,getLibrary:()=>({id:'library',valid:true}),history:()=>{}});await home.load();assert.match(tasks.textContent,/父级：001 缓存 · 名称：一致性/);assert.match(tasks.textContent,/查找收益：便于直接查找/);assert.match(tasks.textContent,/审核期间不建目录/);assert.match(tasks.textContent,/另列目录调整/);assert.match(tasks.textContent,/副本验证与恢复流程/);
 const selected=tasks.querySelector('article').querySelector('input');selected.checked=true;await selected.dispatchEvent({type:'change'});
 const accepted=tasks.querySelectorAll('input').find(node=>node.getAttribute('aria-label')==='接受新增分类 新主题.md');assert.equal(accepted.checked,false);accepted.checked=true;await accepted.dispatchEvent({type:'change'});await home.load();assert.equal(tasks.querySelectorAll('input').find(node=>node.getAttribute('aria-label')==='接受新增分类 新主题.md').checked,true);
 await tasks.querySelectorAll('button').find(node=>node.textContent==='保存所选审核').click();assert.equal(review.acceptNewCategory,true);assert.equal(review.newCategoryHash,'frozen-proposal');assert.equal(review.category,item.classification.category);
});

test('待定方案呈现候选与理由，根分类须明确选择，不能把缺省选择当审核授权',async t=>{
 const document=createInboxDocument(),old=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{value:document,configurable:true});t.after(()=>old?Object.defineProperty(globalThis,'document',old):delete globalThis.document);t.mock.method(globalThis,'setInterval',()=>0);
 const tasks=document.createElement('div'),featured=document.createElement('div'),more=document.createElement('button');document.body.replaceChildren(tasks,featured,more);let reviews=0;
 const item={itemId:'pending',identity:'待定.md',status:'needs-classification',available:true,suggestion:'待定.md',classification:{category:null,decision:'cross-topic',considered:['001 缓存','002 数据库'],options:['','001 缓存','002 数据库'],reason:'主要用途缺少明显主次'},tags:['数据库']};
 t.mock.method(globalThis,'fetch',async(url,options)=>{if(url==='/api/session')return {ok:true,json:async()=>({token:'test'})};if(url==='/api/inbox/review'){reviews++;assert.equal(JSON.parse(options.body).category,'');}return {ok:true,json:async()=>({libraryId:'library',items:[item],analysisProgress:{completed:1,total:1}})};});
 const home=createLibraryInboxHome({tasks,featured,more,getLibrary:()=>({id:'library',valid:true}),history:()=>{}});await home.load();assert.match(tasks.textContent,/主要用途缺少明显主次/);assert.match(tasks.textContent,/考虑的候选：001 缓存、002 数据库/);assert.match(featured.textContent,/分析处理完成 1 \/ 1/);assert.match(featured.textContent,/可审核 0/);
 const selected=tasks.querySelector('article').querySelector('input');selected.checked=true;await selected.dispatchEvent({type:'change'});const button=()=>tasks.querySelectorAll('button').find(node=>node.textContent==='保存所选审核');
 assert.equal(tasks.querySelector('select').value,'__unselected__');await button().click();assert.equal(reviews,0);assert.match(tasks.textContent,/请明确选择主分类/);
 const category=tasks.querySelector('select');category.value='';await category.dispatchEvent({type:'change'});await button().click();assert.equal(reviews,1);
});

test('当前文件审核默认不推广，明确勾选和填写规则后才提交知识库偏好，刷新保留草稿',async t=>{
 const document=createInboxDocument(),old=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{value:document,configurable:true});t.after(()=>old?Object.defineProperty(globalThis,'document',old):delete globalThis.document);t.mock.method(globalThis,'setInterval',()=>0);
 const tasks=document.createElement('div'),featured=document.createElement('div'),more=document.createElement('button');document.body.replaceChildren(tasks,featured,more);const reviews=[];
 const item={itemId:'rule',identity:'偏好.md',status:'reviewable',available:true,suggestion:'偏好.md',reviewBasis:{sourceHash:'source',catalogHash:'catalog'},classification:{category:'001 缓存',options:['','001 缓存','002 数据库']}};
 t.mock.method(globalThis,'fetch',async(url,options)=>{if(url==='/api/session')return {ok:true,json:async()=>({token:'test'})};if(url==='/api/inbox/review')reviews.push(JSON.parse(options.body));return {ok:true,json:async()=>({libraryId:'library',items:[item]})};});
 const home=createLibraryInboxHome({tasks,featured,more,getLibrary:()=>({id:'library',valid:true}),history:()=>{}});await home.load();assert.match(tasks.textContent,/默认只修改当前文件/);assert.match(tasks.textContent,/仍需逐文件审核/);
 const checkbox=tasks.querySelector('article').querySelector('input');checkbox.checked=true;await checkbox.dispatchEvent({type:'change'});const saveButton=()=>tasks.querySelectorAll('button').find(node=>node.textContent==='保存所选审核');await saveButton().click();assert.notEqual(reviews[0].saveClassificationRule,true);
 const selected=tasks.querySelectorAll('input').find(node=>node.getAttribute('aria-label')==='保存后续分类规则 偏好.md');assert.equal(selected.checked,false);selected.checked=true;await selected.dispatchEvent({type:'change'});const instruction=tasks.querySelector('textarea');assert.equal(instruction.disabled,false);instruction.value='缓存一致性优先归属数据库';await instruction.dispatchEvent({type:'input'});await home.load();assert.equal(tasks.querySelector('textarea').value,'缓存一致性优先归属数据库');
 await saveButton().click();assert.equal(reviews[1].saveClassificationRule,true);assert.equal(reviews[1].ruleText,'缓存一致性优先归属数据库');
});
