import test from 'node:test';
import assert from 'node:assert/strict';
import {createInboxDocument} from './helpers/page-dom.js';

async function page(t,{libraries=[{id:'a',libraryPath:'/a',valid:true}],pages=[{records:[],nextCursor:null}],inboxItems={},create,search='',task,batchesUnavailable=false,listGate}={}){
 const document=createInboxDocument();document.body.replaceChildren();
 const add=(tag,id,parent=document.body)=>{const node=document.createElement(tag);node.id=id;parent.append(node);return node;};
 for(const id of ['title','notice','error','categories','featured','tasks','category-description','files','page-label'])add('div',id);
 for(const id of ['home','browse','settings','task-workspace','category-panel'])add('section',id);
 for(const id of ['home-nav','browse-nav','settings-nav','new-library','refresh','more','files-more'])add('button',id);
 add('select','library');const form=add('form','start');const mode=add('select','mode',form);for(const value of ['inbox','restructure']){const option=add('option','',mode);option.value=value;}add('button','',form).textContent='新建整理任务';const settingsForm=add('form','settings-form');for(const name of ['libraryPath','sourceRoot','wikiSourcePath','configPath','artifactRoot'])add('input','',settingsForm).name=name;
 // 复用轻量页面夹具，补充真实页面使用的原生方法。
 const original=document.createElement;document.createElement=tag=>{const node=original(tag);node.removeAttribute=name=>node.attributes.delete(name);return node;};
 form.removeAttribute=name=>form.attributes.delete(name);
 const location={search,href:''},calls=[];
 for(const [key,value] of Object.entries({document,location,FormData:document.FormData,sessionStorage:{getItem:()=>null,setItem:()=>{}}})){const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else delete globalThis[key];});}
 t.mock.method(globalThis,'setInterval',()=>0);
 t.mock.method(globalThis,'fetch',async(url,options)=>{const input=JSON.parse(options?.body??'{}');calls.push({url,input});let value;
 if(url==='/api/session')value={token:'fixed'};
 else if(url==='/api/workspace/list'){if(listGate)await listGate;value={libraries};}
 else if(url==='/api/workspace/save')value={id:input.id??'new',valid:true};
 else if(url==='/api/workspace/categories')value={categories:[],files:[],total:0,nextCursor:null};
 else if(url==='/api/inbox/list'||url==='/api/inbox/scan')value={libraryId:input.id,items:inboxItems[input.id]??[]};
 else if(url==='/api/inbox/history')value={libraryId:input.id,records:[]};
 else if(url==='/api/batches/get')value=task;
 else if(url==='/api/batches/list'){if(batchesUnavailable)throw new Error('合成批次读取失败');value=pages[input.cursor??0];}
 else if(url==='/api/workspace/create')return create(input);
 else throw new Error('意外请求 '+url);
 return {ok:true,json:async()=>structuredClone(value)};
 });
 await import('../public/workspace.js?test='+Math.random());
 return {document,location,calls,$:id=>document.querySelector('#'+id)};
}
const batch=(batchId,libraryPath,updatedAt,status='pending')=>({batchId,libraryPath,updatedAt,mode:'inbox',phase:'file-review',sourceRoot:libraryPath+'/inbox',counts:{total:4,classified:4},flow:{},report:{status,hasExecution:status==='complete',counts:{total:4,succeeded:status==='complete'?4:0,retained:0,blocked:0,failed:0,pending:status==='complete'?0:4,unverified:0}}});

test('专用流程的设置入口只展示设置，不创建任务或调用模型',async t=>{
 const p=await page(t,{search:'?view=settings'});
 await p.document.waitFor(()=>p.$('title').textContent==='知识库设置');
 assert.equal(p.$('home').hidden,true);assert.equal(p.$('settings-nav').getAttribute('aria-current'),'page');
 assert.equal(p.calls.some(call=>/create|analyze|confirm|apply/.test(call.url)),false);
});

test('专用流程的分类入口读取当前知识库分类，不写入材料',async t=>{
 const p=await page(t,{search:'?view=browse'});
 await p.document.waitFor(()=>p.calls.some(call=>call.url==='/api/workspace/categories'));
 assert.equal(p.$('browse').hidden,false);assert.equal(p.$('browse-nav').getAttribute('aria-current'),'page');
 assert.equal(p.calls.some(call=>/create|analyze|confirm|apply/.test(call.url)),false);
});

