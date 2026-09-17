const section = document.createElement('section');
section.innerHTML = `<h2>内容命名方案</h2><p>只读复用 Wiki 的 OpenAI、DeepSeek 或自定义 Chat Completions 配置。分析会把所选材料发送给该模型；只保存审核方案，不搬动文件。已确认名称默认固定。</p><form id="planning"><label>源目录绝对路径<input name="sourceRoot" required></label><label>源文件相对路径（Markdown）<input name="identity" required></label><label>知识库路径（匹配 Wiki 项目覆盖）<input name="libraryPath" required></label><label>Wiki app-state.json 绝对路径<input name="configPath" required></label><button>分析并建议名称</button></form><p id="planning-status" role="status"></p><pre id="planning-detail"></pre><form id="confirm-name"><label>审核名称（含 .md）<input name="name" required></label><button>确认并保存方案</button></form><button id="export-plan">下载已保存方案</button>`;
document.querySelector('main').append(section);
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
  try { const result = await call('analyze', input); section.querySelector('#planning-detail').textContent = JSON.stringify(result, null, 2); section.querySelector('[name=name]').value = result.confirmedName ?? result.suggestion ?? ''; status.textContent = result.warning ?? '请核对证据、项目及章节系列信息后确认。'; }
  catch (e) { status.textContent = e.message; } finally { button.disabled = false; }
});
section.querySelector('#confirm-name').addEventListener('submit', async event => {
  event.preventDefault(); try { await call('confirm', { ...input, name: new FormData(event.target).get('name') }); status.textContent = '已保存审核方案，源文件未移动。'; } catch (e) { status.textContent = e.message; }
});
section.querySelector('#export-plan').addEventListener('click', async () => {
  try { const plan = await call('list', input ?? {}); const url = URL.createObjectURL(new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'organizer-plan.json'; a.click(); URL.revokeObjectURL(url); } catch(e) { status.textContent = e.message; }
});
