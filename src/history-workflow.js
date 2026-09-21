import path from 'node:path';
import {mkdir,readFile,readdir,lstat} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {batchFail} from './batch-store.js';
import {planDigest,categoryCatalog} from './categories.js';
import {inventory} from './compatibility.js';
import {layout} from './backup.js';
import {readRecoveryEvidence} from './recovery.js';

const live=new Map(),libraries=new Map();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const exists=async file=>!!await lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});

// 审核范围由用户选中项决定，目录演化不能在 prepare 中偷偷增加历史材料。
export function historyPlan(batch){
 const selected=batch.sources.filter(source=>source.selected),blockers=[];
 const items=selected.map(source=>({sourceId:source.sourceId,sourceHash:source.hash,associationHash:source.associationHash??null,from:source.currentPath,to:source.targetPath??null,name:source.confirmedName??null,ingestStatus:source.ingestStatus,treeRevision:source.treeRevision??null,catalogHash:source.frozenPlan?.catalogHash??null,sourcePlanHash:source.frozenPlan?.planHash??null})).sort((a,b)=>a.sourceId.localeCompare(b.sourceId));
 for(const source of selected)if(source.status!=='reviewed'||!source.targetPath||source.ingestStatus==='uncertain')blockers.push({sourceId:source.sourceId,code:'REVIEW_REQUIRED',message:'尚未完成名称、分类和来源关联审核'});
 const evolution=batch.flow.evolutionPlan;
 for(const source of batch.sources)if(source.evolution?.operations?.length&&source.evolution.status!=='confirmed')blockers.push({sourceId:source.sourceId,code:'DIRECTORY_DEPENDENCY',message:'目录调整尚未确认，相关完整范围保持阻断'});
 for(const mapping of evolution?.fileMappings??[]){const from=path.join(batch.libraryPath,'raw/sources',mapping.from),to=path.join(batch.libraryPath,'raw/sources',mapping.to);if(!items.some(item=>same(item.from,from)&&item.to&&same(item.to,to)))blockers.push({code:'DIRECTORY_DEPENDENCY',from,to,message:'目录调整涉及尚未明确选中并审核的历史材料，不能隐式扩张范围'});}
 if(batch.mode==='restructure'&&(batch.flow.tree?.status!=='approved'||selected.some(source=>source.treeRevision!==batch.flow.tree.revision)))blockers.push({code:'STALE_TREE',message:'分类树尚未确认或文件审核属于旧分类树'});
 const frozen={schemaVersion:1,batchId:batch.batchId,libraryPath:batch.libraryPath,mode:batch.mode,items,treeRevision:batch.flow.tree?.revision??null,treeCatalogHash:batch.flow.tree?.catalogHash??null,evolutionPlanHash:evolution?.planHash??null,directoryMappings:evolution?.directoryMappings??[],newDirectories:evolution?.newDirectories??[]};
 return {...frozen,planHash:planDigest(frozen),selectedCount:items.length,historicalCount:items.filter(item=>batch.mode==='restructure'||item.ingestStatus==='historical').length,newCount:items.filter(item=>batch.mode!=='restructure'&&item.ingestStatus==='new').length,blockers};
}
export function historyWorkflowView(batch,{cursor=0,limit=25}={}){
 const plan=historyPlan(batch),job=batch.flow.historyValidation;
 const offset=Math.max(0,Number(cursor)||0),size=Math.max(1,Math.min(50,Number(limit)||25));
 let validation=null;
 if(job){const status=job.planHash!==plan.planHash||batch.slices.find(slice=>slice.sliceId===job.sliceId)?.status==='cancelled'?'stale':job.status==='running'&&!live.has(batch.batchId)?'interrupted':job.status;validation={status,stage:job.stage,planHash:job.planHash,sliceId:job.sliceId,evidenceDigest:job.evidenceDigest??null,logicalPlanHash:job.logicalPlanHash??null,selectedCount:job.plan.items.length,attemptCount:(job.previousAttempts?.length??0)+1,error:job.error??null,allowedActions:['failed','interrupted','stale'].includes(status)?['continueHistoryValidation']:[],backupReportPath:job.backupReportPath,planManifestPath:job.planManifestPath,validationJournalPath:job.validationJournalPath,recoveryReportPath:job.recoveryReportPath};}
 return {historyPlan:{...plan,items:plan.items.slice(offset,offset+size),blockers:plan.blockers.slice(offset,offset+size),blockerCount:plan.blockers.length,nextCursor:offset+size<Math.max(plan.items.length,plan.blockers.length)?offset+size:null},historyValidation:validation};
}
export function assertHistoryAccess(batch){if(libraries.has(batch.libraryPath.toLowerCase()))batchFail('BATCH_BUSY','该知识库正在后台完成历史验证，请等待当前方案验证结束');}
function requireCoverage(items,mappings,status){
 if(items.length!==mappings.length||items.some(item=>item.status!==status)||mappings.some(mapping=>!items.some(item=>item.from===mapping.from&&item.to===mapping.to)))batchFail('INCOMPLETE_VALIDATION','冻结或验证结果没有完整覆盖已审核历史范围，禁止将部分成功视为整份通过');
}
// 最终应用必须重新读取这一证据链，不能只信任批次中的成功标志。
export async function readHistoryEvidence(batch,job=batch.flow.historyValidation){
 if(!job||historyPlan(batch).planHash!==job.planHash)batchFail('STALE_PLAN','整理方案范围或版本已变化，需要重新验证');
 const {journal,manifest,backup}=await readRecoveryEvidence(job.validationJournalPath);
 if(!same(job.planManifestPath,journal.planManifestPath)||!same(job.backupReportPath,journal.backupReportPath)||manifest.logicalPlanHash!==job.logicalPlanHash)batchFail('INVALID_EVIDENCE','历史验证证据与冻结方案不匹配');
 if(journal.status!=='complete'||journal.modelAttempts?.length)batchFail('VALIDATION_FAILED','历史验证未全部完成或出现模型尝试');
 requireCoverage(journal.items,job.historicalRequest.mappings,'succeeded');
 if(planDigest(manifest.request.mappings)!==planDigest(job.historicalRequest.mappings))batchFail('INVALID_EVIDENCE','迁移清单包含未授权范围');
 const recoveryPlan=await json(job.recoveryPlanPath),recovered=await json(job.recoveryReportPath);
 const {recoveryPlanHash,...unsignedPlan}=recoveryPlan,{reportHash,...unsignedReport}=recovered;
 if(planDigest(unsignedPlan)!==recoveryPlanHash||planDigest(unsignedReport)!==reportHash||recovered.status!=='complete'||recovered.modelAttempts?.length||recovered.recoveryPlanHash!==recoveryPlanHash||recoveryPlan.sourceJournalHash!==hash(await readFile(job.validationJournalPath))||!same(recoveryPlan.sourceJournalPath,job.validationJournalPath)||recoveryPlan.mode!=='new-directory')batchFail('RECOVERY_FAILED','独立恢复演练证据不完整或与本次验证不匹配');
 if((await inventory(batch.libraryPath)).hash!==backup.baseline.hash||JSON.stringify(await layout(batch.libraryPath))!==JSON.stringify(backup.directories))batchFail('STALE_PLAN','原库在验证后变化，需要重新审核');
 const catalog=await categoryCatalog(path.join(batch.libraryPath,'raw/sources'));
 if(job.plan.items.some(item=>item.catalogHash&&item.catalogHash!==catalog.hash)||(job.plan.treeCatalogHash&&job.plan.treeCatalogHash!==catalog.hash))batchFail('STALE_PLAN','分类目录在审核后变化');
 const files=await Promise.all([job.backupReportPath,job.planManifestPath,job.validationJournalPath,job.recoveryPlanPath,job.recoveryReportPath].map(async file=>({path:file,hash:hash(await readFile(file))})));
 return {planHash:job.planHash,logicalPlanHash:manifest.logicalPlanHash,evidenceDigest:planDigest({planHash:job.planHash,files}),files,selectedCount:job.plan.items.length};
}

