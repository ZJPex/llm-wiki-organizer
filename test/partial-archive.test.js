import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile,lstat,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {migrationFixture} from './helpers/migration-fixture.js';
import {listenForBrowser} from './helpers/http-server.js';
import {createApp} from '../src/server.mjs';
import {createPlanningService} from '../src/planning.js';
import {createBatchService} from '../src/batches.js';
import {createInboxStrategy} from '../src/inbox.js';
import {createWorkspaceService} from '../src/workspace.js';

async function wait(read,predicate){for(let i=0;i<250;i++){const value=await read();if(predicate(value))return value;await delay(15);}throw new Error('等待部分归档状态超时');}
async function fixture(t,{model}={}){
 const f=await migrationFixture(t,{retained:true}),sourceRoot=path.join(f.root,'inbox'),artifactRoot=path.join(f.root,'artifacts'),configPath=path.join(f.root,'config.json'),libraryPath=f.backup.originalPath,wikiSourcePath=path.join(f.root,'upstream'),calls=[];
 await mkdir(sourceRoot);await mkdir(artifactRoot);await mkdir(path.join(libraryPath,'raw/sources/001 缓存'));await mkdir(path.join(libraryPath,'raw/sources/002 网络'));await mkdir(path.join(wikiSourcePath,'src/lib'),{recursive:true});
 await writeFile(path.join(wikiSourcePath,'src/lib/source-watch-defaults.json'),JSON.stringify({enabled:false,autoIngest:false,includeExtensions:['md'],excludeExtensions:[],excludeDirs:[],excludeGlobs:[]}));
 await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test',maxContextSize:1024}}));
 const answer=r=>r.stage==='category-search'?{candidates:[r.content.summary.includes('网络')?'002 网络':'001 缓存']}:r.stage==='category-choice'?{category:r.categories[0].path,reason:'按正文用途查找',evidence:r.content.evidence,uncertain:false}:{title:'工程资料',summary:r.content,evidence:[r.content],uncertain:false};
 const planning=createPlanningService({stateDirectory:path.join(f.root,'planning'),generate:async(_,r)=>{calls.push({stage:r.stage,identity:r.identity,content:r.content});return model?model(r,answer):answer(r);}}),batches=createBatchService({planning,stateDirectory:path.join(f.root,'batches'),strategies:{inbox:createInboxStrategy()}}),workspace=createWorkspaceService({batches,stateDirectory:path.join(f.root,'settings')}),server=createApp({planning,batches,workspace});
 await listenForBrowser(server);t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(f.root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session')).json();let batch;
 const call=async(action,input={})=>{try{const response=await fetch(base+'/api/'+action,{signal:AbortSignal.timeout(15000),method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)}),value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error),value);return value;}catch(error){error.message=action+': '+error.message;throw error;}};
 const settings={libraryPath,sourceRoot,artifactRoot,configPath,wikiSourcePath},batchCall=async(action,input={})=>{batch=await call('batches/'+action,{batchId:batch?.batchId,revision:batch?.revision,...input});return batch;};
 return {...f,settings,libraryPath,sourceRoot,calls,call,batchCall,get:()=>batch,write:async(name,text)=>writeFile(path.join(sourceRoot,name+'.md'),text),create:()=>batchCall('create',{mode:'inbox',...settings})};
}

test('分类复核只撤销实际候选说明变化的建议，其他建议及全文保留且无需模型调用',async t=>{
 const f=await fixture(t);await f.write('cache','缓存一致性提供失败恢复机制，正文包含明确可核验的设计与使用证据。');await f.write('network','网络连接需要协议与超时管理，正文包含明确可核验的设计与使用证据。');await f.create();await f.batchCall('analyzeNext',{limit:3});const before=f.get(),calls=f.calls.length;
 await writeFile(path.join(f.libraryPath,'raw/sources/002 网络/.category.json'),JSON.stringify({description:'新的网络协议用途',aliases:[]}));
 const checked=await f.batchCall('refreshReview'),cache=checked.sources.find(s=>s.identity==='cache.md'),network=checked.sources.find(s=>s.identity==='network.md');
 assert.equal(cache.status,'classified');assert.ok(cache.classification);assert.deepEqual(cache.reviewBasis,before.sources.find(s=>s.identity==='cache.md').reviewBasis);assert.deepEqual(cache.analysis,before.sources.find(s=>s.identity==='cache.md').analysis);
 assert.equal(network.status,'analyzed');assert.equal(network.classification,undefined);assert.deepEqual(network.analysis,before.sources.find(s=>s.identity==='network.md').analysis);assert.equal(f.calls.length,calls);assert.deepEqual(checked.invalidations.affectedSourceIds,[network.sourceId]);
 await f.batchCall('startAnalysis');const resumed=await wait(()=>f.batchCall('get'),value=>value.analysisJob.status==='complete');assert.equal(resumed.sources.find(s=>s.sourceId===network.sourceId).status,'classified');assert.ok(f.calls.slice(calls).every(call=>call.stage.startsWith('category-')),'未变正文只重新分类');
});

