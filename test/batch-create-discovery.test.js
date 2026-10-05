import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {createBatchService} from '../src/batches.js';
import {createInboxStrategy} from '../src/inbox.js';

test('外部收件箱创建任务不读取无关 Wiki 正文，库内材料仍核验页面关联',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'organizer-create-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const libraryPath=path.join(root,'library'),sourceRoot=path.join(root,'inbox');
 const wikiSourcePath=path.join(root,'upstream'),artifactRoot=path.join(root,'artifacts');
 const raw=path.join(libraryPath,'raw/sources'),wiki=path.join(libraryPath,'wiki');
 for(const dir of [raw,wiki,path.join(libraryPath,'.llm-wiki'),sourceRoot,wikiSourcePath,artifactRoot])await fs.mkdir(dir,{recursive:true});
 for(const [name,value] of Object.entries({'ingest-cache.json':{entries:{}},'ingest-queue.json':[{sourcePath:'old.md',status:'pending'}],'file-change-queue.json':{tasks:[]}}))await fs.writeFile(path.join(libraryPath,'.llm-wiki',name),JSON.stringify(value));
 for(let i=0;i<3;i++)await fs.writeFile(path.join(sourceRoot,`${i}.md`),'新材料');
 await fs.writeFile(path.join(raw,'old.md'),'旧材料');
 await fs.writeFile(path.join(raw,'linked.md'),'缺少缓存但存在关联的材料');
 await fs.writeFile(path.join(wiki,'page.md'),'---\nsources: ["linked.md"]\n---\n既有知识正文');
 // 业务入口会解析真实路径，监测也使用同一目录的真实位置，避免 Windows 别名漏计。
 const observedWiki=await fs.realpath(wiki);
 const originalRead=fs.readFile;let wikiReads=0;
 t.mock.method(fs,'readFile',async(file,...args)=>{
  if(String(file).startsWith(observedWiki+path.sep))wikiReads++;
  return originalRead(file,...args);
 });
 syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const batches=createBatchService({stateDirectory:path.join(root,'batches'),strategies:{inbox:createInboxStrategy()}});
 const batch=await batches.create({mode:'inbox',libraryPath,sourceRoot,wikiSourcePath,artifactRoot});
 assert.equal(batch.counts.total,3);
 assert.equal(wikiReads,0,'外部收件箱创建不应随 Wiki 正文规模增加读取开销');
 const found=await createInboxStrategy().discover({input:{libraryPath,sourceRoot:raw}});
 assert.ok(wikiReads>0);
 assert.equal(found.sources.find(source=>source.identity==='linked.md').ingestStatus,'uncertain');
 assert.equal(found.sources.find(source=>source.identity==='old.md').ingestStatus,'uncertain');
 assert.equal(found.flow.busy,true);
});
