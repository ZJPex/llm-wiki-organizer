import {executionBlock} from './execution-state.js';
import {refreshReviewState,invalidationView,assertReviewRefreshAllowed,recordTreeInvalidation} from './review-invalidation.js';
import {buildBatchReport,readArchiveReportEvidence} from './batch-report.js';
import {createNewArchiveWorkflow} from './new-archive-workflow.js';
import {createHistoryApplication,historyApplicationView} from './history-application.js';
import {createHistoryWorkflow,historyWorkflowView,assertHistoryAccess} from './history-workflow.js';
import {createBatchJobs,analysisJobView,assertAnalysisAccess} from './batch-jobs.js';
import {batchView} from './batch-view.js';
import {canConfirmRecommendedCategory} from './category-confirmation.js';
import path from 'node:path';
import {mkdir,readFile,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createBatchStore,batchFail,within} from './batch-store.js';
import {discoverSources} from './batch-sources.js';
import {safePath,createBackup} from './backup.js';
import {canonicalPath} from './filesystem-paths.js';
import {digest} from './compatibility.js';
import {createPlanningService} from './planning.js';
import {createMigrationService} from './migration.js';
import {createRecoveryService} from './recovery.js';
import {createOriginalExecutionService} from './original-execution.js';
const active=new Set(),activeLibraries=new Set();

