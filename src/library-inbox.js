import path from 'node:path';
import os from 'node:os';
import {lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createBatchStore,batchFail} from './batch-store.js';
import {discoverSources} from './batch-sources.js';
import {suggestionProgress} from './classification-result.js';

const queues=new Map();
// 文件身份与路径分开保存；扫描只发现来源，不发起模型请求。
export function createLibraryInboxService({batches,workspace,stateDirectory=path.join(workspace?.stateDirectory??path.join(os.homedir(),'.llm-wiki-organizer','libraries'),'inbox')}={}){
 const store=createBatchStore({stateDirectory});
 async function serial(id,action){const key=path.resolve(stateDirectory)+'|'+id,previous=queues.get(key)??Promise.resolve(),next=previous.catch(()=>{}).then(action);queues.set(key,next);try{return await next;}finally{if(queues.get(key)===next)queues.delete(key);}}
 async function record(id){let cursor=0;do{const page=await store.list({cursor,limit:50}),found=page.records.find(value=>value.libraryId===id);if(found)return found;cursor=page.nextCursor;}while(cursor!==null);return store.create({libraryId:id,items:[]});}
 async function snapshot(batchId){for(let attempt=0;attempt<5;attempt++){let cursor=0,first,sources=[],changed=false;do{const page=await batches.get({batchId,cursor,limit:50});first??=page;if(first.revision!==page.revision){changed=true;break;}sources.push(...page.sources);cursor=page.nextCursor;}while(cursor!==null);if(!changed)return {...first,sources};}batchFail('INBOX_BUSY','进度持续更新，请稍后重试读取');}
 async function sync(saved){
  const groups=new Map();
  for(const item of saved.items.filter(item=>item.batchId)){
   if(!groups.has(item.batchId))groups.set(item.batchId,await snapshot(item.batchId));
   const batch=groups.get(item.batchId),source=batch.sources.find(value=>value.sourceId===item.sourceId);if(!source)continue;
   item.analysis=source.analysis;item.suggestion=source.confirmedName??source.suggestion??source.analysis?.suggestion;item.classification=source.classification;item.targetPath=source.targetPath??source.classification?.finalPath;item.manuallyEdited=source.manuallyEdited;item.error=source.classificationError??source.skipReason;
   item.tags=source.tags??source.classification?.tags??[];item.kind=source.kind;item.confirmedName=source.confirmedName;item.reviewVersion=source.reviewVersion??0;item.reviewBasis=source.reviewBasis;
   if(source.status==='needs-information'&&!item.classification)item.classification={category:null,decision:'insufficient-evidence',tags:[],reason:source.skipReason??'正文信息或可核验引用不足，保留原处',considered:[],evidence:[]};
   item.failure=source.failure;item.progress=source.progress;item.stage=source.progress?.stage??(batch.flow.analysisCurrent?.sourceId===source.sourceId?batch.flow.analysisCurrent.stage:batch.flow.classificationCurrent?.sourceId===source.sourceId?batch.flow.classificationCurrent.stage:undefined);
   if(source.status==='succeeded'){item.status='archived';item.currentPath=source.currentPath;item.identity=source.currentIdentity;const stat=await lstat(source.currentPath,{bigint:true});item.fileIdentity=JSON.stringify([String(stat.dev),String(stat.ino),String(stat.birthtimeNs)]);}
   else if(!item.available)item.status='missing';
   else if(['excluded','skipped'].includes(source.status))item.status='excluded';
   else if(source.status==='needs-analysis'){item.status='pending';delete item.classification;delete item.targetPath;delete item.suggestion;delete item.analysis;delete item.tags;}
   else if(source.status==='reviewed')item.status='confirmed';
   else if(source.status.endsWith('failed'))item.status='failed';
   else if(source.status==='needs-information'||source.status==='blocked')item.status='needs-information';
   else if(source.analysis&&!source.analysis.uncertain){item.status=source.classification?.category!==null&&source.classification?.category!==undefined&&item.suggestion?'reviewable':'needs-classification';}
   else item.status=['running','pausing'].includes(batch.analysisJob.status)?'analyzing':['interrupted','paused','failed'].includes(batch.analysisJob.status)?'paused':'waiting';
  }
  saved.analysisActive=[...groups.values()].some(batch=>['running','pausing'].includes(batch.analysisJob.status));return groups;
 }
 const save=saved=>store.update(saved.batchId,saved.revision,()=>saved);
 const view=value=>({libraryId:value.libraryId,revision:value.revision,analysisActive:value.analysisActive??false,analysisProgress:{total:value.items.filter(item=>item.batchId).length,completed:value.items.filter(item=>item.batchId&&(item.analysis||item.status==='needs-information')).length,remaining:value.items.filter(item=>['waiting','analyzing','paused'].includes(item.status)).length,failed:value.items.filter(item=>item.status==='failed').length},suggestionProgress:suggestionProgress(value.items),items:value.items.map(({fileIdentity,batchId,sourceId,...item})=>item)});
 function select(saved,ids){if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length)batchFail('INVALID_SELECTION','请选择文件');const chosen=ids.map(id=>saved.items.find(item=>item.itemId===id));if(chosen.some(item=>!item))batchFail('INVALID_SELECTION','所选文件不属于当前知识库');return chosen;}
 return {
  list:input=>serial(input.id,async()=>{const library=await workspace.checked(input.id);const saved=await record(input.id);await sync(saved);return {...view(await save(saved)),...(batches.getClassificationRules?await batches.getClassificationRules(library):{classificationRules:[]})};}),
  scan:input=>serial(input.id,async()=>{
   const library=await workspace.checked(input.id),saved=await record(input.id),discovered=await discoverSources(library),seen=new Set();await sync(saved);
   for(const source of discovered.sources){
    const stat=await lstat(source.currentPath,{bigint:true}),fileIdentity=JSON.stringify([String(stat.dev),String(stat.ino),String(stat.birthtimeNs)]);
    let item=saved.items.find(value=>value.fileIdentity===fileIdentity);
    if(!item){item={itemId:randomUUID(),libraryId:input.id,fileIdentity,status:'pending',history:[]};saved.items.push(item);}
    if(item.status==='archived'){seen.add(item.itemId);continue;}
    if(item.hash&&item.hash!==source.hash){item.history.push({hash:item.hash,identity:item.identity,batchId:item.batchId,sourceId:item.sourceId});for(const field of ['batchId','sourceId','analysis','classification','suggestion','targetPath','manuallyEdited','stage','tags','kind'])delete item[field];item.status='pending';item.invalidatedReason='源正文已变化，请重新处理';}
    else if(item.batchId&&item.currentPath!==source.currentPath){const batch=await snapshot(item.batchId);await batches.rebindSource({batchId:item.batchId,revision:batch.revision,sourceId:item.sourceId,currentPath:source.currentPath});delete item.classification;delete item.targetPath;item.status='needs-classification';item.invalidatedReason='来源位置已变化，请复核分类与归档位置';}
    if(item.status==='missing'&&!item.batchId)item.status='pending';
    Object.assign(item,{identity:source.identity,currentPath:source.currentPath,hash:source.hash,ingestStatus:source.ingestStatus,available:true});seen.add(item.itemId);
   }
   for(const item of saved.items)if(!seen.has(item.itemId)&&item.status!=='archived'){item.available=false;item.status='missing';}
   return view(await save(saved));
  }),
  start:input=>serial(input.id,async()=>{
   const library=await workspace.checked(input.id),saved=await record(input.id),groups=await sync(saved),chosen=select(saved,input.itemIds);
   if(chosen.some(item=>!item.available||item.ingestStatus==='uncertain'))batchFail('INVALID_SELECTION','来源不可用或关联不明确');
   if(batches.getClassificationRules){const latest=await batches.getClassificationRules(library),stale=chosen.filter(item=>item.batchId&&item.status!=='archived'&&item.classification?.rulesHash&&item.classification.rulesHash!==latest.rulesHash);for(const batchId of new Set(stale.map(item=>item.batchId))){const batch=await snapshot(batchId);await batches.refreshReview({batchId,revision:batch.revision});}if(stale.length)await sync(saved);}
   const pending=chosen.filter(item=>!item.batchId);
   if(pending.length){
    if([...groups.values()].some(batch=>['running','pausing'].includes(batch.analysisJob.status)))batchFail('INBOX_BUSY','当前知识库仍在分析，请等待完成后开始新材料');
    const batch=await batches.create({...library,mode:'inbox',includeIdentities:pending.map(item=>item.identity)});
    const full=await snapshot(batch.batchId);
    for(const item of pending){const source=full.sources.find(source=>source.identity===item.identity);item.batchId=batch.batchId;item.sourceId=source.sourceId;item.status='waiting';}
    Object.assign(saved,await save(saved));await batches.startAnalysis({batchId:batch.batchId,sourceIds:pending.map(item=>item.sourceId)});
   }
   const resuming=chosen.filter(item=>item.batchId&&['paused','failed','waiting','needs-classification'].includes(item.status));
   for(const batchId of new Set(resuming.map(item=>item.batchId)))await batches.startAnalysis({batchId,sourceIds:resuming.filter(item=>item.batchId===batchId).map(item=>item.sourceId)});
   await sync(saved);return view(await save(saved));
  }),
  review:input=>serial(input.id,async()=>{
   await workspace.checked(input.id);if(!input.reviewBasis)batchFail('REVIEW_REQUIRED','请读取当前审核依据后保存');const saved=await record(input.id);await sync(saved);const [item]=select(saved,[input.itemId]);
   if(!['reviewable','confirmed','needs-classification'].includes(item.status))batchFail('REVIEW_REQUIRED','请等待正文分析后再保存审核');
   const batch=await snapshot(item.batchId);
   await batches.reviewItem({batchId:item.batchId,revision:batch.revision,sourceId:item.sourceId,reviewBasis:input.reviewBasis,action:'confirmPlan',name:input.name,category:input.category,tags:input.tags,saveClassificationRule:input.saveClassificationRule,ruleText:input.ruleText,acceptNewCategory:input.acceptNewCategory,newCategoryHash:input.newCategoryHash,manuallyEdited:input.manuallyEdited===true});
   await sync(saved);return view(await save(saved));
  }),
  archive:input=>serial(input.id,async()=>{
   await workspace.checked(input.id);if(input.approved!==true||input.writersPaused!==true)batchFail('WRITERS_NOT_PAUSED','确认归档前请暂停外部写入');
   const saved=await record(input.id),groups=await sync(saved),chosen=select(saved,input.itemIds);
   if(chosen.some(item=>!['confirmed','archived'].includes(item.status)))batchFail('REVIEW_REQUIRED','请先保存所选文件审核');
   if([...groups.values()].some(batch=>['running','pausing'].includes(batch.analysisJob.status)))batchFail('INBOX_BUSY','请等待分析完成后归档');
   if(typeof input.requestId!=='string'||!input.requestId||input.requestId.length>90)batchFail('INVALID_REQUEST','归档请求缺少稳定标识');
   for(const batchId of new Set(chosen.filter(item=>item.status!=='archived').map(item=>item.batchId))){const batch=await snapshot(batchId);await batches.confirmNewArchive({batchId,revision:batch.revision,requestId:input.requestId+':'+batchId,writersPaused:true,items:chosen.filter(item=>item.batchId===batchId&&item.status!=='archived').map(item=>({sourceId:item.sourceId,name:item.suggestion,category:item.classification.category,tags:item.tags,acceptNewCategory:item.classification.newCategoryAccepted===true,newCategoryHash:item.classification.newCategory?.proposalHash,manuallyEdited:item.manuallyEdited===true}))});}
   await sync(saved);return view(await save(saved));
  }),
 };
}
