import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {migrationFixture} from './helpers/migration-fixture.js';
import {listenForBrowser} from './helpers/http-server.js';
import {createApp} from '../src/server.mjs';
import {createBatchService} from '../src/batches.js';
import {createPlanningService} from '../src/planning.js';
import {createRestructureStrategy} from '../src/restructure.js';
import {createBackup} from '../src/backup.js';
import {createMigrationService} from '../src/migration.js';
import {createOriginalExecutionService} from '../src/original-execution.js';
import {createRecoveryService} from '../src/recovery.js';
import {UPSTREAM_COMMIT} from '../src/migration-verifier.js';
import {inventory,preflight,digest} from '../src/compatibility.js';
import {restructureDraft} from '../public/restructure-workspace.js';

export async function restructureWorkspaceFixture(t,{count=3}={}){
 const text='数据库查询计划、索引选择与共享缓存的性能问题，需要按实际执行路径分析并保留原知识正文。';
 const f=await migrationFixture(t,{decorate:async({write,libraryPath})=>{
  const cache=JSON.parse(await readFile(path.join(libraryPath,'.llm-wiki/ingest-cache.json'),'utf8'));
  for(let i=0;i<count;i++){const name=i===0?'old':`material-${i}`;await write(`raw/sources/${name}.md`,text);if(i===0){cache.entries['old.md'].hash=digest(text);continue;}await write(`wiki/sources/${name}.md`,`---\nsources: ["${name}.md"]\n---\n原知识正文不修改。`);cache.entries[name+'.md']={hash:digest(text),timestamp:1,filesWritten:[`wiki/sources/${name}.md`]};}
  await write('.llm-wiki/ingest-cache.json',cache);await write('raw/sources/空白.md','');
 }});
 const libraryPath=f.backup.originalPath,sourceRoot=path.join(libraryPath,'raw/sources'),wikiSourcePath=path.join(f.root,'upstream'),artifactRoot=path.join(f.root,'artifacts'),configPath=path.join(f.root,'config.json');await mkdir(artifactRoot);await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'fixed'}}));
 const modelCalls=[];const generate=async(_,request)=>{modelCalls.push(request.stage);if(request.stage==='tree-proposal')return {categories:[{segments:['数据库'],members:request.materials.map(s=>s.sourceId),representatives:[request.materials[0].sourceId],reason:'按数据库主题集中查找'}]};if(request.stage==='tree-merge')return {categories:[{segments:['数据库'],groups:request.categories.map(s=>s.groupId),reason:'合并共同主题'}]};return {title:request.identity.replace('.md','')+' 查询分析',summary:request.content,evidence:[request.content],uncertain:false};};
 const quiet=async()=>({upstreamCommit:UPSTREAM_COMMIT,result:{changedTasks:[],queue:{version:1,tasks:[]}},events:[]});
 const planning=createPlanningService({stateDirectory:path.join(f.root,'planning'),generate});
 const server=createApp({batches:createBatchService({stateDirectory:path.join(f.root,'batches'),planning,strategies:{restructure:createRestructureStrategy({generate})},backup:input=>createBackup(input,{inspect:input=>preflight(input,{sourceManifest:{version:'0.6.11',commit:UPSTREAM_COMMIT,files:{fixture:digest('verified-test-format')}}})}),migration:createMigrationService({executionGroupSize:1,verify:quiet}),recovery:createRecoveryService({verify:quiet}),original:createOriginalExecutionService({verify:quiet})})});
 await listenForBrowser(server);t.after(()=>new Promise(resolve=>server.close(resolve)));const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session')).json();let batch;
 const call=async(action,extra={},expected=200)=>{const response=await fetch(base+'/api/batches/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify({batchId:batch?.batchId,revision:batch?.revision,...extra})});const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));if(expected===200)batch=value;return value;};
 await call('create',{mode:'restructure',libraryPath,sourceRoot,wikiSourcePath,artifactRoot,configPath});
 const wait=async predicate=>{for(let i=0;i<2000;i++){await call('get',{limit:50});if(predicate(batch))return batch;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('等待状态超时 '+JSON.stringify(batch.analysisJob));};
 return {f,base,libraryPath,sourceRoot,call,wait,modelCalls,batch:()=>batch};
}

test('首次重构后台生成树，整批审核绑定树版本，自动验证后改树使旧方案失效',async t=>{
 const f=await restructureWorkspaceFixture(t),before=await inventory(f.libraryPath);
 await f.call('startAnalysis');await f.wait(b=>b.analysisJob.status==='complete');let batch=f.batch();assert.equal(batch.flow.tree.status,'proposed');assert.equal(batch.counts.skipped,1);assert.ok(f.modelCalls.includes('tree-proposal'));
 let items=batch.sources.filter(s=>s.status==='analyzed').map(s=>({sourceId:s.sourceId,name:s.analysis.suggestion,nodeId:s.proposedNodeId}));
 assert.equal((await f.call('confirmPlans',{treeRevision:batch.flow.tree.revision,items},400)).code,'STALE_TREE');await f.call('get');
 await f.call('treeAction',{action:'approve'});batch=f.batch();
 assert.equal((await f.call('confirmPlans',{treeRevision:batch.flow.tree.revision,items:[{...items[0],nodeId:'不存在'}]},400)).code,'INVALID_TREE');await f.call('get');
 items[0].name='手工确认的查询分析.md';await f.call('confirmPlans',{treeRevision:f.batch().flow.tree.revision,items,replaceSelection:true});assert.equal(f.batch().historyPlan.selectedCount,3);assert.equal((await inventory(f.libraryPath)).hash,before.hash);
 const planHash=f.batch().historyPlan.planHash,modelCount=f.modelCalls.length;await f.call('startHistoryValidation',{planHash,writersPaused:true});await f.wait(b=>b.historyValidation?.status!=='running');assert.equal(f.batch().historyValidation.status,'awaiting-apply',JSON.stringify(f.batch().historyValidation));assert.equal(f.modelCalls.length,modelCount);assert.equal((await inventory(f.libraryPath)).hash,before.hash);
 await f.call('treeAction',{action:'edit',nodeId:f.batch().flow.tree.nodes[0].nodeId,segments:['系统查询']});assert.equal(f.batch().historyValidation.status,'stale');assert.equal(f.batch().historyPlan.selectedCount,0);assert.equal((await f.call('startHistoryValidation',{planHash,writersPaused:true},400)).code,'STALE_PLAN');
});

test('树草稿绑定来源及树版本，刷新保留手改而新树清除陈旧选择',()=>{const source={hash:'a',analysis:{suggestion:'建议.md'},proposedNodeId:'one',status:'analyzed'},draft={hash:'a',treeRevision:1,name:'手改.md',nodeId:'two',selected:true,manual:true};assert.deepEqual(restructureDraft(source,draft,1),draft);assert.deepEqual(restructureDraft(source,draft,2),{hash:'a',treeRevision:2,name:'建议.md',nodeId:'one',selected:false,manual:false});});

test('跨来源分页的全量方案一次确认可超过旧 16 KiB 限制',async t=>{
 const f=await restructureWorkspaceFixture(t,{count:52});await f.call('startAnalysis');await f.wait(b=>b.analysisJob.status==='complete');assert.notEqual(f.batch().nextCursor,null);await f.call('treeAction',{action:'approve'});const first=await f.call('get',{limit:50}),second=await f.call('get',{cursor:first.nextCursor,limit:50});const sources=[...first.sources,...second.sources];const items=sources.filter(s=>s.status==='analyzed').map((s,index)=>({sourceId:s.sourceId,nodeId:s.proposedNodeId,name:'数据库知识主题'.repeat(12)+index+'.md'}));assert.equal(items.length,52);assert.ok(Buffer.byteLength(JSON.stringify({items}))>16384);await f.call('confirmPlans',{treeRevision:first.flow.tree.revision,items,replaceSelection:true});assert.equal(f.batch().historyPlan.selectedCount,52);assert.equal(f.batch().counts.reviewed,52);assert.equal(f.batch().counts.skipped,1);
});


test('三次实质确认完成首次重构，多执行分组不追加文件审核或授权',async t=>{
 const f=await restructureWorkspaceFixture(t);await f.call('startAnalysis');await f.wait(b=>b.analysisJob.status==='complete');let confirmations=0;
 await f.call('treeAction',{action:'approve'});confirmations++;const items=f.batch().sources.filter(s=>s.status==='analyzed').map(s=>({sourceId:s.sourceId,name:s.analysis.suggestion,nodeId:s.proposedNodeId}));
 await f.call('confirmPlans',{treeRevision:f.batch().flow.tree.revision,items,replaceSelection:true});confirmations++;const planHash=f.batch().historyPlan.planHash;await f.call('startHistoryValidation',{planHash,writersPaused:true});await f.wait(b=>b.historyValidation?.status!=='running');assert.equal(f.batch().historyValidation.status,'awaiting-apply');const modelCount=f.modelCalls.length;
 const authorization={planHash,evidenceDigest:f.batch().historyValidation.evidenceDigest,writersPaused:true,approved:true};await f.call('applyHistoryPlan',authorization);confirmations++;await f.wait(b=>b.historyApplication?.status!=='running');const result=f.batch();assert.equal(result.historyApplication.status,'complete',JSON.stringify(result.historyApplication));assert.equal(confirmations,3);assert.equal(result.counts.succeeded,3);assert.ok(result.historyApplication.groups.length>1);assert.ok(result.historyApplication.groups.every(g=>g.status==='verified'));assert.equal(f.modelCalls.length,modelCount);for(const source of result.sources.filter(s=>s.status==='succeeded'))assert.match(await readFile(source.currentPath,'utf8'),/数据库查询计划/);assert.equal(await readFile(path.join(f.sourceRoot,'空白.md'),'utf8'),'');assert.match(await readFile(path.join(f.libraryPath,'wiki/concept.md'),'utf8'),/保持知识正文/);
 const after=await inventory(f.libraryPath);await f.call('applyHistoryPlan',authorization);assert.equal((await inventory(f.libraryPath)).hash,after.hash);
});

test('重构局部正文变化保留其他分析，同时解释全树依赖重审',async t=>{
 const f=await restructureWorkspaceFixture(t);await f.call('startAnalysis');await f.wait(b=>b.analysisJob.status==='complete');await f.call('treeAction',{action:'approve'});
 let b=f.batch();await f.call('confirmPlans',{treeRevision:b.flow.tree.revision,items:b.sources.filter(s=>s.status==='analyzed').map(s=>({sourceId:s.sourceId,name:s.analysis.suggestion,nodeId:s.proposedNodeId}))});
 const old=f.batch(),changed=old.sources.find(s=>s.status==='reviewed');await writeFile(changed.currentPath,'数据库新的查询证据需要分析和重新确认。');b=await f.call('refreshReview');assert.equal(b.flow.tree.status,'stale');assert.equal(b.counts.reviewed??0,0);assert.equal(b.sources.find(s=>s.sourceId===changed.sourceId).analysis,undefined);
 for(const source of old.sources.filter(s=>s.sourceId!==changed.sourceId))assert.deepEqual(b.sources.find(s=>s.sourceId===source.sourceId).analysis,source.analysis);
 assert.ok(b.invalidations.reasons.some(r=>r.code==='TREE_INPUT_CHANGED'));const versions=b.sources.map(s=>s.reviewVersion);b=await f.call('refreshReview');assert.deepEqual(b.sources.map(s=>s.reviewVersion),versions);
});
