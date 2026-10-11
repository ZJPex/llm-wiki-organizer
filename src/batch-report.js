import path from 'node:path';
import {readFile,lstat} from 'node:fs/promises';
import {planDigest} from './categories.js';

export async function readArchiveReportEvidence(record){
 const batch=structuredClone(record);
 for(const slice of batch.slices??[]){
  if(!slice.newFiles?.length||!slice.artifactDirectory||slice.archiveResult)continue;
  const file=path.join(slice.artifactDirectory,'inbox-archive.json');
  try{const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('归档日志不是独立普通文件');const journal=JSON.parse(await readFile(file,'utf8')),{journalHash,...unsigned}=journal;
   const manifest={batchId:batch.batchId,sliceId:slice.sliceId,newFiles:slice.newFiles,watchConfig:slice.watchConfig,...(slice.newCategories?.length?{newCategories:slice.newCategories,allowedNewCategories:slice.allowedNewCategories??slice.newCategories}:{})};
   if(planDigest(unsigned)!==journalHash||journal.manifestHash!==planDigest(manifest))throw new Error('归档日志不属于当前冻结计划或内容已改变');
   slice.archiveResult={status:journal.status,items:journal.items,archiveJournalPath:file,error:journal.error};
  }catch(error){if(error.code!=='ENOENT')slice.error={code:'INVALID_JOURNAL',message:error.message};}
 }
 return batch;
}

