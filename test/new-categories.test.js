import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {migrationFixture} from './helpers/migration-fixture.js';
import {listenForBrowser} from './helpers/http-server.js';
import {httpFixtureScope} from './helpers/http-fixture-scope.js';
import {createApp} from '../src/server.mjs';
import {createWorkspaceService} from '../src/workspace.js';
import {createPlanningService} from '../src/planning.js';
import {createBatchService} from '../src/batches.js';
import {createInboxStrategy} from '../src/inbox.js';

async function fixture(t,{files=['跨主题'],choose,search,propose,checkpoint,categories=['001 缓存','002 数据库']}={}){
 const f=await migrationFixture(t,{retained:true}),scope=httpFixtureScope(t,f.root),sourceRoot=path.join(f.root,'inbox'),artifactRoot=path.join(f.root,'artifacts'),configPath=path.join(f.root,'config.json'),libraryPath=f.backup.originalPath;
 await mkdir(sourceRoot);await mkdir(artifactRoot);for(const category of categories)await mkdir(path.join(libraryPath,'raw/sources',category));
 await mkdir(path.join(f.root,'upstream/src/lib'),{recursive:true});await writeFile(path.join(f.root,'upstream/src/lib/source-watch-defaults.json'),JSON.stringify({enabled:false,autoIngest:false,includeExtensions:['.md'],excludeExtensions:[],excludeDirs:[],excludeGlobs:[]}));
 await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test'}}));
 for(const name of files)await writeFile(path.join(sourceRoot,name+'.md'),name==='标题'?'# 仅标题':`[${name}] 本文讲解缓存更新、数据库事务以及失效恢复，两类主题都涉及真实业务需求。`);
 const calls=[];
 async function start(){
  const planning=createPlanningService({stateDirectory:path.join(f.root,'planning'),generate:async(_,request)=>{
   calls.push({...request,budget:planning.modelConcurrency.snapshot()});
   if(request.stage==='category-search')return search?.(request)??{candidates:categories};
   if(request.stage==='category-choice')return choose(request);
   if(request.stage==='new-category')return propose?.(request)??{};
   return {title:'缓存与数据库实践',summary:request.content,evidence:[request.content.slice(0,15)],uncertain:false};
  }});
  const batches=createBatchService({planning,stateDirectory:path.join(f.root,'batches'),strategies:{inbox:createInboxStrategy({checkpoint})}}),workspace=createWorkspaceService({batches,stateDirectory:path.join(f.root,'settings')}),server=createApp({batches,workspace});scope.add(server);await listenForBrowser(server);
  const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session',{signal:AbortSignal.timeout(15000)})).json();
  const request=async(action,input={})=>{const response=await fetch(base+'/api/'+action,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)}),body=await response.json();if(!response.ok)throw Object.assign(new Error(body.error),body);return body;};
  return {request,server};
 }
 const service=await start(),saved=await service.request('workspace/save',{libraryPath,sourceRoot,artifactRoot,configPath,wikiSourcePath:path.join(f.root,'upstream')});
 const initial=await service.request('inbox/scan',{id:saved.id});await service.request('inbox/start',{id:saved.id,itemIds:initial.items.map(item=>item.itemId)});
 const read=()=>service.request('inbox/list',{id:saved.id});let ready;for(let n=0;n<200;n++){ready=await read();if(ready.items.every(item=>!['waiting','analyzing'].includes(item.status)))break;await delay(20);}assert.ok(ready.items.every(item=>!['waiting','analyzing'].includes(item.status)));
 return {...f,...service,start,close:scope.close,id:saved.id,sourceRoot,libraryPath,ready,calls,read};
}

