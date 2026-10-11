import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile,readdir,rename} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {migrationFixture} from './helpers/migration-fixture.js';
import {listenForBrowser} from './helpers/http-server.js';
import {httpFixtureScope} from './helpers/http-fixture-scope.js';
import {createApp} from '../src/server.mjs';
import {createWorkspaceService} from '../src/workspace.js';
import {createPlanningService} from '../src/planning.js';
import {createBatchService} from '../src/batches.js';
import {createInboxStrategy} from '../src/inbox.js';

async function fixture(t,{files=['初稿'],choose,search,propose,categories=['001 缓存','002 数据库']}={}){
 const f=await migrationFixture(t,{retained:true}),scope=httpFixtureScope(t,f.root),sourceRoot=path.join(f.root,'inbox'),artifactRoot=path.join(f.root,'artifacts'),configPath=path.join(f.root,'config.json'),libraryPath=f.backup.originalPath;
 await mkdir(sourceRoot);await mkdir(artifactRoot);for(const category of categories)await mkdir(path.join(libraryPath,'raw/sources',category));
 await mkdir(path.join(f.root,'upstream/src/lib'),{recursive:true});await writeFile(path.join(f.root,'upstream/src/lib/source-watch-defaults.json'),JSON.stringify({enabled:false,autoIngest:false,includeExtensions:['.md'],excludeExtensions:[],excludeDirs:[],excludeGlobs:[]}));
 await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test'}}));
 for(const name of files)await writeFile(path.join(sourceRoot,name+'.md'),name==='标题'?'# 仅标题':`[${name}] 本文讲解缓存更新、数据库事务以及失效恢复，两类主题都涉及真实业务需求。`);
 const calls=[];
 async function start(){
  const planning=createPlanningService({stateDirectory:path.join(f.root,'planning'),generate:async(_,request)=>{
   calls.push(request);
   if(request.stage==='category-search')return search?.(request)??{candidates:request.categories.map(category=>category.path)};
   if(request.stage==='category-choice')return choose?.(request)??{category:request.classificationRules?.at(-1)?.category??'001 缓存',reason:'正文用途与偏好相符',evidence:request.content.evidence,uncertain:false};
   if(request.stage==='new-category')return propose?.(request)??{};
   return {title:'缓存与数据库实践',summary:request.content,evidence:[request.content.slice(0,15)],uncertain:false};
  }});
  const batches=createBatchService({planning,stateDirectory:path.join(f.root,'batches'),strategies:{inbox:createInboxStrategy()}}),workspace=createWorkspaceService({batches,stateDirectory:path.join(f.root,'settings')}),server=createApp({planning,batches,workspace});scope.add(server);await listenForBrowser(server);
  const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/session',{signal:AbortSignal.timeout(15000)})).json();
  const request=async(action,input={})=>{const response=await fetch(base+'/api/'+action,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json','X-Organizer-Token':token},body:JSON.stringify(input)}),body=await response.json();if(!response.ok)throw Object.assign(new Error(body.error),body);return body;};
  return {request,server};
 }
 const service=await start(),saved=await service.request('workspace/save',{libraryPath,sourceRoot,artifactRoot,configPath,wikiSourcePath:path.join(f.root,'upstream')});
 const initial=await service.request('inbox/scan',{id:saved.id});await service.request('inbox/start',{id:saved.id,itemIds:initial.items.map(item=>item.itemId)});
 const read=()=>service.request('inbox/list',{id:saved.id});let ready;for(let n=0;n<200;n++){ready=await read();if(ready.items.every(item=>!['waiting','analyzing'].includes(item.status)))break;await delay(20);}assert.ok(ready.items.every(item=>!['waiting','analyzing'].includes(item.status)));
 return {...f,...service,start,close:scope.close,id:saved.id,sourceRoot,libraryPath,configPath,ready,calls,read};
}

const waitFor=async(f,name)=>{let result;for(let index=0;index<250;index++){result=await f.read();const item=result.items.find(item=>item.identity===name+'.md');if(item&&!['pending','waiting','analyzing'].includes(item.status)&&(item.classification||['failed','needs-information'].includes(item.status)))return item;await delay(20);}assert.fail('材料未在期限内完成');};
async function next(f,name){await writeFile(path.join(f.sourceRoot,name+'.md'),`[${name}] 本文讲解缓存更新、数据库事务以及失效恢复，两类主题都涉及真实业务需求。`);const discovered=await f.request('inbox/scan',{id:f.id}),item=discovered.items.find(item=>item.identity===name+'.md');await f.request('inbox/start',{id:f.id,itemIds:[item.itemId]});return waitFor(f,name);}
const review=(f,item,extra={})=>f.request('inbox/review',{id:f.id,itemId:item.itemId,reviewBasis:item.reviewBasis,name:item.identity,category:'002 数据库',...extra});

test('已接受新类别可显式保存待生效规则，重启保留且只在实际确认落地及提议身份一致后参与分类',async t=>{
 let missing=true;const f=await fixture(t,{search:request=>missing?{candidates:[],decision:'missing-category',reason:'缺少一致性专门归属'}:{candidates:request.categories.map(category=>category.path)},propose:()=>({proposal:{parent:'001 缓存',label:'一致性',reason:'正文讨论一致性实践',benefit:'直接查找一致性策略'}})}),first=f.ready.items[0],proposal=first.classification.newCategory;
 await review(f,first,{category:proposal.path,acceptNewCategory:true,newCategoryHash:proposal.proposalHash,saveClassificationRule:true,ruleText:'缓存一致性资料优先归属一致性类别'});
 assert.deepEqual(await readdir(path.join(f.libraryPath,'raw/sources/001 缓存')),[]);assert.equal((await f.read()).classificationRules[0].status,'waiting-category');
 await f.close(f.server);const restarted=await f.start();Object.assign(f,restarted,{read:()=>restarted.request('inbox/list',{id:f.id})});assert.equal((await f.read()).classificationRules[0].status,'waiting-category');missing=false;
 const before=await next(f,'落地前');assert.equal(before.classification.category,'001 缓存');assert.deepEqual(f.calls.filter(call=>call.stage==='category-choice').at(-1).classificationRules,[]);assert.deepEqual(await readdir(path.join(f.libraryPath,'raw/sources/001 缓存')),[]);
 const archived=await f.request('inbox/archive',{id:f.id,itemIds:[first.itemId],requestId:'explicit-new-category-rule',approved:true,writersPaused:true});assert.equal(archived.items.find(item=>item.itemId===first.itemId).status,'archived');assert.equal((await f.read()).classificationRules[0].status,'active');
 const after=await next(f,'落地后');assert.equal(after.classification.category,proposal.path);assert.equal(after.status,'reviewable');await assert.rejects(f.request('inbox/archive',{id:f.id,itemIds:[after.itemId],requestId:'pending-rule-no-authorization',approved:true,writersPaused:true}),{code:'REVIEW_REQUIRED'});
 const metadata=path.join(f.libraryPath,'raw/sources',proposal.path,'.category.json'),saved=JSON.parse(await readFile(metadata,'utf8'));await writeFile(metadata,JSON.stringify({...saved,organizerProposalHash:'f'.repeat(64)}));const replaced=await next(f,'提议身份变化');assert.equal(replaced.classification.category,'001 缓存');assert.deepEqual(f.calls.filter(call=>call.stage==='category-choice').at(-1).classificationRules,[]);assert.equal((await f.read()).classificationRules[0].status,'category-mismatch');assert.match(await readFile(path.join(f.sourceRoot,'提议身份变化.md'),'utf8'),/提议身份变化/);
});

test('默认修改只作用当前文件，显式规则参与后续检索选择且重启保留，建议仍须逐文件审核',async t=>{
 const f=await fixture(t),first=f.ready.items[0];assert.match(first.reviewBasis.rulesHash,/^[a-f0-9]{64}$/);await assert.rejects(review(f,first,{reviewBasis:{...first.reviewBasis,rulesHash:'过期规则'}}),{code:'STALE_REVIEW'});await review(f,first);assert.deepEqual((await f.read()).classificationRules,[]);
 const ordinary=await next(f,'第二份');assert.equal(ordinary.classification.category,'001 缓存');
 await review(f,ordinary,{saveClassificationRule:true,ruleText:'缓存一致性材料优先归属数据库类别'});const rules=(await f.read()).classificationRules;assert.equal(rules.length,1);assert.equal(rules[0].instruction,'缓存一致性材料优先归属数据库类别');assert.equal(rules[0].category,'002 数据库');
 const third=await next(f,'第三份');assert.equal(third.classification.category,'002 数据库');assert.equal(third.status,'reviewable');assert.ok(f.calls.filter(call=>['category-search','category-choice'].includes(call.stage)).some(call=>call.classificationRules?.length===1));
 await assert.rejects(f.request('inbox/archive',{id:f.id,itemIds:[third.itemId],requestId:'rule-is-not-authorization',approved:true,writersPaused:true}),{code:'REVIEW_REQUIRED'});assert.match(await readFile(path.join(f.sourceRoot,'第三份.md'),'utf8'),/第三份/);
 await f.close(f.server);const restarted=await f.start();assert.deepEqual((await restarted.request('inbox/list',{id:f.id})).classificationRules,rules);
});

test('同一服务两份真实知识库隔离偏好，相同路径替换项目并重新保存设置后不继承旧规则',async t=>{
 const f=await fixture(t);await review(f,f.ready.items[0],{saveClassificationRule:true,ruleText:'缓存一致性优先放数据库'});
 const second=await migrationFixture(t,{retained:true});httpFixtureScope(t,second.root);const sourceRoot=path.join(second.root,'inbox'),artifactRoot=path.join(second.root,'artifacts'),configPath=path.join(second.root,'config.json'),libraryPath=second.backup.originalPath;
 await mkdir(sourceRoot);await mkdir(artifactRoot);for(const category of ['001 缓存','002 数据库'])await mkdir(path.join(libraryPath,'raw/sources',category));await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test'}}));await mkdir(path.join(second.root,'upstream/src/lib'),{recursive:true});await writeFile(path.join(second.root,'upstream/src/lib/source-watch-defaults.json'),JSON.stringify({enabled:false,autoIngest:false,includeExtensions:['.md'],excludeExtensions:[],excludeDirs:[],excludeGlobs:[]}));
 const saved=await f.request('workspace/save',{libraryPath,sourceRoot,artifactRoot,configPath,wikiSourcePath:path.join(second.root,'upstream')}),other={...f,id:saved.id,sourceRoot,libraryPath,read:()=>f.request('inbox/list',{id:saved.id})};
 assert.deepEqual((await other.read()).classificationRules,[]);const material=await next(other,'第二库');assert.equal(material.classification.category,'001 缓存');assert.equal((await f.read()).classificationRules.length,1);
 await writeFile(path.join(f.libraryPath,'.llm-wiki/project.json'),JSON.stringify({id:'replacement-project',createdAt:2}));await assert.rejects(f.read(),{code:'LIBRARY_CHANGED'});
 await f.request('workspace/save',{id:f.id,libraryPath:f.libraryPath,sourceRoot:f.sourceRoot,artifactRoot:path.join(f.root,'artifacts'),configPath:f.configPath,wikiSourcePath:path.join(f.root,'upstream')});assert.deepEqual((await f.read()).classificationRules,[]);const replaced=await next(f,'替换后的新材料');assert.equal(replaced.classification.category,'001 缓存');
});

test('规则变化使未执行旧分类需要复核但复用正文，失效类别不传给模型，证据不足仍待定',async t=>{
 let insufficient=false;const f=await fixture(t,{files:['初稿','留待处理'],choose:request=>({category:request.classificationRules?.at(-1)?.category??'001 缓存',reason:'主要用途与偏好相符',evidence:insufficient?[]:request.content.evidence,uncertain:insufficient})}),first=f.ready.items.find(item=>item.identity==='初稿.md'),retained=f.ready.items.find(item=>item.identity==='留待处理.md');
 await review(f,retained);const reviewedRetained=(await f.read()).items.find(item=>item.itemId===retained.itemId);const analysisCalls=f.calls.filter(call=>['segment','synthesis'].includes(call.stage)).length;
 await review(f,first,{saveClassificationRule:true,ruleText:'缓存一致性优先放数据库'});await assert.rejects(review(f,reviewedRetained),{code:'STALE_REVIEW'});
 await f.request('inbox/start',{id:f.id,itemIds:[retained.itemId]});const reconsidered=await waitFor(f,'留待处理');assert.equal(reconsidered.classification.category,'002 数据库');assert.equal(f.calls.filter(call=>['segment','synthesis'].includes(call.stage)).length,analysisCalls);assert.equal(reconsidered.status,'reviewable');
 insufficient=true;const unproven=await next(f,'引用不足');assert.equal(unproven.classification.category,null);assert.equal(unproven.classification.decision,'insufficient-evidence');assert.notEqual(unproven.status,'confirmed');
 await rename(path.join(f.libraryPath,'raw/sources/002 数据库'),path.join(f.libraryPath,'raw/sources/002 新库名'));insufficient=false;const unavailable=await next(f,'目录变化后');assert.equal(unavailable.classification.category,'001 缓存');const latestChoice=f.calls.filter(call=>call.stage==='category-choice').at(-1);assert.deepEqual(latestChoice.classificationRules,[]);
 await assert.rejects(review(f,unavailable,{saveClassificationRule:true,ruleText:'指向已失效目录'}));assert.equal((await f.read()).classificationRules.length,1);assert.match(await readFile(path.join(f.sourceRoot,'目录变化后.md'),'utf8'),/目录变化后/);
});

test('规则保存期间迟到的旧分类建议不覆盖新版本，手动继续只重做分类且不重复全文模型请求',async t=>{
 let release,arrived,blocking=true;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>arrived=resolve);t.after(()=>release());
 const f=await fixture(t,{choose:async request=>{if(request.content.summary.includes('[在途]')&&blocking){arrived();await gate;}return {category:request.classificationRules?.at(-1)?.category??'001 缓存',reason:'按正文及当前规则选择',evidence:request.content.evidence,uncertain:false};}});
 await writeFile(path.join(f.sourceRoot,'在途.md'),'[在途] 本文讨论缓存更新、事务提交与数据一致性的完整实践过程。');const input={sourceRoot:f.sourceRoot,libraryPath:f.libraryPath,configPath:f.configPath,identity:'在途.md',categoryRoot:path.join(f.libraryPath,'raw/sources')};await f.request('planning/analyze',input);const pending=f.request('planning/classify',input);const rejected=assert.rejects(pending);await Promise.race([entered,delay(5000).then(()=>assert.fail('未进入可控分类请求'))]);
 const bodyCalls=f.calls.filter(call=>['segment','synthesis'].includes(call.stage)).length;await review(f,f.ready.items[0],{saveClassificationRule:true,ruleText:'缓存一致性优先放数据库'});blocking=false;release();await rejected;
 const list=await f.request('planning/list',input);assert.equal(list.entries['在途.md'].classification,undefined);
 const page=await f.request('inbox/scan',{id:f.id}),item=page.items.find(item=>item.identity==='在途.md');await f.request('inbox/start',{id:f.id,itemIds:[item.itemId]});const result=await waitFor(f,'在途');assert.equal(result.classification.category,'002 数据库');assert.equal(f.calls.filter(call=>['segment','synthesis'].includes(call.stage)).length,bodyCalls);assert.equal(result.status,'reviewable');
});

