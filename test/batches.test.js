import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {migrationFixture} from './helpers/migration-fixture.js';
import {createBatchStore} from '../src/batch-store.js';
import {createBatchService} from '../src/batches.js';
import {discoverSources} from '../src/batch-sources.js';
import {createBackup} from '../src/backup.js';
import {preflight,digest} from '../src/compatibility.js';
import {createMigrationService} from '../src/migration.js';
import {createRecoveryService} from '../src/recovery.js';
import {createOriginalExecutionService} from '../src/original-execution.js';
import {UPSTREAM_COMMIT,nativeRescanVerifier} from '../src/migration-verifier.js';
const quiet=async()=>({upstreamCommit:UPSTREAM_COMMIT,result:{changedTasks:[],queue:{version:1,tasks:[]}},events:[]});
test('批次状态分页、版本冲突与新实例恢复均以磁盘记录为准',async t=>{
 const f=await migrationFixture(t),options={stateDirectory:path.join(f.root,'batch-state')},store=createBatchStore(options),created=await store.create({sources:[],slices:[]});
 assert.equal((await createBatchStore(options).get(created.batchId)).revision,1);
 await store.update(created.batchId,1,record=>({...record,phase:'review'}));await assert.rejects(store.update(created.batchId,1,record=>record),{code:'STALE_BATCH'});
 assert.equal((await store.list({limit:1})).records.length,1);
});
test('缺缓存但存在Wiki关联或队列的Raw不被归类为新来源',async t=>{
 const f=await migrationFixture(t);await writeFile(path.join(f.backup.originalPath,'.llm-wiki/ingest-cache.json'),JSON.stringify({entries:{}}));
 const result=await discoverSources({libraryPath:f.backup.originalPath,sourceRoot:path.join(f.backup.originalPath,'raw/sources')});assert.equal(result.sources[0].ingestStatus,'uncertain');
});
test('共享批次小请求闭环通过真实T2/T6/T7/T8，重复应用只读已有结果',async t=>{
 const f=await migrationFixture(t),artifactRoot=path.join(f.root,'artifacts');await mkdir(artifactRoot);
 const verify=process.env.ORGANIZER_RESCAN_BINARY?nativeRescanVerifier():quiet;
 const strategy={discover:({input})=>discoverSources(input),analyze:async()=>({status:'analyzed'}),review:async()=>({sourcePatch:{status:'reviewed',selected:true}}),prepare:async({selected})=>({historicalRequest:{mappings:selected.map(source=>({from:`raw/sources/${source.currentIdentity}`,to:'raw/sources/主题/new.md'}))},newFiles:[]})};
 const options={strategies:{inbox:strategy},stateDirectory:path.join(f.root,'state'),migration:createMigrationService({verify}),recovery:createRecoveryService({verify}),original:createOriginalExecutionService({verify}),backup:input=>createBackup(input,{inspect:input=>preflight(input,{sourceManifest:{version:'0.6.11',commit:UPSTREAM_COMMIT,files:{fixture:digest('verified-test-format')}}})})};
 let service=createBatchService(options),batch=await service.create({mode:'inbox',libraryPath:f.backup.originalPath,sourceRoot:path.join(f.backup.originalPath,'raw/sources'),wikiSourcePath:path.join(f.root,'upstream'),artifactRoot});
 batch=await service.analyzeNext({batchId:batch.batchId,revision:batch.revision});batch=await service.reviewItem({batchId:batch.batchId,revision:batch.revision,sourceId:batch.sources[0].sourceId});
 batch=await service.prepareSlice({batchId:batch.batchId,revision:batch.revision,writersPaused:true});const sliceId=batch.slices[0].sliceId;
 service=createBatchService(options);batch=await service.validateSlice({batchId:batch.batchId,revision:batch.revision,sliceId,approved:true,writersPaused:true});
 batch=await service.prepareOriginal({batchId:batch.batchId,revision:batch.revision,sliceId,writersPaused:true});batch=await service.applySlice({batchId:batch.batchId,revision:batch.revision,sliceId,approved:true,writersPaused:true});
 assert.equal(batch.sources[0].status,'succeeded');assert.equal(batch.slices[0].status,'complete');assert.equal(await readFile(path.join(f.backup.originalPath,'raw/sources/主题/new.md'),'utf8'),'# 已摄取的短源');
 const repeated=await service.applySlice({batchId:batch.batchId,revision:batch.revision,sliceId,approved:true,writersPaused:true});assert.equal(repeated.slices[0].originalResultPath,batch.slices[0].originalResultPath);
});
