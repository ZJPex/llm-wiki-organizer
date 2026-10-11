import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHttpFixtureScope} from './helpers/http-fixture-scope.js';
import {listenForBrowser} from './helpers/http-server.js';

test('临时目录清理失败仍先关闭全部真实服务器，重复关闭不会遗留可访问监听',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'organizer-cleanup-')),secondRoot=await mkdtemp(path.join(os.tmpdir(),'organizer-cleanup-')),servers=[];t.after(async()=>{for(const server of servers){server.closeAllConnections();server.close();}await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});await rm(secondRoot,{recursive:true,force:true});});
 const scope=createHttpFixtureScope(root,{remove:async(directory,options)=>{if(directory===root)throw new Error('合成临时目录删除失败');await rm(directory,options);}}),urls=[];scope.include(secondRoot);
 for(let index=0;index<2;index++){const server=http.createServer((_,response)=>response.end('reachable'));servers.push(server);scope.add(server);await listenForBrowser(server);urls.push(`http://127.0.0.1:${server.address().port}`);assert.equal(await(await fetch(urls.at(-1),{signal:AbortSignal.timeout(2000)})).text(),'reachable');}
 await assert.rejects(scope.dispose(),/合成临时目录删除失败/);
 await assert.rejects(readdir(secondRoot),{code:'ENOENT'});
 for(const url of urls)await assert.rejects(fetch(url,{signal:AbortSignal.timeout(2000)}));
 await scope.close(servers[0]);await scope.close(servers[1]);
});
