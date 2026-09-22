import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {compileBatchPlan} from '../src/batch-plan.js';
import {analyzeSharedOutputs as analyzeShared} from '../src/shared-outputs.js';
import {analyzeLinks} from '../src/links.js';
import {analyzeIndexes as analyzeIndex} from '../src/indexes.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {migrationFixture} from './helpers/migration-fixture.js';
import {createMigrationService} from '../src/migration.js';
import {digest,inventory} from '../src/compatibility.js';

test('Windows 共享产出大小写别名不阻塞迁移，真实缺失仍阻塞', {skip:process.platform!=='win32'}, async t=>{
 const f=await migrationFixture(t,{decorate:async({write})=>{
  await write('wiki/index.md','# 全库索引');await write('wiki/log.md','# 摄取日志');
  await write('raw/sources/b.md','共享来源');await write('wiki/github.md','共享产出');
  await write('.llm-wiki/ingest-cache.json',{entries:{
   'old.md':{hash:digest('# 已摄取的短源'),timestamp:1,filesWritten:['wiki/sources/old.md','wiki/concept.md','wiki/index.md','wiki/log.md']},
   'b.md':{hash:digest('共享来源'),timestamp:1,filesWritten:['wiki/concept.md','wiki/GitHub.md']},
  }});
 }});
 const service=createMigrationService();
 const plan=await service.plan({reportPath:f.backup.reportPath,mappings:[{from:'raw/sources/old.md',to:'raw/sources/renamed.md'}],writersPaused:true});
 assert.equal(plan.items[0].status,'selected',JSON.stringify(plan.items[0].reason));
 const cachePath=path.join(f.backup.validationPath,'.llm-wiki/ingest-cache.json');
 const cache=JSON.parse(await readFile(cachePath,'utf8'));cache.entries['b.md'].filesWritten.push('wiki/missing.md');await writeFile(cachePath,JSON.stringify(cache));
 const blocked=await compileBatchPlan({mappings:[{from:'raw/sources/old.md',to:'raw/sources/renamed.md'}]},f.backup,await inventory(f.backup.validationPath),{analyzeShared});
 assert.equal(blocked.items[0].status,'blocked');assert.equal(blocked.items[0].reason.code,'SHARED_OUTPUT');
});

test('上游合并前页面历史保持原样，不把历史正文当成活动关联',async t=>{
 const history='.llm-wiki/page-history/wiki_sources_old.md-2026-08-20T14-56-23-321Z';
 const f=await migrationFixture(t,{decorate:async({write,libraryPath})=>{await mkdir(path.join(libraryPath,'.llm-wiki/page-history'));await write(history,'---\nsources: [old.md]\n---\n历史正文');}});
 const plan=await createMigrationService().plan(f.input);
 assert.equal(plan.items[0].status,'selected');assert.ok(!plan.operations.some(op=>op.path===history||op.from===history));
 assert.equal(await readFile(path.join(f.backup.validationPath,history),'utf8'),'---\nsources: [old.md]\n---\n历史正文');
 await writeFile(path.join(f.backup.validationPath,'.llm-wiki/page-history/unknown.json'),'old.md');
 const blocked=await compileBatchPlan({mappings:[{from:f.input.oldPath,to:f.input.newPath}]},f.backup,await inventory(f.backup.validationPath),{analyzeShared,analyzeLinks,analyzeIndex});
 assert.equal(blocked.items[0].status,'blocked');assert.equal(blocked.items[0].reason.code,'UNKNOWN_STATE_REFERENCE');
});
