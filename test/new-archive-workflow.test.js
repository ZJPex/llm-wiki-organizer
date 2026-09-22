import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile,lstat} from 'node:fs/promises';
import {migrationFixture} from './helpers/migration-fixture.js';
import {listenForBrowser} from './helpers/http-server.js';
import {createPlanningService} from '../src/planning.js';
import {createInboxStrategy} from '../src/inbox.js';
import {createBatchService} from '../src/batches.js';
import {createApp} from '../src/server.mjs';

async function fixture(t,{checkpoint,internal=false}={}){
 const f=await migrationFixture(t),libraryPath=f.backup.originalPath,sourceRoot=internal?path.join(libraryPath,'raw/sources'):path.join(f.root,'inbox'),artifactRoot=path.join(f.root,'artifacts'),wikiSourcePath=path.join(f.root,'upstream'),configPath=path.join(f.root,'config.json');
 await mkdir(sourceRoot,{recursive:true});await mkdir(artifactRoot);await mkdir(path.join(wikiSourcePath,'src/lib'),{recursive:true});
 await writeFile(path.join(wikiSourcePath,'src/lib/source-watch-defaults.json'),JSON.stringify({enabled:false,autoIngest:false,includeExtensions:['md'],excludeExtensions:[],excludeDirs:[],excludeGlobs:[]}));
 await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test'}}));
 for(const name of ['a','b','c'])await writeFile(path.join(sourceRoot,name+'.md'),'缓存一致性需要校验索引与文件来源，归档过程中应当保留失败证据并避免覆盖已有材料。');
 await writeFile(path.join(sourceRoot,'low.md'),'# 标题');
 const planning=createPlanningService({stateDirectory:path.join(f.root,'planning'),generate:async(_,r)=>r.stage==='category-search'?{candidates:['']}:r.stage==='category-choice'?{category:'',reason:'正文主题',evidence:r.content.evidence,uncertain:false}:{title:'缓存实践',summary:r.content,evidence:[r.content],uncertain:false}});
 const service=createBatchService({stateDirectory:path.join(f.root,'batches'),planning,strategies:{inbox:createInboxStrategy({checkpoint})}}),server=createApp({batches:service});
 await listenForBrowser(server);t.after(()=>new Promise(resolve=>server.close(resolve)));const base='http://127.0.0.1:'+server.address().port,{token}=await(await fetch(base+'/api/session')).json();let batch;
 const call=async(action,extra={})=>{const response=await fetch(base+'/api/batches/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify({batchId:batch?.batchId,revision:batch?.revision,...extra})});const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error),value);batch=value;return value;};
 await call('create',{mode:'inbox',libraryPath,sourceRoot,artifactRoot,wikiSourcePath,configPath});await call('analyzeNext',{limit:5});
 const item=(name,target=name)=>({sourceId:batch.sources.find(s=>s.identity===name+'.md').sourceId,name:target+'.md',category:''});
 return {call,item,sourceRoot,libraryPath,configPath,get:()=>batch};
}
test('公开入口一次确认：独立成功，冲突与低信息保留，重复请求不重移且不修改摄取设置',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.libraryPath,'raw/sources/occupied.md'),'不可覆盖');const config=await readFile(f.configPath,'utf8');
 const input={requestId:'one',writersPaused:true,items:[f.item('a','archived'),f.item('b','occupied'),f.item('low')]};
 await assert.rejects(f.call('confirmNewArchive',{...input,writersPaused:false}),/暂停/);
 const result=await f.call('confirmNewArchive',input);assert.equal(result.flow.newArchive.counts.succeeded,1);assert.equal(result.flow.newArchive.counts.retained,2);
 assert.equal(result.slices[0].archiveResult.newIngestRequests.length,0);assert.equal(await readFile(f.configPath,'utf8'),config);assert.equal(await readFile(path.join(f.libraryPath,'raw/sources/occupied.md'),'utf8'),'不可覆盖');
 await assert.rejects(lstat(path.join(f.sourceRoot,'a.md')),{code:'ENOENT'});await lstat(path.join(f.sourceRoot,'b.md'));await lstat(path.join(f.sourceRoot,'low.md'));
 const again=await f.call('confirmNewArchive',{...input,revision:1});assert.equal(again.sliceCount,result.sliceCount);assert.equal(again.flow.newArchive.counts.succeeded,1);
 const report=await f.call('getReport');assert.equal(report.status,'partial');assert.equal(report.counts.total,4);assert.equal(report.counts.succeeded,1);assert.equal(report.counts.retained,3);assert.match(report.items.find(item=>item.identity==='c.md').reason,/未纳入/);
});
test('过期来源原处保留，独立有效项继续',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.sourceRoot,'a.md'),'外部修改');const result=await f.call('confirmNewArchive',{requestId:'changed',writersPaused:true,items:[f.item('a','changed'),f.item('b','good')]});
 assert.equal(result.flow.newArchive.counts.retained,1);assert.equal(result.flow.newArchive.counts.succeeded,1);assert.equal(await readFile(path.join(f.sourceRoot,'a.md'),'utf8'),'外部修改');
});
test('历史关联不能进入新增直通，整次请求保持无写入',async t=>{
 const f=await fixture(t,{internal:true});
 await assert.rejects(f.call('confirmNewArchive',{requestId:'historical',writersPaused:true,items:[f.item('a','new'),f.item('old','moved')]}),/历史材料/);
 await lstat(path.join(f.sourceRoot,'a.md'));await lstat(path.join(f.sourceRoot,'old.md'));await assert.rejects(lstat(path.join(f.sourceRoot,'new.md')),{code:'ENOENT'});
});
test('目录依赖阻断新增直通；用户排除项仍保留',async t=>{
 const {inboxConfirmationFixture}=await import('./helpers/inbox-confirmation-fixture.js');const f=await inboxConfirmationFixture(t,{operations:[{type:'add',parent:'001 缓存',label:'新增主题',files:[],problem:'主题需细分',benefit:'按主题查找'}]}),source=f.getBatch().sources.find(s=>s.identity==='a.md');
 await f.call('reviewItem',{sourceId:source.sourceId,action:'evolve',category:'001 缓存'});await f.call('reviewItem',{sourceId:source.sourceId,action:'confirmEvolution'});
 const result=await f.call('confirmNewArchive',{requestId:'directory',writersPaused:true,items:[{sourceId:source.sourceId,name:'a.md',category:'001 缓存'}]});assert.equal(result.flow.newArchive.counts.retained,1);assert.match(result.flow.newArchive.items[0].reason.message,/目录调整/);
 await lstat(path.join(f.sourceRoot,'a.md'));await lstat(path.join(f.sourceRoot,'excluded.md'));
});
test('复制后失败保留来源、目标和日志，重复确认只查询证据',async t=>{
 const f=await fixture(t,{checkpoint:async stage=>{if(stage==='copied')throw new Error('模拟复制后失败');}}),input={requestId:'failure',writersPaused:true,items:[f.item('a','kept'),f.item('b','later')]};
 const result=await f.call('confirmNewArchive',input);assert.equal(result.flow.newArchive.counts.failed,1);assert.equal(result.flow.newArchive.counts.retained,1);await lstat(path.join(f.sourceRoot,'a.md'));await lstat(path.join(f.libraryPath,'raw/sources/kept.md'));
 const full=await f.call('get',{sliceCursor:0,sliceLimit:50});const failed=full.slices.find(s=>s.status==='failed');const evidence=await readFile(failed.archiveResult.archiveJournalPath,'utf8');assert.equal(JSON.parse(evidence).items[0].status,'copied');
 await f.call('confirmNewArchive',input);assert.equal(await readFile(failed.archiveResult.archiveJournalPath,'utf8'),evidence);
 await f.call('get');await assert.rejects(f.call('reviewItem',{sourceId:input.items[0].sourceId,action:'exclude'}),/执行现场/);await assert.rejects(f.call('startAnalysis'),/执行现场/);
});

test('独立新增仅撤销变更正文的审核，目标占用只撤销冲突项',async t=>{
 const f=await fixture(t);await f.call('confirmPlans',{items:[f.item('a','一'),f.item('b','UpperCase')]});const initial=f.get();await writeFile(path.join(f.sourceRoot,'a.md'),'缓存与索引的新正文');let b=await f.call('refreshReview');assert.equal(b.sources.find(s=>s.identity==='a.md').status,'needs-analysis');assert.equal(b.sources.find(s=>s.identity==='b.md').status,'reviewed');assert.deepEqual(b.sources.find(s=>s.identity==='b.md').analysis,initial.sources.find(s=>s.identity==='b.md').analysis);
 await writeFile(path.join(f.libraryPath,'raw/sources/UpperCase.md'),'外部占用');b=await f.call('refreshReview');assert.ok(b.invalidations.reasons.some(r=>r.code==='TARGET_CONFLICT'));assert.equal(b.sources.find(s=>s.identity==='b.md').selected,false);assert.equal(await readFile(path.join(f.libraryPath,'raw/sources/UpperCase.md'),'utf8'),'外部占用');
});
