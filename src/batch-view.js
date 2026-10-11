import {sourceDirectoryDependency} from './directory-dependencies.js';
import {buildBatchReport} from './batch-report.js';
import {canConfirmRecommendedCategory} from './category-confirmation.js';
import {suggestionProgress} from './classification-result.js';
import {reviewBasis} from './review-basis.js';
const pick=(value,names)=>Object.fromEntries(names.filter(name=>value?.[name]!==undefined).map(name=>[name,value[name]]));
const brief=value=>typeof value==='string'?value.slice(0,2000):value;
const itemFields=['id','sourceId','identity','from','to','path','finalPath','kind','before','after','targetBefore','targetAfter','hash','status','expectedHash','passive','changeType','sourcePath','oldPath','newPath','projectId','at','code','message'];
const sourceFields=['sourceId','identity','currentIdentity','currentPath','hash','rawIdentity','ingestStatus','status','skipReason','selected','kind','confirmedName','suggestion','warning','targetPath','category','treeRevision','analysisCalls','classificationError','categoryConfirmationError','manuallyEdited','reviewVersion','reviewResetCategory','reviewReasons'];
const batchFields=['schemaVersion','batchId','revision','createdAt','updatedAt','mode','libraryPath','sourceRoot','wikiSourcePath','artifactRoot','configPath','phase','status'];
const sliceFields=['sliceId','status','artifactDirectory','backupReportPath','planManifestPath','migrationPlanId','validationJournalPath','recoveryPlanPath','recoveryReportPath','authorizationPlanPath','originalResultPath','originalJournalPath'];
const errorView=value=>value?{code:value.code,message:brief(value.message)}:undefined;

