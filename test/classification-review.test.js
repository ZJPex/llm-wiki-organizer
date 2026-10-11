import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {migrationFixture} from './helpers/migration-fixture.js';
import {listenForBrowser} from './helpers/http-server.js';
import {createApp} from '../src/server.mjs';
import {createWorkspaceService} from '../src/workspace.js';
import {createPlanningService} from '../src/planning.js';
import {createBatchService} from '../src/batches.js';
import {createInboxStrategy} from '../src/inbox.js';

async function fixture(t,{files=['跨主题'],choose,search}={}){
 const f=await migrationFixture(t),sourceRoot=path.join(f.root,'inbox'),artifactRoot=path.join(f.root,'artifacts'),configPath=path.join(f.root,'config.json'),libraryPath=f.backup.originalPath,categories=['001 缓存','002 数据库'];
 await mkdir(sourceRoot);await mkdir(artifactRoot);for(const category of categories)await mkdir(path.join(libraryPath,'raw/sources',category));
 await mkdir(path.join(f.root,'upstream/src/lib'),{recursive:true});await writeFile(path.join(f.root,'upstream/src/lib/source-watch-defaults.json'),JSON.stringify({enabled:false,autoIngest:false,includeExtensions:['.md'],excludeExtensions:[],excludeDirs:[],excludeGlobs:[]}));
 await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test'}}));
 for(const name of files)await writeFile(path.join(sourceRoot,name+'.md'),name==='标题'?'# 仅标题':`[${name}] 本文讲解缓存更新、数据库事务以及失效恢复，两类主题都涉及真实业务需求。`);
 const calls=[];
 async function start(){
  const planning=createPlanningService({stateDirectory:path.join(f.root,'planning'),generate:async(_,request)=>{
   calls.push(request);
   if(request.stage==='category-search')return search?.(request)??{candidates:categories};
   if(request.stage==='category-choice')return choose(request);
   return {title:'缓存与数据库实践',summary:request.content,evidence:[request.content.slice(0,15)],uncertain:false};
  }});
  const batches=createBatchService({planning,stateDirectory:path.join(f.root,'batches'),strategies:{inbox:createInboxStrategy()}}),workspace=createWorkspaceService({batches,stateDirectory:path.join(f.root,'settings')}),server=createApp({batches,workspace});await listenForBrowser(server);t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session')).json();
  const request=async(action,input={})=>{const response=await fetch(base+'/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)}),body=await response.json();if(!response.ok)throw Object.assign(new Error(body.error),body);return body;};
  return {request,server};
 }
 const service=await start(),saved=await service.request('workspace/save',{libraryPath,sourceRoot,artifactRoot,configPath,wikiSourcePath:path.join(f.root,'upstream')});
 const initial=await service.request('inbox/scan',{id:saved.id});await service.request('inbox/start',{id:saved.id,itemIds:initial.items.map(item=>item.itemId)});
 const read=()=>service.request('inbox/list',{id:saved.id});let ready;for(let n=0;n<200;n++){ready=await read();if(ready.items.every(item=>!['waiting','analyzing'].includes(item.status)))break;await delay(20);}assert.ok(ready.items.every(item=>!['waiting','analyzing'].includes(item.status)));
 return {...f,...service,start,id:saved.id,sourceRoot,libraryPath,ready,calls,read};
}

test('跨主题只提出一个主分类和其他主题标签，人工标签审核与归档后持久可见且不复制原文',async t=>{
 const f=await fixture(t,{choose:request=>({category:'001 缓存',decision:'existing',tags:['数据库','事务'],reason:'主要用途是缓存更新，事务为关联主题',evidence:request.content.evidence,uncertain:false})}),item=f.ready.items[0];
 assert.equal(item.classification.category,'001 缓存');assert.equal(item.classification.decision,'existing');assert.deepEqual(item.tags,['数据库','事务']);assert.equal(f.ready.suggestionProgress.complete,1);
 await f.request('inbox/review',{id:f.id,itemId:item.itemId,name:'跨主题.md',category:'001 缓存',tags:['数据库','可靠性'],manuallyEdited:true});
 assert.deepEqual((await f.read()).items[0].tags,['数据库','可靠性']);
 assert.match(await readFile(path.join(f.sourceRoot,'跨主题.md'),'utf8'),/^\[跨主题\]/);assert.deepEqual(await readdir(path.join(f.libraryPath,'raw/sources/001 缓存')),[]);
 await f.request('inbox/archive',{id:f.id,itemIds:[item.itemId],requestId:'tags-archive',approved:true,writersPaused:true});const archived=await f.read();assert.equal(archived.items[0].status,'archived');assert.deepEqual(archived.items[0].tags,['数据库','可靠性']);
 assert.deepEqual(await readdir(path.join(f.libraryPath,'raw/sources/001 缓存')),['跨主题.md']);assert.deepEqual(await readdir(path.join(f.libraryPath,'raw/sources/002 数据库')),[]);
 await new Promise(resolve=>f.server.close(resolve));const restarted=await f.start();assert.deepEqual((await restarted.request('inbox/list',{id:f.id})).items[0].tags,['数据库','可靠性']);
});

test('跨主题、缺少类别和证据不足分别呈现，完成分析不冒充完整建议，可靠正文可人工选择根分类',async t=>{
 const f=await fixture(t,{files:['跨主题','缺类','证据不足','标题'],search:request=>request.content.summary.includes('[缺类]')?{candidates:[],decision:'missing-category',reason:'现有分类仅缓存与数据库，正文主要用途未覆盖',tags:['新主题']}:undefined,choose:request=>request.content.summary.includes('[证据不足]')?{category:null,decision:'insufficient-evidence',reason:'没有足够证据确定主要用途',evidence:[],uncertain:true,tags:[]}:{category:null,decision:'cross-topic',reason:'缓存与数据库同时展开，主要用途尚不清楚',evidence:request.content.evidence,uncertain:true,tags:['缓存','数据库']}});
 const byName=name=>f.ready.items.find(item=>item.identity===name+'.md'),cross=byName('跨主题'),missing=byName('缺类'),insufficient=byName('证据不足'),title=byName('标题');
 assert.equal(cross.status,'needs-classification');assert.equal(cross.classification.decision,'cross-topic');assert.deepEqual(cross.classification.considered,['001 缓存','002 数据库']);assert.match(cross.classification.reason,/主要用途/);
 assert.equal(missing.status,'needs-classification');assert.equal(missing.classification.decision,'missing-category');assert.deepEqual(missing.classification.considered,[]);assert.match(missing.classification.reason,/未覆盖/);
 assert.equal(insufficient.classification.decision,'insufficient-evidence');assert.equal(insufficient.status,'needs-classification');assert.deepEqual(insufficient.classification.evidence,[]);
 assert.equal(title.status,'needs-information');assert.equal(title.classification.decision,'insufficient-evidence');assert.ok(!f.calls.some(call=>call.identity==='标题.md'));
 assert.equal(f.ready.suggestionProgress.complete,0);assert.equal(f.ready.suggestionProgress.needsClassification,3);assert.equal(f.ready.suggestionProgress.needsInformation,1);
 assert.equal(f.ready.analysisProgress.completed,4);assert.equal(f.ready.analysisProgress.total,4);
 await assert.rejects(f.request('inbox/review',{id:f.id,itemId:title.itemId,name:'标题.md',category:''}),{code:'REVIEW_REQUIRED'});
 await f.request('inbox/review',{id:f.id,itemId:cross.itemId,name:'跨主题.md',category:'',tags:['数据库'],manuallyEdited:true});const selected=(await f.read()).items.find(item=>item.itemId===cross.itemId);assert.equal(selected.status,'confirmed');assert.equal(selected.classification.category,'');assert.equal(selected.classification.decision,'manual');
 await f.request('inbox/archive',{id:f.id,itemIds:[cross.itemId],requestId:'manual-root',approved:true,writersPaused:true});assert.match(await readFile(path.join(f.libraryPath,'raw/sources/跨主题.md'),'utf8'),/^\[跨主题\]/);
});

test('分类响应失败单独计数且不能归档，人工非法标签不能覆盖已有有效方案',async t=>{
 const failed=await fixture(t,{choose:()=>{throw new Error('模型边界合成失败');}});
 assert.equal(failed.ready.items[0].status,'failed');assert.equal(failed.ready.suggestionProgress.complete,0);assert.equal(failed.ready.suggestionProgress.failed,1);
 await assert.rejects(failed.request('inbox/review',{id:failed.id,itemId:failed.ready.items[0].itemId,name:'跨主题.md',category:''}),{code:'REVIEW_REQUIRED'});
 const f=await fixture(t,{choose:request=>({category:'001 缓存',reason:'正文主要用途',evidence:request.content.evidence,uncertain:false})}),item=f.ready.items[0];
 assert.deepEqual(item.tags,[]);assert.equal(item.classification.decision,'existing');
 await assert.rejects(f.request('inbox/review',{id:f.id,itemId:item.itemId,name:'跨主题.md',category:'001 缓存',tags:[123]}));
 const restored=(await f.read()).items[0];assert.equal(restored.status,'reviewable');assert.deepEqual(restored.tags,[]);
});