test('明确审核的已有目标经依赖证明保留无关新增后的选择，相关说明变化仍撤授权',async t=>{
 const f=await fixture(t);await f.write('cache','缓存一致性提供失败恢复机制，正文包含明确可核验的设计与使用证据。');await f.write('network','网络连接需要协议与超时管理，正文包含明确可核验的设计与使用证据。');await f.create();await f.batchCall('analyzeNext',{limit:3});
 await f.batchCall('confirmPlans',{items:f.get().sources.map(s=>({sourceId:s.sourceId,reviewBasis:s.reviewBasis,name:s.identity,category:s.classification.category,manuallyEdited:true}))});const before=f.get();
 await mkdir(path.join(f.libraryPath,'raw/sources/003 图像'));let checked=await f.batchCall('refreshReview');assert.ok(checked.sources.every(s=>s.status==='reviewed'&&s.selected));assert.deepEqual(checked.sources.map(s=>s.reviewBasis),before.sources.map(s=>s.reviewBasis));assert.equal(checked.invalidations.retainedClassificationSourceIds.length,2);
 await writeFile(path.join(f.libraryPath,'raw/sources/002 网络/.category.json'),JSON.stringify({description:'另一个网络用途',aliases:[]}));checked=await f.batchCall('refreshReview');const cache=checked.sources.find(s=>s.identity==='cache.md'),network=checked.sources.find(s=>s.identity==='network.md');assert.equal(cache.status,'reviewed');assert.equal(cache.selected,true);assert.equal(network.selected,false);assert.equal(network.status,'analyzed');assert.equal(network.confirmedName,'network.md');
 const archived=await f.batchCall('confirmNewArchive',{requestId:'proof-selected',writersPaused:true,items:[{sourceId:cache.sourceId,name:cache.confirmedName,category:cache.classification.category}]});assert.equal(archived.flow.newArchive.counts.succeeded,1);assert.match(await readFile(path.join(f.libraryPath,'raw/sources/001 缓存/cache.md'),'utf8'),/缓存一致性/);await lstat(path.join(f.sourceRoot,'network.md'));
});

