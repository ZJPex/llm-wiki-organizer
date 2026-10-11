import { readFile, readdir, realpath, lstat, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { canonicalPath } from './filesystem-paths.js';
import { proposeEvolution, freezeEvolution } from './evolution.js';
import {evolutionTouches} from './directory-dependencies.js';
import { inventory } from './compatibility.js';
import { categoryCatalog, recommendCategory, finalTarget, planDigest } from './categories.js';
import { readModelConfig, generateWithModel } from './model-config.js';
import {analysisVersion,sameAnalysisVersion} from './analysis-version.js';
import {themeTags} from './classification-result.js';
import {createModelConcurrency,modelContext,withModelContext} from './model-concurrency.js';
import {atomicRename} from './atomic-rename.js';
const hash = value => createHash('sha256').update(value).digest('hex');
export function validateName(name) {
  if (typeof name !== 'string' || name.length > 240 || !/\.md$/i.test(name) || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name) || !name.slice(0, -3).trim()) throw new Error('名称不符合 Windows Markdown 文件名规则');
  return name;
}
async function sourceFile(root, identity) {
  if (typeof identity !== 'string' || !/\.md$/i.test(identity) || identity.includes('\\') || identity.split('/').some(p => !p || p === '.' || p === '..') || path.isAbsolute(identity)) throw new Error('源身份无效');
  const base = await realpath(root);
  let file = base;
  for (const part of identity.split('/')) { file = path.join(file, part); if ((await lstat(file)).isSymbolicLink()) throw new Error('拒绝符号链接来源'); }
  if (!path.relative(base, await realpath(file)).startsWith('..')) return file;
  throw new Error('来源超出范围');
}
function analysisView(text) {
  // 仅分析视图降权：原文件及元数据从不写回。
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').split(/\r?\n/).filter(line => !/^\s*(播放量|点赞|收藏数|推荐视频|相关推荐|下载次数)\s*[:：]/.test(line)).join('\n');
}
function kindOf(view) {
  const lines = view.split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) return 'blank';
  if (lines.every(s => /^#{1,6}\s/.test(s))) return 'title-only';
  if (lines.some(s => /\[\[.+?\]\]|\[.+?\]\(.+?\)/.test(s)) && lines.every(s => /^#|\[\[.+?\]\]|\[.+?\]\(.+?\)/.test(s))) return 'navigation';
  if (view.replace(/[\s\d\p{P}\p{S}]/gu, '').length < 20) return 'noise';
  return 'body';
}
function checkedAnalysis(result, text) {
  if (!result || typeof result.title !== 'string' || typeof result.summary !== 'string' || !Array.isArray(result.evidence) || result.evidence.some(e => typeof e !== 'string' || !e || !text.includes(e))) throw new Error('模型分析缺少可核验的原文证据');
  return { title: result.title, summary: result.summary, evidence: result.evidence, uncertain: result.uncertain !== false || !result.evidence.length };
}

async function generateCheckedAnalysis(generate, config, request, content) {
  const run = input => generate(config, input).then(result => checkedAnalysis(result, content));
  try { return await run(request); }
  catch (error) {
    if (error.message !== '模型分析缺少可核验的原文证据') throw error;
    return run({ ...request, evidenceRequirement: 'evidence 每一项必须是 content 中的连续精确子串，逐字符保留原标点与空白；不能精确引用时返回空数组并将 uncertain 设为 true。' });
  }
}

export function createPlanningService({ generate = generateWithModel, stateDirectory = path.join(os.homedir(), '.llm-wiki-organizer') } = {}) {
  const modelConcurrency=createModelConcurrency({stateDirectory});
  const modelGenerate=generate;generate=(config,request)=>withModelContext({...modelContext(),priority:request.stage==='segment'?0:1},()=>(modelContext()?.modelConcurrency??modelConcurrency).request(config,request,()=>modelGenerate(config,request)));
  // 串行状态变更，避免同一进程内审核互相覆盖。
  let queue = Promise.resolve();
  const serial = fn => { const pending = queue.then(fn); queue = pending.catch(() => {}); return pending; };
  async function state(root, libraryPath) {
    const canonical = await realpath(root);
    const location = await canonicalPath(stateDirectory);
    if (libraryPath) { const library = await realpath(libraryPath); const inside = path.relative(library, location); if (!inside || (!inside.startsWith('..') && !path.isAbsolute(inside))) throw new Error('方案状态目录必须在知识库之外'); }
    const relative = path.relative(canonical, location);
    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('方案状态目录必须在源目录之外');
    const file = path.join(location, `${hash(canonical)}.json`);
    try { return { file, data: JSON.parse(await readFile(file, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw e; return { file, data: { schemaVersion: 1, entries: {} } }; }
  }
  async function persist(file, data) { await mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(data, null, 2), { flag: 'wx' }); await atomicRename(temporary, file); }
  const inFlight=new Map();
  const once=(key,fn)=>{if(inFlight.has(key))return inFlight.get(key);const pending=withModelContext({...modelContext(),articleKey:modelContext()?.articleKey??key,failureScope:modelContext()?.failureScope??{}},fn).finally(()=>inFlight.delete(key));inFlight.set(key,pending);return pending;};
  const parallel=async items=>{const results=await Promise.allSettled(items.map(fn=>fn()));const error=results.find(result=>result.status==='rejected');if(error)throw error.reason;return results.map(result=>result.value);};
  return {
    modelConcurrency,
    resetModelFailure:async input=>modelConcurrency.resumeModel(await readModelConfig(input)),
    // 仅由整理批次在核验正式执行证据后调用，不开放 HTTP。一次映射避免 A→B→C 链式改名。
    commitIdentityMappings: input => serial(async () => {
      const source=await state(input.sourceRoot,input.libraryPath),target=await state(input.targetRoot,input.libraryPath);
      const transaction=path.join(path.dirname(source.file),`identity-${hash(input.executionId)}.json`);
      let pending;try{pending=JSON.parse(await readFile(transaction,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
      if(pending?.status==='complete')return {status:'complete',reused:true};
      if(!pending){
        const fromRoot=await realpath(input.sourceRoot),toRoot=await realpath(input.targetRoot),original=structuredClone(source.data.entries),nextSource=structuredClone(source.data),nextTarget=source.file===target.file?nextSource:structuredClone(target.data);
        const mappings=input.mappings.map(mapping=>({...mapping,oldIdentity:path.relative(fromRoot,mapping.from).replaceAll('\\','/'),newIdentity:path.relative(toRoot,mapping.to).replaceAll('\\','/')}));
        for(const mapping of mappings){if(mapping.oldIdentity.startsWith('../')||mapping.newIdentity.startsWith('../')||path.isAbsolute(mapping.oldIdentity)||path.isAbsolute(mapping.newIdentity))throw new Error('身份映射越界');if(hash(await readFile(mapping.to))!==mapping.hash)throw new Error('身份同步目标与成功证据不一致');delete nextSource.entries[mapping.oldIdentity];}
        for(const mapping of mappings){const entry=original[mapping.oldIdentity];if(!entry)continue;if(nextTarget.entries[mapping.newIdentity]&&!mappings.some(other=>other.oldIdentity===mapping.newIdentity&&source.file===target.file))throw new Error('已有命名状态冲突，未覆盖');const {classification,frozenPlan,...kept}=entry;nextTarget.entries[mapping.newIdentity]={...kept,identity:mapping.newIdentity,hash:mapping.hash,previousIdentity:mapping.oldIdentity,executionId:input.executionId,reviewRequired:true};}
        pending={status:'prepared',sourceFile:source.file,targetFile:target.file,nextSource,nextTarget};await persist(transaction,pending);
      }
      await persist(pending.sourceFile,pending.nextSource);if(pending.targetFile!==pending.sourceFile)await persist(pending.targetFile,pending.nextTarget);
      await persist(transaction,{...pending,status:'complete'});return {status:'complete'};
    }),
    analysisValidity: async input=>{
      const saved=await serial(()=>state(input.sourceRoot,input.libraryPath)),entry=saved.data.entries[input.identity];
      if(!entry||entry.hash!==hash(await readFile(await sourceFile(input.sourceRoot,input.identity),'utf8')))return false;
      const config=['body','navigation'].includes(entry.kind)?await readModelConfig(input):null;
      return sameAnalysisVersion(entry.analysisVersion,analysisVersion(config));
    },
    analyze: async input => {
      const {sourceRoot,identity}=input,file=await sourceFile(sourceRoot,identity),text=await readFile(file,'utf8'),sourceHash=hash(text);
      const view=analysisView(text),kind=kindOf(view),config=['body','navigation'].includes(kind)?await readModelConfig(input):null,version=analysisVersion(config);
      return once(JSON.stringify([file,sourceHash,version,input.reanalyze===true]),async()=>{
      if(input.onProgress)modelContext().onModelProgress=input.onProgress;
      if(input.retryFailures&&config)modelConcurrency.resumeModel(config);
      const saved = await state(sourceRoot, input.libraryPath);
      const prior = saved.data.entries[identity];
      if(prior?.hash===sourceHash&&sameAnalysisVersion(prior.analysisVersion,version)&&!input.reanalyze)return {...prior,reused:true};
      const seriesPattern = /第[零一二三四五六七八九十百千0-9]+[章节课讲]|(?:chapter|lesson|part)\s*\d+/gi;
      const heading = view.split('\n').find(line => /^#{1,6}\s/.test(line)) ?? '';
      const identityHints = [...new Set((path.basename(identity) + ' ' + heading).match(seriesPattern) ?? [])];
      const entry = { identity, hash: sourceHash, analysisVersion:version, kind, identityHints, segments: [], suggestion: null, confirmedName: prior?.confirmedName ?? null, reviewRequired: true };
      if (['body', 'navigation'].includes(kind)) {
        const checkpoint=await serial(async()=>{
          const latest=await state(sourceRoot,input.libraryPath);latest.data.checkpoints??={};let current=latest.data.checkpoints[identity];
          if(current?.schemaVersion!==1||!current.results||current.sourceHash!==sourceHash||!sameAnalysisVersion(current.analysisVersion,version)||input.reanalyze){current={schemaVersion:1,sourceHash,analysisVersion:version,generation:randomUUID(),results:{}};latest.data.checkpoints[identity]=current;await persist(latest.file,latest.data);}
          return structuredClone(current);
        });
        const stillCurrent=async()=>{
          if(hash(await readFile(file,'utf8'))!==sourceHash)throw new Error('分析过程中源文件变化，请重试');
          if(!sameAnalysisVersion(analysisVersion(await readModelConfig(input)),version))throw new Error('分析过程中模型配置变化，请重试');
        };
        const cachedResult=(key,content)=>{const cached=checkpoint.results[key];if(cached?.inputHash!==hash(content))return;try{return checkedAnalysis(cached.result,content);}catch{return;}};
        const cachedRequest=async(key,request,content)=>{
          const inputHash=hash(content),cached=cachedResult(key,content);
          if(cached){await stillCurrent();return cached;}
          const result=await generateCheckedAnalysis(generate,config,request,content);
          await serial(async()=>{
            await stillCurrent();const latest=await state(sourceRoot,input.libraryPath),current=latest.data.checkpoints?.[identity];
            if(current?.generation!==checkpoint.generation)throw new Error('已有更新的分析，旧结果不再保存');
            current.results[key]={inputHash,result};await persist(latest.file,latest.data);
          });return result;
        };
        entry.checkpointGeneration=checkpoint.generation;
        const size = Math.max(256, Math.min(8000, Math.floor((config.maxContextSize ?? 16000) / 4)));
        const totalSteps=Math.ceil(view.length/size),reusedSteps=Array.from({length:totalSteps},(_,index)=>{const start=index*size;return !!cachedResult('segment:'+start+':'+Math.min(start+size,view.length),view.slice(start,start+size));}).filter(Boolean).length;
        let completed=reusedSteps;
        await input.onProgress?.({stage:'segment',step:completed,completed,totalSteps,reusedSteps});
        entry.segments=await parallel(Array.from({length:totalSteps},(_,index)=>async()=>{
          const start=index*size,content=view.slice(start,start+size);
          const key='segment:'+start+':'+Math.min(start+size,view.length),reused=!!cachedResult(key,content);
          const result={start,end:Math.min(start+size,view.length),...await cachedRequest(key,{stage:'segment',content,identity},content)};
          if(!reused)completed++;await input.onProgress?.({stage:'segment',step:completed,completed,totalSteps,reusedSteps});return result;
        }));
        // 分层归并使每一段均参与，避免把超长全文再次塞入一个上下文。
        let summaries = entry.segments, round = 0;
        while (summaries.length > 1) {
          round++;
          const totalSteps=Math.ceil(summaries.length/4),contents=Array.from({length:totalSteps},(_,index)=>summaries.slice(index*4,index*4+4).map(s=>`${s.summary}\n${s.evidence.join('\n')}`).join('\n'));
          const reusedSteps=contents.filter((content,index)=>cachedResult('synthesis:'+round+':'+index,content)).length;let completed=reusedSteps;
          await input.onProgress?.({stage:'synthesis',round,step:completed,completed,totalSteps,reusedSteps});
          const next=await parallel(contents.map((content,index)=>async()=>{
            const reused=!!cachedResult('synthesis:'+round+':'+index,content);
            const result=await cachedRequest('synthesis:'+round+':'+index,{stage:'synthesis',content,identity},content);
            if(!reused)completed++;await input.onProgress?.({stage:'synthesis',round,step:completed,completed,totalSteps,reusedSteps});return result;
          }));
          summaries = next;
        }
        entry.analysis = summaries[0];
        if (!entry.analysis.uncertain && !entry.confirmedName) {
          const proposed = `${entry.analysis.title}${path.extname(identity)}`;
          try { validateName(proposed); if (identityHints.every(hint => proposed.toLowerCase().includes(hint.toLowerCase()))) entry.suggestion = proposed; else entry.warning = '建议遗漏章节或系列编号，请结合原文人工命名'; } catch { entry.warning = '模型名称无效，请人工修改'; }
        }
      }
      if (!entry.suggestion && !entry.confirmedName) entry.warning ??= '证据不足或主题不明确，请人工处理；源文件及关联保持原样';
      if (hash(await readFile(file, 'utf8')) !== sourceHash) throw new Error('分析过程中源文件变化，请重试');
      return serial(async()=>{
        const latest=await state(sourceRoot,input.libraryPath);
        if(hash(await readFile(file,'utf8'))!==sourceHash)throw new Error('分析过程中源文件变化，请重试');
        if(config&&!sameAnalysisVersion(analysisVersion(await readModelConfig(input)),version))throw new Error('分析过程中模型配置变化，请重试');
        if(entry.checkpointGeneration&&latest.data.checkpoints?.[identity]?.generation!==entry.checkpointGeneration)throw new Error('已有更新的分析，旧结果不再保存');
        delete entry.checkpointGeneration;
        const current=latest.data.entries[identity];
        if(current?.confirmedName){entry.confirmedName=current.confirmedName;entry.suggestion=null;}
        latest.data.entries[identity]=entry;await persist(latest.file,latest.data);return entry;
      });
      });
    },
    confirm: input => serial(async () => {
      const { sourceRoot, identity, name } = input;
      validateName(name);
      const file = await sourceFile(sourceRoot, identity);
      const saved = await state(sourceRoot, input.libraryPath);
      const entry = saved.data.entries[identity];
      if (!entry || entry.hash !== hash(await readFile(file, 'utf8'))) throw new Error('源文件已变化，必须重新分析');
      if (entry.confirmedName && entry.confirmedName !== name && !input.allowRenameConfirmed) throw new Error('已确认名称默认固定，需明确允许重新命名');
      const collision = (await readdir(path.dirname(file))).some(p => p.toLowerCase() === name.toLowerCase() && p !== path.basename(file));
      const duplicate = Object.values(saved.data.entries).some(e => e.identity !== identity && path.dirname(e.identity) === path.dirname(identity) && e.confirmedName?.toLowerCase() === name.toLowerCase());
      if (collision || duplicate) throw new Error('目标名称已存在，不能覆盖');
      if (entry.confirmedName !== name) {
        // 分类依据来自正文，与首次确认名字无关；只撤销路径授权并更新待审核位置。
        const classification=entry.classification;
        if(classification&&(await categoryCatalog(classification.catalogRoot)).hash===classification.catalogHash)entry.classification={...classification,status:'needs-review',finalPath:classification.category===null?null:path.join(classification.catalogRoot,classification.category,name)};
        else delete entry.classification;
        delete entry.frozenPlan;
      } entry.confirmedName = name; entry.reviewRequired = false;
      await persist(saved.file, saved.data);
      return entry;
    }),
    classify: input => once(JSON.stringify(['classification',input.sourceRoot,input.identity]),async () => {
      if(input.onProgress)modelContext().onModelProgress=input.onProgress;
      const saved = await state(input.sourceRoot, input.libraryPath);
      const file = await sourceFile(input.sourceRoot, input.identity);
      const entry = saved.data.entries[input.identity];
      if (!entry) throw new Error('请先完成全文分析');
      if (entry.hash !== hash(await readFile(file, 'utf8'))) throw new Error('源文件变化，请重新分析');
      await state(input.sourceRoot, input.categoryRoot);
      const catalog = await categoryCatalog(input.categoryRoot);
      const config = entry.analysis && !entry.analysis.uncertain ? await readModelConfig(input) : null;
      if(config&&!sameAnalysisVersion(entry.analysisVersion,analysisVersion(config)))throw new Error('全文分析依据已失效，请先重新分析');
      const recommendation = await recommendCategory({ entry, catalog, config, generate, onProgress:input.onProgress });
      if (entry.hash !== hash(await readFile(file, 'utf8')) || (await categoryCatalog(input.categoryRoot)).hash !== catalog.hash) throw new Error('分类规划期间基线变化');
      return serial(async()=>{
        const latest=await state(input.sourceRoot,input.libraryPath),current=latest.data.entries[input.identity];
        if(!current||current.hash!==entry.hash||hash(await readFile(file,'utf8'))!==entry.hash||(await categoryCatalog(input.categoryRoot)).hash!==catalog.hash)throw new Error('分类规划期间基线变化');
        if(config&&(!sameAnalysisVersion(current.analysisVersion,analysisVersion(config))||!sameAnalysisVersion(analysisVersion(await readModelConfig(input)),analysisVersion(config))))throw new Error('分类规划期间模型配置变化，请重新分析');
        if(current.classification?.status==='confirmed')return current;
        current.classification={...recommendation,catalogRoot:catalog.root,catalogHash:catalog.hash,options:catalog.categories.map(c=>c.path),finalPath:recommendation.category===null?null:path.join(catalog.root,recommendation.category,current.confirmedName??current.suggestion??path.basename(current.identity))};
        current.tags=themeTags(recommendation.tags);
        delete current.frozenPlan;await persist(latest.file,latest.data);return current;
      });
    }),
    // 名称与分类在全部校验通过后一次保存，建议名不冒充已确认名。
    confirmPlan: input => serial(async () => {
      const saved = await state(input.sourceRoot, input.libraryPath);
      const file = await sourceFile(input.sourceRoot, input.identity);
      const entry = saved.data.entries[input.identity];
      if (!entry?.classification || !entry.analysis || entry.analysis.uncertain || !['body','navigation'].includes(entry.kind) || entry.hash !== hash(await readFile(file, 'utf8'))) throw new Error('内容证据不足或源基线变化');
      if (evolutionTouches(saved.data.evolution,{sourcePath:file,targetPath:path.resolve(entry.classification.catalogRoot,input.category??'',input.name??''),categoryRoot:entry.classification.catalogRoot,owner:saved.data.evolution?.identity===entry.identity})) throw new Error('目录调整尚未解决，请先处理目录依赖');
      const name = validateName(input.name);
      if (entry.confirmedName && entry.confirmedName !== name) throw new Error('已确认名称保持稳定');
      const catalog = await categoryCatalog(entry.classification.catalogRoot);
      if (catalog.hash !== entry.classification.catalogHash) throw new Error('分类树或说明已变化，请重新规划');
      const target = await finalTarget(catalog, input.category, name, file);
      if (Object.values(saved.data.entries).some(e => e.identity !== entry.identity && e.frozenPlan?.finalPath.toLowerCase() === target.toLowerCase())) throw new Error('批次内目标重名');
      const tags=themeTags(input.tags??entry.tags??entry.classification.tags);
      const frozen = { schemaVersion: 1, identity: entry.identity, sourcePath: file, sourceHash: entry.hash, name, category: input.category, tags, categoryRoot: catalog.root, catalogHash: catalog.hash, finalPath: target };
      Object.assign(entry, {tags,confirmedName:name,reviewRequired:false,frozenPlan:{...frozen,planHash:planDigest(frozen)},classification:{...entry.classification,tags,decision:entry.classification.category===input.category?entry.classification.decision:'manual',category:input.category,finalPath:target,status:'confirmed'}});
      await persist(saved.file, saved.data);
      return entry;
    }),
    confirmCategory: input => serial(async () => {
      const saved = await state(input.sourceRoot, input.libraryPath);
      const file = await sourceFile(input.sourceRoot, input.identity);
      const entry = saved.data.entries[input.identity];
      if (!entry?.confirmedName || !entry.classification || entry.hash !== hash(await readFile(file, 'utf8'))) throw new Error('计划缺失或源基线变化');
      const catalog = await categoryCatalog(entry.classification.catalogRoot);
      if (catalog.hash !== entry.classification.catalogHash) throw new Error('分类树或说明已变化，请重新规划');
      validateName(entry.confirmedName);
      const target = await finalTarget(catalog, input.category, entry.confirmedName, file);
      if (Object.values(saved.data.entries).some(e => e.identity !== entry.identity && e.frozenPlan?.finalPath.toLowerCase() === target.toLowerCase())) throw new Error('批次内目标重名');
      const frozen = { schemaVersion: 1, identity: entry.identity, sourcePath: file, sourceHash: entry.hash, name: entry.confirmedName, category: input.category, categoryRoot: catalog.root, catalogHash: catalog.hash, finalPath: target };
      entry.frozenPlan = { ...frozen, planHash: planDigest(frozen) };
      entry.classification = { ...entry.classification, category: input.category, finalPath: target, status: 'confirmed' };
      await persist(saved.file, saved.data);
      return entry;
    }),
    evolve: input => once(JSON.stringify(['evolution',input.sourceRoot,input.identity]),async () => {
      const saved = await state(input.sourceRoot, input.libraryPath);
      const file = await sourceFile(input.sourceRoot, input.identity);
      const entry = saved.data.entries[input.identity];
      if (!entry?.confirmedName || entry.hash !== hash(await readFile(file, 'utf8'))) throw new Error('请先完成当前来源的命名审核');
      await state(input.sourceRoot, input.categoryRoot);
      const config = entry.analysis && !entry.analysis.uncertain ? await readModelConfig(input) : null;
      const proposal = await proposeEvolution({ entry, root: input.categoryRoot, startCategory: input.startCategory, generate, config });
      if (entry.hash !== hash(await readFile(file, 'utf8'))) throw new Error('规划期间来源变化');
      return serial(async()=>{
        const latest=await state(input.sourceRoot,input.libraryPath),current=latest.data.entries[input.identity];
        if(!current||current.hash!==entry.hash||current.confirmedName!==entry.confirmedName||hash(await readFile(file,'utf8'))!==entry.hash||(await categoryCatalog(input.categoryRoot)).hash!==proposal.catalog.hash||(await inventory(input.categoryRoot)).hash!==proposal.baseline.hash)throw new Error('规划期间基线变化');
        if(JSON.stringify(latest.data.evolution)!==JSON.stringify(saved.data.evolution))throw new Error('已有更新的目录方案，请重新读取');
        latest.data.evolution={...proposal,identity:entry.identity,sourceHash:entry.hash,status:'needs-review'};await persist(latest.file,latest.data);return latest.data.evolution;
      });
    }),
    confirmEvolution: input => serial(async () => {
      const saved = await state(input.sourceRoot, input.libraryPath);
      const proposal = saved.data.evolution;
      if (!proposal || !Array.isArray(input.operations)) throw new Error('缺少待审核演化方案');
      const source = await sourceFile(input.sourceRoot, proposal.identity);
      if (proposal.sourceHash !== hash(await readFile(source, 'utf8')) || (await inventory(proposal.catalog.root)).hash !== proposal.baseline.hash || (await categoryCatalog(proposal.catalog.root)).hash !== proposal.catalog.hash) throw new Error('演化基线已失效');
      const allowedScopes = new Set(proposal.visited.map(v => v.scope));
      for (const operation of input.operations) {
        const affected = operation.from ?? operation.parent;
        if (![...allowedScopes].some(scope => affected === scope || path.posix.dirname(affected) === scope || (!scope && !affected.includes('/')))) throw new Error('审核变更超出已检查范围，请重新规划');
      }
      const names = {};
      const canonicalSourceRoot = await realpath(input.sourceRoot);
      for (const entry of Object.values(saved.data.entries)) {
        const relative = path.relative(proposal.catalog.root, path.resolve(canonicalSourceRoot, entry.identity)).split(path.sep).join('/');
        if (!relative.startsWith('..') && entry.confirmedName) names[relative] = entry.confirmedName;
      }
      const plan = freezeEvolution(proposal, input.operations, names);
      if (input.previewOnly) return { ...proposal, preview: plan };
      saved.data.evolution = { ...proposal, operations:input.operations, status: 'confirmed', frozenPlan: plan };
      await persist(saved.file, saved.data);
      return saved.data.evolution;
    }),
    discardEvolution: input => serial(async()=>{
      const saved=await state(input.sourceRoot,input.libraryPath);
      if(saved.data.evolution&&saved.data.evolution.identity!==input.identity)throw new Error('请从提出这份目录调整的材料取消方案');
      delete saved.data.evolution;await persist(saved.file,saved.data);
    }),
    invalidateReview: input => serial(async () => {
      const saved=await state(input.sourceRoot,input.libraryPath),entry=saved.data.entries[input.identity];
      if(!entry)return;
      delete entry.frozenPlan;entry.reviewRequired=true;
      if(input.clearClassification)delete entry.classification;
      await persist(saved.file,saved.data);
    }),
    list: input => serial(async () => (await state(input.sourceRoot, input.libraryPath)).data),
  };
}
