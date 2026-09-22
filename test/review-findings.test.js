import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,rm,writeFile,mkdir,lstat} from 'node:fs/promises';
import {executionBlock} from '../src/execution-state.js';
import {evolutionTouches} from '../src/directory-dependencies.js';
import {createBatchStore} from '../src/batch-store.js';
import {createBatchService} from '../src/batches.js';
import {createApp} from '../src/server.mjs';
import {listenForBrowser} from './helpers/http-server.js';
import {inboxConfirmationFixture} from './helpers/inbox-confirmation-fixture.js';
import {reviewAnalysisActions} from '../public/review-workspace.js';
import {renderHistoryActions} from '../public/history-actions.js';

test('执行守卫保留各动作对终态、授权、日志及失败的原有边界',()=>{
 const cases=[['prepared',{},[false,false,false,true]],['authorized',{},[false,false,true,true]],['applying',{},[true,true,true,true]],['failed',{},[false,false,false,true]],['failed',{originalJournalPath:'log'},[false,true,false,true]],['failed',{archiveResult:{}},[true,true,true,true]],['complete',{archiveResult:{}},[false,false,false,false]],['complete',{originalResultPath:'result'},[false,false,true,false]],['cancelled',{archiveResult:{}},[true,true,false,false]]];
 for(const [status,evidence,expected] of cases)assert.deepEqual(['review','refresh','history','archive'].map(action=>!!executionBlock({flow:{},slices:[{status,...evidence}]},action)),expected,status+JSON.stringify(evidence));
 for(const status of ['running','needs-recovery','interrupted'])assert.equal(executionBlock({flow:{historyApplication:{status}},slices:[]},'refresh'),'application');
 for(const status of ['complete','failed'])assert.equal(executionBlock({flow:{historyApplication:{status}},slices:[]},'refresh'),null);
});

test('未冻结建议使用真实目录编译识别目标与跨目录文件，缺少证据保持阻断',()=>{
 const root=path.resolve('category-fixture'),scope={sourcePath:path.join(root,'other/unrelated.md'),targetPath:path.join(root,'001 缓存/independent.md'),categoryRoot:root};
 const proposal={catalog:{root,categories:[{path:'',aliases:[]},{path:'001 缓存',aliases:[]}]},baseline:{files:[{path:'old.md',hash:'old'}]},operations:[{type:'add',parent:'',label:'新主题',files:['old.md'],problem:'不同主题',benefit:'便于查找'}]};
 assert.equal(evolutionTouches(proposal,scope),false);
 assert.equal(evolutionTouches(proposal,{...scope,sourcePath:path.join(root,'old.md')}),true);
 assert.equal(evolutionTouches(proposal,{...scope,targetPath:path.join(root,'002 新主题/new.md')}),true);
 assert.equal(evolutionTouches({operations:proposal.operations},scope),true);
 const plan={planHash:'frozen',fileMappings:[{from:'old.md',to:'002 新主题/old.md'}],newDirectories:['002 新主题'],directoryMappings:[]};
 assert.equal(evolutionTouches(plan,scope),false);assert.equal(evolutionTouches(plan,{...scope,targetPath:path.join(root,'002 新主题/new.md')}),true);
});

