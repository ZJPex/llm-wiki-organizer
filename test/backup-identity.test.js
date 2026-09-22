import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {copyTree} from '../src/backup.js';
import {inventory} from '../src/compatibility.js';

async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'backup-identity-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),target=path.join(root,'target');await fs.mkdir(source);await fs.mkdir(target);
 const from=path.join(source,'file.md'),to=path.join(target,'file.md');await fs.writeFile(from,'原始正文');
 return {source,target,from,to,baseline:await inventory(source)};
}

for(const field of ['ino','dev'])test(`复制文件的64位${field}不能经Number取整后误判为同一身份`,async t=>{
 const f=await fixture(t),low=2n**53n,high=low+1n;assert.notEqual(low,high);assert.equal(Number(low),Number(high));
 const original=fs.lstat;
 t.mock.method(fs,'lstat',async(file,options)=>{const stat=await original(file,options);if(file===f.from||file===f.to){const id=file===f.from?low:high;stat[field]=options?.bigint?id:Number(id);const other=field==='ino'?'dev':'ino';stat[other]=options?.bigint?5n:5;}return stat;});syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 await copyTree(f.source,f.target,f.baseline,[]);await fs.writeFile(f.to,'仅修改副本');assert.equal(await fs.readFile(f.from,'utf8'),'原始正文');
});

test('复制器实际创建硬链接时仍拒绝共享副本',async t=>{
 const f=await fixture(t);await assert.rejects(copyTree(f.source,f.target,f.baseline,[],(from,to)=>fs.link(from,to)),{code:'SHARED_DATA'});
 assert.equal((await fs.lstat(f.from,{bigint:true})).nlink,2n);
});

test('即使链接数为一，同设备同64位inode仍被拒绝',async t=>{
 const f=await fixture(t),original=fs.lstat;
 t.mock.method(fs,'lstat',async(file,options)=>{const stat=await original(file,options);if(file===f.from||file===f.to){stat.ino=options?.bigint?2n**54n:Number(2n**54n);stat.dev=options?.bigint?5n:5;}return stat;});syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 await assert.rejects(copyTree(f.source,f.target,f.baseline,[]),{code:'SHARED_DATA'});
});
