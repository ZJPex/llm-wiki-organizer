export function treeProgressText(batch){
 const p=batch.flow?.treeProgress;if(!p)return '';
 const state=batch.interrupted?'已中断':p.status==='failed'?'已停止':p.status==='complete'?'已完成':'进行中';
 const detail=p.stage==='proposal'?`材料分组 ${p.chunk}/${p.totalChunks}，已处理 ${p.processedCount}/${p.totalCount} 份`:p.stage==='merge'?`归并第 ${p.round} 轮，第 ${p.chunk}/${p.totalChunks} 组，第 ${p.attempt} 次尝试`:'分类树已生成';
 return `分类树${state}：${detail}；当前 ${p.categoryCount} 个分类。`;
}

// 请求串行轮询，结束后的迟到响应不能覆盖最终批次版本。
export async function withTreeProgress({operation,read,update,schedule=setInterval,cancel=clearInterval}){
 let finished=false,reading=false;
 const timer=schedule(async()=>{
  if(finished||reading)return;reading=true;
  try{const value=await read();if(!finished)update(value);}catch{ /* 临时读取失败不影响后台生成，最终操作仍返回实际错误。 */ }
  finally{reading=false;}
 },2000);
 try{return await operation();}finally{finished=true;cancel(timer);}
}
