import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs,{mkdtemp,rm,writeFile,link,symlink,unlink} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {createBatchStore} from '../src/batch-store.js';
import {createBatchService} from '../src/batches.js';
import {createHistoryWorkflow,historyPlan,historyWorkflowView} from '../src/history-workflow.js';
import {createHistoryApplication,historyApplicationView} from '../src/history-application.js';
import {planDigest} from '../src/categories.js';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'organizer-read-race-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=createBatchStore({stateDirectory:path.join(root,'state')});const batch=await store.create({mode:'inbox',libraryPath:path.join(root,'library'),sourceRoot:path.join(root,'library/raw/sources'),artifactRoot:path.join(root,'artifacts'),flow:{},sources:[{sourceId:'one',identity:'one.md',currentPath:path.join(root,'library/raw/sources/one.md'),targetPath:path.join(root,'library/raw/sources/new.md'),status:'reviewed',selected:true,ingestStatus:'historical'}],slices:[]});return {root,store,batch};}
function delayedRead(store){let next=false;const captured=deferred(),release=deferred();return {store:{...store,get:async(...args)=>{const result=await store.get(...args);if(next){next=false;captured.resolve();await release.promise;}return result;}},pause:()=>{next=true;},captured:captured.promise,release:release.resolve};}
async function settled(store,id,key){for(let n=0;n<100;n++){const batch=await store.get(id);if(batch.flow[key].status!=='running'){await new Promise(resolve=>setImmediate(resolve));return batch;}await new Promise(resolve=>setTimeout(resolve,1));}assert.fail('后台任务未完成');}

for(const alias of process.platform==='win32'?[false,true]:[false])test(`读取校验尚未结束时同进程原子替换必须等待，旧 inode 不会被误判为链接（路径别名=${alias}）`,async t=>{
 const f=await fixture(t),canonicalDirectory=await fs.realpath(f.store.directory);
 // Windows CI 的 TEMP 可能含 8.3 短名；读取器使用 realpath，屏障必须匹配同一规范路径。
 // 大小写别名无需依赖磁盘启用 8.3，也能明确复现输入路径与真实路径不同的情形。
 if(alias){f.store=createBatchStore({stateDirectory:path.join(canonicalDirectory,'..','STATE')});assert.notEqual(f.store.directory,canonicalDirectory);assert.equal(await fs.realpath(f.store.directory),canonicalDirectory);}
 const file=path.join(canonicalDirectory,f.batch.batchId+'.json'),entered=deferred(),release=deferred();
 const stat=fs.lstat;let pause=true,writing=false;
 t.mock.method(fs,'lstat',async(...args)=>{const result=await stat(...args);if(args[0]===file&&pause){pause=false;entered.resolve();await release.promise;return writing?Object.assign(result,{nlink:0}):result;}return result;});syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const reading=f.store.get(f.batch.batchId);
 // 未命中屏障时明确失败，不能留下永远等待、导致其余测试一起取消的 Promise。
 await Promise.race([entered.promise,reading.then(()=>assert.fail('读取已结束但未触发文件校验屏障'))]);
 const update=createBatchStore({stateDirectory:f.store.directory}).update(f.batch.batchId,f.batch.revision,record=>{writing=true;return {...record,phase:'complete'};});
 await Promise.race([update,new Promise(resolve=>setTimeout(resolve,40))]);release.resolve();
 const observed=await reading;assert.equal(observed.revision,1);await update;
 assert.equal((await f.store.get(f.batch.batchId)).revision,2);
});

test('序列化读取仍拒绝真实硬链接与符号链接，损坏记录不能绕过校验',async t=>{
 const f=await fixture(t),file=path.join(f.store.directory,f.batch.batchId+'.json'),alias=path.join(f.root,'alias.json');
 await link(file,alias);await assert.rejects(f.store.get(f.batch.batchId),{code:'INVALID_BATCH'});await unlink(alias);
 await fs.rename(file,alias);try{await symlink(alias,file,'file');}catch(error){if(process.platform==='win32'&&error.code==='EPERM'){await fs.rename(alias,file);return;}throw error;}
 await assert.rejects(f.store.get(f.batch.batchId),{code:'INVALID_BATCH'});await unlink(file);await fs.rename(alias,file);
 await writeFile(file,'{"batchId":"forged"}');await assert.rejects(f.store.get(f.batch.batchId),{code:'INVALID_BATCH'});
});

