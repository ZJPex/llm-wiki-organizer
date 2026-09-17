import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {connect,makeArrowTable} from '@lancedb/lancedb';
import {Schema,Field,Utf8,Uint32,Float32,FixedSizeList} from 'apache-arrow';
import {createBackup} from '../src/backup.js';
import {digest,inventory,preflight} from '../src/compatibility.js';
import {createMigrationService} from '../src/migration.js';
import {sourceFrontmatter} from '../src/source-format.js';
import {UPSTREAM_COMMIT,nativeRescanVerifier} from '../src/migration-verifier.js';
const execute=promisify(execFile);
const quiet=async()=>({upstreamCommit:UPSTREAM_COMMIT,result:{changedTasks:[],queue:{version:1,tasks:[]}},events:[]});
const vector=new Field('vector',new FixedSizeList(3,new Field('item',new Float32(),true)),false);
const v1schema=new Schema([new Field('page_id',new Utf8(),false),vector]);
const v2schema=new Schema([new Field('chunk_id',new Utf8(),false),new Field('page_id',new Utf8(),false),new Field('chunk_index',new Uint32(),false),new Field('chunk_text',new Utf8(),false),new Field('heading_path',new Utf8(),false),vector]);
async function fixture(t,{indexed=true,badSchema=false,revision=false,retained=false}={}) {
 const root=await mkdtemp(path.join(tmpdir(),'organizer-shared-index-'));
 if(!retained)t.after(()=>rm(root,{recursive:true,force:true}));
 const libraryPath=path.join(root,'library'),wikiSourcePath=path.join(root,'upstream');
 for(const dir of ['raw/sources','wiki/sources','.llm-wiki'])await mkdir(path.join(libraryPath,dir),{recursive:true});
 await mkdir(wikiSourcePath);
 await writeFile(path.join(wikiSourcePath,'package.json'),JSON.stringify({name:'llm-wiki',version:'0.6.11'}));
 await writeFile(path.join(wikiSourcePath,'fixture'),'fixed-index-proof');
 const sourceManifest={version:'0.6.11',commit:UPSTREAM_COMMIT,files:{fixture:digest('fixed-index-proof')}};
 const write=async(file,data)=>writeFile(path.join(libraryPath,file),typeof data==='string'?data:JSON.stringify(data));
 const originalId=randomUUID();
 await write('.llm-wiki/project.json',{id:originalId,createdAt:1});
 await write('raw/sources/old.md','短来源一');await write('raw/sources/other.md','其他来源二');
 await write('wiki/sources/old.md','---\nsources: ["old.md"]\n---\n原摘要正文');
 await write('wiki/sources/other.md','---\nsources: ["other.md"]\n---\n其他摘要');
 await write('wiki/shared.md','---\nsources: ["old.md", "other.md"]\n---\n共享知识正文');
 await write('.llm-wiki/ingest-cache.json',{entries:{'old.md':{hash:digest('短来源一'),timestamp:17,filesWritten:['wiki/sources/old.md','wiki/shared.md']},'other.md':{hash:digest('其他来源二'),timestamp:23,filesWritten:['wiki/sources/other.md','wiki/shared.md','wiki/sources/old.md']}}});
 await write('.llm-wiki/ingest-queue.json',[]);await write('.llm-wiki/file-change-queue.json',{version:1,tasks:[]});
 if(indexed){
  const db=await connect(path.join(libraryPath,'.llm-wiki/lancedb'));
  await db.createTable('wiki_vectors',makeArrowTable([{page_id:'old',vector:[0,1,0]},{page_id:'shared',vector:[1,0,0]},{page_id:'other',vector:[0,0,1]}],{schema:v1schema}));
  const chunks=[{chunk_id:'old#0',page_id:'old',chunk_index:0,chunk_text:'原摘要正文',heading_path:'',vector:[0,1,0]},{chunk_id:'old#1',page_id:'old',chunk_index:1,chunk_text:'原摘要第二段',heading_path:'章节',vector:[0.1,0.9,0]},{chunk_id:'shared#0',page_id:'shared',chunk_index:0,chunk_text:'共享知识正文',heading_path:'',vector:[1,0,0]}];
  await db.createTable('wiki_chunks_v2',badSchema?chunks:makeArrowTable(chunks,{schema:v2schema}));
 }
 if(revision){await mkdir(path.join(libraryPath,'.llm-wiki/embedding-revisions'));await write(`.llm-wiki/embedding-revisions/${digest('old')}.revision`,`sha256:${'1'.repeat(64)}`);}
 const snapshot={};
 for(const file of (await inventory(libraryPath)).files.filter(file=>file.path.endsWith('.md'))){const bytes=await readFile(path.join(libraryPath,file.path));snapshot[file.path]={hash:createHash('md5').update(bytes).digest('hex'),size:bytes.length,mtimeMs:Math.trunc((await lstat(path.join(libraryPath,file.path))).mtimeMs)};}
 await write('.llm-wiki/file-snapshot.json',{version:1,updatedAt:1,files:snapshot});
 const backup=await createBackup({libraryPath,wikiSourcePath,backupPath:path.join(root,'backup'),validationPath:path.join(root,'validation'),writersPaused:true},{inspect:input=>preflight(input,{sourceManifest})});
 assert.equal(backup.status,'complete',JSON.stringify(backup.errors));
 return {root,backup,input:{reportPath:backup.reportPath,oldPath:'raw/sources/old.md',newPath:'raw/sources/主题/new.md',writersPaused:true}};
}
async function migrateAndCheck(f,verify=quiet){
 const service=createMigrationService({verify});
 const plan=await service.plan(f.input);
 assert.deepEqual(plan.associations.sharedSources.map(x=>x.identity),['other.md']);
 const result=await service.execute({planId:plan.planId,approved:true,writersPaused:true});
 assert.equal(result.status,'complete',JSON.stringify(result.error));
 const cache=JSON.parse(await readFile(path.join(f.backup.validationPath,'.llm-wiki/ingest-cache.json'),'utf8'));
 assert.equal(cache.entries['other.md'].timestamp,23);
 assert.ok(cache.entries['other.md'].filesWritten.includes(plan.summaryMapping.newPath));
 assert.ok(!cache.entries['other.md'].filesWritten.includes('wiki/sources/old.md'));
 assert.deepEqual(sourceFrontmatter(await readFile(path.join(f.backup.validationPath,'wiki/shared.md'),'utf8')).sources,['主题/new.md','other.md']);
 assert.ok((await readFile(path.join(f.backup.validationPath,'wiki/shared.md'),'utf8')).endsWith('共享知识正文'));
 assert.equal((await inventory(f.backup.originalPath)).hash,f.backup.baseline.hash);
 assert.equal((await inventory(f.backup.backupPath)).hash,f.backup.baseline.hash);
 assert.deepEqual(result.modelAttempts,[]);
 return {plan,result};
}
test('共享产出无索引：所有缓存摘要路径更新，其他来源和知识正文保留',async t=>{await migrateAndCheck(await fixture(t,{indexed:false}));});
test('真实LanceDB v1/v2：修改摘要标识后逐值保留全部向量，重连搜索仍返回原共享页和新摘要',async t=>{
 const f=await fixture(t);const {plan,result}=await migrateAndCheck(f);
 assert.equal(result.indexProof.status,'verified');assert.ok(result.indexProof.tables.every(table=>table.vectorsPreserved));
 const db=await connect(path.join(f.backup.validationPath,'.llm-wiki/lancedb'));
 for(const name of ['wiki_vectors','wiki_chunks_v2']){
  const table=await db.openTable(name),rows=await table.query().toArray();
  assert.ok(rows.every(row=>row.page_id!=='old'));
  assert.equal((await table.vectorSearch([1,0,0]).limit(1).toArray())[0].page_id,'shared');
  const slug=path.posix.basename(plan.summaryMapping.newPath,'.md');
  assert.equal((await table.vectorSearch([0,1,0]).limit(1).toArray())[0].page_id,slug);
 }
});
test('未知Arrow schema及受影响API revision拒绝，三份数据不改变',async t=>{
 for(const options of [{badSchema:true},{revision:true}]){
  const f=await fixture(t,options);await assert.rejects(createMigrationService({verify:quiet}).plan(f.input),{code:'UNSUPPORTED_INDEX'});
  assert.equal((await inventory(f.backup.validationPath)).hash,f.backup.validationBaseline.hash);
 }
});
test('共享索引迁移实际副本通过真实Rust重扫', {skip:!process.env.ORGANIZER_RESCAN_BINARY&&process.env.ORGANIZER_TEST_WSL_RESCAN!=='1'},async t=>{
 const f=await fixture(t,{retained:process.env.ORGANIZER_KEEP_PROOF==='1'});
 const verify=process.env.ORGANIZER_RESCAN_BINARY?nativeRescanVerifier():async({validationPath,projectId})=>{
  const linux=validationPath.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,drive)=>`/mnt/${drive.toLowerCase()}`);
  const {stdout}=await execute('wsl.exe',['-d','Ubuntu-24.04','--','/tmp/organizer-spec-1/rescan-target/debug/organizer-upstream-rescan','--validation-copy',linux,projectId],{windowsHide:true});return JSON.parse(stdout);
 };
 const {result}=await migrateAndCheck(f,verify);assert.deepEqual(result.afterProof.result.changedTasks,[]);
 if(process.env.ORGANIZER_KEEP_PROOF==='1')console.log(`T5_PROOF=${JSON.stringify({validationPath:f.backup.validationPath,reportPath:f.backup.reportPath,journalPath:result.journalPath})}`);
});
