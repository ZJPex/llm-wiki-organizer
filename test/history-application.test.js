import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,lstat,readdir} from 'node:fs/promises';
import {historyFixture} from './helpers/history-fixture.js';
import {inventory} from '../src/compatibility.js';
const nodeApply=async f=>{await f.call('startHistoryValidation',{planHash:f.getBatch().historyPlan.planHash,writersPaused:true});const batch=await f.wait();assert.equal(batch.historyValidation.status,'awaiting-apply',JSON.stringify(batch.historyValidation));return {planHash:batch.historyValidation.planHash,evidenceDigest:batch.historyValidation.evidenceDigest,writersPaused:true,approved:true};};
async function waitApplied(f){for(let n=0;n<400;n++){await f.call('get');if(f.getBatch().historyApplication.status!=='running')return f.getBatch();await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('原库应用未结束');}

test('整份最终确认绑定证据，多个真实内部分批无需重复审核；混合新增随后归档且重复请求不移动',async t=>{
 const boundaries=[];const f=await historyFixture(t,{mixed:true,originalCheckpoint:async(stage,data)=>{if(stage==='group-place-complete'){const files=(await inventory(data.root)).files;boundaries.push({id:data.groupId,targets:files.filter(file=>file.path.startsWith('raw/sources/001 缓存/')).length});}}});
 const input=await nodeApply(f),before=await inventory(f.libraryPath),calls=f.modelCalls();
 await f.call('applyHistoryPlan',{...input,evidenceDigest:'旧证据'},400);await f.call('applyHistoryPlan',{...input,writersPaused:false},400);assert.equal((await inventory(f.libraryPath)).hash,before.hash);
 await f.call('applyHistoryPlan',input);await f.call('applyHistoryPlan',input);await f.restart();const batch=await waitApplied(f);assert.equal(batch.historyApplication.status,'complete',JSON.stringify(batch.historyApplication));assert.equal(batch.counts.succeeded,4);assert.ok(boundaries.length>1);assert.ok(boundaries[0].targets<boundaries.at(-1).targets);assert.ok(batch.historyApplication.groups.every(group=>group.status==='verified'));assert.equal(f.modelCalls(),calls);
 assert.match(await readFile(path.join(f.libraryPath,'raw/sources/001 缓存/new缓存.md'),'utf8'),/缓存一致性/);const after=await inventory(f.libraryPath);await f.call('applyHistoryPlan',input);assert.equal(f.getBatch().historyApplication.status,'complete');assert.equal((await inventory(f.libraryPath)).hash,after.hash);
 const report=await f.call('getReport');assert.equal(report.status,'complete');assert.equal(report.counts.succeeded,4);assert.ok(report.evidence[0].originalJournalPath);await f.restart();assert.deepEqual(await f.call('getReport'),report);
});

test('前一分批后插入外部写入阻断后续分批，依赖新增保源；重复请求不重放现场',async t=>{
 let injected=false;const f=await historyFixture(t,{mixed:true,originalCheckpoint:async(stage,data)=>{if(stage==='group-place-complete'&&!injected){injected=true;await writeFile(path.join(data.root,'external.md'),'外部程序修改，不能当作合法迁移');}}});
 const input=await nodeApply(f);await f.call('applyHistoryPlan',input);let batch=await waitApplied(f);assert.equal(batch.historyApplication.status,'needs-recovery');assert.match(batch.historyApplication.error.message,/外部变化/);assert.ok(batch.historyApplication.results.some(item=>item.status==='dependency-blocked'));assert.match(await readFile(path.join(f.libraryPath,'raw/sources/new.md'),'utf8'),/缓存/);await assert.rejects(lstat(path.join(f.libraryPath,'raw/sources/001 缓存/new缓存.md')),{code:'ENOENT'});
 const before=await inventory(f.libraryPath);await f.restart();await f.call('get');await f.call('applyHistoryPlan',input);assert.equal(f.getBatch().historyApplication.status,'needs-recovery');assert.equal((await inventory(f.libraryPath)).hash,before.hash);assert.equal(await readFile(path.join(f.libraryPath,'external.md'),'utf8'),'外部程序修改，不能当作合法迁移');
 const report=await f.call('getReport');assert.equal(report.status,'needs-recovery');assert.equal(report.counts.blocked,1);assert.equal(report.evidence[0].journalPath,report.evidence[0].originalJournalPath);assert.ok(report.evidence[0].allowedActions.includes('inspectRecovery'));assert.equal((await inventory(f.libraryPath)).hash,before.hash);
});

test('最终确认拒绝验证后外部来源变化，尚未生成原库写入授权',async t=>{
 const f=await historyFixture(t),input=await nodeApply(f);await writeFile(path.join(f.libraryPath,'raw/sources/old.md'),'原库已被外部编辑');await f.call('applyHistoryPlan',input,400);assert.equal(f.getBatch().historyApplication,null);assert.match(await readFile(path.join(f.libraryPath,'raw/sources/old.md'),'utf8'),/外部编辑/);assert.equal((await readdir(f.f.root)).filter(file=>file.includes('.authorization-')).length,0);
});

test('真实进程在第一个放置分批退出：重启只查询旧授权，无法证明成功时保留现场并引导恢复',async t=>{
 const {spawn}=await import('node:child_process');const f=await historyFixture(t),input=await nodeApply(f),batch=f.getBatch();
 const child=spawn(process.execPath,[new URL('./helpers/interrupted-history-application.mjs',import.meta.url).pathname.replace(/^\/([A-Z]:)/i,'$1'),f.stateDirectory,JSON.stringify({...input,batchId:batch.batchId,revision:batch.revision})],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});assert.equal(code,71,output);
 const beforeQuery=await inventory(f.libraryPath);await f.call('queryHistoryApplication');assert.equal(f.getBatch().historyApplication.status,'interrupted');assert.equal(f.getBatch().historyApplication.observedHistory.phase,'writing');assert.equal((await inventory(f.libraryPath)).hash,beforeQuery.hash);const before=await inventory(f.libraryPath);await f.call('applyHistoryPlan',input);const resumed=await waitApplied(f);assert.equal(resumed.historyApplication.status,'needs-recovery');assert.equal((await inventory(f.libraryPath)).hash,before.hash);assert.ok(resumed.historyApplication.journalPath);
});