test('安全暂停后部分归档再按原范围继续，成功检查点复用而失败和未选文件保持原处',async t=>{
 let open=false;const gates=[],release=()=>{open=true;gates.forEach(resolve=>resolve());};
 const f=await fixture(t,{model:async(r,answer)=>{if(r.identity==='long.md'&&!open&&!gates.length)await new Promise(resolve=>gates.push(resolve));if(r.identity==='failed.md')return {};return answer(r);}});
 try{
  await f.write('cache','缓存一致性提供失败恢复机制，正文包含明确可核验的设计与使用证据。');await f.write('long',Array.from({length:40},(_,i)=>`第${i}条缓存长期记录说明分段校验与失败恢复，必须保存完整正文证据。`).join('\n'));await f.write('failed','独立材料缺少可靠模型响应，但原文件与其他材料均应当保留。');await f.write('unselected','未选材料包含自己的原始正文，不能在继续时擅自进入分析或移动。');await f.create();
  const scope=f.get().sources.filter(s=>s.identity!=='unselected.md').map(s=>s.sourceId);await f.batchCall('startAnalysis',{sourceIds:scope});
  let partial=await wait(()=>f.batchCall('get'),value=>value.sources.find(s=>s.identity==='cache.md')?.classification&&value.sources.find(s=>s.identity==='failed.md')?.status==='analysis-failed'&&gates.length),cache=partial.sources.find(s=>s.identity==='cache.md');
  await f.batchCall('confirmPlans',{items:[{sourceId:cache.sourceId,reviewBasis:cache.reviewBasis,name:'已归档.md',category:'001 缓存'}]});await f.batchCall('pauseAnalysis');
  const archive={requestId:'paused-part',writersPaused:true,items:[{sourceId:cache.sourceId,name:'已归档.md',category:'001 缓存'}]};await assert.rejects(f.batchCall('confirmNewArchive',archive),{code:'BATCH_BUSY'});await assert.rejects(lstat(path.join(f.libraryPath,'raw/sources/001 缓存/已归档.md')),{code:'ENOENT'});
  release();partial=await wait(()=>f.batchCall('get'),value=>['paused','failed'].includes(value.analysisJob.status)&&value.analysisJob.inFlight===0);const pausedCalls=f.calls.length;assert.ok(partial.sources.find(s=>s.identity==='long.md').progress.reusedSteps!==undefined||partial.sources.find(s=>s.identity==='long.md').progress.completed>0);
  const archived=await f.batchCall('confirmNewArchive',archive);assert.equal(archived.flow.newArchive.counts.succeeded,1);const again=await f.batchCall('confirmNewArchive',archive);assert.equal(again.sliceCount,archived.sliceCount);await assert.rejects(lstat(path.join(f.sourceRoot,'cache.md')),{code:'ENOENT'});
  await f.batchCall('continueAnalysis');const continued=await wait(()=>f.batchCall('get'),value=>['complete','partial','failed'].includes(value.analysisJob.status)&&value.analysisJob.inFlight===0);assert.deepEqual(continued.analysisJob.sourceIds,scope);assert.equal(continued.sources.find(s=>s.identity==='cache.md').status,'succeeded');assert.equal(continued.sources.find(s=>s.identity==='unselected.md').status,'pending');
  assert.ok(f.calls.slice(pausedCalls).every(call=>call.identity!=='cache.md'&&call.identity!=='unselected.md'));await lstat(path.join(f.sourceRoot,'failed.md'));await lstat(path.join(f.sourceRoot,'unselected.md'));await lstat(path.join(f.sourceRoot,'long.md'));assert.match(await readFile(path.join(f.libraryPath,'raw/sources/001 缓存/已归档.md'),'utf8'),/缓存一致性/);
  const savedSegments=f.calls.slice(0,pausedCalls).filter(call=>call.identity==='long.md'&&call.stage==='segment').map(call=>call.content);assert.ok(savedSegments.length);assert.ok(f.calls.slice(pausedCalls).filter(call=>call.identity==='long.md'&&call.stage==='segment').every(call=>!savedSegments.includes(call.content)),'已落盘的成功分段不再次请求模型');
 }finally{release();}
});

test('知识库归档后公开复核范围，已归档不再排队，正文变化只提示该篇重新分析',async t=>{
 const f=await fixture(t);await f.write('cache','缓存一致性提供失败恢复机制，正文包含明确可核验的设计与使用证据。');await f.write('network','网络连接需要协议与超时管理，正文包含明确可核验的设计与使用证据。');const {id}=await f.call('workspace/save',f.settings),scan=await f.call('inbox/scan',{id});await f.call('inbox/start',{id,itemIds:scan.items.map(item=>item.itemId)});
 const ready=await wait(()=>f.call('inbox/list',{id}),value=>!value.analysisActive&&value.items.every(item=>item.status==='reviewable')),cache=ready.items.find(item=>item.identity==='cache.md');await f.call('inbox/review',{id,itemId:cache.itemId,reviewBasis:cache.reviewBasis,name:'已归档.md',category:'001 缓存'});
 const archived=await f.call('inbox/archive',{id,itemIds:[cache.itemId],approved:true,writersPaused:true,requestId:'library-part'});assert.equal(archived.items.find(item=>item.itemId===cache.itemId).status,'archived');assert.equal(archived.reviewCheck.status,'checked');assert.deepEqual(archived.reviewCheck.archivedItemIds,[cache.itemId]);
 await f.write('network','网络正文发生真实变化，必须重新分析该篇，新依据不能授权旧分类。');const calls=f.calls.length,checked=await f.call('inbox/recheck',{id}),network=checked.items.find(item=>item.itemId!==cache.itemId);assert.deepEqual(checked.reviewCheck.analysisNeededItemIds,[network.itemId]);assert.deepEqual(checked.reviewCheck.affectedItemIds,[network.itemId]);assert.deepEqual(checked.reviewCheck.resumeItemIds,[network.itemId]);assert.equal(network.status,'pending');assert.equal(f.calls.length,calls);assert.equal(checked.items.find(item=>item.itemId===cache.itemId).status,'archived');
 await f.call('inbox/start',{id,itemIds:[network.itemId]});const resumed=await wait(()=>f.call('inbox/list',{id}),value=>!value.analysisActive);assert.equal(resumed.items.find(item=>item.itemId===cache.itemId).status,'archived');assert.equal(resumed.items.find(item=>item.itemId===network.itemId).status,'reviewable');assert.ok(f.calls.slice(calls).every(call=>call.identity!=='cache.md'));await lstat(path.join(f.sourceRoot,'network.md'));
});

