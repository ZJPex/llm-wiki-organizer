// 每次处理一份，暂停在当前文件完成后生效；数量来自整批统计。
export async function classifyAll({getBatch,request,update,stopped}){
 while(!stopped()){
  const before=getBatch();
  if(!before.classificationProgress.remaining)return 'complete';
  let next;
  try{next=await request('classifyNext',{batchId:before.batchId,revision:before.revision});}
  catch(error){
   try{update(await request('get',{batchId:before.batchId}));}catch{ /* 保留最初的失败原因。 */ }
   throw error;
  }
  update(next);
  if(!next.classificationProgress.remaining)return 'complete';
  if(next.classificationProgress.remaining>=before.classificationProgress.remaining)throw new Error('分类未取得新进展，已停止，请检查材料状态后重试。');
 }
 return 'paused';
}
