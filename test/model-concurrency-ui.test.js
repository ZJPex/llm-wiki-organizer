import test from 'node:test';
import assert from 'node:assert/strict';
import {createInboxDocument} from './helpers/page-dom.js';
import {modelConcurrencyControls} from '../public/model-concurrency-ui.js';
test('审核进度显示分段完成量与实际占用，调速输入保持焦点与草稿',async()=>{
 const document=createInboxDocument(),previous=globalThis.document;globalThis.document=document;
 try{const host=document.querySelector('#progress'),settings=[];const controls=modelConcurrencyControls(host,{request:async(limit)=>{settings.push(limit);return {limit,active:3,converging:true};}});
 controls.update({modelConcurrency:{limit:3,active:3},flow:{analysisCurrent:{identity:'长文.md',stage:'segment',completed:2,totalSteps:9,status:'running'}}});
 assert.match(host.textContent,/长文.md.*2\/9/);assert.match(host.textContent,/3\/3/);
 const input=host.querySelector('input');input.value='1';input.focus();controls.update({modelConcurrency:{limit:3,active:3},flow:{analysisCurrent:{identity:'长文.md',stage:'synthesis',round:1,completed:1,totalSteps:3,status:'running'}}});assert.equal(input.value,'1');assert.equal(document.activeElement,input);
 await host.querySelector('button').click();assert.deepEqual(settings,[1]);assert.match(host.textContent,/收敛/);assert.match(host.textContent,/3\/1/);
 }finally{globalThis.document=previous;}
});
