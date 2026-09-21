import {element,statusName,requestBatch} from './batch-ui.js';
const editable=source=>source.analysis&&!source.analysis.uncertain&&source.classification&&!['excluded','succeeded','blocked','reviewed'].includes(source.status);
const selectable=source=>editable(source)||(source.status==='reviewed'&&source.analysis&&!source.analysis.uncertain&&source.classification);
export function reconcileReviewDraft(source,current){
 if(current?.hash!==source.hash)current={hash:source.hash,name:'',category:'',selected:source.status==='reviewed'&&source.selected===true,manual:false};
 if(!current.manual){current.name=source.confirmedName??source.suggestion??'';current.category=source.classification?.category??'';}
 return current;
}
export async function mountReviewWorkspace(host,batchId){
 let batch,rows=[],focus=null,page=0,category='',query='',status='',busy=false,paused=false;
 const storageKey='organizer-review:'+batchId;
 let drafts={};try{drafts=JSON.parse(sessionStorage.getItem(storageKey)??'{}');}catch{}
 const saveDrafts=()=>sessionStorage.setItem(storageKey,JSON.stringify(drafts));
 const draft=source=>drafts[source.sourceId]=reconcileReviewDraft(source,drafts[source.sourceId]);
 const root=element('div');host.replaceChildren(root);
 const notice=element('p');notice.setAttribute('role','status');const error=element('p');error.setAttribute('role','alert');
 const controls=element('div');controls.className='toolbar';
 const summary=element('p'),filters=element('div');filters.className='toolbar';
 const search=element('input');search.placeholder='查找旧名称或新名称';search.setAttribute('aria-label','按名称查找');
 const categoryFilter=element('select');categoryFilter.setAttribute('aria-label','按分类筛选');
 const statusFilter=element('select');statusFilter.setAttribute('aria-label','按状态筛选');
 filters.append(search,categoryFilter,statusFilter);
 const grid=element('div');grid.className='review-grid';const tableHost=element('div');tableHost.className='table-scroll';const detail=element('section');detail.className='review-detail';detail.setAttribute('aria-label','材料证据详情');grid.append(tableHost,detail);
 const pager=element('nav');pager.setAttribute('aria-label','材料分页');const footer=element('div');footer.className='review-footer';
 const results=element('section');results.hidden=true;results.setAttribute('aria-label','归档结果');
 root.append(notice,error,controls,summary,filters,grid,pager,results,footer);
 const button=(label,action,disabled=false)=>{const b=element('button',label);b.disabled=disabled||busy;b.onclick=()=>run(action);return b;};
 async function run(fn){if(busy)return;busy=true;error.textContent='';try{await fn();}catch(e){error.textContent=e.message;try{await load();}catch{}}finally{busy=false;render();}}
 async function load(){
  const result=await requestBatch('get',{batchId,limit:50});let all=[...result.sources],cursor=result.nextCursor;
  while(cursor!==null){const next=await requestBatch('get',{batchId,cursor,limit:50});if(next.revision!==result.revision){notice.textContent='后台正在更新，稍后刷新完整范围';return;}all.push(...next.sources);cursor=next.nextCursor;}
  batch=result;rows=all;for(const source of rows)draft(source);saveDrafts();render();
 }
 const filtered=()=>rows.filter(source=>(!category||((source.classification?.category??'')===category || (category==='@root'&&source.classification?.category==='')))&&(!status||source.status===status)&&(!query||(source.identity+' '+draft(source).name).toLowerCase().includes(query.toLowerCase())));
 function showDetail(source){
  detail.replaceChildren();if(!source){detail.append(element('p','选择一行查看证据和最终位置'));return;}
  detail.append(element('h2',source.currentIdentity??source.identity),element('p',source.analysis?.summary??'尚无全文分析证据'));
  for(const quote of source.analysis?.evidence??[])detail.append(element('blockquote',quote));
  detail.append(element('p','分类依据：'+(source.classification?.reason??'尚无建议')),element('p','原位置：'+source.currentPath));
  const d=draft(source);detail.append(element('p','最终位置：'+(source.targetPath??[batch.libraryPath,'raw/sources',d.category,d.name].filter(Boolean).join('/'))));
  for(const message of [source.warning,source.skipReason,source.categoryConfirmationError])if(message)detail.append(element('p',message));
  if(source.evolution){detail.append(element('h3','目录调整（阻断）'));for(const op of source.evolution.operations??[])detail.append(element('p',JSON.stringify(op)));}
  if(batch.flow.evolutionPlan){detail.append(element('p',`目录调整影响 ${batch.flow.evolutionPlan.affectedFileCount??0} 份历史材料，尚未解决前保留原处`));for(const item of batch.flow.evolutionPlan.fileMappings??[])detail.append(element('p',`${item.from} → ${item.to}`));}
  if(!['succeeded','excluded'].includes(source.status))detail.append(button('本项保留原处',async()=>{await requestBatch('reviewItem',{batchId,revision:batch.revision,sourceId:source.sourceId,action:'exclude'});draft(source).selected=false;await load();}));
 }
 function render(){
  if(!batch)return;
  notice.textContent=`任务 ${batch.batchId} · ${statusName(batch.analysisJob?.status??batch.phase)}。请集中审核名称、分类与最终位置。`;
  controls.replaceChildren();for(const action of batch.analysisJob?.allowedActions??[])controls.append(button(({startAnalysis:'开始分析',pauseAnalysis:'暂停分析',continueAnalysis:'继续分析'})[action],async()=>{await requestBatch(action,{batchId});await load();}));
  controls.append(button('刷新建议',load));const legacy=element('a','执行与恢复入口');legacy.href='/inbox?batchId='+encodeURIComponent(batchId);controls.append(legacy);
  const options=(select,values,value,label)=>{select.replaceChildren();const first=element('option',label);first.value='';select.append(first);for(const [key,text] of values){const option=element('option',text);option.value=key;select.append(option);}select.value=value;};
  options(categoryFilter,[...new Set(rows.map(s=>s.classification?.category).filter(v=>v!==null&&v!==undefined))].map(v=>[v||'@root',v||'Raw 根目录']),category,'全部分类');
  options(statusFilter,[...new Set(rows.map(s=>s.status))].map(v=>[v,statusName(v)]),status,'全部状态');
  const list=filtered();page=Math.min(page,Math.max(0,Math.ceil(list.length/20)-1));const visible=list.slice(page*20,page*20+20);if(!visible.some(s=>s.sourceId===focus))focus=visible[0]?.sourceId;
  const selected=rows.filter(s=>draft(s).selected&&selectable(s));summary.textContent=`整批 ${rows.length} 份 · 正常建议 ${rows.filter(s=>editable(s)&&s.classification?.category!==null&&!s.evolution).length} 份 · 例外 ${rows.filter(s=>['needs-information','blocked','analysis-failed','evolution-review','classification-failed'].includes(s.status)||s.classification?.category===null||s.categoryConfirmationError).length} 份 · 当前筛选 ${list.length} 份 · 跨全部页面已选 ${selected.length} 份 · 已保存 ${rows.filter(s=>s.status==='reviewed').length} 份`;
  const table=element('table'),head=element('thead'),headRow=element('tr');for(const title of ['选择','原名称','新名称','主分类','状态'])headRow.append(element('th',title));head.append(headRow);table.append(head);const body=element('tbody');
  for(const source of visible){const d=draft(source),row=element('tr');row.setAttribute('aria-selected',String(focus===source.sourceId));row.onclick=()=>{focus=source.sourceId;for(const other of body.rows)other.setAttribute('aria-selected',String(other===row));showDetail(source);};
   const checkbox=element('input');checkbox.type='checkbox';checkbox.checked=d.selected&&selectable(source);checkbox.disabled=!selectable(source)||busy;checkbox.setAttribute('aria-label','选择 '+source.identity);checkbox.onchange=()=>{d.selected=checkbox.checked;saveDrafts();render();};const cell=element('td');cell.append(checkbox);
   const name=element('input');name.value=d.name;name.disabled=!editable(source)||!!source.confirmedName;name.setAttribute('aria-label','新名称 '+source.identity);name.onchange=()=>{d.name=name.value;d.manual=true;saveDrafts();showDetail(source);};
   const categoryInput=element('input');categoryInput.value=d.category;categoryInput.disabled=!editable(source);categoryInput.setAttribute('aria-label','主分类 '+source.identity);categoryInput.setAttribute('list','category-options-'+source.sourceId);const data=element('datalist');data.id='category-options-'+source.sourceId;for(const value of source.classification?.options??[]){const o=element('option');o.value=value;data.append(o);}categoryInput.onchange=()=>{d.category=categoryInput.value;d.manual=true;saveDrafts();showDetail(source);};
   const nameCell=element('td'),categoryCell=element('td');nameCell.append(name);categoryCell.append(categoryInput,data);row.append(cell,element('td',source.identity),nameCell,categoryCell,element('td',statusName(source.status)+(d.manual?' · 已手改':'')));body.append(row);
  }table.append(body);tableHost.replaceChildren(table);showDetail(visible.find(s=>s.sourceId===focus));
  pager.replaceChildren(button('上一页',()=>{page--;render();},page===0),element('span',`第 ${page+1} / ${Math.max(1,Math.ceil(list.length/20))} 页`),button('下一页',()=>{page++;render();},(page+1)*20>=list.length));
  const pureNew=selected.every(s=>s.ingestStatus==='new')&&!batch.flow.evolutionPlan&&!rows.some(s=>s.evolution?.operations?.length);
  const pause=element('input');pause.type='checkbox';pause.checked=paused;pause.onchange=()=>{paused=pause.checked;};const pauseLabel=element('label','我已暂停 Wiki 及其他程序对知识库和收件箱的写入');pauseLabel.prepend(pause);
  footer.replaceChildren(element('p',`操作范围：整批中明确勾选的 ${selected.length} 份（跨页，包含隐藏筛选项）；未选中项保留。`),button('选择整批正常建议',()=>{for(const s of rows)if(selectable(s)&&!s.evolution&&s.classification?.category!==null&&draft(s).name)draft(s).selected=true;saveDrafts();render();}),button('清除全部选择',()=>{for(const d of Object.values(drafts))d.selected=false;saveDrafts();render();}),button(pureNew?'确认并归档所选材料':'保存所选名称与分类',async()=>{if(pureNew&&!paused)throw new Error('请先勾选暂停外部写入');await requestBatch(pureNew?'confirmNewArchive':'confirmPlans',{batchId,revision:batch.revision,writersPaused:paused,requestId:crypto.randomUUID(),items:selected.map(s=>({sourceId:s.sourceId,name:draft(s).name,category:draft(s).category,manuallyEdited:draft(s).manual}))});await load();},!selected.length||!!batch.flow.evolutionPlan));
  footer.prepend(element('p','当前知识库：'+batch.libraryPath),pauseLabel);
  const archive=batch.flow.newArchive;results.replaceChildren();results.hidden=!archive;if(archive){results.append(element('p','归档结果：成功 '+(archive.counts.succeeded??0)+' 份，保留 '+(archive.counts.retained??0)+' 份，失败 '+(archive.counts.failed??0)+' 份'));for(const item of archive.items)results.append(element('p',item.identity+'：'+(item.status==='succeeded'?'归档成功':item.reason?.message??statusName(item.status))));}
 }
 search.oninput=()=>{query=search.value;page=0;render();};categoryFilter.onchange=()=>{category=categoryFilter.value;page=0;render();};statusFilter.onchange=()=>{status=statusFilter.value;page=0;render();};
 await load();const timer=setInterval(()=>{if(host.hidden||!host.isConnected){clearInterval(timer);return;}if(!busy&&['running','pausing'].includes(batch?.analysisJob?.status))run(load);},2000);
 return {refresh:load,filterCategory:value=>{category=value||'@root';page=0;render();}};
}
