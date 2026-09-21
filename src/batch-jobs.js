import {batchFail} from './batch-store.js';

// 内存只保存活跃执行权；持久化状态在重启后永远不会自行启动模型。
export const jobOwner=Symbol('后台分析执行权');
const jobs=new Map(),libraries=new Map();
export function analysisJobView(batch){
 const live=jobs.get(batch.batchId),saved=batch.flow.analysisJob;
 let status=live?.status??saved?.status??'idle';
 if(!live&&['running','pausing'].includes(status))status='interrupted';
 return {status,boundary:'current-material',allowedActions:status==='running'?['pauseAnalysis']:status==='pausing'?[]:status==='idle'?['startAnalysis']:status==='complete'?['startAnalysis']:['continueAnalysis'],
  ...(status==='interrupted'&&(batch.flow.classificationCurrent?.status==='running'||batch.flow.analysisCurrent?.status==='running')?{uncertainSourceId:(batch.flow.classificationCurrent?.status==='running'?batch.flow.classificationCurrent:batch.flow.analysisCurrent).sourceId}:{}),
  ...(saved?.error?{error:saved.error}:{})};
}
export function assertAnalysisAccess(batch,input){
 const owner=libraries.get(batch.libraryPath.toLowerCase());
 if(owner&&input[jobOwner]!==owner)batchFail('BATCH_BUSY','该知识库正在后台分析，请先暂停并等待当前材料完成');
}
export function createBatchJobs({store,view,step,classify,checkIdle,prepare}){
 async function save(job,status,error){
  const batch=await store.get(job.batchId);
  return store.update(batch.batchId,batch.revision,record=>{record.flow.analysisJob={status,...(error?{error:{code:error.code??'ANALYSIS_FAILED',message:error.message}}:{})};return record;});
 }
 async function run(job){
  try{
   let finalStatus='complete';
   await prepare(job);
   while(job.status!=='pausing'){
    const batch=await store.get(job.batchId);
    const before=view(batch),analyzing=before.analysisProgress.remaining>0;
    if(!analyzing&&!(batch.mode==='inbox'&&before.classificationProgress.remaining))break;
    const next=await (analyzing?step:classify)({batchId:job.batchId,revision:batch.revision,limit:1,stopOnFailure:true,[jobOwner]:job});
    const progress=analyzing?'analysisProgress':'classificationProgress';
    if(next[progress].remaining>=before[progress].remaining)batchFail('ANALYSIS_STALLED','分析未取得进展，请检查当前材料后继续');
   }
   if(job.status==='pausing')finalStatus='paused';
   await save(job,finalStatus);
  }catch(error){await save(job,'failed',error).catch(()=>{});}
  finally{jobs.delete(job.batchId);if(libraries.get(job.libraryKey)===job)libraries.delete(job.libraryKey);}
 }
 async function startAnalysis(input){
  let batch=await store.get(input.batchId);
  if(jobs.has(batch.batchId))return view(batch);
  checkIdle(batch);assertAnalysisAccess(batch,input);
  const job={batchId:batch.batchId,libraryKey:batch.libraryPath.toLowerCase(),status:'running'};
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
