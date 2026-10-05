import {element} from './batch-ui.js';

async function readCategory(input){
 const {token}=await(await fetch('/api/session')).json();
 const response=await fetch('/api/workspace/categories',{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)});
 const result=await response.json();if(!response.ok)throw new Error(result.error?.message??result.error);return result;
}
const nameOf=value=>value.split('/').at(-1)||'Raw 根目录';
function disclosure(label,text){const details=element('details'),summary=element('summary',label);details.append(summary,element('p',text));return details;}

// 页面只调用读取接口；目录展开、材料位置和选择分别拥有原生键盘入口。
export function createCategoryBrowser({tree,content,getLibrary}){
 let category='',catalog=[],files=[],next=null,total=0,loading=false,generation=0;
 const expanded=new Set();
 function renderTree(){
  tree.replaceChildren();const nodes=new Map();
  for(const item of catalog){
   const parts=item.path.split('/').filter(Boolean);
   for(let n=1;n<=parts.length;n++){const path=parts.slice(0,n).join('/');if(!nodes.has(path))nodes.set(path,{path,children:[]});}
   if(!item.path)nodes.set('',{path:'',children:[]});
   nodes.get(item.path).item=item;
  }
  const roots=[];
  for(const node of nodes.values()){const parent=node.path.includes('/')?node.path.slice(0,node.path.lastIndexOf('/')):null;if(parent!==null&&nodes.has(parent))nodes.get(parent).children.push(node);else roots.push(node);}
  function branch(items){
   const list=element('ul');
   for(const node of items){
    const li=element('li'),row=element('div');row.className='category-row';
    let children;
    if(node.children.length){
     const toggle=element('button',expanded.has(node.path)?'⌄':'›');toggle.type='button';toggle.className='category-toggle';
     const update=()=>{toggle.textContent=expanded.has(node.path)?'⌄':'›';toggle.setAttribute('aria-expanded',String(expanded.has(node.path)));toggle.setAttribute('aria-label',(expanded.has(node.path)?'收起 ':'展开 ')+nameOf(node.path));};update();
     toggle.onclick=()=>{if(expanded.has(node.path))expanded.delete(node.path);else expanded.add(node.path);children.hidden=!expanded.has(node.path);update();};row.append(toggle);
    }else {const spacer=element('span');spacer.className='category-toggle-space';row.append(spacer);}
    if(node.item){const select=element('button',nameOf(node.path));select.type='button';select.setAttribute('aria-current',node.path===category?'page':'false');select.onclick=()=>open(node.path);row.append(select);}
    else row.append(element('span',nameOf(node.path)));
    li.append(row);if(node.children.length){children=branch(node.children);children.hidden=!expanded.has(node.path);li.append(children);}list.append(li);
   }
   return list;
  }
  tree.append(branch(roots));if(!catalog.some(item=>item.path))tree.append(element('p','暂无子分类，可浏览 Raw 根目录材料。'));
 }
 function render(){
  content.replaceChildren();const library=getLibrary(),item=catalog.find(item=>item.path===category),parent=category.includes('/')?category.slice(0,category.lastIndexOf('/')):'Raw 根目录';
  const breadcrumb=element('p','分类浏览 / '+parent);breadcrumb.className='category-breadcrumb';
  const title=element('h1',nameOf(category));
  const description=element('p',item?.description||'此分类未提供说明。');description.className='category-description';
  const heading=element('div');heading.className='category-list-heading';heading.append(element('h2',`当前分类 · ${total} 份材料`),disclosure('分类路径',library.libraryPath.replaceAll('\\','/')+'/raw/sources'+(category?'/'+category:'')));
  content.append(breadcrumb,title,description,heading);
  const list=element('div');
  for(const file of files){const article=element('article');article.className='category-file';const identity=element('div'),icon=element('span','▤');icon.setAttribute('aria-hidden','true');icon.className='file-icon';identity.append(element('p',file.name),element('small',category?category.split('/').join(' / '):'Raw 根目录'));article.append(icon,identity,disclosure('路径',file.path));list.append(article);}
  content.append(list);
  const status=element('p',`已显示 ${files.length} 份材料，共 ${total} 份`);status.setAttribute('role','status');content.append(status);
  if(total===0)content.append(element('p','此分类暂无 Markdown 材料。'));
  else if(!files.length)content.append(element('p','本页未返回材料，请重新载入此分类。'));
  if(next!==null){const more=element('button','加载更多材料');more.type='button';more.onclick=()=>open(category,true);content.append(more);}
 }
 async function open(value='',append=false){
  if(append&&(loading||next===null))return;
  const version=++generation,library=getLibrary();if(!library?.valid)return;
  const current=()=>version===generation&&getLibrary()?.id===library.id;
  category=value;loading=true;
  if(!append){files=[];content.replaceChildren(element('p','正在加载分类材料…'));}
  else for(const button of content.querySelectorAll('button')){button.disabled=true;button.textContent='正在加载更多材料…';}
  content.setAttribute('aria-busy','true');
  try{const result=await readCategory({id:library.id,category:value,cursor:append?next:0});if(!current())return;catalog=result.categories;files=[...new Map((append?[...files,...result.files]:result.files).map(file=>[file.path,file])).values()];total=result.total;next=result.nextCursor;renderTree();render();}
  catch(error){if(!current())return;if(append)render();else content.replaceChildren();const message=element('p','分类加载失败：'+error.message);message.setAttribute('role','alert');const retry=element('button','重试加载');retry.onclick=()=>open(value,append);content.append(message,retry);}
  finally{if(current()){loading=false;content.setAttribute('aria-busy','false');}}
 }
 return {open,clear(){generation++;loading=false;category='';catalog=[];files=[];next=null;expanded.clear();tree.replaceChildren();content.replaceChildren();content.setAttribute('aria-busy','false');}};
}
