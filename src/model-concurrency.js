import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {atomicRename} from './atomic-rename.js';

const contexts=new AsyncLocalStorage();
export const withModelContext=(context,operation)=>contexts.run(context,operation);
export const modelContext=()=>contexts.getStore();
export function analysisPaused(){return Object.assign(new Error('分析已暂停，已发出的请求完成后停止'),{code:'ANALYSIS_PAUSED'});}
export function createModelConcurrency({stateDirectory}={}){
 const file=stateDirectory&&path.join(stateDirectory,'model-concurrency.json');
 let limit=3,active=0,completed=0,failed=0,initialized=false,initializing,settings=Promise.resolve();const waiting=[];
 const snapshot=()=>({limit,active,queued:waiting.length,completed,failed,converging:active>limit,unit:'organizer-model-calls'});
 async function initialize(){if(initialized)return;if(!initializing)initializing=(async()=>{if(file)try{const saved=JSON.parse(await readFile(file,'utf8'));if(!Number.isSafeInteger(saved.limit)||saved.limit<1)throw new Error('已保存并发设置无效');limit=saved.limit;}catch(error){if(error.code!=='ENOENT')throw error;}initialized=true;})();await initializing;}
 function drain(){while(waiting.length&&active<limit){const item=waiting.shift();if(item.context?.shouldPause?.()){item.reject(analysisPaused());continue;}active++;item.resolve();}}
 return {
  snapshot,
  async get(){await initialize();return snapshot();},
  async set(value){if(!Number.isSafeInteger(value)||value<1)throw new Error('并发上限必须是合法正整数');const update=settings.then(async()=>{await initialize();if(file){await mkdir(path.dirname(file),{recursive:true});const temporary=`${file}.${randomUUID()}.tmp`;await writeFile(temporary,JSON.stringify({limit:value}),{flag:'wx'});await atomicRename(temporary,file);}limit=value;drain();return snapshot();});settings=update.catch(()=>{});return update;},
  async run(operation){await initialize();const context=contexts.getStore();if(context?.shouldPause?.())throw analysisPaused();await new Promise((resolve,reject)=>{waiting.push({resolve,reject,context});drain();});try{const result=await operation();completed++;return result;}catch(error){failed++;throw error;}finally{active--;drain();}},
 };
}
