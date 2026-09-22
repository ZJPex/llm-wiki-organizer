import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import {buildBatchReport,readArchiveReportEvidence} from '../src/batch-report.js';
import {planDigest} from '../src/categories.js';
import {createBatchStore} from '../src/batch-store.js';
import {createBatchService} from '../src/batches.js';
import {createApp} from '../src/server.mjs';
import {listenForBrowser} from './helpers/http-server.js';

const record=()=>({mode:'inbox',libraryPath:path.resolve('test-library'),sourceRoot:path.resolve('test-inbox'),phase:'batch-progress',flow:{newArchives:[{items:[{sourceId:'1',status:'succeeded',to:path.resolve('test-library/raw/sources/one.md')}]}]},sources:[{sourceId:'1',identity:'a.md',currentPath:path.resolve('test-library/raw/sources/one.md'),status:'succeeded'},{sourceId:'2',identity:'empty.md',currentPath:path.resolve('test-inbox/empty.md'),status:'needs-information'}],slices:[],events:[]});
test('整批报告包含未选低信息材料，不把授权范围全部成功当整批完成',()=>{
 const report=buildBatchReport(record());assert.equal(report.status,'partial');assert.equal(report.counts.total,2);assert.equal(report.counts.succeeded,1);assert.equal(report.counts.retained,1);assert.match(report.items[1].reason,/信息不足/);
});
test('多次执行累计成功；归档中断只能报告未验证，复制歧义不允许续作',()=>{
 const batch=record();batch.sources.push({sourceId:'3',identity:'b.md',currentPath:path.resolve('test-inbox/b.md'),status:'reviewed'});batch.flow.newArchives.push({items:[{sourceId:'3',status:'failed',sliceId:'three'}]});batch.slices.push({sliceId:'three',sourceIds:['3'],status:'failed',newFiles:[{sourceId:'3'}],archiveResult:{archiveJournalPath:'archive.json',items:[{sourceId:'3',from:'b.md',to:'c.md',status:'copy-intent'}]}});
 let report=buildBatchReport(batch);assert.equal(report.counts.succeeded,1);assert.equal(report.status,'partial');assert.deepEqual(report.evidence[0].allowedActions,[]);
 batch.slices[0].archiveResult.items[0].status='copied';report=buildBatchReport(batch);assert.deepEqual(report.evidence[0].allowedActions,['applySlice']);
 batch.slices[0].status='applying';delete batch.slices[0].archiveResult;report=buildBatchReport(batch);assert.equal(report.status,'needs-recovery');assert.equal(report.counts.unverified,1);
});
test('归档进程退出后报告只读校验磁盘日志，损坏证据不授予续作',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'organizer-report-journal-'));t.after(()=>rm(root,{recursive:true,force:true}));const batch=record();batch.batchId='report-batch';batch.phase='archive-running';
 const slice={sliceId:'copy',status:'applying',sourceIds:['2'],artifactDirectory:root,newFiles:[{sourceId:'2',from:batch.sources[1].currentPath,to:path.join(root,'target.md')}],watchConfig:{hash:'watch'}};batch.slices.push(slice);
 const manifest={batchId:batch.batchId,sliceId:slice.sliceId,newFiles:slice.newFiles,watchConfig:slice.watchConfig};const journal={...manifest,manifestHash:planDigest(manifest),status:'running',items:[{...slice.newFiles[0],status:'copied'}]};journal.journalHash=planDigest(journal);const file=path.join(root,'inbox-archive.json');await writeFile(file,JSON.stringify(journal));
 const report=buildBatchReport(await readArchiveReportEvidence(batch));assert.equal(report.status,'needs-recovery');assert.equal(report.evidence[0].archiveJournalPath,file);assert.deepEqual(report.evidence[0].allowedActions,['applySlice']);assert.equal(batch.slices[0].archiveResult,undefined);
 journal.items[0].status='succeeded';await writeFile(file,JSON.stringify(journal));const broken=buildBatchReport(await readArchiveReportEvidence(batch));assert.equal(broken.evidence[0].error.code,'INVALID_JOURNAL');assert.deepEqual(broken.evidence[0].allowedActions,[]);
});
test('公开任务报告分页与重启：结果来自持久记录，恢复链接只指向真实迁移日志',async t=>{
 const stateDirectory=await mkdtemp(path.join(os.tmpdir(),'organizer-report-'));t.after(()=>rm(stateDirectory,{recursive:true,force:true}));const store=createBatchStore({stateDirectory}),input=record();
 for(let i=0;i<55;i++){input.sources.push({sourceId:'extra'+i,identity:i+'.md',currentPath:path.resolve(i+'.md'),status:'excluded'});input.slices.push({sliceId:'slice'+i,status:'failed',validationJournalPath:path.resolve('validation-'+i+'.json'),recoveryPlanPath:path.resolve('recovery-'+i+'.json')});}
 const batch=await store.create(input);
 const read=async()=>{const service=createBatchService({stateDirectory}),server=createApp({batches:service});await listenForBrowser(server);const base='http://127.0.0.1:'+server.address().port;
  try{const {token}=await(await fetch(base+'/api/session')).json();const post=async(action,args)=>{const response=await fetch(base+'/api/batches/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(args)});assert.equal(response.status,200);return response.json();};const first=await post('getReport',{batchId:batch.batchId}),second=await post('getReport',{batchId:batch.batchId,cursor:first.nextCursor,evidenceCursor:first.evidenceNextCursor});assert.equal(first.items.length+second.items.length,57);assert.equal(first.evidence.length+second.evidence.length,55);assert.deepEqual(first.evidence[0].allowedActions,['inspectRecovery']);assert.equal((await post('list',{})).records[0].report.counts.retained,56);return first;}finally{await new Promise(resolve=>server.close(resolve));}};
 assert.deepEqual(await read(),await read());
});
