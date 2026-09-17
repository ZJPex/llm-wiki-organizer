import path from 'node:path';
const fail = (code,message) => {throw Object.assign(new Error(message),{code});};
// 缓存代表来源与产出的多对多关系；共享页面没有单一所有者。
export function analyzeSharedOutputs({cache,oldIdentity,outputs,relativeOutput,files}) {
  const shared=[];
  for (const [identity,entry] of Object.entries(cache.entries)) {
    if (!entry || !Array.isArray(entry.filesWritten)) fail('SHARED_OUTPUT','来源缓存格式不完整');
    const relevant=entry.filesWritten.map(relativeOutput).filter(file=>outputs.includes(file));
    if (identity===oldIdentity || !relevant.length) continue;
    const source=files.get(`raw/sources/${identity}`);
    if (!source || source.hash!==entry.hash) fail('SHARED_OUTPUT','共享产出的其他来源缺失或已变化');
    if (entry.filesWritten.map(relativeOutput).some(file=>!files.has(file))) fail('SHARED_OUTPUT','共享来源的产出缺失');
    shared.push({identity,outputs:relevant});
  }
  return {sharedSources:shared};
}
export function migrateAllCacheOutputs(cache,root,oldIdentity,newIdentity,oldSummary,newSummary,relativeOutput) {
  const changed=[];
  for (const [identity,entry] of Object.entries(cache.entries)) {
    let touched=false;
    entry.filesWritten=entry.filesWritten.map(file=>{
      if(relativeOutput(file)!==oldSummary)return file;
      touched=true;
      return path.isAbsolute(file)||path.win32.isAbsolute(file)?`${root.replaceAll('\\','/')}/${newSummary}`:newSummary;
    });
    if(touched)changed.push(identity===oldIdentity?newIdentity:identity);
  }
  cache.entries[newIdentity]=cache.entries[oldIdentity];
  delete cache.entries[oldIdentity];
  return changed;
}
