import {reportStatus,reportSummary} from './report-ui.js';
import {element,statusName,requestBatch} from './batch-ui.js';
import {submitHistoryPlan,renderHistoryActions} from './history-actions.js';
import {renderInvalidations} from './invalidation-ui.js';
const editable=source=>source.analysis&&!source.analysis.uncertain&&source.classification&&!['excluded','succeeded','blocked','reviewed'].includes(source.status);
const selectable=source=>editable(source)||(source.status==='reviewed'&&source.analysis&&!source.analysis.uncertain&&source.classification);
export function reconcileReviewDraft(source,current){
 if(current?.hash!==source.hash)current={hash:source.hash,reviewVersion:source.reviewVersion??0,name:'',category:'',selected:source.status==='reviewed'&&source.selected===true,manual:false};
 if((current.reviewVersion??0)!==(source.reviewVersion??0)){current.selected=false;if(source.reviewResetCategory){current.category='';current.categoryManual=false;}current.reviewVersion=source.reviewVersion??0;}
 if(!(current.nameManual??current.manual))current.name=source.confirmedName??source.suggestion??'';
 if(!(current.categoryManual??current.manual))current.category=source.classification?.category??'';
 return current;
}
export function reviewAnalysisActions(batch){
 if(batch.report?.status==='needs-recovery'||batch.historyApplication&&batch.historyApplication.status!=='complete')return [];
 return (batch.analysisJob?.allowedActions??[]).filter(action=>action!=='startAnalysis'||(batch.analysisProgress?.remaining??0)>0||(batch.classificationProgress?.remaining??0)>0);
}
export async function mountReviewWorkspace(host,batchId){
 let batch,rows=[],focus=null,page=0,category='',query='',status='',busy=false,paused=false,busyMessage='',detailsOpen=false,detailTrigger,readRequired=false;
 const unsafe=()=>readRequired||batch?.report?.status==='needs-recovery'||!!batch?.historyApplication&&batch.historyApplication.status!=='complete';
 const storageKey='organizer-review:'+batchId;
 let drafts={};try{drafts=JSON.parse(sessionStorage.getItem(storageKey)??'{}');}catch{}
 const saveDrafts=()=>sessionStorage.setItem(storageKey,JSON.stringify(drafts));
 const draft=source=>drafts[source.sourceId]=reconcileReviewDraft(source,drafts[source.sourceId]);
 const root=element('div');root.className='review-workspace';host.replaceChildren(root);
 const notice=element('p');notice.setAttribute('role','status');const error=element('p');error.setAttribute('role','alert');
 const controls=element('div');controls.className='toolbar review-controls';
 const summary=element('p'),filters=element('div');summary.className='review-summary';filters.className='review-filters';
 const search=element('input');search.placeholder='查找旧名称或新名称';search.setAttribute('aria-label','按名称查找');
 const categoryFilter=element('select');categoryFilter.setAttribute('aria-label','按分类筛选');
 const statusFilter=element('select');statusFilter.setAttribute('aria-label','按状态筛选');
 filters.append(search,categoryFilter,statusFilter);
 const grid=element('div');grid.className='review-grid';
 const queue=element('aside');queue.className='review-queue';queue.setAttribute('aria-label','材料队列');
 const tableHost=element('div');tableHost.className='review-items';
 const reading=element('section');reading.className='review-reading';reading.setAttribute('aria-label','当前材料阅读');
 const detail=element('section');detail.className='review-detail';detail.setAttribute('aria-label','材料证据详情');detail.hidden=true;
 const pager=element('nav');pager.setAttribute('aria-label','材料分页');const footer=element('div');footer.className='review-footer';footer.setAttribute('aria-label','批量归档操作');
 const scope=element('details');scope.className='review-bulk-scope';
 const updateScope=()=>{scope.replaceChildren(element('summary','核对目标知识库与最终位置'),element('p','当前知识库：'+batch.libraryPath));for(const source of rows.filter(s=>draft(s).selected&&selectable(s))){const d=draft(source);scope.append(element('p',source.identity+' → '+(source.status==='reviewed'&&source.targetPath?source.targetPath:[batch.libraryPath,'raw/sources',d.category,d.name].filter(Boolean).join('/'))));}};
 const queueActions=element('div');queueActions.className='review-queue-actions';
 const queueHeading=element('div');queueHeading.className='review-queue-heading';queueHeading.append(element('h2','日常整理'),notice);
 const queueTools=element('div');queueTools.className='review-queue-tools';const queueSafety=element('div');queueSafety.className='review-queue-safety';
 queue.append(queueHeading,summary,filters,queueSafety,queueActions,tableHost,pager,queueTools);grid.append(queue,reading);
 const results=element('section');results.hidden=true;results.setAttribute('aria-label','归档结果');
 const history=element('section');history.setAttribute('aria-label','历史验证与应用');
 const invalidations=element('section');invalidations.setAttribute('aria-label','材料变化与重审');
 queueTools.append(controls,invalidations);root.append(error,results,grid,history,footer);
 const button=(label,action,disabled=false)=>{const b=element('button',label);b.disabled=disabled||busy;b.onclick=()=>run(action,label);return b;};
 async function run(fn,label){if(busy)return;busy=true;busyMessage=label==='确认并归档所选材料'?'正在校验并归档所选材料，请稍候；无需重复点击。':'正在处理，请稍候。';error.textContent='';try{render();await fn();}catch(e){readRequired=true;error.textContent=e.message;try{await load();}catch{error.textContent+='。未能读取最新状态，请先刷新建议核对结果，不能重复执行。';}}finally{busy=false;busyMessage='';render();}}
 async function load(){
  const result=await requestBatch('get',{batchId,limit:50});let all=[...result.sources],cursor=result.nextCursor;
  while(cursor!==null){const next=await requestBatch('get',{batchId,cursor,limit:50});if(next.revision!==result.revision){notice.textContent='后台正在更新，稍后刷新完整范围';return;}all.push(...next.sources);cursor=next.nextCursor;}
  readRequired=false;batch=result;rows=all;for(const source of rows)draft(source);saveDrafts();render();
 }
 const filtered=()=>rows.filter(source=>(!category||((source.classification?.category??'')===category || (category==='@root'&&source.classification?.category==='')))&&(!status||source.status===status)&&(!query||(source.identity+' '+draft(source).name).toLowerCase().includes(query.toLowerCase())));
 function showDetail(source){
  detail.replaceChildren();detail.hidden=!detailsOpen;if(!source)return;
  const close=element('button','关闭详情');close.onclick=()=>{detailsOpen=false;detail.hidden=true;detailTrigger.setAttribute('aria-expanded','false');detailTrigger.focus();};
  detail.append(close,element('h2','分类与位置详情'));
  detail.append(element('p','分类依据：'+(source.classification?.reason??'尚无建议')),element('p','原位置：'+source.currentPath));
  const d=draft(source);detail.append(element('p','最终位置：'+(source.targetPath??[batch.libraryPath,'raw/sources',d.category,d.name].filter(Boolean).join('/'))));
  for(const message of [source.warning,source.skipReason,source.categoryConfirmationError])if(message)detail.append(element('p',message));
  if(source.evolution){detail.append(element('h3',source.evolution.status==='confirmed'?'已冻结目录方案':'待审核目录建议'));for(const op of source.evolution.operations??[]){detail.append(element('p',`${({add:'新增分类',split:'拆分分类',merge:'合并分类',move:'移动或改名分类'})[op.type]??'目录调整'}：${op.from??op.parent??'Raw 根目录'} → ${op.to??op.label??'下列子分类'}（最终编号以冻结方案为准）`));if(op.problem)detail.append(element('p','现有问题：'+op.problem));if(op.benefit)detail.append(element('p','查找收益：'+op.benefit));for(const file of op.files??[])detail.append(element('p','涉及材料：'+file));for(const group of op.groups??[])detail.append(element('p','子分类 '+group.label+'：'+(group.files??[]).join('、')));}}
  if(!unsafe()&&(editable(source)||source.status==='reviewed'&&source.evolution)){
   const review=async(action,extra={})=>{await requestBatch('reviewItem',{batchId,revision:batch.revision,sourceId:source.sourceId,action,...extra});await load();};
   if(!source.evolution)detail.append(button(source.confirmedName?'评估所填分类的目录调整':'确认此名称并评估目录调整',async()=>{if(!source.confirmedName)await review('confirmName',{name:d.name});await review('evolve',{category:d.category});}));
   else{
    if(source.evolution.status!=='confirmed')detail.append(button('确认这份目录调整',()=>review('confirmEvolution')));
    const shared=!!batch.flow.evolutionPlan;
    detail.append(element('p',shared?'撤销会解除整份共享目录方案，并要求所有相关材料重新审核。':'如现有分类可容纳，请放弃此目录建议，再填写现有分类；也可重新评估。'));
    detail.append(button(shared?'撤销整份目录方案并重审相关材料':'放弃目录建议，改用现有分类',()=>review('discardEvolution',{discardShared:shared})));
   }
  }
  if(batch.flow.evolutionPlan){detail.append(element('p',`目录调整影响 ${batch.flow.evolutionPlan.affectedFileCount??0} 份历史材料，尚未解决前保留原处`));for(const item of batch.flow.evolutionPlan.fileMappings??[])detail.append(element('p',`${item.from} → ${item.to}`));}
  if(!unsafe()&&!['succeeded','excluded'].includes(source.status))detail.append(button('本项保留原处',async()=>{await requestBatch('reviewItem',{batchId,revision:batch.revision,sourceId:source.sourceId,action:'exclude'});draft(source).selected=false;await load();}));
 }
 function showReading(source,visible){
  reading.replaceChildren();
  if(!source){reading.append(element('h2','没有符合条件的材料'),element('p','请调整名称、分类或状态筛选。'));detail.hidden=true;return;}
  const d=draft(source),position=visible.indexOf(source),heading=element('div');heading.className='review-reading-heading';
  const breadcrumb=element('p',`集中审核 / 材料 ${page*20+position+1}`);breadcrumb.className='review-breadcrumb';
  const navigation=element('div');navigation.className='review-reading-actions';
  const navigate=(label,offset)=>{const b=element('button',label);b.disabled=!visible[position+offset];b.onclick=()=>{focus=visible[position+offset].sourceId;render();};return b;};
  detailTrigger=element('button','详情');detailTrigger.setAttribute('aria-expanded',String(detailsOpen));detailTrigger.setAttribute('aria-controls','review-evidence-details');detailTrigger.onclick=()=>{detailsOpen=!detailsOpen;detailTrigger.setAttribute('aria-expanded',String(detailsOpen));showDetail(source);if(detailsOpen)detail.querySelector('button').focus();};detail.id='review-evidence-details';
  navigation.append(navigate('上一篇',-1),navigate('下一篇',1),detailTrigger);heading.append(breadcrumb,navigation);
  const title=element('h2',d.name||source.currentIdentity||source.identity);title.className='review-title';
  const state=element('p',statusName(source.status)+(d.manual?' · 已手改':''));state.className='review-item-state';
  const fields=element('div');fields.className='review-fields';
  const name=element('input');name.value=d.name;name.disabled=!editable(source)||!!source.confirmedName||unsafe()||busy;name.setAttribute('aria-label','新名称 '+source.identity);
  const categoryInput=element('input');categoryInput.value=d.category;categoryInput.disabled=!editable(source)||unsafe()||busy;categoryInput.setAttribute('aria-label','主分类 '+source.identity);categoryInput.setAttribute('list','category-options-'+source.sourceId);
  const data=element('datalist');data.id='category-options-'+source.sourceId;for(const value of source.classification?.options??[]){const o=element('option');o.value=value;data.append(o);}
  const nameLabel=element('label','建议文件名');nameLabel.append(name);const categoryLabel=element('label','建议分类');categoryLabel.append(categoryInput,data);
  const rootCategory=element('button','Raw 根目录');rootCategory.disabled=categoryInput.disabled;rootCategory.onclick=()=>{categoryInput.value='';categoryInput.oninput();};categoryLabel.append(rootCategory);fields.append(nameLabel,categoryLabel);
  const original=element('p','原文件名：'+source.identity);original.className='review-original';
  name.oninput=()=>{d.name=name.value;d.nameManual=true;d.categoryManual??=false;d.manual=true;saveDrafts();title.textContent=d.name||source.identity;state.textContent=statusName(source.status)+' · 已手改';showDetail(source);updateScope();};
  categoryInput.oninput=()=>{d.category=categoryInput.value;d.categoryManual=true;d.nameManual??=false;d.manual=true;saveDrafts();state.textContent=statusName(source.status)+' · 已手改';showDetail(source);updateScope();};
  const evidence=element('div');evidence.className='review-evidence';evidence.append(element('p','摘要与证据'),element('h3','摘要'),element('p',source.analysis?.summary||'尚无摘要'),element('h3','原文证据'));
  if(!source.analysis?.evidence?.length)evidence.append(element('p','尚无原文证据'));
  for(const quote of source.analysis?.evidence??[])evidence.append(element('blockquote',quote));
  reading.append(heading,title,state,fields,original);
  const warnings=[source.warning,source.skipReason,source.categoryConfirmationError,source.directoryDependency?'涉及目录调整，请在详情中核对影响及阻断原因':null,source.evolution?'存在目录调整方案，请在详情中审核':null,...(source.evolution?.operations??[]).map(op=>op.problem)].filter(Boolean);
  if(warnings.length){const issues=element('div');issues.className='review-warnings';issues.setAttribute('role','note');for(const message of warnings)issues.append(element('p',message));reading.append(issues);}
  reading.append(evidence,detail);showDetail(source);
 }
 function render(){
  if(!batch)return;
  const completed=batch.report?.status==='complete'&&batch.flow.newArchive;
  notice.textContent=busy?busyMessage:completed?`归档成功，共 ${batch.report.counts.succeeded} 份材料。${reportSummary(batch.report)}。`:batch.report?.hasExecution?`${reportStatus(batch.report.status)}。${reportSummary(batch.report)}。`:`${batch.report?reportStatus(batch.report.status):statusName(batch.phase)}`;
  controls.replaceChildren();for(const action of reviewAnalysisActions(batch))controls.append(button(({startAnalysis:'开始分析',pauseAnalysis:'暂停分析',continueAnalysis:'继续分析'})[action],async()=>{await requestBatch(action,{batchId});await load();},readRequired));
  controls.append(button('刷新建议',load));const legacy=element('a','执行与恢复入口');legacy.href='/task-report?batchId='+encodeURIComponent(batchId);controls.append(legacy);
  (reviewAnalysisActions(batch).length?queueSafety:queueTools).prepend(controls);
  const options=(select,values,value,label)=>{select.replaceChildren();const first=element('option',label);first.value='';select.append(first);for(const [key,text] of values){const option=element('option',text);option.value=key;select.append(option);}select.value=value;};
  options(categoryFilter,[...new Set(rows.map(s=>s.classification?.category).filter(v=>v!==null&&v!==undefined))].map(v=>[v||'@root',v||'Raw 根目录']),category,'全部分类');
  options(statusFilter,[...new Set(rows.map(s=>s.status))].map(v=>[v,statusName(v)]),status,'全部状态');
  const list=filtered();page=Math.min(page,Math.max(0,Math.ceil(list.length/20)-1));const visible=list.slice(page*20,page*20+20);if(!visible.some(s=>s.sourceId===focus))focus=visible[0]?.sourceId;
  const selected=rows.filter(s=>draft(s).selected&&selectable(s));summary.textContent=`整批 ${rows.length} 份 · 正常建议 ${rows.filter(s=>editable(s)&&s.classification?.category!==null&&!s.directoryDependency).length} 份 · 例外 ${rows.filter(s=>['needs-information','blocked','analysis-failed','evolution-review','classification-failed'].includes(s.status)||s.classification?.category===null||s.categoryConfirmationError).length} 份 · 当前筛选 ${list.length} 份 · 跨全部页面已选 ${selected.length} 份 · 已保存 ${rows.filter(s=>s.status==='reviewed').length} 份`;
  tableHost.replaceChildren();
  for(const source of visible){const d=draft(source),row=element('div');row.className='review-queue-item';row.setAttribute('data-current',String(focus===source.sourceId));
   const checkbox=element('input');checkbox.type='checkbox';checkbox.checked=d.selected&&selectable(source);checkbox.disabled=!selectable(source)||busy||unsafe();checkbox.setAttribute('aria-label','选择 '+source.identity);checkbox.onchange=()=>{d.selected=checkbox.checked;saveDrafts();render();};
   const open=element('button');open.className='review-open';open.setAttribute('aria-label','阅读 '+source.identity);open.setAttribute('aria-current',String(focus===source.sourceId));
   const name=element('span',d.name||source.identity);name.className='review-queue-name';
   const caption=element('small',(d.category||'Raw 根目录')+' · '+statusName(source.status)+(d.manual?' · 已手改':'')+(source.directoryDependency||source.evolution?' · 目录调整':'')+(source.categoryConfirmationError?' · 分类待处理':''));
   open.append(name,caption);open.onclick=()=>{focus=source.sourceId;render();};row.append(checkbox,open);tableHost.append(row);
  }
  if(!visible.length)tableHost.append(element('p','没有符合条件的材料'));
  showReading(visible.find(s=>s.sourceId===focus),visible);
  pager.replaceChildren(button('上一页',()=>{page--;render();},page===0),element('span',`第 ${page+1} / ${Math.max(1,Math.ceil(list.length/20))} 页`),button('下一页',()=>{page++;render();},(page+1)*20>=list.length));
  const alreadyValidated=batch.historyValidation?.status==='awaiting-apply'&&selected.length===batch.historyPlan?.selectedCount&&selected.every(s=>s.selected&&s.status==='reviewed'&&draft(s).name===s.confirmedName&&draft(s).category===s.classification?.category);
  const pureNew=selected.every(s=>s.ingestStatus==='new'&&!s.directoryDependency);
  const pause=element('input');pause.type='checkbox';pause.checked=paused;pause.disabled=busy;pause.onchange=()=>{paused=pause.checked;render();};const pauseLabel=element('label','我已暂停 Wiki 及其他程序对知识库和收件箱的写入');pauseLabel.prepend(pause);
  queueActions.replaceChildren(button('选择整批正常建议',()=>{for(const s of rows)if(selectable(s)&&!s.directoryDependency&&s.classification?.category!==null&&draft(s).name)draft(s).selected=true;saveDrafts();render();}),button('清除全部选择',()=>{for(const d of Object.values(drafts))d.selected=false;saveDrafts();render();}));
  footer.hidden=selected.length===0;
  footer.replaceChildren(element('p',`操作范围：整批中明确勾选的 ${selected.length} 份（跨全部页面，包含隐藏筛选项）；未选中项保留。`),button(alreadyValidated?'当前方案已验证，请在上方最终确认':pureNew?'确认并归档所选材料':'确认整理方案并开始安全验证',async()=>{const items=selected.map(s=>({sourceId:s.sourceId,name:draft(s).name,category:draft(s).category,manuallyEdited:draft(s).manual}));if(!paused)throw new Error('请先勾选暂停外部写入');if(pureNew)await requestBatch('confirmNewArchive',{batchId,revision:batch.revision,writersPaused:paused,requestId:crypto.randomUUID(),items});else await submitHistoryPlan({batch,items,writersPaused:paused});await load();},!paused||!selected.length||alreadyValidated||unsafe()||batch.historyValidation?.status==='running'));
  updateScope();footer.prepend(scope,pauseLabel);
  renderHistoryActions(history,{batch,writersPaused:paused,run,refresh:load});
  if(footer.hidden&&batch.historyValidation)history.prepend(element('p','当前知识库：'+batch.libraryPath),pauseLabel);
  if(busy||readRequired)for(const control of history.querySelectorAll('button'))control.disabled=true;
  renderInvalidations(invalidations,{batch:{...batch,sources:rows,busy:busy||readRequired},run,refresh:load});
  (unsafe()||batch.invalidations?queueSafety:queueTools).append(invalidations);
  results.replaceChildren();results.hidden=!(batch.report?.hasExecution||['partial','failed','retained','needs-recovery'].includes(batch.report?.status));if(!results.hidden){results.append(element('h2',reportStatus(batch.report.status)),element('p',reportSummary(batch.report)));const reportLink=element('a','查看整批结果、保留原因与恢复证据');reportLink.href='/task-report?batchId='+encodeURIComponent(batchId);results.append(reportLink);}
 }
 search.oninput=()=>{query=search.value;page=0;render();};categoryFilter.onchange=()=>{category=categoryFilter.value;page=0;render();};statusFilter.onchange=()=>{status=statusFilter.value;page=0;render();};
 await load();const timer=setInterval(()=>{if(host.hidden||!host.isConnected){clearInterval(timer);return;}if(!busy&&!(root.contains(document.activeElement)&&['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName))&&(['running','pausing'].includes(batch?.analysisJob?.status)||batch?.historyValidation?.status==='running'||batch?.historyApplication?.status==='running'))run(load);},2000);
 return {refresh:load,filterCategory:value=>{category=value||'@root';page=0;render();}};
}
