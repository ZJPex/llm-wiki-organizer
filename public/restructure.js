import {loadReview,reviewReason,confirmReview} from './bulk-review.js';
import {treeProgressText,withTreeProgress} from './tree-progress.js';
import {analyzeAll} from './analyze-all.js';
import {element,requestBatch,renderBatchSummary,renderSlice,statusName,renderDetailPager} from './batch-ui.js';
const $=selector=>document.querySelector(selector);let batch,busy=false,analyzing=false,pauseRequested=false;
async function run(action){if(busy)return;busy=true;document.querySelectorAll('button').forEach(button=>button.disabled=true);$('#status').textContent='正在处理，请等待…';try{const message=await action();$('#status').textContent=message??'进度已保存，可按批次编号继续。';}catch(error){$('#status').textContent=error.message;if(batch){try{batch=await requestBatch('get',{batchId:batch.batchId});render();}catch{}}}finally{busy=false;document.querySelectorAll('button').forEach(button=>button.disabled=false);if(batch)render();}}
function render(){
 const progress=batch.analysisProgress;
 $('#analysis-progress').textContent=progress?`分析进度：已处理 ${progress.total-progress.remaining} / ${progress.total} 份，剩余 ${progress.remaining} 份，失败 ${progress.failed} 份。`:'';
 $('#pause-analysis').hidden=!analyzing;

 $('#work').hidden=false;$('#batch-id').value=batch.batchId;renderBatchSummary($('#summary'),batch);const tree=batch.flow.tree;$('#tree').replaceChildren();const treeProgress=treeProgressText(batch);if(treeProgress)$('#tree').append(element('p',treeProgress));
 if(tree){$('#tree').append(element('p',`${statusName(tree.status)}；已分析 ${tree.analyzedCount} 份，可靠归类 ${tree.classifiedCount} 份。`));for(const node of tree.nodes){const card=element('article');card.append(element('h3',node.category),element('p',node.reason),element('p',`代表材料：${node.representativeFiles?.map(item=>item.identity).join('、')}`));const edit=element('input');edit.value=node.segments.join(' / ');edit.setAttribute('aria-label','分类层级');const button=element('button','修改分类并重新审核');button.onclick=()=>run(()=>mutate('treeAction',{action:'edit',nodeId:node.nodeId,segments:edit.value.split('/').map(s=>s.trim())}));card.append(edit,button);$('#tree').append(card);}$('#tree-next').hidden=tree.nextCursor===null;}
 else $('#tree').append(element('p','全部材料分析完成后可生成分类树。'));
 $('#sources').replaceChildren();for(const source of batch.sources){const card=element('article');card.append(element('h3',source.currentIdentity),element('p',`${statusName(source.status)}；${source.ingestStatus==='historical'?'已有摄取记录':source.ingestStatus==='new'?'未摄取，保留并交 Inbox':'关联需核查'}`));if(source.analysis?.summary)card.append(element('p',source.analysis.summary));if(source.skipReason)card.append(element('p',source.skipReason));if(source.analysis?.evidence?.length){const details=element('details'),summary=element('summary','查看分析原文依据');details.append(summary,...source.analysis.evidence.map(text=>element('p',text)));card.append(details);}if(source.targetPath)card.append(element('p',`已审核目标：${source.targetPath}`));
  if(tree?.status==='approved'&&!['succeeded','skipped','blocked'].includes(source.status)){const name=element('input');name.value=source.confirmedName??source.analysis?.suggestion??source.currentIdentity.split('/').at(-1);name.setAttribute('aria-label','确认文件名');const category=element('select');if(source.proposedNodeId&&!tree?.nodes.some(node=>node.nodeId===source.proposedNodeId)){const option=element('option',source.proposedCategory);option.value=source.proposedNodeId;category.append(option);}for(const node of tree?.nodes??[]){const option=element('option',node.category);option.value=node.nodeId;option.selected=node.nodeId===source.proposedNodeId;category.append(option);}const confirm=element('button','审核此文件和目标路径');confirm.onclick=()=>run(()=>mutate('reviewItem',{sourceId:source.sourceId,action:'confirm',name:name.value,nodeId:category.value}));const skip=element('button','本次保留原处');skip.onclick=()=>run(()=>mutate('reviewItem',{sourceId:source.sourceId,action:'exclude'}));card.append(name,category,confirm,skip);}$('#sources').append(card);
 }
 $('#next-page').hidden=batch.nextCursor===null;const slice=batch.slices.at(-1);$('#slice').replaceChildren();if(slice)renderSlice($('#slice'),slice);renderDetailPager($('#slice'),batch,patch=>run(async()=>{batch=await requestBatch('get',{batchId:batch.batchId,...patch});render();}));$('#slice-approved').checked=false;$('#original-approved').checked=false;$('#tree-approved').checked=false;
 if(busy)document.querySelectorAll('button').forEach(button=>button.disabled=true);
 $('#pause-analysis').disabled=!analyzing||pauseRequested;
}
async function mutate(action,input={}){batch=await requestBatch(action,{batchId:batch.batchId,revision:batch.revision,...input});render();}
const slice=()=>{const value=batch?.slices.at(-1);if(!value)throw new Error('请先生成分批方案');return value.sliceId;};
const paused=()=>{if(!$('#paused').checked)throw new Error('请先暂停外部写入');return true;};
$('#create').onsubmit=event=>{event.preventDefault();run(async()=>{const input=Object.fromEntries(new FormData(event.target));input.sourceRoot=input.libraryPath.replace(/[\\/]$/,'')+'/raw/sources';batch=await requestBatch('create',{...input,mode:'restructure'});render();});};
$('#load').onclick=()=>run(async()=>{batch=await requestBatch('get',{batchId:$('#batch-id').value});render();});
$('#analyze').onclick=()=>run(async()=>{
 analyzing=true;pauseRequested=false;render();
 try{
  const outcome=await analyzeAll({getBatch:()=>batch,request:requestBatch,update:value=>{batch=value;render();},stopped:()=>pauseRequested});
  return outcome==='complete'?'全部材料分析结束，请生成全范围分类树。':'已暂停，进度已保存。点击“分析全部材料”继续。';
 }finally{analyzing=false;}
});
$('#pause-analysis').onclick=()=>{pauseRequested=true;$('#pause-analysis').disabled=true;$('#status').textContent='正在暂停：当前组完成后停止，已完成结果会保留。';};
$('#propose').onclick=()=>run(async()=>{const input={batchId:batch.batchId,revision:batch.revision,action:'propose'};const result=await withTreeProgress({operation:()=>requestBatch('treeAction',input),read:()=>requestBatch('get',{batchId:input.batchId}),update:value=>{batch=value;render();}});batch=result;render();});$('#approve-tree').onclick=()=>run(()=>{if(!$('#tree-approved').checked)throw new Error('请审核分类树并勾选确认');return mutate('treeAction',{action:'approve'});});
$('#tree-next').onclick=()=>run(async()=>{batch=await requestBatch('get',{batchId:batch.batchId,treeCursor:batch.flow.tree.nextCursor});render();});
$('#next-page').onclick=()=>run(async()=>{batch=await requestBatch('get',{batchId:batch.batchId,cursor:batch.nextCursor});render();});$('#first-page').onclick=()=>run(async()=>{batch=await requestBatch('get',{batchId:batch.batchId});render();});
$('#prepare').onclick=()=>run(()=>mutate('prepareSlice',{writersPaused:paused()}));$('#validate').onclick=()=>run(()=>{if(!$('#slice-approved').checked)throw new Error('请先审核本批路径');return mutate('validateSlice',{sliceId:slice(),approved:true,writersPaused:paused()});});$('#authorize').onclick=()=>run(()=>mutate('prepareOriginal',{sliceId:slice(),writersPaused:paused()}));$('#apply').onclick=()=>run(()=>{if(!$('#original-approved').checked)throw new Error('请先核对原库方案并确认');return mutate('applySlice',{sliceId:slice(),approved:true,writersPaused:paused()});});

