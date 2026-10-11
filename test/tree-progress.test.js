import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRestructureStrategy} from '../src/restructure.js';
import {digest} from '../src/compatibility.js';
import {createBatchStore} from '../src/batch-store.js';
import {createBatchService} from '../src/batches.js';
import {treeProgressText,withTreeProgress} from '../public/tree-progress.js';
import {createApp} from '../src/server.mjs';
import {listenForBrowser} from './helpers/http-server.js';

async function fixture(t,count){
 const root=await mkdtemp(path.join(os.tmpdir(),'tree-progress-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const sourceRoot=path.join(root,'sources');await mkdir(sourceRoot);
 const configPath=path.join(root,'config.json');await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test'}}));
 const sources=[];for(let i=0;i<count;i++){const currentPath=path.join(sourceRoot,`${i}.md`);await writeFile(currentPath,'主题材料');sources.push({sourceId:String(i),identity:`${i}.md`,currentIdentity:`${i}.md`,currentPath,hash:digest('主题材料'),status:'analyzed',analysis:{analysis:{summary:'主题材料',evidence:['主题材料'],uncertain:false}}});}
 return {libraryPath:root,sourceRoot,configPath,sources,flow:{}};
}
const unchanged=request=>({categories:request.categories.map(node=>({segments:node.segments,groups:[node.groupId],reason:'保留主题'}))});
const proposal=request=>({categories:request.materials.map(item=>({segments:[`主题${item.sourceId}`],members:[item.sourceId],representatives:[item.sourceId],reason:'按主题查找'}))});

for(const count of [21,93])test(`${count} 份材料归并停滞时二次压缩，保留全部成员并报告进度`,async t=>{
 const batch=await fixture(t,count),progress=[];let retries=0,calls=0;
 const strategy=createRestructureStrategy({generate:async(_config,request)=>{
  calls++;if(request.stage==='tree-proposal')return proposal(request);
  if(!request.retry)return unchanged(request);
  retries++;return {categories:[{segments:['综合主题'],groups:request.categories.map(node=>node.groupId),reason:'同一主题统一查找'}]};
 }});
 const result=await strategy.tree({batch,input:{action:'propose'},save:async()=>progress.push(structuredClone(batch.flow.treeProgress))});
 assert.deepEqual(result.tree.nodes.flatMap(node=>node.members).sort(),batch.sources.map(source=>source.sourceId).sort());
 assert.ok(retries>0);assert.ok(calls<30);assert.ok(progress.some(item=>item?.stage==='merge'&&item.attempt===2));
 assert.equal(batch.flow.treeProgress.status,'complete');
});

test('模型连续忽略压缩上限时有界失败并保留分析',async t=>{
 const batch=await fixture(t,21);let merges=0;
 const strategy=createRestructureStrategy({generate:async(_config,request)=>{if(request.stage==='tree-proposal')return proposal(request);merges++;return unchanged(request);}});
 await assert.rejects(strategy.tree({batch,input:{action:'propose'}}),{code:'TREE_TOO_LARGE'});
 assert.equal(merges,2);assert.ok(batch.sources.every(source=>source.status==='analyzed'));assert.equal(batch.flow.tree,undefined);
});

test('模型等待期间可从磁盘读取进度，失败后保留进度且可复用分析重试',async t=>{
 const batch=await fixture(t,21),stateDirectory=path.join(batch.libraryPath,'state'),store=createBatchStore({stateDirectory});
 const initial=await store.create({...batch,mode:'restructure',slices:[],events:[],phase:'analysis-complete'});
 let service,observed=false,fail=true;
 const strategy=createRestructureStrategy({generate:async(_config,request)=>{
  const current=await service.get({batchId:initial.batchId});
  assert.equal(current.flow.treeProgress.status,'running');assert.equal(current.interrupted,false);
  assert.equal((await store.get(initial.batchId)).flow.treeProgress.stage,current.flow.treeProgress.stage);observed=true;
  if(request.stage==='tree-proposal')return proposal(request);
  if(fail)throw new Error('模型断开');
  return {categories:[{segments:['综合主题'],groups:request.categories.map(node=>node.groupId),reason:'统一主题'}]};
 }});
 service=createBatchService({stateDirectory,strategies:{restructure:strategy}});
 await assert.rejects(service.treeAction({batchId:initial.batchId,revision:initial.revision,action:'propose'}),{code:'MODEL_REQUEST_FAILED',message:'模型调用失败，请检查配置后重试'});
 let current=await service.get({batchId:initial.batchId});assert.ok(observed);assert.equal(current.flow.treeProgress.status,'failed');assert.equal(current.counts.analyzed,21);
 fail=false;current=await service.treeAction({batchId:initial.batchId,revision:current.revision,action:'propose'});
 assert.equal(current.flow.treeProgress.status,'complete');assert.equal(current.flow.tree.classifiedCount,21);assert.equal(current.error,undefined);
});

test('进度轮询不重叠，迟到响应不覆盖最终结果，失败也清理定时器',async()=>{
 let tick,finish,resolveRead,cancelled=0,reads=0;const updates=[];
 const running=withTreeProgress({operation:()=>new Promise(resolve=>finish=resolve),read:()=>{reads++;return new Promise(resolve=>resolveRead=resolve);},update:value=>updates.push(value),schedule:callback=>{tick=callback;return 1;},cancel:()=>cancelled++});
 const polling=tick();await tick();assert.equal(reads,1);finish('最终结果');assert.equal(await running,'最终结果');resolveRead('旧进度');await polling;
 assert.deepEqual(updates,[]);assert.equal(cancelled,1);
 await assert.rejects(withTreeProgress({operation:async()=>{throw new Error('失败');},schedule:()=>1,cancel:()=>cancelled++}),/失败/);assert.equal(cancelled,2);
 assert.match(treeProgressText({flow:{treeProgress:{status:'running',stage:'merge',round:2,chunk:1,totalChunks:3,attempt:2,categoryCount:41}}}),/第 2 轮.*第 1\/3 组.*41 个分类/);
});

test('页面进度模块可通过 HTTP 加载',async t=>{
 const app=createApp();await listenForBrowser(app);t.after(()=>new Promise(resolve=>app.close(resolve)));
 const response=await fetch(`http://127.0.0.1:${app.address().port}/tree-progress.js`);
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);assert.match(await response.text(),/export async function withTreeProgress/);
});
