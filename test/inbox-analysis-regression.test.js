import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPlanningService} from '../src/planning.js';

test('局部不确定不否决全文主题，进度覆盖分段与汇总，旧结果可以重分析',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'inbox-analysis-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const sourceRoot=path.join(root,'sources');await mkdir(sourceRoot);
 const configPath=path.join(root,'config.json');await writeFile(configPath,JSON.stringify({llmConfig:{provider:'custom',model:'test',maxContextSize:1024}}));
 await writeFile(path.join(sourceRoot,'record.md'),'这里讲述智能体项目开发与知识库管理。'.repeat(30));
 let calls=0;const progress=[];
 const planner=createPlanningService({stateDirectory:path.join(root,'state'),generate:async(_,r)=>{calls++;return {title:'智能体项目实践',summary:'智能体项目开发',evidence:[r.content.slice(0,10)],uncertain:r.stage==='segment'};}});
 const input={sourceRoot,libraryPath:sourceRoot,configPath,identity:'record.md',onProgress:p=>progress.push(p)};
 const result=await planner.analyze(input);
 assert.equal(result.analysis.uncertain,false);
 assert.equal(result.suggestion,'智能体项目实践.md');
 assert.ok(progress.some(p=>p.stage==='segment'));
 assert.ok(progress.some(p=>p.stage==='synthesis'));
 const before=calls;await planner.analyze(input);assert.equal(calls,before);
 await planner.analyze({...input,reanalyze:true});assert.ok(calls>before);
});
