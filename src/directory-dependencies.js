import path from 'node:path';
import {compileEvolution} from './evolution.js';
const key=value=>path.resolve(value).replaceAll('\\','/').toLowerCase();
const under=(file,root)=>key(file)===key(root)||key(file).startsWith(key(root)+'/');
// 只依赖已声明的源文件与目录范围；新增一个兄弟目录不会牵连所有既有目录。
export function evolutionTouches(evolution,{sourcePath,targetPath,categoryRoot,owner=false}){
 if(!evolution)return false;
 let plan=evolution.frozenPlan??evolution;const operations=plan.operations??evolution.operations??[];
 if(!evolution.frozenPlan&&!Array.isArray(plan.fileMappings)&&operations.length){
  // 未确认建议也按同一编译规则识别目标目录；证据不足或建议无效时不推断独立。
  try{plan={...plan,...compileEvolution(evolution.catalog,evolution.baseline,operations)};}catch{return true;}
 }
 if(owner&&(operations.length||plan.fileMappings?.length||plan.directoryMappings?.length||plan.newDirectories?.length))return true;
 const paths=[sourcePath,targetPath].filter(Boolean),file=value=>path.resolve(categoryRoot,value);
 if((plan.fileMappings??[]).some(move=>paths.some(p=>key(p)===key(file(move.from))||key(p)===key(file(move.to)))))return true;
 const directories=[...(plan.directoryMappings??[]).flatMap(move=>[move.from,move.to]),...(plan.newDirectories??[])];
 for(const operation of operations){
  if(operation.from)directories.push(operation.from);if(operation.type==='merge'&&operation.to)directories.push(operation.to);
  const files=[...(operation.files??[]),...(operation.groups??[]).flatMap(group=>group.files??[])];
  if(files.some(name=>paths.some(p=>key(p)===key(file(name)))))return true;
 }
 return directories.some(directory=>paths.some(p=>under(p,file(directory))));
}
export function sourceDirectoryDependency(batch,source,targetPath=source.targetPath??source.classification?.finalPath){
 const scope={sourcePath:source.currentPath,targetPath,categoryRoot:path.join(batch.libraryPath,'raw/sources')};
 if(evolutionTouches(batch.flow.evolutionPlan,scope))return true;
 return batch.sources.some(owner=>evolutionTouches(owner.evolution,{...scope,owner:owner.sourceId===source.sourceId}));
}
export function selectedEvolution(batch,selected){return batch.flow.evolutionPlan&&selected.some(source=>sourceDirectoryDependency(batch,source))?batch.flow.evolutionPlan:null;}
