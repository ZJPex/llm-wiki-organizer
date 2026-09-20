import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

test('首次重构请求结束后恢复静态按钮，成功和错误均可继续已有批次',async()=>{
 const source=await readFile(new URL('../public/restructure.js',import.meta.url),'utf8');
 const controller=source.slice(source.indexOf('const $='),source.indexOf('function render()'));
 const buttons=[{disabled:false},{disabled:false}],status={textContent:''};
 const api=runInNewContext(`${controller};({run,setBatch:value=>{batch=value;}})`,{
  document:{querySelector:()=>status,querySelectorAll:()=>buttons},
  render:()=>{},requestBatch:async()=>{throw new Error('读取暂时失败');}
 });
 await api.run(async()=>{assert.ok(buttons.every(button=>button.disabled));api.setBatch({batchId:'saved'});});
 assert.ok(buttons.every(button=>!button.disabled),'创建批次成功后应恢复分析及读取按钮');
 await api.run(async()=>{throw new Error('模型暂时失败');});
 assert.equal(status.textContent,'模型暂时失败');
 assert.ok(buttons.every(button=>!button.disabled),'请求失败后应允许重试');
});