test('首份材料提出完整编号子类，审核无写入，明确确认归档才创建类别与移动来源',async t=>{
 const f=await fixture(t,{files:['新主题'],search:()=>({candidates:[],decision:'missing-category',reason:'现有类别缺少缓存一致性归属'}),propose:()=>({proposal:{parent:'001 缓存',label:'一致性',reason:'正文专门比较缓存一致性策略',benefit:'在缓存下直接查找一致性实践'}})}),item=f.ready.items[0];
 assert.equal(item.classification.newCategory.path,'001 缓存/001.01 一致性');assert.equal(item.status,'reviewable');
 const newCall=f.calls.find(call=>call.stage==='new-category');assert.equal(newCall.budget.active,1);assert.equal(newCall.budget.unit,'organizer-model-calls');
 assert.deepEqual(await readdir(path.join(f.libraryPath,'raw/sources/001 缓存')),[]);
 await assert.rejects(f.request('inbox/review',{id:f.id,itemId:item.itemId,name:'新主题.md',category:item.classification.category}));
 await f.request('inbox/review',{id:f.id,itemId:item.itemId,name:'新主题.md',category:item.classification.category,acceptNewCategory:true,newCategoryHash:item.classification.newCategory.proposalHash});
 assert.deepEqual(await readdir(path.join(f.libraryPath,'raw/sources/001 缓存')),[]);assert.match(await readFile(path.join(f.sourceRoot,'新主题.md'),'utf8'),/新主题/);
 const archived=await f.request('inbox/archive',{id:f.id,itemIds:[item.itemId],requestId:'first-new-category',approved:true,writersPaused:true});assert.equal(archived.items[0].status,'archived');
 const directory=path.join(f.libraryPath,'raw/sources/001 缓存/001.01 一致性');assert.deepEqual((await readdir(directory)).sort(),['.category.json','新主题.md']);
 assert.match((await readFile(path.join(directory,'.category.json'),'utf8')),/直接查找/);
});

const missing=()=>({candidates:[],decision:'missing-category',reason:'现有类别缺少对应主题'});
const proposed=()=>({proposal:{parent:'',label:'分布式一致性',reason:'正文主要比较一致性策略',benefit:'直接查找分布式一致性资料'}});
const reviewNew=(f,item)=>f.request('inbox/review',{id:f.id,itemId:item.itemId,name:item.identity,category:item.classification.category,acceptNewCategory:true,newCategoryHash:item.classification.newCategory.proposalHash});

test('多份材料协调同一个顶层提议和编号，重复授权不重复建类，同次授权只归档选中材料',async t=>{
 const f=await fixture(t,{files:['第一份','第二份','未选中'],search:missing,propose:proposed});
 const proposals=f.ready.items.map(item=>item.classification.newCategory);assert.equal(new Set(proposals.map(item=>item.proposalHash)).size,1);assert.equal(proposals[0].path,'003 分布式一致性');
 for(const item of f.ready.items)await reviewNew(f,item);
 const chosen=f.ready.items.filter(item=>item.identity!=='未选中.md'),input={id:f.id,itemIds:chosen.map(item=>item.itemId),requestId:'shared-proposal',approved:true,writersPaused:true};
 await f.request('inbox/archive',input);await f.request('inbox/archive',input);const result=await f.read();assert.equal(result.items.filter(item=>item.status==='archived').length,2);
 assert.deepEqual((await readdir(path.join(f.libraryPath,'raw/sources/003 分布式一致性'))).sort(),['.category.json','第一份.md','第二份.md']);assert.match(await readFile(path.join(f.sourceRoot,'未选中.md'),'utf8'),/未选中/);
 await assert.rejects(reviewNew(f,result.items.find(item=>item.identity==='未选中.md')));assert.notEqual((await f.read()).items.find(item=>item.identity==='未选中.md').status,'archived');
});

test('同义分类优先复用，不为首份材料重复创建已有类别，调整提示不执行历史目录改名',async t=>{
 const f=await fixture(t,{files:['首份'],search:missing,propose:()=>({proposal:{parent:'',label:'缓存',reason:'同义名称可直接归属',benefit:'沿用既有缓存入口'},adjustments:[{type:'rename',from:'002 数据库',to:'数据库技术',reason:'已有名称需统一，影响其历史材料',benefit:'统一查找术语'}]})}),item=f.ready.items[0];
 assert.equal(item.classification.category,'001 缓存');assert.equal(item.classification.decision,'existing');assert.equal(item.classification.newCategory,undefined);assert.equal(item.classification.adjustments[0].requiresHistoryValidation,true);
 await f.request('inbox/review',{id:f.id,itemId:item.itemId,name:'首份.md',category:'001 缓存'});await f.request('inbox/archive',{id:f.id,itemIds:[item.itemId],requestId:'existing-alias',approved:true,writersPaused:true});
 assert.deepEqual((await readdir(path.join(f.libraryPath,'raw/sources'))).sort(),['001 缓存','002 数据库','old.md']);
});

