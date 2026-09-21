import {element,requestBatch} from './batch-ui.js';
export async function submitHistoryPlan({batch,items,writersPaused}){
 if(writersPaused!==true)throw new Error('请先确认已暂停 Wiki、Obsidian 和同步程序等外部写入');
 if(!Array.isArray(items)||!items.length)throw new Error('请明确选择本次完整整理范围');
 const saved=await requestBatch('confirmPlans',{batchId:batch.batchId,revision:batch.revision,items,replaceSelection:true});
 return requestBatch('startHistoryValidation',{batchId:saved.batchId,revision:saved.revision,planHash:saved.historyPlan.planHash,writersPaused});
}
export function renderHistoryActions(host,{batch,writersPaused,run,refresh}){
 host.replaceChildren();const history=batch.historyValidation;if(!history)return;
 const stages={frozen:'方案范围已固定',freezing:'核验完整范围',backup:'创建完整备份与验证副本','migration-plan':'冻结迁移清单',validation:'验证完整迁移','recovery-plan':'准备独立恢复演练','recovery-drill':'演练恢复','checking-evidence':'核验完整证据链','awaiting-apply':'全部安全验证通过，等待最终确认应用原库'};
 host.append(element('p',`历史安全验证：${stages[history.stage]??history.stage} · 共 ${history.selectedCount} 份 · 第 ${history.attemptCount} 次验证`));
 if(history.status==='running')host.append(element('p','服务正在后台运行；关闭页面后继续，本地服务退出则停止。'));
 if(history.status==='interrupted')host.append(element('p','服务上次退出。重新确认外部写入已暂停后继续核验已有证据。'));
 if(history.error)host.append(element('p','停止原因：'+history.error.message));
 const application=batch.historyApplication;
 if(history.status==='awaiting-apply'&&(!application||application.planHash!==history.planHash||application.evidenceDigest!==history.evidenceDigest)){
  host.append(element('h2','最终应用摘要'),element('p',`整份已验证方案共 ${history.selectedCount} 份：历史 ${batch.historyPlan.historicalCount} 份，新增 ${batch.historyPlan.newCount} 份。历史完成后归档新增；内部执行分批不再要求确认。`));
  const scope=element('details');scope.append(element('summary','查看最终位置与纳入范围'));const list=element('div');scope.append(list);host.append(scope);
  const draw=plan=>{list.replaceChildren();for(const item of plan.items)list.append(element('p',item.from+' → '+item.to));if(plan.nextCursor!==null){const more=element('button','继续查看完整范围');more.onclick=()=>run(async()=>draw((await requestBatch('get',{batchId:batch.batchId,cursor:plan.nextCursor,limit:50})).historyPlan));list.append(more);}};draw(batch.historyPlan);
  const apply=element('button','确认应用整份已验证方案');apply.className='primary';apply.disabled=writersPaused!==true;apply.onclick=()=>run(async()=>{await requestBatch('applyHistoryPlan',{batchId:batch.batchId,revision:batch.revision,planHash:history.planHash,evidenceDigest:history.evidenceDigest,writersPaused,approved:true});await refresh();});host.append(apply);
 }
 if(application){
  const labels={running:'正在后台应用',complete:'整理完成','needs-recovery':'现场需要查询或恢复',failed:'应用尚未完成',interrupted:'上次应用中断，等待查询'};
  host.append(element('h2',labels[application.status]??application.status));
  host.append(element('p',`执行范围 ${application.selectedCount} 份；执行阶段 ${application.phase}`));
  for(const group of application.groups??[])host.append(element('p',`${group.groupId}：${({pending:'等待',staged:'已暂存',placed:'已放置，待整体验证',verified:'整体验证通过','stage-running':'正在暂存','place-running':'正在放置'})[group.status]??group.status}`));
  if(application.error)host.append(element('p',application.error.message));
  const labelsResult={succeeded:'成功',retained:'保留','dependency-blocked':'依赖阻断',unverified:'未验证'};
  for(const status of Object.keys(labelsResult)){const items=(application.results??[]).filter(item=>item.status===status);if(items.length)host.append(element('p',labelsResult[status]+'：'+items.length+' 份'));}
  if(application.journalPath)host.append(element('p','原库执行日志：'+application.journalPath));
  if(['interrupted','failed'].includes(application.status)){const retry=element('button','查询日志并继续合法步骤');retry.disabled=writersPaused!==true;retry.onclick=()=>run(async()=>{await requestBatch('applyHistoryPlan',{batchId:batch.batchId,revision:batch.revision,planHash:application.planHash,evidenceDigest:application.evidenceDigest,writersPaused,approved:true});await refresh();});host.append(retry);}
 }

 const reports=element('details');reports.append(element('summary','验证报告与恢复入口'));for(const [label,value] of [['备份报告',history.backupReportPath],['迁移清单',history.planManifestPath],['验证日志',history.validationJournalPath],['恢复报告',history.recoveryReportPath]])if(value)reports.append(element('p',label+'：'+value));const recovery=element('a','打开恢复与报告');recovery.href='/recovery';reports.append(recovery);host.append(reports);
 for(const action of history.allowedActions??[]){const button=element('button','继续安全验证');button.disabled=writersPaused!==true;button.onclick=()=>run(async()=>{await requestBatch(action,{batchId:batch.batchId,revision:batch.revision,planHash:batch.historyPlan.planHash,writersPaused});await refresh();});host.append(button);}
}
