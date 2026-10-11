import {batchFail} from './batch-store.js';

// 内存只保存活跃执行权；持久化状态在重启后永远不会自行启动模型。
export const jobOwner=Symbol('后台分析执行权');
const jobs=new Map(),libraries=new Map();
export function analysisJobView(batch){
 const live=jobs.get(batch.batchId),saved=batch.flow.analysisJob;
 let status=live?.status??saved?.status??'idle';
 if(!live&&['running','pausing'].includes(status))status='interrupted';
 const uncertain=(batch.sources??[]).filter(source=>source.progress?.status==='running').map(source=>source.sourceId);
 return {status,boundary:'model-request',sourceIds:live?live.sourceIds??null:saved?.sourceIds??null,allowedActions:status==='running'?['pauseAnalysis']:status==='pausing'?[]:status==='idle'?['startAnalysis']:status==='complete'?['startAnalysis']:['continueAnalysis'],
  ...(status==='interrupted'&&(uncertain.length||batch.flow.classificationCurrent?.status==='running'||batch.flow.analysisCurrent?.status==='running')?{uncertainSourceId:uncertain[0]??(batch.flow.classificationCurrent?.status==='running'?batch.flow.classificationCurrent:batch.flow.analysisCurrent).sourceId,uncertainSourceIds:uncertain}:{}),
  ...(saved?.error?{error:saved.error}:{})};
}
export function assertAnalysisAccess(batch,input){
 const owner=libraries.get(batch.libraryPath.toLowerCase());
 if(owner&&input[jobOwner]!==owner)batchFail('BATCH_BUSY','该知识库正在后台分析，请先暂停并等待当前材料完成');
}
export function createBatchJobs({store,view,step,classify,processSource,proposeTree,checkIdle,prepare}){
 async function save(job,status,error){
  const batch=await store.get(job.batchId);
  return store.update(batch.batchId,batch.revision,record=>{record.flow.analysisJob={status,sourceIds:job.sourceIds??null,...(error?{error:{code:error.code??'ANALYSIS_FAILED',message:error.message,attempts:error.attempts,scope:error.shared?'model':'article'}}:{})};return record;});
 }
 async function run(job){
  try{
   let finalStatus='complete';
   await prepare(job);
   while(job.status!=='pausing'){
    const batch=await store.get(job.batchId);
    const before=view(batch),analyzing=before.analysisProgress.remaining>0;
    if(!analyzing&&!(batch.mode==='inbox'&&before.classificationProgress.remaining)){
     if(batch.mode==='restructure'&&(!batch.flow.tree||batch.flow.tree.status==='stale')&&batch.sources.some(source=>source.analysis?.analysis&&!source.analysis.analysis.uncertain&&!['skipped','blocked'].includes(source.status)))await proposeTree({batchId:batch.batchId,revision:batch.revision,action:'propose',[jobOwner]:job});
     break;
    }
    if(batch.mode==='inbox'&&processSource){
     const selected=batch.sources.filter(source=>(!job.sourceIds||job.sourceIds.includes(source.sourceId))&&(['pending','analysis-failed','needs-analysis'].includes(source.status)||(source.status==='blocked'&&!source.analysis)||(['analyzed','named','classification-failed'].includes(source.status)&&source.analysis&&!source.analysis.uncertain)));
     if(!selected.length){finalStatus=before.analysisProgress.remaining||before.classificationProgress.remaining?'partial':'complete';break;}
     const results=await Promise.allSettled(selected.map(source=>processSource(job,source.sourceId,!!source.analysis&&!['pending','needs-analysis','analysis-failed'].includes(source.status))));
     const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
     continue;
    }
    const next=await (analyzing?step:classify)({batchId:job.batchId,revision:batch.revision,limit:1,stopOnFailure:true,[jobOwner]:job});
    const progress=analyzing?'analysisProgress':'classificationProgress';
    if(next[progress].remaining>=before[progress].remaining)batchFail('ANALYSIS_STALLED','分析未取得进展，请检查当前材料后继续');
   }
   if(job.status==='pausing')finalStatus='paused';
   await save(job,finalStatus);
  }catch(error){await save(job,error.code==='ANALYSIS_PAUSED'?'paused':'failed',error.code==='ANALYSIS_PAUSED'?undefined:error).catch(()=>{});}
  finally{jobs.delete(job.batchId);if(libraries.get(job.libraryKey)===job)libraries.delete(job.libraryKey);}
 }
 async function startAnalysis(input){
  let batch=await store.get(input.batchId);
  if(input.sourceIds!==undefined&&(batch.mode!=='inbox'||!Array.isArray(input.sourceIds)||!input.sourceIds.length||new Set(input.sourceIds).size!==input.sourceIds.length||input.sourceIds.some(id=>!batch.sources.some(source=>source.sourceId===id))))batchFail('INVALID_SELECTION','恢复范围必须是本批次明确选择的收件箱文件');
  if(jobs.has(batch.batchId))return view(batch);
  checkIdle(batch);assertAnalysisAccess(batch,input);
  const job={batchId:batch.batchId,libraryKey:batch.libraryPath.toLowerCase(),status:'running',sourceIds:input.sourceIds??null};
  jobs.set(job.batchId,job);libraries.set(job.libraryKey,job);
  try{batch=await save(job,'running');}catch(error){jobs.delete(job.batchId);libraries.delete(job.libraryKey);throw error;}
  setImmediate(()=>void run(job));
  return view(batch);
 }
 async function pauseAnalysis(input){
  const batch=await store.get(input.batchId),job=jobs.get(batch.batchId);
  if(job?.status==='running')job.status='pausing';
  return view(batch);
 }
 return {startAnalysis,continueAnalysis:startAnalysis,pauseAnalysis};
}
