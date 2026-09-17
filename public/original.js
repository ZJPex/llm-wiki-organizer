const $=selector=>document.querySelector(selector);
let plan,busy=false;
const states={'awaiting-review':'等待审核',complete:'全部选中项目成功',partial:'选中子集成功，其他项目未执行',failed:'执行失败，请根据日志恢复现场',running:'正在执行或进程已中断，请查看日志',selected:'已选中',excluded:'已排除',blocked:'受阻',succeeded:'成功','applied-unverified':'已修改但未验证','not-run':'未执行',pending:'等待执行'};
function render(selector,value){
 const host=$(selector);host.replaceChildren();
 const line=(label,text)=>{if(text===undefined)return;const p=document.createElement('p');p.textContent=`${label}：${text}`;host.append(p);};
 line('状态',states[value.status]??value.status);
 for(const [key,label] of [['originalPath','执行原库'],['backupPath','完整恢复备份'],['validationPath','已验证副本'],['recoveryPath','恢复演练目录'],['authorizationPlanPath','审核方案'],['resultPath','执行结果报告'],['journalPath','逐步执行日志']])line(label,value[key]);
 if(value.selectedItems)line('执行范围',`${value.selectedItems.length} 项，保持已验证的冻结决策`);
 if(value.authorizationHash&&value.status==='awaiting-review'){
  line('本批证据','完整备份已校验；副本所选项目全部验证成功；独立恢复演练通过；原库基线一致');
  line('副本验证日志',value.validationJournalPath);line('恢复演练报告',value.recoveryReportPath);
 }
 if(value.items){const table=document.createElement('table'),thead=document.createElement('thead'),head=document.createElement('tr');for(const name of ['原位置','最终位置','状态']){const th=document.createElement('th');th.textContent=name;head.append(th);}thead.append(head);table.append(thead);const body=document.createElement('tbody');for(const item of value.items){const row=document.createElement('tr');for(const text of [item.from,item.to,states[item.status]??item.status]){const td=document.createElement('td');td.textContent=text;row.append(td);}body.append(row);}table.append(body);host.append(table);}
 if(value.links){line('引用修复',`${value.links.repairs?.length??0} 项；与验证副本保持相同决策`);for(const repair of value.links.repairs??[])line(`引用变化（${repair.path}）`,`${repair.before} → ${repair.after}`);}
 if(value.indexes)line('原有索引',value.indexes.status==='absent'?'没有索引':`${value.indexes.tables?.length??0} 张表，保留已有向量`);
 if(value.modelAttempts)line('模型调用尝试',value.modelAttempts.length);
 if(value.afterProof)line('执行后重扫变更任务',value.afterProof.result.changedTasks.length);
 if(value.indexProof)line('执行后索引验证',value.indexProof.status==='verified'?'已重新连接检索，原有向量保持一致':'无索引变更');
 if(value.error)line('停止原因',value.error.message);
 if(value.journalPath){const link=document.createElement('a');link.href='/recovery';link.textContent='使用上述逐步执行日志检查并恢复现场';host.append(link);}
 const button=document.createElement('button');button.type='button';button.textContent='下载完整审核与验证数据';button.onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='original-execution.json';link.click();URL.revokeObjectURL(url);};host.append(button);
}
async function call(action,input){const {token}=await(await fetch('/api/session')).json();const response=await fetch(`/api/original/${action}`,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)});const result=await response.json();if(!response.ok)throw new Error(result.error);return result;}
async function run(action){if(busy)return;busy=true;document.querySelectorAll('button').forEach(button=>button.disabled=true);$('#status').textContent='正在核验磁盘证据，请等待…';try{await action();}catch(error){$('#status').textContent=error.message;}finally{busy=false;document.querySelectorAll('button').forEach(button=>button.disabled=false);}}
$('#prepare').addEventListener('input',()=>{plan=null;$('#review').hidden=true;$('#approved').checked=false;$('#output').replaceChildren();});
$('#prepare').onsubmit=event=>{event.preventDefault();run(async()=>{plan=await call('prepare',{...Object.fromEntries(new FormData(event.target)),writersPaused:event.target.elements.writersPaused.checked});render('#details',plan);$('#review').hidden=false;$('#approved').checked=false;$('#result-path').value=`${plan.authorizationPlanPath}.result.json`;$('#status').textContent='证据核验通过。请审核目录和选中项目。';});};
$('#execute').onclick=()=>run(async()=>{if(!plan||!$('#approved').checked||!$('#prepare').elements.writersPaused.checked)throw new Error('请先生成并审核原库方案，确认全部写入已暂停');const authorizationPlanPath=plan.authorizationPlanPath;plan=null;$('#review').hidden=true;$('#status').textContent='正在执行原库冻结方案并验证关联与重扫结果…';const result=await call('execute',{authorizationPlanPath,approved:true,writersPaused:true});render('#output',result);$('#result-path').value=result.resultPath;$('#status').textContent=states[result.status]??result.status;});
$('#query').onclick=()=>run(async()=>{render('#output',await call('get',{resultPath:$('#result-path').value}));$('#status').textContent='已读取持久化结果。';});
