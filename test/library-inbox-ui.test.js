import test from 'node:test';
import assert from 'node:assert/strict';
import {createInboxDocument} from './helpers/page-dom.js';
import {createLibraryInboxHome} from '../public/library-inbox.js';

test('旧结果冲突呈现来源和依据，明确选择后才接入，库内历史可打开原恢复报告',async t=>{
 const document=createInboxDocument(),old=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{value:document,configurable:true});t.after(()=>old?Object.defineProperty(globalThis,'document',old):delete globalThis.document);t.mock.method(globalThis,'setInterval',()=>0);
 const tasks=document.createElement('div'),featured=document.createElement('div'),more=document.createElement('button');document.body.replaceChildren(tasks,featured,more);let chosen=null;
 const records=[{originId:'first:source',valid:true,name:'人工第一份.md',category:'001 缓存',manuallyEdited:true,reason:'正文有效，人工确认需重审',recoveryUrl:'/task-report?batchId=first'},{originId:'second:source',valid:true,name:'人工第二份.md',category:'002 数据库',reason:'正文有效，分类依据需重审',recoveryUrl:'/task-report?batchId=second'}];
 let item={itemId:'a',identity:'a.md',available:true,status:'legacy-conflict',legacyChoices:records,history:records};
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url==='/api/session')return {ok:true,json:async()=>({token:'test'})};
  if(url==='/api/inbox/chooseLegacy'){chosen=JSON.parse(options.body);item={...item,status:'needs-classification',suggestion:'人工第一份.md',legacyChoices:undefined};}
  return {ok:true,json:async()=>url==='/api/inbox/history'?{records}:structuredClone({libraryId:'library',items:[item]})};
 });
 const home=createLibraryInboxHome({tasks,featured,more,getLibrary:()=>({id:'library',valid:true}),history:host=>host.append(document.createElement('p'))});await home.load();
 assert.match(tasks.textContent,/人工第一份.md.*人工确认需重审/s);assert.match(tasks.textContent,/人工第二份.md.*分类依据需重审/s);assert.equal(chosen,null);
 await tasks.querySelectorAll('button').find(node=>node.textContent==='采用此旧结果：人工第一份.md').click();assert.equal(chosen.originId,'first:source');assert.equal(chosen.itemId,'a');
 await tasks.querySelector('summary').click();assert.ok(tasks.querySelectorAll('a').some(node=>node.getAttribute('href')==='/task-report?batchId=first'));assert.match(tasks.textContent,/来源：first:source/);
});

test('相同知识库 ID 的物理或来源范围改变后移除旧编辑节点、选择与草稿',async t=>{
 const document=createInboxDocument(),old=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{value:document,configurable:true});t.after(()=>old?Object.defineProperty(globalThis,'document',old):delete globalThis.document);t.mock.method(globalThis,'setInterval',()=>0);
 const tasks=document.createElement('div'),featured=document.createElement('div'),more=document.createElement('button');document.body.replaceChildren(tasks,featured,more);
 let scopeId='original',item={itemId:'old',identity:'旧文件.md',status:'reviewable',available:true,suggestion:'旧建议.md',classification:{category:'',options:['']}};
 t.mock.method(globalThis,'fetch',async url=>({ok:true,json:async()=>url==='/api/session'?{token:'test'}:structuredClone({libraryId:'library',scopeId,items:[item]})}));
 const home=createLibraryInboxHome({tasks,featured,more,getLibrary:()=>({id:'library',valid:true}),history:()=>{}});await home.load();const selected=tasks.querySelector('article input');selected.checked=true;await selected.dispatchEvent({type:'change'});
 const name=tasks.querySelectorAll('input').find(node=>node.getAttribute('aria-label')==='归档名称 旧文件.md');name.value='未保存旧草稿.md';await name.dispatchEvent({type:'input'});
 scopeId='replacement';item={...item,itemId:'new',identity:'新文件.md',suggestion:'新建议.md'};await home.load();
 assert.equal(tasks.querySelectorAll('article').length,1);assert.equal(tasks.querySelectorAll('input').includes(name),false);assert.equal(tasks.querySelector('article input').checked,false);assert.equal(tasks.querySelectorAll('input').find(node=>node.getAttribute('aria-label')==='归档名称 新文件.md').value,'新建议.md');
});

