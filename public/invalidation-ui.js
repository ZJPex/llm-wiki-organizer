import {element,requestBatch} from './batch-ui.js';
export function renderInvalidations(host,{batch,run,refresh}){
 host.replaceChildren();const record=batch.invalidations;
 const check=element('button','检查材料与审核依赖变化');
 const unsafe=batch.report?.status==='needs-recovery'||!!batch.historyApplication&&!['complete','failed'].includes(batch.historyApplication.status);
 check.disabled=unsafe||batch.busy===true||['running','pausing'].includes(batch.analysisJob?.status)||batch.historyValidation?.status==='running'||!!batch.historyApplication&&!['complete','failed'].includes(batch.historyApplication.status);
 check.onclick=()=>run(async()=>{await requestBatch('refreshReview',{batchId:batch.batchId,revision:batch.revision});await refresh();});host.append(check);if(unsafe)host.append(element('p','已有执行现场尚未核实，请先查看任务报告并查询或恢复，不能撤销审核重新移动。'));
 if(!record)return;
 host.append(element('p',`本次检查影响 ${record.affectedSourceIds.length} 份，保留 ${record.retainedReviewCount} 份有效审核、${record.analysisRetainedCount} 份正文分析。`));
 if(record.sharedValidationStale)host.append(element('p','整份备份与验证证据已失效，重新审核后需要重新验证。'));
 const list=element('ul');for(const reason of record.reasons)list.append(element('li',`${reason.message}（${reason.sourceIds.length} 份；${reason.code}）`));host.append(list);
 if(record.nextCursor!==null){const more=element('button','查看更多失效原因');more.onclick=()=>run(async()=>{const next=await requestBatch('get',{batchId:batch.batchId,cursor:record.nextCursor,limit:25});renderInvalidations(host,{batch:{...batch,invalidations:next.invalidations},run,refresh});});host.append(more);}
}
