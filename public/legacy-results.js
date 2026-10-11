import {element} from './batch-ui.js';

export function appendLegacyResult(host,result){
 const row=element('div');row.className='review-card';
 row.append(element('p',`${result.name??'未命名旧结果'} · ${result.category===null?'主分类待定':result.category||'Raw 根目录'}${result.manuallyEdited?' · 人工确认':''}`),element('p','来源：'+result.originId),element('p',result.reason));
 const link=element('a','查看原任务报告与恢复证据');link.setAttribute('href',result.recoveryUrl);row.append(link);host.append(row);return row;
}