$('#cancel-slice').onclick=()=>run(()=>mutate('cancelSlice',{sliceId:slice()}));

$('#bulk-preview').onclick=()=>run(async()=>{
 if(batch.flow.tree?.status!=='approved')throw new Error('请先确认分类树');
 const preview=await loadReview(batch,requestBatch),host=$('#bulk-review');host.hidden=false;host.replaceChildren();
 host.append(element('h3','全量文件名与目标路径审核'),element('p','有效方案默认纳入，只需修改名称、分类或取消不想处理的项目。此处确认仅保存审核结果，不移动文件。'));
 const rows=[],table=element('table'),head=element('tr');table.className='bulk-review-table';
 for(const label of ['纳入','原路径','文件名','目标分类与路径','状态'])head.append(element('th',label));table.append(head);
 for(const source of preview.sources){
  const tr=element('tr'),reason=reviewReason(source),include=element('input');include.type='checkbox';include.checked=!reason;include.disabled=!!reason;include.setAttribute('aria-label','纳入 '+source.currentIdentity);
  const name=element('input');name.value=source.confirmedName??source.analysis?.suggestion??source.currentIdentity.split('/').at(-1);name.disabled=!!reason;name.setAttribute('aria-label','文件名 '+source.currentIdentity);
  const category=element('select');category.disabled=!!reason;category.setAttribute('aria-label','分类 '+source.currentIdentity);
  for(const node of preview.nodes){const option=element('option',node.category);option.value=node.nodeId;option.selected=source.category?node.category===source.category:node.nodeId===source.proposedNodeId;category.append(option);}
  const target=element('p');const refresh=()=>{target.textContent=(preview.nodes.find(node=>node.nodeId===category.value)?.category??'未分类')+'/'+name.value;};name.oninput=refresh;category.onchange=refresh;refresh();
  const cells=[element('td'),element('td',source.currentIdentity),element('td'),element('td'),element('td',reason||'待整批确认')];cells[0].append(include);cells[2].append(name);cells[3].append(category,target);tr.append(...cells);table.append(tr);
  if(!reason)rows.push({sourceId:source.sourceId,identity:source.currentIdentity,wasSelected:source.selected,include,name,category});
 }
 host.append(element('p', '共 '+preview.sources.length+' 份材料，可批量审核 '+rows.length+' 份；其余项目保留并显示原因。'),table);const confirm=element('button','确认全部有效方案');
 confirm.onclick=()=>run(async()=>{
  if(batch.batchId!==preview.batchId||batch.revision!==preview.revision)throw new Error('批次已变化，请重新生成全量审核清单');
  const choices=rows.map(row=>({sourceId:row.sourceId,identity:row.identity,wasSelected:row.wasSelected,include:row.include.checked,name:row.name.value,nodeId:row.category.value}));
  host.querySelectorAll('input,select').forEach(control=>control.disabled=true);
  const result=await confirmReview(preview,choices,requestBatch,value=>{batch=value;render();$('#status').textContent='正在保存整批审核，已审核 '+(batch.counts.reviewed??0)+' 份…';});
  host.replaceChildren(element('p', '整批审核结束：确认 '+result.confirmed+' 份，失败 '+result.failures.length+' 份。'));
  for(const failure of result.failures)host.append(element('p',failure.identity+'：'+failure.reason));
  return '审核结果已保存；失败材料请修改后重审。下一步可为已审核材料准备备份与分批方案。';
 });host.append(confirm);
});
