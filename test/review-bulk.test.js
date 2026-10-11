import test from 'node:test';
import assert from 'node:assert/strict';
import {createInboxDocument} from './helpers/page-dom.js';
import {mountReviewWorkspace} from '../public/review-workspace.js';

const visible=node=>!!node&&!node.hidden&&(!node.parentNode||visible(node.parentNode));
const source=i=>({sourceId:String(i),identity:`材料${i}.md`,currentPath:`/inbox/材料${i}.md`,hash:`hash${i}`,status:'classified',ingestStatus:'new',suggestion:`建议${i}.md`,analysis:{uncertain:false,summary:'合成摘要',evidence:['合成证据']},classification:{category:'001 分类',reason:'合成依据'}});
async function page(t,{count=2,patch={},onRequest}={}){
 const document=createInboxDocument(),requests=[],storage=new Map();
 const batch={batchId:'bulk',revision:1,phase:'file-review',libraryPath:'/library',sources:Array.from({length:count},(_,i)=>source(i)),nextCursor:null,flow:{},report:{status:'pending',hasExecution:false,counts:{total:count,succeeded:0,retained:0,blocked:0,failed:0,unverified:0,pending:count}},...patch};
 for(const [key,value] of Object.entries({document,sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)}})){const previous=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});t.after(()=>{if(previous)Object.defineProperty(globalThis,key,previous);else delete globalThis[key];});}
 t.mock.method(globalThis,'setInterval',()=>0);
 t.mock.method(globalThis,'fetch',async(url,options)=>{if(url==='/api/session')return {json:async()=>({token:'fixed'})};const body=JSON.parse(options.body);requests.push({url,body});const override=await onRequest?.(url,body,batch);return override??{ok:true,json:async()=>structuredClone({...batch,sources:batch.sources.slice(body.cursor??0,(body.cursor??0)+50),nextCursor:(body.cursor??0)+50<batch.sources.length?(body.cursor??0)+50:null})};});
 const host=document.createElement('main');document.body.append(host);const workspace=await mountReviewWorkspace(host,'bulk');
 return {document,host,batch,requests,workspace,button:label=>host.querySelectorAll('button').find(node=>node.textContent===label),input:label=>host.querySelectorAll('input').find(node=>node.getAttribute('aria-label')===label),footer:()=>host.querySelector('[aria-label="批量归档操作"]'),pause:()=>host.querySelectorAll('input').find(node=>node.type==='checkbox'&&node.parentNode.textContent.includes('我已暂停')&&visible(node))};
}

test('零选择隐藏执行栏，整批选择跨服务页与筛选保持准确数量，排除目录例外并能清空',async t=>{
 const p=await page(t,{count:53});p.batch.sources[52].directoryDependency=true;await p.workspace.refresh();
 assert.equal(visible(p.footer()),false);assert.equal(visible(p.button('选择整批正常建议')),true);
 await p.button('选择整批正常建议').click();
 assert.equal(visible(p.footer()),true);assert.match(p.footer().textContent,/52 份.*跨全部页面.*隐藏筛选项/);
 const search=p.input('按名称查找');search.value='建议0';await search.dispatchEvent({type:'input'});
 assert.match(p.footer().textContent,/52 份/);assert.equal(p.pause().checked,false);
 await p.button('清除全部选择').click();assert.equal(visible(p.footer()),false);
 assert.equal(visible(p.button('选择整批正常建议')),true);
});

test('零选择保留历史最终应用及暂停确认，确认前拒绝执行且不改走直接归档',async t=>{
 const historical={...source(0),status:'reviewed',confirmedName:'已确认.md',selected:false,ingestStatus:'historical'};
 const p=await page(t,{patch:{sources:[historical],historyPlan:{selectedCount:1,historicalCount:1,newCount:0,items:[{from:'/old.md',to:'/new.md'}],nextCursor:null},historyValidation:{status:'awaiting-apply',stage:'awaiting-apply',selectedCount:1,attemptCount:1,planHash:'plan',evidenceDigest:'proof'}}});
 assert.equal(visible(p.footer()),false);assert.equal(visible(p.button('确认应用整份已验证方案')),true);
 assert.equal(p.button('确认应用整份已验证方案').disabled,true);
 assert.ok(p.pause(),'隐藏归档栏后，历史应用仍有独立暂停写入确认');
 assert.equal(p.pause().checked,false);p.pause().checked=true;await p.pause().dispatchEvent({type:'change'});
 await p.button('确认应用整份已验证方案').click();
 assert.equal(p.requests.filter(r=>r.url.endsWith('/applyHistoryPlan')).length,1);
 assert.equal(p.requests.some(r=>r.url.endsWith('/confirmNewArchive')),false);
});