test('分类落地失败保留两份来源与持久证据，重启后只经公开恢复入口完成失败依赖',async t=>{
 let interrupted=true;const f=await fixture(t,{files:['第一份','第二份'],search:missing,propose:proposed,checkpoint:async stage=>{if(stage==='category-created'&&interrupted){interrupted=false;throw new Error('合成类别落地中断');}}});
 for(const item of f.ready.items)await reviewNew(f,item);
 await f.request('inbox/archive',{id:f.id,itemIds:f.ready.items.map(item=>item.itemId),requestId:'interrupted-category',approved:true,writersPaused:true});
 const page=await f.request('batches/list'),batch=await f.request('batches/get',{batchId:page.records[0].batchId}),report=await f.request('batches/getReport',{batchId:batch.batchId});
 assert.equal(report.counts.succeeded,0);assert.equal(report.counts.failed,1);assert.match(await readFile(path.join(f.sourceRoot,'第一份.md'),'utf8'),/第一份/);assert.match(await readFile(path.join(f.sourceRoot,'第二份.md'),'utf8'),/第二份/);
 const evidence=report.evidence.find(item=>item.archiveJournalPath),journal=JSON.parse(await readFile(evidence.archiveJournalPath,'utf8'));assert.equal(journal.status,'failed');assert.equal(journal.newCategories[0].proposalHash,f.ready.items[0].classification.newCategory.proposalHash);assert.ok(journal.categoryEvents.some(item=>item.status==='created'));
 await f.close(f.server);const restarted=await f.start(),current=await restarted.request('batches/get',{batchId:batch.batchId});
 await restarted.request('batches/applySlice',{batchId:batch.batchId,revision:current.revision,sliceId:evidence.sliceId,approved:true,writersPaused:true});
 const recovered=await restarted.request('batches/getReport',{batchId:batch.batchId});assert.equal(recovered.counts.succeeded,1);const originalFailed=batch.sources.find(item=>item.sourceId===journal.items[0].sourceId);assert.match(await readFile(path.join(f.libraryPath,'raw/sources/003 分布式一致性',originalFailed.identity),'utf8'),/本文/);const retained=batch.sources.find(item=>item.sourceId!==originalFailed.sourceId);assert.match(await readFile(path.join(f.sourceRoot,retained.identity),'utf8'),/本文/);
});

test('审核后的分类占用冲突保留来源，任意路径与篡改提议摘要不能取得新增授权',async t=>{
 const f=await fixture(t,{files:['冲突'],search:missing,propose:proposed}),item=f.ready.items[0];
 await assert.rejects(f.request('inbox/review',{id:f.id,itemId:item.itemId,name:'冲突.md',category:'../任意',acceptNewCategory:true,newCategoryHash:item.classification.newCategory.proposalHash}));
 await assert.rejects(f.request('inbox/review',{id:f.id,itemId:item.itemId,name:'冲突.md',category:item.classification.category,acceptNewCategory:true,newCategoryHash:'wrong'}));
 await reviewNew(f,item);await mkdir(path.join(f.libraryPath,'raw/sources/003 分布式一致性'));
 await f.request('inbox/archive',{id:f.id,itemIds:[item.itemId],requestId:'occupied-category',approved:true,writersPaused:true});
 assert.match(await readFile(path.join(f.sourceRoot,'冲突.md'),'utf8'),/冲突/);assert.deepEqual(await readdir(path.join(f.libraryPath,'raw/sources/003 分布式一致性')),[]);assert.equal((await f.read()).items.filter(item=>item.status==='archived').length,0);
});

test('不同新主题保留互不冲突编号，选已有类别不会顺带接受另一个新增提议',async t=>{
 const f=await fixture(t,{files:['主题A','主题B'],search:missing,propose:request=>({proposal:{parent:'',label:request.content.summary.includes('[主题A]')?'消息队列':'复制协议',reason:'正文有独立用途',benefit:'沿独立主题查找实践'}})});
 const categories=f.ready.items.map(item=>item.classification.category);assert.equal(new Set(categories).size,2);assert.deepEqual(categories.map(category=>category.slice(0,3)).sort(),['003','004']);
 const item=f.ready.items[0];await f.request('inbox/review',{id:f.id,itemId:item.itemId,name:item.identity,category:'001 缓存'});const saved=(await f.read()).items.find(value=>value.itemId===item.itemId);assert.equal(saved.classification.newCategoryAccepted,false);
 await f.request('inbox/archive',{id:f.id,itemIds:[item.itemId],requestId:'choose-existing',approved:true,writersPaused:true});assert.deepEqual((await readdir(path.join(f.libraryPath,'raw/sources'))).sort(),['001 缓存','002 数据库','old.md']);
});

