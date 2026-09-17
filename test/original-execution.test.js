import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {connect,makeArrowTable} from '@lancedb/lancedb';
import {Schema,Field,Utf8,Uint32,Float32,FixedSizeList} from 'apache-arrow';
import {createApp} from '../src/server.mjs';
import {digest,inventory} from '../src/compatibility.js';
import {migrationFixture} from './helpers/migration-fixture.js';
import {createMigrationService} from '../src/migration.js';
import {createRecoveryService} from '../src/recovery.js';
import {createOriginalExecutionService} from '../src/original-execution.js';
import {UPSTREAM_COMMIT,nativeRescanVerifier} from '../src/migration-verifier.js';
import {historyKey} from '../src/relocation-records.js';
const quiet=async()=>({upstreamCommit:UPSTREAM_COMMIT,result:{changedTasks:[],queue:{version:1,tasks:[]}},events:[]});
async function ready(t,options={}){
 const f=await migrationFixture(t,options),verify=options.verify??quiet;
 const migration=createMigrationService({verify}),plan=await migration.plan({...f.input,...options.request});
 const result=await migration.execute({planId:plan.planId,approved:true,writersPaused:true});assert.ok(['complete','partial'].includes(result.status),JSON.stringify(result.error));
 const recovery=createRecoveryService({verify}),rp=await recovery.plan({journalPath:result.journalPath,mode:'new-directory',destination:path.join(f.root,'drill'),writersPaused:true});
 const rr=await recovery.execute({recoveryPlanPath:rp.recoveryPlanPath,approved:true,writersPaused:true});assert.equal(rr.status,'complete',JSON.stringify(rr.error));
 return {...f,verify,plan,result,input:{planManifestPath:plan.planManifestPath,validationJournalPath:result.journalPath,recoveryReportPath:rr.reportPath,writersPaused:true}};
}
test('原库执行复用冻结决策，保留身份且可重启查询',async t=>{
 const f=await ready(t),service=createOriginalExecutionService({verify:quiet});
 const plan=await service.prepare(f.input);
 const result=await createOriginalExecutionService({verify:quiet}).execute({authorizationPlanPath:plan.authorizationPlanPath,approved:true,writersPaused:true});
 assert.equal(result.status,'complete',JSON.stringify(result.error));
 assert.equal(JSON.parse(await readFile(path.join(f.backup.originalPath,'.llm-wiki/project.json'),'utf8')).id,'original-uuid');
 assert.equal(await readFile(path.join(f.backup.originalPath,'raw/sources/主题/new.md'),'utf8'),'# 已摄取的短源');
 assert.deepEqual(result.modelAttempts,[]);
 assert.equal((await service.get({resultPath:result.resultPath})).status,'complete');
});
test('三类记录随冻结改名同步，历史查找键可用且正文保留，副本恢复和原库决策一致',async t=>{
 let prose;
 const oldRelative='raw/sources/old.md',newRelative='raw/sources/主题/new.md';
 const historyFile=`.llm-wiki/history/${historyKey(oldRelative)}.json`,newHistoryFile=`.llm-wiki/history/${historyKey(newRelative)}.json`;
 const verify=process.env.ORGANIZER_RESCAN_BINARY?nativeRescanVerifier():quiet;
 const f=await ready(t,{verify,decorate:async({libraryPath,write})=>{
  await mkdir(path.join(libraryPath,'.llm-wiki/history'));await mkdir(path.join(libraryPath,'.llm-wiki/chats'));
  const location=path.join(libraryPath,oldRelative);prose=`历史正文 old.md ${libraryPath} original-uuid`;
  await write(historyFile,[{id:'v',path:location,timestamp:1,author:'human',tool:'ui.write_file',content:prose}]);
  await write('.llm-wiki/chats/conv_test.json',[{id:'m',role:'assistant',timestamp:1,conversationId:'conv_test',content:prose,contextFiles:[location],references:[{title:'来源',path:location}]}]);
  await write('.llm-wiki/review.json',[{id:'r',title:'审核',description:prose,sourcePath:location,affectedPages:['./'+oldRelative],options:[],resolved:false,createdAt:1}]);
  await write('.llm-wiki/.file-change-queue.json.1785725868891120000.tmp',{tasks:[{projectId:'original-uuid',sourcePath:oldRelative,status:'pending'}]});
 }});
 const service=createOriginalExecutionService({verify}),plan=await service.prepare(f.input);
 const result=await service.execute({authorizationPlanPath:plan.authorizationPlanPath,approved:true,writersPaused:true});
 assert.equal(result.status,'complete',JSON.stringify(result.error));
 for(const root of [f.backup.originalPath,f.backup.validationPath]){
  const load=async file=>JSON.parse(await readFile(path.join(root,file),'utf8'));
  const history=(await load(newHistoryFile))[0];assert.equal(history.path,path.join(root,newRelative).replaceAll('\\','/'));assert.equal(history.content,prose);
  await assert.rejects(readFile(path.join(root,historyFile)),{code:'ENOENT'});
  const chat=(await load('.llm-wiki/chats/conv_test.json'))[0];assert.equal(chat.content,prose);assert.equal(chat.contextFiles[0],history.path);
  const review=(await load('.llm-wiki/review.json'))[0];assert.equal(review.sourcePath,history.path);assert.equal(review.description,prose);assert.equal(review.affectedPages[0],newRelative);
 }
 assert.equal((await inventory(f.backup.backupPath)).hash,f.backup.baseline.hash);
});

