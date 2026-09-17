import {listenForBrowser} from './helpers/http-server.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {migrationFixture} from './helpers/migration-fixture.js';
import {createBatchService} from '../src/batches.js';
import {createRestructureStrategy} from '../src/restructure.js';
import {createPlanningService} from '../src/planning.js';
import {createBackup} from '../src/backup.js';
import {createMigrationService} from '../src/migration.js';
import {createRecoveryService} from '../src/recovery.js';
import {createOriginalExecutionService} from '../src/original-execution.js';
import {digest,inventory,preflight} from '../src/compatibility.js';
import {UPSTREAM_COMMIT,nativeRescanVerifier} from '../src/migration-verifier.js';
import {createApp} from '../src/server.mjs';
const quiet=async()=>({upstreamCommit:UPSTREAM_COMMIT,result:{changedTasks:[],queue:{version:1,tasks:[]}},events:[]});
async function fixture(t){
 const original='# 第1讲 数据库\n'+('查询计划、索引选择与共享缓存的性能问题需要按实际执行路径分析。'.repeat(700));
 const f=await migrationFixture(t,{oldIdentity:'第1讲 录屏1080p.md',decorate:async({write,summary})=>{
  await write('raw/sources/第1讲 录屏1080p.md',original);await write('raw/sources/导航.md','# 导航\n[课程](第1讲%20录屏1080p.md)');await write('raw/sources/噪声.md','12!?');await write('raw/sources/空白.md','');
  await write('wiki/concept.md','---\nsources: ["第1讲 录屏1080p.md", "导航.md", "噪声.md", "空白.md"]\n---\n共享知识正文始终保留。');
  await write('wiki/sources/导航.md','---\nsources: ["导航.md"]\n---\n导航摘要正文保留。');
  await write('.llm-wiki/ingest-cache.json',{entries:Object.fromEntries([['第1讲 录屏1080p.md',original],['导航.md','# 导航\n[课程](第1讲%20录屏1080p.md)'],['噪声.md','12!?'],['空白.md','']].map(([identity,text])=>[identity,{hash:digest(text),timestamp:1,filesWritten:identity==='第1讲 录屏1080p.md'?[summary,'wiki/concept.md']:identity==='导航.md'?['wiki/sources/导航.md','wiki/concept.md']:['wiki/concept.md']}]))});
 }});
 const artifactRoot=path.join(f.root,'artifacts');await mkdir(artifactRoot);const configPath=path.join(f.root,'config.json');await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test',customEndpoint:'http://127.0.0.1:1',maxContextSize:4000}}));
 const calls=[];const generate=async(config,request)=>{calls.push(request);if(request.stage==='tree-proposal')return {categories:[{segments:['计算机','数据系统','关系数据库','查询执行','性能诊断'],members:request.materials.map(m=>m.sourceId),representatives:request.materials.slice(0,2).map(m=>m.sourceId),reason:'统一数据库课程与导航的查找入口'}]};return {title:request.identity.includes('第1讲')?'第1讲 数据库课程':'课程导航',summary:'数据库查询计划与索引性能课程导航说明',evidence:[request.content.slice(0,45)],uncertain:false};};
 const verify=process.env.ORGANIZER_RESCAN_BINARY?nativeRescanVerifier():quiet;
 const options={stateDirectory:path.join(f.root,'state'),strategies:{restructure:createRestructureStrategy({generate})},planning:createPlanningService({generate,stateDirectory:path.join(f.root,'planning')}),backup:input=>createBackup(input,{inspect:input=>preflight(input,{sourceManifest:{version:'0.6.11',commit:UPSTREAM_COMMIT,files:{fixture:digest('verified-test-format')}}})}),migration:createMigrationService({verify}),recovery:createRecoveryService({verify}),original:createOriginalExecutionService({verify})};
 return {...f,calls,options,original,input:{mode:'restructure',libraryPath:f.backup.originalPath,sourceRoot:path.join(f.backup.originalPath,'raw/sources'),wikiSourcePath:path.join(f.root,'upstream'),artifactRoot,configPath}};
}
test('首次全库先分析长转写/导航并审五层树，再逐批审核执行；低信息和共享正文保留',async t=>{
 const f=await fixture(t),service=createBatchService(f.options);let batch=await service.create(f.input);
 await assert.rejects(service.treeAction({batchId:batch.batchId,revision:batch.revision,action:'propose'}),{code:'ANALYSIS_INCOMPLETE'});batch=await service.get({batchId:batch.batchId});
 batch=await service.analyzeNext({batchId:batch.batchId,revision:batch.revision,limit:5});assert.equal(batch.counts.skipped,2);assert.ok(f.calls.filter(call=>call.stage==='segment'&&call.identity.includes('第1讲')).length>10);
 const long=batch.sources.find(source=>source.identity.includes('第1讲'));
 await assert.rejects(service.reviewItem({batchId:batch.batchId,revision:batch.revision,sourceId:long.sourceId,name:'第1讲 数据库课程.md'}),{code:'TREE_REVIEW_REQUIRED'});batch=await service.get({batchId:batch.batchId});
 batch=await service.treeAction({batchId:batch.batchId,revision:batch.revision,action:'propose'});assert.equal(batch.flow.tree.nodes[0].category.split('/').length,5);assert.ok(!(await readdir(f.input.sourceRoot)).some(name=>name.startsWith('001')));
 batch=await service.treeAction({batchId:batch.batchId,revision:batch.revision,action:'approve'});
 batch=await service.reviewItem({batchId:batch.batchId,revision:batch.revision,sourceId:long.sourceId,name:'第1讲 数据库课程.md'});
 const finalPath=batch.sources.find(source=>source.sourceId===long.sourceId).targetPath;
 const modelCount=f.calls.length;batch=await service.prepareSlice({batchId:batch.batchId,revision:batch.revision,writersPaused:true});const sliceId=batch.slices[0].sliceId;
 batch=await service.validateSlice({batchId:batch.batchId,revision:batch.revision,sliceId,approved:true,writersPaused:true});batch=await service.prepareOriginal({batchId:batch.batchId,revision:batch.revision,sliceId,writersPaused:true});batch=await service.applySlice({batchId:batch.batchId,revision:batch.revision,sliceId,approved:true,writersPaused:true});assert.equal(f.calls.length,modelCount);assert.equal(batch.slices[0].status,'complete');assert.equal(await readFile(finalPath,'utf8'),f.original);
 assert.equal(await readFile(path.join(f.input.sourceRoot,'噪声.md'),'utf8'),'12!?');assert.equal(await readFile(path.join(f.input.sourceRoot,'空白.md'),'utf8'),'');assert.ok((await readFile(path.join(f.backup.originalPath,'wiki/concept.md'),'utf8')).endsWith('共享知识正文始终保留。'));
 const planning=await f.options.planning.list({sourceRoot:f.input.sourceRoot,libraryPath:f.backup.originalPath});const identity=path.relative(f.input.sourceRoot,finalPath).replaceAll('\\','/');assert.equal(planning.entries[identity].confirmedName,'第1讲 数据库课程.md');assert.equal(planning.entries[long.identity],undefined);
 // 第一批反链修复改变导航正文，剩余来源须重新分析审核；第二批重新建立三份数据基线。
 const firstBackup=JSON.parse(await readFile(batch.slices[0].backupReportPath,'utf8'));
 batch=await service.analyzeNext({batchId:batch.batchId,revision:batch.revision,limit:5});const navigation=batch.sources.find(source=>source.identity==='导航.md');
 batch=await service.reviewItem({batchId:batch.batchId,revision:batch.revision,sourceId:navigation.sourceId,name:'课程导航.md'});const beforeSecondExecution=f.calls.length;
 batch=await service.prepareSlice({batchId:batch.batchId,revision:batch.revision,writersPaused:true});const second=batch.slices.at(-1);const firstPage=await service.get({batchId:batch.batchId,sliceCursor:0,sliceLimit:1});assert.equal(firstPage.slices[0].sliceId,sliceId);assert.equal(batch.sliceCount,2);assert.notEqual(second.backupReportPath,firstPage.slices[0].backupReportPath);assert.notEqual(JSON.parse(await readFile(second.backupReportPath,'utf8')).baseline.hash,firstBackup.baseline.hash);
 batch=await service.validateSlice({batchId:batch.batchId,revision:batch.revision,sliceId:second.sliceId,approved:true,writersPaused:true});batch=await service.prepareOriginal({batchId:batch.batchId,revision:batch.revision,sliceId:second.sliceId,writersPaused:true});batch=await service.applySlice({batchId:batch.batchId,revision:batch.revision,sliceId:second.sliceId,approved:true,writersPaused:true});assert.equal(f.calls.length,beforeSecondExecution);assert.equal(batch.counts.succeeded,2);assert.equal(batch.counts.skipped,2);
});
test('分类树调整使文件审核失效，同库两批互斥',async t=>{
 const f=await fixture(t),service=createBatchService(f.options);let batch=await service.create(f.input);batch=await service.analyzeNext({batchId:batch.batchId,revision:batch.revision,limit:5});batch=await service.treeAction({batchId:batch.batchId,revision:batch.revision,action:'propose'});batch=await service.treeAction({batchId:batch.batchId,revision:batch.revision,action:'approve'});const source=batch.sources.find(s=>s.status==='analyzed');batch=await service.reviewItem({batchId:batch.batchId,revision:batch.revision,sourceId:source.sourceId,name:'第1讲 数据库课程.md'});batch=await service.treeAction({batchId:batch.batchId,revision:batch.revision,action:'edit',nodeId:batch.flow.tree.nodes[0].nodeId,segments:['课程资料']});assert.equal(batch.sources.find(s=>s.sourceId===source.sourceId).selected,false);assert.equal(batch.flow.tree.status,'proposed');
 let release,entered;const wait=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);const strategy={...createRestructureStrategy(),analyze:async()=>{entered();await wait;return {status:'analyzed'};}};const parallel=createBatchService({...f.options,strategies:{restructure:strategy}}),a=await parallel.create(f.input),b=await parallel.create(f.input);const running=parallel.analyzeNext({batchId:a.batchId,revision:a.revision});await started;await assert.rejects(parallel.analyzeNext({batchId:b.batchId,revision:b.revision}),{code:'BATCH_BUSY'});release();await running;
});