test('HTTP 历史执行每类明细独立分页，整批报告仍使用完整实时日志证据',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'application-pages-'));t.after(()=>rm(root,{recursive:true,force:true}));const stateDirectory=path.join(root,'state'),store=createBatchStore({stateDirectory});
 const sources=Array.from({length:73},(_,i)=>({sourceId:String(i),identity:`${i}.md`,currentPath:path.join(root,`${i}.md`),status:'reviewed',ingestStatus:'historical',selected:false}));
 const groups=sources.map((s,i)=>({groupId:String(i),status:'verified',moveIndexes:Array(80).fill(i),itemIds:[s.sourceId]})),results=sources.map(s=>({sourceId:s.sourceId,status:'succeeded'})),items=sources.map(s=>({id:s.sourceId,from:`raw/sources/${s.identity}`,to:`raw/sources/moved/${s.identity}`,status:'succeeded'}));
 const resultPath=path.join(root,'result.json');await writeFile(resultPath,'{}');
 const batch=await store.create({mode:'inbox',sourceRoot:root,libraryPath:root,sources,slices:[],flow:{historyApplication:{status:'running',sourceIds:sources.map(s=>s.sourceId),resultPath,groups,results}}});
 const service=createBatchService({stateDirectory,original:{get:async()=>({status:'complete',phase:'verified-original',items,executionGroups:groups})}}),server=createApp({batches:service});await listenForBrowser(server);t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session')).json();const call=async(action,input={})=>{const res=await fetch(base+'/api/batches/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify({batchId:batch.batchId,...input})});assert.equal(res.status,200);return res.json();};
 let app=(await call('get',{limit:1000})).historyApplication;assert.equal(app.status,'interrupted');assert.equal(app.groups.length,50);assert.equal(app.results.length,50);assert.equal(app.observedHistory.items.length,50);assert.equal(app.groupCount,73);assert.equal(app.verifiedGroupCount,73);assert.equal(app.resultCounts.succeeded,73);assert.equal(app.groups[0].moveCount,80);assert.equal(app.groups[0].moveIndexes,undefined);
 app=(await call('get',{limit:50,applicationGroupCursor:50,applicationResultCursor:60,observedHistoryCursor:70})).historyApplication;assert.equal(app.groups.length,23);assert.equal(app.results.length,13);assert.equal(app.observedHistory.items.length,3);assert.equal(app.groups[0].groupId,'50');assert.equal(app.results[0].sourceId,'60');assert.equal(app.observedHistory.items[0].id,'70');assert.equal(app.groupNextCursor,null);
 const listed=await call('list');assert.equal(listed.records[0].historyApplication.groups.length,1);assert.equal(listed.records[0].historyApplication.results.length,1);
 const report=await call('getReport',{limit:1});assert.equal(report.counts.succeeded,73);assert.equal(report.items.length,1);assert.equal(report.status,'needs-recovery');
});

test('目录例外可在公开C审核入口修正，未选或排除的建议不阻断真正独立新增',async t=>{
 const operations=[{type:'add',parent:'001 缓存',label:'细分',files:[],problem:'主题需细分',benefit:'按主题查找'}],f=await inboxConfirmationFixture(t,{operations});
 const source=identity=>f.getBatch().sources.find(s=>s.identity===identity),owner=source('a.md');
 await mkdir(path.join(f.root,'upstream/src/lib'),{recursive:true});await writeFile(path.join(f.root,'upstream/src/lib/source-watch-defaults.json'),JSON.stringify({enabled:false,autoIngest:false,includeExtensions:['md'],excludeExtensions:[],excludeDirs:[],excludeGlobs:[]}));
 await f.call('reviewItem',{sourceId:owner.sourceId,action:'evolve',category:'001 缓存'});
 await assert.rejects(f.call('confirmPlans',{items:[{sourceId:owner.sourceId,name:'a.md',category:'001 缓存'}]}),/目录调整/);await f.call('get');
 await f.call('confirmPlans',{items:[{sourceId:source('b.md').sourceId,name:'b.md',category:'001 缓存'}]});
 await f.call('reviewItem',{sourceId:owner.sourceId,action:'confirmEvolution'});
 await assert.rejects(f.call('reviewItem',{sourceId:owner.sourceId,action:'discardEvolution'}),/整份撤销/);await f.call('get');
 const run=await f.call('confirmNewArchive',{requestId:'independent',writersPaused:true,items:[{sourceId:owner.sourceId,name:'a.md',category:'001 缓存'},{sourceId:source('b.md').sourceId,name:'b.md',category:'001 缓存'}]});assert.equal(run.flow.newArchive.counts.succeeded,1);assert.equal(run.flow.newArchive.counts.retained,1);await lstat(path.join(f.sourceRoot,'a.md'));
 await f.call('reviewItem',{sourceId:owner.sourceId,action:'discardEvolution',discardShared:true});assert.equal(f.getBatch().flow.evolutionPlan,undefined);
 await f.call('confirmPlans',{items:[{sourceId:owner.sourceId,name:'a.md',category:'001 缓存'}]});assert.equal(source('a.md').status,'reviewed');
});

test('部分执行后剩余待分析入口继续开放，执行现场与全完成不显示开始分析',()=>{
 const batch={report:{hasExecution:true,status:'partial'},analysisJob:{allowedActions:['startAnalysis']},analysisProgress:{remaining:1},classificationProgress:{remaining:0}};
 assert.deepEqual(reviewAnalysisActions(batch),['startAnalysis']);assert.deepEqual(reviewAnalysisActions({...batch,analysisProgress:{remaining:0}}),[]);
 assert.deepEqual(reviewAnalysisActions({...batch,report:{status:'needs-recovery'}}),[]);assert.deepEqual(reviewAnalysisActions({...batch,historyApplication:{status:'interrupted'}}),[]);
});

