import {createBatchService} from '../../src/batches.js';
import {createInboxStrategy} from '../../src/inbox.js';
import {createOriginalExecutionService} from '../../src/original-execution.js';
import {UPSTREAM_COMMIT} from '../../src/migration-verifier.js';
const [stateDirectory,input]=process.argv.slice(2);
const service=createBatchService({stateDirectory,strategies:{inbox:createInboxStrategy()},original:createOriginalExecutionService({verify:async()=>({upstreamCommit:UPSTREAM_COMMIT,result:{changedTasks:[],queue:{version:1,tasks:[]}},events:[]}),checkpoint:async(stage)=>{if(stage==='group-place-complete')process.exit(71);}})});
await service.applyHistoryPlan(JSON.parse(input));