test('归档前显示目标库和随人工编辑更新的最终位置，未暂停时按钮不可执行',async t=>{
 const p=await page(t);await p.button('选择整批正常建议').click();
 assert.equal(p.button('确认并归档所选材料').disabled,true);
 await p.button('确认并归档所选材料').click();assert.equal(p.requests.some(r=>r.url.endsWith('/confirmNewArchive')),false);
 assert.match(p.footer().textContent,/当前知识库：\/library/);
 const name=p.input('新名称 材料0.md');name.value='人工标题.md';await name.dispatchEvent({type:'input'});
 const category=p.input('主分类 材料0.md');category.value='002 新分类';await category.dispatchEvent({type:'input'});
 assert.match(p.footer().textContent,/\/library\/raw\/sources\/002 新分类\/人工标题.md/);
 assert.match(p.footer().textContent,/\/library\/raw\/sources\/001 分类\/建议1.md/);
});

test('归档请求结果未知且刷新失败时保持执行锁，恢复后只读查询不会重放请求',async t=>{
 let offline=false,writes=0;
 const p=await page(t,{onRequest:async(url,body,batch)=>{
  if(url.endsWith('/confirmNewArchive')){writes++;batch.sources.forEach(s=>s.status='succeeded');batch.report={status:'complete',hasExecution:true,counts:{total:2,succeeded:2,retained:0,blocked:0,failed:0,unverified:0,pending:0}};offline=true;throw new TypeError('合成响应中断');}
  if(offline)throw new TypeError('合成读取中断');
 }});
 await p.button('选择整批正常建议').click();p.pause().checked=true;await p.pause().dispatchEvent({type:'change'});
 await p.button('确认并归档所选材料').click();
 assert.equal(p.button('确认并归档所选材料').disabled,true);assert.match(p.host.querySelector('[role="alert"]').textContent,/刷新/);
 await p.button('确认并归档所选材料').click();assert.equal(writes,1);
 offline=false;await p.button('刷新建议').click();
 assert.equal(visible(p.footer()),false);assert.equal(writes,1);assert.match(p.host.querySelector('[aria-label="归档结果"]').textContent,/成功 2/);
});

test('零选择时部分完成、失败、保留和需要恢复仍显示真实结果及恢复入口',async t=>{
 const p=await page(t,{patch:{sources:[{...source(0),status:'succeeded'}]}});
 for(const [status,label,hasExecution] of [['partial','部分完成',true],['failed','执行失败',false],['retained','材料保留原处',true],['needs-recovery','需要检查执行现场',false]]){
  p.batch.report={status,hasExecution,counts:{total:2,succeeded:1,retained:1,blocked:0,failed:0,unverified:0,pending:0}};
  await p.workspace.refresh();const results=p.host.querySelector('[aria-label="归档结果"]');
  assert.equal(visible(p.footer()),false);assert.equal(visible(results),true);assert.ok(results.textContent.includes(label));
  assert.equal(results.querySelector('a').href,'/task-report?batchId=bulk');
 }
});

