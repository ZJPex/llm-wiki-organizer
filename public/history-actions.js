import {element,requestBatch} from './batch-ui.js';
export async function submitHistoryPlan({batch,items,writersPaused}){
 if(writersPaused!==true)throw new Error('请先确认已暂停 Wiki、Obsidian 和同步程序等外部写入');
 if(!Array.isArray(items)||!items.length)throw new Error('请明确选择本次完整整理范围');
 const saved=await requestBatch('confirmPlans',{batchId:batch.batchId,revision:batch.revision,items,treeRevision:batch.flow?.tree?.revision,replaceSelection:true});
 return requestBatch('startHistoryValidation',{batchId:saved.batchId,revision:saved.revision,planHash:saved.historyPlan.planHash,writersPaused});
}
export function renderHistoryActions(host,{batch,writersPaused,run,refresh}){
 host.replaceChildren();const history=batch.historyValidation;if(!history)return;
 const stages={frozen:'方案范围已固定',freezing:'核验完整范围',backup:'创建完整备份与验证副本','migration-plan':'冻结迁移清单',validation:'验证完整迁移','recovery-plan':'准备独立恢复演练','recovery-drill':'演练恢复','checking-evidence':'核验完整证据链','awaiting-apply':'全部安全验证通过，等待最终确认应用原库'};
 host.append(element('p',`历史安全验证：${stages[history.stage]??history.stage} · 共 ${history.selectedCount} 份 · 第 ${history.attemptCount} 次验证`));
 if(history.status==='running')host.append(element('p','服务正在后台运行；关闭页面后继续，本地服务退出则停止。'));
 if(history.status==='interrupted')host.append(element('p','服务上次退出。重新确认外部写入已暂停后继续核验已有证据。'));
 if(history.error)host.append(element('p','停止原因：'+history.error.message));
 if(history.status==='awaiting-apply')host.append(element('p','原库尚未修改。最终应用将绑定当前整份方案及验证证据。'));
 const reports=element('details');reports.append(element('summary','验证报告与恢复入口'));for(const [label,value] of [['备份报告',history.backupReportPath],['迁移清单',history.planManifestPath],['验证日志',history.validationJournalPath],['恢复报告',history.recoveryReportPath]])if(value)reports.append(element('p',label+'：'+value));const recovery=element('a','打开恢复与报告');recovery.href='/recovery';reports.append(recovery);host.append(reports);
 for(const action of history.allowedActions??[]){const button=element('button','继续安全验证');button.disabled=writersPaused!==true;button.onclick=()=>run(async()=>{await requestBatch(action,{batchId:batch.batchId,revision:batch.revision,planHash:batch.historyPlan.planHash,writersPaused});await refresh();});host.append(button);}
}
