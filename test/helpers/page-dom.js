import {setTimeout as delay} from 'node:timers/promises';

// 只适配页面实际使用的 DOM 边界；业务请求与事件处理仍由真实页面模块执行。
class PageElement {
 constructor(document,tag){
  this.ownerDocument=document;this.tagName=tag.toUpperCase();this.parentNode=null;this.childNodes=[];
  this.attributes=new Map();this.listeners=new Map();this.id='';this.name='';this.type='';
  this.disabled=false;this.hidden=false;this.checked=false;this.onclick=null;
  this._text='';this._value='';this._selected=false;this._selectedIndex=undefined;
 }
 get children(){return this.childNodes.filter(node=>node.tagName!=='#TEXT');}
 get textContent(){return this._text+this.childNodes.map(node=>node.textContent).join('');}
 set textContent(value){this.replaceChildren();this._text=String(value??'');}
 get value(){return this.tagName==='SELECT'?this.children[this.selectedIndex]?.value??'':this._value;}
 set value(value){
  this._value=String(value);
  if(this.tagName==='SELECT')this.selectedIndex=this.children.findIndex(option=>option.value===this._value);
 }
 get selected(){return this.parentNode?.tagName==='SELECT'?this.parentNode.children[this.parentNode.selectedIndex]===this:this._selected;}
 set selected(value){
  this._selected=Boolean(value);
  if(this._selected&&this.parentNode?.tagName==='SELECT')this.parentNode.selectedIndex=this.parentNode.children.indexOf(this);
 }
 get selectedIndex(){
  if(this._selectedIndex!==undefined)return this._selectedIndex;
  const selected=this.children.findIndex(option=>option._selected);
  return selected>=0?selected:this.children.length?0:-1;
 }
 set selectedIndex(value){this._selectedIndex=Number(value);this.children.forEach((option,index)=>option._selected=index===this._selectedIndex);}
 setAttribute(name,value){
  this.attributes.set(name,String(value));
  if(['id','name','type','value'].includes(name))this[name]=String(value);
  if(['disabled','hidden','checked'].includes(name))this[name]=true;
 }
 getAttribute(name){return this.attributes.get(name)??(['id','name','type'].includes(name)&&this[name]?this[name]:null);}
 append(...nodes){
  for(let node of nodes){
   if(typeof node==='string'){const text=this.ownerDocument.createElement('#text');text.textContent=node;node=text;}
   if(node.parentNode)node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node),1);
   node.parentNode=this;this.childNodes.push(node);
   if(this.tagName==='SELECT'&&node._selected)this.selectedIndex=this.children.indexOf(node);
  }
 }
 prepend(...nodes){const text=this._text;this.replaceChildren(...nodes,...(text?[text]:[]),...this.childNodes);}
 focus(){this.ownerDocument.activeElement=this;}
 after(...nodes){
  const parent=this.parentNode;if(!parent)return;
  let position=parent.childNodes.indexOf(this)+1;
  for(const node of nodes){
   if(node.parentNode)node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node),1);
   node.parentNode=parent;parent.childNodes.splice(position++,0,node);
  }
 }
 replaceChildren(...nodes){for(const child of this.childNodes)child.parentNode=null;this.childNodes=[];this._text='';this.append(...nodes);}
 querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
 querySelectorAll(selector){
  const branches=selector.split(',').map(branch=>branch.trim().split(/\s+/));
  const matches=(node,parts)=>{
   if(!matchesSimple(node,parts.at(-1)))return false;
   let ancestor=node.parentNode;
   for(let index=parts.length-2;index>=0;index--){
    while(ancestor&&ancestor!==this&&!matchesSimple(ancestor,parts[index]))ancestor=ancestor.parentNode;
    if(!ancestor||ancestor===this)return false;
    ancestor=ancestor.parentNode;
   }
   return true;
  };
  const found=[];
  const visit=node=>{for(const child of node.children){if(branches.some(parts=>matches(child,parts)))found.push(child);visit(child);}};
  visit(this);return found;
 }
 addEventListener(type,handler){const handlers=this.listeners.get(type)??[];handlers.push(handler);this.listeners.set(type,handlers);}
 async dispatchEvent(input){
  const event={...input,type:input.type,target:input.target??this,currentTarget:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};
  const handler=this[`on${event.type}`];if(handler)await handler.call(this,event);
  for(const listener of this.listeners.get(event.type)??[])await listener.call(this,event);
  return !event.defaultPrevented;
 }
 async click(){
  if(this.disabled)return;
  const proceed=await this.dispatchEvent({type:'click'});
  if(proceed&&this.tagName==='BUTTON'&&this.type!=='button'){
   let form=this.parentNode;while(form&&form.tagName!=='FORM')form=form.parentNode;
   if(form)await form.requestSubmit(this);
  }
 }
 requestSubmit(submitter){return this.dispatchEvent({type:'submit',submitter});}
}

function matchesSimple(node,selector){
 const parsed=selector.match(/^([\w-]+|\*)?(?:#([\w-]+))?(?:\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\])?$/);
 if(!parsed)throw new Error(`测试 DOM 尚未适配选择器：${selector}`);
 const [,tag,id,attribute,value]=parsed;
 return (!tag||tag==='*'||node.tagName===tag.toUpperCase())&&(!id||node.id===id)&&(!attribute||(value===undefined?node.getAttribute(attribute)!==null:node.getAttribute(attribute)===value));
}

export function createInboxDocument(){
 const document=new PageElement(null,'document');document.ownerDocument=document;
 document.createElement=tag=>new PageElement(document,tag);
 document.body=document.createElement('body');document.append(document.body);
 const main=document.createElement('main');document.body.append(main);
 const add=(parent,tag,id,text)=>{const node=document.createElement(tag);if(id)node.id=id;if(text)node.textContent=text;parent.append(node);return node;};
 const create=add(main,'form','create');
 for(const name of ['libraryPath','sourceRoot','wikiSourcePath','configPath','artifactRoot']){const input=add(create,'input');input.name=name;}
 add(create,'button',null,'建立手动批次');
 const resume=add(main,'form','resume');add(resume,'input').name='batchId';add(resume,'button',null,'读取进度');
 add(main,'p','error');add(main,'section','progress');
 add(main,'button','analyze','分析下一组（最多 5 份）').disabled=true;
 add(main,'section','sources');add(main,'button','next','下一页材料').disabled=true;
 add(main,'input','paused').type='checkbox';
 add(main,'button','prepare','冻结已选材料与历史依赖').disabled=true;
 add(main,'section','slice');add(main,'input','approved').type='checkbox';
 for(const [id,text] of [['validate','验证副本并演练恢复'],['original','准备正式执行审核'],['apply','执行历史迁移与新增归档']])add(main,'button',id,text).disabled=true;
 document.FormData=class {
  constructor(form){this.values=form.querySelectorAll('input,select').filter(input=>input.name&&!input.disabled&&(!['checkbox','radio'].includes(input.type)||input.checked)).map(input=>[input.name,input.value]);}
  entries(){return this.values[Symbol.iterator]();}
  [Symbol.iterator](){return this.entries();}
  get(name){return this.values.find(([key])=>key===name)?.[1]??null;}
 };
 // 原生事件监听器可启动未返回的异步任务，测试需等待可观察的页面状态。
 document.waitFor=async(predicate,{timeout=3000}={})=>{
  const deadline=Date.now()+timeout;
  while(!predicate()){if(Date.now()>=deadline)throw new Error('等待页面状态超时');await delay(5);}
 };
 return document;
}
