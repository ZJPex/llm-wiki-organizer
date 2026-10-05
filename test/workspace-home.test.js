import test from 'node:test';
import assert from 'node:assert/strict';
import {createInboxDocument} from './helpers/page-dom.js';

async function page(t,{libraries=[{id:'a',libraryPath:'/a',valid:true}],pages=[{records:[],nextCursor:null}],create}={}){
 const document=createInboxDocument();document.body.replaceChildren();
 const add=(tag,id,parent=document.body)=>{const node=document.createElement(tag);node.id=id;parent.append(node);return node;};
 for(const id of ['title','notice','error','categories','featured','tasks','category-description','files','page-label'])add('div',id);
 for(const id of ['home','browse','settings','task-workspace','category-panel'])add('section',id);
 for(const id of ['home-nav','browse-nav','settings-nav','new-library','refresh','more','files-more'])add('button',id);
 add('select','library');const form=add('form','start');const mode=add('select','mode',form);for(const value of ['inbox','restructure']){const option=add('option','',mode);option.value=value;}add('button','',form).textContent='新建整理任务';add('form','settings-form');
 // 复用轻量页面夹具，补充真实页面使用的原生方法。
 const original=document.createElement;document.createElement=tag=>{const node=original(tag);node.removeAttribute=name=>node.attributes.delete(name);return node;};
 form.removeAttribute=name=>form.attributes.delete(name);
 const location={search:'',href:''},calls=[];
 for(const [key,value] of Object.entries({document,location})){const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else delete globalThis[key];});}
 t.mock.method(globalThis,'fetch',async(url,options)=>{const input=JSON.parse(options?.body??'{}');calls.push({url,input});let value;
 if(url==='/api/session')value={token:'fixed'};
 else if(url==='/api/workspace/list')value={libraries};
 else if(url==='/api/workspace/categories')value={categories:[],files:[],total:0,nextCursor:null};
 else if(url==='/api/batches/list')value=pages[input.cursor??0];
 else if(url==='/api/workspace/create')return create(input);
 else throw new Error('意外请求 '+url);
 return {ok:true,json:async()=>structuredClone(value)};
 });
 await import('../public/workspace.js?test='+Math.random());
 return {document,location,calls,$:id=>document.querySelector('#'+id)};
}
const batch=(batchId,libraryPath,updatedAt,status='pending')=>({batchId,libraryPath,updatedAt,mode:'inbox',phase:'file-review',sourceRoot:libraryPath+'/inbox',counts:{total:4,classified:4},flow:{},report:{status,hasExecution:status==='complete',counts:{total:4,succeeded:status==='complete'?4:0,retained:0,blocked:0,failed:0,pending:status==='complete'?0:4,unverified:0}}});

test('第二库任务刷新失败后重试保持当前库身份',async t=>{
 const p=await page(t,{libraries:[{id:'a',libraryPath:'/a',valid:true},{id:'b',libraryPath:'/b',valid:true}],pages:[{records:[batch('库一','/a','2026-10-05'),batch('库二','/b','2026-10-05')],nextCursor:null}]});
 await p.document.waitFor(()=>p.$('featured').textContent.includes('继续审核'));
 p.$('library').value='b';await p.$('library').dispatchEvent({type:'change'});
 const original=globalThis.fetch;let fail=true;
 t.mock.method(globalThis,'fetch',async(url,options)=>{if(url==='/api/batches/list'&&fail){fail=false;throw new Error('暂时断开');}return original(url,options);});
 await p.$('refresh').click();await p.$('refresh').click();
 assert.equal(p.$('library').value,'b');assert.match(p.$('featured').querySelector('a').href,/batchId=%E5%BA%93%E4%BA%8C/);
});

test('首页跨公共分页发现当前库最近未完成任务，同更新时间稳定排序且继续只提供导航',async t=>{
 const p=await page(t,{pages:[{records:[batch('foreign','/b','2026-10-05')],nextCursor:1},{records:[batch('z','/a','2026-10-04'),batch('a','/a','2026-10-04'),batch('done','/a','2026-10-05','complete')],nextCursor:null}]});
 await p.document.waitFor(()=>p.$('featured').textContent.includes('继续审核'));
 assert.equal(p.$('featured').querySelector('a').href,'/?batchId=a');
 assert.equal(p.$('tasks').querySelectorAll('a').some(a=>a.href.includes('foreign')),false);
 assert.equal(p.calls.some(call=>/analyze|confirm|apply/.test(call.url)),false);
});

