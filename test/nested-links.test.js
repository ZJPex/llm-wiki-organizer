import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLinks } from '../src/links.js';

test('迁移包含嵌套图片链接的材料时保留外部网址并修复内外层本地目标', () => {
  const text = '[![标志](https://example.org/logo.png)](https://example.org/project)\n[![本地](image.png)](peer.md#章)';
  const changes = new Map();
  const result = analyzeLinks({
    baseline: { files: ['old.md', 'image.png', 'peer.md'].map(path => ({ path })) },
    documents: [{ path: 'old.md', text }],
    moves: [{ from: 'old.md', to: 'folder/new.md' }], changes, affectedPages: [],
  });
  assert.equal(changes.get('old.md'), '[![标志](https://example.org/logo.png)](https://example.org/project)\n[![本地](../image.png)](../peer.md#章)');
  assert.equal(result.repairs.length, 2);
});

test('明确选择歧义双链的现有候选，记录修复并拒绝无关目标或过期选择', () => {
  const run = target => {
    const changes = new Map();
    const result = analyzeLinks({
      baseline: { files: ['nav.md', 'raw/FastAPI.md', 'wiki/fastapi.md', 'other.md'].map(path => ({ path })) },
      documents: [{ path: 'nav.md', text: '[[FastAPI|框架]]' }],
      moves: [{ from: 'raw/FastAPI.md', to: 'raw/new.md' }], changes, affectedPages: [],
      resolutions: [{ path: 'nav.md', link: 'FastAPI', target }],
    });
    return { changes, result };
  };
  const { changes, result } = run('wiki/fastapi.md');
  assert.equal(changes.get('nav.md'), '[[wiki/fastapi|框架]]');
  assert.equal(result.repairs[0].explicitlyResolved, true);
  assert.equal(run('raw/FastAPI.md').changes.get('nav.md'), '[[raw/new|框架]]');
  assert.throws(() => run('other.md'), { code: 'INVALID_LINK_RESOLUTION' });
  assert.throws(() => analyzeLinks({ baseline: { files: [] }, documents: [], moves: [], changes: new Map(), affectedPages: [], resolutions: [{ path: 'gone.md', link: 'FastAPI', target: 'wiki/fastapi.md' }] }), { code: 'INVALID_LINK_RESOLUTION' });
});

test('段首行内代码不会制造缩进，Wiki 知识链接不与同名原材料混淆', () => {
  const text = '`FastAPI` 框架见 [[fastapi]]，来源见 [[sources/old]]';
  const changes = new Map();
  const result = analyzeLinks({baseline:{files:['wiki/nav.md','wiki/entities/fastapi.md','raw/sources/FastAPI.md','wiki/sources/old.md','raw/sources/old.md'].map(path=>({path}))},documents:[{path:'wiki/nav.md',text}],moves:[{from:'raw/sources/FastAPI.md',to:'raw/sources/new.md'},{from:'wiki/sources/old.md',to:'wiki/sources/renamed.md'}],changes,affectedPages:[]});
  assert.equal(changes.get('wiki/nav.md'),'`FastAPI` 框架见 [[fastapi]]，来源见 [[wiki/sources/renamed]]');
  assert.equal(result.repairs.length,1);
  assert.throws(()=>analyzeLinks({baseline:{files:[{path:'old.md'}]},documents:[{path:'old.md',text:'    [[old]]'}],moves:[{from:'old.md',to:'new.md'}],changes:new Map(),affectedPages:[]}),{code:'UNSUPPORTED_LINKS'});
});

test('仅移动引用页且歧义候选集合完全不变时保留原链接，不猜目标', () => {
  const changes=new Map();
  const result=analyzeLinks({baseline:{files:['wiki/sources/old.md','wiki/concepts/topic.md','wiki/entities/topic.md'].map(path=>({path}))},documents:[{path:'wiki/sources/old.md',text:'[[topic]]'}],moves:[{from:'wiki/sources/old.md',to:'wiki/sources/new.md'}],changes,affectedPages:[]});
  assert.equal(result.preexistingAmbiguous.length,1);assert.equal(changes.size,0);
});