test('历史验证完成跨越读取返回窗口：同进程旧 running 快照不能变成 interrupted',async t=>{
 const f=await fixture(t),entered=deferred(),finish=deferred(),delayed=delayedRead(f.store);
 const view=batch=>({revision:batch.revision,...historyWorkflowView(batch),...historyApplicationView(batch)});
 const workflow=createHistoryWorkflow({store:f.store,view,checkIdle:()=>{},fresh:async()=>{},strategy:()=>({prepare:async()=>{entered.resolve();await finish.promise;throw new Error('固定验证失败');}})});
 const application=createHistoryApplication({store:delayed.store,view});
 await workflow.startHistoryValidation({batchId:f.batch.batchId,revision:f.batch.revision,planHash:historyPlan(f.batch).planHash,writersPaused:true});await entered.promise;
 delayed.pause();const reading=application.get({batchId:f.batch.batchId});await delayed.captured;finish.resolve();await settled(f.store,f.batch.batchId,'historyValidation');delayed.release();
 const observed=await reading;assert.notEqual(observed.historyValidation.status,'interrupted');assert.equal((await application.get({batchId:f.batch.batchId})).historyValidation.status,'failed');
});

test('原库应用完成跨越读取返回窗口：终态清除内存执行权后不误报进程中断',async t=>{
 const f=await fixture(t),entered=deferred(),finish=deferred(),delayed=delayedRead(f.store);
 const authorizationPlanPath=path.join(f.root,'authorization.json'),resultPath=path.join(f.root,'result.json');
 const authorization={logicalPlanHash:'logical',planManifestPath:path.join(f.root,'manifest.json')};authorization.authorizationHash=planDigest(authorization);await writeFile(authorizationPlanPath,JSON.stringify(authorization));await writeFile(resultPath,'{}');
 const batch=await f.store.update(f.batch.batchId,f.batch.revision,record=>{record.flow.historyValidation={planHash:'plan',evidenceDigest:'evidence',logicalPlanHash:'logical',planManifestPath:authorization.planManifestPath,sliceId:'slice'};record.flow.historyApplication={status:'running',planHash:'plan',evidenceDigest:'evidence',sourceIds:['one'],authorizationPlanPath,resultPath};record.slices=[{sliceId:'slice',sourceIds:['one'],historicalRequest:{mappings:[{id:'one',from:'raw/sources/one.md',to:'raw/sources/new.md'}]}}];return record;});
 const view=record=>({revision:record.revision,...historyApplicationView(record)}),original={get:async()=>{entered.resolve();await finish.promise;return {status:'failed',phase:'verification-before',items:[],error:{message:'固定预验证失败'}};}};
 const application=createHistoryApplication({store:delayed.store,view,checkIdle:()=>{},original});
 await application.applyHistoryPlan({batchId:batch.batchId,revision:batch.revision,planHash:'plan',evidenceDigest:'evidence',writersPaused:true,approved:true});await entered.promise;
 delayed.pause();const reading=application.get({batchId:batch.batchId});await delayed.captured;finish.resolve();await settled(f.store,batch.batchId,'historyApplication');delayed.release();
 const observed=await reading;assert.notEqual(observed.historyApplication.status,'interrupted');assert.equal((await application.get({batchId:batch.batchId})).historyApplication.status,'needs-recovery');
});

test('报告读取日志时批次更新：保留同一版本快照，不拼接后读来源或误报 STALE_BATCH',async t=>{
 const f=await fixture(t),resultPath=path.join(f.root,'report-result.json');await writeFile(resultPath,'{}');
 const plan=historyPlan(f.batch),batch=await f.store.update(f.batch.batchId,f.batch.revision,record=>{record.flow.historyValidation={planHash:plan.planHash,plan,status:'awaiting-apply',sliceId:'slice'};record.flow.historyApplication={status:'running',sourceIds:['one'],resultPath};return record;});
 let changed=false;const service=createBatchService({stateDirectory:f.store.directory,original:{get:async()=>{if(!changed){changed=true;await f.store.update(batch.batchId,batch.revision,record=>{record.sources[0].identity='后一个版本.md';return record;});}return {status:'failed',phase:'verification-before',items:[]};}}});
 const report=await service.getReport({batchId:batch.batchId});assert.equal(report.revision,batch.revision);assert.equal(report.items[0].identity,'one.md');assert.equal(report.status,'needs-recovery');
 assert.equal((await service.getReport({batchId:batch.batchId})).items[0].identity,'后一个版本.md');
});
