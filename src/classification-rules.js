import path from 'node:path';
import {readFile,lstat,mkdir,writeFile,realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {planDigest} from './categories.js';
import {atomicRename} from './atomic-rename.js';
const queues=new Map();
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};

// 接受提议只允许保存偏好；实际目录与提议证明一致后才进入后续模型请求。
export function classificationRuleState(rule,catalog){
 const category=catalog.categories.find(category=>category.path===rule.category);
 if(!category)return rule.newCategoryHash?'waiting-category':'category-unavailable';
 if(rule.newCategoryHash&&category.organizerProposalHash!==rule.newCategoryHash)return 'category-mismatch';
 return 'active';
}
export const effectiveClassificationRulesHash=(snapshot,catalog)=>planDigest({libraryIdentity:snapshot.libraryIdentity,rules:snapshot.rules.filter(rule=>classificationRuleState(rule,catalog)==='active')});

// 规则属于实际知识库身份；相同路径被新项目替换后不会继承旧偏好。
export async function classificationLibraryIdentity(libraryPath){
 const root=await realpath(libraryPath);let project;
 try{project=JSON.parse(await readFile(path.join(root,'.llm-wiki/project.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return {root,libraryIdentity:null};throw error;}
 const stat=await lstat(root,{bigint:true});
 if(typeof project.id!=='string'||!project.id||stat.isSymbolicLink()||!stat.isDirectory())fail('INVALID_LIBRARY','分类规则需要有效知识库身份');
 return {root,libraryIdentity:JSON.stringify([project.id,String(stat.dev),String(stat.ino),String(stat.birthtimeNs)])};
}
export function createClassificationRules({stateDirectory}){
 async function snapshot(input){
  const {root,libraryIdentity}=await classificationLibraryIdentity(input.libraryPath);
  if(input.classificationLibraryIdentity&&input.classificationLibraryIdentity!==libraryIdentity)fail('LIBRARY_CHANGED','原位置的知识库身份已变化，不能复用旧分类规则或审核');
  // 独立规划仍可处理普通目录，但没有知识库身份时不读取或保存后续规则。
  if(!libraryIdentity)return {root,libraryIdentity,rules:[],rulesHash:planDigest({libraryIdentity,rules:[]}),file:null};
  const file=path.join(stateDirectory,'classification-rules-'+planDigest({root,libraryIdentity})+'.json');let rules=[];
  try{const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail('INVALID_RULES','分类规则记录不能为链接');const saved=JSON.parse(await readFile(file,'utf8')),{recordHash,...unsigned}=saved;if(recordHash!==planDigest(unsigned)||saved.libraryIdentity!==libraryIdentity||saved.root!==root||!Array.isArray(saved.rules))fail('INVALID_RULES','分类规则记录损坏');rules=saved.rules;}catch(error){if(error.code!=='ENOENT')throw error;}
  return {root,libraryIdentity,rules,rulesHash:planDigest({libraryIdentity,rules}),file};
 }
 return {
  read:snapshot,
  async save(input){
   const instruction=typeof input.ruleText==='string'?input.ruleText.trim():'';
   if(!instruction||instruction.length>1000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(instruction))fail('INVALID_RULE','请填写最多1000字的后续分类偏好');
   const initial=await snapshot(input);if(!initial.libraryIdentity)fail('INVALID_LIBRARY','保存后续分类规则需要有效知识库身份');const previous=queues.get(initial.file)??Promise.resolve();
   const pending=previous.catch(()=>{}).then(async()=>{
    const current=await snapshot(input);
    if(input.expectedRulesHash!==current.rulesHash)fail('STALE_RULES','分类偏好已变化，请重新审核');
    const preference={instruction,category:input.category,...(input.newCategoryHash?{newCategoryHash:input.newCategoryHash}:{})},ruleId=planDigest(preference),rules=current.rules.some(rule=>rule.ruleId===ruleId)?current.rules:[...current.rules,{ruleId,...preference}];
    const saved={schemaVersion:1,root:current.root,libraryIdentity:current.libraryIdentity,rules};saved.recordHash=planDigest(saved);
    await mkdir(stateDirectory,{recursive:true});const temporary=`${current.file}.${randomUUID()}.tmp`;await writeFile(temporary,JSON.stringify(saved,null,2),{flag:'wx'});await atomicRename(temporary,current.file);
    return {...current,rules,rulesHash:planDigest({libraryIdentity:current.libraryIdentity,rules})};
   });queues.set(initial.file,pending);try{return await pending;}finally{if(queues.get(initial.file)===pending)queues.delete(initial.file);}
  },
 };
}
