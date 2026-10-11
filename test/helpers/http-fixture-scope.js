import {rm} from 'node:fs/promises';
const testScopes=new WeakMap();
export function httpFixtureScope(t,root){
 let scope=testScopes.get(t);if(!scope){scope=createHttpFixtureScope(root);testScopes.set(t,scope);t.after(()=>scope.dispose());}else scope.include(root);return scope;
}
// 服务监听先释放；任一关闭或删除失败也不能跳过其他服务。
export function createHttpFixtureScope(root,{remove=rm}={}){
 const roots=new Set([root]),servers=new Set(),closing=new WeakMap();
 function close(server){
  if(closing.has(server))return closing.get(server);
  const pending=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('测试服务关闭超时')),5000);
   const finish=error=>{clearTimeout(timer);error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve();};
   try{server.close(finish);server.closeAllConnections();}catch(error){finish(error);}
  });closing.set(server,pending);return pending;
 }
 return {include:root=>roots.add(root),add:server=>servers.add(server),close,async dispose(){
  const failures=[];
  try{for(const result of await Promise.allSettled([...servers].map(close)))if(result.status==='rejected')failures.push(result.reason);}
  finally{for(const result of await Promise.allSettled([...roots].map(root=>remove(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}))))if(result.status==='rejected')failures.push(result.reason);}
  if(failures.length)throw new AggregateError(failures,failures.map(error=>error.message).join('；'));
 }};
}
