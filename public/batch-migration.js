let frozen, evolutionPlan;
const rows = document.querySelector('#rows'), status = document.querySelector('#status');
const labels = { selected: '可执行', blocked: '不安全', excluded: '已排除', pending: '等待执行', succeeded: '已成功', failed: '失败', 'not-run': '未执行', 'applied-unverified': '已发生修改，尚未验证' };
function invalidate() { frozen = null; document.querySelector('#review').hidden = true; document.querySelector('#results').hidden = true; status.textContent = '映射已修改，请重新计算并审核。'; }
function add(item = {}) {
  const tr = document.createElement('tr'); tr.dataset.id = item.id ?? '';
  for (const field of ['enabled', 'from', 'to']) { const td = document.createElement('td'), input = document.createElement('input'); input.dataset.field = field;
    input.setAttribute('aria-label', `第 ${rows.children.length + 1} 项${{ enabled: '纳入批次', from: '旧路径', to: '新路径' }[field]}`);
    if (field === 'enabled') { input.type = 'checkbox'; input.checked = item.status !== 'excluded'; }
    else { input.value = item[field] ?? ''; input.placeholder = 'raw/sources/目录/材料.md'; input.required = true; }
    input.addEventListener('input', invalidate); td.append(input); tr.append(td);
  }
  const state = document.createElement('td'); state.textContent = `${labels[item.status] ?? '待预检'}${item.reason ? `：${item.reason.message}` : ''}`; tr.append(state); rows.append(tr);
}
document.querySelector('#add').addEventListener('click', () => { add(); invalidate(); });
document.querySelector('[name=reportPath]').addEventListener('input', invalidate);
document.querySelector('#evolution').addEventListener('change', async event => {
  evolutionPlan = null; invalidate();
  try { const data = JSON.parse(await event.target.files[0].text()); evolutionPlan = data.evolution?.frozenPlan ?? data.frozenPlan ?? data; rows.replaceChildren(); invalidate(); status.textContent = '目录方案已加载，请生成完整映射进行审核。'; }
  catch { status.textContent = '无法读取目录方案，请选择已确认方案的 JSON 文件。'; }
});
async function call(action, input) {
  const { token } = await (await fetch('/api/session')).json();
  const response = await fetch(`/api/migration/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organizer-Token': token }, body: JSON.stringify(input) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
}
document.querySelector('#batch').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  invalidate(); status.textContent = '正在校验并生成新的批量方案…';
  try {
    const form = new FormData(event.target), mappings = [...rows.children].map(tr => ({ ...(tr.dataset.id ? { id: tr.dataset.id } : {}), from: tr.querySelector('[data-field=from]').value, to: tr.querySelector('[data-field=to]').value, enabled: tr.querySelector('[data-field=enabled]').checked }));
    frozen = await call('plan', { reportPath: form.get('reportPath'), writersPaused: form.has('writersPaused'), ...(mappings.length ? { mappings } : {}), ...(evolutionPlan ? { evolutionPlan } : {}) });
    rows.replaceChildren(); frozen.items.forEach(add);
    document.querySelector('#summary').textContent = `可执行 ${frozen.items.filter(item => item.status === 'selected').length} 项；阻塞或排除 ${frozen.items.filter(item => item.status !== 'selected').length} 项。冻结计划：${frozen.planManifestPath}`;
    document.querySelector('#changes').replaceChildren(...frozen.operations.map(op => { const li = document.createElement('li'); li.textContent = op.type === 'move' ? `${op.from} → ${op.to}` : `${op.type === 'links' ? '修复引用' : '更新关联'}：${op.path}`; return li; }));
    document.querySelector('#approve').checked = false; document.querySelector('#execute').disabled = frozen.status === 'blocked'; document.querySelector('#review').hidden = false; status.textContent = '方案已冻结；修改映射后必须重新审核。';
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
document.querySelector('#execute').addEventListener('click', async event => {
  if (!frozen || !document.querySelector('#approve').checked) { status.textContent = '请先审核并确认可执行范围。'; return; }
  event.target.disabled = true;
  status.textContent = '正在执行批量迁移并验证链接、索引和真实重扫结果…';
  try {
    const result = await call('execute', { planId: frozen.planId, planManifestPath: frozen.planManifestPath, planHash: frozen.logicalPlanHash, approved: true, writersPaused: document.querySelector('[name=writersPaused]').checked });
    document.querySelector('#result-summary').textContent = `${result.status === 'complete' ? '全部成功' : result.status === 'partial' ? '部分成功，仍有未执行项目' : '执行失败，现场已保留'}。恢复日志：${result.journalPath}`;
    document.querySelector('#result-items').replaceChildren(...result.items.map(item => { const li = document.createElement('li'); li.textContent = `${item.from} → ${item.to}：${labels[item.status]}`; return li; }));
    document.querySelector('#results').hidden = false; status.textContent = result.error?.message ?? '批次结束；原库仍未执行。';
  } catch (error) { status.textContent = error.message; }
});
document.querySelector('#download').addEventListener('click', () => { const url = URL.createObjectURL(new Blob([JSON.stringify(frozen, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'batch-plan.json'; a.click(); URL.revokeObjectURL(url); });
add();
