import path from 'node:path';
import {readFile,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {discoverSources} from './batch-sources.js';
import {batchFail,pathKey} from './batch-store.js';
import {categoryCatalog} from './categories.js';
import {nextCategoryPath} from './evolution.js';
import {generateWithModel,readModelConfig} from './model-config.js';
import {digest} from './compatibility.js';
import {validateName} from './planning.js';
const labelOf=value=>path.posix.basename(value).replace(/^\d+(?:\.\d+)*\s+/,'');
function segments(values){if(Array.isArray(values)&&Buffer.byteLength(JSON.stringify(values))>8192)batchFail('TREE_RESOURCE_LIMIT','分类节点路径超出单项资源上限，请缩短名称');if(!Array.isArray(values)||!values.length||values.some(value=>typeof value!=='string'||!value.trim()||value.length>100||/[<>:"/\\|?*\x00-\x1f]/.test(value)||/[. ]$/.test(value)))batchFail('INVALID_TREE','分类层级名称无效');return values;}
function validateGroups(result,allowed,merged=false){if(!Array.isArray(result?.categories)||!result.categories.length)batchFail('INVALID_TREE','分类树提议格式无效');const used=new Set();return result.categories.map(category=>{segments(category.segments);const ids=merged?category.groups:category.members;if(!Array.isArray(ids)||!ids.length||ids.some(id=>!allowed.has(id)||used.has(id)))batchFail('INVALID_TREE','分类提议遗漏或重复材料');ids.forEach(id=>used.add(id));if(typeof category.reason!=='string'||!category.reason.trim())batchFail('INVALID_TREE','分类须说明查找理由');return {...category,ids};}).map((category,index,array)=>{if(index===array.length-1&&used.size!==allowed.size)batchFail('INVALID_TREE','全范围材料尚未全部参与分类');return category;});}
export function createRestructureStrategy({generate=generateWithModel}={}){
 async function discover({input}){if(pathKey(input.sourceRoot)!==pathKey(path.join(input.libraryPath,'raw/sources')))batchFail('INVALID_SCOPE','首次重构必须冻结完整 raw/sources 范围');return discoverSources(input);}
 async function analyze({batch,source,planning}){const entry=await planning.analyze({...batch,identity:source.currentIdentity});const low=['blank','noise','title-only'].includes(entry.kind);return {analysis:entry,kind:entry.kind,confirmedName:entry.confirmedName,status:low?'skipped':source.ingestStatus==='uncertain'?'blocked':'analyzed',skipReason:low?'低信息材料保留原文件和既有成果':source.skipReason};}
 function invalidate(batch){for(const source of batch.sources){if(source.status==='reviewed')source.status='analyzed';source.selected=false;delete source.targetPath;delete source.treeRevision;}}
 async function tree({batch,input}){
  const existing=batch.flow.tree;
  if(input.action==='approve'){
   if(!existing||existing.status!=='proposed')batchFail('INVALID_PHASE','请先生成待审核分类树');
   for(const source of batch.sources)if(digest(await readFile(source.currentPath))!==source.hash)batchFail('SOURCE_CHANGED','材料已变化，分类树需要重新分析');
   return {tree:{...existing,status:'approved'}};
  }
  if(input.action==='edit'){
   if(!existing)batchFail('INVALID_PHASE','尚无分类树');const node=existing.nodes.find(node=>node.nodeId===input.nodeId);if(!node)batchFail('INVALID_TREE','分类节点不存在');
   segments(input.segments);node.segments=input.segments;if(input.reason)node.reason=input.reason;invalidate(batch);
   const catalog=await categoryCatalog(batch.sourceRoot);return {tree:{...existing,revision:existing.revision+1,status:'proposed',nodes:allocate(existing.nodes,catalog)}};
  }
  if(input.action!=='propose')batchFail('INVALID_ACTION','分类树操作无效');
  if(batch.sources.some(source=>['pending','needs-analysis','analysis-failed'].includes(source.status)))batchFail('ANALYSIS_INCOMPLETE','先完成全范围材料分析，再提出分类树');
  const candidates=batch.sources.filter(source=>source.analysis?.analysis&&!source.analysis.analysis.uncertain&&!['skipped','blocked'].includes(source.status));
  if(!candidates.length)batchFail('NO_RELIABLE_MATERIAL','没有可可靠分类的材料，原文件均保留');
  const config=await readModelConfig(batch),catalog=await categoryCatalog(batch.sourceRoot);let groups=[];
  for(let start=0;start<candidates.length;start+=15){const chunk=candidates.slice(start,start+15),allowed=new Set(chunk.map(source=>source.sourceId));const result=await generate(config,{stage:'tree-proposal',materials:chunk.map(source=>({sourceId:source.sourceId,summary:source.analysis.analysis.summary,evidence:source.analysis.analysis.evidence,identityHints:source.analysis.identityHints})),existing:catalog.categories.map(category=>({path:category.path,aliases:category.aliases}))});
   groups.push(...validateGroups(result,allowed).map(category=>{const representatives=category.representatives;if(!Array.isArray(representatives)||!representatives.length||representatives.length>3||representatives.some(id=>!category.ids.includes(id)))batchFail('INVALID_TREE','代表材料必须属于该分类实际来源');return {nodeId:randomUUID(),segments:category.segments,members:category.ids,representatives,reason:category.reason};}));}
  // 分块分析之后按分类摘要归并，保留每份材料的成员关系，不重新截取原文。
  let level=0;while(groups.length>1){const merged=[];for(let start=0;start<groups.length;start+=20){const chunk=groups.slice(start,start+20);const result=await generate(config,{stage:'tree-merge',categories:chunk.map(node=>({groupId:node.nodeId,segments:node.segments,reason:node.reason,count:node.members.length,representatives:node.representatives.map(id=>({sourceId:id,summary:candidates.find(source=>source.sourceId===id).analysis.analysis.summary}))}))});const allowed=new Set(chunk.map(node=>node.nodeId));merged.push(...validateGroups(result,allowed,true).map(category=>{const children=chunk.filter(node=>category.ids.includes(node.nodeId));return {nodeId:randomUUID(),segments:category.segments,members:children.flatMap(node=>node.members),representatives:children.flatMap(node=>node.representatives).slice(0,3),reason:category.reason};}));}if(groups.length<=20){groups=merged;break;}if(merged.length>=groups.length||++level>10)batchFail('TREE_TOO_LARGE','分类归并未收敛，请缩小分类数量后重新分析');groups=merged;}
  for(const source of batch.sources)if(digest(await readFile(source.currentPath))!==source.hash)batchFail('SOURCE_CHANGED','生成分类树期间来源改变');invalidate(batch);
  return {tree:{revision:(existing?.revision??0)+1,status:'proposed',nodes:allocate(groups,catalog),catalogHash:catalog.hash,analyzedCount:batch.sources.length,classifiedCount:candidates.length}};
 }
 function allocate(nodes,catalog){const paths=catalog.categories.map(category=>category.path);return nodes.map(node=>{let parent='';for(const label of node.segments){const existing=paths.find(value=>value&&path.posix.dirname(value)===(parent||'.')&&labelOf(value).toLowerCase()===label.toLowerCase());if(existing)parent=existing;else{parent=nextCategoryPath(paths,parent,label);paths.push(parent);}}return {...node,category:parent};});}
 async function review({batch,source,input,planning}){
  const tree=batch.flow.tree;if(tree?.status!=='approved')batchFail('TREE_REVIEW_REQUIRED','先审核分类树，再形成文件名和路径批次');
  if(input.action==='exclude')return {sourcePatch:{selected:false,status:'skipped',skipReason:'用户选择保留原处'}};
  if(source.ingestStatus!=='historical')batchFail('UNKNOWN_ASSOCIATION','首次历史重构仅迁移有缓存证据的材料；新增材料请从 Inbox 处理');
  if(['blank','noise','title-only'].includes(source.kind))batchFail('LOW_INFORMATION','低信息材料保留原文件和成果');
  const node=tree.nodes.find(node=>node.nodeId===input.nodeId)||tree.nodes.find(node=>node.members.includes(source.sourceId));if(!node)batchFail('INVALID_TREE','请选择已审核分类节点');
  const name=input.name??source.confirmedName??source.analysis.suggestion;validateName(name);
  const entry=await planning.confirm({...batch,identity:source.currentIdentity,name,allowRenameConfirmed:input.allowRenameConfirmed===true});const targetPath=path.join(batch.sourceRoot,node.category,entry.confirmedName);
  if(pathKey(targetPath)!==pathKey(source.currentPath)&&await lstat(targetPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))batchFail('TARGET_EXISTS','目标已有文件，不能覆盖');
  if(batch.sources.some(other=>other.sourceId!==source.sourceId&&other.selected&&other.targetPath&&pathKey(other.targetPath)===pathKey(targetPath)))batchFail('TARGET_EXISTS','所选材料目标冲突，请修改并重新审核');
  return {sourcePatch:{confirmedName:entry.confirmedName,targetPath,category:node.category,treeRevision:tree.revision,status:'reviewed',selected:true}};
 }
 async function prepare({batch,selected}){if(batch.flow.tree?.status!=='approved'||selected.some(source=>source.treeRevision!==batch.flow.tree.revision))batchFail('STALE_TREE','分类树已调整，请重新审核文件路径');return {historicalRequest:{mappings:selected.map(source=>({id:source.sourceId,from:path.relative(batch.libraryPath,source.currentPath).replaceAll('\\','/'),to:path.relative(batch.libraryPath,source.targetPath).replaceAll('\\','/'),hash:source.hash}))},newFiles:[],affectedSourceIds:selected.map(source=>source.sourceId)};}
 return {discover,analyze,tree,review,prepare};
}
