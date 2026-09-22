import {element,requestBatch,statusName} from './batch-ui.js';
import {reportStatus,reportSummary} from './report-ui.js';
const $=s=>document.querySelector(s),batchId=new URLSearchParams(location.search).get('batchId');
let report,batch,busy=false,cursor=0,evidenceCursor=0;
const link=(label,url)=>{const a=element('a',label);a.href=url;return a;};
const button=(label,action)=>{const b=element('button',label);b.onclick=()=>run(action);return b;};
async function run(action){if(busy)return;busy=true;$('#error').textContent='';try{await action();}catch(e){$('#error').textContent=e.message;}finally{busy=false;}}
async function load(){
 batch=await requestBatch('get',{batchId});report=await requestBatch('getReport',{batchId,cursor,evidenceCursor});
 $('#summary').textContent=reportStatus(report.status)+' · '+reportSummary(report)+' · '+report.libraryPath;
 $('#actions').replaceChildren(button('查询持久化结果',load),link('返回任务工作台','/?batchId='+encodeURIComponent(batchId)));
 if(batch.historyValidation?.allowedActions?.includes('continueHistoryValidation')&&!['needs-recovery','running'].includes(report.status)&&!batch.historyApplication)$('#actions').append(link('重新验证或继续安全验证','/?batchId='+encodeURIComponent(batchId)));
 if(report.error)$('#actions').append(element('p',report.error.message));
 const table=element('table'),head=element('tr');for(const name of ['材料','原位置','当前去向 / 计划目标','结果','原因'])head.append(element('th',name));table.append(head);
 for(const item of report.items){const row=element('tr');for(const text of [item.identity,item.from,item.to,({succeeded:'成功',retained:'保留',blocked:'阻断',failed:'失败',unverified:'未验证',pending:'待处理'})[item.status],item.reason??''])row.append(element('td',text));table.append(row);}
 $('#items').replaceChildren(report.items.length?table:element('p','尚无材料记录。'));
 $('#pager').replaceChildren();if(cursor)$('#pager').append(button('上一页材料',async()=>{cursor=Math.max(0,cursor-50);await load();}));if(report.nextCursor!==null)$('#pager').append(button('下一页材料',async()=>{cursor=report.nextCursor;await load();}));
 $('#evidence').replaceChildren();if(!report.evidence.length)$('#evidence').append(element('p','尚无执行证据；文件未执行整理。'));
 for(const evidence of report.evidence){const section=element('section');section.append(element('h3','执行记录 '+evidence.sliceId+' · '+statusName(evidence.status)));
  for(const [key,label] of [['artifactDirectory','现场目录'],['backupReportPath','完整备份报告'],['originalResultPath','原库执行报告'],['originalJournalPath','原库迁移日志'],['validationJournalPath','副本验证日志'],['archiveJournalPath','新增归档日志'],['recoveryPlanPath','恢复计划'],['recoveryReportPath','恢复报告']])if(evidence[key])section.append(element('p',label+'：'+evidence[key]));
  if(evidence.error)section.append(element('p',evidence.error.message));
  if(evidence.allowedActions.includes('inspectRecovery'))section.append(link(evidence.originalJournalPath?'检查原库现场与恢复':'检查验证副本与恢复','/recovery?batchId='+encodeURIComponent(batchId)+'&sliceId='+encodeURIComponent(evidence.sliceId)));
  if(evidence.allowedActions.includes('applySlice')){const paused=element('input');paused.type='checkbox';const approved=element('input');approved.type='checkbox';const p=element('label','外部写入已暂停'),a=element('label','已核对来源、目标和归档日志，继续同一份归档');p.prepend(paused);a.prepend(approved);section.append(p,a,button('继续已有归档',async()=>{if(!paused.checked||!approved.checked)throw new Error('请确认外部写入暂停并核对归档现场');await requestBatch('applySlice',{batchId,revision:batch.revision,sliceId:evidence.sliceId,writersPaused:true,approved:true});await load();}));}
  else if(evidence.archiveJournalPath&&evidence.status==='failed')section.append(element('p','归档现场存在不确定写入，请检查日志与两侧文件；不能自动重新归档，也不能将此日志用于整库恢复。'));
  $('#evidence').append(section);
 }
 $('#evidence-pager').replaceChildren();if(evidenceCursor)$('#evidence-pager').append(button('上一页证据',async()=>{evidenceCursor=Math.max(0,evidenceCursor-50);await load();}));if(report.evidenceNextCursor!==null)$('#evidence-pager').append(button('下一页证据',async()=>{evidenceCursor=report.evidenceNextCursor;await load();}));
}
run(async()=>{if(!batchId)throw new Error('请从任务记录打开报告');await load();});
