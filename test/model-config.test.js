import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readModelConfig, generateWithModel } from '../src/model-config.js';

test('Codex CLI 配置沿用摄取路由、项目覆盖和全局回退，不要求 API 密钥', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'model-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'state.json');
  const state = {
    recentProjects: [{ id: 'wiki', path: root }],
    llmConfig: { provider: 'codex-cli', model: 'global-model' },
    taskModelRouting: { ingestPresetId: 'codex-cli' },
    providerConfigs: { 'codex-cli': { model: 'gpt-5.6-sol', localCliIsolation: true, codexCliTimeoutMinutes: 17 } },
  };
  const read = async () => { await writeFile(configPath, JSON.stringify(state)); return readModelConfig({ configPath, libraryPath: root }); };
  let config = await read();
  assert.equal(config.provider, 'codex-cli');
  assert.equal(config.model, 'gpt-5.6-sol');
  assert.equal(config.localCliIsolation, true);
  assert.equal(config.codexCliTimeoutMinutes, 17);
  state.projectLlmOverrides = { wiki: { enabled: true, presetId: 'codex-cli', model: 'project-model' } };
  assert.equal((await read()).model, 'project-model');
  state.projectLlmOverrides.wiki.presetId = 'deleted-preset';
  assert.equal((await read()).model, 'global-model');
});

test('Codex CLI 通过标准输入接收材料并返回最终 JSON，模型名不经过 shell', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'model-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, 'fake-cli.cjs');
  await writeFile(fixture, `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{
    const args=process.argv.slice(2);
    const result={title:'缓存',summary:'缓存分析',evidence:['缓存正文'],uncertain:false};
    if(!input.includes('缓存正文')||!input.includes('材料整理助手')||!input.includes('连续精确子串')||args[args.indexOf('--model')+1]!=='model & echo secret'||!args.includes('read-only')||!args.includes('--ephemeral'))process.exit(2);
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}));
    console.log(JSON.stringify({type:'turn.completed'}));
  });`);
  const result = await generateWithModel({ provider: 'codex-cli', model: 'model & echo secret' }, { stage: 'segment', content: '缓存正文' }, { command: process.execPath, args: [fixture] });
  assert.deepEqual(result, { title: '缓存', summary: '缓存分析', evidence: ['缓存正文'], uncertain: false });
});

test('Codex CLI 失败、未完成或非法响应不泄露输出，超时终止进程', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'model-errors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, 'fake-cli.cjs');
  const config = { provider: 'codex-cli', model: 'test', localCliIsolation: true };
  const request = { stage: 'segment', content: '测试' };
  for (const source of [
    "process.stderr.write('private-secret');process.exit(1)",
    "console.log(JSON.stringify({type:'turn.failed',error:{message:'private-secret'}}))",
    "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{}'}}))",
    "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'private-secret'}}));console.log(JSON.stringify({type:'turn.completed'}))",
  ]) {
    await writeFile(fixture, source);
    await assert.rejects(generateWithModel(config, request, { command: process.execPath, args: [fixture] }), error => /Codex CLI/.test(error.message) && !error.message.includes('private-secret'));
  }
  await writeFile(fixture, "setInterval(()=>{},1000)");
  await assert.rejects(generateWithModel(config, request, { command: process.execPath, args: [fixture], timeoutMs: 200 }), /超时/);
  await assert.rejects(generateWithModel(config, request, { command: path.join(root, 'missing-program') }), /启动失败/);
});
