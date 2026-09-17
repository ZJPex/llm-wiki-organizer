const section = document.createElement('section');
section.innerHTML = `<h2>内容命名方案</h2><p>只读复用 Wiki 的 OpenAI、DeepSeek 或自定义 Chat Completions 配置。分析会把所选材料发送给该模型；只保存审核方案，不搬动文件。已确认名称默认固定。</p><form id="planning"><label>源目录绝对路径<input name="sourceRoot" required></label><label>源文件相对路径（Markdown）<input name="identity" required></label><label>知识库路径（匹配 Wiki 项目覆盖）<input name="libraryPath" required></label><label>Wiki app-state.json 绝对路径<input name="configPath" required></label><button>分析并建议名称</button></form><p id="planning-status" role="status"></p><div id="planning-detail"></div><form id="confirm-name"><label>审核名称（含 .md）<input name="name" required></label><button>确认并保存方案</button></form><button id="export-plan">下载已保存方案</button>`;
document.querySelector('main').append(section);
function renderAnalysis(result) {
  const panel = section.querySelector('#planning-detail'); panel.replaceChildren();
  const kinds = { body: '正文', navigation: '导航索引', 'title-only': '仅标题', blank: '空白', noise: '低信息噪声' };
  for (const [label, value] of [['材料类型', kinds[result.kind]], ['建议名称', result.suggestion ?? '暂无可靠建议'], ['确认名称', result.confirmedName ?? '尚未确认'], ['内容摘要', result.analysis?.summary ?? '证据不足，需人工处理']]) { const p = document.createElement('p'); const strong = document.createElement('strong'); strong.textContent = `${label}：`; p.append(strong, document.createTextNode(value ?? '')); panel.append(p); }
  const title = document.createElement('h4'); title.textContent = '原文证据'; panel.append(title);
  for (const evidence of result.analysis?.evidence ?? []) { const quote = document.createElement('blockquote'); quote.textContent = evidence; panel.append(quote); }
  if (result.warning) { const p = document.createElement('p'); p.textContent = result.warning; panel.append(p); }
}
let input;
const status = section.querySelector('#planning-status');
async function call(action, body) {
  const { token } = await (await fetch('/api/session')).json();
  const response = await fetch(`/api/planning/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organizer-Token': token }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
section.querySelector('#planning').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  input = Object.fromEntries(new FormData(event.target)); status.textContent = '正在覆盖全文分段分析…';
  try { const result = await call('analyze', input); renderAnalysis(result); section.querySelector('[name=name]').value = result.confirmedName ?? result.suggestion ?? ''; status.textContent = result.warning ?? '请核对证据、项目及章节系列信息后确认。'; }
  catch (e) { status.textContent = e.message; } finally { button.disabled = false; }
});
section.querySelector('#confirm-name').addEventListener('submit', async event => {
  event.preventDefault(); try { await call('confirm', { ...input, name: new FormData(event.target).get('name') }); status.textContent = '已保存审核方案，源文件未移动。'; } catch (e) { status.textContent = e.message; }
});
section.querySelector('#export-plan').addEventListener('click', async () => {
  try { const plan = await call('list', input ?? {}); const url = URL.createObjectURL(new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'organizer-plan.json'; a.click(); URL.revokeObjectURL(url); } catch(e) { status.textContent = e.message; }
});

const categoryForm = document.createElement('form');
categoryForm.innerHTML = `<h3>选择现有主分类</h3><label>现有分类根目录<input name="categoryRoot" required></label><button>为已确认名称推荐分类</button><p id="category-reason"></p><label>审核主分类<select name="category"></select></label><p id="category-path"></p><button type="button" id="confirm-category">保存冻结方案</button>`;
section.append(categoryForm);
let categoryInput;
let categoryName = '';
const categorySelect = categoryForm.querySelector('select');
function previewCategory() { const root = categoryInput?.categoryRoot ?? ''; const name = categoryName; categoryForm.querySelector('#category-path').textContent = `最终路径：${root}/${categorySelect.value ? categorySelect.value + '/' : ''}${name}`; }
categorySelect.addEventListener('change', previewCategory);
categoryForm.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    categoryInput = { ...input, categoryRoot: new FormData(categoryForm).get('categoryRoot') };
    const result = await call('classify', categoryInput);
    const classification = result.classification; categoryName = result.confirmedName;
    categorySelect.replaceChildren(...classification.options.map(value => { const option = document.createElement('option'); option.value = value; option.textContent = value || '分类根目录'; return option; }));
    categorySelect.selectedIndex = classification.category === null ? -1 : classification.options.indexOf(classification.category);
    categoryForm.querySelector('#category-reason').textContent = classification.reason;
    categoryForm.querySelector('#category-path').textContent = classification.finalPath ?? '证据不足，请明确选择一个现有分类后审核。';
  } catch(e) { status.textContent = e.message; }
});
categoryForm.querySelector('#confirm-category').addEventListener('click', async () => {
  try { if (categorySelect.selectedIndex < 0) throw new Error('请明确选择主分类'); const result = await call('confirmCategory', { ...categoryInput, category: categorySelect.value }); categoryForm.querySelector('#category-path').textContent = result.frozenPlan.finalPath; status.textContent = '完整路径方案已冻结保存；Raw 未变化。'; } catch(e) { status.textContent = e.message; }
});


const evolutionForm = document.createElement('form');
evolutionForm.innerHTML = `<h3>必要时调整局部分类</h3><label>开始检查的分类相对路径<input name="startCategory"></label><button>检查是否需要调整</button><p id="evolution-reason"></p><div id="evolution-operations"></div><button type="button" id="evolution-preview">预览受影响路径</button><div id="evolution-paths"></div><button type="button" id="evolution-confirm">冻结已审核调整</button>`;
section.append(evolutionForm);
let evolutionInput, evolutionOperations = [];
function editedOperations() { return evolutionOperations.filter((_, index) => evolutionForm.querySelector(`[data-include="${index}"]`).checked).map((op) => structuredClone(op)); }
function showEvolutionPaths(plan) {
  const panel = evolutionForm.querySelector('#evolution-paths'); panel.replaceChildren();
  for (const item of [...plan.directoryMappings, ...plan.fileMappings]) { const p = document.createElement('p'); p.textContent = `${item.from} → ${item.to}`; panel.append(p); }
  for (const directory of plan.newDirectories) { const p = document.createElement('p'); p.textContent = `新增分类：${directory}`; panel.append(p); }
  if (!plan.fileMappings.length) { const p = document.createElement('p'); p.textContent = '没有已有材料需要移动。'; panel.append(p); }
}
evolutionForm.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    evolutionInput = { ...categoryInput, ...input, categoryRoot: categoryForm.querySelector('[name=categoryRoot]').value, startCategory: new FormData(evolutionForm).get('startCategory') };
    const result = await call('evolve', evolutionInput); evolutionOperations = result.operations;
    evolutionForm.querySelector('#evolution-reason').textContent = result.visited.map(v => `${v.scope || '根分类'}：${v.reason}`).join('；') || result.reason;
    const list = evolutionForm.querySelector('#evolution-operations'); list.replaceChildren(); evolutionForm.querySelector('#evolution-paths').replaceChildren();
    const labels = { add: '新增', split: '拆分', merge: '合并', move: '调整归属' };
    evolutionOperations.forEach((op, index) => {
      const box = document.createElement('fieldset'); const legend = document.createElement('legend'); legend.textContent = `${labels[op.type]}：${op.from ?? op.parent ?? '根分类'}`; box.append(legend);
      const include = document.createElement('input'); include.type = 'checkbox'; include.checked = true; include.dataset.include = index; const enabled = document.createElement('label'); enabled.append(include, '保留此建议'); box.append(enabled);
      for (const [key, label] of [['label', '分类名称'], ['parent', '目标父分类'], ['to', '合并目标'], ['problem', '现有问题'], ['benefit', '查找收益']]) if (typeof op[key] === 'string') { const row = document.createElement('label'); row.append(`${label}：`); const edit = document.createElement('input'); edit.value = op[key]; edit.addEventListener('input', () => { op[key] = edit.value; }); row.append(edit); box.append(row); }
      for (const group of op.groups ?? []) { const row = document.createElement('label'); row.append('拆分类名：'); const edit = document.createElement('input'); edit.value = group.label; edit.addEventListener('input', () => { group.label = edit.value; }); row.append(edit); const files = document.createElement('p'); files.textContent = `材料：${group.files.join('、')}`; box.append(row, files); }
      list.append(box);
    });
  } catch(e) { status.textContent = e.message; }
});
evolutionForm.querySelector('#evolution-preview').addEventListener('click', async () => { try { const result = await call('confirmEvolution', { ...evolutionInput, operations: editedOperations(), previewOnly: true }); showEvolutionPaths(result.preview); } catch(e) { status.textContent = e.message; } });
evolutionForm.querySelector('#evolution-confirm').addEventListener('click', async () => { try { const result = await call('confirmEvolution', { ...evolutionInput, operations: editedOperations() }); showEvolutionPaths(result.frozenPlan); status.textContent = '局部目录与全部受影响材料方案已冻结，文件尚未迁移。'; } catch(e) { status.textContent = e.message; } });