test('执行组翻页可到达末组，界面汇总按整份范围而不是当前页计数',async t=>{
 class Node{constructor(tag){this.tag=tag;this.children=[];this.textContent='';}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}}
 t.mock.method(globalThis,'fetch',async(url,options)=>({ok:true,json:async()=>{if(url==='/api/session')return {token:'test'};assert.equal(JSON.parse(options.body).applicationGroupCursor,50);return {historyApplication:{groups:[{status:'verified'}],groupCursor:50,groupNextCursor:null}};}}));
 const previous=globalThis.document;globalThis.document={createElement:tag=>new Node(tag)};t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
 const host=new Node('section'),walk=node=>[node,...node.children.flatMap(walk)];
 renderHistoryActions(host,{batch:{batchId:'test',historyValidation:{status:'stale'},historyApplication:{status:'complete',selectedCount:51,groups:[{status:'verified'}],groupCursor:0,groupCount:51,groupNextCursor:50,verifiedGroupCount:51,resultCounts:{succeeded:51}}},run:()=>assert.fail('只读翻页不得重新渲染回第一页')});
 assert.ok(walk(host).some(node=>node.textContent.includes('51 / 51')));assert.ok(walk(host).some(node=>node.textContent==='成功：51 份'));
 await walk(host).find(node=>node.textContent==='下一页执行组').onclick();assert.ok(walk(host).some(node=>node.textContent.startsWith('第 51 组')));assert.ok(!walk(host).some(node=>node.textContent==='下一页执行组'));
});

test('已排除的目录建议只阻断真正依赖项，不阻断另一份的集中确认',async t=>{
 const f=await inboxConfirmationFixture(t,{operations:[{type:'add',parent:'001 缓存',label:'细分',files:[],problem:'主题需细分',benefit:'便于查找'}]}),owner=f.getBatch().sources.find(s=>s.identity==='a.md'),other=f.getBatch().sources.find(s=>s.identity==='b.md');
 await f.call('reviewItem',{sourceId:owner.sourceId,action:'evolve',category:'001 缓存'});await f.call('reviewItem',{sourceId:owner.sourceId,action:'exclude'});
 await f.call('confirmPlans',{items:[{sourceId:other.sourceId,name:'b.md',category:'001 缓存'}]});assert.equal(f.getBatch().sources.find(s=>s.sourceId===other.sourceId).status,'reviewed');assert.equal(f.getBatch().sources.find(s=>s.sourceId===owner.sourceId).status,'excluded');
});

test('C页首次确认名称后评估并放弃目录建议，正文分类仍有效且可直接归档',async t=>{
 const f=await inboxConfirmationFixture(t,{operations:[{type:'add',parent:'001 缓存',label:'细分',files:[],problem:'主题需细分',benefit:'便于查找'}]}),owner=f.getBatch().sources.find(s=>s.identity==='unnamed.md');assert.equal(owner.confirmedName,null);
 await mkdir(path.join(f.root,'upstream/src/lib'),{recursive:true});await writeFile(path.join(f.root,'upstream/src/lib/source-watch-defaults.json'),JSON.stringify({enabled:false,autoIngest:false,includeExtensions:['md'],excludeExtensions:[],excludeDirs:[],excludeGlobs:[]}));
 await f.call('reviewItem',{sourceId:owner.sourceId,action:'confirmName',name:'人工命名.md'});const named=f.getBatch().sources.find(s=>s.sourceId===owner.sourceId);assert.deepEqual(named.analysis,{...owner.analysis,confirmedName:'人工命名.md'});assert.equal(named.classification.category,owner.classification.category);assert.match(named.classification.finalPath,/人工命名.md$/);
 await f.call('reviewItem',{sourceId:owner.sourceId,action:'evolve',category:'001 缓存'});await f.call('reviewItem',{sourceId:owner.sourceId,action:'discardEvolution'});
 const result=await f.call('confirmNewArchive',{requestId:'corrected',writersPaused:true,items:[{sourceId:owner.sourceId,name:'人工命名.md',category:'001 缓存'}]});assert.equal(result.flow.newArchive.counts.succeeded,1);await assert.rejects(lstat(path.join(f.sourceRoot,'unnamed.md')),{code:'ENOENT'});await lstat(path.join(f.libraryPath,'raw/sources/001 缓存/人工命名.md'));
});