// 公共视图使用白名单，磁盘完整证据仍留给执行器；每种明细均使用独立于来源的游标。
export function batchView(batch,{cursor=0,limit=25,treeCursor=0,detailCursor=0,sliceCursor,sliceLimit=1}={},isActive=false){
 const size=Math.max(1,Math.min(50,Number(limit)||25)),offset=Math.max(0,Number(cursor)||0),detailOffset=Math.max(0,Number(detailCursor)||0),treeOffset=Math.max(0,Number(treeCursor)||0);
 const sliceSize=Math.max(1,Math.min(50,Number(sliceLimit)||1));
 const sliceOffset=sliceCursor===undefined?Math.max(0,batch.slices.length-sliceSize):Math.max(0,Number(sliceCursor)||0);
 let detailCount=0;
 const page=(rows=[],map=value=>value)=>{detailCount=Math.max(detailCount,rows.length);return rows.slice(detailOffset,detailOffset+size).map(map);};
 const row=value=>({...pick(value,itemFields),...(value.reason?{reason:typeof value.reason==='string'?brief(value.reason):errorView(value.reason)}:{})});
 const evidence=value=>(value??[]).slice(0,Math.min(8,size)).map(text=>String(text).slice(0,400));
 const links=value=>value?{repairs:page(value.repairs,row),repairCount:value.repairs?.length??0,preexistingBroken:page(value.preexistingBroken,row),preexistingAmbiguous:page(value.preexistingAmbiguous,row),newlyBroken:page(value.newlyBroken,row)}:undefined;
 const indexes=value=>value?{status:value.status,pageMoves:page(value.pageMoves,row),tables:page(value.tables,table=>({...pick(table,['name','affectedRows','rows','vectorsPreserved']),searched:page(table.searched)}))}:undefined;
 const proof=value=>value?{upstreamCommit:value.upstreamCommit,result:{changedTasks:page(value.result?.changedTasks,row),changedTaskCount:value.result?.changedTasks?.length??0,queue:{tasks:page(value.result?.queue?.tasks,row)}},events:page(value.events,event=>({event:event.event}))}:undefined;
 const result=value=>value?{...pick(value,['status','phase','archiveJournalPath','journalPath','resultPath']),items:page(value.items,row),itemCount:value.items?.length??0,modelAttempts:page(value.modelAttempts,row),modelAttemptCount:value.modelAttempts?.length??0,newIngestRequests:page(value.newIngestRequests,row),afterProof:proof(value.afterProof),indexProof:indexes(value.indexProof),error:errorView(value.error)}:undefined;
 const operation=value=>({...pick(value,['type','parent','from','to','label','problem','benefit']),files:page(value.files),groups:page(value.groups,group=>({...pick(group,['label']),files:page(group.files)}))});
 const sources=batch.sources.slice(offset,offset+size).map(source=>{
  const entry=source.analysis,analysis=entry?.analysis??entry,node=batch.flow.tree?.nodes.find(node=>node.members.includes(source.sourceId));
  return {directoryDependency:sourceDirectoryDependency(batch,source),...pick(source,sourceFields),reviewBasis:reviewBasis(source),failure:source.failure?pick(source.failure,['code','message','attempts','scope']):undefined,progress:source.progress?{...pick(source.progress,['status','stage','step','completed','totalSteps','reusedSteps','round','startedAt']),retry:source.progress.retry?pick(source.progress.retry,['status','attempt','nextAttempt','maxAttempts','delayMs','code','message']):undefined}:undefined,proposedNodeId:node?.nodeId,proposedCategory:node?.category,
   analysis:analysis?{kind:source.kind??entry.kind,summary:brief(analysis.summary),suggestion:source.suggestion??entry.suggestion,confirmedName:source.confirmedName??entry.confirmedName,identityHints:page(entry.identityHints),warning:brief(entry.warning),evidence:evidence(analysis.evidence),uncertain:analysis.uncertain}:undefined,
   tags:source.tags??source.classification?.tags??[],classification:source.classification?{...pick(source.classification,['status','category','finalPath','decision','tags','newCategoryAccepted','rulesHash']),newCategory:source.classification.newCategory?pick(source.classification.newCategory,['proposalId','proposalHash','path','parent','label','reason','benefit']):undefined,adjustments:page(source.classification.adjustments,value=>({...pick(value,['type','from','to','reason','benefit','affectedCategories','requiresHistoryValidation'])})),reason:brief(source.classification.reason),evidence:evidence(source.classification.evidence),options:page(source.classification.options),considered:page(source.classification.considered)}:undefined,
   evolution:source.evolution?{status:source.evolution.status,reason:brief(source.evolution.reason),operations:page(source.evolution.operations,operation)}:undefined};
 });
 const flow=pick(batch.flow,['busy','stage','historyBeforeNew']);
 if(batch.flow.newArchives?.length){const run=batch.flow.newArchives.at(-1);flow.newArchive={...pick(run,['requestId','status','startedAt']),items:page(run.items,row),counts:run.items.reduce((counts,item)=>(counts[item.status]=(counts[item.status]??0)+1,counts),{})};}
 if(batch.flow.categoryConfirmation)flow.categoryConfirmation=pick(batch.flow.categoryConfirmation,['status','total','completed','confirmed','failed','skipped']);
 if(batch.flow.classificationCurrent)flow.classificationCurrent=pick(batch.flow.classificationCurrent,['sourceId','identity','startedAt','status','stage','step','totalSteps']);
 if(batch.flow.analysisCurrent)flow.analysisCurrent=pick(batch.flow.analysisCurrent,['sourceId','identity','startedAt','status','stage','step','totalSteps','round','completed','reusedSteps']);
 if(batch.flow.treeProgress)flow.treeProgress=pick(batch.flow.treeProgress,['status','stage','round','chunk','totalChunks','completedChunks','categoryCount','outputCategoryCount','processedCount','totalCount','attempt','maxCategories','updatedAt']);
 if(batch.flow.evolutionPlan)flow.evolutionPlan={planHash:batch.flow.evolutionPlan.planHash,newDirectories:page(batch.flow.evolutionPlan.newDirectories),directoryMappings:page(batch.flow.evolutionPlan.directoryMappings,row),fileMappings:page(batch.flow.evolutionPlan.fileMappings,row),affectedFileCount:batch.flow.evolutionPlan.fileMappings?.length??0};
 if(batch.flow.tree){const tree=batch.flow.tree;flow.tree={...pick(tree,['revision','status','analyzedCount','classifiedCount','catalogHash']),nodeCount:tree.nodes.length,nextCursor:treeOffset+size<tree.nodes.length?treeOffset+size:null,nodes:tree.nodes.slice(treeOffset,treeOffset+size).map(node=>({...pick(node,['nodeId','segments','category']),reason:brief(node.reason),representatives:node.representatives.slice(0,3),representativeFiles:node.representatives.slice(0,3).map(id=>({sourceId:id,identity:batch.sources.find(source=>source.sourceId===id)?.currentIdentity})),memberCount:node.members.length,members:page(node.members)}))};}
 const slices=batch.slices.slice(sliceOffset,sliceOffset+sliceSize).map(slice=>({...pick(slice,sliceFields),sourceIds:page(slice.sourceIds),newFileCount:slice.newFiles?.length??0,newFiles:page(slice.newFiles,row),error:errorView(slice.error),watchConfig:slice.watchConfig?{message:brief(slice.watchConfig.message),disposition:slice.watchConfig.disposition}:undefined,
  preview:slice.preview?{items:page(slice.preview.items,row),itemCount:slice.preview.items?.length??0,links:links(slice.preview.links),indexes:indexes(slice.preview.indexes)}:undefined,
  validationResult:result(slice.validationResult),historicalResult:result(slice.historicalResult),archiveResult:result(slice.archiveResult),
  authorization:slice.authorization?{...pick(slice.authorization,['originalPath','backupPath','validationPath','recoveryPath']),items:page(slice.authorization.items,row),itemCount:slice.authorization.items?.length??0}:undefined}));
 const counts={total:batch.sources.length};for(const source of batch.sources)counts[source.status]=(counts[source.status]??0)+1;
 const confirmableCategoryCount=batch.mode==='inbox'&&!batch.flow.evolutionPlan?batch.sources.filter(canConfirmRecommendedCategory).length:0;
 const events=page(batch.events,row);
 const classificationRemaining=batch.sources.filter(s=>['analyzed','named','classification-failed'].includes(s.status)&&s.analysis&&!s.analysis.uncertain).length;
 const classificationCompleted=batch.sources.filter(s=>['classified','evolution-review','reviewed','succeeded'].includes(s.status)&&s.classification).length;
 const classificationProgress={total:classificationRemaining+classificationCompleted,remaining:classificationRemaining,completed:classificationCompleted,skipped:batch.sources.length-classificationRemaining-classificationCompleted,failed:counts['classification-failed']??0};
 const report=buildBatchReport(batch,{limit:1,isActive});delete report.items;delete report.evidence;
 return {report,suggestionProgress:suggestionProgress(batch.sources),...pick(batch,batchFields),error:errorView(batch.error),flow,sources,slices,counts,classificationProgress,confirmableCategoryCount,analysisProgress:{total:batch.sources.length,remaining:batch.sources.filter(source=>['pending','analysis-failed','needs-analysis'].includes(source.status)||(source.status==='blocked'&&!source.analysis)).length,failed:counts['analysis-failed']??0},events,cursor:offset,treeCursor:treeOffset,detailCursor:detailOffset,pageSize:size,nextCursor:offset+size<batch.sources.length?offset+size:null,detailNextCursor:detailOffset+size<detailCount?detailOffset+size:null,detailCount,sliceCursor:sliceOffset,sliceNextCursor:sliceOffset+sliceSize<batch.slices.length?sliceOffset+sliceSize:null,sliceCount:batch.slices.length,interrupted:batch.phase?.endsWith('-running')&&!isActive};
}