test('第二库刷新失败后重试保持当前库身份，刷新只调用知识库扫描',async t=>{
 const p=await page(t,{libraries:[{id:'a',libraryPath:'/a',valid:true},{id:'b',libraryPath:'/b',valid:true}],inboxItems:{b:[{itemId:'b-1',identity:'库二.md',status:'pending',available:true}]}});
 await p.document.waitFor(()=>p.$('featured').textContent.includes('未归档'));
 p.$('library').value='b';await p.$('library').dispatchEvent({type:'change'});
 const original=globalThis.fetch;let fail=true;
 t.mock.method(globalThis,'fetch',async(url,options)=>{if(url==='/api/inbox/scan'&&fail){fail=false;throw new Error('暂时断开');}return original(url,options);});
 await p.$('refresh').click();await p.$('refresh').click();
 assert.equal(p.$('library').value,'b');assert.match(p.$('tasks').textContent,/库二.md/);assert.equal(p.calls.some(call=>call.url==='/api/batches/create'),false);
});

test('历史入口跨公共分页发现当前库最近未完成记录，同更新时间稳定排序且继续只提供导航',async t=>{
 const p=await page(t,{pages:[{records:[batch('foreign','/b','2026-10-05')],nextCursor:1},{records:[batch('z','/a','2026-10-04'),batch('a','/a','2026-10-04'),batch('done','/a','2026-10-05','complete')],nextCursor:null}]});
 await p.document.waitFor(()=>p.$('featured').textContent.includes('未归档'));assert.equal(p.calls.some(call=>call.url==='/api/batches/list'),false);
 await p.$('tasks').querySelector('summary').click();
 assert.equal(p.$('tasks').querySelector('a').href,'/?batchId=a');
 assert.equal(p.$('tasks').querySelectorAll('a').some(a=>a.href.includes('foreign')),false);
 assert.equal(p.calls.some(call=>/analyze|confirm|apply/.test(call.url)),false);
});

test('切库立即清空旧文件，旧库迟到扫描不能覆盖新库',async t=>{
 const p=await page(t,{libraries:[{id:'a',libraryPath:'/a',valid:true},{id:'b',libraryPath:'/b',valid:true}],inboxItems:{a:[{itemId:'old',identity:'旧库.md',status:'pending',available:true}]}});
 await p.document.waitFor(()=>p.$('tasks').textContent.includes('旧库.md'));
 let release;const gate=new Promise(resolve=>release=resolve);t.after(()=>release());let requested=false;
 const original=globalThis.fetch;
 t.mock.method(globalThis,'fetch',async(url,options)=>{if(url==='/api/inbox/scan'&&!requested){requested=true;await gate;}return original(url,options);});
 const refreshing=p.$('refresh').click();await p.document.waitFor(()=>requested);
 p.$('library').value='b';const switching=p.$('library').dispatchEvent({type:'change'});
 assert.equal(p.$('tasks').textContent.includes('旧库.md'),false);
 await p.document.waitFor(()=>p.$('featured').textContent.includes('0 份未归档'));
 release();await refreshing;await switching;
 assert.equal(p.$('tasks').textContent.includes('旧库.md'),false);
 assert.match(p.$('featured').textContent,/0 份未归档/);
});

test('创建失败保留范围并可重试，请求中重复提交只产生一次创建且成功导航真实批次',async t=>{
 let calls=0,release;const gate=new Promise(resolve=>release=resolve);t.after(()=>release());
 const p=await page(t,{create:async input=>{calls++;assert.equal(input.id,'a');assert.equal(input.mode,'restructure');if(calls===1){await gate;return {ok:false,json:async()=>({error:'合成创建失败'})};}return {ok:true,json:async()=>({batchId:'created-real'})};}});
 await p.document.waitFor(()=>p.$('featured').textContent.includes('未归档'));
 p.$('mode').value='restructure';const first=p.$('start').requestSubmit();await p.document.waitFor(()=>calls===1);
 assert.equal(p.$('start').querySelector('button').disabled,true);
 assert.match(p.$('start').textContent,/正在创建任务/);
 await p.$('start').requestSubmit();assert.equal(calls,1);release();await first;
 assert.match(p.$('error').textContent,/合成创建失败/);assert.equal(p.$('mode').value,'restructure');
 await p.$('start').requestSubmit();assert.equal(calls,2);assert.equal(p.location.href,'/?batchId=created-real');
});

