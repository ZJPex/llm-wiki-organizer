import {createCategoryBrowser} from './category-browser.js';
import {createTaskHome,taskUrl,libraryPathKey} from './task-home.js';
import {mountRestructureWorkspace} from './restructure-workspace.js';
import {mountReviewWorkspace} from './review-workspace.js';
import {element,requestBatch} from './batch-ui.js';
const $=selector=>document.querySelector(selector);
let libraries=[],selected=null,editing=null,busy=false,contextVersion=0,reviewWorkspace=null,navigationVersion=0;
async function api(action,input={}) {
 const {token}=await(await fetch('/api/session')).json();
 const response=await fetch('/api/workspace/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)});
 const result=await response.json();if(!response.ok)throw new Error(result.error?.message??result.error);return result;
}
async function run(action){if(busy)return;const version=contextVersion;busy=true;$('#error').textContent='';try{await action(version);}catch(error){if(version===contextVersion)$('#error').textContent=error.message;}finally{if(version===contextVersion)busy=false;}}
function show(name,title){
 navigationVersion++;
 if(name!=='browse')categoryBrowser.clear();
 for(const id of ['home','browse','settings','task-workspace'])$('#'+id).hidden=id!==name;
 $('#title').textContent=title;$('#start').hidden=name!=='home';if($('#home-intro'))$('#home-intro').hidden=name!=='home';
 $('#page-label').textContent=({home:'任务首页',browse:'分类浏览',settings:'知识库设置','task-workspace':'集中审核'})[name];
 for(const [id,page] of [['home-nav','home'],['browse-nav','browse'],['settings-nav','settings']])$('#'+id).setAttribute('aria-current',name===page||(name==='task-workspace'&&page==='home')?'page':'false');
}
let newLibraryIntent=false;const editedSettingsFields=new Set();
function settings(record=selected){
 newLibraryIntent=arguments.length>0&&record===null;editing=record;editedSettingsFields.clear();
 for(const input of $('#settings-form').querySelectorAll('input')){input.value=record?.[input.name]??'';input.oninput=()=>editedSettingsFields.add(input.name);}
 show('settings','知识库设置');
}
function completeSettingsEnvironment(){
 if(newLibraryIntent)return;
 editing=selected;
 for(const input of $('#settings-form').querySelectorAll('input'))if(!editedSettingsFields.has(input.name))input.value=selected?.[input.name]??'';
}
export {taskUrl};
const categoryBrowser=createCategoryBrowser({tree:$('#categories'),content:$('#category-content')??$('#files'),getLibrary:()=>selected});
const home=createTaskHome({tasks:$('#tasks'),featured:$('#featured'),more:$('#more'),getLibrary:()=>selected});
function environment(){
 $('#library').title=selected?.libraryPath??'';
 $('#notice').textContent=selected?(selected.valid?'● 设置已校验':selected.error??'设置已失效，请修正。'):'尚未配置知识库，请补齐位置并保存。';
 $('#start button').disabled=!selected?.valid;
}
function libraryLabel(record){
 const parts=record.libraryPath.replaceAll('\\','/').split('/').filter(Boolean);
 for(let length=1;length<=parts.length;length++){const label=parts.slice(-length).join('/');if(!libraries.some(other=>other.id!==record.id&&libraryPathKey(other.libraryPath).split('/').slice(-length).join('/')===libraryPathKey(label)))return label;}
 return record.libraryPath;
}
async function loadLibraries(preferred,version=contextVersion){
 const result=await api('list');if(version!==contextVersion)return false;
 libraries=result.libraries;$('#library').replaceChildren();
 for(const record of libraries){const option=element('option',libraryLabel(record)+(record.valid?'':'（需修正）'));option.value=record.id;option.title=record.libraryPath;$('#library').append(option);}
 selected=libraries.find(record=>record.id===preferred)??libraries[0]??null;
 if(selected)$('#library').value=selected.id;else $('#library').append(element('option','请先设置知识库'));
 environment();return true;
}
async function categories(){categoryBrowser.clear();}
async function browse(value=''){
 if(!selected?.valid){settings();return;}
 show('browse','分类浏览');await categoryBrowser.open(value);
}
async function loadEnvironment(version,preferred=selected?.id){
 home.clear();$('#notice').textContent='正在校验知识库设置…';$('#start button').disabled=true;
 try{if(!await loadLibraries(preferred,version))return false;}
 catch(error){if(version===contextVersion){$('#start button').disabled=true;$('#notice').textContent='知识库加载失败，请刷新重试或检查设置。';home.clear('加载失败，请点击刷新任务重试。');}throw error;}
 await categories();return version===contextVersion;
}
async function reload(version,preferred=selected?.id){if(await loadEnvironment(version,preferred))await home.load();}
$('#home-nav').onclick=()=>run(async()=>{show('home','整理任务');await home.load();});
$('#browse-nav').onclick=()=>browse('');
$('#settings-nav').onclick=()=>settings();$('#new-library').onclick=()=>settings(null);
$('#library').onchange=()=>{
 // 切库不受旧请求的 busy 锁阻挡；代次令牌阻止迟到结果回填。
 contextVersion++;busy=false;selected=libraries.find(record=>record.id===$('#library').value)??null;
 home.clear();categoryBrowser.clear();$('#task-workspace').hidden=true;$('#task-workspace').replaceChildren();reviewWorkspace=null;
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
 const navigationAtStart=navigationVersion;
 if(!await loadEnvironment(version))return;
 // 用户已经选择其他页面时，初始化只补齐环境，不覆盖当前导航。
 if(navigationVersion!==navigationAtStart){if(!$('#settings').hidden)completeSettingsEnvironment();return;}
 const params=new URLSearchParams(location.search),batchId=params.get('batchId');
 if(batchId){
  const task=await requestBatch('get',{batchId});if(version!==contextVersion||navigationVersion!==navigationAtStart)return;
  const library=libraries.find(record=>libraryPathKey(record.libraryPath)===libraryPathKey(task.libraryPath));
  if(!library?.valid)throw new Error('此任务的知识库未配置或设置失效，请先修正设置。');
  selected=library;$('#library').value=library.id;environment();await categories();if(version!==contextVersion)return;
  show('task-workspace',task.mode==='restructure'?'首次重构':'集中审核整理方案');
  reviewWorkspace=await (task.mode==='restructure'?mountRestructureWorkspace:mountReviewWorkspace)($('#task-workspace'),batchId);
 }else if(!selected||!selected.valid||params.get('view')==='settings')settings();
 else if(params.get('view')==='browse')await browse('');
 else {show('home','整理任务');await home.load();}
});
