import {createTaskHome,taskUrl} from './task-home.js';
import {mountRestructureWorkspace} from './restructure-workspace.js';
import {mountReviewWorkspace} from './review-workspace.js';
import {element,requestBatch} from './batch-ui.js';
const $=selector=>document.querySelector(selector);
let libraries=[],selected=null,editing=null,busy=false,contextVersion=0,category='',reviewWorkspace=null;
async function api(action,input={}) {
 const {token}=await(await fetch('/api/session')).json();
 const response=await fetch('/api/workspace/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)});
 const result=await response.json();if(!response.ok)throw new Error(result.error?.message??result.error);return result;
}
async function run(action){if(busy)return;const version=contextVersion;busy=true;$('#error').textContent='';try{await action(version);}catch(error){if(version===contextVersion)$('#error').textContent=error.message;}finally{if(version===contextVersion)busy=false;}}
function show(name,title){
 for(const id of ['home','browse','settings','task-workspace'])$('#'+id).hidden=id!==name;
 $('#title').textContent=title;$('#start').hidden=name!=='home';if($('#home-intro'))$('#home-intro').hidden=name!=='home';
 $('#page-label').textContent=({home:'任务首页',browse:'分类浏览',settings:'知识库设置','task-workspace':'集中审核'})[name];
 for(const [id,page] of [['home-nav','home'],['browse-nav','browse'],['settings-nav','settings']])$('#'+id).setAttribute('aria-current',name===page||(name==='task-workspace'&&page==='home')?'page':'false');
}
function settings(record=selected){editing=record;for(const input of $('#settings-form').querySelectorAll('input'))input.value=record?.[input.name]??'';show('settings','知识库设置');}
export {taskUrl};
const home=createTaskHome({tasks:$('#tasks'),featured:$('#featured'),more:$('#more'),getLibrary:()=>selected});
function environment(){
 $('#library').title=selected?.libraryPath??'';
 $('#notice').textContent=selected?(selected.valid?'● 设置已校验':selected.error??'设置已失效，请修正。'):'尚未配置知识库，请补齐位置并保存。';
 $('#start button').disabled=!selected?.valid;
}
async function loadLibraries(preferred,version=contextVersion){
 const result=await api('list');if(version!==contextVersion)return false;
 libraries=result.libraries;$('#library').replaceChildren();
 for(const record of libraries){const option=element('option',(record.libraryPath.replaceAll('\\','/').split('/').filter(Boolean).at(-1)||record.libraryPath)+(record.valid?'':'（需修正）'));option.value=record.id;option.title=record.libraryPath;$('#library').append(option);}
 selected=libraries.find(record=>record.id===preferred)??libraries[0]??null;
 if(selected)$('#library').value=selected.id;else $('#library').append(element('option','请先设置知识库'));
 environment();return true;
}
async function categories(){
 const version=contextVersion;$('#categories').replaceChildren();if(!selected?.valid){$('#categories').append(element('p','保存有效设置后显示真实分类。'));return;}
 const result=await api('categories',{id:selected.id});if(version!==contextVersion)return;
 for(const item of result.categories){const button=element('button',item.path||'Raw 根目录');button.onclick=()=>run(()=>browse(item.path));button.dataset.category=item.path;$('#categories').append(button);}
}
async function browse(value,cursor=0){
 if(!selected?.valid){settings();return;}
 const version=contextVersion;category=value;show('browse',category||'Raw 根目录');$('#files').replaceChildren(element('p','正在加载分类材料…'));
 const result=await api('categories',{id:selected.id,category,cursor});if(version!==contextVersion)return;
 $('#category-description').textContent=result.categories.find(item=>item.path===category)?.description||'当前分类中的材料';$('#files').replaceChildren();
 for(const file of result.files)$('#files').append(element('p',file.name),element('small',file.path));
 if(!result.total)$('#files').append(element('p','此分类暂无 Markdown 材料。'));
 $('#files-more').hidden=result.nextCursor===null;$('#files-more').onclick=()=>run(()=>browse(category,result.nextCursor));
 for(const button of document.querySelectorAll('#categories button'))button.setAttribute('aria-current',String(button.dataset.category===category));
}
async function reload(version,preferred=selected?.id){
 home.clear();$('#notice').textContent='正在校验知识库设置…';$('#start button').disabled=true;
 try{if(!await loadLibraries(preferred,version))return;await categories();if(version===contextVersion)await home.load();}
 catch(error){if(version===contextVersion){selected=null;$('#start button').disabled=true;$('#notice').textContent='知识库加载失败，请刷新重试或检查设置。';home.clear('加载失败，请点击刷新任务重试。');}throw error;}
}
$('#home-nav').onclick=()=>run(async()=>{show('home','整理任务');await home.load();});
$('#browse-nav').onclick=()=>run(()=>browse(''));
$('#settings-nav').onclick=()=>settings();$('#new-library').onclick=()=>settings(null);
$('#library').onchange=()=>{
 // 切库不受旧请求的 busy 锁阻挡；代次令牌阻止迟到结果回填。
 contextVersion++;busy=false;selected=libraries.find(record=>record.id===$('#library').value)??null;
 home.clear();$('#categories').replaceChildren();$('#files').replaceChildren();$('#task-workspace').hidden=true;$('#task-workspace').replaceChildren();reviewWorkspace=null;
 show('home','整理任务');environment();return run(version=>reload(version));
};
$('#refresh').onclick=()=>run(version=>reload(version));$('#more').onclick=()=>run(()=>home.load(true));
$('#settings-form').onsubmit=event=>{event.preventDefault();return run(async version=>{const record=await api('save',{...Object.fromEntries(new FormData(event.target)),...(editing?{id:editing.id,revision:editing.revision}:{})});if(version!==contextVersion)return;show('home','整理任务');await reload(version,record.id);});};
$('#start').onsubmit=event=>{event.preventDefault();return run(async version=>{
 if(!selected?.valid)throw new Error('请先修正知识库设置');
 const button=$('#start button'),label=button.textContent;
 button.disabled=true;button.textContent='正在创建任务…';$('#library').disabled=true;
 $('#start').setAttribute('aria-busy','true');$('#notice').textContent='正在校验材料并创建任务，请稍候。';
 try{const batch=await api('create',{id:selected.id,mode:$('#mode').value});if(version===contextVersion)location.href=taskUrl(batch);}
 finally{button.disabled=!selected?.valid;button.textContent=label;$('#library').disabled=false;$('#start').removeAttribute('aria-busy');if(version===contextVersion)environment();}
});};
run(async version=>{
 await reload(version);if(version!==contextVersion)return;
 const batchId=new URLSearchParams(location.search).get('batchId');
 if(batchId){
  const task=await requestBatch('get',{batchId});if(version!==contextVersion)return;
  const library=libraries.find(record=>record.libraryPath.replaceAll('\\','/').toLowerCase()===task.libraryPath.replaceAll('\\','/').toLowerCase());
  if(!library?.valid)throw new Error('此任务的知识库未配置或设置失效，请先修正设置。');
  selected=library;$('#library').value=library.id;environment();await categories();if(version!==contextVersion)return;
  show('task-workspace',task.mode==='restructure'?'首次重构':'集中审核整理方案');
  reviewWorkspace=await (task.mode==='restructure'?mountRestructureWorkspace:mountReviewWorkspace)($('#task-workspace'),batchId);
 }else if(!selected||!selected.valid)settings();
});
