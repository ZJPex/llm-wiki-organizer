// 仅创建临时合成库，提供 C 工作台浏览器验收环境；不读取真实知识库或调用模型。
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {migrationFixture} from '../test/helpers/migration-fixture.js';
import {createBatchService} from '../src/batches.js';
import {createWorkspaceService} from '../src/workspace.js';
import {createInboxStrategy} from '../src/inbox.js';
import {createRestructureStrategy} from '../src/restructure.js';
import {createPlanningService} from '../src/planning.js';
import {createApp} from '../src/server.mjs';
const f=await migrationFixture({after(){}},{retained:true});
const libraryPath=f.backup.originalPath,sourceRoot=path.join(f.root,'inbox'),artifactRoot=path.join(f.root,'artifacts'),configPath=path.join(f.root,'config.json');
await mkdir(sourceRoot);await mkdir(artifactRoot);await mkdir(path.join(libraryPath,'raw/sources/001 合成分类'));
await writeFile(path.join(sourceRoot,'example.md'),'合成材料介绍缓存一致性与恢复。');
await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'fixed-test'}}));
const planning=createPlanningService({stateDirectory:path.join(f.root,'planning'),generate:async(_,request)=>{
 if(request.stage==='category-search')return {candidates:['001 合成分类']};
 if(request.stage==='category-choice')return {category:'001 合成分类',reason:'合成主题',evidence:request.content.evidence,uncertain:false};
 return {title:'缓存一致性',summary:request.content,evidence:[request.content],uncertain:false};
}});
const batches=createBatchService({stateDirectory:path.join(f.root,'batches'),planning,strategies:{inbox:createInboxStrategy(),restructure:createRestructureStrategy()}});
const workspace=createWorkspaceService({batches,stateDirectory:path.join(f.root,'settings')});
const server=createApp({batches,workspace});
server.listen(Number(process.env.PORT||4327),'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,settings:{libraryPath,sourceRoot,artifactRoot,configPath,wikiSourcePath:path.join(f.root,'upstream')},fixtureRoot:f.root})));