test('后台刷新独立更新另一材料进度，保留当前输入节点、焦点、光标与勾选',async t=>{
 const document=createInboxDocument(),old=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{value:document,configurable:true});t.after(()=>old?Object.defineProperty(globalThis,'document',old):delete globalThis.document);t.mock.method(globalThis,'setInterval',()=>0);
 const tasks=document.createElement('div'),featured=document.createElement('div'),more=document.createElement('button');document.body.replaceChildren(tasks,featured,more);
 let completed=1;const items=[{itemId:'a',identity:'a.md',hash:'a',reviewVersion:0,status:'reviewable',available:true,suggestion:'建议.md',classification:{category:'',options:['']},analysis:{summary:'正文摘要'}},{itemId:'b',identity:'b.md',status:'analyzing',available:true,stage:'segment',progress:{completed:1,totalSteps:8}}];
 t.mock.method(globalThis,'fetch',async url=>url==='/api/session'?{ok:true,json:async()=>({token:'test'})}:{ok:true,json:async()=>structuredClone({libraryId:'library',items:[items[0],{...items[1],progress:{completed,totalSteps:8}}],analysisProgress:{completed:1,total:2},analysisActive:true})});
 const home=createLibraryInboxHome({tasks,featured,more,getLibrary:()=>({id:'library',valid:true}),history:()=>{}});await home.load();
 const selected=tasks.querySelector('article').querySelector('input');selected.checked=true;await selected.dispatchEvent({type:'change'});
 const name=tasks.querySelectorAll('input').find(node=>node.getAttribute('aria-label')==='归档名称 a.md');name.value='手动草稿.md';await name.dispatchEvent({type:'input'});name.focus();name.selectionStart=2;name.selectionEnd=4;
 completed=3;await home.load();
 assert.ok(tasks.querySelectorAll('input').find(node=>node.getAttribute('aria-label')==='归档名称 a.md')===name,'保留输入节点');assert.ok(document.activeElement===name,'保留焦点');assert.equal(name.selectionStart,2);assert.equal(name.selectionEnd,4);assert.equal(name.value,'手动草稿.md');assert.equal(tasks.querySelector('article').querySelector('input').checked,true);assert.match(tasks.textContent,/3\/8/);
 items[0].status='confirmed';await home.load();assert.equal(tasks.querySelectorAll('button').find(node=>node.textContent==='确认归档所选文件').disabled,true);
 items[0].status='pending';items[0].hash='changed';items[0].reviewVersion=1;await home.load();assert.ok(tasks.querySelectorAll('input').find(node=>node.getAttribute('aria-label')==='归档名称 a.md')===name);assert.equal(name.value,'手动草稿.md');assert.equal(name.disabled,false);assert.equal(tasks.querySelector('article').querySelector('input').checked,false);assert.match(tasks.textContent,/旧选择已撤销.*草稿.*重新审核/);
});

test('文件失败说明影响范围并提供手动重试，退避中的文件呈现有限尝试',async t=>{
 const document=createInboxDocument(),old=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{value:document,configurable:true});t.after(()=>old?Object.defineProperty(globalThis,'document',old):delete globalThis.document);t.mock.method(globalThis,'setInterval',()=>0);
 const tasks=document.createElement('div'),featured=document.createElement('div'),more=document.createElement('button');document.body.replaceChildren(tasks,featured,more);let starts=0;
 const items=[{itemId:'failed',identity:'失败.md',status:'failed',available:true,error:'模型鉴权失败，请修正配置后重试',failure:{scope:'model',attempts:1}},{itemId:'waiting',identity:'退避.md',status:'analyzing',available:true,stage:'segment',progress:{retry:{status:'waiting',attempt:1,maxAttempts:3}}}];
 t.mock.method(globalThis,'fetch',async(url,options)=>{if(url==='/api/session')return {ok:true,json:async()=>({token:'test'})};if(url==='/api/inbox/start'){assert.deepEqual(JSON.parse(options.body).itemIds,['failed']);starts++;items[0].status='analyzing';}return {ok:true,json:async()=>({libraryId:'library',items})};});
 const home=createLibraryInboxHome({tasks,featured,more,getLibrary:()=>({id:'library',valid:true}),history:()=>{}});await home.load();assert.match(tasks.textContent,/同模型配置.*尝试 1/);assert.match(tasks.textContent,/退避等待.*1\/3/);
 const retry=tasks.querySelectorAll('button').find(button=>button.textContent==='重试此文件');assert.ok(retry);await retry.click();assert.equal(starts,1);
});

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
  if(url==='/api/inbox/start'){assert.deepEqual(input.itemIds,['source-a']);items[0]={...items[0],reviewVersion:0,reviewBasis:{sourceHash:'a',reviewVersion:0},status:'reviewable',suggestion:'建议名称.md',analysis:{summary:'已读取的全文摘要'},classification:{category:'',options:['','001 缓存'],reason:'正文主题'},targetPath:'/raw/建议名称.md'};}
  if(url==='/api/inbox/review'){assert.equal(input.name,'人工名称.md');assert.equal(input.category,'001 缓存');assert.deepEqual(input.tags,['数据库','可靠性']);assert.deepEqual(input.reviewBasis,items[0].reviewBasis);items[0]={...items[0],reviewVersion:1,reviewBasis:{sourceHash:'a',reviewVersion:1},tags:input.tags,status:'confirmed',suggestion:input.name,classification:{...items[0].classification,category:input.category},targetPath:'/raw/001 缓存/人工名称.md'};}
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
 await button('保存所选审核').click();assert.match(tasks.textContent,/已确认待归档/);assert.equal(calls.some(call=>call.url==='/api/inbox/archive'),false);assert.equal(tasks.querySelector('article').querySelector('input').checked,true);
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
