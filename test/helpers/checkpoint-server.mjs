import path from 'node:path';
import {appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createApp} from '../../src/server.mjs';
import {createBatchService} from '../../src/batches.js';
import {createPlanningService} from '../../src/planning.js';
import {createInboxStrategy} from '../../src/inbox.js';
import {listenForBrowser} from './http-server.js';
const root=process.argv[2],blockAt=Number(process.argv[3]??0);let count=0,release;
process.on('message',message=>{if(message==='release')release?.();});
const planning=createPlanningService({stateDirectory:path.join(root,'planning'),generate:async(config,request)=>{
 const attempt=++count;await appendFile(path.join(root,'checkpoint-calls.jsonl'),JSON.stringify({stage:request.stage,contentHash:createHash('sha256').update(JSON.stringify(request.content)).digest('hex'),model:config.model})+'\n');
 if(attempt===blockAt)await new Promise(resolve=>{release=resolve;});
 if(request.stage==='category-search')return {candidates:['']};
 if(request.stage==='category-choice')return {category:'',reason:'全文主题',evidence:request.content.evidence,uncertain:false};
 return {title:'缓存一致性',summary:request.content.slice(0,24),evidence:[request.content.slice(0,20)],uncertain:false};
}});
const batches=createBatchService({planning,stateDirectory:path.join(root,'batches'),strategies:{inbox:createInboxStrategy()}}),server=createApp({planning,batches});
await listenForBrowser(server);process.send({base:`http://127.0.0.1:${server.address().port}`});
