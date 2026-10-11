import path from 'node:path';
import {lstat,readFile} from 'node:fs/promises';
import {digest} from './compatibility.js';
import {analysisVersion,sameAnalysisVersion} from './analysis-version.js';
import {readModelConfig} from './model-config.js';
import {categoryCatalog,planDigest} from './categories.js';
import {executionBlock} from './execution-state.js';
import {batchFail} from './batch-store.js';

const samePath=(first,second)=>path.resolve(first).toLowerCase()===path.resolve(second).toLowerCase();
const resultFingerprint=source=>planDigest({analysis:source.analysis,name:source.confirmedName??source.suggestion,category:source.classification?.category??null,tags:source.tags??source.classification?.tags??[]});
// 完整旧记录只留在服务内部；收件箱取得的是来源标识与验证结论。
export function createLegacyResults({store,planning,create,isActive=()=>false}){
 async function sanitizeLegacy(library,values){
  const config=await readModelConfig(library),secrets=[config.apiKey,...Object.values(config.customHeaders??{})].filter(value=>typeof value==='string'&&value.length>=4);
  const redact=value=>{if(typeof value!=='string')return value;if(path.isAbsolute(value)||/^[A-Za-z]:[\\/]/.test(value))return '[私有路径已隐藏]';for(const secret of secrets)value=value.replaceAll(secret,'[凭据已隐藏]');return value;};
  return values.map(value=>Object.fromEntries(['originId','name','category','tags','manuallyEdited','valid','classificationValid','confirmed','requiresRecovery','active','reason','recoveryUrl','resultFingerprint'].filter(key=>value[key]!==undefined).map(key=>[key,key==='recoveryUrl'?value[key]:Array.isArray(value[key])?value[key].map(redact):redact(value[key])])));
 }
 async function records(){const records=[];let cursor=0;do{const page=await store.list({cursor,limit:50});records.push(...page.records);cursor=page.nextCursor;}while(cursor!==null);return records;}
 async function origins(){
  const values=await records();return values.filter(batch=>{
   if(!batch.flow.legacyOrigin)return true;
   const [batchId,sourceId]=batch.flow.legacyOrigin.split(':'),original=values.find(value=>value.batchId===batchId)?.sources.find(value=>value.sourceId===sourceId);
   return batch.sources.some(source=>source.status==='reviewed'&&source.manuallyEdited&&(!original||resultFingerprint(source)!==resultFingerprint(original)));
  });
 }
 async function candidates(library,item){
  const version=analysisVersion(await readModelConfig(library)),catalog=await categoryCatalog(path.join(library.libraryPath,'raw/sources')),found=[];
  const actual=await lstat(item.currentPath,{bigint:true}).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  const actualIdentity=actual?JSON.stringify([String(actual.dev),String(actual.ino),String(actual.birthtimeNs)]):null;
  const text=actual?await readFile(item.currentPath,'utf8'):null;
  for(const batch of await origins()){
   if(!samePath(batch.libraryPath,library.libraryPath))continue;
   for(const source of batch.sources){
    if(source.fileIdentity!==item.fileIdentity&&!(samePath(batch.sourceRoot,library.sourceRoot)&&source.identity===item.identity))continue;
    const active=isActive(batch);if(!source.analysis&&source.status!=='succeeded'&&!active)continue;
    const originId=batch.batchId+':'+source.sourceId;
    let reason='',valid=true;const requiresRecovery=!!(executionBlock(batch,'archive')||executionBlock(batch,'refresh'));
    if(source.status==='succeeded')reason='旧任务已归档，保留归档与恢复记录';
    else if(requiresRecovery)reason='旧任务保留执行现场，请从原报告查询或恢复';
    else if(active)reason='旧任务仍在运行，请等待静止后刷新接入';
    else if(!samePath(batch.sourceRoot,library.sourceRoot)||source.fileIdentity!==item.fileIdentity||source.fileIdentity!==actualIdentity)reason='无法证明旧结果对应当前来源身份';
    else if(source.hash!==item.hash||source.hash!==digest(text))reason='源正文已变化，旧结果仅供历史查阅';
    else if(!sameAnalysisVersion(source.analysisVersion,version))reason='模型配置或正文分析规则版本不匹配，旧结果仅供历史查阅';
    else if(source.analysis.uncertain||!source.analysis.evidence?.length||source.analysis.evidence.some(value=>typeof value!=='string'||!value||!text.includes(value)))reason='旧正文证据不足，保留历史';
    if(reason)valid=false;
    const libraryValid=!!batch.inboxLibraryProof&&batch.inboxLibraryProof===library.libraryIdentity;
    const classificationValid=valid&&libraryValid&&source.classification?.catalogHash===catalog.hash;
    const confirmed=classificationValid&&source.status==='reviewed'&&source.frozenPlan?.sourceHash===item.hash&&source.frozenPlan.catalogHash===catalog.hash;
    found.push({originId,valid,classificationValid,confirmed,requiresRecovery,active,reason:reason||(!libraryValid?'旧确认缺少当前知识库身份证据，请重新审核':!classificationValid?'分类目录依据变化，请重新审核':'正文、分类与人工确认依据仍有效'),name:source.confirmedName??source.suggestion??source.analysis?.suggestion,category:source.classification?.category??null,tags:source.tags??[],manuallyEdited:source.manuallyEdited===true,recoveryUrl:'/task-report?batchId='+batch.batchId,resultHash:resultFingerprint(source),batch,source});
   }
  }
  return found;
 }
 const summary=({batch,source,resultHash,...candidate})=>({...candidate,resultFingerprint:resultHash});
 async function adopt(library,item,originId){
  const candidate=(await candidates(library,item)).find(value=>value.originId===originId);
  if(!candidate?.valid)batchFail('LEGACY_INVALID','旧结果已失效，请刷新后查看历史依据');
  const scope=JSON.stringify([library.libraryIdentity,library.libraryPath,library.sourceRoot]);
  const prior=(await records()).find(batch=>batch.flow.legacyOrigin===originId&&batch.flow.legacyScope===scope&&batch.sources.some(source=>source.fileIdentity===item.fileIdentity&&source.hash===item.hash&&sameAnalysisVersion(source.analysisVersion,candidate.source.analysisVersion)));
  if(prior)return {batchId:prior.batchId,sourceId:prior.sources.find(source=>source.fileIdentity===item.fileIdentity).sourceId,candidate:summary(candidate)};
  const imported=await create({...library,mode:'inbox',includeIdentities:[item.identity]}),entry=await planning.adoptLegacyAnalysis({...library,identity:item.identity,entry:candidate.source,classificationValid:candidate.classificationValid});
  const saved=await store.get(imported.batchId);
  const updated=await store.update(saved.batchId,saved.revision,()=>({...saved,phase:'file-review',flow:{...saved.flow,legacyOrigin:originId,legacyScope:scope},sources:saved.sources.map(source=>({...source,...entry,selected:false,status:entry.classification?.category===null?'analyzed':'classified',manuallyEdited:candidate.manuallyEdited}))}));
  return {batchId:updated.batchId,sourceId:updated.sources[0].sourceId,candidate:(await sanitizeLegacy(library,[summary(candidate)]))[0]};
 }
 return {sanitizeLegacy,legacyHistory:async library=>sanitizeLegacy(library,(await origins()).filter(batch=>samePath(batch.libraryPath,library.libraryPath)).flatMap(batch=>batch.sources.filter(source=>source.analysis||source.status==='succeeded').map(source=>({originId:batch.batchId+':'+source.sourceId,name:source.confirmedName??source.suggestion,category:source.classification?.category??null,tags:source.tags??[],manuallyEdited:source.manuallyEdited===true,valid:false,reason:source.status==='succeeded'?'旧任务已归档，保留原报告与恢复记录':'尚未按当前来源与版本核验，仅供历史查阅',recoveryUrl:'/task-report?batchId='+batch.batchId})))),legacyResults:async(library,item)=>sanitizeLegacy(library,(await candidates(library,item)).map(summary)),adoptLegacy:adopt};
}
