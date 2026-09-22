const $=selector=>document.querySelector(selector);
let plan,busy=false;
const phases={planned:'方案已保存','verified-copy':'迁移副本已验证','scene-copy':'保留当前现场','restore-copy':'复制完整备份','restore-bind':'重定位恢复副本','restore-verify':'验证恢复副本',park:'保留原位置现场',install:'放回原位置','final-bind':'核对最终位置身份','final-verify':'验证最终恢复结果',complete:'全部验证完成',write:'更新文件',stage:'保存中转副本',unlink:'移除旧位置占位',copy:'写入新位置',indexes:'维护索引',snapshot:'维护快照'};
function render(selector,value){
 const host=$(selector);host.replaceChildren();
 const line=(label,text)=>{if(text===undefined)return;const p=document.createElement('p');p.textContent=`${label}：${text}`;host.append(p);};
 line('状态',({complete:'恢复完成',failed:'恢复停止，现场已保留',running:'恢复中','awaiting-review':'等待审核',inspectable:'现场可检查'})[value.status]??value.status);
 line('当前阶段',phases[value.phase]??value.phase);
 line('恢复方式',value.mode?value.mode==='new-directory'?'全新独立目录':'保留现场后恢复原位置':undefined);
 line('当前现场',value.targetRoot);line('恢复目标',value.destination);line('现场保留位置',value.scenePath);line('恢复备份',value.backupPath);
 line('来源迁移日志',value.sourceJournalPath);line('恢复计划',value.recoveryPlanPath);line('结果报告',value.reportPath);
 if(value.changes)line('变化比较范围','与迁移前基线比较，包含本次迁移的改动');
 for(const [key,label] of [['added','新增文件'],['modified','内容有变化的文件'],['missing','当前缺失的文件']]){
  const files=value.changes?.[key];if(!files)continue;line(label,`${files.length} 项`);
  if(files.length){const list=document.createElement('ul'),metadata=document.createElement('ul');for(const file of files){const li=document.createElement('li');li.textContent=file;(file.startsWith('.llm-wiki/')?metadata:list).append(li);}if(list.children.length)host.append(list);if(metadata.children.length){const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=`另有 ${metadata.children.length} 项缓存或索引状态文件`;details.append(summary,metadata);host.append(details);}}
 }
 if(value.completed)line('已完成步骤',value.completed.map(step=>typeof step==='string'?(phases[step]??step):`${phases[step.type]??step.type}${step.path?`（${step.path}）`:''}`).join('、')||'尚无');
 if(value.modelAttempts)line('模型调用尝试',value.modelAttempts.length);
 if(value.verification){line('已核验来源',value.verification.sources);line('恢复后重扫变更任务',value.verification.proof.result.changedTasks.length);line('索引验证',value.verification.indexes.status==='absent'?'没有索引':'原有向量与检索关联已核验');}
 if(value.backupUnchanged!==undefined)line('恢复备份',value.backupUnchanged?'内容保持原样':'需要核查');
 if(value.error)line('停止原因',value.error.message);
 const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='查看完整验证数据';pre.textContent=JSON.stringify(value,null,2);details.append(summary,pre);host.append(details);
}
const show=value=>render('#output',value);
async function call(action,input){const {token}=await(await fetch('/api/session')).json();const response=await fetch(`/api/recovery/${action}`,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)});const result=await response.json();if(!response.ok)throw new Error(result.error);return result;}
async function run(action){if(busy)return;busy=true;const buttons=[...document.querySelectorAll('button')];buttons.forEach(button=>button.disabled=true);$('#status').textContent='正在检查磁盘证据，请等待…';try{await action();}catch(error){$('#status').textContent=error.message;}finally{busy=false;buttons.forEach(button=>button.disabled=false);}}
function review(value){plan=value;$('#review').hidden=false;$('#approved').checked=false;$('#recovery-path').value=value.recoveryPlanPath;render('#details',value);$('#status').textContent='请核对方案；原位置恢复会将当前目录完整移到现场保留位置。';}
$('#plan').addEventListener('input',event=>{if(event.target.name!=='writersPaused'){plan=null;$('#review').hidden=true;}});
$('#inspect').onclick=()=>run(async()=>{show(await call('inspect',{journalPath:$('#plan').elements.journalPath.value}));$('#status').textContent='现场检查完成。';});
$('#plan').onsubmit=event=>{event.preventDefault();run(async()=>{const form=Object.fromEntries(new FormData(event.target));if(!form.scenePath)delete form.scenePath;review(await call('plan',{...form,writersPaused:$('#plan').elements.writersPaused.checked}));});};
$('#execute').onclick=()=>run(async()=>{if(!$('#approved').checked||!$('#plan').elements.writersPaused.checked)throw new Error('请先审核恢复方案并确认外部写入已暂停');const result=await call('execute',{recoveryPlanPath:plan.recoveryPlanPath,approved:true,writersPaused:true});show(result);$('#status').textContent=result.status==='complete'?'恢复完成，现场和备份均已核验。':`恢复已停止：${result.error?.message??result.phase}。保留的磁盘证据可用于继续恢复。`;});
$('#query').onclick=()=>run(async()=>{show(await call('get',{recoveryPlanPath:$('#recovery-path').value}));$('#status').textContent='已读取磁盘结果。';});
$('#resume').onclick=()=>run(async()=>review(await call('get',{recoveryPlanPath:$('#recovery-path').value})));
// 从持久任务定位日志，仅预填并查询；仍由用户确认恢复方式及写入条件。
const params=new URLSearchParams(location.search);
if(params.has('batchId')&&params.has('sliceId'))run(async()=>{
 const {requestBatch}=await import('./batch-ui.js');let cursor=0,entry;
 do{const report=await requestBatch('getReport',{batchId:params.get('batchId'),evidenceCursor:cursor});entry=report.evidence.find(item=>item.sliceId===params.get('sliceId'));cursor=report.evidenceNextCursor;}while(!entry&&cursor!==null);
 if(!entry?.journalPath)throw new Error('该执行记录没有可供整库恢复的迁移日志，请返回任务报告检查归档现场');
 $('#plan').elements.journalPath.value=entry.journalPath;
 // 副本演练计划不能用于恢复原库；原库现场必须重新生成绑定原库的方案。
 if(!entry.originalJournalPath&&entry.recoveryPlanPath)$('#recovery-path').value=entry.recoveryPlanPath;
 const back=document.createElement('a');back.href='/task-report?batchId='+encodeURIComponent(params.get('batchId'));back.textContent='返回关联任务报告';document.querySelector('main').prepend(back);
 show(await call('inspect',{journalPath:entry.journalPath}));$('#status').textContent='已从任务记录定位现场。尚未执行恢复，请核对恢复位置和保留内容。';
});
