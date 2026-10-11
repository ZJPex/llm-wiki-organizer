import test from 'node:test';
import assert from 'node:assert/strict';
import {createInboxDocument} from './helpers/page-dom.js';
import {mountReviewWorkspace} from '../public/review-workspace.js';

test('确认归档立即显示等待并禁止重复提交，完成后顶部明确显示归档成功',async t=>{
 const document=createInboxDocument();
 for(const [key,value] of Object.entries({document,sessionStorage:{getItem:()=>null,setItem:()=>{}}})){
  const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else delete globalThis[key];});
 }
 t.mock.method(globalThis,'setInterval',()=>0);
 const source={sourceId:'one',identity:'a.md',hash:'hash',status:'classified',ingestStatus:'new',suggestion:'新名称.md',analysis:{uncertain:false,evidence:[]},classification:{category:''}};
 const counts={total:1,succeeded:0,retained:0,blocked:0,failed:0,unverified:0,pending:1};
 const batch={batchId:'test',revision:1,phase:'file-review',libraryPath:'/library',sources:[source],nextCursor:null,flow:{},report:{status:'pending',hasExecution:false,counts}};
 let release,requests=0;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
 t.mock.method(globalThis,'fetch',async url=>{
  if(url==='/api/session')return {json:async()=>({token:'test'})};
  if(url.endsWith('/confirmNewArchive')){requests++;await gate;source.status='succeeded';batch.report={status:'complete',hasExecution:true,counts:{...counts,succeeded:1,pending:0}};batch.flow.newArchive={status:'complete',counts:{succeeded:1}};}
  return {ok:true,json:async()=>structuredClone(batch)};
 });
 const host=document.createElement('main');document.body.append(host);await mountReviewWorkspace(host,'test');
 const button=text=>host.querySelectorAll('button').find(node=>node.textContent===text);
 await button('选择整批正常建议').click();
 const pause=host.querySelectorAll('input').find(node=>node.type==='checkbox'&&node.parentNode.textContent.includes('我已暂停'));pause.checked=true;await pause.dispatchEvent({type:'change'});
 const pending=button('确认并归档所选材料').click();
 await document.waitFor(()=>requests===1);
 const waitingText=host.querySelector('[role="status"]').textContent;
 const disabled=button('确认并归档所选材料').disabled;
 await button('确认并归档所选材料').click();release();await pending;
 assert.match(waitingText,/正在校验并归档/);
 assert.equal(disabled,true);assert.equal(requests,1);
 assert.match(host.querySelector('[role="status"]').textContent,/归档成功.*1/);
});
