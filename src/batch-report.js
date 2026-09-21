import path from 'node:path';

const reason=value=>typeof value==='string'?value:value?.message;
// 报告以整批来源为分母；执行证据只覆盖授权子集，不能替代整批结果。
export function buildBatchReport(batch,{cursor=0,limit=50,evidenceCursor=0,isActive=false}={}){
 const slices=batch.slices??[],runs=batch.flow.newArchives??[],application=batch.flow.historyApplication;
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
  if(item.status==='pending'){
   if(source.status==='blocked'||source.evolution?.operations?.length){item.status='blocked';item.reason=source.skipReason??'来源关联或目录依赖尚未解决';}
   else if(['excluded','needs-information','skipped'].includes(source.status)||hasExecution){item.status='retained';item.reason=source.skipReason??source.categoryConfirmationError??(source.status==='needs-information'?'正文信息不足，保留原处':'未纳入已执行范围，保留原处');}
  }
  if(item.status==='retained'||item.status==='blocked')item.to=source.currentPath;
  return item;
 });
 const counts={total:items.length,succeeded:0,retained:0,blocked:0,failed:0,pending:0,unverified:0};for(const item of items)counts[item.status]=(counts[item.status]??0)+1;
 const validation=batch.flow.historyValidation;
 const interrupted=(batch.phase?.endsWith('-running')&&!isActive)||application?.status==='needs-recovery';
 let status=isActive?'running':interrupted||counts.unverified?'needs-recovery':counts.failed?(counts.succeeded?'partial':'failed'):counts.succeeded===counts.total&&counts.total?'complete':counts.succeeded?'partial':counts.blocked?'blocked':hasExecution?'retained':'pending';
 if(application?.status==='failed'&&!counts.succeeded)status='failed';
 if(!hasExecution&&!isActive&&!interrupted){if(validation?.status==='failed'||batch.error)status='failed';else if(validation?.status==='awaiting-apply')status='awaiting-apply';}
 const evidence=slices.map(slice=>{
  const entry={sliceId:slice.sliceId,status:slice.status,backupReportPath:slice.backupReportPath,validationJournalPath:slice.validationJournalPath,originalJournalPath:slice.originalJournalPath,originalResultPath:slice.originalResultPath,recoveryPlanPath:slice.recoveryPlanPath,recoveryReportPath:slice.recoveryReportPath,archiveJournalPath:slice.archiveResult?.archiveJournalPath,artifactDirectory:slice.artifactDirectory,error:slice.error??slice.archiveResult?.error};
  entry.journalPath=entry.originalJournalPath??entry.validationJournalPath;
  entry.allowedActions=[];
  if(entry.journalPath)entry.allowedActions.push('inspectRecovery');
  if(!slice.historicalRequest&&!slice.authorizationPlanPath&&['failed','applying'].includes(slice.status)&&slice.archiveResult?.items?.every(i=>['pending','copied','succeeded'].includes(i.status)))entry.allowedActions.push('applySlice');
  return entry;
 });
 const size=Math.max(1,Math.min(50,Number(limit)||50)),offset=Math.max(0,Number(cursor)||0),eoffset=Math.max(0,Number(evidenceCursor)||0);
 return {batchId:batch.batchId,revision:batch.revision,mode:batch.mode,libraryPath:batch.libraryPath,status,stage:batch.phase,counts,hasExecution,interrupted,items:items.slice(offset,offset+size),cursor:offset,nextCursor:offset+size<items.length?offset+size:null,evidence:evidence.slice(eoffset,eoffset+size),evidenceCursor:eoffset,evidenceNextCursor:eoffset+size<evidence.length?eoffset+size:null,evidenceCount:evidence.length,error:batch.error};
}
