import path from 'node:path';
import {readFile,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {batchFail} from './batch-store.js';
import {readHistoryEvidence,historyPlan,reserveHistoryApplication} from './history-workflow.js';
import {planDigest} from './categories.js';
const live=new Set();
const exists=async file=>!!await lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
export function historyApplicationView(batch){
 const job=batch.flow.historyApplication;if(!job)return {historyApplication:null};
 return {historyApplication:{status:job.status==='running'&&!live.has(batch.batchId)?'interrupted':job.status,phase:job.phase,planHash:job.planHash,evidenceDigest:job.evidenceDigest,selectedCount:job.sourceIds.length,groups:job.groups??[],error:job.error??null,independentArchiveError:job.independentArchiveError??null,results:job.results??[],authorizationPlanPath:job.authorizationPlanPath,resultPath:job.resultPath,journalPath:job.journalPath,allowedActions:job.status==='running'&&!live.has(batch.batchId)?['applyHistoryPlan']:[]}};
}
export function createHistoryApplication({store,view,checkIdle,fresh,original,strategy,reconcile}){
 const save=async batch=>Object.assign(batch,await store.update(batch.batchId,batch.revision,()=>batch));
 async function get(input){const batch=await store.get(input.batchId),answer=view(batch,input),job=batch.flow.historyApplication;if(job?.resultPath&&job.status==='running'&&await exists(job.resultPath)){const actual=await original.get({resultPath:job.resultPath});answer.historyApplication.groups=actual.executionGroups??[];answer.historyApplication.phase=actual.phase??job.phase;answer.historyApplication.journalPath=actual.journalPath;answer.historyApplication.observedHistory={status:actual.status,phase:actual.phase,interrupted:actual.interrupted??false,items:actual.items?.map(item=>({id:item.id,from:item.from,to:item.to,status:item.status})),error:actual.error??null};}return answer;}
 async function run(batch,release){const job=batch.flow.historyApplication,validation=batch.flow.historyValidation,slice=batch.slices.find(value=>value.sliceId===validation.sliceId);
 try{
  job.phase='preparing-authorization';await save(batch);
  if(!await exists(job.authorizationPlanPath)){
   await fresh(batch,batch.sources.filter(source=>job.sourceIds.includes(source.sourceId)));
   const proof=await readHistoryEvidence(batch);if(proof.evidenceDigest!==job.evidenceDigest)batchFail('STALE_EVIDENCE','最终确认后验证证据变化');
   const authorization=await original.prepare({authorizationId:job.authorizationId,planManifestPath:validation.planManifestPath,validationJournalPath:validation.validationJournalPath,recoveryReportPath:validation.recoveryReportPath,writersPaused:true});
   if(authorization.authorizationPlanPath!==job.authorizationPlanPath)batchFail('INVALID_AUTHORIZATION','最终授权产物路径不同');
  }
  const authorization=JSON.parse(await readFile(job.authorizationPlanPath,'utf8')), {authorizationHash,...unsigned}=authorization;
  if(planDigest(unsigned)!==authorizationHash||authorization.logicalPlanHash!==validation.logicalPlanHash||authorization.planManifestPath!==validation.planManifestPath)batchFail('INVALID_AUTHORIZATION','最终授权不属于已验证整份方案');
  slice.authorizationPlanPath=job.authorizationPlanPath;slice.status='applying';job.phase='applying-history';await save(batch);
  const report=await exists(job.resultPath)?await original.get({resultPath:job.resultPath}):await original.execute({authorizationPlanPath:job.authorizationPlanPath,approved:true,writersPaused:true});
  job.journalPath=report.journalPath;job.groups=report.executionGroups??[];slice.originalResultPath=job.resultPath;slice.originalJournalPath=report.journalPath;
  slice.historicalResult={status:report.status,items:report.items,modelAttempts:report.modelAttempts,afterProof:report.afterProof,indexProof:report.indexProof,error:report.error};
  const mappings=slice.historicalRequest.mappings;
  if(report.status!=='complete'||report.phase!=='verified-original'||report.modelAttempts?.length||mappings.some(mapping=>!report.items?.some(item=>item.from===mapping.from&&item.to===mapping.to&&item.status==='succeeded')))batchFail('ORIGINAL_UNCERTAIN',report.error?.message??'原库日志没有证明整份成功，禁止重放；请查询报告或恢复现场');
  job.phase='archiving-new';await save(batch);
  if(slice.newFiles?.length){slice.archiveResult=await strategy(batch).archive({batch,slice,artifactDirectory:slice.artifactDirectory});await save(batch);if(slice.archiveResult.status!=='complete')batchFail('ARCHIVE_FAILED',slice.archiveResult.error?.message??'历史已完成，新增归档暂停，请检查现场');}
  await reconcile(batch,slice);job.status='complete';job.phase='complete';slice.status='complete';batch.phase='batch-progress';
  job.results=batch.sources.map(source=>({sourceId:source.sourceId,identity:source.identity,status:source.status==='succeeded'?'succeeded':job.sourceIds.includes(source.sourceId)?'unverified':'retained',from:validation.plan.items.find(item=>item.sourceId===source.sourceId)?.from??source.currentPath,to:source.targetPath??null}));delete job.error;await save(batch);
  }catch(error){
  // 只有完整原库仍等于验证基线，且新增不依赖目录演化时，才允许独立新增继续。
  // 已有任何不可证明的历史写入会使证据复核失败，此时全部剩余写入停止。
  if(slice.newFiles?.length&&!slice.historicalRequest?.evolutionPlan&&!slice.archiveResult&&!slice.historicalResult?.modelAttempts?.length){
   let untouched=false;try{const proof=await readHistoryEvidence(batch);if(proof.evidenceDigest!==job.evidenceDigest)batchFail('STALE_EVIDENCE','独立新增授权所绑定的验证证据已改变');untouched=true;}catch(proofError){job.independentArchiveError={code:proofError.code,message:proofError.message};}
   if(untouched){try{slice.archiveResult=await strategy(batch).archive({batch,slice:{...slice,historicalRequest:null,historicalResult:null},artifactDirectory:slice.artifactDirectory});await save(batch);if(slice.archiveResult.status==='complete')await reconcile(batch,{...slice,historicalResult:null});}catch(archiveError){job.independentArchiveError={code:archiveError.code??'ARCHIVE_FAILED',message:archiveError.message};}}
  }
  job.error={code:error.code??'HISTORY_APPLY_FAILED',message:error.message};job.status=await exists(job.resultPath)?'needs-recovery':'failed';job.phase='stopped';slice.status='failed';slice.error=job.error;batch.phase='needs-review';job.results=batch.sources.map(source=>({sourceId:source.sourceId,identity:source.identity,status:source.status==='succeeded'?'succeeded':job.sourceIds.includes(source.sourceId)?source.ingestStatus==='new'?'dependency-blocked':'unverified':'retained',reason:job.sourceIds.includes(source.sourceId)?error.message:'未纳入本次范围'}));await save(batch).catch(()=>{});
 }finally{live.delete(batch.batchId);release();}}
 async function applyHistoryPlan(input){
  let batch=await store.get(input.batchId),prior=batch.flow.historyApplication,validation=batch.flow.historyValidation;
  if(input.approved!==true||input.writersPaused!==true)batchFail('REVIEW_REQUIRED','请核对完整执行摘要并确认外部写入已暂停');
  if(!validation||input.planHash!==validation.planHash||input.evidenceDigest!==validation.evidenceDigest)batchFail('STALE_EVIDENCE','最终确认的方案或验证证据不同，请重新查看摘要');
  if(prior&&(prior.planHash!==input.planHash||prior.evidenceDigest!==input.evidenceDigest)&&prior.status==='failed'&&!await exists(prior.resultPath))prior=null;
  if(prior){if(prior.planHash!==input.planHash||prior.evidenceDigest!==input.evidenceDigest)batchFail('EXECUTION_INTERRUPTED','已有另一原库执行授权，先处理结果或恢复');if(live.has(batch.batchId)||['complete','needs-recovery'].includes(prior.status))return get(input);}
  if(batch.revision!==input.revision)batchFail('STALE_BATCH','任务已更新，请重新读取');
  checkIdle(batch);const release=reserveHistoryApplication(batch);live.add(batch.batchId);
  try{
   if(!prior){
    if(validation.status!=='awaiting-apply'||historyPlan(batch).planHash!==input.planHash)batchFail('STALE_PLAN','整理方案已变化，先重新验证');
    const slice=batch.slices.find(value=>value.sliceId===validation.sliceId);if(slice?.status!=='validated')batchFail('VALIDATION_REQUIRED','缺少当前范围的完整验证');
    await fresh(batch,batch.sources.filter(source=>source.selected));const proof=await readHistoryEvidence(batch);if(proof.evidenceDigest!==input.evidenceDigest)batchFail('STALE_EVIDENCE','验证证据已变化');
    const id=randomUUID(),authorizationPlanPath=`${batch.libraryPath}.authorization-${id}.json`;
    batch.flow.historyApplication={status:'running',phase:'authorized',authorizationId:id,authorizationPlanPath,resultPath:authorizationPlanPath+'.result.json',planHash:input.planHash,evidenceDigest:input.evidenceDigest,sourceIds:validation.plan.items.map(item=>item.sourceId)};
   }else{if(!await exists(prior.resultPath)){if(historyPlan(batch).planHash!==input.planHash)batchFail('STALE_PLAN','上次授权后整理范围已改变，请重新验证');await fresh(batch,batch.sources.filter(source=>prior.sourceIds.includes(source.sourceId)));const proof=await readHistoryEvidence(batch);if(proof.evidenceDigest!==input.evidenceDigest)batchFail('STALE_EVIDENCE','上次授权后的证据已改变');}prior.status='running';delete prior.error;}
   await save(batch);setImmediate(()=>void run(batch,release));return view(batch);
  }catch(error){live.delete(batch.batchId);release();throw error;}
 }
 return {applyHistoryPlan,get};
}
