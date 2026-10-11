import {modelConcurrencyControls} from './model-concurrency-ui.js';
import {classifyAll} from './classify-all.js';
import {backgroundAnalysis} from './background-analysis.js';
import {withTreeProgress} from './tree-progress.js';
import {requestBatch as api,statusName,renderDetailPager} from './batch-ui.js';
const $=selector=>document.querySelector(selector);
let batch=null,slice=null,cursor=0,busy=false,pagination={},classifying=false,classifyPaused=false;
const analyzeButton=document.querySelector('#analyze');
analyzeButton.textContent='一键分析全部';
const pauseButton=document.createElement('button');pauseButton.textContent='暂停分析';pauseButton.hidden=true;analyzeButton.after(pauseButton);
const analysisMessage=document.createElement('p');analysisMessage.setAttribute('role','status');pauseButton.after(analysisMessage);
const modelProgress=document.createElement('div');analysisMessage.after(modelProgress);const modelControls=modelConcurrencyControls(modelProgress);
const analysis=backgroundAnalysis({getBatch:()=>batch,request:api,update:value=>{batch=value;render();},onError:error=>{$('#error').textContent=error.message;}});
pauseButton.onclick=()=>analysis.pause().catch(error=>{$('#error').textContent=error.message;});
async function analyzeRequest(action,input){
 return withTreeProgress({operation:()=>api(action,input),read:()=>api('get',{batchId:input.batchId,cursor,limit:50}),update:value=>{batch=value;render();}});
}
const classifyButton=document.createElement('button');classifyButton.textContent='一键推荐全部分类';classifyButton.disabled=true;analysisMessage.after(classifyButton);
const pauseClassify=document.createElement('button');pauseClassify.textContent='暂停分类推荐';pauseClassify.hidden=true;classifyButton.after(pauseClassify);
const classifyMessage=document.createElement('p');classifyMessage.setAttribute('role','status');pauseClassify.after(classifyMessage);
const confirmCategoriesButton=document.createElement('button');confirmCategoriesButton.textContent='一键确认全部推荐分类';confirmCategoriesButton.disabled=true;classifyMessage.after(confirmCategoriesButton);
const confirmationMessage=document.createElement('p');confirmationMessage.setAttribute('role','status');confirmCategoriesButton.after(confirmationMessage);
confirmCategoriesButton.onclick=()=>run(async()=>{
 $('#approved').checked=false;slice=null;
 const value=await analyzeRequest('confirmRecommendedCategories',{batchId:batch.batchId,revision:batch.revision});
 batch=value;render();
});
pauseClassify.onclick=()=>{classifyPaused=true;pauseClassify.disabled=true;classifyMessage.textContent='当前文件推荐完成后暂停。';};
classifyButton.onclick=()=>run(async()=>{
 classifying=true;classifyPaused=false;classifyMessage.textContent='连续推荐所有已确认名称的材料，请保持页面打开。';render();
 try{const result=await classifyAll({getBatch:()=>batch,request:(action,input)=>action==='get'?api(action,input):analyzeRequest(action,input),update:value=>{batch=value;render();},stopped:()=>classifyPaused});classifyMessage.textContent=result==='complete'?'分类推荐完成，请逐项审核分类与最终路径；未确认名称的材料请先确认名称。':'已暂停，再点一键推荐全部分类可继续。';}
 catch(error){classifyMessage.textContent='分类推荐已停止，已完成结果保留；解决错误后再次点击即可继续。';throw error;}
 finally{classifying=false;pauseClassify.hidden=true;}
});
const p=(host,text)=>{const node=document.createElement('p');node.textContent=text;host.append(node);};
function button(host,label,handler){const node=document.createElement('button');node.textContent=label;node.disabled=busy;node.addEventListener('click',()=>run(handler));host.append(node);return node;}
async function refresh(){if(!batch)return;const value=await api('get',{batchId:batch.batchId,cursor,limit:50,...pagination});batch=value.batch??value;render();}
async function run(action){if(busy)return;busy=true;$('#error').textContent='';document.querySelectorAll('button').forEach(button=>button.disabled=true);try{await action();}catch(error){$('#error').textContent=error.message;}finally{busy=false;if(batch)await refresh().catch(error=>{$('#error').textContent=error.message;render();});else document.querySelectorAll('form button').forEach(button=>button.disabled=false);}}
async function review(source,action,patch={}){await api('reviewItem',{batchId:batch.batchId,revision:batch.revision,sourceId:source.sourceId,action,...patch});$('#approved').checked=false;slice=null;}
function render(){
 modelControls.update(batch);
 $('#progress').replaceChildren();p($('#progress'),`批次 ${batch.batchId} · 修订 ${batch.revision} · ${statusName(batch.status??batch.phase)}`);if(batch.counts)p($('#progress'),Object.entries(batch.counts).map(([key,value])=>`${statusName(key)} ${value}`).join('，'));if(batch.error??batch.lastError)p($('#progress'),`最近错误：${(batch.error??batch.lastError).message}`);
 const progress=batch.analysisProgress,current=batch.flow?.analysisCurrent;
 if(progress)p($('#progress'),`已处理 ${progress.total-progress.remaining} / ${progress.total} 份；待人工判断 ${batch.counts?.['needs-information']??0} 份；失败 ${progress.failed} 份。`);
 if(current?.status==='running'){
  const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(current.startedAt))/1000));
  p($('#progress'),`${batch.interrupted?'已中断，可继续分析':'正在分析'}：${current.identity}；${current.stage==='segment'?'正文分段':current.stage==='synthesis'?`汇总第 ${current.round} 轮`:'检查来源'}${current.step?` ${current.step}/${current.totalSteps}`:''}；本文件已耗时 ${Math.floor(seconds/60)} 分 ${seconds%60} 秒。`);
 }
 analysis.render(analyzeButton,pauseButton,analysisMessage);
 const cp=batch.classificationProgress,cc=batch.flow?.classificationCurrent;
 if(cp)p($('#progress'),`分类推荐：已完成 ${cp.completed} / ${cp.total} 份，剩余 ${cp.remaining} 份，失败 ${cp.failed} 份，未纳入 ${cp.skipped} 份（未确认名称、需补充信息或已排除）。`);
 if(cc?.status==='running'){
  const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(cc.startedAt))/1000));
  p($('#progress'),`${batch.interrupted?'分类已中断，可继续':'正在推荐分类'}：${cc.identity}；${cc.stage==='search'?`检索候选分类 ${cc.step}/${cc.totalSteps}`:cc.stage==='choice'?'选择主分类':'检查来源'}；已耗时 ${Math.floor(seconds/60)} 分 ${seconds%60} 秒。`);
 }
 classifyButton.disabled=busy||!cp?.remaining;pauseClassify.hidden=!classifying;pauseClassify.disabled=!classifying||classifyPaused;
 confirmCategoriesButton.disabled=busy||!batch.confirmableCategoryCount;
 const confirmation=batch.flow?.categoryConfirmation;
 confirmationMessage.textContent=batch.flow?.evolutionPlan?'本批包含目录演化，请逐项审核演化后的分类与路径。':`可一键确认 ${batch.confirmableCategoryCount??0} 份。使用系统已保存的推荐分类；手动改过的分类请逐项审核。这里只保存审核结果，不会移动文件。`;
 if(confirmation)confirmationMessage.textContent+=` ${confirmation.status==='running'?(batch.interrupted?'确认已中断':'正在确认'):confirmation.status==='failed'?'确认已停止':'本次确认完成'}：已处理 ${confirmation.completed} / ${confirmation.total} 份，已确认 ${confirmation.confirmed} 份，失败 ${confirmation.failed} 份，跳过 ${confirmation.skipped} 份。${confirmation.status==='failed'?'已成功的结果保留；解决错误后再次点击可继续。':''}`;
 const host=$('#sources');host.replaceChildren();for(const source of batch.sources??[]){const card=document.createElement('article');host.append(card);const title=document.createElement('h2');title.textContent=source.currentIdentity??source.identity;card.append(title);p(card,`${statusName(source.ingestStatus)} · ${statusName(source.status)}`);if(source.analysis){p(card,source.analysis.summary);for(const evidence of source.analysis.evidence??[])p(card,`依据：${evidence}`);}if(source.classificationError)p(card,`分类失败：${source.classificationError}`);if(source.skipReason||source.warning)p(card,source.skipReason??source.warning);if(source.targetPath)p(card,`最终路径：${source.targetPath}`);
 const name=document.createElement('input');name.value=source.confirmedName??source.suggestion??'';name.setAttribute('aria-label','确认文件名');name.disabled=Boolean(source.confirmedName);card.append(name);button(card,source.confirmedName?'保留已确认名字':'确认名字',()=>review(source,'confirmName',{name:name.value}));button(card,'检索已有分类',()=>review(source,'classify'));
 if(source.classification){p(card,`分类理由：${source.classification.reason??'请核对现有分类'}`);const category=document.createElement('select');category.setAttribute('aria-label','最终分类');const options=new Set([...(source.classification.options??[]),...(batch.flow?.evolutionPlan?.newDirectories??[]),...(batch.flow?.evolutionPlan?.directoryMappings??[]).map(item=>item.to)]);for(const value of options){const option=document.createElement('option');option.value=value;option.textContent=value||'Raw 根目录';option.selected=value===source.classification.category;category.append(option);}if(source.classification.category===null){category.selectedIndex=-1;p(card,'没有可靠的现有分类，请手动选择或评估必要的局部演化。');}card.append(category);button(card,'审核此分类与路径',()=>{if(category.selectedIndex<0)throw new Error('请先明确选择一个分类');return review(source,'confirmCategory',{category:category.value});});button(card,'评估必要的局部演化',()=>review(source,'evolve',{category:category.value}));}
 if(source.evolution){p(card,`目录演化：${source.evolution.reason??'只调整已检查的必要范围'}`);for(const op of source.evolution.operations??[])p(card,`${op.type}：${op.from??op.parent??'根目录'} → ${op.to??op.label??''}；${op.problem}；${op.benefit}`);button(card,'审核以上目录演化',()=>review(source,'confirmEvolution'));}
 if(source.categoryConfirmationError)p(card,`分类确认失败：${source.categoryConfirmationError}`);
 if(source.status==='needs-information')button(card,'重新分析主题',()=>analyzeRequest('analyzeNext',{batchId:batch.batchId,revision:batch.revision,sourceId:source.sourceId,retryUncertain:true,limit:1,stopOnFailure:true}));
 button(card,'排除本材料',()=>review(source,'exclude'));
 if(source.status==='succeeded')card.querySelectorAll('button,input,select').forEach(control=>control.disabled=true);
 }
 slice=batch.slices?.at(-1)??slice;const detail=$('#slice');detail.replaceChildren();if(slice){p(detail,`执行片段 ${slice.sliceId} · ${statusName(slice.status)}`);for(const item of slice.newFiles??slice.preview?.newFiles??[])p(detail,`新增：${item.from} → ${item.to}`);for(const item of slice.preview?.items??slice.historicalRequest?.mappings??[])p(detail,`历史：${item.from} → ${item.to}（${statusName(item.status)??'待审核'}）`);for(const key of ['backupReportPath','validationJournalPath','recoveryReportPath','authorizationPlanPath','originalResultPath','originalJournalPath'])if(slice[key])p(detail,`${key}：${slice[key]}`);if(slice.watchConfig)p(detail,slice.watchConfig.message);for(const result of [slice.historicalResult,slice.archiveResult]){if(result){p(detail,`阶段结果：${statusName(result.status)}`);if(result.archiveJournalPath)p(detail,`归档日志：${result.archiveJournalPath}`);for(const item of result.items??[])p(detail,`${item.from} → ${item.to}：${statusName(item.status)}`);if(result.error)p(detail,result.error.message);}}}
 renderDetailPager(detail,batch,patch=>run(async()=>{pagination=patch;}));
 document.querySelectorAll('form button').forEach(button=>button.disabled=busy);for(const id of ['prepare'])$(`#${id}`).disabled=busy;$('#next').disabled=busy||!(batch.nextCursor??((batch.sources?.length??0)===50));for(const id of ['validate','original','apply'])$(`#${id}`).disabled=busy||!slice;
 $('#validate').textContent=slice?.planManifestPath?'验证副本并演练恢复':'校验新增归档条件';$('#original').textContent=slice?.planManifestPath?'准备正式原库执行审核':'准备新增归档审核';$('#apply').textContent=slice?.status==='complete'?'读取已完成结果':slice?.planManifestPath?'执行历史迁移与新增归档':'执行新增归档';
}
$('#create').addEventListener('submit',event=>{event.preventDefault();run(async()=>{const input=Object.fromEntries(new FormData(event.target));const value=await api('create',{mode:'inbox',...input});batch=value.batch??value;cursor=0;pagination={};slice=null;$('#resume input').value=batch.batchId;});});
$('#resume').addEventListener('submit',event=>{event.preventDefault();run(async()=>{batch={batchId:new FormData(event.target).get('batchId')};cursor=0;pagination={};slice=null;});});
$('#analyze').onclick=()=>run(()=>analysis.start());
$('#next').onclick=()=>run(async()=>{cursor=batch.nextCursor??cursor+50;pagination.cursor=cursor;});
for(const [id,action] of [['prepare','prepareSlice'],['validate','validateSlice'],['original','prepareOriginal'],['apply','applySlice']])$(`#${id}`).onclick=()=>run(async()=>{if(!$('#paused').checked)throw new Error('请先暂停全部外部写入');if(['validate','apply'].includes(id)&&!$('#approved').checked)throw new Error('请审核并确认所选范围');await api(action,{batchId:batch.batchId,revision:batch.revision,sliceId:slice?.sliceId,writersPaused:true,approved:$('#approved').checked});});

const initialBatchId=new URLSearchParams(globalThis.location?.search??'').get('batchId');
if(initialBatchId)run(async()=>{batch={batchId:initialBatchId};$('#resume input').value=initialBatchId;});
