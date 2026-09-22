import path from 'node:path';
import {readFile,writeFile,mkdir,rename,lstat,readdir,copyFile,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {discoverSources,assertSourceAssociation} from './batch-sources.js';
import {safePath} from './backup.js';
import {categoryCatalog,planDigest} from './categories.js';
import {validateName} from './planning.js';
import {inventory} from './compatibility.js';
import {localReferences} from './links.js';
import {selectedEvolution,sourceDirectoryDependency} from './directory-dependencies.js';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const key=value=>path.resolve(value).replaceAll('\\','/').toLowerCase();
const inside=(root,file)=>key(file)===key(root)||key(file).startsWith(`${key(root)}/`);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const inputFor=(batch,source)=>({sourceRoot:batch.sourceRoot,libraryPath:batch.libraryPath,configPath:batch.configPath,identity:source.currentIdentity??source.identity,categoryRoot:path.join(batch.libraryPath,'raw/sources')});
async function checkedFile(file,expected) {
  await safePath(path.dirname(file));const stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail('UNSAFE_SOURCE','来源必须为独立普通文件');
  if(expected&&digest(await readFile(file))!==expected)fail('STALE_SOURCE','来源内容已变化，请重新分析审核');
}
async function checkTarget(root,target,source) {
  if(!inside(root,target)||key(root)===key(target))fail('INVALID_TARGET','归档目标必须在 Raw 内');
  let parent=path.dirname(target),missing=[];
  while(true){try{await safePath(parent);break;}catch(error){if(error.code!=='ENOENT')throw error;missing.unshift(path.basename(parent));parent=path.dirname(parent);}}
  const segments=[...missing,path.basename(target)];
  for(const [index,name] of segments.entries()) {
    if(!name||name==='.'||name==='..'||/[<>:"\\|?*\x00-\x1f]/.test(name)||/[. ]$/.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))fail('INVALID_TARGET','目标名称不符合文件系统规则');
    const found=(await readdir(parent).catch(error=>{if(error.code==='ENOENT')return [];throw error;})).find(value=>value.toLowerCase()===name.toLowerCase());
    const next=path.join(parent,name);
    if(found&&index===segments.length-1&&key(next)!==key(source??''))fail('TARGET_EXISTS','归档目标已存在，不能覆盖或自动加后缀');
    if(found&&found!==name)fail('TARGET_EXISTS','目标祖先存在大小写冲突');
    parent=next;
  }
}
async function watchSettings(batch) {
  if(!batch.configPath)fail('WATCH_CONFIG_REQUIRED','请选择 Wiki 实际配置文件，以核验首次摄取设置');
  const state=JSON.parse(await readFile(batch.configPath,'utf8'));
  const defaults=JSON.parse(await readFile(path.join(batch.wikiSourcePath,'src/lib/source-watch-defaults.json'),'utf8'));
  const value={...defaults,...state.sourceWatchConfig};
  if(typeof value.enabled!=='boolean'||typeof value.autoIngest!=='boolean'||!['includeExtensions','excludeExtensions','excludeDirs','excludeGlobs'].every(name=>Array.isArray(value[name])&&value[name].every(item=>typeof item==='string')))fail('UNKNOWN_WATCH_CONFIG','首次摄取设置格式未知');
  return {settings:value,hash:planDigest(value),disposition:value.enabled&&value.autoIngest?'awaiting-wiki-policy':'archived-without-ingest-request',message:value.enabled&&value.autoIngest?'归档后等待 Wiki 按现有过滤与首次摄取设置处理；Organizer 未入队':'归档后未请求摄取；保留 Wiki 当前关闭设置'};
}
async function currentSources(batch) {
  const result=await discoverSources(batch);
  if(result.flow?.busy)fail('SOURCE_BUSY','知识库存在待执行或执行中的任务，请暂停并处理后重试');
  return result.sources;
}
async function checkNewLinks(batch,moves){
 const changed=moves.filter(move=>path.resolve(move.from)!==path.resolve(move.to));if(!changed.length)return;
 const documents=new Map();
 const roots=await Promise.all([batch.libraryPath,batch.sourceRoot].map(root=>safePath(root)));
 for(const root of new Set(roots))for(const file of (await inventory(root)).files.filter(file=>/\.md$/i.test(file.path))){const full=path.join(root,file.path);documents.set(key(full),full);}
 for(const file of documents.values()){
  const references=localReferences(await readFile(file,'utf8'));
  if(changed.some(move=>key(move.from)===key(file))&&references.length)fail('UNSUPPORTED_NEW_LINKS',`新增材料含本地图片或材料链接，当前归档不能证明目标不变，保留原处：${file}`);
  for(const reference of references){
   if(reference.invalid)continue;
   const relative=path.resolve(path.dirname(file),reference.decoded);
   const targets=reference.kind==='wiki'?[relative,path.resolve(roots[1],reference.decoded),path.resolve(roots[0],reference.decoded)]:[relative];
   const targetsMoved=changed.some(move=>targets.some(target=>key(target)===key(move.from)||(!path.extname(reference.decoded)&&key(`${target}.md`)===key(move.from)))||(reference.kind==='wiki'&&key(move.from).endsWith('/'+reference.decoded.toLowerCase().replace(/\.md$/i,'')+'.md')));
   if(targetsMoved)fail('UNSUPPORTED_NEW_LINKS',`未归档材料存在指向本批来源的本地反链，当前不能安全修复，保留原处：${file}`);
  }
 }
}

export function createInboxStrategy({checkpoint=async()=>{}}={}) {
  return {
    async discover({input}) {
      // Windows 短路径与长路径可能指向同一目录，先拒绝连接再规范化边界。
      const libraryPath=await safePath(input.libraryPath),sourceRoot=await safePath(input.sourceRoot);
      const raw=path.join(libraryPath,'raw/sources');
      if(inside(sourceRoot,libraryPath)||(inside(libraryPath,sourceRoot)&&!inside(raw,sourceRoot)))fail('INVALID_INBOX','库内 Inbox 必须位于 raw/sources；外部 Inbox 必须与知识库独立');
      const result=await discoverSources({...input,libraryPath,sourceRoot});return {...result,flow:{...result.flow,stage:'analysis',historyBeforeNew:true}};
    },
    async analyze({batch,source,planning,onProgress,reanalyze}) {
      if(source.ingestStatus==='uncertain')return {status:'blocked',selected:false};
      await checkedFile(source.currentPath,source.hash);
      let entry=await planning.analyze({...inputFor(batch,source),onProgress,reanalyze});
      const reliable=entry.analysis&&!entry.analysis.uncertain&&['body','navigation'].includes(entry.kind);
      if(reliable&&!entry.classification&&planning.classify)entry=await planning.classify({...inputFor(batch,source),onProgress});
      return {...entry,status:reliable?(entry.classification?'classified':'analyzed'):'needs-information',selected:false,analysisCalls:entry.reused?0:entry.segments?.length??0};
    },
    async review({batch,source,input,planning,onProgress}) {
      if(input.action==='exclude')return {sourcePatch:{selected:false,status:'excluded',skipReason:'用户排除'}};
      await checkedFile(source.currentPath,source.hash);
      if(source.ingestStatus==='uncertain'||!source.analysis||source.analysis.uncertain||!['body','navigation'].includes(source.kind))fail('INSUFFICIENT_EVIDENCE','来源关联或内容证据不足，保持原处');
      const base=inputFor(batch,source);
      if(input.action==='discardEvolution'){
        if(!source.evolution)fail('EVOLUTION_REQUIRED','该材料没有待修正的目录调整');
        if(batch.flow.evolutionPlan&&input.discardShared!==true)fail('SHARED_EVOLUTION_REVIEW_REQUIRED','撤销已冻结的共享目录方案需明确确认整份撤销和关联材料重审');
        await planning.discardEvolution(base);
        return {sourcePatch:{evolution:null,status:'classified',selected:false,targetPath:null,frozenPlan:null},flowPatch:{evolutionPlan:null},discardedEvolutionHash:batch.flow.evolutionPlan?.planHash};
      }
      if(input.action==='confirmPlan') {
        const dependent=sourceDirectoryDependency(batch,source,path.resolve(base.categoryRoot,input.category??'',input.name??''));
        if(dependent){
          if(!batch.flow.evolutionPlan||(source.evolution?.operations?.length&&source.evolution.status!=='confirmed'))fail('EVOLUTION_REVIEW_REQUIRED','该材料涉及目录调整，请先确认或修正完整目录方案');
          if(source.confirmedName&&source.confirmedName!==input.name)fail('NAME_REQUIRED','已确认名称保持稳定');
          const result=await this.review({batch,source:{...source,confirmedName:input.name},input:{action:'confirmCategory',category:input.category},planning});
          const named=await planning.confirm({...base,name:input.name});
          return {sourcePatch:{...named,...result.sourcePatch,manuallyEdited:input.manuallyEdited===true}};
        }
        const entry=await planning.confirmPlan({...base,name:input.name,category:input.category});
        return {sourcePatch:{...entry,targetPath:entry.frozenPlan.finalPath,status:'reviewed',selected:true,manuallyEdited:input.manuallyEdited===true}};
      }
      if(input.action==='classify')return {sourcePatch:{...await planning.classify({...base,onProgress}),status:'classified',selected:false,targetPath:null}};
      if(input.action==='confirmName') {
        const entry=await planning.confirm({...base,name:input.name});
        return {sourcePatch:{...entry,classification:entry.classification??null,frozenPlan:null,status:'named',selected:false,targetPath:null}};
      }
      if(!source.confirmedName)fail('NAME_REQUIRED','先确认文件名，再查找分类');

      if(!source.classification)fail('CLASSIFICATION_REQUIRED','先检索已有分类，再决定是否需要演化');
      if(input.action==='evolve')return {sourcePatch:{evolution:await planning.evolve({...base,startCategory:input.category??''}),status:'evolution-review',selected:false}};
      if(input.action==='confirmEvolution') {
        if(!source.evolution)fail('EVOLUTION_REQUIRED','没有待审核的局部演化方案');
        const operations=input.operations??source.evolution.operations;
        const evolution=await planning.confirmEvolution({...base,operations});
        if(batch.flow.evolutionPlan&&batch.flow.evolutionPlan.planHash!==evolution.frozenPlan.planHash)fail('EVOLUTION_CONFLICT','本批已有另一目录演化，请先完成该批或重新统一审核');
        return {sourcePatch:{evolution,status:'classified',selected:false},flowPatch:{evolutionPlan:evolution.frozenPlan}};
      }
      if(input.action==='confirmCategory') {
        const evolution=sourceDirectoryDependency(batch,source,path.resolve(base.categoryRoot,input.category??'',source.confirmedName))?batch.flow.evolutionPlan:null;
        if(evolution) {
          const {planHash,...unsigned}=evolution;if(planHash!==planDigest(unsigned))fail('INVALID_EVOLUTION','目录演化计划损坏');
          const catalog=await categoryCatalog(base.categoryRoot);
          if(catalog.hash!==evolution.catalogHash)fail('STALE_PLAN','分类树已变化');
          const categories=new Set([...catalog.categories.map(item=>item.path),...evolution.newDirectories,...evolution.directoryMappings.map(item=>item.to)]);
          if(!categories.has(input.category))fail('INVALID_CATEGORY','目标不在已审核的现有或演化分类中');
          validateName(source.confirmedName);
          const targetPath=path.join(base.categoryRoot,input.category,source.confirmedName);
          await checkTarget(base.categoryRoot,targetPath,source.currentPath);
          const frozen={sourceHash:source.hash,name:source.confirmedName,category:input.category,finalPath:targetPath,catalogHash:catalog.hash,evolutionHash:evolution.planHash};
          return {sourcePatch:{targetPath,classification:{...source.classification,category:input.category,finalPath:targetPath,status:'confirmed'},frozenPlan:{...frozen,planHash:planDigest(frozen)},status:'reviewed',selected:true}};
        }
        const entry=await planning.confirmCategory({...base,category:input.category});
        return {sourcePatch:{...entry,targetPath:entry.frozenPlan.finalPath,status:'reviewed',selected:true}};
      }
      fail('INVALID_REVIEW','不支持的 Inbox 审核步骤');
    },
    async prepare({batch,selected}) {
      const discovered=await currentSources(batch),categoryRoot=path.join(batch.libraryPath,'raw/sources');
      const evolution=selectedEvolution(batch,selected),mappings=[],newFiles=[],destinations=new Set();
      for(const source of selected) {
        const current=discovered.find(value=>key(value.currentPath)===key(source.currentPath));
        if(!current||current.hash!==source.hash)fail('STALE_SOURCE','来源记录已变化');
        assertSourceAssociation(source,current);
        if(source.status!=='reviewed'||!source.frozenPlan||!source.targetPath)fail('REVIEW_REQUIRED','请先完成命名、分类和路径审核');
        const {planHash,...unsigned}=source.frozenPlan;if(planDigest(unsigned)!==planHash)fail('INVALID_PLAN','文件审核计划已损坏');
        if((await categoryCatalog(categoryRoot)).hash!==source.frozenPlan.catalogHash)fail('STALE_PLAN','分类树变化，需要重新审核');
        await checkedFile(source.currentPath,source.hash);await checkTarget(categoryRoot,source.targetPath,source.currentPath);
        if(destinations.has(key(source.targetPath)))fail('TARGET_EXISTS','批次中存在重复目标');destinations.add(key(source.targetPath));
        if(source.ingestStatus==='historical')mappings.push({id:source.sourceId,from:`raw/sources/${current.rawIdentity}`,to:path.relative(batch.libraryPath,source.targetPath).replaceAll('\\','/')});
        else if(source.ingestStatus==='new') {
          if(key(source.currentPath)===key(source.targetPath)&&path.resolve(source.currentPath)!==path.resolve(source.targetPath))fail('CASE_ONLY_NEW_UNSUPPORTED','未摄取材料仅大小写改名需先人工处理，不能静默忽略');
          newFiles.push({sourceId:source.sourceId,from:source.currentPath,to:source.targetPath,hash:source.hash,ingestStatus:source.ingestStatus,associationHash:source.associationHash});
        }
        else fail('UNKNOWN_ASSOCIATION','不能安全判断来源关联');
      }
      if(evolution)for(const move of evolution.fileMappings) {
        const from=`raw/sources/${move.from}`,existing=mappings.find(item=>item.from===from);
        if(!existing)mappings.push({id:`history:${move.from}`,from,to:`raw/sources/${move.to}`});
      }
      await checkNewLinks(batch,newFiles);
      return {historicalRequest:mappings.length?{mappings,...(evolution?{evolutionPlan:evolution}:{})}:null,newFiles,affectedSourceIds:selected.map(source=>source.sourceId),watchConfig:await watchSettings(batch)};
    },
    async archive({batch,slice,artifactDirectory}) {
      const raw=path.join(batch.libraryPath,'raw/sources'),sourceRoot=await safePath(batch.sourceRoot);
      await safePath(artifactDirectory);
      if(inside(batch.libraryPath,artifactDirectory)||inside(batch.sourceRoot,artifactDirectory))fail('UNSAFE_JOURNAL','归档日志必须在库与 Inbox 之外');
      const archiveJournalPath=path.join(artifactDirectory,'inbox-archive.json');
      const manifest={batchId:batch.batchId,sliceId:slice.sliceId,newFiles:slice.newFiles,watchConfig:slice.watchConfig};
      const manifestHash=planDigest(manifest);
      let journal;
      try{journal=JSON.parse(await readFile(archiveJournalPath,'utf8'));const {journalHash,...unsigned}=journal;if(journalHash!==planDigest(unsigned)||journal.manifestHash!==manifestHash)fail('INVALID_JOURNAL','归档日志或冻结计划变化');}
      catch(error){if(error.code!=='ENOENT')throw error;journal={schemaVersion:1,...manifest,manifestHash,status:'running',items:slice.newFiles.map(file=>({...file,status:'pending'})),events:[]};}
      const save=async()=>{delete journal.journalHash;journal.journalHash=planDigest(journal);const temp=`${archiveJournalPath}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(journal,null,2),{flag:'wx'});await rename(temp,archiveJournalPath);};
      const answer=()=>({status:journal.status,items:journal.items,archiveJournalPath,watchConfig:journal.watchConfig,historyModelAttempts:[],newIngestRequests:[],committedMappings:journal.items.filter(item=>item.status==='succeeded').map(item=>({...item,sourceRoot:batch.sourceRoot,targetRoot:raw,currentIdentity:path.relative(raw,item.to).replaceAll('\\','/')}))});
      if(journal.status==='complete') {for(const item of journal.items)await checkedFile(item.to,item.hash);return answer();}
      await save();
      try {
        if(slice.historicalRequest&&!['complete','partial'].includes(slice.historicalResult?.status))fail('HISTORY_REQUIRED','历史迁移尚未通过原库执行，不归档新增材料');
        if(slice.historicalResult?.items?.some(item=>['failed','applied-unverified','not-run','pending','selected'].includes(item.status)))fail('HISTORY_REQUIRED','历史材料仍有未成功项目');
        if(slice.historicalRequest?.mappings?.some(mapping=>!slice.historicalResult?.items?.some(item=>item.from===mapping.from&&item.to===mapping.to&&item.status==='succeeded')))fail('HISTORY_REQUIRED','新增材料依赖的历史映射尚未全部成功，不能扩大安全子集');
        const watch=await watchSettings(batch);if(watch.hash!==slice.watchConfig.hash)fail('STALE_SETTINGS','首次摄取设置变化，请重新审核');
        const checkAssociations=async()=>{const found=await discoverSources({...batch,includeIdentities:journal.items.filter(item=>item.status!=='succeeded').map(item=>path.relative(sourceRoot,item.from).replaceAll('\\','/'))});if(found.flow.busy)fail('SOURCE_BUSY','知识库有待处理任务，归档暂停');for(const item of journal.items.filter(item=>item.status!=='succeeded'))assertSourceAssociation(item,found.sources.find(source=>key(source.currentPath)===key(item.from)));};
        await checkAssociations();
        await checkNewLinks(batch,journal.items.filter(item=>item.status!=='succeeded'));
        for(const item of journal.items.filter(item=>item.status==='pending')){await checkedFile(item.from,item.hash);await checkTarget(raw,item.to,item.from);}
        for(const item of journal.items) {
          if(item.status==='succeeded')continue;
          if(key(item.from)===key(item.to)){await checkedFile(item.from,item.hash);item.status='succeeded';await save();continue;}
          if(item.status==='pending') {
            await checkAssociations();await checkedFile(item.from,item.hash);await checkTarget(raw,item.to,item.from);await mkdir(path.dirname(item.to),{recursive:true});await safePath(path.dirname(item.to));
            item.status='copy-intent';await save();await checkpoint('before-copy',item);
            await copyFile(item.from,item.to,constants.COPYFILE_EXCL);await checkedFile(item.to,item.hash);item.status='copied';await save();await checkpoint('copied',item);
          }
          if(item.status!=='copied')fail('ARCHIVE_INTERRUPTED','复制中断，保留来源和目标，请检查归档日志');
          await checkedFile(item.to,item.hash);
          await checkAssociations();
          try{await checkedFile(item.from,item.hash);await checkpoint('before-remove',item);await checkAssociations();await unlink(item.from);}catch(error){if(error.code!=='ENOENT')throw error;}
          item.status='succeeded';journal.events.push({sourceId:item.sourceId,kind:'archived',at:new Date().toISOString()});await save();await checkpoint('archived',item);
        }
        journal.status='complete';delete journal.error;
      }catch(error){journal.status=journal.items.some(item=>item.status==='succeeded')?'partial':'failed';journal.error={code:error.code??'ARCHIVE_FAILED',message:error.message};}
      await save();return {...answer(),error:journal.error};
    },
  };
}