export function createHistoryWorkflow({store,view,checkIdle,fresh,strategy,planning,backup,migration,recovery}){
 async function save(batch){Object.assign(batch,await store.update(batch.batchId,batch.revision,()=>batch));}
 async function stage(batch,name){batch.flow.historyValidation.stage=name;await save(batch);}
 async function artifact(job,prefix){const found=(await readdir(job.artifactDirectory)).filter(name=>name.startsWith(prefix)&&name.endsWith('.json')&&!name.endsWith('.result.json'));if(found.length>1)batchFail('INVALID_EVIDENCE','发现多个不确定产物，保留现场并停止');return found.length?path.join(job.artifactDirectory,found[0]):null;}
 async function run(batch){const job=batch.flow.historyValidation;try{
  await fresh(batch,batch.sources.filter(source=>source.selected));if(historyPlan(batch).planHash!==job.planHash)batchFail('STALE_PLAN','整理方案范围已变化');
  await stage(batch,'freezing');
  const prepared=await strategy(batch).prepare({batch,selected:batch.sources.filter(source=>source.selected),planning});
  const mappings=prepared.historicalRequest?.mappings??[];
  const authorized=job.plan.items.filter(item=>batch.mode==='restructure'||item.ingestStatus==='historical');
  if(mappings.length!==authorized.length||mappings.some(mapping=>!authorized.some(item=>same(item.from,path.join(batch.libraryPath,mapping.from))&&same(item.to,path.join(batch.libraryPath,mapping.to)))))batchFail('UNREVIEWED_SCOPE','执行准备试图扩大已审核历史范围');
  if(!mappings.length)batchFail('NO_HISTORY','所选范围不含历史迁移');
  if(job.historicalRequest&&planDigest(job.historicalRequest)!==planDigest(prepared.historicalRequest))batchFail('STALE_PLAN','历史目录或关联准备结果已变化');
  job.historicalRequest=prepared.historicalRequest;
  let slice=batch.slices.find(slice=>slice.sliceId===job.sliceId);
  if(!slice){slice={...prepared,sliceId:job.sliceId,sourceIds:job.plan.items.map(item=>item.sourceId),status:'preparing',artifactDirectory:job.artifactDirectory,organizerPlanHash:job.planHash};batch.slices.push(slice);await save(batch);}
  await mkdir(job.artifactDirectory,{recursive:true});
  await stage(batch,'backup');
  job.backupReportPath=path.join(job.artifactDirectory,'backup.organizer-report.json');await save(batch);
  const report=await exists(job.backupReportPath)?await json(job.backupReportPath):await backup({libraryPath:batch.libraryPath,wikiSourcePath:batch.wikiSourcePath,backupPath:path.join(job.artifactDirectory,'backup'),validationPath:path.join(job.artifactDirectory,'validation'),writersPaused:true});
  if(report.status!=='complete'||!report.backupVerified||!report.validationVerified)batchFail('BACKUP_FAILED',report.errors?.map(error=>error.message).join('；')||'完整备份未通过，已保留现场');
  slice.backupReportPath=job.backupReportPath;await save(batch);
  await stage(batch,'migration-plan');
  job.planManifestPath??=await artifact(job,'validation.plan-');
  if(!job.planManifestPath){const plan=await migration.plan({...prepared.historicalRequest,reportPath:job.backupReportPath,writersPaused:true});job.planManifestPath=plan.planManifestPath;job.logicalPlanHash=plan.logicalPlanHash;slice.preview={items:plan.items,links:plan.links,indexes:plan.indexes};await save(batch);requireCoverage(plan.items,mappings,'selected');}
  const manifest=await json(job.planManifestPath),{manifestHash,...unsigned}=manifest;
  if(planDigest(unsigned)!==manifestHash||planDigest(manifest.request.mappings)!==planDigest(mappings))batchFail('INVALID_EVIDENCE','持久迁移清单与审核范围不符');
  requireCoverage(manifest.logicalPlan.items,mappings,'selected');job.logicalPlanHash=manifest.logicalPlanHash;
  Object.assign(slice,{planManifestPath:job.planManifestPath,migrationPlanId:manifest.planId,status:'validating'});
  job.validationJournalPath=path.join(job.artifactDirectory,`validation.migration-${manifest.planId}.json`);slice.anticipatedJournalPath=job.validationJournalPath;await save(batch);
  await stage(batch,'validation');
  const validated=await exists(job.validationJournalPath)?await json(job.validationJournalPath):await migration.execute({planId:manifest.planId,planManifestPath:job.planManifestPath,approved:true,writersPaused:true});
  slice.validationJournalPath=job.validationJournalPath;slice.validationResult={status:validated.status,items:validated.items,modelAttempts:validated.modelAttempts,afterProof:validated.afterProof,indexProof:validated.indexProof,error:validated.error};await save(batch);
  if(validated.status!=='complete'||validated.modelAttempts?.length)batchFail('VALIDATION_FAILED',validated.error?.message??'副本未全部通过，保留现场；继续将创建独立的新验证尝试');
  requireCoverage(validated.items,mappings,'succeeded');
  await stage(batch,'recovery-plan');
  job.recoveryPlanPath??=await artifact(job,'validation.recovery-');
  if(!job.recoveryPlanPath){const plan=await recovery.plan({journalPath:job.validationJournalPath,mode:'new-directory',destination:path.join(job.artifactDirectory,'recovery-drill'),writersPaused:true});job.recoveryPlanPath=plan.recoveryPlanPath;}
  slice.recoveryPlanPath=job.recoveryPlanPath;await save(batch);
  await stage(batch,'recovery-drill');
  const restored=await recovery.execute({recoveryPlanPath:job.recoveryPlanPath,approved:true,writersPaused:true});
  job.recoveryReportPath=restored.reportPath;slice.recoveryReportPath=restored.reportPath;await save(batch);
  if(restored.status!=='complete')batchFail('RECOVERY_FAILED','独立恢复演练未通过，已保留现场');
  await stage(batch,'checking-evidence');
  const evidence=await readHistoryEvidence(batch,job);job.evidenceDigest=evidence.evidenceDigest;job.status='awaiting-apply';job.stage='awaiting-apply';slice.status='validated';slice.evidenceDigest=evidence.evidenceDigest;batch.phase='awaiting-original-review';delete job.error;await save(batch);
 }catch(error){job.status='failed';job.error={code:error.code??'HISTORY_VALIDATION_FAILED',message:error.message};batch.phase='needs-review';const slice=batch.slices.find(slice=>slice.sliceId===job.sliceId);if(slice){slice.status='failed';slice.error=job.error;}await save(batch).catch(()=>{});}finally{live.delete(batch.batchId);libraries.delete(batch.libraryPath.toLowerCase());}}
 async function startHistoryValidation(input){
  let batch=await store.get(input.batchId),previous=batch.flow.historyValidation;
  if(input.writersPaused!==true)batchFail('WRITERS_NOT_PAUSED','请在验证前明确确认外部写入已暂停');
  const plan=historyPlan(batch);if(input.planHash!==plan.planHash)batchFail('STALE_PLAN','请重新读取并确认完整整理范围');
  if(live.has(batch.batchId)){if(previous?.planHash!==input.planHash)batchFail('STALE_PLAN','当前后台方案不同');return view(batch);}
  if(batch.revision!==input.revision)batchFail('STALE_BATCH','任务已更新，请重新读取');
  checkIdle(batch);assertHistoryAccess(batch);
  if(plan.blockers.length)batchFail('DIRECTORY_DEPENDENCY',plan.blockers.map(item=>item.message).join('；'));
  if(!plan.historicalCount)batchFail('NO_HISTORY','所选范围不含历史材料');
  if(previous?.status==='awaiting-apply'&&previous.planHash===plan.planHash&&batch.slices.find(slice=>slice.sliceId===previous.sliceId)?.status==='validated'){const evidence=await readHistoryEvidence(batch);if(evidence.evidenceDigest!==previous.evidenceDigest)batchFail('INVALID_EVIDENCE','验证证据已变化');return view(batch);}
  if(batch.slices.some(slice=>['applying','authorized'].includes(slice.status)||slice.originalResultPath||(slice.archiveResult&&!['complete','cancelled'].includes(slice.status))))batchFail('EXECUTION_INTERRUPTED','原库执行已经授权或开始，请先处理其结果');
  if(batch.slices.some(slice=>!['complete','failed','cancelled'].includes(slice.status)&&slice.sliceId!==previous?.sliceId))batchFail('SLICE_PENDING','存在另一待处理验证方案');
  const key=batch.libraryPath.toLowerCase();live.set(batch.batchId,true);libraries.set(key,batch.batchId);
  try{
   // 验证已写到副本但无成功证据时，新尝试使用新目录；旧备份与日志完整保留。
   let restart=previous?.status==='failed'||previous?.planHash!==plan.planHash;
   if(previous?.status==='running'&&previous.validationJournalPath&&await exists(previous.validationJournalPath)){const journal=await json(previous.validationJournalPath);if(journal.status!=='complete')restart=true;}
   if(previous?.status==='running'&&previous.backupReportPath&&await exists(previous.backupReportPath)&&(await json(previous.backupReportPath)).status!=='complete')restart=true;
   if(!previous||restart){if(previous){const old=batch.slices.find(slice=>slice.sliceId===previous.sliceId);if(old&&!['complete','failed'].includes(old.status))old.status='cancelled';}const id=randomUUID();batch.flow.historyValidation={status:'running',stage:'frozen',planHash:plan.planHash,plan,sliceId:id,artifactDirectory:path.join(batch.artifactRoot,'h-'+id.replaceAll('-','').slice(0,12)),previousAttempts:previous?[...(previous.previousAttempts??[]),{...previous,previousAttempts:undefined}]:[]};}
   else {previous.status='running';delete previous.error;}
   await save(batch);setImmediate(()=>void run(batch));return view(batch);
  }catch(error){live.delete(batch.batchId);libraries.delete(key);throw error;}
 }
 return {startHistoryValidation,continueHistoryValidation:startHistoryValidation};
}
