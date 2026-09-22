import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {migrationFixture} from './helpers/migration-fixture.js';
import {listenForBrowser} from './helpers/http-server.js';
import {createPlanningService} from '../src/planning.js';
import {createInboxStrategy} from '../src/inbox.js';
import {createBatchService} from '../src/batches.js';
import {createApp} from '../src/server.mjs';

async function setup(t){
 const f=await migrationFixture(t),sourceRoot=path.join(f.root,'inbox'),artifactRoot=path.join(f.root,'artifacts');
 await mkdir(sourceRoot);await mkdir(artifactRoot);await mkdir(path.join(f.backup.originalPath,'raw/sources/001 缓存'));
 for(const name of ['a','b','c','d'])await writeFile(path.join(sourceRoot,name+'.md'),'这里讨论缓存一致性、索引更新和失败恢复，提供完整材料用于判断归档主题。');
 const configPath=path.join(f.root,'config.json');await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test'}}));
 let failing=false;
 const planning=createPlanningService({stateDirectory:path.join(f.root,'planning'),generate:async(_,r)=>{
  if(r.stage==='category-search'){if(failing)throw new Error('模拟模型断开');return {candidates:['001 缓存']};}
  if(r.stage==='category-choice')return {category:'001 缓存',reason:'缓存主题',evidence:[r.content.evidence[0]],uncertain:false};
  return {title:'缓存主题',summary:'缓存主题',evidence:[r.content.slice(0,10)],uncertain:false};
 }});
 const server=createApp({batches:createBatchService({stateDirectory:path.join(f.root,'batches'),planning,strategies:{inbox:createInboxStrategy()}})});
 await listenForBrowser(server);t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session')).json();
 const request=async(action,input)=>{const response=await fetch(base+'/api/batches/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)});const body=await response.json();if(!response.ok)throw new Error(body.error);return body;};
 let batch=await request('create',{mode:'inbox',libraryPath:f.backup.originalPath,sourceRoot,artifactRoot,wikiSourcePath:path.join(f.root,'upstream'),configPath});
 batch=await request('analyzeNext',{batchId:batch.batchId,revision:batch.revision,limit:5});
 for(const source of batch.sources.filter(s=>s.identity!=='c.md'))batch=await request('reviewItem',{batchId:batch.batchId,revision:batch.revision,sourceId:source.sourceId,action:'confirmName',name:source.identity});
 batch=await request('reviewItem',{batchId:batch.batchId,revision:batch.revision,sourceId:batch.sources.find(s=>s.identity==='d.md').sourceId,action:'exclude'});
 // 只显示一条材料，批量任务仍必须覆盖整批。
 batch=await request('get',{batchId:batch.batchId,limit:1});
 return {request,getBatch:()=>batch,update:value=>{batch=value;},fail:value=>{failing=value;}};
}

test('一键分类跨分页处理全部合格材料，暂停后继续，未命名也获分类，排除项不受影响',async t=>{
 const value=await setup(t),{classifyAll}=await import('../public/classify-all.js');
 let paused=false;
 const options={...value,stopped:()=>paused,update:batch=>{value.update(batch);paused=true;}};
 assert.equal(await classifyAll(options),'paused');
 assert.equal(value.getBatch().classificationProgress.remaining,1);
 paused=false;assert.equal(await classifyAll(options),'complete');
 assert.deepEqual(value.getBatch().classificationProgress,{total:3,remaining:0,completed:3,skipped:1,failed:0});
 assert.equal(value.getBatch().sources.find(s=>s.identity==='c.md').status,'classified');
 assert.equal(value.getBatch().sources.find(s=>s.identity==='d.md').status,'excluded');
 assert.equal(value.getBatch().sources.filter(s=>s.selected).length,0);
});

test('分类模型失败后立即显示失败进度，恢复时仅继续剩余项',async t=>{
 const value=await setup(t),{classifyAll}=await import('../public/classify-all.js');
 const options={...value,stopped:()=>false,update:batch=>{value.update(batch);if(batch.classificationProgress.completed===2)value.fail(true);}};
 await assert.rejects(classifyAll(options),/模拟模型断开/);
 assert.equal(value.getBatch().classificationProgress.failed,1);
 assert.equal(value.getBatch().classificationProgress.completed,2);
 assert.equal(value.getBatch().flow.classificationCurrent.status,'failed');
 value.fail(false);
 assert.equal(await classifyAll({...value,stopped:()=>false}),'complete');
 assert.equal(value.getBatch().classificationProgress.completed,3);
 assert.equal(value.getBatch().classificationProgress.failed,0);
});
