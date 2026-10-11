import {element} from './batch-ui.js';

// 后续偏好必须由用户明确选择；当前文件审核不自动推广。
export function appendClassificationRuleReview(host,item,draft,onChange){
 const scope=element('p','默认只修改当前文件；后续规则仅影响本知识库新建议，仍需逐文件审核。');
 if(item.classification?.newCategory)scope.append(' 新类别偏好保存为待生效规则；明确确认归档并落地后才参与后续建议，保存规则不会建目录。');
 const save=element('input');save.type='checkbox';save.checked=draft.saveClassificationRule===true;save.setAttribute('aria-label','保存后续分类规则 '+item.identity);
 const label=element('label');label.append(save,'将本次分类偏好保存为本知识库的后续规则');
 const instruction=element('textarea');instruction.value=draft.ruleText??'';instruction.maxLength=1000;instruction.setAttribute('aria-label','后续分类规则 '+item.identity);instruction.placeholder='例如：缓存一致性资料优先归属数据库类别。请说明适用主题和范围。';instruction.disabled=!save.checked;
 save.onchange=()=>{draft.saveClassificationRule=save.checked;instruction.disabled=!save.checked;onChange();};instruction.oninput=()=>{draft.ruleText=instruction.value;onChange();};host.append(scope,label,instruction);
}

export function appendClassificationRules(host,rules=[]){
 if(!rules.length)return;const details=element('details'),summary=element('summary',`本知识库已保存分类规则（${rules.length}）`);details.append(summary);for(const rule of rules){const status=({active:'已生效', 'waiting-category':'待生效：等待已接受的新类别确认归档落地','category-mismatch':'未生效：实际类别提议身份不匹配','category-unavailable':'未生效：类别已不可用'})[rule.status]??'';details.append(element('p',`${rule.instruction} → ${rule.category||'Raw 根目录'}；${status}；仅供后续建议参考，仍需审核。`));}host.append(details);
}
