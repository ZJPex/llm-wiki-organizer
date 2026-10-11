import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../../../src/server.mjs';
import {createPlanningService} from '../../../src/planning.js';
import {listenForBrowser} from '../../../test/helpers/http-server.js';
const results=[];
const content=Array.from({length:9},(_,i)=>`第${i}段讨论缓存一致性。`+'原'.repeat(248)).join('');
for(const limit of [1,3]){
 const root=await mkdtemp(path.join(os.tmpdir(),'organizer-inbox-benchmark-'));
 const sourceRoot=path.join(root,'source');await mkdir(sourceRoot);
 const configPath=path.join(root,'config.json');await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'controlled-latency',maxContextSize:1024}}));
 await writeFile(path.join(sourceRoot,'long.md'),content);
 let active=0,peak=0;const calls=[];
 const planning=createPlanningService({stateDirectory:path.join(root,'planning'),generate:async(_,request)=>{
  active++;peak=Math.max(peak,active);calls.push(request);
  try{await delay(40);return {title:'缓存一致性',summary:request.content.slice(0,30),evidence:[request.content.slice(0,20)],uncertain:false};}finally{active--;}
 }});
 const app=createApp({planning});await listenForBrowser(app);
 try{
  const base=`http://127.0.0.1:${app.address().port}`,{token}=await(await fetch(base+'/api/session')).json();
  const call=async(route,input)=>{const response=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;};
  await call('model-concurrency/set',{limit});
  const started=performance.now();const result=await call('planning/analyze',{sourceRoot,libraryPath:sourceRoot,configPath,identity:'long.md'});const durationMs=performance.now()-started;
  assert.equal(calls.filter(request=>request.stage==='segment').map(request=>request.content).join(''),content);
  assert.ok(peak<=limit);assert.equal(result.suggestion,'缓存一致性.md');
  results.push({limit,durationMs:Math.round(durationMs),peak,calls:calls.length,segments:calls.filter(request=>request.stage==='segment').length,synthesis:calls.filter(request=>request.stage==='synthesis').length,coverage:true,model:'controlled-latency',delayMs:40});
 }finally{await new Promise(resolve=>app.close(resolve));await rm(root,{recursive:true,force:true});}
}
assert.equal(results[0].calls,results[1].calls);assert.equal(results[0].segments,results[1].segments);
await writeFile(new URL('./benchmark-results.json',import.meta.url),JSON.stringify({scope:'合成模型延迟验证，不代表真实供应商性能',results},null,2));
console.log(JSON.stringify(results));
