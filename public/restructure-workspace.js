import {element,requestBatch,statusName} from './batch-ui.js';
import {submitHistoryPlan,renderHistoryActions} from './history-actions.js';
import {reviewReason} from './bulk-review.js';

// 树版本参与草稿身份，避免分类调整后悄悄沿用旧节点选择。
export function restructureDraft(source,current,treeRevision){
 if(current?.hash!==source.hash||current?.treeRevision!==treeRevision)return {hash:source.hash,treeRevision,name:source.confirmedName??source.analysis?.suggestion??'',nodeId:source.proposedNodeId??'',selected:source.status==='reviewed'&&source.selected===true,manual:false};
 return current;
}
export async function mountRestructureWorkspace(host,batchId){
 let batch,rows=[],nodes=[],drafts={},page=0,focus=null,query='',category='',status='',busy=false,writersPaused=false;
 const key='organizer-restructure:'+batchId;try{drafts=JSON.parse(sessionStorage.getItem(key)??'{}');}catch{}
 const persist=()=>sessionStorage.setItem(key,JSON.stringify(drafts));
 const draft=source=>drafts[source.sourceId]=restructureDraft(source,drafts[source.sourceId],batch.flow.tree?.revision);
 const root=element('div'),notice=element('p'),error=element('p'),controls=element('div'),treeHost=element('section'),files=element('section'),history=element('section');
 notice.setAttribute('role','status');error.setAttribute('role','alert');controls.className='toolbar';treeHost.setAttribute('aria-label','分类树审核');files.setAttribute('aria-label','全量文件方案');history.setAttribute('aria-label','安全验证与应用');root.append(notice,error,controls,treeHost,files,history);host.replaceChildren(root);
 const button=(text,action,disabled=false)=>{const b=element('button',text);b.disabled=disabled||busy;b.onclick=()=>run(action);return b;};
 async function run(action){if(busy)return;busy=true;error.textContent='';try{await action();}catch(e){error.textContent=e.message;try{await load();}catch{}}finally{busy=false;render();}}
 async function load(){
  const initial=await requestBatch('get',{batchId,limit:50});const all=[...initial.sources],tree=[...(initial.flow.tree?.nodes??[])];let cursor=initial.nextCursor,treeCursor=initial.flow.tree?.nextCursor??null;
  while(cursor!==null||treeCursor!==null){const next=await requestBatch('get',{batchId,cursor:cursor??0,treeCursor:treeCursor??0,limit:50});if(next.revision!==initial.revision){notice.textContent='后台正在更新全量方案，请稍候';return;}if(cursor!==null){all.push(...next.sources);cursor=next.nextCursor;}if(treeCursor!==null){tree.push(...next.flow.tree.nodes);treeCursor=next.flow.tree.nextCursor;}}
  batch=initial;rows=all;nodes=tree;for(const source of rows)draft(source);persist();render();
 }
 const locked=()=>['running','pausing'].includes(batch.analysisJob?.status)||batch.historyValidation?.status==='running'||['running','complete','needs-recovery'].includes(batch.historyApplication?.status);
 async function treeAction(input){await requestBatch('treeAction',{batchId,revision:batch.revision,...input});await load();}
 function render(){
  if(!batch)return;const tree=batch.flow.tree,approved=tree?.status==='approved',application=batch.historyApplication,validation=batch.historyValidation;
  const phase=application?'执行结果':validation&&validation.status!=='stale'?'安全验证与最终应用':approved?'第二步：审核文件方案':tree?'第一步：审核分类树':'全体材料分析';
  notice.textContent=`首次整体重构 · ${phase} · ${batch.libraryPath}`;
  controls.replaceChildren();if(!application&&!approved)for(const action of batch.analysisJob?.allowedActions??[])controls.append(button(({startAnalysis:'开始全体分析',pauseAnalysis:'暂停分析',continueAnalysis:'继续分析'})[action],async()=>{await requestBatch(action,{batchId});await load();},locked()&&action!=='pauseAnalysis'));
  controls.append(button('刷新进度',load));const report=element('a','报告与恢复');report.href='/task-report?batchId='+encodeURIComponent(batchId);controls.append(report);
  const progress=batch.analysisProgress,current=batch.flow.analysisCurrent;controls.append(element('p',`分析 ${progress.total-progress.remaining} / ${progress.total} 份 · ${statusName(batch.analysisJob?.status)}${current?.status==='running'?' · 当前材料：'+current.identity+' · '+current.stage:''}`));
  if(batch.analysisJob?.status==='pausing')controls.append(element('p','正在暂停：当前材料或分类树生成完成后停止。'));
  if(batch.analysisJob?.status==='interrupted')controls.append(element('p','本地服务已中断。点击继续后复核已完成结果；在途请求可能重试。'));
  if(batch.analysisJob?.error)controls.append(element('p',batch.analysisJob.error.message));
  treeHost.replaceChildren();files.replaceChildren();
  if(tree){const details=element(approved?'details':'div');if(approved)details.append(element('summary',`已确认分类树 · ${nodes.length} 个分类（展开查看或调整）`));else details.append(element('h2','分类树与代表材料'));
   for(const node of nodes){const article=element('article');article.append(element('h3',node.category),element('p',node.reason));for(const id of node.representatives??[]){const source=rows.find(s=>s.sourceId===id);if(source){article.append(element('strong',source.currentIdentity),element('p',source.analysis?.summary??''));for(const quote of source.analysis?.evidence??[])article.append(element('blockquote',quote));}}
    const edit=element('input');edit.value=node.segments.join(' / ');edit.setAttribute('aria-label','分类层级 '+node.category);edit.disabled=locked();article.append(edit,button('保存分类调整',()=>treeAction({action:'edit',nodeId:node.nodeId,segments:edit.value.split('/').map(v=>v.trim())}),locked()));details.append(article);}
   if(!approved)details.append(element('p','分类树调整后旧文件方案和验证将失效。确认前请检查分类及代表材料。'),button('确认分类树',()=>treeAction({action:'approve'}),locked()||tree.status!=='proposed'));treeHost.append(details);
  }else if(!progress.remaining&&!['running','pausing'].includes(batch.analysisJob?.status))treeHost.append(element('p','可靠材料分析完成后生成分类树；信息不足的材料保留原处。'));
  if(batch.flow.treeProgress?.status==='running')treeHost.append(element('p',`正在生成分类树：${batch.flow.treeProgress.stage} · ${batch.flow.treeProgress.processedCount??0} / ${batch.flow.treeProgress.totalCount??0}`));
  if(approved)renderFiles();
  const pause=element('input');pause.type='checkbox';pause.checked=writersPaused;pause.onchange=()=>{writersPaused=pause.checked;render();};const label=element('label','我已暂停 Wiki、Obsidian 和同步程序等外部写入');label.prepend(pause);
  renderHistoryActions(history,{batch,writersPaused,run,refresh:load});if(approved||validation)history.prepend(label);
 }
 function renderFiles(){
  const toolbar=element('div');toolbar.className='toolbar';const search=element('input');search.value=query;search.placeholder='查找旧名称或新名称';search.setAttribute('aria-label','查找材料');search.onchange=()=>{query=search.value;page=0;render();};
  const categories=element('select');categories.setAttribute('aria-label','按分类筛选');categories.append(element('option','全部分类'));categories.firstChild.value='';for(const node of nodes){const option=element('option',node.category);option.value=node.category;categories.append(option);}categories.value=category;categories.onchange=()=>{category=categories.value;page=0;render();};
  const statuses=element('select');statuses.setAttribute('aria-label','按状态筛选');for(const [value,text] of [['','全部材料'],['normal','可接受建议'],['exception','待处理例外']]){const option=element('option',text);option.value=value;statuses.append(option);}statuses.value=status;statuses.onchange=()=>{status=statuses.value;page=0;render();};toolbar.append(search,categories,statuses);
  const list=rows.filter(s=>(!query||(s.currentIdentity+' '+draft(s).name).toLowerCase().includes(query.toLowerCase()))&&(!category||nodes.find(n=>n.nodeId===draft(s).nodeId)?.category===category)&&(!status||(status==='normal'?!reviewReason(s):!!reviewReason(s))));page=Math.min(page,Math.max(0,Math.ceil(list.length/20)-1));const visible=list.slice(page*20,page*20+20);if(!visible.some(s=>s.sourceId===focus))focus=visible[0]?.sourceId;
  const selected=rows.filter(s=>draft(s).selected&&!reviewReason(s));files.append(element('h2','文件整理方案'),element('p',`整批 ${rows.length} 份 · 正常 ${rows.filter(s=>!reviewReason(s)).length} 份 · 例外 ${rows.filter(s=>reviewReason(s)).length} 份 · 跨所有页已选 ${selected.length} 份 · 当前筛选 ${list.length} 份`),toolbar);
  const grid=element('div');grid.className='review-grid';const tableHost=element('div');tableHost.className='table-scroll';const detail=element('section');detail.className='review-detail';detail.setAttribute('aria-label','材料证据详情');const table=element('table'),head=element('tr');for(const text of ['选择','原名称','新名称','主分类','状态'])head.append(element('th',text));table.append(head);
  function showDetail(source){detail.replaceChildren();if(!source)return;const d=draft(source),node=nodes.find(n=>n.nodeId===d.nodeId);detail.append(element('h3',source.currentIdentity),element('p',source.analysis?.summary??'尚无可靠证据'));for(const text of source.analysis?.evidence??[])detail.append(element('blockquote',text));detail.append(element('p','分类理由：'+(node?.reason??'未分类')),element('p','原位置：'+source.currentPath),element('p','最终位置：'+[batch.sourceRoot,node?.category,d.name].filter(Boolean).join('/')),element('p',reviewReason(source)||source.categoryConfirmationError||'有效建议；未选中的材料保留原处'));}
  for(const source of visible){const d=draft(source),reason=reviewReason(source),row=element('tr');row.setAttribute('aria-selected',String(focus===source.sourceId));row.onclick=()=>{focus=source.sourceId;for(const other of table.rows)other.setAttribute('aria-selected',String(other===row));showDetail(source);};const select=element('input');select.type='checkbox';select.checked=d.selected&&!reason;select.disabled=!!reason||locked()||busy;select.setAttribute('aria-label','选择 '+source.currentIdentity);select.onchange=()=>{d.selected=select.checked;persist();render();};const name=element('input');name.value=d.name;name.disabled=!!reason||!!source.confirmedName||locked();name.setAttribute('aria-label','新名称 '+source.currentIdentity);name.onchange=()=>{d.name=name.value;d.manual=true;persist();showDetail(source);};const categoryInput=element('select');categoryInput.setAttribute('aria-label','主分类 '+source.currentIdentity);for(const node of nodes){const option=element('option',node.category);option.value=node.nodeId;categoryInput.append(option);}categoryInput.value=d.nodeId;categoryInput.disabled=!!reason||locked()||source.status==='reviewed';categoryInput.onchange=()=>{d.nodeId=categoryInput.value;d.manual=true;persist();showDetail(source);};for(const value of [select,element('span',source.currentIdentity),name,categoryInput,element('span',reason||source.categoryConfirmationError||statusName(source.status))]){const cell=element('td');cell.append(value);row.append(cell);}table.append(row);}
  tableHost.append(table);grid.append(tableHost,detail);files.append(grid);showDetail(visible.find(s=>s.sourceId===focus));
  const pager=element('nav');pager.append(button('上一页',()=>{page--;render();},page===0),element('span',`第 ${page+1} / ${Math.max(1,Math.ceil(list.length/20))} 页`),button('下一页',()=>{page++;render();},(page+1)*20>=list.length));files.append(pager);
  const footer=element('div');footer.className='review-footer';footer.append(element('p',`确认范围：跨所有页面、包括隐藏筛选项的 ${selected.length} 份；其余材料保留原处。`),button('选择整批正常建议',()=>{for(const source of rows)if(!reviewReason(source))draft(source).selected=true;persist();render();},locked()),button('清除全部选择',()=>{for(const d of Object.values(drafts))d.selected=false;persist();render();},locked()),button('确认文件整理方案并开始安全验证',async()=>{await submitHistoryPlan({batch,writersPaused,items:selected.map(s=>({sourceId:s.sourceId,name:draft(s).name,nodeId:draft(s).nodeId}))});await load();},!selected.length||locked()||!writersPaused||['awaiting-apply'].includes(batch.historyValidation?.status)));files.append(footer);
 }
 await load();const timer=setInterval(()=>{if(host.hidden||!host.isConnected){clearInterval(timer);return;}if(!busy&&(['running','pausing'].includes(batch?.analysisJob?.status)||batch?.historyValidation?.status==='running'||batch?.historyApplication?.status==='running'))run(load);},1500);
 return {refresh:load,filterCategory:value=>{category=value;page=0;render();}};
}
