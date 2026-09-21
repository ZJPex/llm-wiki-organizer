import {test} from 'node:test';
import assert from 'node:assert/strict';
import {atomicRename} from '../src/atomic-rename.js';

test('日志替换遇 Windows 短暂占用会重试，持久错误有界失败',async()=>{
 let attempts=0;const waits=[];
 await atomicRename('temporary','journal',{platform:'win32',wait:async ms=>waits.push(ms),renameFile:async(from,to)=>{assert.equal(from,'temporary');assert.equal(to,'journal');if(++attempts<3)throw Object.assign(new Error('busy'),{code:'EPERM'});}});
 assert.equal(attempts,3);assert.equal(waits.length,2);
 for(const [platform,code,expected] of [['win32','EBUSY',8],['win32','ENOENT',1],['linux','EPERM',1]]){
  attempts=0;await assert.rejects(atomicRename('temporary','journal',{platform,wait:async()=>{},renameFile:async()=>{attempts++;throw Object.assign(new Error('failed'),{code});}}),{code});assert.equal(attempts,expected);
 }
});