test('历史记录按本库分页，全部完成时不提供继续；加载失败清空结果后可重试',async t=>{
 const records=Array.from({length:30},(_,i)=>batch(String(i).padStart(2,'0'),'/a','2026-10-04','complete'));
 const p=await page(t,{pages:[{records,nextCursor:null}]});
 await p.document.waitFor(()=>p.$('featured').textContent.includes('未归档'));await p.$('tasks').querySelector('summary').click();
 assert.equal(p.$('tasks').querySelectorAll('a').length,25);
 await p.$('tasks').querySelectorAll('button').find(button=>button.textContent==='加载更多历史').click();assert.equal(p.$('tasks').querySelectorAll('a').length,30);
 const original=globalThis.fetch;let fail=true;
 t.mock.method(globalThis,'fetch',async(url,options)=>url==='/api/batches/list'&&fail?{ok:false,json:async()=>({error:'合成读取失败'})}:original(url,options));
 await assert.rejects(p.$('tasks').querySelector('summary').click(),/合成读取失败/);assert.equal(p.$('tasks').querySelectorAll('a').length,0);
 fail=false;await p.$('tasks').querySelector('summary').click();assert.equal(p.$('tasks').querySelectorAll('a').length,25);
});

test('未配置和失效设置不能创建任务或列出其他库任务',async t=>{
 const p=await page(t,{libraries:[{id:'broken',libraryPath:'/broken',valid:false,error:'收件箱不存在'}]});
 await p.document.waitFor(()=>p.$('notice').textContent.includes('收件箱不存在'));
 assert.equal(p.$('start').querySelector('button').disabled,true);
 assert.equal(p.calls.some(call=>call.url==='/api/batches/list'),false);
 assert.equal(p.$('settings').hidden,false);
});

test('有效历史日常分析记录继续提供待审核和原恢复导航',async t=>{
 const ready={...batch('ready','/a','2026-10-05'),phase:'analysis-complete',analysisJob:{status:'complete'},counts:{total:12,classified:11,'needs-information':1}};
 const p=await page(t,{pages:[{records:[ready],nextCursor:null}]});
 await p.document.waitFor(()=>p.$('featured').textContent.includes('未归档'));await p.$('tasks').querySelector('summary').click();
 assert.match(p.$('tasks').textContent,/待审核/);
 assert.equal(p.$('tasks').querySelector('a').href,'/?batchId=ready');
 assert.equal(p.$('tasks').querySelector('a').textContent,'继续审核');
 assert.match(p.$('tasks').textContent,/11 份可审核/);
 assert.equal(p.calls.some(call=>/analyze|confirm|apply/.test(call.url)),false);
});

test('同名知识库选项包含可区分位置，独有名称保持简短且切换正确',async t=>{
 const libraries=[{id:'a',libraryPath:'E:/工作/library',valid:true},{id:'b',libraryPath:'E:/个人/library',valid:true},{id:'c',libraryPath:'E:/个人/notes',valid:true}];
 const p=await page(t,{libraries});await p.document.waitFor(()=>p.$('featured').textContent.includes('未归档'));
 const labels=p.$('library').children.map(n=>n.textContent);
 assert.deepEqual(labels,['工作/library','个人/library','notes']);
 p.$('library').value='b';await p.$('library').dispatchEvent({type:'change'});assert.equal(p.$('library').value,'b');
});

test('首页任务与直达任务对库路径大小写、分隔符和尾斜线使用相同身份规则',async t=>{
 const task={...batch('direct','e:/wiki/','2026-10-05'),sources:[],nextCursor:null};
 const p=await page(t,{libraries:[{id:'wiki',libraryPath:'E:\\wiki',valid:true}],pages:[{records:[task],nextCursor:null}],search:'?batchId=direct&view=settings',task});
 await p.document.waitFor(()=>p.$('task-workspace').textContent.includes('整批 0 份'));
 assert.equal(p.$('error').textContent,'');assert.equal(p.$('library').value,'wiki');
 assert.equal(p.calls.some(call=>call.url==='/api/batches/list'),false);
 await p.$('home-nav').click();
 await p.$('tasks').querySelector('summary').click();
 assert.equal(p.$('tasks').querySelector('a').href,'/?batchId=direct');
});


test('批次读取失败不阻挡直达知识库设置',async t=>{
 const p=await page(t,{search:'?view=settings',batchesUnavailable:true});
 await p.document.waitFor(()=>p.$('title').textContent==='知识库设置'||p.$('error').textContent);
 assert.equal(p.$('title').textContent,'知识库设置');assert.equal(p.$('settings').hidden,false);assert.equal(p.$('home').hidden,true);
 assert.equal(p.$('library').value,'a');assert.equal(p.$('error').textContent,'');
 assert.equal(p.calls.some(call=>call.url==='/api/batches/list'),false);
});