test('公开首次分类树跨分支复用 aliases，同义位置不唯一则拒绝',async t=>{
 const f=await fixture(t),existing='001 工程/001.01 Agent';await mkdir(path.join(f.input.sourceRoot,existing),{recursive:true});await writeFile(path.join(f.input.sourceRoot,existing,'.category.json'),JSON.stringify({description:'智能体工程',aliases:['AI Agent']}));
 const generate=async(_config,request)=>request.stage==='tree-merge'?{categories:request.categories.map(node=>({segments:node.segments,groups:[node.groupId],reason:node.reason}))}:{categories:request.materials.map((item,index)=>({segments:index===0?['新分支','AI Agent']:['独立主题'],members:[item.sourceId],representatives:[item.sourceId],reason:'复用智能体主题并保留另一材料主分类'}))};
 const service=createBatchService({...f.options,strategies:{restructure:createRestructureStrategy({generate})}}),server=createApp({batches:service});await listenForBrowser(server);t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(`${base}/api/session`)).json();let batch;
 const call=async(action,input={})=>{const response=await fetch(`${base}/api/batches/${action}`,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify({batchId:batch?.batchId,revision:batch?.revision,...input})});const value=await response.json();if(response.ok)batch=value;return {response,value};};
 await call('create',f.input);await call('analyzeNext',{limit:5});const first=await call('treeAction',{action:'propose'});assert.equal(first.response.status,200);assert.equal(batch.flow.tree.nodes[0].category,existing);assert.equal(batch.flow.tree.nodes[1].category,'002 独立主题');
 await mkdir(path.join(f.input.sourceRoot,'002 其他/002.01 智能体'),{recursive:true});await writeFile(path.join(f.input.sourceRoot,'002 其他/002.01 智能体/.category.json'),JSON.stringify({description:'另一个边界',aliases:['AI Agent']}));
 const ambiguous=await call('treeAction',{action:'propose'});assert.equal(ambiguous.response.status,400);assert.equal(ambiguous.value.code,'AMBIGUOUS_CATEGORY');
});
