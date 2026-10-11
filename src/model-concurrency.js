import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {atomicRename} from './atomic-rename.js';
import {setTimeout as delay} from 'node:timers/promises';
import {analysisVersion} from './analysis-version.js';
import {MODEL_RETRY_POLICY,safeModelFailure,modelFailure} from './model-failure.js';

const contexts=new AsyncLocalStorage();
export const withModelContext=(context,operation)=>contexts.run(context,operation);
export const modelContext=()=>contexts.getStore();
export function analysisPaused(){return Object.assign(new Error('分析已暂停，已发出的请求完成后停止'),{code:'ANALYSIS_PAUSED'});}
export function createModelConcurrency({stateDirectory}={}){
 const file=stateDirectory&&path.join(stateDirectory,'model-concurrency.json');
 let limit=3,active=0,completed=0,failed=0,initialized=false,initializing,settings=Promise.resolve(),dispatch=0,priorityBurst=0;const waiting=[],activeBatches=new Map(),lastDispatch=new Map();
 let retrying=0;const blocked=new Map(),cooldowns=new Map(),activeModels=new Map();let wake;
 const snapshot=()=>({limit,active,queued:waiting.length,completed,failed,retrying,rateLimited:[...cooldowns.values()].some(until=>until>Date.now()),modelFaults:[...blocked.values()].map(error=>({code:error.code,message:error.message})),converging:active>limit,unit:'organizer-model-calls'});
 async function initialize(){if(initialized)return;if(!initializing)initializing=(async()=>{if(file)try{const saved=JSON.parse(await readFile(file,'utf8'));if(!Number.isSafeInteger(saved.limit)||saved.limit<1)throw new Error('已保存并发设置无效');limit=saved.limit;}catch(error){if(error.code!=='ENOENT')throw error;}initialized=true;})();await initializing;}
 // 优先补全汇总与分类，但持续保留正文分段机会；同一层级按文章轮流取得额度。
 function take(){
  const eligible=waiting.filter(item=>(cooldowns.get(item.context?.modelKey)??0)<=Date.now()&&(!cooldowns.has(item.context?.modelKey)||!activeModels.get(item.context?.modelKey)));
  const segments=eligible.filter(item=>!item.context?.priority),ready=eligible.filter(item=>item.context?.priority);
  if(!eligible.length)return;
  const candidates=ready.length&&(!segments.length||priorityBurst<2)?ready:segments;
  const item=candidates.reduce((chosen,item)=>(lastDispatch.get(item.context?.articleKey)??0)<(lastDispatch.get(chosen.context?.articleKey)??0)?item:chosen);
  waiting.splice(waiting.indexOf(item),1);lastDispatch.set(item.context?.articleKey,++dispatch);priorityBurst=item.context?.priority?priorityBurst+1:0;return item;
 }
 function stopped(context){if(context?.shouldPause?.())return analysisPaused();if(blocked.has(context?.modelKey))return blocked.get(context.modelKey);if(context?.failureScope?.stopped)return context.failureScope.error??modelFailure('MODEL_ARTICLE_STOPPED');}
 function drain(){
  clearTimeout(wake);
  for(const item of [...waiting]){const error=stopped(item.context);if(error){waiting.splice(waiting.indexOf(item),1);item.reject(error);}}
  while(waiting.length&&active<limit){const item=take();if(!item)break;active++;if(item.context?.modelKey)activeModels.set(item.context.modelKey,(activeModels.get(item.context.modelKey)??0)+1);if(item.context?.batchId)activeBatches.set(item.context.batchId,(activeBatches.get(item.context.batchId)??0)+1);item.resolve();}
  const next=Math.min(...waiting.map(item=>cooldowns.get(item.context?.modelKey)??Infinity));if(Number.isFinite(next)&&next>Date.now())wake=setTimeout(drain,next-Date.now());
 }
 return {
  snapshot,
  activeFor:batchId=>activeBatches.get(batchId)??0,
  async get(){await initialize();return snapshot();},
  async set(value){if(!Number.isSafeInteger(value)||value<1)throw new Error('并发上限必须是合法正整数');const update=settings.then(async()=>{await initialize();if(file){await mkdir(path.dirname(file),{recursive:true});const temporary=`${file}.${randomUUID()}.tmp`;await writeFile(temporary,JSON.stringify({limit:value}),{flag:'wx'});await atomicRename(temporary,file);}limit=value;drain();return snapshot();});settings=update.catch(()=>{});return update;},
  resumeModel(config){blocked.delete(analysisVersion(config).fingerprint);drain();},
  async request(config,request,operation){
   const modelKey=analysisVersion(config).fingerprint,context={...contexts.getStore(),modelKey};
   return withModelContext(context,async()=>{
    for(let attempt=1;attempt<=MODEL_RETRY_POLICY.attempts;attempt++){
     const error=stopped(context);if(error)throw error;
     try{return await this.run(async()=>{try{
      if(attempt>1)await context.onModelProgress?.({retry:{status:'retrying',attempt,maxAttempts:MODEL_RETRY_POLICY.attempts}});
      const stoppedError=stopped(context);if(stoppedError)throw stoppedError;
      const result=await operation();cooldowns.delete(modelKey);if(attempt>1)await context.onModelProgress?.({retry:null});return result;
     }catch(original){
      const error=safeModelFailure(original);error.attempts=attempt;
      if(error.shared)blocked.set(modelKey,error);
      if(!error.retryable||attempt===MODEL_RETRY_POLICY.attempts){if(context.failureScope)Object.assign(context.failureScope,{stopped:true,error});}
      else if(error.code==='MODEL_RATE_LIMITED')cooldowns.set(modelKey,Date.now()+Math.max(error.retryAfterMs??0,Math.min(MODEL_RETRY_POLICY.maxDelayMs,MODEL_RETRY_POLICY.baseDelayMs*2**(attempt-1))));
      throw error;
     }});}catch(error){
      if(!error.retryable||attempt===MODEL_RETRY_POLICY.attempts)throw error;
      const waitMs=Math.max(error.retryAfterMs??0,Math.min(MODEL_RETRY_POLICY.maxDelayMs,MODEL_RETRY_POLICY.baseDelayMs*2**(attempt-1)));
      retrying++;try{await context.onModelProgress?.({retry:{status:'waiting',attempt,nextAttempt:attempt+1,maxAttempts:MODEL_RETRY_POLICY.attempts,delayMs:waitMs,code:error.code,message:error.message}});await delay(waitMs);}finally{retrying--;}
     }
    }
   });
  },
  async run(operation){await initialize();const context=contexts.getStore(),error=stopped(context);if(error)throw error;await new Promise((resolve,reject)=>{waiting.push({resolve,reject,context});drain();});try{const result=await operation();completed++;return result;}catch(error){failed++;throw error;}finally{active--;if(context?.modelKey){const count=activeModels.get(context.modelKey)-1;count?activeModels.set(context.modelKey,count):activeModels.delete(context.modelKey);}if(context?.batchId){const count=activeBatches.get(context.batchId)-1;count?activeBatches.set(context.batchId,count):activeBatches.delete(context.batchId);}drain();}},
 };
}
