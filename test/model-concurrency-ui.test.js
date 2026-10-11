import test from 'node:test';
import assert from 'node:assert/strict';
import {createInboxDocument} from './helpers/page-dom.js';
import {modelConcurrencyControls} from '../public/model-concurrency-ui.js';
import {backgroundAnalysis} from '../public/background-analysis.js';
test('审核进度显示分段完成量与实际占用，调速输入保持焦点与草稿',async()=>{
 const document=createInboxDocument(),previous=globalThis.document;globalThis.document=document;
 try{const host=document.querySelector('#progress'),settings=[];const controls=modelConcurrencyControls(host,{request:async(limit)=>{settings.push(limit);return {limit,active:3,converging:true};}});
 controls.update({modelConcurrency:{limit:3,active:3},flow:{analysisCurrent:{identity:'长文.md',stage:'segment',completed:2,totalSteps:9,status:'running'}}});
 assert.match(host.textContent,/长文.md.*2\/9/);assert.match(host.textContent,/3\/3/);
 const input=host.querySelector('input');input.value='1';input.focus();controls.update({modelConcurrency:{limit:3,active:3},flow:{analysisCurrent:{identity:'长文.md',stage:'synthesis',round:1,completed:1,totalSteps:3,status:'running'}}});assert.equal(input.value,'1');assert.equal(document.activeElement,input);
 await host.querySelector('button').click();assert.deepEqual(settings,[1]);assert.match(host.textContent,/收敛/);assert.match(host.textContent,/3\/1/);
 }finally{globalThis.document=previous;}
});
test('并发审核列表显示每份正在分析材料的独立阶段与完成量',()=>{
 const document=createInboxDocument(),previous=globalThis.document;globalThis.document=document;
 try{const host=document.querySelector('#progress'),controls=modelConcurrencyControls(host);
  controls.update({modelConcurrency:{limit:3,active:3},sources:[{identity:'甲.md',progress:{status:'running',stage:'segment',completed:2,totalSteps:8}},{identity:'乙.md',progress:{status:'running',stage:'choice'}}],flow:{}});
  assert.match(host.textContent,/甲.md.*2\/8/);assert.match(host.textContent,/乙.md.*选择分类/);
 }finally{globalThis.document=previous;}
});
test('恢复进度展示已复用段、该次分析在途数及中断未知计量',()=>{
 const document=createInboxDocument(),previous=globalThis.document;globalThis.document=document;
 try{const host=document.querySelector('#progress'),controls=modelConcurrencyControls(host);
 controls.update({modelConcurrency:{limit:3,active:3},analysisJob:{status:'pausing',inFlight:2},flow:{analysisCurrent:{identity:'长文.md',stage:'segment',completed:4,totalSteps:9,reusedSteps:3,status:'running'}}});
 assert.match(host.textContent,/当前分析在途 2/);assert.match(host.textContent,/复用 3/);
 controls.update({modelConcurrency:{limit:3,active:0},analysisJob:{status:'interrupted',inFlight:null},flow:{}});assert.match(host.textContent,/中断.*未知/);
 }finally{globalThis.document=previous;}
});

test('失败及退避界面说明文章与同配置范围、有限尝试和手动恢复动作',()=>{
 const document=createInboxDocument(),previous=globalThis.document;globalThis.document=document;
 try{const host=document.querySelector('#progress'),controls=modelConcurrencyControls(host);
  controls.update({modelConcurrency:{limit:3,active:0,retrying:1,rateLimited:true},analysisJob:{status:'running',inFlight:0},sources:[{identity:'甲.md',progress:{status:'running',stage:'segment',retry:{status:'waiting',attempt:1,maxAttempts:3,delayMs:250,message:'模型服务限流，等待后重试'}}}],flow:{}});
  assert.match(host.textContent,/退避.*1\/3/);assert.match(host.textContent,/限流.*降低/);
  controls.update({modelConcurrency:{limit:3,active:0},analysisJob:{status:'failed',inFlight:0},sources:[{identity:'甲.md',failure:{scope:'model',message:'模型鉴权失败，请修正配置后重试',attempts:1},progress:{status:'failed',stage:'segment'}}],flow:{}});
  assert.match(host.textContent,/甲.md.*同模型配置.*鉴权失败/);assert.match(host.textContent,/已结束.*失败/);assert.match(host.textContent,/手动.*继续/);
 }finally{globalThis.document=previous;}
});

test('按文件恢复部分完成有中文终态与可用继续入口',()=>{
 const document=createInboxDocument(),button=document.createElement('button'),pause=document.createElement('button'),message=document.createElement('p');
 backgroundAnalysis({getBatch:()=>({analysisJob:{status:'partial',sourceIds:['one'],allowedActions:['continueAnalysis']}}),request:async()=>{},update:()=>{}}).render(button,pause,message);
 assert.match(message.textContent,/所选.*完成.*其他.*继续/);assert.equal(button.textContent,'继续分析');assert.equal(button.disabled,false);assert.equal(pause.hidden,true);
});