const success=result=>['complete','partial'].includes(result?.status)&&result.items?.filter(item=>!['excluded','blocked'].includes(item.status)).every(item=>item.status==='succeeded');
export function createBatchService({strategies={},planning,backup=createBackup,migration=createMigrationService(),recovery=createRecoveryService(),original=createOriginalExecutionService(),stateDirectory}={}){
 const store=createBatchStore({stateDirectory});
 planning??=createPlanningService({stateDirectory:stateDirectory?path.join(stateDirectory,'planning'):undefined});
 const strategy=batch=>{const selected=strategies[batch.mode];if(!selected)batchFail('INVALID_MODE','整理模式尚不可用');return selected;};
 const reportActive=batch=>active.has(batch.batchId)||['running','pausing'].includes(analysisJobView(batch).status)||historyWorkflowView(batch).historyValidation?.status==='running'||historyApplicationView(batch).historyApplication?.status==='running';
 const view=(batch,input)=>({...batchView(batch,input,reportActive(batch)),analysisJob:analysisJobView(batch),...historyWorkflowView(batch,input),...historyApplicationView(batch,input),...invalidationView(batch,input)});
 function assertExecutionScene(batch){if(executionBlock(batch,'review'))batchFail('EXECUTION_INTERRUPTED','存在未处理的执行现场，请从任务报告查询、继续或恢复');}
 function invalidateSlices(batch){assertExecutionScene(batch);for(const slice of batch.slices)if(!['complete','failed','cancelled'].includes(slice.status))slice.status='cancelled';}
 async function current(input){const batch=await store.get(input.batchId);if(batch.revision!==input.revision)batchFail('STALE_BATCH','批次已更新，请重新读取并审核');return batch;}
 async function fresh(batch,sources){const refreshed=await refreshReviewState(batch,{planning,executionCheck:false});if(sources.some(source=>refreshed.changedSourceIds.includes(source.sourceId)))batchFail('REVIEW_INVALIDATED','材料或其依赖已变化，请查看具体失效范围并重新审核');for(const source of sources){if(source.ingestStatus==='uncertain')batchFail('UNKNOWN_ASSOCIATION','来源关联不明确，保留原处');}}
 async function refreshReview(input){return operate(input,'review-running',async batch=>{await refreshReviewState(batch,{planning});batch.phase=batch.sources.every(source=>source.status==='succeeded')?'batch-progress':batch.flow.tree?.status==='stale'?'tree-review':'file-review';});}
 async function operate(input,phase,action){let batch=await current(input);if(['analysis-running','classification-running','review-running','tree-running'].includes(phase))assertExecutionScene(batch);assertAnalysisAccess(batch,input);assertHistoryAccess(batch);if(active.has(batch.batchId)||activeLibraries.has(batch.libraryPath.toLowerCase()))batchFail('BATCH_BUSY','该知识库已有批次正在处理');active.add(batch.batchId);activeLibraries.add(batch.libraryPath.toLowerCase());const save=async()=>{Object.assign(batch,await store.update(batch.batchId,batch.revision,()=>batch));};try{batch.phase=phase;delete batch.error;await save();await action(batch,save);await save();return view(batch);}catch(error){if(phase==='tree-running'&&batch.flow.treeProgress?.status==='running')batch.flow.treeProgress.status='failed';batch.phase='needs-review';batch.error={code:error.code??'BATCH_FAILED',message:error.message};for(const slice of batch.slices)if(['preparing','validating'].includes(slice.status)){slice.status='failed';slice.error=batch.error;}await save();throw Object.assign(error,{batchId:batch.batchId,revision:batch.revision});}finally{active.delete(batch.batchId);activeLibraries.delete(batch.libraryPath.toLowerCase());}}
 function sliceOf(batch,id){const slice=batch.slices.find(value=>value.sliceId===id);if(!slice)batchFail('INVALID_SLICE','整理分批不存在');return slice;}
 async function create(input){
  if(!strategies[input.mode])batchFail('INVALID_MODE','请选择可用整理模式');
  const libraryPath=await safePath(input.libraryPath),sourceRoot=await safePath(input.sourceRoot),wikiSourcePath=await safePath(input.wikiSourcePath),artifactRoot=await safePath(input.artifactRoot);
  const state=await canonicalPath(store.directory);for(const data of [libraryPath,sourceRoot])if(within(data,state)||within(data,artifactRoot)||within(artifactRoot,data))batchFail('OVERLAPPING_PATHS','批次状态、备份位置必须在知识库及来源范围之外');
  const configPath=input.configPath?await canonicalPath(input.configPath):null;
  const base={mode:input.mode,libraryPath,sourceRoot,wikiSourcePath,artifactRoot,configPath};
  const discovered=await strategies[input.mode].discover({input:base});
  const batch=await store.create({...base,sources:discovered.sources.map(source=>({...source,sourceId:randomUUID(),currentIdentity:source.currentIdentity??source.identity,selected:false})),flow:discovered.flow??{},slices:[],phase:'analysis',events:[]});return view(batch);
 }
 async function analyzeNext(input){return operate(input,'analysis-running',async(batch,save)=>{const limit=Math.max(1,Math.min(5,Number(input.limit)||1));let count=0;for(const source of batch.sources){if(count>=limit)break;if(input.sourceId&&source.sourceId!==input.sourceId)continue;if(!['pending','analysis-failed','needs-analysis'].includes(source.status)&&!(source.status==='blocked'&&!source.analysis)&&!(input.retryUncertain===true&&source.status==='needs-information'))continue;try{
 const startedAt=new Date().toISOString();
 const onProgress=async progress=>{batch.flow.analysisCurrent={sourceId:source.sourceId,identity:source.currentIdentity,startedAt,status:'running',...progress};await save();};
 await onProgress({stage:'preparing'});const currentHash=digest(await readFile(source.currentPath));if(currentHash!==source.hash){source.hash=currentHash;source.selected=false;delete source.targetPath;}const discovered=(await discoverSources(batch)).sources.find(item=>path.resolve(item.currentPath)===path.resolve(source.currentPath));if(!discovered)batchFail('SOURCE_CHANGED','来源已经不存在');Object.assign(source,{ingestStatus:discovered.ingestStatus,associationHash:discovered.associationHash,rawIdentity:discovered.rawIdentity,skipReason:discovered.skipReason});Object.assign(source,await strategy(batch).analyze({batch,source,planning,onProgress,reanalyze:input.retryUncertain===true&&source.status==='needs-information'}));}catch(error){if(batch.flow.analysisCurrent)batch.flow.analysisCurrent.status='failed';source.status='analysis-failed';source.skipReason=error.message;if(input.stopOnFailure===true){await save();throw error;}}count++;if(batch.flow.analysisCurrent?.status==='running')batch.flow.analysisCurrent.status='complete';await save();}batch.phase=batch.sources.some(s=>['pending','needs-analysis'].includes(s.status)||(s.status==='blocked'&&!s.analysis))?'analysis':'analysis-complete';});}
 async function classifyNext(input){return operate(input,'classification-running',async(batch,save)=>{
  if(batch.mode!=='inbox')batchFail('INVALID_MODE','批量分类仅用于日常 Inbox');
  const source=batch.sources.find(s=>['analyzed','named','classification-failed'].includes(s.status)&&s.analysis&&!s.analysis.uncertain);
  if(!source){batch.phase='file-review';return;}
  await fresh(batch,[source]);invalidateSlices(batch);
  const startedAt=new Date().toISOString();
  const onProgress=async progress=>{batch.flow.classificationCurrent={sourceId:source.sourceId,identity:source.currentIdentity,startedAt,status:'running',...progress};await save();};
  await onProgress({stage:'preparing'});
  try{
   const result=await strategy(batch).review({batch,source,input:{action:'classify'},planning,onProgress});
   Object.assign(source,result.sourcePatch);delete source.classificationError;
   batch.flow.classificationCurrent.status='complete';batch.phase='file-review';
  }catch(error){source.status='classification-failed';source.classificationError=error.message;batch.flow.classificationCurrent.status='failed';throw error;}
 });}
 async function confirmRecommendedCategories(input){return operate(input,'review-running',async(batch,save)=>{
  if(batch.mode!=='inbox')batchFail('INVALID_MODE','批量确认推荐分类仅用于日常 Inbox');
  if(batch.flow.evolutionPlan)batchFail('EVOLUTION_REVIEW_REQUIRED','本批包含目录演化，请逐项审核演化后的最终分类与路径');
  const sources=batch.sources.filter(canConfirmRecommendedCategory);
  if(sources.length)invalidateSlices(batch);
  const progress=batch.flow.categoryConfirmation={status:'running',total:sources.length,completed:0,confirmed:0,failed:0,skipped:batch.sources.length-sources.length};
  for(const source of sources){
   try{
    await fresh(batch,[source]);
    const result=await strategy(batch).review({batch,source,input:{action:'confirmCategory',category:source.classification.category},planning});
    Object.assign(source,result.sourcePatch);Object.assign(batch.flow,result.flowPatch??{});delete source.categoryConfirmationError;
   }catch(error){source.categoryConfirmationError=error.message;progress.status='failed';progress.failed++;progress.completed++;throw error;}
   progress.confirmed++;progress.completed++;await save();
  }
  progress.status='complete';batch.phase='file-review';
 });}
 async function confirmPlans(input){return operate(input,'review-running',async(batch,save)=>{
  if(!['inbox','restructure'].includes(batch.mode))batchFail('INVALID_MODE','此模式不支持集中确认');
  if(batch.mode==='restructure'&&(batch.flow.tree?.status!=='approved'||input.treeRevision!==batch.flow.tree.revision))batchFail('STALE_TREE','分类树尚未审核或已变化，请先确认当前分类树');
  if(!Array.isArray(input.items)||!input.items.length||new Set(input.items.map(item=>item.sourceId)).size!==input.items.length)batchFail('INVALID_SELECTION','请明确选择本次保存的材料');

  const items=input.items.map(item=>({input:item,source:batch.sources.find(source=>source.sourceId===item.sourceId)}));
  if(items.some(({source})=>!source||['excluded','succeeded','blocked'].includes(source.status)||(source?.status==='reviewed'&&input.replaceSelection!==true)))batchFail('INVALID_SELECTION','选择包含已保留、已审核或不可处理材料');
  for(const {source,input:item} of items)if(source.status==='reviewed'&&(item.name!==source.confirmedName||(batch.mode==='restructure'?batch.flow.tree.nodes.find(node=>node.nodeId===item.nodeId)?.category: item.category)!==(source.classification?.category??source.category)))batchFail('STALE_PLAN','已审核材料的名称或分类不同，请先重新审核');
  invalidateSlices(batch);
  if(input.replaceSelection===true){const selectedIds=new Set(items.map(item=>item.source.sourceId));for(const source of batch.sources)if(!selectedIds.has(source.sourceId))source.selected=false;}
  for(const {source,input:item} of items){
   try{await fresh(batch,[source]);if(source.status==='reviewed'){source.selected=true;await save();continue;}const result=await strategy(batch).review({batch,source,input:{...item,action:'confirmPlan'},planning});Object.assign(source,result.sourcePatch);delete source.categoryConfirmationError;await save();}
   catch(error){source.categoryConfirmationError=error.message;throw error;}
  }
  batch.phase='file-review';
 });}
 async function reviewItem(input){return operate(input,'review-running',async batch=>{const source=batch.sources.find(s=>s.sourceId===input.sourceId);if(!source)batchFail('INVALID_SOURCE','材料不在此批次');if(input.action!=='exclude')await fresh(batch,[source]);invalidateSlices(batch);const result=await strategy(batch).review({batch,source,input,planning});if(result.discardedEvolutionHash)for(const item of batch.sources)if(item.frozenPlan?.evolutionHash===result.discardedEvolutionHash){delete item.frozenPlan;delete item.targetPath;item.selected=false;if(item.status==='reviewed')item.status='classified';}Object.assign(source,result.sourcePatch);Object.assign(batch.flow,result.flowPatch??{});batch.phase='file-review';});}
 async function treeAction(input){return operate(input,'tree-running',async(batch,save)=>{if(!strategy(batch).tree)batchFail('INVALID_MODE','此模式不使用整库分类树审核');invalidateSlices(batch);const priorTree=batch.flow.tree?.revision;Object.assign(batch.flow,await strategy(batch).tree({batch,input,planning,save}));if(priorTree!==undefined&&priorTree!==batch.flow.tree?.revision)recordTreeInvalidation(batch);batch.phase=batch.flow.tree?.status==='approved'?'file-review':'tree-review';});}
 async function prepareSlice(input){if(input.writersPaused!==true)batchFail('WRITERS_NOT_PAUSED','请暂停全部外部写入');return operate(input,'prepare-running',async(batch,save)=>{if(batch.slices.some(slice=>!['complete','failed','cancelled'].includes(slice.status)))batchFail('SLICE_PENDING','请先完成或处理已有分批');const selected=batch.sources.filter(s=>s.selected&&s.status==='reviewed');if(!selected.length)batchFail('EMPTY_SELECTION','请先审核并选中至少一份材料');await fresh(batch,selected);const prepared=await strategy(batch).prepare({batch,selected,planning});if(prepared.historicalRequest&&input.linkResolutions!==undefined)prepared.historicalRequest.linkResolutions=input.linkResolutions;const slice={...prepared,sliceId:randomUUID(),sourceIds:selected.map(s=>s.sourceId),status:'preparing'};slice.artifactDirectory=path.join(batch.artifactRoot,'s-'+randomUUID().replaceAll('-','').slice(0,12));await mkdir(slice.artifactDirectory);batch.slices.push(slice);await save();if(slice.historicalRequest?.mappings?.length||slice.historicalRequest?.evolutionPlan){const report=await backup({libraryPath:batch.libraryPath,wikiSourcePath:batch.wikiSourcePath,backupPath:path.join(slice.artifactDirectory,'backup'),validationPath:path.join(slice.artifactDirectory,'validation'),writersPaused:true});slice.backupReportPath=report.reportPath;await save();if(report.status!=='complete')batchFail('BACKUP_FAILED','完整备份未通过，当前分批停止');const plan=await migration.plan({...slice.historicalRequest,reportPath:report.reportPath,writersPaused:true});slice.planManifestPath=plan.planManifestPath;slice.migrationPlanId=plan.planId;slice.anticipatedJournalPath=report.validationPath+'.migration-'+plan.planId+'.json';slice.preview={items:plan.items,links:plan.links,indexes:plan.indexes};}slice.status='prepared';batch.phase='slice-review';});}
 async function validateSlice(input){if(input.approved!==true||input.writersPaused!==true)batchFail('REVIEW_REQUIRED','请审核分批方案并暂停写入');return operate(input,'validation-running',async(batch,save)=>{const slice=sliceOf(batch,input.sliceId);if(slice.status==='validated')return;const recoveryRetry=slice.status==='failed'&&success(slice.validationResult)&&slice.recoveryPlanPath&&!slice.originalResultPath&&!slice.authorizationPlanPath;if(!['prepared','validating'].includes(slice.status)&&!recoveryRetry)batchFail('INVALID_PHASE','分批尚未准备好验证');delete slice.error;slice.status='validating';await save();if(slice.planManifestPath){if(!slice.validationJournalPath){const existing=await lstat(slice.anticipatedJournalPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;});const result=existing?JSON.parse(await readFile(slice.anticipatedJournalPath,'utf8')):await migration.execute({planId:slice.migrationPlanId,planManifestPath:slice.planManifestPath,approved:true,writersPaused:true});slice.validationJournalPath=result.journalPath??slice.anticipatedJournalPath;slice.validationResult={status:result.status,items:result.items,modelAttempts:result.modelAttempts,afterProof:result.afterProof,indexProof:result.indexProof,error:result.error};await save();if(!success(result))batchFail('VALIDATION_FAILED',result.error?.message??'验证副本未全部通过，不能应用原库');}else if(!success(slice.validationResult))batchFail('VALIDATION_FAILED','失败的副本需要通过恢复入口处理');if(!slice.recoveryPlanPath){const plan=await recovery.plan({journalPath:slice.validationJournalPath,mode:'new-directory',destination:path.join(slice.artifactDirectory,'recovery-drill'),writersPaused:true});slice.recoveryPlanPath=plan.recoveryPlanPath;await save();}const restored=await recovery.execute({recoveryPlanPath:slice.recoveryPlanPath,approved:true,writersPaused:true});slice.recoveryReportPath=restored.reportPath;await save();if(restored.status!=='complete')batchFail('RECOVERY_FAILED','恢复演练未完成，不能应用原库');}slice.status='validated';batch.phase='awaiting-original-review';});}
 async function replanSlice(input){
  if(input.writersPaused!==true)batchFail('WRITERS_NOT_PAUSED','请先暂停全部外部写入');
  return operate(input,'prepare-running',async batch=>{
   const slice=sliceOf(batch,input.sliceId);
   if(slice.status!=='failed'||!slice.backupReportPath||!slice.historicalRequest||slice.validationJournalPath||slice.originalResultPath||slice.authorizationPlanPath)batchFail('INVALID_PHASE','仅可重建尚未执行的失败方案');
   if(batch.slices.some(other=>other!==slice&&!['complete','failed','cancelled'].includes(other.status)))batchFail('SLICE_PENDING','另有分批正在处理');
   if(slice.anticipatedJournalPath&&await lstat(slice.anticipatedJournalPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))batchFail('EXECUTION_INTERRUPTED','验证已有执行日志，请先检查或恢复');
   const sources=batch.sources.filter(source=>slice.sourceIds.includes(source.sourceId));
   if(sources.length!==slice.sourceIds.length||sources.some(source=>!source.selected||source.status!=='reviewed'))batchFail('REVIEW_REQUIRED','原方案选中项已改变，请重新审核');
   if(sources.some(source=>source.targetPath&&!slice.historicalRequest.mappings?.some(mapping=>path.resolve(batch.libraryPath,mapping.from)===path.resolve(source.currentPath)&&path.resolve(batch.libraryPath,mapping.to)===path.resolve(source.targetPath))))batchFail('REVIEW_REQUIRED','审核目标已变化，请重新准备分批');
   await fresh(batch,sources);
   const request={...slice.historicalRequest,...(input.linkResolutions!==undefined?{linkResolutions:input.linkResolutions}:{})};
   const plan=await migration.plan({...request,reportPath:slice.backupReportPath,writersPaused:true});
   slice.historicalRequest=request;
   slice.planManifestPath=plan.planManifestPath;slice.migrationPlanId=plan.planId;
   slice.anticipatedJournalPath=plan.validationPath+'.migration-'+plan.planId+'.json';
   slice.preview={items:plan.items,links:plan.links,indexes:plan.indexes};
   if(plan.status==='blocked')batchFail('EMPTY_BATCH','修复后仍没有可执行项目，请查看方案原因');
   delete slice.error;slice.status='prepared';batch.phase='slice-review';
  });
 }
 async function cancelSlice(input){return operate(input,'review-running',async batch=>{const slice=sliceOf(batch,input.sliceId);if(slice.status==='applying'||slice.originalResultPath)batchFail('EXECUTION_INTERRUPTED','原库已经执行，请先查询结果并按日志恢复');slice.status='cancelled';for(const source of batch.sources.filter(source=>slice.sourceIds.includes(source.sourceId)))source.selected=false;batch.phase='file-review';});}
 async function prepareOriginal(input){if(input.writersPaused!==true)batchFail('WRITERS_NOT_PAUSED','请暂停写入');return operate(input,'authorization-running',async(batch,save)=>{const slice=sliceOf(batch,input.sliceId);if(slice.status!=='validated')batchFail('INVALID_PHASE','请先完成副本验证及恢复演练');await fresh(batch,batch.sources.filter(s=>slice.sourceIds.includes(s.sourceId)));if(slice.planManifestPath){const authorization=await original.prepare({planManifestPath:slice.planManifestPath,validationJournalPath:slice.validationJournalPath,recoveryReportPath:slice.recoveryReportPath,writersPaused:true});slice.authorizationPlanPath=authorization.authorizationPlanPath;slice.authorization={items:authorization.selectedItems,originalPath:authorization.originalPath,backupPath:authorization.backupPath,validationPath:authorization.validationPath,recoveryPath:authorization.recoveryPath};}slice.status='authorized';batch.phase='original-review';});}
 async function reconcile(batch,slice){const mappings=[];for(const item of slice.historicalResult?.items??[]){if(item.status!=='succeeded')continue;const from=path.join(batch.libraryPath,item.from),to=path.join(batch.libraryPath,item.to);mappings.push({from,to,sourceRoot:path.join(batch.libraryPath,'raw/sources'),targetRoot:path.join(batch.libraryPath,'raw/sources'),hash:digest(await readFile(to))});}mappings.push(...(slice.archiveResult?.committedMappings??[]));if(planning.commitIdentityMappings){const groups=new Map();for(const mapping of mappings){const sourceRoot=mapping.sourceRoot??batch.sourceRoot,targetRoot=mapping.targetRoot??path.join(batch.libraryPath,'raw/sources'),key=sourceRoot+'|'+targetRoot;if(!groups.has(key))groups.set(key,{sourceRoot,targetRoot,mappings:[]});groups.get(key).mappings.push(mapping);}let index=0;for(const group of groups.values())await planning.commitIdentityMappings({...group,executionId:slice.sliceId+':'+index++,libraryPath:batch.libraryPath});}for(const source of batch.sources){const mapping=mappings.find(m=>path.resolve(m.from)===path.resolve(source.currentPath));if(mapping){source.currentPath=mapping.to;source.currentIdentity=path.relative(mapping.targetRoot??batch.sourceRoot,mapping.to).replaceAll('\\','/');source.hash=mapping.hash;source.status='succeeded';source.selected=false;}else if(!['succeeded','skipped','blocked'].includes(source.status)){const actual=digest(await readFile(source.currentPath));if(actual!==source.hash){source.hash=actual;source.status='needs-analysis';source.selected=false;delete source.targetPath;}}}}
 async function applySlice(input){if(input.approved!==true||input.writersPaused!==true)batchFail('REVIEW_REQUIRED','请确认原库执行并暂停写入');return operate(input,'apply-running',async(batch,save)=>{const slice=sliceOf(batch,input.sliceId);if(slice.status==='complete'){batch.phase='batch-progress';return;}if(!['authorized','applying'].includes(slice.status)&&!(slice.status==='failed'&&slice.archiveResult))batchFail('INVALID_PHASE','请先审核原库执行方案');slice.status='applying';await save();if(slice.authorizationPlanPath){const resultPath=`${slice.authorizationPlanPath}.result.json`;const exists=await lstat(resultPath).catch(e=>{if(e.code==='ENOENT')return null;throw e;});const result=exists?await original.get({resultPath}):await original.execute({authorizationPlanPath:slice.authorizationPlanPath,approved:true,writersPaused:true});slice.originalResultPath=result.resultPath;slice.originalJournalPath=result.journalPath;slice.historicalResult={status:result.status,items:result.items,modelAttempts:result.modelAttempts,afterProof:result.afterProof,indexProof:result.indexProof,error:result.error};await save();if(!success(result)){slice.status='failed';batchFail('ORIGINAL_FAILED','原库执行未全部成功，保留现场并停止后续归档');}}if(slice.newFiles?.length){slice.archiveResult=await strategy(batch).archive({batch,slice,artifactDirectory:slice.artifactDirectory});await save();if(slice.archiveResult.status!=='complete'){slice.status='failed';if(slice.archiveResult.error?.code==='STALE_ASSOCIATION')for(const source of batch.sources.filter(source=>slice.newFiles.some(file=>file.sourceId===source.sourceId))){source.status='needs-analysis';source.selected=false;delete source.targetPath;}batchFail('ARCHIVE_FAILED','新材料归档停止，请查看保留的来源与日志');}}await reconcile(batch,slice);slice.status='complete';batch.phase='batch-progress';});}
 const jobs=createBatchJobs({store,view,step:analyzeNext,classify:classifyNext,proposeTree:treeAction,
  checkIdle:batch=>{assertExecutionScene(batch);assertReviewRefreshAllowed(batch);assertHistoryAccess(batch);if(active.has(batch.batchId)||activeLibraries.has(batch.libraryPath.toLowerCase()))batchFail('BATCH_BUSY','该知识库已有批次正在处理');if(batch.slices.some(slice=>slice.status==='applying'))batchFail('EXECUTION_INTERRUPTED','原库执行已开始，请先处理执行结果');},
  prepare:async job=>{const batch=await store.get(job.batchId);await store.update(batch.batchId,batch.revision,async record=>{
   await refreshReviewState(record,{planning});
   return record;
  });}
 });
 const confirmNewArchive=createNewArchiveWorkflow({store,view,operate,strategy,planning,fresh,reconcile});
 const history=createHistoryWorkflow({store,view,fresh,strategy,planning,backup,migration,recovery,checkIdle:batch=>{assertAnalysisAccess(batch,{});if(active.has(batch.batchId)||activeLibraries.has(batch.libraryPath.toLowerCase()))batchFail('BATCH_BUSY','该知识库正在处理另一操作');}});
 const application=createHistoryApplication({store,view,fresh,original,strategy,reconcile,checkIdle:batch=>{assertAnalysisAccess(batch,{});assertHistoryAccess(batch);if(active.has(batch.batchId)||activeLibraries.has(batch.libraryPath.toLowerCase()))batchFail('BATCH_BUSY','该知识库已有任务正在执行');}});
 return {...history,...jobs,confirmNewArchive,refreshReview,create,getReport:async input=>{const {batch,answer,error,application:observedApplication}=await application.readSnapshot(input);const report=buildBatchReport(await readArchiveReportEvidence(batch),{...input,isActive:answer.report.status==='running',observedApplication});if(error){report.status='needs-recovery';report.error={code:error.code??'EVIDENCE_READ_FAILED',message:error.message};}return report;},applyHistoryPlan:application.applyHistoryPlan,queryHistoryApplication:application.get,get:application.get,list:input=>store.list(input,record=>view(record,{limit:1})),analyzeNext,classifyNext,confirmRecommendedCategories,confirmPlans,reviewItem,treeAction,prepareSlice,replanSlice,validateSlice,cancelSlice,prepareOriginal,applySlice};
}
