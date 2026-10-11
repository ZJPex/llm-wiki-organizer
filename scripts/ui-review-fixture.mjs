// 仅使用临时合成知识库和固定模型替身，供规格 #27 的真实浏览器验收。
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {migrationFixture} from '../test/helpers/migration-fixture.js';
import {createBatchService} from '../src/batches.js';
import {createWorkspaceService} from '../src/workspace.js';
import {createInboxStrategy} from '../src/inbox.js';
import {createRestructureStrategy} from '../src/restructure.js';
import {createPlanningService} from '../src/planning.js';
import {createApp} from '../src/server.mjs';

const fixture=await migrationFixture({after(){}},{retained:true});
const libraryPath=fixture.backup.originalPath;
const sourceRoot=path.join(fixture.root,'inbox');
const artifactRoot=path.join(fixture.root,'artifacts');
const configPath=path.join(fixture.root,'config.json');
const raw=path.join(libraryPath,'raw/sources');
const category='301 人工智能/301.01 检索增强生成';
const titles=['RAG 检索优化实践','Agent 工具调用设计','向量数据库选型笔记','长文本文档分段策略','提示词版本管理','大模型评测方法总结','RAG 应用案例整理','知识库搭建指南','多模态检索实践','Embedding 模型对比','文档清洗与预处理','检索效果评估指标'];
await mkdir(sourceRoot);await mkdir(artifactRoot);
await mkdir(path.join(fixture.root,'upstream/src/lib'),{recursive:true});
await writeFile(path.join(fixture.root,'upstream/src/lib/source-watch-defaults.json'),JSON.stringify({enabled:false,autoIngest:false,includeExtensions:['md'],excludeExtensions:[],excludeDirs:[],excludeGlobs:[]}));
for(const folder of [category,'301 人工智能/301.02 智能体','301 人工智能/301.03 模型评测','302 软件工程','303 数据系统','401 产品与设计'])await mkdir(path.join(raw,folder),{recursive:true});
const content='本文围绕检索增强生成的检索环节展开，讨论文档索引构建、检索策略与排序优化。实验采用固定材料，比较关键词检索和向量检索的覆盖范围，记录重排前后的结果差异。\n\n在索引构建阶段，按语义完整性切分文档，保留来源和标题等元数据；检索后核对原始证据，避免仅凭相似度判断答案是否可靠。';
for(const [index,title] of titles.entries()){
 await writeFile(path.join(sourceRoot,`${String(index+1).padStart(2,'0')}_${title}.md`),index===5?'# 待补充正文':content);
 if(index<8)await writeFile(path.join(raw,category,`${title}.md`),content);
}
await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'fixed-test'}}));
const generate=async(_,request)=>{
 if(request.stage==='category-search')return {candidates:[category]};
 if(request.stage==='category-choice')return {category,reason:'材料主要讨论检索、索引和证据核对，归入检索增强生成。',evidence:request.content.evidence,uncertain:false};
 return {title:request.identity.replace(/^\d+_/,'').replace(/\.md$/,''),summary:content,evidence:[request.content],uncertain:false};
};
const planning=createPlanningService({stateDirectory:path.join(fixture.root,'planning'),generate});
const batches=createBatchService({stateDirectory:path.join(fixture.root,'batches'),planning,strategies:{inbox:createInboxStrategy(),restructure:createRestructureStrategy({generate})}});
const workspace=createWorkspaceService({batches,stateDirectory:path.join(fixture.root,'settings')});
const settings=await workspace.save({libraryPath,sourceRoot,artifactRoot,configPath,wikiSourcePath:path.join(fixture.root,'upstream')});
await workspace.create({id:settings.id,mode:'restructure'});
let batch=await workspace.create({id:settings.id,mode:'inbox'});
for(let index=0;index<3;index++)batch=await batches.analyzeNext({batchId:batch.batchId,revision:batch.revision,limit:5});
if(batch.counts.classified!==11)throw new Error('合成材料未形成预期的 11 份可审核建议');
const server=createApp({planning,batches,workspace});
server.listen(Number(process.env.PORT||4337),'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,batchId:batch.batchId,fixtureRoot:fixture.root,libraryId:settings.id})));
