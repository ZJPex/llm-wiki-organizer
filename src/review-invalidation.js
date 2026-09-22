import path from 'node:path';
import {lstat,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {discoverSources} from './batch-sources.js';
import {categoryCatalog,planDigest} from './categories.js';
import {inventory} from './compatibility.js';
import {batchFail} from './batch-store.js';
const key=value=>path.resolve(value).toLowerCase();
const terminal=source=>source.status==='succeeded';
export function recordTreeInvalidation(batch){
 const sources=batch.sources.filter(source=>!terminal(source)&&source.analysis&&!['excluded','skipped'].includes(source.status));
 for(const source of sources){source.reviewVersion=(source.reviewVersion??0)+1;source.reviewResetCategory=true;source.reviewReasons=['分类树版本变化，按新树重新确认文件归属；未变正文分析保留'];}
 batch.flow.invalidations={revision:(batch.flow.invalidations?.revision??0)+1,checkedAt:new Date().toISOString(),affectedSourceIds:sources.map(source=>source.sourceId),retainedReviewCount:batch.sources.filter(source=>source.status==='reviewed').length,analysisRetainedCount:batch.sources.filter(source=>source.analysis).length,sharedValidationStale:staleValidation(batch,'分类树版本已变化'),reasons:[{code:'TREE_REVISION_CHANGED',scope:'tree',sourceIds:sources.map(source=>source.sourceId),message:'分类树版本变化使全树文件归属需要重审，未变正文分析仍有效',nextAction:'tree'}]};
}
export function assertReviewRefreshAllowed(batch){
 const application=batch.flow.historyApplication;
 if(application&&application.status!=='complete'&&application.status!=='failed')batchFail('EXECUTION_INTERRUPTED','已有执行中或结果不确定的原库授权，只能先查询日志或恢复，不能把材料回退重审');
 if(batch.slices.some(slice=>slice.status==='applying'||(slice.status!=='complete'&&(slice.originalResultPath||slice.originalJournalPath||slice.archiveResult))))batchFail('EXECUTION_INTERRUPTED','已有未完成写入现场，请先查询或恢复；不得通过重审重复移动');
}
export function invalidationView(batch,{cursor=0,limit=25}={}){
 const record=batch.flow.invalidations;if(!record)return {invalidations:null};const offset=Math.max(0,Number(cursor)||0),size=Math.max(1,Math.min(50,Number(limit)||25));
 return {invalidations:{...record,reasons:record.reasons.slice(offset,offset+size),reasonCount:record.reasons.length,nextCursor:offset+size<record.reasons.length?offset+size:null}};
}
export function staleValidation(batch,reason){
 let stale=false;for(const slice of batch.slices)if(!['complete','failed','cancelled'].includes(slice.status)){slice.status='cancelled';slice.invalidationReason=reason;stale=true;}
 const validation=batch.flow.historyValidation;if(validation&&validation.status!=='complete'&&batch.flow.historyApplication?.status!=='complete'){validation.status='stale';validation.invalidationReason=reason;stale=true;}
 return stale;
}
export async function refreshReviewState(batch,{planning,detectTargets=true,executionCheck=true}={}){
 if(executionCheck)assertReviewRefreshAllowed(batch);
 const discovery=await discoverSources(batch);if(discovery.flow.busy)batchFail('WRITERS_BUSY','知识库有待处理写入任务，先暂停并处理后检查变化');
 const pending=batch.sources.filter(source=>!terminal(source)),lookup=new Map(discovery.sources.map(source=>[key(source.currentPath),source])),reasons=[],changes=new Map();
 const mark=(source,code,message,options={})=>{const change=changes.get(source.sourceId)??{source,body:false,classification:false};Object.assign(change,{body:change.body||options.body,classification:change.classification||options.classification});changes.set(source.sourceId,change);reasons.push({code,message,sourceIds:[source.sourceId],scope:'source',nextAction:options.body?'analyze':options.classification?'classify':'review'});};
 let treeChanged=false;
 for(const source of pending){
  const actual=lookup.get(key(source.currentPath));
  if(!actual){if(source.reviewMissing!==true){mark(source,'SOURCE_MISSING','来源已缺失，保留旧证据并等待修复或明确保留',{body:true});source.reviewMissing=true;treeChanged=true;}continue;}
  if(source.reviewMissing)mark(source,'SOURCE_RESTORED','来源恢复，需要重新核验正文与关联',{body:true});
  delete source.reviewMissing;
  if(actual.hash!==source.hash||(source.status==='needs-analysis'&&source.analysis)){mark(source,'SOURCE_CHANGED','正文内容变化，仅重新分析这份材料',{body:true});source.hash=actual.hash;treeChanged=true;}
  if(actual.associationHash!==source.associationHash||actual.ingestStatus!==source.ingestStatus){mark(source,'ASSOCIATION_CHANGED','摄取身份、历史页面或关联记录变化；保留未变正文分析，重新审核迁移范围');Object.assign(source,{associationHash:actual.associationHash,ingestStatus:actual.ingestStatus,rawIdentity:actual.rawIdentity,skipReason:actual.skipReason});}
 }
 if(batch.mode==='restructure')for(const actual of discovery.sources)if(!batch.sources.some(source=>key(source.currentPath)===key(actual.currentPath))){const source={...actual,sourceId:randomUUID(),selected:false};batch.sources.push(source);pending.push(source);mark(source,'SOURCE_ADDED','完整 Raw 范围增加材料，须重新检查全树归属',{body:true});treeChanged=true;}
 const catalog=await categoryCatalog(path.join(batch.libraryPath,'raw/sources'));
 const catalogChanged=batch.flow.reviewCatalogHash?batch.flow.reviewCatalogHash!==catalog.hash:pending.some(source=>(source.classification?.catalogHash&&source.classification.catalogHash!==catalog.hash)||(source.frozenPlan?.catalogHash&&source.frozenPlan.catalogHash!==catalog.hash))||(batch.flow.tree?.catalogHash&&batch.flow.tree.catalogHash!==catalog.hash)||(batch.flow.reviewCatalogHash&&batch.flow.reviewCatalogHash!==catalog.hash);
 if(catalogChanged){for(const source of pending)if(source.analysis||source.confirmedName)mark(source,'CATALOG_CHANGED','分类目录或说明变化；无法证明全局分类检索不受影响，保留正文分析并重新规划分类',{classification:true});treeChanged=true;}
 batch.flow.reviewCatalogHash=catalog.hash;
 if(batch.mode==='restructure'&&batch.flow.tree){
  const tree=batch.flow.tree;
  for(const source of pending)if(source.treeRevision!==undefined&&source.treeRevision!==tree.revision)mark(source,'TREE_REVISION_CHANGED','文件审核属于旧分类树版本，请按当前树重新审核',{classification:true});
  if(treeChanged){tree.status='stale';for(const source of pending)if(source.analysis||source.status==='reviewed')mark(source,'TREE_INPUT_CHANGED','全树归并依赖完整材料与目录输入，输入变化使分类树及文件归属整体失效；未变正文分析保留',{classification:true});reasons.push({code:'TREE_INPUT_CHANGED',message:'完整分类树需要重新提出和确认，不能沿用旧树版本',sourceIds:pending.map(source=>source.sourceId),scope:'tree',nextAction:'tree'});}
 }
 if(detectTargets){
  const targets=new Map();for(const source of pending){const target=source.targetPath;if(!target)continue;const group=targets.get(key(target))??[];group.push(source);targets.set(key(target),group);}
  for(const [target,group] of targets){
   const occupied=await lstat(group[0].targetPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
   for(const source of group)if(group.length>1||(occupied&&key(source.currentPath)!==target)){const fingerprint=planDigest({target,ids:group.map(item=>item.sourceId),occupied:!!occupied});if(source.targetConflictFingerprint!==fingerprint){mark(source,'TARGET_CONFLICT','最终位置已被占用或与本批另一材料重名，所有冲突项保留原处');source.targetConflictFingerprint=fingerprint;}}
  }
 }
 const evolution=batch.flow.evolutionPlan;
 if(evolution&&changes.size){const members=new Set((evolution.fileMappings??[]).map(mapping=>key(path.join(batch.libraryPath,'raw/sources',mapping.from))));if([...changes.values()].some(change=>members.has(key(change.source.currentPath)))||catalogChanged){for(const source of pending)if(members.has(key(source.currentPath))||source.evolution)mark(source,'DIRECTORY_DEPENDENCY','目录调整成员或目录基线变化，完整目录依赖范围阻断',{classification:true});evolution.invalidated=true;reasons.push({code:'DIRECTORY_DEPENDENCY',scope:'directory',message:'目录演化不得只执行未变化的一部分，需重新检查完整调整',sourceIds:pending.filter(source=>members.has(key(source.currentPath))).map(source=>source.sourceId),nextAction:'directory'});}}
 let sharedStale=false;
 if(changes.size)sharedStale=staleValidation(batch,'来源、关联或分类审核变化，共享备份及验证证据需要重建');
 // 即使正文审核仍有效，库内无关变化也使整份备份证据失效；不把这个范围扩大为全文重分析。
 const validation=batch.flow.historyValidation;
 if(validation&&validation.status==='awaiting-apply'&&validation.backupReportPath&&batch.flow.historyApplication?.status!=='complete'){
  try{const report=JSON.parse(await readFile(validation.backupReportPath,'utf8'));if((await inventory(batch.libraryPath)).hash!==report.baseline.hash){sharedStale=staleValidation(batch,'完整原库基线已改变，需要重新建立整份安全验证');reasons.push({code:'SHARED_BASELINE_CHANGED',scope:'validation',sourceIds:[],message:'完整原库基线变化，仅使共享验证失效；仍有效的逐文件审核保留',nextAction:'validate'});}}catch(error){if(error.code!=='ENOENT')throw error;sharedStale=staleValidation(batch,'备份证据缺失，需要重新验证');reasons.push({code:'EVIDENCE_MISSING',scope:'validation',sourceIds:[],message:'旧备份证据缺失，不能沿用验证成功标志',nextAction:'validate'});}
 }
 for(const {source,body,classification} of changes.values()){
  const retainedStatus=['excluded','skipped'].includes(source.status)?source.status:null;
  source.selected=false;source.reviewVersion=(source.reviewVersion??0)+1;source.reviewResetCategory=!!(body||classification);source.reviewReasons=reasons.filter(reason=>reason.sourceIds.includes(source.sourceId)).map(reason=>reason.message);delete source.targetPath;delete source.frozenPlan;delete source.treeRevision;
  if(body){delete source.analysis;delete source.classification;delete source.suggestion;source.status=source.reviewMissing?'blocked':'needs-analysis';}
  else if(classification){delete source.classification;source.status=source.analysis?'analyzed':'needs-analysis';}
  else source.status=source.ingestStatus==='uncertain'?'blocked':source.classification?'classified':source.analysis?'analyzed':'needs-analysis';
  if(retainedStatus)source.status=retainedStatus;
  if(planning?.invalidateReview)await planning.invalidateReview({...batch,identity:source.currentIdentity??source.identity,clearClassification:body||classification});
 }
 if(reasons.length){batch.flow.invalidations={revision:(batch.flow.invalidations?.revision??0)+1,checkedAt:new Date().toISOString(),affectedSourceIds:[...changes.keys()],retainedReviewCount:batch.sources.filter(source=>source.status==='reviewed').length,analysisRetainedCount:batch.sources.filter(source=>source.analysis).length,sharedValidationStale:sharedStale,reasons};batch.phase=batch.flow.tree?.status==='stale'?'tree-review':'file-review';}
 return {changedSourceIds:[...changes.keys()],reasons,sharedValidationStale:sharedStale};
}