test('切库立即清空旧任务，旧库迟到响应不能覆盖新库；没有未完成任务时只显示引导',async t=>{
 const p=await page(t,{libraries:[{id:'a',libraryPath:'/a',valid:true},{id:'b',libraryPath:'/b',valid:true}],pages:[{records:[batch('old','/a','2026-10-04'),batch('finished','/b','2026-10-05','complete')],nextCursor:null}]});
 await p.document.waitFor(()=>p.$('featured').textContent.includes('继续审核'));
 let release;const gate=new Promise(resolve=>release=resolve);t.after(()=>release());let requested=false;
 const original=globalThis.fetch;
 t.mock.method(globalThis,'fetch',async(url,options)=>{if(url==='/api/batches/list'&&!requested){requested=true;await gate;}return original(url,options);});
 const refreshing=p.$('refresh').click();await p.document.waitFor(()=>requested);
 p.$('library').value='b';const switching=p.$('library').dispatchEvent({type:'change'});
 assert.equal(p.$('featured').textContent.includes('继续审核'),false);
 await p.document.waitFor(()=>p.$('featured').textContent.includes('所有任务均已完成'));
 release();await refreshing;await switching;
 assert.equal(p.$('tasks').querySelectorAll('a').some(a=>a.href.includes('old')),false);
 assert.match(p.$('featured').textContent,/所有任务均已完成/);
});

test('创建失败保留范围并可重试，请求中重复提交只产生一次创建且成功导航真实批次',async t=>{
 let calls=0,release;const gate=new Promise(resolve=>release=resolve);t.after(()=>release());
 const p=await page(t,{create:async input=>{calls++;assert.equal(input.id,'a');assert.equal(input.mode,'restructure');if(calls===1){await gate;return {ok:false,json:async()=>({error:'合成创建失败'})};}return {ok:true,json:async()=>({batchId:'created-real'})};}});
 await p.document.waitFor(()=>p.$('featured').textContent.includes('还没有整理任务'));
 p.$('mode').value='restructure';const first=p.$('start').requestSubmit();await p.document.waitFor(()=>calls===1);
 assert.equal(p.$('start').querySelector('button').disabled,true);
 assert.match(p.$('start').textContent,/正在创建任务/);
 await p.$('start').requestSubmit();assert.equal(calls,1);release();await first;
 assert.match(p.$('error').textContent,/合成创建失败/);assert.equal(p.$('mode').value,'restructure');
 await p.$('start').requestSubmit();assert.equal(calls,2);assert.equal(p.location.href,'/?batchId=created-real');
});

test('任务列表按本库分页，全部完成时不提供继续任务；刷新失败清空结果后可重试',async t=>{
 const records=Array.from({length:30},(_,i)=>batch(String(i).padStart(2,'0'),'/a','2026-10-04','complete'));
 const p=await page(t,{pages:[{records,nextCursor:null}]});
 await p.document.waitFor(()=>p.$('featured').textContent.includes('所有任务均已完成'));
 assert.equal(p.$('tasks').querySelectorAll('a').length,25);assert.equal(p.$('more').hidden,false);
 await p.$('more').click();assert.equal(p.$('tasks').querySelectorAll('a').length,30);assert.equal(p.$('more').hidden,true);
 const original=globalThis.fetch;let fail=true;
 t.mock.method(globalThis,'fetch',async(url,options)=>url==='/api/batches/list'&&fail?{ok:false,json:async()=>({error:'合成读取失败'})}:original(url,options));
 await p.$('refresh').click();assert.equal(p.$('tasks').querySelectorAll('a').length,0);assert.match(p.$('error').textContent,/合成读取失败/);
 fail=false;await p.$('refresh').click();assert.equal(p.$('tasks').querySelectorAll('a').length,25);
});

test('未配置和失效设置不能创建任务或列出其他库任务',async t=>{
 const p=await page(t,{libraries:[{id:'broken',libraryPath:'/broken',valid:false,error:'收件箱不存在'}]});
 await p.document.waitFor(()=>p.$('notice').textContent.includes('收件箱不存在'));
 assert.equal(p.$('start').querySelector('button').disabled,true);
 assert.equal(p.calls.some(call=>call.url==='/api/batches/list'),false);
 assert.equal(p.$('settings').hidden,false);
});

test('日常分析完成且已有可审核建议时，首页和列表显示待审核并仅导航继续审核',async t=>{
 const ready={...batch('ready','/a','2026-10-05'),phase:'analysis-complete',analysisJob:{status:'complete'},counts:{total:12,classified:11,'needs-information':1}};
 const p=await page(t,{pages:[{records:[ready],nextCursor:null}]});
 await p.document.waitFor(()=>p.$('tasks').querySelectorAll('a').length===2);
 assert.match(p.$('featured').textContent,/待审核/);
 assert.equal(p.$('featured').querySelector('a').textContent,'继续审核');
 assert.equal(p.$('featured').querySelector('a').href,'/?batchId=ready');
 assert.equal(p.$('tasks').querySelector('a').textContent,'继续审核');
 assert.match(p.$('tasks').textContent,/11 份可审核/);
 assert.equal(p.calls.some(call=>/analyze|confirm|apply/.test(call.url)),false);
});
