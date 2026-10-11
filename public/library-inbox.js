import {element} from './batch-ui.js';
import {appendNewCategoryReview} from './new-category-review.js';
import {appendClassificationRuleReview,appendClassificationRules} from './classification-rule-review.js';

export async function requestInbox(action,input){
 const {token}=await(await fetch('/api/session')).json();
 const response=await fetch('/api/inbox/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)}),result=await response.json();
 if(!response.ok)throw Object.assign(new Error(result.error),result);return result;
}
const labels={pending:'待处理',waiting:'等待分析',analyzing:'分析中',paused:'等待手动继续',reviewable:'可审核','needs-classification':'分类待定','needs-information':'信息不足',failed:'失败',confirmed:'已确认待归档',archived:'已归档',missing:'来源缺失',excluded:'已保留原处'};
const control=(label,action,primary=false)=>{const button=element('button',label);button.type='button';button.className=primary?'primary':'';button.onclick=action;return button;};

// 草稿与勾选独立于后台快照，轮询不覆盖用户尚未保存的修改。
export function createLibraryInboxHome({tasks,featured,more,getLibrary,history}){
 let items=[],generation=0,busy=false,selected=new Set(),drafts=new Map(),libraryId=null,writersPaused=false,analysisProgress=null,classificationRules=[];
 const message=element('p');message.setAttribute('role','status');
 async function run(action){if(busy)return;busy=true;const version=generation;message.textContent='正在处理…';try{await action();if(version===generation)message.textContent='操作已保存';}catch(error){if(version===generation)message.textContent=error.message;}finally{if(version===generation){busy=false;render();}}}
 const chosen=()=>items.filter(item=>selected.has(item.itemId));
 async function load(action='list'){
  const library=getLibrary();if(!library?.valid){clear(library?'设置已失效，请先修正设置。':'请先保存知识库设置。');return;}
  const version=generation,result=await requestInbox(action,{id:library.id});if(version!==generation||getLibrary()?.id!==library.id)return;
  libraryId=library.id;items=result.items;analysisProgress=result.analysisProgress;classificationRules=result.classificationRules??classificationRules;for(const item of items)if(!['reviewable','needs-classification','confirmed'].includes(item.status))drafts.delete(item.itemId);render();
 }
 function clear(text='正在加载收件箱…'){generation++;busy=false;items=[];selected=new Set();drafts=new Map();classificationRules=[];libraryId=null;tasks.replaceChildren(element('p',text));featured.replaceChildren();more.hidden=true;}
 function render(){
  if(libraryId!==getLibrary()?.id)return;
  tasks.replaceChildren();featured.replaceChildren();more.hidden=true;
  const counts=items.reduce((value,item)=>(value[item.status]=(value[item.status]??0)+1,value),{});
  featured.className='home-guidance';featured.append(element('p',`${items.filter(item=>item.status!=='archived').length} 份未归档 · 可审核 ${counts.reviewable??0} · 分类待定 ${counts['needs-classification']??0} · 已确认 ${counts.confirmed??0} · 失败 ${counts.failed??0}`));
  if(analysisProgress)featured.append(element('p',`分析处理完成 ${analysisProgress.completed} / ${analysisProgress.total} · 信息不足 ${counts['needs-information']??0} · 已归档 ${counts.archived??0}`));
  appendClassificationRules(featured,classificationRules);
  const toolbar=element('div');toolbar.className='review-toolbar';
  const analyze=control('开始整理所选文件',()=>run(async()=>{await requestInbox('start',{id:libraryId,itemIds:chosen().map(item=>item.itemId)});await load();}),true);
  const review=control('保存所选审核',()=>run(async()=>{for(const item of chosen()){if(!['reviewable','needs-classification','confirmed'].includes(item.status))continue;const draft=drafts.get(item.itemId)??{name:item.suggestion??item.identity,category:item.classification?.category??null,tags:item.tags??[]};if(draft.category===null)throw new Error('请明确选择主分类');await requestInbox('review',{id:libraryId,itemId:item.itemId,...draft,manuallyEdited:drafts.has(item.itemId)});drafts.delete(item.itemId);}await load();}));
  const paused=element('input');paused.type='checkbox';paused.id='inbox-writers-paused';paused.checked=writersPaused;paused.onchange=()=>writersPaused=paused.checked;const pausedLabel=element('label');pausedLabel.append(paused,'已暂停 Wiki 等外部写入');
  const archive=control('确认归档所选文件',()=>run(async()=>{if(!paused.checked)throw new Error('请先暂停外部写入并勾选确认');await requestInbox('archive',{id:libraryId,itemIds:chosen().map(item=>item.itemId),requestId:globalThis.crypto.randomUUID(),approved:true,writersPaused:true});selected.clear();await load();}));
  analyze.disabled=busy||!chosen().length;review.disabled=busy||!chosen().some(item=>['reviewable','needs-classification','confirmed'].includes(item.status));archive.disabled=busy||!chosen().length||chosen().some(item=>item.status!=='confirmed');
  toolbar.append(analyze,review,pausedLabel,archive);tasks.append(toolbar,message);
  if(!items.length)tasks.append(element('p','收件箱还没有材料。点击“刷新发现文件”执行一次扫描，再勾选需要整理的文件。'));
  for(const item of items){
   const card=element('article');card.className='review-card';const heading=element('div');heading.className='section-heading';
   const checkbox=element('input');checkbox.type='checkbox';checkbox.checked=selected.has(item.itemId);checkbox.disabled=busy||!item.available||['archived','excluded'].includes(item.status);checkbox.setAttribute('aria-label','选择 '+item.identity);checkbox.onchange=()=>{checkbox.checked?selected.add(item.itemId):selected.delete(item.itemId);render();};
   const title=element('label');title.append(checkbox,element('strong',item.identity));const badge=element('span',labels[item.status]??item.status);badge.className='status-badge';heading.append(title,badge);card.append(heading);
   if(item.stage&&item.status==='analyzing'){const stage=({segment:'正文分段',synthesis:'摘要汇总',search:'分类检索',choice:'主分类选择',preparing:'检查来源'})[item.stage]??item.stage;card.append(element('p','当前阶段：'+stage+(item.progress?.totalSteps?` ${item.progress.completed??item.progress.step??0}/${item.progress.totalSteps}`:'')));}
   if(item.analysis?.summary)card.append(element('p',item.analysis.summary));
   if(item.invalidatedReason)card.append(element('p',item.invalidatedReason));
   if(item.error)card.append(element('p',item.error));
   if(item.failure)card.append(element('p',`${item.failure.scope==='model'?'同模型配置已停止派发':'本篇文章已停止新请求'} · 已尝试 ${item.failure.attempts} 次；修复原因后重试，仅补齐未完成工作。`));
   if(item.progress?.retry)card.append(element('p',`${item.progress.retry.status==='waiting'?'退避等待':'正在重试'} ${item.progress.retry.attempt}/${item.progress.retry.maxAttempts}`));
   if(item.status==='failed'){const retry=control('重试此文件',()=>run(async()=>{await requestInbox('start',{id:libraryId,itemIds:[item.itemId]});await load();}));retry.disabled=busy||!item.available;card.append(retry);}
   if(item.classification?.decision){const reasons={existing:'复用已有分类','missing-category':'现有分类缺少合适归属','cross-topic':'跨主题主次待定','insufficient-evidence':'分类证据不足',undetermined:'主分类待定',manual:'人工选择主分类'};card.append(element('p',reasons[item.classification.decision]??'主分类待定'));}
   if(item.classification?.considered?.length)card.append(element('p','考虑的候选：'+item.classification.considered.map(value=>value||'Raw 根目录').join('、')));
   else if(['needs-classification','needs-information'].includes(item.status))card.append(element('p','没有可靠候选。'+(item.classification?.reason??'正文信息不足，请补充后重新处理。')));
   if(['reviewable','needs-classification','confirmed'].includes(item.status)){
    const draft=drafts.get(item.itemId)??{name:item.suggestion??item.identity,category:item.classification?.category??null,tags:item.tags??[]};
    if(item.status==='confirmed'&&item.classification?.newCategoryAccepted&&!drafts.has(item.itemId)){draft.acceptNewCategory=true;draft.newCategoryHash=item.classification.newCategory.proposalHash;}
    const name=element('input');name.value=draft.name;name.setAttribute('aria-label','归档名称 '+item.identity);name.oninput=()=>{draft.name=name.value;drafts.set(item.itemId,draft);};
    const category=element('select');category.setAttribute('aria-label','主分类 '+item.identity);
    const placeholder=element('option','请选择主分类');placeholder.value='__unselected__';category.append(placeholder);
    for(const value of new Set([...(item.classification?.options??['']),...(item.classification?.considered??[]),...(typeof item.classification?.category==='string'?[item.classification.category]:[])])){const option=element('option',value||'Raw 根目录');option.value=value;category.append(option);}category.value=draft.category??'__unselected__';category.onchange=()=>{draft.category=category.value==='__unselected__'?null:category.value;drafts.set(item.itemId,draft);};
    const nameLabel=element('label','归档名称');nameLabel.append(name);const categoryLabel=element('label','主分类');categoryLabel.append(category);card.append(nameLabel,categoryLabel,element('p','归档位置：'+(item.targetPath??'保存审核后生成')));
    const tags=element('input');tags.value=(draft.tags??[]).join('、');tags.setAttribute('aria-label','主题标签 '+item.identity);tags.oninput=()=>{draft.tags=tags.value.split(/[,，、]/).map(value=>value.trim()).filter(Boolean);drafts.set(item.itemId,draft);};const tagsLabel=element('label','其他主题标签（用顿号或逗号分隔）');tagsLabel.append(tags);card.append(tagsLabel);
    if(item.classification?.reason)card.append(element('p',item.classification.reason));
    appendNewCategoryReview(card,item,draft,()=>drafts.set(item.itemId,draft));
    appendClassificationRuleReview(card,item,draft,()=>drafts.set(item.itemId,draft));
   }else if(item.status==='archived'){card.append(element('p','归档位置：'+item.targetPath),element('p','主题标签：'+(item.tags?.join('、')||'无')));appendNewCategoryReview(card,item,{},()=>{});}
   tasks.append(card);
  }
  const old=element('details'),summary=element('summary','历史记录与恢复');old.append(summary);const content=element('div');old.append(content);summary.onclick=()=>history(content);tasks.append(old);
 }
 const timer=setInterval(()=>{if(!busy&&items.some(item=>['analyzing','waiting'].includes(item.status)))void load().catch(error=>message.textContent=error.message);},1200);timer.unref?.();
 return {clear,load,scan:()=>run(()=>load('scan'))};
}
