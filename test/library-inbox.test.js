import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,rename,readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {migrationFixture} from './helpers/migration-fixture.js';
import {listenForBrowser} from './helpers/http-server.js';
import {createApp} from '../src/server.mjs';
import {createWorkspaceService} from '../src/workspace.js';
import {createBatchService} from '../src/batches.js';
import {createPlanningService} from '../src/planning.js';
import {createInboxStrategy} from '../src/inbox.js';

async function fixture(t){
 const f=await migrationFixture(t),sourceRoot=path.join(f.root,'inbox'),artifactRoot=path.join(f.root,'artifacts'),configPath=path.join(f.root,'config.json');
 await mkdir(sourceRoot);await mkdir(artifactRoot);
 await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test'}}));
 for(const name of ['a','b'])await writeFile(path.join(sourceRoot,name+'.md'),`[${name}] 这份材料讨论缓存一致性、索引维护与失败恢复。`);
 await writeFile(path.join(f.root,'upstream','src/lib/source-watch-defaults.json'),JSON.stringify({enabled:false,autoIngest:false,includeExtensions:['.md'],excludeExtensions:[],excludeDirs:[],excludeGlobs:[]})).catch(async error=>{if(error.code!=='ENOENT')throw error;await mkdir(path.join(f.root,'upstream/src/lib'),{recursive:true});await writeFile(path.join(f.root,'upstream/src/lib/source-watch-defaults.json'),JSON.stringify({enabled:false,autoIngest:false,includeExtensions:['.md'],excludeExtensions:[],excludeDirs:[],excludeGlobs:[]}));});
 const calls=[];
 async function start(){
  const planning=createPlanningService({stateDirectory:path.join(f.root,'planning'),generate:async(_,request)=>{
   calls.push({identity:request.identity,stage:request.stage});
   if(request.stage==='category-search')return {candidates:['']};
   if(request.stage==='category-choice')return {category:'',reason:'正文主题',evidence:[request.content.evidence[0]],uncertain:false};
   return {title:'缓存主题',summary:request.content,evidence:[request.content.slice(0,12)],uncertain:false};
  }});
  const batches=createBatchService({planning,stateDirectory:path.join(f.root,'batches'),strategies:{inbox:createInboxStrategy()}});
  const workspace=createWorkspaceService({batches,stateDirectory:path.join(f.root,'settings')});
  const server=createApp({batches,workspace});await listenForBrowser(server);t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session')).json();
  const request=async(action,input={})=>{const response=await fetch(base+'/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)}),body=await response.json();if(!response.ok)throw Object.assign(new Error(body.error),body);return body;};
  return {request,server};
 }
 const service=await start(),saved=await service.request('workspace/save',{libraryPath:f.backup.originalPath,sourceRoot,artifactRoot,configPath,wikiSourcePath:path.join(f.root,'upstream')});
 return {...f,...service,start,id:saved.id,sourceRoot,calls};
}
async function waitFor(read,predicate){let last;for(let i=0;i<200;i++){last=await read();if(predicate(last))return last;await delay(20);}throw new Error('等待收件箱超时 '+JSON.stringify(last));}

test('知识库刷新只扫描一次，重复刷新和改名保持文件身份，重启恢复且库之间隔离',async t=>{
 const f=await fixture(t),input={id:f.id};
 const initial=await f.request('inbox/scan',input);assert.equal(initial.items.length,2);assert.equal(f.calls.length,0);
 const original=initial.items.find(item=>item.identity==='a.md');
 await rename(path.join(f.sourceRoot,'a.md'),path.join(f.sourceRoot,'renamed.md'));
 const refreshed=await f.request('inbox/scan',input);assert.equal(refreshed.items.length,2);assert.equal(refreshed.items.find(item=>item.identity==='renamed.md').itemId,original.itemId);assert.equal(f.calls.length,0);
 const again=await f.request('inbox/scan',input);assert.deepEqual(again.items.map(item=>item.itemId).sort(),initial.items.map(item=>item.itemId).sort());
 await new Promise(resolve=>f.server.close(resolve));const restarted=await f.start();const restored=await restarted.request('inbox/list',input);assert.deepEqual(restored.items.map(item=>item.itemId).sort(),initial.items.map(item=>item.itemId).sort());assert.equal(f.calls.length,0);
 await assert.rejects(restarted.request('inbox/list',{id:'00000000-0000-0000-0000-000000000000'}));
});

test('仅所选文件分析，重复启动复用结果，保存审核但确认归档前不移动',async t=>{
 const f=await fixture(t),input={id:f.id},initial=await f.request('inbox/scan',input),chosen=initial.items.find(item=>item.identity==='a.md');
 await Promise.all(Array.from({length:3},()=>f.request('inbox/start',{...input,itemIds:[chosen.itemId]})));
 const ready=await waitFor(()=>f.request('inbox/list',input),value=>value.items.find(item=>item.itemId===chosen.itemId).status==='reviewable');
 assert.equal(ready.items.find(item=>item.identity==='b.md').status,'pending');assert.ok(f.calls.length>0);assert.ok(f.calls.filter(call=>call.identity).every(call=>call.identity==='a.md'));
 const before=f.calls.length;await f.request('inbox/start',{...input,itemIds:[chosen.itemId]});await delay(40);assert.equal(f.calls.length,before);
 const reviewed=await f.request('inbox/review',{...input,itemId:chosen.itemId,name:'缓存分析.md',category:''});assert.equal(reviewed.items.find(item=>item.itemId===chosen.itemId).status,'confirmed');
 assert.match(await readFile(path.join(f.sourceRoot,'a.md'),'utf8'),/^\[a\]/);await assert.rejects(readFile(path.join(f.backup.originalPath,'raw/sources/缓存分析.md')),{code:'ENOENT'});
 const result=await f.request('inbox/archive',{...input,itemIds:[chosen.itemId],requestId:'archive-once',approved:true,writersPaused:true});assert.equal(result.items.find(item=>item.itemId===chosen.itemId).status,'archived');
 assert.match(await readFile(path.join(f.backup.originalPath,'raw/sources/缓存分析.md'),'utf8'),/^\[a\]/);
 await assert.rejects(readFile(path.join(f.sourceRoot,'a.md')),{code:'ENOENT'});
 await f.request('inbox/archive',{...input,itemIds:[chosen.itemId],requestId:'archive-once',approved:true,writersPaused:true});assert.equal(f.calls.length,before);
 const rescanned=await f.request('inbox/scan',input);assert.equal(rescanned.items.filter(item=>item.status!=='archived').length,1);
});

test('分析后的改名保留正文结果但使审核失效，正文修改移除旧建议，跨库文件不能启动',async t=>{
 const f=await fixture(t),input={id:f.id},initial=await f.request('inbox/scan',input),chosen=initial.items.find(item=>item.identity==='a.md');
 await f.request('inbox/start',{...input,itemIds:[chosen.itemId]});await waitFor(()=>f.request('inbox/list',input),value=>value.items.find(item=>item.itemId===chosen.itemId).status==='reviewable');
 await f.request('inbox/review',{...input,itemId:chosen.itemId,name:'缓存分析.md',category:''});const analyzed=f.calls.filter(call=>call.stage==='segment').length,total=f.calls.length;
 await rename(path.join(f.sourceRoot,'a.md'),path.join(f.sourceRoot,'renamed.md'));
 const changed=await f.request('inbox/scan',input),renamed=changed.items.find(item=>item.itemId===chosen.itemId);assert.equal(renamed.identity,'renamed.md');assert.equal(renamed.status,'needs-classification');assert.equal(renamed.targetPath,undefined);assert.equal(f.calls.length,total);
 await assert.rejects(f.request('inbox/archive',{...input,itemIds:[chosen.itemId],requestId:'stale',approved:true,writersPaused:true}),{code:'REVIEW_REQUIRED'});
 await f.request('inbox/start',{...input,itemIds:[chosen.itemId]});await waitFor(()=>f.request('inbox/list',input),value=>value.items.find(item=>item.itemId===chosen.itemId).status==='reviewable');assert.equal(f.calls.filter(call=>call.stage==='segment').length,analyzed);
 await writeFile(path.join(f.sourceRoot,'renamed.md'),'修订版本：本文解释新的缓存失效条件与数据库一致性边界。');const updated=await f.request('inbox/scan',input),item=updated.items.find(item=>item.itemId===chosen.itemId);assert.equal(item.status,'pending');assert.equal(item.analysis,undefined);assert.equal(item.classification,undefined);assert.equal(item.suggestion,undefined);assert.ok(item.history.length);
 const other=await fixture(t),saved=await f.request('workspace/save',{libraryPath:other.backup.originalPath,sourceRoot:other.sourceRoot,artifactRoot:path.join(other.root,'artifacts'),configPath:path.join(other.root,'config.json'),wikiSourcePath:path.join(other.root,'upstream')});
 const otherInbox=await f.request('inbox/scan',{id:saved.id});assert.equal(otherInbox.items.length,2);assert.equal(otherInbox.items.some(item=>item.itemId===chosen.itemId),false);
 assert.deepEqual((await f.request('inbox/list',{id:saved.id})).items.map(item=>item.itemId),otherInbox.items.map(item=>item.itemId));assert.equal((await f.request('inbox/list',input)).items.find(item=>item.itemId===chosen.itemId).identity,'renamed.md');
 await assert.rejects(f.request('inbox/start',{id:saved.id,itemIds:[chosen.itemId]}),{code:'INVALID_SELECTION'});
});
