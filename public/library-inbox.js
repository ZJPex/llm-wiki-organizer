import {element} from './batch-ui.js';

export async function requestInbox(action,input){
 const {token}=await(await fetch('/api/session')).json();
 const response=await fetch('/api/inbox/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)}),result=await response.json();
 if(!response.ok)throw Object.assign(new Error(result.error),result);return result;
}
const labels={pending:'待处理',waiting:'等待分析',analyzing:'分析中',paused:'等待手动继续',reviewable:'可审核','needs-classification':'分类待定','needs-information':'信息不足',failed:'失败',confirmed:'已确认待归档',archived:'已归档',missing:'来源缺失',excluded:'已保留原处'};
const control=(label,action,primary=false)=>{const button=element('button',label);button.type='button';button.className=primary?'primary':'';button.onclick=action;return button;};

// 草稿与勾选独立于后台快照，轮询不覆盖用户尚未保存的修改。
export function createLibraryInboxHome({tasks,featured,more,getLibrary,history}){
 let items=[],generation=0,busy=false,selected=new Set(),drafts=new Map(),libraryId=null,writersPaused=false,analysisProgress=null,analysisActive=false;
 const cards=new Map(),toolbarHost=element('div'),listHost=element('div'),empty=element('p','收件箱还没有材料。点击“刷新发现文件”执行一次扫描，再勾选需要整理的文件。');
 const message=element('p');message.setAttribute('role','status');
 async function run(action){if(busy)return;busy=true;const version=generation;message.textContent='正在处理…';try{await action();if(version===generation)message.textContent='操作已保存';}catch(error){if(version===generation)message.textContent=error.message;}finally{if(version===generation){busy=false;render();}}}
 const chosen=()=>items.filter(item=>selected.has(item.itemId));
 async function load(action='list'){
  const library=getLibrary();if(!library?.valid){clear(library?'设置已失效，请先修正设置。':'请先保存知识库设置。');return;}
  const version=generation,result=await requestInbox(action,{id:library.id});if(version!==generation||getLibrary()?.id!==library.id)return;
  libraryId=library.id;
  for(const item of result.items){const before=items.find(value=>value.itemId===item.itemId);if(before&&(before.hash!==item.hash||(before.reviewBasis&&JSON.stringify(before.reviewBasis)!==JSON.stringify(item.reviewBasis))||(before.reviewVersion??0)!==(item.reviewVersion??0))){selected.delete(item.itemId);const draft=drafts.get(item.itemId);if(draft)draft.invalidated=true;}}
  items=result.items;analysisProgress=result.analysisProgress;analysisActive=result.analysisActive??items.some(item=>['analyzing','waiting'].includes(item.status));render();
 }
 function clear(text='正在加载收件箱…'){generation++;busy=false;items=[];selected=new Set();drafts=new Map();cards.clear();listHost.replaceChildren();libraryId=null;tasks.replaceChildren(element('p',text));featured.replaceChildren();more.hidden=true;}
 function render(){
  if(libraryId!==getLibrary()?.id)return;
  if(toolbarHost.parentNode!==tasks)tasks.replaceChildren(toolbarHost,empty,listHost);featured.replaceChildren();more.hidden=true;
  const counts=items.reduce((value,item)=>(value[item.status]=(value[item.status]??0)+1,value),{});
  featured.className='home-guidance';featured.append(element('p',`${items.filter(item=>item.status!=='archived').length} 份未归档 · 可审核 ${counts.reviewable??0} · 分类待定 ${counts['needs-classification']??0} · 已确认 ${counts.confirmed??0} · 失败 ${counts.failed??0}`));
  if(analysisProgress)featured.append(element('p',`分析处理完成 ${analysisProgress.completed} / ${analysisProgress.total} · 信息不足 ${counts['needs-information']??0} · 已归档 ${counts.archived??0}`));
  const toolbar=element('div');toolbar.className='review-toolbar';
  const analyze=control('开始整理所选文件',()=>run(async()=>{await requestInbox('start',{id:libraryId,itemIds:chosen().map(item=>item.itemId)});await load();}),true);
  const review=control('保存所选审核',()=>run(async()=>{for(const item of chosen()){if(!['reviewable','needs-classification','confirmed'].includes(item.status))continue;const draft=drafts.get(item.itemId)??{name:item.suggestion??item.identity,category:item.classification?.category??null,tags:item.tags??[],reviewBasis:item.reviewBasis};if(draft.category===null)throw new Error('请明确选择主分类');const result=await requestInbox('review',{id:libraryId,itemId:item.itemId,...draft,manuallyEdited:drafts.has(item.itemId)}),saved=result.items.find(value=>value.itemId===item.itemId);if(saved)items=items.map(value=>value.itemId===item.itemId?saved:value);drafts.delete(item.itemId);}await load();}));
  const paused=element('input');paused.type='checkbox';paused.id='inbox-writers-paused';paused.checked=writersPaused;paused.onchange=()=>writersPaused=paused.checked;const pausedLabel=element('label');pausedLabel.append(paused,'已暂停 Wiki 等外部写入');
  const archive=control('确认归档所选文件',()=>run(async()=>{if(!paused.checked)throw new Error('请先暂停外部写入并勾选确认');await requestInbox('archive',{id:libraryId,itemIds:chosen().map(item=>item.itemId),requestId:globalThis.crypto.randomUUID(),approved:true,writersPaused:true});selected.clear();await load();}));
  analyze.disabled=busy||!chosen().length;review.disabled=busy||!chosen().some(item=>['reviewable','needs-classification','confirmed'].includes(item.status));archive.disabled=busy||analysisActive||!chosen().length||chosen().some(item=>item.status!=='confirmed');
  toolbar.append(analyze,review,pausedLabel,archive);toolbarHost.replaceChildren(toolbar,message);empty.hidden=!!items.length;
  for(const item of items){
   let nodes=cards.get(item.itemId);
   if(!nodes){const card=element('article'),heading=element('div'),checkbox=element('input'),title=element('strong'),badge=element('span'),info=element('div'),editor=element('div');card.className='review-card';heading.className='section-heading';checkbox.type='checkbox';checkbox.onchange=()=>{if(checkbox.checked){selected.add(item.itemId);const draft=drafts.get(item.itemId);if(draft?.invalidated){draft.reviewBasis=items.find(value=>value.itemId===item.itemId)?.reviewBasis;draft.invalidated=false;}}else selected.delete(item.itemId);render();};const label=element('label');label.append(checkbox,title);heading.append(label,badge);card.append(heading,info,editor);nodes={card,checkbox,title,badge,info,editor};cards.set(item.itemId,nodes);listHost.append(card);}
   const {checkbox,title,badge,info,editor}=nodes;checkbox.checked=selected.has(item.itemId);checkbox.disabled=busy||!item.available||['archived','excluded'].includes(item.status);checkbox.setAttribute('aria-label','选择 '+item.identity);title.textContent=item.identity;badge.textContent=labels[item.status]??item.status;badge.className='status-badge';info.replaceChildren();
   if(item.stage&&item.status==='analyzing'){const stage=({segment:'正文分段',synthesis:'摘要汇总',search:'分类检索',choice:'主分类选择',preparing:'检查来源'})[item.stage]??item.stage;info.append(element('p','当前阶段：'+stage+(item.progress?.totalSteps?` ${item.progress.completed??item.progress.step??0}/${item.progress.totalSteps}`:'')));}
   if(item.analysis?.summary)info.append(element('p',item.analysis.summary));
   for(const text of [item.invalidatedReason,item.error,drafts.get(item.itemId)?.invalidated?'审核依据已变化，旧选择已撤销；以下保留草稿，须重新审核。':null])if(text)info.append(element('p',text));
   if(item.classification?.decision){const reasons={existing:'复用已有分类','missing-category':'现有分类缺少合适归属','cross-topic':'跨主题主次待定','insufficient-evidence':'分类证据不足',undetermined:'主分类待定',manual:'人工选择主分类'};info.append(element('p',reasons[item.classification.decision]??'主分类待定'));}
   if(item.classification?.considered?.length)info.append(element('p','考虑的候选：'+item.classification.considered.map(value=>value||'Raw 根目录').join('、')));
   else if(['needs-classification','needs-information'].includes(item.status))info.append(element('p','没有可靠候选。'+(item.classification?.reason??'正文信息不足，请补充后重新处理。')));
   const editable=['reviewable','needs-classification','confirmed'].includes(item.status);
   if(editable||drafts.has(item.itemId)){
    const draft=drafts.get(item.itemId)??{name:item.suggestion??item.identity,category:item.classification?.category??null,tags:item.tags??[],reviewBasis:item.reviewBasis};
    if(!nodes.name){nodes.name=element('input');nodes.category=element('select');nodes.tags=element('input');const nameLabel=element('label','归档名称'),categoryLabel=element('label','主分类'),tagsLabel=element('label','其他主题标签（用顿号或逗号分隔）');nameLabel.append(nodes.name);categoryLabel.append(nodes.category);tagsLabel.append(nodes.tags);editor.append(nameLabel,categoryLabel,tagsLabel);}
    const {name,category,tags}=nodes;
    if(document.activeElement!==name)name.value=draft.name;name.disabled=busy||!!item.confirmedName;name.setAttribute('aria-label','归档名称 '+item.identity);name.oninput=()=>{draft.name=name.value;drafts.set(item.itemId,draft);};
    category.disabled=busy;category.setAttribute('aria-label','主分类 '+item.identity);
    if(document.activeElement!==category){category.replaceChildren();
    const placeholder=element('option','请选择主分类');placeholder.value='__unselected__';category.append(placeholder);
    for(const value of new Set([...(item.classification?.options??['']),...(item.classification?.considered??[]),...(typeof item.classification?.category==='string'?[item.classification.category]:[]),...(typeof draft.category==='string'?[draft.category]:[])])){const option=element('option',value||'Raw 根目录');option.value=value;category.append(option);}category.value=draft.category??'__unselected__';}
    category.onchange=()=>{draft.category=category.value==='__unselected__'?null:category.value;drafts.set(item.itemId,draft);};
    if(document.activeElement!==tags)tags.value=(draft.tags??[]).join('、');tags.disabled=busy;tags.setAttribute('aria-label','主题标签 '+item.identity);tags.oninput=()=>{draft.tags=tags.value.split(/[,，、]/).map(value=>value.trim()).filter(Boolean);drafts.set(item.itemId,draft);};
    info.append(element('p','归档位置：'+(item.targetPath??'保存审核后生成')));if(item.classification?.reason)info.append(element('p',item.classification.reason));
   }else{editor.replaceChildren();delete nodes.name;delete nodes.category;delete nodes.tags;if(item.status==='archived')info.append(element('p','归档位置：'+item.targetPath),element('p','主题标签：'+(item.tags?.join('、')||'无')));}
  }
  if(!tasks.querySelector('details')){const old=element('details'),summary=element('summary','历史记录与恢复');old.append(summary);const content=element('div');old.append(content);summary.onclick=()=>history(content);tasks.append(old);}
 }
 const timer=setInterval(()=>{if(!busy&&items.some(item=>['analyzing','waiting'].includes(item.status)))void load().catch(error=>message.textContent=error.message);},1200);timer.unref?.();
 return {clear,load,scan:()=>run(()=>load('scan'))};
}