test('路径和同义名变化影响全目录检索，仅撤未审核建议并保留显式人工目标',async t=>{
 const f=await fixture(t);for(const name of ['reviewed','suggested'])await f.write(name,'缓存一致性提供失败恢复机制，正文包含明确可核验的设计与使用证据。');await f.create();await f.batchCall('analyzeNext',{limit:3});const source=f.get().sources.find(s=>s.identity==='reviewed.md');await f.batchCall('confirmPlans',{items:[{sourceId:source.sourceId,reviewBasis:source.reviewBasis,name:'人工.md',category:'001 缓存'}]});
 await writeFile(path.join(f.libraryPath,'raw/sources/002 网络/.category.json'),JSON.stringify({description:'网络用途',aliases:['缓存通信']}));let checked=await f.batchCall('refreshReview');assert.equal(checked.sources.find(s=>s.identity==='reviewed.md').selected,true);assert.equal(checked.sources.find(s=>s.identity==='suggested.md').classification,undefined);assert.ok(checked.sources.every(s=>s.analysis));
 await f.batchCall('startAnalysis');await wait(()=>f.batchCall('get'),value=>value.analysisJob.status==='complete');await mkdir(path.join(f.libraryPath,'raw/sources/003 日志'));checked=await f.batchCall('refreshReview');assert.equal(checked.sources.find(s=>s.identity==='reviewed.md').status,'reviewed');assert.equal(checked.sources.find(s=>s.identity==='suggested.md').status,'analyzed');
});

test('已有目录演化即使逐篇目标无关变化可证明，也必须使整份目录调整失效',async t=>{
 const f=await fixture(t,{model:(r,answer)=>r.stage==='evolution'?{canContain:false,parentAffected:false,operations:[{type:'add',parent:'001 缓存',label:'记录',files:[],problem:'细化历史目录',benefit:'按用途查找记录'}],reason:'完整目录调整'}:answer(r)});await f.write('cache','缓存一致性提供失败恢复机制，正文包含明确可核验的设计与使用证据。');await f.create();await f.batchCall('analyzeNext');const source=f.get().sources[0];await f.batchCall('confirmPlans',{items:[{sourceId:source.sourceId,name:'cache.md',category:'001 缓存'}]});await f.batchCall('reviewItem',{sourceId:source.sourceId,action:'evolve',category:'001 缓存'});await f.batchCall('reviewItem',{sourceId:source.sourceId,action:'confirmEvolution'});
 await writeFile(path.join(f.libraryPath,'raw/sources/002 网络/.category.json'),JSON.stringify({description:'无关网络说明变化',aliases:[]}));const checked=await f.batchCall('refreshReview');assert.ok(checked.invalidations.reasons.some(reason=>reason.code==='DIRECTORY_DEPENDENCY'));assert.equal(checked.sources[0].classification,undefined);assert.equal(checked.sources[0].selected,false);const retained=await f.batchCall('confirmNewArchive',{requestId:'directory-blocked',writersPaused:true,items:[{sourceId:source.sourceId,name:'cache.md',category:'001 缓存'}]});assert.equal(retained.flow.newArchive.counts.retained,1);assert.equal(retained.flow.newArchive.items[0].reason.code,'HISTORY_REQUIRED');await lstat(path.join(f.sourceRoot,'cache.md'));
});
