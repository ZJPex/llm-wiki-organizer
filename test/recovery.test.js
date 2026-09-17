import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {migrationFixture} from './helpers/migration-fixture.js';
import {createMigrationService} from '../src/migration.js';
import {createRecoveryService} from '../src/recovery.js';
import {inventory} from '../src/compatibility.js';
import {UPSTREAM_COMMIT,nativeRescanVerifier} from '../src/migration-verifier.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {connect,makeArrowTable} from '@lancedb/lancedb';
import {Schema,Field,Utf8,Uint32,Float32,FixedSizeList} from 'apache-arrow';
import {digest} from '../src/compatibility.js';
import {once} from 'node:events';
import {createApp} from '../src/server.mjs';
import {validateExternalCopy} from '../scripts/upstream-frontend/external-copy.mjs';
const exec=promisify(execFile);
const quiet=async()=>({upstreamCommit:UPSTREAM_COMMIT,result:{changedTasks:[],queue:{version:1,tasks:[]}},events:[]});
async function failedFixture(t){
 const f=await migrationFixture(t);const migration=createMigrationService({verify:quiet,checkpoint:async stage=>{if(stage==='move')throw new Error('故障后保留');}});
 const plan=await migration.plan(f.input);const failed=await migration.execute({planId:plan.planId,approved:true,writersPaused:true});assert.equal(failed.status,'failed');
 await writeFile(path.join(f.backup.validationPath,'raw/sources/新增.md'),'迁移后新材料');
 await writeFile(path.join(f.backup.validationPath,'wiki/concept.md'),'迁移后用户新修改');
 return {...f,failed};
}
test('独立目录恢复：保留现场和新增，重启服务仅凭磁盘计划恢复来源缓存',async t=>{
 const f=await failedFixture(t),service=createRecoveryService({verify:quiet});
 const inspect=await service.inspect({journalPath:f.failed.journalPath});assert.ok(inspect.changes.added.includes('raw/sources/新增.md'));
 const plan=await service.plan({journalPath:f.failed.journalPath,mode:'new-directory',destination:path.join(f.root,'recovered'),writersPaused:true});
 const result=await createRecoveryService({verify:quiet}).execute({recoveryPlanPath:plan.recoveryPlanPath,approved:true,writersPaused:true});
 assert.equal(result.status,'complete',JSON.stringify(result.error));assert.deepEqual(result.modelAttempts,[]);
 assert.equal(await readFile(path.join(result.scenePath,'raw/sources/新增.md'),'utf8'),'迁移后新材料');
 assert.equal(await readFile(path.join(result.scenePath,'wiki/concept.md'),'utf8'),'迁移后用户新修改');
 assert.equal(await readFile(path.join(result.restoreRoot,'raw/sources/old.md'),'utf8'),'# 已摄取的短源');
 assert.equal((await inventory(f.backup.backupPath)).hash,f.backup.baseline.hash);
 assert.notEqual(result.projectId,f.backup.relocation.originalProjectId);
 assert.equal((await createRecoveryService().get({recoveryPlanPath:plan.recoveryPlanPath})).status,'complete');
 const report=JSON.parse(await readFile(result.reportPath,'utf8'));report.phase='伪造完成';await writeFile(result.reportPath,JSON.stringify(report));
 await assert.rejects(service.get({recoveryPlanPath:plan.recoveryPlanPath}),{code:'INVALID_EVIDENCE'});
});
test('原位置恢复：park后中断，新进程实例识别现场并继续安装且保留原副本身份',async t=>{
 const f=await failedFixture(t),service=createRecoveryService({verify:quiet,checkpoint:async stage=>{if(stage==='park')throw new Error('模拟进程在目录换位后中断');}});
 const plan=await service.plan({journalPath:f.failed.journalPath,mode:'same-location',writersPaused:true});
 const first=await service.execute({recoveryPlanPath:plan.recoveryPlanPath,approved:true,writersPaused:true});assert.equal(first.status,'failed');assert.equal(first.phase,'park');
 await assert.rejects(lstat(f.backup.validationPath),{code:'ENOENT'});
 const result=await createRecoveryService({verify:quiet}).execute({recoveryPlanPath:plan.recoveryPlanPath,approved:true,writersPaused:true});
 assert.equal(result.status,'complete',JSON.stringify(result.error));assert.equal(result.projectId,f.backup.relocation.validationProjectId);
 assert.equal(await readFile(path.join(result.scenePath,'raw/sources/新增.md'),'utf8'),'迁移后新材料');
 assert.equal(await readFile(path.join(result.restoreRoot,'raw/sources/old.md'),'utf8'),'# 已摄取的短源');
});
test('损坏备份、变化现场、重叠目标和模型尝试不被报告为恢复成功',async t=>{
 const f=await failedFixture(t),service=createRecoveryService({verify:quiet});
 await assert.rejects(service.plan({journalPath:f.failed.journalPath,mode:'new-directory',destination:f.backup.backupPath,writersPaused:true}));
 const plan=await service.plan({journalPath:f.failed.journalPath,mode:'new-directory',destination:path.join(f.root,'recovered'),writersPaused:true});
 await writeFile(path.join(f.backup.validationPath,'raw/sources/之后.md'),'新变化');
 const stale=await service.execute({recoveryPlanPath:plan.recoveryPlanPath,approved:true,writersPaused:true});assert.equal(stale.status,'failed');assert.equal(stale.error.code,'HASH_MISMATCH');
 const next=await service.plan({journalPath:f.failed.journalPath,mode:'new-directory',destination:path.join(f.root,'recovered2'),writersPaused:true});
 const unsafe=createRecoveryService({verify:async({models})=>{await models.embed().catch(()=>{});return quiet();}});
 const failed=await unsafe.execute({recoveryPlanPath:next.recoveryPlanPath,approved:true,writersPaused:true});assert.equal(failed.status,'failed');assert.ok(failed.modelAttempts.length);
 await writeFile(path.join(f.backup.backupPath,'raw/sources/old.md'),'损坏');await assert.rejects(service.inspect({journalPath:f.failed.journalPath}),{code:'HASH_MISMATCH'});
});
test('恢复独立副本通过真实Rust重扫', {skip:!process.env.ORGANIZER_RESCAN_BINARY},async t=>{
 const f=await failedFixture(t),service=createRecoveryService({verify:nativeRescanVerifier()});
 const plan=await service.plan({journalPath:f.failed.journalPath,mode:'new-directory',destination:path.join(f.root,'recovered'),writersPaused:true});
 const result=await service.execute({recoveryPlanPath:plan.recoveryPlanPath,approved:true,writersPaused:true});assert.equal(result.status,'complete',JSON.stringify(result.error));assert.deepEqual(result.verification.proof.result.changedTasks,[]);
});

