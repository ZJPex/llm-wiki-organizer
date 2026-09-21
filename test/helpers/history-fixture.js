import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {migrationFixture} from './migration-fixture.js';
import {listenForBrowser} from './http-server.js';
import {createApp} from '../../src/server.mjs';
import {createBatchService} from '../../src/batches.js';
import {createBatchStore} from '../../src/batch-store.js';
import {createPlanningService} from '../../src/planning.js';
import {createInboxStrategy} from '../../src/inbox.js';
import {createBackup} from '../../src/backup.js';
import {createMigrationService} from '../../src/migration.js';
import {createOriginalExecutionService} from '../../src/original-execution.js';
import {createRecoveryService} from '../../src/recovery.js';
import {UPSTREAM_COMMIT} from '../../src/migration-verifier.js';
import {inventory,preflight,digest} from '../../src/compatibility.js';

export async function historyFixture(t,{failValidation=false,backupGate,originalCheckpoint,originalVerify,mixed=false}={}){
 const text='缓存一致性需要协调索引维护，完整保留知识正文与摄取状态以保证历史迁移安全。';
 const f=await migrationFixture(t,{decorate:async({write,libraryPath})=>{
  await mkdir(path.join(libraryPath,'raw/sources/001 缓存'));
  const cache=JSON.parse(await readFile(path.join(libraryPath,'.llm-wiki/ingest-cache.json'),'utf8'));
  for(const name of ['old','second','third']){await write(`raw/sources/${name}.md`,text);if(name==='old'){cache.entries['old.md'].hash=digest(text);continue;}await write(`wiki/sources/${name}.md`,`---\nsources: ["${name}.md"]\n---\n原知识正文不修改。`);cache.entries[name+'.md']={hash:digest(text),timestamp:1,filesWritten:[`wiki/sources/${name}.md`]};}
  await write('.llm-wiki/ingest-cache.json',cache);if(mixed)await write('raw/sources/new.md',text);
 }});
 const libraryPath=f.backup.originalPath,sourceRoot=path.join(libraryPath,'raw/sources'),wikiSourcePath=path.join(f.root,'upstream'),artifactRoot=path.join(f.root,'history-artifacts'),configPath=path.join(f.root,'history-config.json'),stateDirectory=path.join(f.root,'history-state');await mkdir(artifactRoot);await mkdir(path.join(wikiSourcePath,'src/lib'),{recursive:true});
 await writeFile(path.join(wikiSourcePath,'src/lib/source-watch-defaults.json'),JSON.stringify({enabled:false,autoIngest:false,includeExtensions:['md'],excludeExtensions:[],excludeDirs:[],excludeGlobs:[]}));await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'fixed'},sourceWatchConfig:{enabled:false,autoIngest:false}}));
 let modelCalls=0,fail=failValidation,server,base,token,batch;
 const quiet=async()=>({upstreamCommit:UPSTREAM_COMMIT,result:{changedTasks:[],queue:{version:1,tasks:[]}},events:[]});
 const planning=createPlanningService({stateDirectory:path.join(f.root,'history-planning'),generate:async(_,request)=>{modelCalls++;if(request.stage==='category-search')return {candidates:['001 缓存']};if(request.stage==='category-choice')return {category:'001 缓存',reason:'全文缓存主题',evidence:request.content.evidence,uncertain:false};return {title:request.identity.replace('.md','')+'缓存',summary:request.content,evidence:[request.content],uncertain:false};}});
 const options={stateDirectory,planning,strategies:{inbox:createInboxStrategy()},backup:async input=>{await backupGate?.();return createBackup(input,{inspect:input=>preflight(input,{sourceManifest:{version:'0.6.11',commit:UPSTREAM_COMMIT,files:{fixture:digest('verified-test-format')}}})});},migration:createMigrationService({executionGroupSize:1,verify:async(...args)=>{if(fail)throw new Error('注入完整验证失败');return quiet(...args);}}),recovery:createRecoveryService({verify:quiet}),original:createOriginalExecutionService({verify:originalVerify??quiet,checkpoint:originalCheckpoint})};
 const open=async()=>{server=createApp({batches:createBatchService(options)});await listenForBrowser(server);base=`http://127.0.0.1:${server.address().port}`;({token}=await(await fetch(base+'/api/session')).json());};await open();t.after(()=>new Promise(resolve=>server.close(resolve)));
 const call=async(action,extra={},expected=200)=>{const response=await fetch(base+'/api/batches/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify({batchId:batch?.batchId,revision:batch?.revision,...extra})});const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));if(expected===200)batch=result;return result;};
 await call('create',{mode:'inbox',libraryPath,sourceRoot,wikiSourcePath,artifactRoot,configPath});await call('analyzeNext',{limit:5});assert.equal(batch.counts.classified,mixed?4:3);await call('confirmPlans',{items:batch.sources.map(source=>({sourceId:source.sourceId,name:source.suggestion,category:'001 缓存'}))});
 const wait=async()=>{for(let i=0;i<400;i++){await call('get');if(batch.historyValidation.status!=='running')return batch;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('历史验证未完成');};
 return {f,libraryPath,artifactRoot,call,wait,stateDirectory,getBatch:()=>batch,modelCalls:()=>modelCalls,repair:()=>{fail=false;},restart:async()=>{await new Promise(resolve=>server.close(resolve));await open();}};
}
