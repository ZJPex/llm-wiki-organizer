const labels={idle:'尚未启动',running:'后台分析中，可以离开页面',pausing:'正在暂停：停止新请求，等待在途调用完成',paused:'已暂停，已完成结果保留',interrupted:'服务曾中断，请点击继续；在途材料结果待重新核验',complete:'分析完成，请审核结果',partial:'所选文件已完成，其他未完成文件可手动继续',failed:'分析已停止，请处理错误后继续'};
export function backgroundAnalysis({getBatch,request,update,onError=()=>{}}){
 let timer=null;
 function observe(){
  const batch=getBatch();
  if(timer||!['running','pausing'].includes(batch?.analysisJob?.status))return;
  timer=setTimeout(async()=>{timer=null;try{const id=getBatch()?.batchId;if(!id)return;const next=await request('get',{batchId:id,cursor:getBatch().cursor,limit:getBatch().pageSize});if(getBatch()?.batchId===id)update(next);observe();}catch(error){onError(error);}},800);
 }
 async function start(){const batch=getBatch(),action=batch.analysisJob?.allowedActions?.includes('continueAnalysis')?'continueAnalysis':'startAnalysis';update(await request(action,{batchId:batch.batchId}));observe();}
 async function pause(){update(await request('pauseAnalysis',{batchId:getBatch().batchId}));observe();}
 function render(startButton,pauseButton,message){const job=getBatch()?.analysisJob;if(!job)return;startButton.disabled=['running','pausing'].includes(job.status);startButton.textContent=job.allowedActions.includes('continueAnalysis')?'继续分析':'开始后台分析';pauseButton.hidden=!['running','pausing'].includes(job.status);pauseButton.disabled=job.status!=='running';if(message)message.textContent=labels[job.status]+(job.error?`：${job.error.message}`:'');observe();}
 return {start,pause,render};
}
