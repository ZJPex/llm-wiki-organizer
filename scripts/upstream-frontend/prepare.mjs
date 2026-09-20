import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const [upstreamInput, destinationInput] = process.argv.slice(2);
if (!upstreamInput || !destinationInput) throw new Error('用法：node prepare.mjs <固定上游源码目录> <全新临时运行目录>');
const upstream = path.resolve(upstreamInput);
const destination = path.resolve(destinationInput);
const here = path.dirname(fileURLToPath(import.meta.url));
const hashes = JSON.parse(await readFile(path.join(here, 'fingerprints.json'), 'utf8'));
for (const [relative, expected] of Object.entries(hashes)) {
  const text = (await readFile(path.join(upstream, relative), 'utf8')).replace(/\r\n/g, '\n');
  if (createHash('sha256').update(text).digest('hex') !== expected) throw new Error(`未知上游文件：${relative}`);
}
await mkdir(destination);

for (const file of ['frontend.test.ts','external-copy.mjs','external-original.mjs','package.json','package-lock.json']) await copyFile(path.join(here,file),path.join(destination,file));
await writeFile(path.join(destination, 'vitest.config.mjs'), `export default ${JSON.stringify({root:destination,cacheDir:path.join(destination,'.vite'),resolve:{alias:{'@':path.join(upstream,'src'),'zustand':path.join(destination,'node_modules/zustand/esm/index.mjs'),'react':path.join(destination,'node_modules/react/index.js'),'@tauri-apps/api':path.join(destination,'node_modules/@tauri-apps/api'),'@tauri-apps/plugin-http':path.join(destination,'node_modules/@tauri-apps/plugin-http/dist-js/index.js')}},test:{include:['frontend.test.ts'],environment:'node',testTimeout:30000}},null,2)}`);
console.log(JSON.stringify({upstream,destination,filesVerified:Object.keys(hashes).length}));
