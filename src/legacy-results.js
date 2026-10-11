import path from 'node:path';
import {analysisVersion,sameAnalysisVersion} from './analysis-version.js';
import {readModelConfig} from './model-config.js';
import {categoryCatalog,planDigest} from './categories.js';
import {executionBlock} from './execution-state.js';
import {batchFail} from './batch-store.js';

const samePath=(first,second)=>path.resolve(first).toLowerCase()===path.resolve(second).toLowerCase();
// 完整旧记录只留在服务内部；收件箱取得的是来源标识与验证结论。
export function createLegacyResults({store,planning,create}){
 async function records(){const records=[];let cursor=0;do{const page=await store.list({cursor,limit:50});records.push(...page.records);cursor=page.nextCursor;}while(cursor!==null);return records;}
 async function candidates(library,item){
  const version=analysisVersion(await readModelConfig(library)),catalog=await categoryCatalog(path.join(library.libraryPath,'raw/sources')),found=[];
  for(const batch of await records()){
   if(batch.flow.legacyOrigin||!samePath(batch.libraryPath,library.libraryPath))continue;
   for(const source of batch.sources){
    if(source.fileIdentity!==item.fileIdentity&&!(samePath(batch.sourceRoot,library.sourceRoot)&&source.identity===item.identity))continue;
    if(!source.analysis&&source.status!=='succeeded')continue;
    const originId=batch.batchId+':'+source.sourceId;
    let reason='',valid=true;
    if(source.status==='succeeded')reason='旧任务已归档，保留归档与恢复记录';
    else if(executionBlock(batch,'archive')||executionBlock(batch,'refresh'))reason='旧任务保留执行现场，请从原报告查询或恢复';
    else if(!samePath(batch.sourceRoot,library.sourceRoot)||source.fileIdentity!==item.fileIdentity)reason='无法证明旧结果对应当前来源身份';
    else if(source.hash!==item.hash)reason='源正文已变化，旧结果仅供历史查阅';
    else if(!sameAnalysisVersion(source.analysisVersion,version))reason='模型配置或正文分析规则版本不匹配，旧结果仅供历史查阅';
    else if(source.analysis.uncertain)reason='旧正文证据不足，保留历史';
    if(reason)valid=false;
    const libraryValid=!!batch.inboxLibraryProof&&batch.inboxLibraryProof===library.libraryIdentity;
    const classificationValid=valid&&libraryValid&&source.classification?.catalogHash===catalog.hash;
    const confirmed=classificationValid&&source.status==='reviewed'&&source.frozenPlan?.sourceHash===item.hash&&source.frozenPlan.catalogHash===catalog.hash;
    found.push({originId,valid,classificationValid,confirmed,reason:reason||(!libraryValid?'旧确认缺少当前知识库身份证据，请重新审核':!classificationValid?'分类目录依据变化，请重新审核':'正文、分类与人工确认依据仍有效'),name:source.confirmedName??source.suggestion??source.analysis?.suggestion,category:source.classification?.category??null,tags:source.tags??[],manuallyEdited:source.manuallyEdited===true,recoveryUrl:'/task-report?batchId='+batch.batchId,resultHash:planDigest({analysis:source.analysis,name:source.confirmedName??source.suggestion,classification:source.classification,tags:source.tags}),batch,source});
   }
  }
  return found;
 }
 const summary=({batch,source,resultHash,...candidate})=>candidate;
 async function adopt(library,item,originId){
  const candidate=(await candidates(library,item)).find(value=>value.originId===originId);
  if(!candidate?.valid)batchFail('LEGACY_INVALID','旧结果已失效，请刷新后查看历史依据');
  const imported=await create({...library,mode:'inbox',includeIdentities:[item.identity]}),entry=await planning.adoptLegacyAnalysis({...library,identity:item.identity,entry:candidate.source,classificationValid:candidate.classificationValid});
  const saved=await store.get(imported.batchId);
  const updated=await store.update(saved.batchId,saved.revision,()=>({...saved,phase:'file-review',flow:{...saved.flow,legacyOrigin:originId},sources:saved.sources.map(source=>({...source,...entry,selected:false,status:entry.classification?.category===null?'analyzed':'classified',manuallyEdited:candidate.manuallyEdited}))}));
  return {batchId:updated.batchId,sourceId:updated.sources[0].sourceId,candidate:summary(candidate)};
 }
 return {legacyResults:async(library,item)=>(await candidates(library,item)).map(summary),adoptLegacy:adopt};
}
