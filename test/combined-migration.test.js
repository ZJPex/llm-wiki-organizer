import {test} from 'node:test';
import {once} from 'node:events';
import {createApp} from '../src/server.mjs';
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
async function fixture(t,{indexed=true,badSchema=false,revision=false,retained=false,longValidation=false}={}) {
 const root=await mkdtemp(path.join(tmpdir(),'organizer-combined-'));
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
 await write('raw/sources/old.md','短来源一 [其他](other.md)');await write('raw/sources/other.md','其他来源二 [[raw/sources/old#章节|旧源]]');
 await write('wiki/sources/old.md','---\nsources: ["old.md"]\n---\n原摘要正文');
 await write('wiki/sources/other.md','---\nsources: ["other.md"]\n---\n其他摘要');
 await write('wiki/shared.md','---\nsources: ["old.md", "other.md"]\n---\n共享知识正文');
 await write('.llm-wiki/ingest-cache.json',{entries:{'old.md':{hash:digest('短来源一 [其他](other.md)'),timestamp:17,filesWritten:['wiki/sources/old.md','wiki/shared.md']},'other.md':{hash:digest('其他来源二 [[raw/sources/old#章节|旧源]]'),timestamp:23,filesWritten:['wiki/sources/other.md','wiki/shared.md','wiki/sources/old.md']}}});
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
 const validationPath=path.join(root,longValidation?'validation-'+ 'x'.repeat(150):'validation');
 const backup=await createBackup({libraryPath,wikiSourcePath,backupPath:path.join(root,'backup'),validationPath,writersPaused:true},{inspect:input=>preflight(input,{sourceManifest})});
 assert.equal(backup.status,'complete',JSON.stringify(backup.errors));
 return {root,backup,input:{reportPath:backup.reportPath,oldPath:'raw/sources/old.md',newPath:'raw/sources/主题/new.md',writersPaused:true}};
}

function plainRows(rows) {
 return rows.map(row=>Object.fromEntries(Object.entries(row).map(([name,value])=>[name,name==='vector'?Array.from(value):value]))).sort((a,b)=>(a.chunk_id??a.page_id).localeCompare(b.chunk_id??b.page_id));
}
test('Windows 过长的 LanceDB 副本路径在规划阶段阻止，来源与备份不变',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t,{longValidation:true});
 const before=(await inventory(f.backup.validationPath)).hash;
 const service=createMigrationService({verify:quiet});
 await assert.rejects(service.plan(f.input),/Windows LanceDB 写入路径过长/);
 assert.equal((await inventory(f.backup.validationPath)).hash,before);
 assert.equal((await inventory(f.backup.originalPath)).hash,f.backup.baseline.hash);
 assert.equal((await inventory(f.backup.backupPath)).hash,f.backup.baseline.hash);
});
test('公开迁移批次协作：Raw反链、共享来源及真实v1/v2向量同步保留',async t=>{
 const f=await fixture(t,{retained:process.env.ORGANIZER_KEEP_PROOF==='1'});
 const dbBefore=await connect(path.join(f.backup.validationPath,'.llm-wiki/lancedb'));
 const before={};for(const name of ['wiki_vectors','wiki_chunks_v2'])before[name]=plainRows(await(await dbBefore.openTable(name)).query().toArray());
 const verify=process.env.ORGANIZER_RESCAN_BINARY?nativeRescanVerifier():process.env.ORGANIZER_TEST_WSL_RESCAN==='1'?async({validationPath,projectId})=>{
  const linux=validationPath.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,drive)=>`/mnt/${drive.toLowerCase()}`);
  const {stdout}=await execute('wsl.exe',['-d','Ubuntu-24.04','--','/tmp/organizer-spec-1/rescan-target/debug/organizer-upstream-rescan','--validation-copy',linux,projectId],{windowsHide:true});return JSON.parse(stdout);
 }:quiet;
 const app=createApp({migration:createMigrationService({verify})});app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>new Promise(resolve=>app.close(resolve)));
 const base=`http://127.0.0.1:${app.address().port}`,{token}=await(await fetch(`${base}/api/session`)).json();
 const call=async(action,input)=>{const response=await fetch(`${base}/api/migration/${action}`,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;};
 const plan=await call('plan',f.input);
 assert.ok(plan.links.repairs.some(repair=>repair.path==='raw/sources/other.md'));
 assert.ok(plan.links.repairs.some(repair=>repair.path==='raw/sources/old.md'));
 assert.deepEqual(plan.associations.sharedSources.map(item=>item.identity),['other.md']);
 assert.equal(plan.indexes.tables.length,2);
 const result=await call('execute',{planId:plan.planId,approved:true,writersPaused:true});
 assert.equal(result.status,'complete',JSON.stringify(result.error));assert.deepEqual(result.modelAttempts,[]);assert.deepEqual(result.afterProof.result.changedTasks,[]);
 const read=file=>readFile(path.join(f.backup.validationPath,file),'utf8');
 const other=await read('raw/sources/other.md'),moved=await read(f.input.newPath);
 assert.ok(other.includes('[[raw/sources/主题/new#章节|旧源]]'));assert.ok(moved.includes('[其他](../other.md)'));
 const cache=JSON.parse(await read('.llm-wiki/ingest-cache.json'));
 assert.equal(cache.entries['other.md'].hash,digest(other));assert.equal(cache.entries['主题/new.md'].hash,digest(moved));
 assert.equal(cache.entries['other.md'].timestamp,23);assert.ok(cache.entries['other.md'].filesWritten.includes(plan.summaryMapping.newPath));
 assert.deepEqual(sourceFrontmatter(await read('wiki/shared.md')).sources,['主题/new.md','other.md']);assert.equal(sourceFrontmatter(await read('wiki/shared.md')).body,'共享知识正文');
 const snapshot=JSON.parse(await read('.llm-wiki/file-snapshot.json'));
 for(const file of ['raw/sources/other.md',f.input.newPath])assert.equal(snapshot.files[file].hash,createHash('md5').update(await read(file)).digest('hex'));
 const slug=path.posix.basename(plan.summaryMapping.newPath,'.md');const dbAfter=await connect(path.join(f.backup.validationPath,'.llm-wiki/lancedb'));
 for(const name of ['wiki_vectors','wiki_chunks_v2']){
  const expected=plainRows(before[name].map(row=>({...row,page_id:row.page_id==='old'?slug:row.page_id,...(row.chunk_id?.startsWith('old#')?{chunk_id:slug+row.chunk_id.slice(3)}:{})})));
  const table=await dbAfter.openTable(name);assert.deepEqual(plainRows(await table.query().toArray()),expected);
  assert.equal((await table.vectorSearch([1,0,0]).limit(1).toArray())[0].page_id,'shared');assert.equal((await table.vectorSearch([0,1,0]).limit(1).toArray())[0].page_id,slug);
 }
 assert.equal((await inventory(f.backup.originalPath)).hash,f.backup.baseline.hash);assert.equal((await inventory(f.backup.backupPath)).hash,f.backup.baseline.hash);
 if(process.env.ORGANIZER_KEEP_PROOF==='1')console.log(`T45_PROOF=${JSON.stringify({validationPath:f.backup.validationPath,reportPath:f.backup.reportPath,journalPath:result.journalPath})}`);
});
