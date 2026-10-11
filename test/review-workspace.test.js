import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,lstat,unlink} from 'node:fs/promises';
import path from 'node:path';
import {migrationFixture} from './helpers/migration-fixture.js';
import {listenForBrowser} from './helpers/http-server.js';
import {createPlanningService} from '../src/planning.js';
import {createInboxStrategy} from '../src/inbox.js';
import {createBatchService} from '../src/batches.js';
import {createApp} from '../src/server.mjs';

test('公开集中审核：无需确认名即可跨页分类，一次保存手改名称和分类，例外及旧确认名稳定且不移动',async t=>{
 const f=await migrationFixture(t),libraryPath=f.backup.originalPath,sourceRoot=path.join(f.root,'review-inbox'),artifactRoot=path.join(f.root,'review-artifacts');
 await mkdir(sourceRoot);await mkdir(artifactRoot);await mkdir(path.join(libraryPath,'raw/sources/001 缓存'));
 for(let i=0;i<22;i++)await writeFile(path.join(sourceRoot,`材料${String(i).padStart(2,'0')}.md`),'材料正文讨论缓存一致性、索引维护和失败恢复的具体工程设计。');
 await writeFile(path.join(sourceRoot,'无正文.md'),'# 标题');
 const configPath=path.join(f.root,'review-config.json');await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test'}}));
 const planning=createPlanningService({stateDirectory:path.join(f.root,'review-planning'),generate:async(_,r)=>{
  if(r.stage==='category-search')return {candidates:['','001 缓存']};
  if(r.stage==='category-choice'){assert.ok(r.content.summary.includes('缓存一致性'));return {category:'001 缓存',reason:'全文证据',evidence:r.content.evidence,uncertain:false};}
  return {title:r.identity.replace('.md','')+'缓存实践',summary:r.content,evidence:[r.content],uncertain:false};
 }});
 const server=createApp({batches:createBatchService({stateDirectory:path.join(f.root,'review-batches'),planning,strategies:{inbox:createInboxStrategy()}})});await listenForBrowser(server);t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session')).json();let batch;
 const call=async(action,extra={})=>{const res=await fetch(base+'/api/batches/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify({batchId:batch?.batchId,revision:batch?.revision,...extra})});const value=await res.json();if(!res.ok)throw new Error(value.error);batch=value;return value;};
 await call('create',{mode:'inbox',libraryPath,sourceRoot,artifactRoot,configPath,wikiSourcePath:path.join(f.root,'upstream')});for(let i=0;i<5;i++)await call('analyzeNext',{limit:5});
 const all=await call('get',{limit:50}),sources=all.sources.filter(s=>s.status==='classified');assert.equal(sources.length,22);assert.equal(sources[0].confirmedName,null);assert.equal(sources[0].classification.category,'001 缓存');
 const first=sources[0];
 const occupied=path.join(libraryPath,'raw/sources/占用.md');await writeFile(occupied,'保留已有内容');
 await assert.rejects(call('confirmPlans',{items:[{sourceId:first.sourceId,name:'占用.md',category:''}]}),/存在/);await call('get');assert.equal(batch.sources.find(s=>s.sourceId===first.sourceId).confirmedName,null);assert.equal(await readFile(occupied,'utf8'),'保留已有内容');await unlink(occupied);
 await call('confirmPlans',{items:[{sourceId:first.sourceId,name:'人工名称.md',category:'',manuallyEdited:true}]});
 const saved=batch.sources.find(s=>s.sourceId===first.sourceId);assert.equal(saved.confirmedName,'人工名称.md');assert.equal(saved.classification.category,'');assert.equal(saved.manuallyEdited,true);
 const small=await call('get',{limit:1});assert.equal(small.sources.length,1);
 await call('confirmPlans',{items:sources.slice(1).map(s=>({sourceId:s.sourceId,name:s.suggestion,category:s.classification.category}))});
 assert.equal(batch.counts.reviewed,22);assert.equal(batch.counts['needs-information'],1);assert.equal(batch.slices.length,0);
 for(const s of batch.sources.filter(s=>s.status==='reviewed')){assert.match(await readFile(s.currentPath,'utf8'),/缓存一致性/);await assert.rejects(lstat(s.targetPath),{code:'ENOENT'});}
 const low=batch.sources.find(s=>s.status==='needs-information');await assert.rejects(call('confirmPlans',{items:[{sourceId:low.sourceId,name:'猜测.md',category:''}]}),/证据不足/);await call('get');
 const stable=await planning.analyze({sourceRoot,libraryPath,identity:first.identity,configPath,reanalyze:true});assert.equal(stable.confirmedName,'人工名称.md');assert.equal(stable.suggestion,null);
 assert.equal(batch.sources.find(s=>s.sourceId===first.sourceId).confirmedName,'人工名称.md');
});

test('先打开待分析任务：新建议同步非手动草稿，分页刷新保留手改，源内容变化清除陈旧选择',async()=>{
 const {reconcileReviewDraft}=await import('../public/review-workspace.js');
 const source={hash:'one',status:'pending'};let draft=reconcileReviewDraft(source);assert.equal(draft.name,'');
 Object.assign(source,{suggestion:'正文主题.md',classification:{category:'001 缓存'}});draft=reconcileReviewDraft(source,draft);assert.equal(draft.name,'正文主题.md');assert.equal(draft.category,'001 缓存');
 Object.assign(draft,{manual:true,name:'人工.md',category:'',selected:true});assert.deepEqual(reconcileReviewDraft(source,draft),draft);
 const changed=reconcileReviewDraft({...source,hash:'two'},draft);assert.equal(changed.selected,false);assert.equal(changed.manual,true);assert.equal(changed.name,'人工.md');assert.equal(changed.invalidated,true);
 const reviewed={hash:'saved',status:'reviewed',selected:true,confirmedName:'已审核.md',classification:{category:'001 缓存'}};
 const restored=reconcileReviewDraft(reviewed);assert.equal(restored.selected,true);assert.equal(restored.name,'已审核.md');
 restored.selected=false;assert.equal(reconcileReviewDraft(reviewed,restored).selected,false);
});

test('无实际目录操作的确认不阻断集中接受，已排除材料继续保留',async t=>{
 const {inboxConfirmationFixture}=await import('./helpers/inbox-confirmation-fixture.js');const f=await inboxConfirmationFixture(t);
 const source=f.getBatch().sources.find(s=>s.identity==='a.md');await f.call('reviewItem',{sourceId:source.sourceId,action:'evolve',category:'001 缓存'});await f.call('reviewItem',{sourceId:source.sourceId,action:'confirmEvolution'});
 await f.call('confirmPlans',{items:[{sourceId:source.sourceId,name:'a.md',category:'001 缓存'}]});
 const state=await f.call('get');assert.equal(state.sources.find(s=>s.identity==='excluded.md').status,'excluded');assert.equal(state.sources.find(s=>s.sourceId===source.sourceId).selected,true);
});
