import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateExternalCopy} from './external-copy.mjs';
test('外部入口拒绝原库、恢复备份、相同身份和相对路径', async () => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'frontend-boundary-'));
 try {
  const oldId=randomUUID(), newId=randomUUID();
  const roots=['original','backup','validation'].map(p=>path.join(root,p));
  for(let i=0;i<3;i++) {await fs.mkdir(path.join(roots[i],'.llm-wiki'),{recursive:true}); await fs.writeFile(path.join(roots[i],'.llm-wiki/project.json'),JSON.stringify({id:i===2?newId:oldId}));}
  const manifest=path.join(root,'report.json');
  await fs.writeFile(manifest,JSON.stringify({status:'complete',backupVerified:true,validationVerified:true,originalPath:roots[0],backupPath:roots[1],validationPath:roots[2],relocation:{originalProjectId:oldId,validationProjectId:newId}}));
  const env={UPSTREAM_VALIDATION_COPY:roots[2],UPSTREAM_VALIDATION_MANIFEST:manifest,UPSTREAM_VALIDATION_RESULT:path.join(root,'result.json')};
  assert.equal((await validateExternalCopy(env)).projectId,newId);
  for(const bad of [roots[0],roots[1],'relative']) await assert.rejects(validateExternalCopy({...env,UPSTREAM_VALIDATION_COPY:bad}));
  await assert.rejects(validateExternalCopy({...env,UPSTREAM_VALIDATION_RESULT:path.join(roots[2],'result.json')}));
  await fs.writeFile(path.join(roots[2],'.llm-wiki/project.json'),JSON.stringify({id:oldId}));
  await assert.rejects(validateExternalCopy(env));
 } finally {await fs.rm(root,{recursive:true,force:true});}
});
