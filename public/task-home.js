import {element,statusName,requestBatch} from './batch-ui.js';
import {reportStatus,reportSummary} from './report-ui.js';

export const taskUrl=batch=>`/?batchId=${encodeURIComponent(batch.batchId)}`;
const reportUrl=batch=>'/task-report?batchId='+encodeURIComponent(batch.batchId);
const link=(label,url,primary=false)=>{const node=element('a',label);node.href=url;node.className=primary?'button primary':'button';return node;};
const key=value=>value.replaceAll('\\','/').replace(/\/$/,'').toLowerCase();
const finished=batch=>batch.report?.status==='complete';
const title=batch=>`${batch.mode==='inbox'?'日常整理':'首次重构'} · ${new Date(batch.createdAt??batch.updatedAt).toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'})}`;
function state(batch){
 const report=batch.report,job=batch.analysisJob?.status;
 if(report?.status==='needs-recovery'||batch.interrupted)return {label:'需要恢复',action:'查看恢复',url:reportUrl(batch),tone:'warning'};
 if(finished(batch))return {label:'已完成',action:'查看报告',url:reportUrl(batch),tone:'complete'};
 if(['running','pausing','paused','interrupted','failed'].includes(job))return {label:({running:'正在分析',pausing:'正在暂停',paused:'已暂停',interrupted:'分析中断',failed:'分析失败'})[job],action:'继续任务',url:taskUrl(batch),tone:job==='failed'?'warning':'neutral'};
 if(batch.flow?.tree?.status==='proposed'||batch.flow?.tree?.status==='stale')return {label:batch.flow.tree.status==='stale'?'分类树需要重审':'分类树待审核',action:'审核分类树',url:taskUrl(batch)};
 if(report&&report.status!=='pending')return {label:reportStatus(report.status),action:report.status==='failed'?'查看报告':'继续任务',url:report.status==='failed'?reportUrl(batch):taskUrl(batch),tone:'warning'};
 const reviewable=batch.phase==='file-review'||(batch.mode==='inbox'&&batch.phase==='analysis-complete'&&((batch.counts.classified??0)+(batch.counts.reviewed??0)>0));
 return {label:reviewable?'待审核':statusName(batch.phase),action:reviewable?'继续审核':'继续任务',url:taskUrl(batch)};
}
function progress(batch){
 if(batch.report?.hasExecution)return reportSummary(batch.report);
 if(['running','pausing','paused','interrupted','failed'].includes(batch.analysisJob?.status)&&batch.analysisProgress)return `${batch.counts.total} 份材料 · 已分析 ${batch.analysisProgress.total-batch.analysisProgress.remaining} / ${batch.analysisProgress.total}`;
 if(batch.flow?.tree?.status==='proposed')return '等待确认分类方案';
 const ready=(batch.counts.classified??0)+(batch.counts.reviewed??0);
 return `${batch.counts.total} 份材料${ready?` · ${ready} 份可审核`:' · 尚未归档'}`;
}
const badge=view=>{const node=element('span',view.label);node.className='status-badge '+(view.tone??'');return node;};

// 完整读取公开分页后只展示当前库；重点任务不会受其他库或第一页排序影响。
export function createTaskHome({tasks,featured,more,getLibrary}){
 let records=[],visible=25,generation=0,recordLibrary=null;
 function render(){
  tasks.replaceChildren();featured.replaceChildren();
  const candidate=records.find(batch=>!finished(batch));
  if(candidate){
   const view=state(candidate),icon=element('span','▤'),content=element('div'),heading=element('h2',title(candidate));icon.className='featured-icon';content.className='featured-content';heading.append(badge(view));
   content.append(element('p','继续上次任务'),heading,element('p',progress(candidate)),element('small','更新于 '+new Date(candidate.updatedAt).toLocaleString('zh-CN')));
   featured.append(icon,content,link(view.action,view.url,true));featured.className='featured-task';
  }else{featured.className='home-guidance';featured.append(element('p',records.length?'所有任务均已完成。可以从收件箱开始新的整理。':'还没有整理任务。选择材料范围，创建第一个任务。'));}
  if(records.length){
   const grid=element('table'),head=element('thead'),row=element('tr'),body=element('tbody');
   for(const name of ['任务与材料范围','当前阶段','进度','操作'])row.append(element('th',name));head.append(row);grid.append(head,body);
   for(const batch of records.slice(0,visible)){
    const view=state(batch),row=element('tr'),name=element('td'),heading=element('strong',title(batch)),phase=element('td'),actions=element('td');
    name.append(heading,element('p',batch.mode==='inbox'?'收件箱':'全部 Raw'),element('small','更新于 '+new Date(batch.updatedAt).toLocaleString('zh-CN')));
    phase.append(badge(view));actions.append(link(view.action,view.url,!finished(batch)&&view.url===taskUrl(batch)));
    if(view.url!==reportUrl(batch))actions.append(link('报告与恢复',reportUrl(batch)));
    row.append(name,phase,element('td',progress(batch)),actions);body.append(row);
   }
   tasks.append(grid);
  }else tasks.append(element('p','暂无整理任务。'));
  more.hidden=visible>=records.length;
 }
 return {clear(message='正在加载当前知识库任务…'){generation++;records=[];recordLibrary=null;tasks.replaceChildren(element('p',message));featured.replaceChildren();more.hidden=true;},async load(append=false){
  if(append){if(recordLibrary===getLibrary()?.id){visible+=25;render();}return;}
  this.clear();visible=25;const library=getLibrary();if(!library?.valid){this.clear(library?'设置已失效，请先修正知识库设置。':'尚未配置知识库，请先保存设置。');return;}
  const current= generation;const all=[];let cursor=0;
  try{do{const page=await requestBatch('list',{cursor,limit:50});if(current!==generation||getLibrary()?.id!==library.id)return;all.push(...page.records.filter(batch=>key(batch.libraryPath)===key(library.libraryPath)));cursor=page.nextCursor;}while(cursor!==null);
   recordLibrary=library.id;records=all.sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)||(a.batchId<b.batchId?-1:a.batchId>b.batchId?1:0));render();
  }catch(error){if(current!==generation)return;this.clear('任务加载失败，请点击刷新重试。');throw error;}
 }};
}