test('真实页面经公共HTTP归档人工草稿，只移动所选合成材料，完成后隐藏执行栏',async t=>{
 const {inboxConfirmationFixture}=await import('./helpers/inbox-confirmation-fixture.js');
 const {mkdir,writeFile,lstat}=await import('node:fs/promises');const path=await import('node:path');
 const f=await inboxConfirmationFixture(t);await mkdir(path.join(f.root,'upstream/src/lib'),{recursive:true});await writeFile(path.join(f.root,'upstream/src/lib/source-watch-defaults.json'),JSON.stringify({enabled:false,autoIngest:false,includeExtensions:['md'],excludeExtensions:[],excludeDirs:[],excludeGlobs:[]}));
 const document=createInboxDocument(),nativeFetch=globalThis.fetch;
 for(const [key,value] of Object.entries({document,sessionStorage:{getItem:()=>null,setItem:()=>{}}})){const previous=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});t.after(()=>{if(previous)Object.defineProperty(globalThis,key,previous);else delete globalThis[key];});}
 t.mock.method(globalThis,'setInterval',()=>0);const writes=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{if(url==='/api/batches/confirmNewArchive')writes.push(JSON.parse(options.body));return nativeFetch(String(url).startsWith('/')?f.base+url:url,options);});
 const host=document.createElement('main');document.body.append(host);await mountReviewWorkspace(host,f.getBatch().batchId);
 const button=label=>host.querySelectorAll('button').find(n=>(n.getAttribute('aria-label')??n.textContent)===label);
 const input=label=>host.querySelectorAll('input').find(n=>n.getAttribute('aria-label')===label);
 await button('清除全部选择').click();await button('阅读 unnamed.md').click();
 input('新名称 unnamed.md').value='人工归档.md';await input('新名称 unnamed.md').dispatchEvent({type:'input'});
 await button('Raw 根目录').click();input('选择 unnamed.md').checked=true;await input('选择 unnamed.md').dispatchEvent({type:'change'});
 const pause=host.querySelectorAll('input').find(n=>n.type==='checkbox'&&n.parentNode.textContent.includes('我已暂停'));pause.checked=true;await pause.dispatchEvent({type:'change'});
 await button('确认并归档所选材料').click();
 assert.equal(writes.length,1);assert.equal(writes[0].items.length,1);assert.equal(writes[0].items[0].name,'人工归档.md');assert.equal(writes[0].items[0].category,'');
 await lstat(path.join(f.libraryPath,'raw/sources/人工归档.md'));await assert.rejects(lstat(path.join(f.sourceRoot,'unnamed.md')),{code:'ENOENT'});await lstat(path.join(f.sourceRoot,'a.md'));
 assert.equal(visible(host.querySelector('[aria-label="批量归档操作"]')),false);
 assert.match(host.querySelector('[aria-label="归档结果"]').textContent,/成功 1/);
});

test('批量正常建议跳过分类确认失败项，正常计数一致且保留人工合法选择',async t=>{
 const p=await page(t);p.batch.sources[0].categoryConfirmationError='目标冲突需要人工核对';p.batch.sources[0].skipReason='很长的原始保留说明'.repeat(20);await p.workspace.refresh();
 assert.match(p.host.querySelector('[aria-label="材料队列"]').textContent,/正常建议 1 份/);
 await p.button('选择整批正常建议').click();assert.match(p.footer().textContent,/1 份/);
 assert.equal(p.input('选择 材料0.md').checked,false);
 assert.equal(p.input('选择 材料0.md').disabled,false);
 const open=p.host.querySelectorAll('button').find(n=>n.getAttribute('aria-label')==='阅读 材料0.md');assert.doesNotMatch(open.textContent,/很长的原始保留说明/);
 assert.match(p.host.querySelector('[aria-label="当前材料阅读"]').textContent,/目标冲突需要人工核对/);
});

test('详情与批量范围使用同一份人工草稿最终位置，不展示旧targetPath',async t=>{
 const p=await page(t);p.batch.sources[0].targetPath='/library/raw/sources/旧位置.md';await p.workspace.refresh();
 await p.button('选择整批正常建议').click();await p.button('详情').click();
 const category=p.input('主分类 材料0.md');category.value='002 人工分类';await category.dispatchEvent({type:'input'});
 const detail=p.host.querySelector('[aria-label="材料证据详情"]');
 assert.match(detail.textContent,/\/library\/raw\/sources\/002 人工分类\/建议0.md/);
 assert.match(p.footer().textContent,/\/library\/raw\/sources\/002 人工分类\/建议0.md/);
 assert.doesNotMatch(detail.textContent,/旧位置/);
});