test('历史查找键不匹配或目标键被占用时拒绝改名，所有文件保持基线',async t=>{
 for(const kind of ['mismatch','collision'])await t.test(kind,async t=>{
  const f=await migrationFixture(t,{decorate:async({libraryPath,write})=>{
   await mkdir(path.join(libraryPath,'.llm-wiki/history'));
   const entry={id:'v',path:path.join(libraryPath,'raw/sources/old.md'),timestamp:1,author:'human',tool:'ui.write_file',content:'原文'};
   await write(`.llm-wiki/history/${kind==='mismatch'?'0123456789abcdef':historyKey('raw/sources/old.md')}.json`,[entry]);
   if(kind==='collision')await write(`.llm-wiki/history/${historyKey('raw/sources/主题/new.md')}.json`,[{...entry,id:'other',path:path.join(libraryPath,'raw/sources/主题/new.md')}]);
  }});
  const before=await inventory(f.backup.validationPath);
  await assert.rejects(createMigrationService({verify:quiet}).plan(f.input),{code:kind==='mismatch'?'UNKNOWN_RELOCATION':'TARGET_EXISTS'});
  assert.deepEqual(await inventory(f.backup.validationPath),before);
 });
});

test('任何原库新增文件或空目录、验证后改动和损坏证据均阻止执行',async t=>{
 for(const kind of ['file','directory','validation','report'])await t.test(kind,async t=>{
  const f=await ready(t),service=createOriginalExecutionService({verify:quiet}),plan=await service.prepare(f.input);
  if(kind==='file')await writeFile(path.join(f.backup.originalPath,'.hidden'),'新内容');
  if(kind==='directory')await mkdir(path.join(f.backup.originalPath,'新增空目录'));
  if(kind==='validation')await writeFile(path.join(f.backup.validationPath,'wiki/concept.md'),'验证后变化');
  if(kind==='report')await writeFile(f.input.recoveryReportPath,'{}');
  await assert.rejects(service.execute({authorizationPlanPath:plan.authorizationPlanPath,approved:true,writersPaused:true}));
  assert.equal(await readFile(path.join(f.backup.originalPath,'raw/sources/old.md'),'utf8'),'# 已摄取的短源');
 });
});
test('原库失败后可由T7保留现场新增并恢复原UUID',async t=>{
 const f=await ready(t),service=createOriginalExecutionService({verify:quiet,checkpoint:async stage=>{if(stage==='move')throw new Error('原库中断');}});
 const plan=await service.prepare(f.input),result=await service.execute({authorizationPlanPath:plan.authorizationPlanPath,approved:true,writersPaused:true});
 assert.equal(result.status,'failed');
 await writeFile(path.join(f.backup.originalPath,'raw/sources/新增.md'),'失败后新内容');
 const recovery=createRecoveryService({verify:quiet}),rp=await recovery.plan({journalPath:result.journalPath,mode:'same-location',writersPaused:true});
 const rr=await recovery.execute({recoveryPlanPath:rp.recoveryPlanPath,approved:true,writersPaused:true});
 assert.equal(rr.status,'complete',JSON.stringify(rr.error));assert.equal(rr.projectId,'original-uuid');
 assert.equal(await readFile(path.join(rr.scenePath,'raw/sources/新增.md'),'utf8'),'失败后新内容');
 assert.equal((await inventory(f.backup.backupPath)).hash,f.backup.baseline.hash);
});
test('缺少恢复演练、验证未完成或模型调用尝试都不能放行原库',async t=>{
 const f=await ready(t),service=createOriginalExecutionService({verify:quiet});
 await assert.rejects(service.prepare({...f.input,writersPaused:false}),{code:'WRITERS_NOT_PAUSED'});
 await assert.rejects(service.prepare({...f.input,recoveryReportPath:f.plan.planManifestPath}),{code:'INVALID_EVIDENCE'});
 const originalJournal=await readFile(f.input.validationJournalPath,'utf8'),journal=JSON.parse(originalJournal);
 journal.items[0].status='applied-unverified';await writeFile(f.input.validationJournalPath,JSON.stringify(journal));
 await assert.rejects(service.prepare(f.input),{code:'VALIDATION_REQUIRED'});await writeFile(f.input.validationJournalPath,originalJournal);
 const plan=await service.prepare(f.input),unsafe=createOriginalExecutionService({verify:async({models})=>{await models.embed().catch(()=>{});return quiet();}});
 const result=await unsafe.execute({authorizationPlanPath:plan.authorizationPlanPath,approved:true,writersPaused:true});
 assert.equal(result.status,'failed');assert.ok(result.modelAttempts.length);assert.equal((await inventory(f.backup.originalPath)).hash,f.backup.baseline.hash);
});
test('原库执行进程在写入后退出，持久结果可查询并交给恢复',async t=>{
 const f=await ready(t),service=createOriginalExecutionService({verify:quiet}),plan=await service.prepare(f.input);
 const code=`import {createOriginalExecutionService} from ${JSON.stringify(new URL('../src/original-execution.js',import.meta.url).href)};const service=createOriginalExecutionService({verify:${quiet.toString().replace('UPSTREAM_COMMIT',JSON.stringify(UPSTREAM_COMMIT))},checkpoint:async stage=>{if(stage==='write')process.exit(77)}});await service.execute({authorizationPlanPath:process.argv[1],approved:true,writersPaused:true});`;
 await assert.rejects(promisify(execFile)(process.execPath,['--input-type=module','-e',code,plan.authorizationPlanPath]),error=>error.code===77);
 const result=await service.get({resultPath:`${plan.authorizationPlanPath}.result.json`});assert.equal(result.interrupted,true);assert.equal(result.phase,'writing');assert.ok(!JSON.stringify(result).includes('contentBase64'));
 const recovery=createRecoveryService({verify:quiet}),rp=await recovery.plan({journalPath:result.journalPath,mode:'same-location',writersPaused:true});
 assert.equal((await recovery.execute({recoveryPlanPath:rp.recoveryPlanPath,approved:true,writersPaused:true})).status,'complete');
});
test('公开原库入口执行partial安全子集，保留绝对缓存与双表向量，真实重扫可选',async t=>{
 const verify=process.env.ORGANIZER_RESCAN_BINARY?nativeRescanVerifier():quiet;
 const f=await ready(t,{verify,retained:process.env.ORGANIZER_KEEP_PROOF==='1',request:{mappings:[{id:'selected',from:'raw/sources/old.md',to:'raw/sources/主题/new.md'},{id:'excluded',from:'raw/sources/other.md',to:'raw/sources/不执行.md'}],exclusions:['excluded']},decorate:async({write,libraryPath,summary})=>{
  await write('raw/sources/other.md','# 另一来源');await write('wiki/concept.md','---\nsources: ["old.md","other.md"]\n---\n共享内容');await write('raw/sources/navigation.md','[旧材料](old.md#锚点)');
  await write('.llm-wiki/ingest-cache.json',{entries:{'old.md':{hash:digest('# 已摄取的短源'),timestamp:1,filesWritten:[path.join(libraryPath,summary),'wiki/concept.md']},'other.md':{hash:digest('# 另一来源'),timestamp:2,filesWritten:['wiki/concept.md']},'navigation.md':{hash:digest('[旧材料](old.md#锚点)'),timestamp:3,filesWritten:[]}}});
  const db=await connect(path.join(libraryPath,'.llm-wiki/lancedb')),vector=new Field('vector',new FixedSizeList(3,new Field('item',new Float32(),true)),false);
  await db.createTable('wiki_vectors',makeArrowTable([{page_id:'old',vector:[1,0,0]},{page_id:'concept',vector:[0,1,0]}],{schema:new Schema([new Field('page_id',new Utf8(),false),vector])}));
  await db.createTable('wiki_chunks_v2',makeArrowTable([{chunk_id:'old#0',page_id:'old',chunk_index:0,chunk_text:'保持摘要正文。',heading_path:'',vector:[1,0,0]}],{schema:new Schema([new Field('chunk_id',new Utf8(),false),new Field('page_id',new Utf8(),false),new Field('chunk_index',new Uint32(),false),new Field('chunk_text',new Utf8(),false),new Field('heading_path',new Utf8(),false),vector])}));
 }});
 const app=createApp({original:createOriginalExecutionService({verify})});app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>new Promise(resolve=>app.close(resolve)));
 const base=`http://127.0.0.1:${app.address().port}`,{token}=await(await fetch(`${base}/api/session`)).json();
 assert.match(await(await fetch(`${base}/original`)).text(),/原库执行/);
 const call=async(action,input)=>{const response=await fetch(`${base}/api/original/${action}`,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;};
 const plan=await call('prepare',f.input);assert.equal(plan.selectedItems.length,1);
 const result=await call('execute',{authorizationPlanPath:plan.authorizationPlanPath,approved:true,writersPaused:true});assert.equal(result.status,'partial',JSON.stringify(result.error));
 assert.equal(result.items.find(item=>item.id==='selected').status,'succeeded');assert.equal(result.items.find(item=>item.id==='excluded').status,'excluded');
 const cache=JSON.parse(await readFile(path.join(f.backup.originalPath,'.llm-wiki/ingest-cache.json'),'utf8'));
 assert.ok(path.isAbsolute(cache.entries['主题/new.md'].filesWritten[0]));assert.ok(path.resolve(cache.entries['主题/new.md'].filesWritten[0]).startsWith(path.resolve(f.backup.originalPath)));assert.ok(!JSON.stringify(cache).includes(f.backup.validationPath));
 const navigation=await readFile(path.join(f.backup.originalPath,'raw/sources/navigation.md'),'utf8');assert.ok(navigation.includes('new.md#锚点'));assert.equal(cache.entries['navigation.md'].hash,digest(navigation));
 const db=await connect(path.join(f.backup.originalPath,'.llm-wiki/lancedb'));
 for(const name of ['wiki_vectors','wiki_chunks_v2'])assert.notEqual((await(await db.openTable(name)).vectorSearch([1,0,0]).limit(1).toArray())[0].page_id,'old');
 assert.deepEqual(result.modelAttempts,[]);assert.equal((await call('get',{resultPath:result.resultPath})).status,'partial');
 if(process.env.ORGANIZER_KEEP_PROOF==='1')console.log('T8_PROOF='+JSON.stringify({root:f.backup.originalPath,resultPath:result.resultPath,journalPath:result.journalPath}));
});