test('历史写入前验证失败且完整原库仍可证明未动时，独立新增可归档，历史项明确未验证',async t=>{
 const f=await historyFixture(t,{mixed:true,originalVerify:async()=>{throw new Error('原库预验证失败，尚未写入');}}),input=await nodeApply(f);const old=await readFile(path.join(f.libraryPath,'raw/sources/old.md'),'utf8');
 await f.call('applyHistoryPlan',input);const batch=await waitApplied(f);assert.notEqual(batch.historyApplication.status,'complete');assert.equal(batch.historyApplication.results.filter(item=>item.status==='succeeded').length,1,JSON.stringify({job:batch.historyApplication,slice:batch.slices[0]?.archiveResult}));assert.equal(batch.historyApplication.results.filter(item=>item.status==='unverified').length,3);assert.equal(await readFile(path.join(f.libraryPath,'raw/sources/old.md'),'utf8'),old);await lstat(path.join(f.libraryPath,'raw/sources/001 缓存/new缓存.md'));
});

test('最终确认后自洽改写恢复证据也拒绝独立新增兜底，保持完整原库基线',async t=>{
 const {planDigest}=await import('../src/categories.js');let f;
 f=await historyFixture(t,{mixed:true,originalVerify:async()=>{const file=f.getBatch().historyValidation.recoveryReportPath,report=JSON.parse(await readFile(file,'utf8'));delete report.reportHash;report.unapprovedNote='最终授权后变化';report.reportHash=planDigest(report);await writeFile(file,JSON.stringify(report,null,2));throw new Error('注入证据变化后的验证失败');}});
 const input=await nodeApply(f),before=await inventory(f.libraryPath);await f.call('applyHistoryPlan',input);const batch=await waitApplied(f);assert.equal(batch.historyApplication.status,'needs-recovery');assert.equal(batch.historyApplication.independentArchiveError.code,'STALE_EVIDENCE');assert.equal(batch.slices[0].archiveResult,undefined);assert.equal((await inventory(f.libraryPath)).hash,before.hash);assert.match(await readFile(path.join(f.libraryPath,'raw/sources/new.md'),'utf8'),/缓存/);
});
