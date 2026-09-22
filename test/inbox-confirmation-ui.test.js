import test from 'node:test';
import assert from 'node:assert/strict';
import {createInboxDocument} from './helpers/page-dom.js';
import {inboxConfirmationFixture} from './helpers/inbox-confirmation-fixture.js';

async function page(t){
 const f=await inboxConfirmationFixture(t),document=createInboxDocument();
 const previousDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
 const previousFormData=globalThis.FormData,nativeFetch=globalThis.fetch;
 globalThis.document=document;globalThis.FormData=document.FormData;
 t.after(()=>{if(previousDocument)Object.defineProperty(globalThis,'document',previousDocument);else delete globalThis.document;globalThis.FormData=previousFormData;});
 let offline=false,confirmations=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(offline)throw new TypeError('Failed to fetch');
  if(url==='/api/batches/confirmRecommendedCategories')confirmations++;
  return nativeFetch(String(url).startsWith('/')?f.base+url:url,options);
 });
 await import(`../public/inbox.js?confirmation-test=${f.getBatch().batchId}`);
 document.querySelector('#resume input').value=f.getBatch().batchId;
 await document.querySelector('#resume button').click();
 await document.waitFor(()=>document.querySelector('#progress').textContent.includes(f.getBatch().batchId)&&!document.querySelector('#resume button').disabled);
 return {f,document,setOffline:value=>offline=value,confirmations:()=>confirmations};
}

test('页面一键确认提交整批、显示数量，完成后不可重复提交且不会执行归档',async t=>{
 const {document,confirmations}=await page(t);
 const button=document.querySelectorAll('button').find(node=>node.textContent==='一键确认全部推荐分类');
 assert.ok(button,'页面应提供批量确认按钮');
 assert.equal(button.disabled,false);
 assert.match(document.body.textContent,/可一键确认 3 份/);
 const pending=button.click();assert.equal(button.disabled,true);await button.click();await pending;
 assert.equal(confirmations(),1);
 assert.match(document.body.textContent,/已确认 3 份/);
 assert.equal(button.disabled,true);
 assert.equal(document.querySelector('#apply').disabled,true);
});

test('确认请求与随后刷新都断网时解除页面锁定，恢复连接后能够重试',async t=>{
 const {document,setOffline}=await page(t);
 const button=document.querySelectorAll('button').find(node=>node.textContent==='一键确认全部推荐分类');
 setOffline(true);await button.click();
 assert.match(document.querySelector('#error').textContent,/Failed to fetch/);
 assert.equal(button.disabled,false,'失败后批量按钮应允许重试');
 assert.equal(document.querySelector('#resume button').disabled,false,'断网不能锁死读取进度按钮');
 assert.equal(document.querySelector('#apply').disabled,true,'解除操作锁不能放开未审核的执行步骤');
 setOffline(false);await button.click();
 assert.match(document.body.textContent,/已确认 3 份/);
 assert.equal(document.querySelector('#error').textContent,'');
});