test('批次读取失败不阻挡直达分类并显示真实分类空态',async t=>{
 const p=await page(t,{search:'?view=browse',batchesUnavailable:true});
 await p.document.waitFor(()=>p.$('files').textContent.includes('此分类暂无')||p.$('error').textContent);
 assert.equal(p.$('browse').hidden,false);assert.equal(p.$('home').hidden,true);assert.match(p.$('files').textContent,/此分类暂无 Markdown 材料/);
 assert.equal(p.$('error').textContent,'');assert.equal(p.calls.some(call=>call.url==='/api/batches/list'),false);
 assert.equal(p.calls.some(call=>call.url==='/api/workspace/categories'&&call.input.id==='a'),true);
});

test('初次库请求尚未返回时打开设置，迟到的初始化不会切回任务页',async t=>{
 let release;const listGate=new Promise(resolve=>release=resolve);
 const p=await page(t,{listGate});
 await p.document.waitFor(()=>p.calls.some(call=>call.url==='/api/workspace/list'));
 await p.$('settings-nav').click();
 assert.equal(p.$('title').textContent,'知识库设置');
 release();await p.document.waitFor(()=>p.$('notice').textContent==='● 设置已校验');
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(p.$('title').textContent,'知识库设置');assert.equal(p.$('settings').hidden,false);
 assert.equal(p.$('home').hidden,true);assert.equal(p.calls.some(call=>call.url==='/api/batches/list'),false);
});

test('加载期间打开现有设置并输入草稿，迟到环境只补未编辑字段并保留编辑身份',async t=>{
 let release;const listGate=new Promise(resolve=>release=resolve);t.after(()=>release());
 const record={id:'a',revision:7,libraryPath:'/existing',sourceRoot:'/existing-inbox',valid:true};
 const p=await page(t,{libraries:[record],listGate});await p.$('settings-nav').click();
 const inputs=p.$('settings-form').querySelectorAll('input'),library=inputs.find(n=>n.name==='libraryPath');library.value='/人工草稿';await library.dispatchEvent({type:'input'});
 release();await p.document.waitFor(()=>p.$('library').value==='a');
 assert.equal(library.value,'/人工草稿');assert.equal(inputs.find(n=>n.name==='sourceRoot').value,'/existing-inbox');
 await p.$('settings-form').requestSubmit();const saved=p.calls.find(c=>c.url==='/api/workspace/save').input;
 assert.equal(saved.id,'a');assert.equal(saved.revision,7);assert.equal(saved.libraryPath,'/人工草稿');
});

test('加载期间选择新增知识库，迟到环境不能填入旧设置或把新增变成编辑',async t=>{
 let release;const listGate=new Promise(resolve=>release=resolve);t.after(()=>release());
 const p=await page(t,{libraries:[{id:'old',revision:3,libraryPath:'/old',sourceRoot:'/old-inbox',valid:true}],listGate});
 await p.$('settings-nav').click();await p.$('new-library').click();
 const inputs=p.$('settings-form').querySelectorAll('input'),library=inputs.find(n=>n.name==='libraryPath');library.value='/new-draft';await library.dispatchEvent({type:'input'});
 release();await p.document.waitFor(()=>p.$('library').value==='old');
 assert.equal(library.value,'/new-draft');assert.equal(inputs.find(n=>n.name==='sourceRoot').value,'');
 await p.$('settings-form').requestSubmit();const saved=p.calls.find(c=>c.url==='/api/workspace/save').input;
 assert.equal(saved.id,undefined);assert.equal(saved.revision,undefined);assert.equal(saved.libraryPath,'/new-draft');
});

test('加载期间打开设置但未编辑时仍补齐真实设置及当前记录身份',async t=>{
 let release;const listGate=new Promise(resolve=>release=resolve);t.after(()=>release());
 const p=await page(t,{libraries:[{id:'a',revision:9,libraryPath:'/a',sourceRoot:'/inbox',valid:true}],listGate});
 await p.$('settings-nav').click();release();await p.document.waitFor(()=>p.$('library').value==='a');
 assert.equal(p.$('settings-form').querySelectorAll('input').find(n=>n.name==='sourceRoot').value,'/inbox');
 await p.$('settings-form').requestSubmit();const saved=p.calls.find(c=>c.url==='/api/workspace/save').input;
 assert.equal(saved.id,'a');assert.equal(saved.revision,9);
});