const reason=value=>typeof value==='string'?value:value?.message;
// 报告以整批来源为分母；执行证据只覆盖授权子集，不能替代整批结果。
export function buildBatchReport(batch,{cursor=0,limit=50,evidenceCursor=0,isActive=false,observedApplication}={}){
 const slices=batch.slices??[],runs=batch.flow.newArchives??[],application=observedApplication??batch.flow.historyApplication;
 const hasExecution=runs.length>0||slices.some(s=>s.archiveResult||s.originalResultPath||s.historicalResult)||!!application;
 const items=batch.sources.map(source=>{
  const item={sourceId:source.sourceId,identity:source.identity,from:path.join(batch.sourceRoot,source.identity),to:source.currentPath,status:source.status==='succeeded'?'succeeded':'pending',reason:null};
  for(const run of runs){const found=run.items.find(i=>i.sourceId===source.sourceId);if(!found)continue;Object.assign(item,{status:['ready','running'].includes(found.status)?'unverified':found.status,reason:reason(found.reason),sliceId:found.sliceId});if(found.to)item.to=found.to;}
  for(const slice of slices){
   if(slice.status==='cancelled')continue;
   const archive=slice.archiveResult?.items?.find(i=>i.sourceId===source.sourceId);
   const move=slice.historicalRequest?.mappings?.find(i=>i.id===source.sourceId),historical=move&&slice.historicalResult?.items?.find(i=>i.from===move.from&&i.to===move.to);
   const result=archive??historical;
   if(result){item.sliceId=slice.sliceId;item.from=archive?result.from:path.join(batch.libraryPath,result.from);item.to=archive?result.to:path.join(batch.libraryPath,result.to);item.status=result.status==='succeeded'?'succeeded':['blocked','excluded'].includes(result.status)?'blocked':slice.status==='failed'?'failed':'unverified';item.reason=reason(result.reason)??reason(slice.archiveResult?.error)??reason(slice.error);}
   else if(slice.sourceIds?.includes(source.sourceId)&&slice.status==='applying'){item.status='unverified';item.sliceId=slice.sliceId;item.reason='执行尚未验证完成，请先查询现场';}
  }
  if(source.status==='succeeded')item.status='succeeded';
  const appItem=application?.results?.find(row=>row.sourceId===source.sourceId);
  if(appItem&&item.status!=='succeeded'){item.status=appItem.status==='dependency-blocked'?'blocked':appItem.status;item.reason=appItem.reason??item.reason;if(appItem.from)item.from=appItem.from;if(appItem.to)item.to=appItem.to;}
  const observed=application?.observedHistory?.items?.find(row=>row.id===source.sourceId);
  if(observed){item.from=path.join(batch.libraryPath,observed.from);item.to=path.join(batch.libraryPath,observed.to);item.status=application.observedHistory.status==='complete'&&application.observedHistory.phase==='verified-original'&&observed.status==='succeeded'?'succeeded':'unverified';item.reason=item.status==='unverified'?'原库日志尚未证明完整验证通过':null;}
  if(item.status==='pending'){
   if(source.status==='blocked'||source.evolution?.operations?.length){item.status='blocked';item.reason=source.skipReason??'来源关联或目录依赖尚未解决';}
   else if(['excluded','needs-information','skipped'].includes(source.status)||hasExecution){item.status='retained';item.reason=source.skipReason??source.categoryConfirmationError??(source.status==='needs-information'?'正文信息不足，保留原处':'未纳入已执行范围，保留原处');}
  }
  if(item.status==='retained'&&!item.reason)item.reason=source.skipReason||source.categoryConfirmationError||(source.status==='needs-information'?'正文信息不足，保留原处':'未纳入已执行范围，保留原处');
  if(item.status==='retained'||item.status==='blocked')item.to=source.currentPath;
  return item;
 });
 const counts={total:items.length,succeeded:0,retained:0,blocked:0,failed:0,pending:0,unverified:0};for(const item of items)counts[item.status]=(counts[item.status]??0)+1;
 const validation=batch.flow.historyValidation;
 const interrupted=(batch.phase?.endsWith('-running')&&!isActive)||['needs-recovery','interrupted'].includes(application?.status)||(!isActive&&application?.status==='running');
 let status=isActive?'running':interrupted||counts.unverified?'needs-recovery':counts.failed?(counts.succeeded?'partial':'failed'):counts.succeeded===counts.total&&counts.total?'complete':counts.succeeded?'partial':counts.blocked?'blocked':hasExecution?'retained':'pending';
 if(application?.status==='failed'&&!counts.succeeded)status='failed';
 if(!hasExecution&&!isActive&&!interrupted){if(validation?.status==='failed'||batch.error)status='failed';else if(validation?.status==='awaiting-apply')status='awaiting-apply';}
 const evidence=slices.map(slice=>{
  const entry={sliceId:slice.sliceId,status:slice.status,backupReportPath:slice.backupReportPath,validationJournalPath:slice.validationJournalPath,originalJournalPath:slice.originalJournalPath,originalResultPath:slice.originalResultPath,recoveryPlanPath:slice.recoveryPlanPath,recoveryReportPath:slice.recoveryReportPath,archiveJournalPath:slice.archiveResult?.archiveJournalPath,artifactDirectory:slice.artifactDirectory,error:slice.error??slice.archiveResult?.error};
  if(slice.sliceId===batch.flow.historyValidation?.sliceId&&application){entry.originalJournalPath=application.journalPath??entry.originalJournalPath;entry.originalResultPath=application.resultPath??entry.originalResultPath;}
  entry.journalPath=entry.originalJournalPath??entry.validationJournalPath;
  entry.allowedActions=[];
  if(entry.journalPath)entry.allowedActions.push('inspectRecovery');
  if(!slice.historicalRequest&&!slice.authorizationPlanPath&&['failed','applying'].includes(slice.status)&&slice.archiveResult?.items?.every(i=>['pending','copied','succeeded'].includes(i.status)))entry.allowedActions.push('applySlice');
  return entry;
 });
 const size=Math.max(1,Math.min(50,Number(limit)||50)),offset=Math.max(0,Number(cursor)||0),eoffset=Math.max(0,Number(evidenceCursor)||0);
 return {batchId:batch.batchId,revision:batch.revision,mode:batch.mode,libraryPath:batch.libraryPath,status,stage:batch.phase,counts,hasExecution,interrupted,items:items.slice(offset,offset+size),cursor:offset,nextCursor:offset+size<items.length?offset+size:null,evidence:evidence.slice(eoffset,eoffset+size),evidenceCursor:eoffset,evidenceNextCursor:eoffset+size<evidence.length?eoffset+size:null,evidenceCount:evidence.length,error:batch.error};
}
