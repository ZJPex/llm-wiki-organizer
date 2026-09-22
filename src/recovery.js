import path from 'node:path';
import {atomicRename} from './atomic-rename.js';
import {readFile,writeFile,mkdir,lstat,stat,rename,copyFile,statfs} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {inventory} from './compatibility.js';
import {safePath,verifyBackup,copyTree,layout,relocateValidationCopy} from './backup.js';
import {planDigest} from './categories.js';
import {modelGuard,nativeRescanVerifier,requireQuietRescan} from './migration-verifier.js';
import {analyzeIndexes,verifyIndexContents} from './indexes.js';
import {analyzeLinks} from './links.js';
import {sourceFrontmatter} from './source-format.js';
import {recordKind} from './relocation-records.js';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const key=value=>path.resolve(value).replaceAll('\\','/').toLowerCase();
const inside=(root,file)=>key(file)===key(root)||key(file).startsWith(key(root)+'/');
const stateFiles=['project.json','ingest-cache.json','ingest-queue.json','file-change-queue.json'];
const active=new Set();
async function exists(file){return !!await lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});}
async function json(file){if(typeof file!=='string'||!path.isAbsolute(file))fail('INVALID_EVIDENCE','证据必须为绝对路径');await safePath(path.dirname(file));const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink>1)fail('INVALID_EVIDENCE','证据不能是链接或共享文件');return JSON.parse(await readFile(file,'utf8'));}
function checkDigest(record,field){const {[field]:expected,...unsigned}=record;if(!expected||planDigest(unsigned)!==expected)fail('INVALID_EVIDENCE','持久证据内容校验失败');}
async function digestFile(file){return hash(await readFile(file));}
async function persist(file,record){const tmp=`${file}.tmp-${randomUUID()}`;await writeFile(tmp,JSON.stringify(record,null,2),{flag:'wx'});await atomicRename(tmp,file);}
function differences(actual,expected){const before=new Map(expected.files.map(f=>[f.path,f.hash])),now=new Map(actual.files.map(f=>[f.path,f.hash]));return {added:actual.files.filter(f=>!before.has(f.path)).map(f=>f.path),modified:actual.files.filter(f=>before.has(f.path)&&before.get(f.path)!==f.hash).map(f=>f.path),missing:expected.files.filter(f=>!now.has(f.path)).map(f=>f.path)};}
export async function readRecoveryEvidence(journalPath){
 // 校验完整备份和证据链；失败根本来就可能偏离迁移前清单，不复用迁移的三根基线检查。
 const journal=await json(journalPath),manifest=await json(journal.planManifestPath);
 const {manifestHash,...unsigned}=manifest;
 if(manifest.schemaVersion!==1||planDigest(unsigned)!==manifestHash||journal.planManifestHash!==manifestHash||journal.logicalPlanHash!==manifest.logicalPlanHash||planDigest(manifest.logicalPlan)!==manifest.logicalPlanHash)fail('INVALID_EVIDENCE','迁移计划与日志校验不一致');
 const backup=await json(journal.backupReportPath);
 if(backup.status!=='complete'||!backup.backupVerified||!backup.validationVerified||!backup.version?.verifiedSource||await digestFile(journal.backupReportPath)!==manifest.backupManifestHash||journal.backupManifestHash!==manifest.backupManifestHash)fail('INVALID_EVIDENCE','备份报告与计划不一致');
 const target=journal.targetRole==='validation'?backup.validationPath:journal.targetRole==='original'?backup.originalPath:null;
 if(!target||key(target)!==key(journal.targetRoot)||key(journal.backupReportPath)!==key(manifest.backupReportPath)||journal.planId!==manifest.planId)fail('INVALID_EVIDENCE','迁移目标角色、位置或批次不一致');
 for(const root of [backup.originalPath,backup.backupPath,backup.validationPath])await safePath(root,{missingLeaf:true});
 const roots=[backup.originalPath,backup.backupPath,backup.validationPath];for(let i=0;i<3;i++)for(let j=i+1;j<3;j++)if(inside(roots[i],roots[j])||inside(roots[j],roots[i]))fail('OVERLAPPING_PATHS','恢复证据包含重叠位置');
 await verifyBackup(backup.backupPath,backup.baseline,backup.directories);
 if((await json(path.join(backup.backupPath,'.llm-wiki/project.json'))).id!==backup.relocation?.originalProjectId)fail('INVALID_EVIDENCE','备份项目身份不一致');
 return {journal,manifest,backup,target};
}
async function copyResumable(source,destination,baseline,directories){
 // 中断留下的相同字节可复用，任何未知内容都停止，不覆盖也不删除现场。
 await safePath(destination,{missingLeaf:true});
 if(!await exists(destination))await mkdir(destination);
 const existing=await inventory(destination), expected=new Map(baseline.files.map(f=>[f.path,f.hash]));
 if(existing.files.some(f=>expected.get(f.path)!==f.hash))fail('RECOVERY_COPY_CONFLICT','恢复工作目录包含未知或不同内容，保留现场并停止');
 await copyTree(source,destination,baseline,directories,async(from,to,flags)=>{if(!await exists(to))await copyFile(from,to,flags);else if(await digestFile(from)!==await digestFile(to))fail('RECOVERY_COPY_CONFLICT','复制恢复内容冲突');});
}
async function captureState(root){
 const baseline=await inventory(root);
 const files=[...stateFiles,...baseline.files.filter(file=>recordKind(file.path)).map(file=>file.path.slice('.llm-wiki/'.length))];
 return Object.fromEntries(await Promise.all(files.map(async file=>[file,(await readFile(path.join(root,'.llm-wiki',file))).toString('base64')])));
}
async function applyBinding(root,binding){
 const current=await captureState(root);
 const files=Object.keys(current).sort();
 if(JSON.stringify(files)!==JSON.stringify(Object.keys(binding.before).sort())||JSON.stringify(files)!==JSON.stringify(Object.keys(binding.after).sort()))fail('RECOVERY_BIND_CONFLICT','恢复绑定文件集合发生变化，保留现场');
 for(const file of files){const stat=await lstat(path.join(root,'.llm-wiki',file));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail('RECOVERY_BIND_CONFLICT','恢复绑定文件出现链接或共享内容，保留现场');}
 // 先核验所有文件，再写入；只允许日志记录的前态、后态或两者组成的中断状态。
 for(const file of files)if(current[file]!==binding.before[file]&&current[file]!==binding.after[file])fail('RECOVERY_BIND_CONFLICT','恢复绑定状态出现用户修改或未知内容，保留全部现场并停止');
 for(const file of files)if(current[file]!==binding.after[file])await writeFile(path.join(root,'.llm-wiki',file),Buffer.from(binding.after[file],'base64'));
}
async function validateLibrary(root,projectId,expectedIndexes,verify,models,backupBaseline){
 const baseline=await inventory(root),files=new Map(baseline.files.map(f=>[f.path,f]));
 const cache=await json(path.join(root,'.llm-wiki/ingest-cache.json'));
 if(!cache.entries||Array.isArray(cache.entries))fail('INVALID_ASSOCIATION','恢复缓存格式无效');
 for(const [identity,entry] of Object.entries(cache.entries)){
  const source=files.get(`raw/sources/${identity}`);
  if(!source||source.hash!==entry.hash||!Array.isArray(entry.filesWritten))fail('INVALID_ASSOCIATION','恢复来源与缓存内容不一致');
  for(const output of entry.filesWritten){const relative=path.isAbsolute(output)||path.win32.isAbsolute(output)?inside(root,output)?path.relative(root,output).replaceAll('\\','/'):null:output;
   if(!relative||relative.split('/').includes('..'))fail('INVALID_ASSOCIATION','恢复缓存产出不存在或越界');
   if(!files.has(relative)){
    const aliases=process.platform==='win32'?baseline.files.filter(file=>file.path.toLowerCase()===relative.toLowerCase()):[];
    if(aliases.length!==1)fail('INVALID_ASSOCIATION','恢复缓存产出不存在或越界');
    const [a,b]=await Promise.all([stat(path.join(root,relative)),stat(path.join(root,aliases[0].path))]);
    if(!a.isFile()||!b.isFile()||a.dev!==b.dev||a.ino!==b.ino)fail('INVALID_ASSOCIATION','恢复缓存产出不是同一实际文件');
   }}
 }
 const documents=[],preexistingSourceIssues=[];
 for(const file of baseline.files.filter(f=>f.path.endsWith('.md'))){const text=await readFile(path.join(root,file.path),'utf8');const fm=sourceFrontmatter(text);documents.push({path:file.path,text,frontmatter:fm});
  if(file.path.startsWith('wiki/'))for(const source of fm.sources){
   const identity=source.replaceAll('\\','/').replace(/^raw\/sources\//,'');
   const matches=rows=>rows.filter(f=>f.path.startsWith('raw/sources/')&&(f.path===`raw/sources/${identity}`||!identity.includes('/')&&path.posix.basename(f.path)===identity));
   const candidates=matches(baseline.files);
   if(candidates.length!==1){
    const before=matches(backupBaseline.files),original=backupBaseline.files.find(f=>f.path===file.path);
    if(original?.hash!==file.hash||before.length!==candidates.length||!before.every(f=>candidates.some(c=>c.path===f.path&&c.hash===f.hash)))fail('INVALID_ASSOCIATION',`恢复页面出现新的来源解析问题：${file.path}`);
    preexistingSourceIssues.push({path:file.path,source});
   }
  }
 }
 const links=await analyzeLinks({root,baseline,documents,moves:[],changes:new Map(),affectedPages:[]});
 const indexes=await verifyIndexContents(root,expectedIndexes);
 const preserved=await Promise.all(['file-snapshot.json','file-change-queue.json'].map(async name=>({file:path.join(root,'.llm-wiki',name),bytes:await readFile(path.join(root,'.llm-wiki',name))})));
 let proof;
 try{proof=requireQuietRescan(await verify({validationPath:root,projectId,models}));if(models.attempts.length)fail('MODEL_ATTEMPT','恢复验证尝试调用模型');}
 finally{for(const entry of preserved)await writeFile(entry.file,entry.bytes);}
 return {sources:Object.keys(cache.entries).length,preexistingSourceIssues,links,indexes,proof};
}
function publicReport(report){const {bindingPreimages,restoreBinding,finalBinding,...safe}=report;return safe;}
export function createRecoveryService({verify=nativeRescanVerifier(),checkpoint=async()=>{},space=statfs}={}){
 async function inspectRecovery({journalPath}){const {journal,manifest,backup,target}=await readRecoveryEvidence(journalPath);const actual=await inventory(target);return {status:'inspectable',targetRole:journal.targetRole,targetRoot:target,logicalPlanHash:manifest.logicalPlanHash,phase:journal.phase,completed:journal.completed??[],intents:journal.intents??[],changes:differences(actual,journal.beforeBaseline??manifest.beforeBaseline),backupPath:backup.backupPath,actualBaseline:actual};}
 async function planRecovery(input){
  if(input.writersPaused!==true)fail('WRITERS_NOT_PAUSED','请先暂停全部相关写入');
  if(!['new-directory','same-location'].includes(input.mode))fail('INVALID_RECOVERY','恢复模式无效');
  const evidence=await readRecoveryEvidence(input.journalPath),{journal,manifest,backup,target}=evidence;
  const inspected=await inspectRecovery(input),id=randomUUID();
  const destination=input.mode==='same-location'?target:await safePath(input.destination,{missingLeaf:true});
  const staging=input.mode==='same-location'?`${target}.restore-${id}`:destination;
  const scene=input.scenePath?await safePath(input.scenePath,{missingLeaf:true}):`${target}.scene-${id}`;
  const reserved=[scene,staging];for(const value of reserved){await safePath(value,{missingLeaf:true});if(await exists(value))fail('TARGET_EXISTS','恢复或现场目标已存在，禁止覆盖');}
  const roots=[backup.originalPath,backup.backupPath,backup.validationPath,...reserved];for(let i=0;i<roots.length;i++)for(let j=i+1;j<roots.length;j++)if(inside(roots[i],roots[j])||inside(roots[j],roots[i]))fail('OVERLAPPING_PATHS','恢复、现场与三份数据必须独立');
  if(input.mode==='same-location'&&(await lstat(path.dirname(scene))).dev!==(await lstat(path.dirname(target))).dev)fail('CROSS_VOLUME','原位置恢复要求同卷换位');
  const required=backup.baseline.files.reduce((n,f)=>n+f.size,0)+inspected.actualBaseline.files.reduce((n,f)=>n+f.size,0);
  for(const volume of new Set(reserved.map(p=>path.dirname(p)))){const stat=await space(volume);if(Number(stat.bavail)*Number(stat.bsize)<required)fail('INSUFFICIENT_SPACE','恢复工作目录磁盘空间不足');}
  const targetId=journal.targetRole==='original'?backup.relocation.originalProjectId:backup.relocation.validationProjectId;
  const record={schemaVersion:1,recoveryId:id,backupPath:backup.backupPath,batchId:backup.batchId,logicalPlanHash:manifest.logicalPlanHash,planManifestPath:journal.planManifestPath,planManifestHash:journal.planManifestHash,backupReportPath:journal.backupReportPath,backupManifestHash:journal.backupManifestHash,sourceJournalPath:input.journalPath,sourceJournalHash:await digestFile(input.journalPath),targetRole:journal.targetRole,targetRoot:target,mode:input.mode,destination,stagingPath:staging,scenePath:scene,targetProjectId:input.mode==='new-directory'?randomUUID():targetId,stagingProjectId:randomUUID(),beforeBaseline:inspected.actualBaseline,beforeDirectories:await layout(target),changes:inspected.changes};
  record.recoveryPlanHash=planDigest(record);
  const recoveryPlanPath=`${target}.recovery-${id}.json`;await writeFile(recoveryPlanPath,JSON.stringify(record,null,2),{flag:'wx'});
  return {...record,recoveryPlanPath,status:'awaiting-review'};
 }
 async function executeRecovery({recoveryPlanPath,approved,writersPaused}){
  if(!approved||!writersPaused)fail('REVIEW_REQUIRED','恢复前必须审核确认并暂停写入');
  const plan=await json(recoveryPlanPath),{recoveryPlanHash,...unsigned}=plan;
  if(plan.schemaVersion!==1||planDigest(unsigned)!==recoveryPlanHash||key(recoveryPlanPath)!==key(`${plan.targetRoot}.recovery-${plan.recoveryId}.json`))fail('INVALID_RECOVERY','恢复计划损坏或位置不一致');
  if(active.has(key(plan.targetRoot)))fail('RECOVERY_BUSY','该目标正在恢复');active.add(key(plan.targetRoot));
  try{return await perform(plan,recoveryPlanPath);}finally{active.delete(key(plan.targetRoot));}
 }
 async function perform(plan,recoveryPlanPath){
  const evidence=await readRecoveryEvidence(plan.sourceJournalPath),{backup,manifest,journal}=evidence;
  if(await digestFile(plan.sourceJournalPath)!==plan.sourceJournalHash||plan.logicalPlanHash!==manifest.logicalPlanHash||plan.planManifestHash!==manifest.manifestHash||plan.backupManifestHash!==manifest.backupManifestHash)fail('INVALID_EVIDENCE','恢复审核后迁移证据发生变化');
  const reportPath=`${recoveryPlanPath}.result.json`;
  let report=await json(reportPath).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(report)checkDigest(report,'reportHash');
  if(report&&report.recoveryPlanHash!==plan.recoveryPlanHash)fail('INVALID_RECOVERY','恢复结果不属于该计划');
  if(report?.status==='complete'){await verifyBackup(plan.destination,report.afterBaseline);await verifyBackup(plan.scenePath,plan.beforeBaseline,plan.beforeDirectories);return publicReport(report);}
  report??={...plan,recoveryPlanPath,reportPath,status:'running',phase:'planned',completed:[],modelAttempts:[]};
  const models=modelGuard();
  const save=async()=>{report.modelAttempts.push(...models.attempts.splice(0));delete report.reportHash;report.reportHash=planDigest(report);await persist(reportPath,report);};
  const step=async(name,action)=>{if(report.completed.includes(name))return;report.phase=name;report.status='running';await save();await action();await checkpoint(name,{report:publicReport(report),models});if(models.attempts.length||report.modelAttempts.length)fail('MODEL_ATTEMPT','恢复步骤尝试调用模型');report.completed.push(name);await save();};
  const expectedIndexes=await analyzeIndexes({baseline:backup.baseline,root:backup.backupPath,moves:[],changes:new Map()});
  try{
   if(!report.completed.includes('park')&&!report.completed.includes('install')&&await exists(plan.targetRoot))await verifyBackup(plan.targetRoot,plan.beforeBaseline,plan.beforeDirectories);
   if(plan.mode==='new-directory')await step('scene-copy',async()=>{await copyResumable(plan.targetRoot,plan.scenePath,plan.beforeBaseline,plan.beforeDirectories);await verifyBackup(plan.targetRoot,plan.beforeBaseline,plan.beforeDirectories);});
   await step('restore-copy',async()=>{await copyResumable(backup.backupPath,plan.stagingPath,backup.baseline,backup.directories);});
   await step('restore-bind',async()=>{
    if(!report.restoreBinding){const before=await captureState(plan.stagingPath),expected=await captureState(backup.backupPath);if(planDigest(before)!==planDigest(expected))fail('RECOVERY_BIND_CONFLICT','恢复暂存状态偏离完整备份，保留现场');const prepared=await relocateValidationCopy(plan.stagingPath,backup.originalPath,{targetId:plan.stagingProjectId,expectedSourceId:backup.relocation.originalProjectId,prepareOnly:true});report.restoreBinding={before,after:prepared.stateContents};await save();}
    await applyBinding(plan.stagingPath,report.restoreBinding);
   });
   await step('restore-verify',async()=>{report.stagingProof=await validateLibrary(plan.stagingPath,plan.stagingProjectId,expectedIndexes,verify,models,backup.baseline);report.stagingBaseline=await inventory(plan.stagingPath);report.bindingPreimages=await captureState(plan.stagingPath);await save();});
   if(plan.mode==='same-location'){
    // rename 与 completed 之间进程可能退出，续作依靠目录存在性及清单识别已完成换位。
    await step('park',async()=>{if(await exists(plan.scenePath)){if(await exists(plan.targetRoot))fail('RECOVERY_CONFLICT','现场与原目标同时存在，不能猜测换位状态');await verifyBackup(plan.scenePath,plan.beforeBaseline,plan.beforeDirectories);}else{await verifyBackup(plan.targetRoot,plan.beforeBaseline,plan.beforeDirectories);await rename(plan.targetRoot,plan.scenePath);} });
    await step('install',async()=>{if(await exists(plan.stagingPath)){if(await exists(plan.targetRoot))fail('TARGET_EXISTS','原位置被占用，不能覆盖');await verifyBackup(plan.stagingPath,report.stagingBaseline);await rename(plan.stagingPath,plan.targetRoot);}else{await verifyBackup(plan.targetRoot,report.stagingBaseline);} });
   }
   await step('final-bind',async()=>{
    if(!report.finalBinding){const before=await captureState(plan.destination);if(planDigest(before)!==planDigest(report.bindingPreimages))fail('RECOVERY_BIND_CONFLICT','最终绑定前状态已改变，保留现场');const prepared=await relocateValidationCopy(plan.destination,plan.stagingPath,{targetId:plan.targetProjectId,expectedSourceId:plan.stagingProjectId,prepareOnly:true});report.finalBinding={before,after:prepared.stateContents};await save();}
    await applyBinding(plan.destination,report.finalBinding);
   });
   await step('final-verify',async()=>{report.verification=await validateLibrary(plan.destination,plan.targetProjectId,expectedIndexes,verify,models,backup.baseline);report.afterBaseline=await inventory(plan.destination);await verifyBackup(backup.backupPath,backup.baseline,backup.directories);await verifyBackup(plan.scenePath,plan.beforeBaseline,plan.beforeDirectories);if(plan.mode==='new-directory')await verifyBackup(plan.targetRoot,plan.beforeBaseline,plan.beforeDirectories);});
   delete report.error;report.status='complete';report.phase='complete';report.restoreRoot=plan.destination;report.projectId=plan.targetProjectId;report.backupUnchanged=true;report.finishedAt=new Date().toISOString();
  }catch(error){report.status='failed';report.error={code:error.code??'RECOVERY_FAILED',message:error.message};}
  await save();report.reportHash=planDigest(Object.fromEntries(Object.entries(report).filter(([k])=>k!=='reportHash')));await persist(reportPath,report);return publicReport(report);
 }
 async function get({recoveryPlanPath}){const plan=await json(recoveryPlanPath);checkDigest(plan,'recoveryPlanHash');const report=await json(`${recoveryPlanPath}.result.json`).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(report){checkDigest(report,'reportHash');if(report.recoveryPlanHash!==plan.recoveryPlanHash)fail('INVALID_EVIDENCE','结果不属于所选恢复计划');}return report?publicReport(report):{...plan,status:'awaiting-review',recoveryPlanPath};}
 return {inspect:inspectRecovery,plan:planRecovery,execute:executeRecovery,get,inspectRecovery,planRecovery,executeRecovery};
}
