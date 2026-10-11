import path from 'node:path';
import {appendFile} from 'node:fs/promises';
import {createApp} from '../../src/server.mjs';
import {createBatchService} from '../../src/batches.js';
import {createPlanningService} from '../../src/planning.js';
import {createInboxStrategy} from '../../src/inbox.js';
import {createRestructureStrategy} from '../../src/restructure.js';
import {listenForBrowser} from './http-server.js';
const root=process.argv[2],blockAt=Number(process.argv[3]);let calls=0,release;
process.on('message',message=>{if(message==='release')release?.();});
const planning=createPlanningService({stateDirectory:path.join(root,'planning'),generate:async(_,request)=>{
 await appendFile(path.join(root,'model-calls.jsonl'),JSON.stringify({identity:request.identity,stage:request.stage})+'\n');
 if(request.stage==='category-search')return {candidates:['']};
 if(request.stage==='category-choice')return {category:'',reason:'正文主题',evidence:[request.content.evidence[0]],uncertain:false};
 const callNumber=++calls;await appendFile(path.join(root,'calls.jsonl'),JSON.stringify({identity:request.identity,stage:request.stage})+'\n');
 if(callNumber===blockAt){process.send({blocked:true});await new Promise(resolve=>{release=resolve;});}
 return {title:'缓存主题',summary:request.content,evidence:[request.content.slice(0,12)],uncertain:false};
}});
const server=createApp({batches:createBatchService({planning,stateDirectory:path.join(root,'batches'),strategies:{inbox:createInboxStrategy(),restructure:createRestructureStrategy()}})});
await listenForBrowser(server);process.send({base:`http://127.0.0.1:${server.address().port}`});