test('真实子进程在park换位后退出，只凭磁盘记录继续原位置恢复',async t=>{
 const f=await failedFixture(t),service=createRecoveryService({verify:quiet});
 const plan=await service.plan({journalPath:f.failed.journalPath,mode:'same-location',writersPaused:true});
 const code=`import {createRecoveryService} from ${JSON.stringify(new URL('../src/recovery.js',import.meta.url).href)};const service=createRecoveryService({verify:${quiet.toString().replace('UPSTREAM_COMMIT',JSON.stringify(UPSTREAM_COMMIT))},checkpoint:async stage=>{if(stage==='park')process.exit(77)}});await service.execute({recoveryPlanPath:process.argv[1],approved:true,writersPaused:true});`;
 await assert.rejects(exec(process.execPath,['--input-type=module','-e',code,plan.recoveryPlanPath]),error=>error.code===77);
 const interrupted=await service.get({recoveryPlanPath:plan.recoveryPlanPath});assert.equal(interrupted.phase,'park');assert.equal(interrupted.status,'running');
 const result=await createRecoveryService({verify:quiet}).execute({recoveryPlanPath:plan.recoveryPlanPath,approved:true,writersPaused:true});assert.equal(result.status,'complete',JSON.stringify(result.error));
});

test('公开恢复入口还原共享来源、绝对缓存、链接与真实v1/v2索引，备份保持原样',async t=>{
 const f=await migrationFixture(t,{retained:process.env.ORGANIZER_KEEP_PROOF==='1',decorate:async({write,libraryPath,summary})=>{
  await write('raw/sources/other.md','# 其他来源');
  await write('wiki/concept.md','---\nsources: ["old.md", "other.md"]\n---\n共享知识');
  await write('wiki/reference.md','链接 [源](../raw/sources/old.md)');
  await write('.llm-wiki/ingest-cache.json',{entries:{'old.md':{hash:digest('# 已摄取的短源'),timestamp:1,filesWritten:[path.join(libraryPath,summary),'wiki/concept.md']},'other.md':{hash:digest('# 其他来源'),timestamp:2,filesWritten:['wiki/concept.md']}}});
  const db=await connect(path.join(libraryPath,'.llm-wiki/lancedb'));
  const vector=new Field('vector',new FixedSizeList(3,new Field('item',new Float32(),true)),false);
  await db.createTable('wiki_vectors',makeArrowTable([{page_id:'old',vector:[0.1,-0,1]},{page_id:'concept',vector:[1,0,0]}],{schema:new Schema([new Field('page_id',new Utf8(),false),vector])}));
  await db.createTable('wiki_chunks_v2',makeArrowTable([{chunk_id:'old#0',page_id:'old',chunk_index:0,chunk_text:'保持摘要正文。',heading_path:'',vector:[0.1,-0,1]}],{schema:new Schema([new Field('chunk_id',new Utf8(),false),new Field('page_id',new Utf8(),false),new Field('chunk_index',new Uint32(),false),new Field('chunk_text',new Utf8(),false),new Field('heading_path',new Utf8(),false),vector])}));
 }});
 const verify=process.env.ORGANIZER_RESCAN_BINARY?nativeRescanVerifier():quiet;
 const migration=createMigrationService({verify}),mp=await migration.plan(f.input),mr=await migration.execute({planId:mp.planId,approved:true,writersPaused:true});assert.equal(mr.status,'complete',JSON.stringify(mr.error));
 await writeFile(path.join(f.backup.validationPath,'raw/sources/新增.md'),'保留新增');
 const app=createApp({recovery:createRecoveryService({verify})});app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>new Promise(resolve=>app.close(resolve)));
 const base=`http://127.0.0.1:${app.address().port}`,{token}=await(await fetch(`${base}/api/session`)).json();
 const call=async(action,input)=>{const response=await fetch(`${base}/api/recovery/${action}`,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;};
 const plan=await call('plan',{journalPath:mr.journalPath,mode:'new-directory',destination:path.join(f.root,'recovered'),writersPaused:true});const result=await call('execute',{recoveryPlanPath:plan.recoveryPlanPath,approved:true,writersPaused:true});
 assert.equal(result.status,'complete',JSON.stringify(result.error));assert.equal(result.verification.sources,2);assert.equal(result.verification.indexes.tables.length,2);assert.deepEqual(result.modelAttempts,[]);
 const cache=JSON.parse(await readFile(path.join(result.restoreRoot,'.llm-wiki/ingest-cache.json'),'utf8'));assert.equal(cache.entries['old.md'].filesWritten[0].replaceAll('\\','/'),path.join(result.restoreRoot,f.summary).replaceAll('\\','/'));
 assert.ok((await readFile(path.join(result.restoreRoot,'wiki/reference.md'),'utf8')).includes('../raw/sources/old.md'));
 const db=await connect(path.join(result.restoreRoot,'.llm-wiki/lancedb'));assert.equal((await(await db.openTable('wiki_vectors')).vectorSearch([0.1,0,1]).limit(1).toArray())[0].page_id,'old');
 assert.equal((await inventory(f.backup.backupPath)).hash,f.backup.baseline.hash);assert.equal((await call('get',{recoveryPlanPath:plan.recoveryPlanPath})).status,'complete');
 const env={UPSTREAM_VALIDATION_COPY:result.restoreRoot,UPSTREAM_VALIDATION_MANIFEST:result.reportPath,UPSTREAM_VALIDATION_RESULT:path.join(f.root,'frontend-report.json')};
 assert.equal((await validateExternalCopy(env)).projectId,result.projectId);
 await assert.rejects(validateExternalCopy({...env,UPSTREAM_VALIDATION_COPY:f.backup.originalPath}));
 if(process.env.ORGANIZER_KEEP_PROOF==='1')console.log('T7_PROOF='+JSON.stringify({root:result.restoreRoot,reportPath:result.reportPath,journalPath:mr.journalPath,recoveryPlanPath:plan.recoveryPlanPath}));
});

test('原库角色原位恢复保留原项目身份并隔离现场新增内容',async t=>{
 const f=await failedFixture(t),journal=JSON.parse(await readFile(f.failed.journalPath,'utf8'));
 const journalPath=path.join(f.root,'original-migration.json');
 await writeFile(journalPath,JSON.stringify({...journal,targetRole:'original',targetRoot:f.backup.originalPath}));
 await writeFile(path.join(f.backup.originalPath,'raw/sources/新增.md'),'原库失败后新增');
 const service=createRecoveryService({verify:quiet}),plan=await service.plan({journalPath,mode:'same-location',writersPaused:true});
 const result=await service.execute({recoveryPlanPath:plan.recoveryPlanPath,approved:true,writersPaused:true});assert.equal(result.status,'complete',JSON.stringify(result.error));assert.equal(result.projectId,f.backup.relocation.originalProjectId);
 assert.equal(await readFile(path.join(result.scenePath,'raw/sources/新增.md'),'utf8'),'原库失败后新增');
 assert.equal((await inventory(f.backup.backupPath)).hash,f.backup.baseline.hash);
});
