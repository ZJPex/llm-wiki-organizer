import {element} from './batch-ui.js';

// 类别提议的审核只保存授权；目录创建由确认归档执行。
export function appendNewCategoryReview(card,item,draft,onChange){
 const proposal=item.classification?.newCategory;
 if(proposal){
  const box=element('div');box.className='review-context';box.append(element('strong','新增分类提议：'+proposal.path),element('p','父级：'+(proposal.parent||'Raw 根目录')+' · 名称：'+proposal.label),element('p','归属理由：'+proposal.reason),element('p','查找收益：'+proposal.benefit),element('p','保存审核期间不建目录；确认归档时创建。'));
  if(['reviewable','needs-classification','confirmed'].includes(item.status)){
   const approval=element('input');approval.type='checkbox';approval.checked=draft.acceptNewCategory===true;approval.setAttribute('aria-label','接受新增分类 '+item.identity);approval.onchange=()=>{draft.acceptNewCategory=approval.checked;draft.newCategoryHash=proposal.proposalHash;onChange();};
   const label=element('label');label.append(approval,'已审核并接受新增分类名称、父级和查找收益');box.append(label);
  }card.append(box);
 }
 for(const adjustment of item.classification?.adjustments??[])card.append(element('p',`另列目录调整：${adjustment.type} ${adjustment.from} → ${adjustment.to}；影响类别：${(adjustment.affectedCategories??[adjustment.from]).join('、')} 及其中历史材料；理由：${adjustment.reason}；收益：${adjustment.benefit}。须通过历史调整的副本验证与恢复流程，普通新增归档不执行。`));
}
