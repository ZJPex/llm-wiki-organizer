async function setLimit(limit){
 const {token}=await(await fetch('/api/session')).json();
 const response=await fetch('/api/model-concurrency/set',{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify({limit})});
 const answer=await response.json();if(!response.ok)throw new Error(answer.error);return answer;
}
export function modelConcurrencyControls(host,{request=setLimit}={}){
 const progress=document.createElement('p'),occupancy=document.createElement('p'),label=document.createElement('label'),input=document.createElement('input'),save=document.createElement('button'),error=document.createElement('p');
 progress.setAttribute('role','status');occupancy.setAttribute('role','status');error.setAttribute('role','alert');
 input.type='number';input.setAttribute('min','1');input.setAttribute('step','1');input.setAttribute('aria-label','服务最大模型并发数');
 label.textContent='最大模型并发数';label.append(input);save.type='button';save.textContent='保存并发设置';host.append(progress,occupancy,label,save,error);
 let dirty=false;input.oninput=()=>{dirty=true;};
 const display=value=>{if(!value)return;occupancy.textContent=`模型调用占用 ${value.active}/${value.limit}${value.converging?' · 正在收敛，等待在途完成':''}；CLI 按整理器调用计数。`;if(!dirty&&document.activeElement!==input)input.value=String(value.limit);};
 save.onclick=async()=>{save.disabled=true;error.textContent='';try{const value=Number(input.value);if(!Number.isSafeInteger(value)||value<1)throw new Error('请输入合法正整数');const result=await request(value);dirty=false;display(result);}catch(e){error.textContent=e.message;}finally{save.disabled=false;}};
 return {update(batch){display(batch.modelConcurrency);const current=batch.flow?.analysisCurrent,classification=batch.flow?.classificationCurrent;const item=classification?.status==='running'?classification:current;if(!item||!['running','paused'].includes(item.status)){progress.textContent='';return;}const stage=({segment:'正文分段',synthesis:`汇总第 ${item.round??1} 轮`,search:'检索分类',choice:'选择分类',preparing:'检查来源'})[item.stage]??item.stage;progress.textContent=`${item.identity} · ${stage}${item.totalSteps?` ${item.completed??item.step??0}/${item.totalSteps}`:''}${item.status==='paused'?' · 已暂停':''}`;}};
}
