import {executionBlock} from './execution-state.js';
import {sourceDirectoryDependency} from './directory-dependencies.js';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {batchFail} from './batch-store.js';
import {planDigest} from './categories.js';

// 一次授权只涵盖明确列出的新增文件；每份独立文件保留自己的持久归档日志。
export function createNewArchiveWorkflow({store,view,operate,strategy,planning,fresh,reconcile}){
 return async function confirmNewArchive(input){
  if(input.writersPaused!==true)batchFail('WRITERS_NOT_PAUSED','请暂停全部外部写入后确认归档');
  if(typeof input.requestId!=='string'||!input.requestId||input.requestId.length>128)batchFail('INVALID_REQUEST','归档请求缺少稳定标识');
  if(!Array.isArray(input.items)||!input.items.length||new Set(input.items.map(i=>i.sourceId)).size!==input.items.length)batchFail('INVALID_SELECTION','请明确选择归档材料');
  const requestHash=planDigest(input.items),existing=await store.get(input.batchId);
  const previous=existing.flow.newArchives?.find(run=>run.requestId===input.requestId);
  if(previous){if(previous.requestHash!==requestHash)batchFail('REQUEST_CHANGED','重复请求的审核范围已变化');return view(existing);}
  return operate(input,'archive-running',async(batch,save)=>{
   if(batch.mode!=='inbox')batchFail('INVALID_MODE','新增归档仅用于收件箱');

   if(executionBlock(batch,'archive'))batchFail('EXECUTION_INTERRUPTED','已有执行或失败证据，请先处理后再归档');
   const chosen=input.items.map(item=>({item,source:batch.sources.find(s=>s.sourceId===item.sourceId)}));
   if(chosen.some(({source})=>!source))batchFail('INVALID_SELECTION','材料不在当前批次');
   if(chosen.some(({source})=>source.ingestStatus==='historical'))batchFail('HISTORY_REQUIRED','历史材料必须经过副本验证与原库确认');
   const run={requestId:input.requestId,requestHash,status:'checking',items:[],startedAt:new Date().toISOString()};
   (batch.flow.newArchives??=[]).push(run);await save();
   const targets=new Map();
   for(const {item,source} of chosen){const key=path.resolve(batch.libraryPath,'raw/sources',item.category??'',item.name??'').toLowerCase();targets.set(key,(targets.get(key)??0)+1);}
   for(const {item,source} of chosen){
    const outcome={sourceId:source.sourceId,identity:source.identity,status:'retained'};run.items.push(outcome);
    try{
     if(sourceDirectoryDependency(batch,source,path.resolve(batch.libraryPath,'raw/sources',item.category??'',item.name??'')))batchFail('HISTORY_REQUIRED','该材料涉及目录调整依赖，须先确认完整目录方案；保留原处');
     if(['excluded','succeeded','blocked','needs-information'].includes(source.status)||source.ingestStatus!=='new')batchFail('INSUFFICIENT_EVIDENCE',source.skipReason??'材料已排除或证据不足，保留原处');
     const key=path.resolve(batch.libraryPath,'raw/sources',item.category??'',item.name??'').toLowerCase();
     if(targets.get(key)>1)batchFail('TARGET_EXISTS','所选材料目标重名，保留所有冲突项');
     await fresh(batch,[source]);
     const reviewed=await strategy(batch).review({batch,source,input:{...item,action:'confirmPlan'},planning});Object.assign(source,reviewed.sourcePatch);
     const prepared=await strategy(batch).prepare({batch,selected:[source],planning});
     if(prepared.historicalRequest)batchFail('HISTORY_REQUIRED','归档检查发现历史或目录依赖');
     const slice={...prepared,sliceId:randomUUID(),sourceIds:[source.sourceId],status:'prepared'};
     slice.artifactDirectory=path.join(batch.artifactRoot,'new-'+slice.sliceId);await mkdir(slice.artifactDirectory);
     batch.slices.push(slice);outcome.sliceId=slice.sliceId;outcome.status='ready';outcome.to=source.targetPath;
    }catch(error){outcome.reason={code:error.code??'CHECK_FAILED',message:error.message};source.categoryConfirmationError=error.message;source.selected=false;}
    await save();
   }
   const authorizedCategories=[...new Map(run.items.filter(item=>item.status==='ready').flatMap(item=>batch.slices.find(slice=>slice.sliceId===item.sliceId).newCategories??[]).map(proposal=>[proposal.proposalHash,proposal])).values()];
   for(const outcome of run.items.filter(item=>item.status==='ready')){const slice=batch.slices.find(slice=>slice.sliceId===outcome.sliceId);if(slice.newCategories?.length)slice.allowedNewCategories=authorizedCategories;}
   run.status='archiving';await save();
   for(const outcome of run.items.filter(item=>item.status==='ready')){
   const slice=batch.slices.find(s=>s.sliceId===outcome.sliceId);slice.status='applying';outcome.status='running';await save();
    try{
     slice.archiveResult=await strategy(batch).archive({batch,slice,artifactDirectory:slice.artifactDirectory,planning});await save();
     if(slice.archiveResult.status!=='complete')throw Object.assign(new Error(slice.archiveResult.error?.message??'归档失败，请检查保留的来源与日志'),{code:slice.archiveResult.error?.code??'ARCHIVE_FAILED'});
     await reconcile(batch,slice);slice.status='complete';outcome.status='succeeded';
    }catch(error){slice.status='failed';outcome.status='failed';outcome.reason={code:error.code??'ARCHIVE_FAILED',message:error.message};slice.error=outcome.reason;
     // 发生写入失败时保留全部证据，不在同一次授权内继续写入。
     for(const next of run.items.filter(item=>item.status==='ready')){next.status='retained';next.reason={code:'EXECUTION_STOPPED',message:'前一项执行失败，等待检查归档日志'};batch.slices.find(s=>s.sliceId===next.sliceId).status='cancelled';}
     await save();break;
    }
    await save();
   }
   run.status=run.items.every(item=>item.status==='succeeded')?'complete':run.items.some(item=>item.status==='succeeded')?'partial':'retained';batch.phase='batch-progress';
  });
 };
}
