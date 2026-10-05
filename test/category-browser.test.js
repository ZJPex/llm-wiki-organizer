import test from 'node:test';
import assert from 'node:assert/strict';
import {createInboxDocument} from './helpers/page-dom.js';
import {createCategoryBrowser} from '../public/category-browser.js';

async function page(t,respond){
 const document=createInboxDocument();document.body.replaceChildren();
 const old=globalThis.document;globalThis.document=document;t.after(()=>{globalThis.document=old;});
 const tree=document.createElement('nav'),content=document.createElement('div');document.body.append(tree,content);
 let library={id:'a',libraryPath:'/a',valid:true};const calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{if(url==='/api/session')return {json:async()=>({token:'fixed'})};const input=JSON.parse(options.body);calls.push({url,input});return {ok:true,json:async()=>respond(input)};});
 const browser=createCategoryBrowser({tree,content,getLibrary:()=>library});
 return {document,tree,content,calls,browser,setLibrary:value=>{library=value;browser.clear();},button:label=>document.querySelectorAll('button').find(node=>node.textContent===label)};
}
const catalog=[{path:'',description:''},{path:'900 实际父级',description:''},{path:'900 实际父级/100.20 子类',description:'真实说明'},{path:'900 实际父级/100.20 子类/深层',description:''},{path:'空分类',description:''}];
test('分类按实际路径逐级展开，根材料独立可读，分页累计且位置默认折叠',async t=>{
 const files=Array.from({length:53},(_,i)=>({name:`材料${i}.md`,path:`/a/raw/sources/材料${i}.md`}));
 const p=await page(t,input=>({categories:catalog,category:input.category??'',files:input.category?[]:files.slice(input.cursor??0,(input.cursor??0)+50),total:input.category?0:53,nextCursor:!input.category&&!input.cursor?50:null}));
 await p.browser.open('');assert.match(p.content.textContent,/已显示 50.*共 53/);
 const location=p.content.querySelector('details');assert.notEqual(location.open,true);location.open=true;assert.match(location.textContent,/\/a\/raw\/sources/);
 await p.button('加载更多材料').click();assert.match(p.content.textContent,/已显示 53.*共 53/);assert.equal(p.content.querySelectorAll('article').length,53);
 const expand=p.tree.querySelectorAll('button').find(b=>b.getAttribute('aria-label')==='展开 900 实际父级');await expand.click();assert.equal(expand.getAttribute('aria-expanded'),'true');
 await p.button('100.20 子类').click();assert.equal(p.content.querySelector('h1').textContent,'子类');assert.equal(p.content.querySelector('[aria-label="分类编号"]').textContent,'100.20');assert.match(p.content.textContent,/真实说明/);assert.match(p.content.textContent,/此分类暂无 Markdown 材料/);
 assert.equal(p.calls.at(-1).input.category,'900 实际父级/100.20 子类');
 assert.equal(p.calls.every(c=>c.url==='/api/workspace/categories'),true);
});

test('快速分类切换和切库让迟到结果失效，加载中不冒充空分类',async t=>{
 let release;const gate=new Promise(resolve=>release=resolve);t.after(()=>release());
 let requested=false;
 const p=await page(t,async input=>{if(input.category==='空分类'){requested=true;await gate;}return {categories:catalog,files:[{name:input.id==='b'?'新库.md':input.category||'根.md',path:'/synthetic/file.md'}],total:1,nextCursor:null};});
 await p.browser.open('');const stale=p.button('空分类').click();await p.document.waitFor(()=>requested);
 assert.match(p.content.textContent,/正在加载/);assert.doesNotMatch(p.content.textContent,/暂无 Markdown/);
 await p.button('900 实际父级').click();assert.match(p.content.textContent,/900 实际父级/);
 p.setLibrary({id:'b',libraryPath:'/b',valid:true});await p.browser.open('');release();await stale;
 assert.match(p.content.textContent,/新库.md/);assert.doesNotMatch(p.content.textContent,/空分类/);
});

test('分页失败保留已加载材料可重试，空页不能伪装空分类且可重新选择',async t=>{
 let fail=true;
 const p=await page(t,input=>{if(input.cursor===50&&fail){fail=false;throw new Error('暂时断开');}return {categories:catalog,files:input.cursor===50?[{name:'末页.md',path:'/last.md'}]:input.category?[]:Array.from({length:50},(_,i)=>({name:`文件${i}.md`,path:`/${i}.md`})),total:51,nextCursor:input.cursor===50?null:50};});
 await p.browser.open('');await p.button('加载更多材料').click();assert.match(p.content.textContent,/分类加载失败/);assert.equal(p.content.querySelectorAll('article').length,50);
 await p.button('重试加载').click();assert.equal(p.content.querySelectorAll('article').length,51);
 await p.button('空分类').click();assert.match(p.content.textContent,/本页未返回材料/);assert.doesNotMatch(p.content.textContent,/此分类暂无/);
});

test('键盘选分类后焦点保留，材料分页不移除未变化目录中的焦点',async t=>{
 const p=await page(t,input=>({categories:catalog,files:[{name:'文件.md',path:'/a/file.md'}],total:2,nextCursor:input.cursor?null:1}));
 await p.browser.open('');const category=p.button('空分类');category.focus();await category.click();
 assert.equal(p.document.activeElement===p.button('空分类'),true);
 assert.ok(p.tree.querySelectorAll('button').includes(p.document.activeElement));
 await p.button('加载更多材料').click();assert.equal(p.document.activeElement===p.button('空分类'),true);
});
