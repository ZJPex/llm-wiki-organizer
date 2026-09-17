let plan;
function showReport(selector, data, completed = false) {
  const host = document.querySelector(selector); host.replaceChildren();
  const line = (label, value) => {
    const element = document.createElement('p'); element.textContent = `${label}：${value}`; host.append(element);
  };
  line('验证副本', data.validationPath);
  line('Raw 路径', `${data.mapping.oldPath} → ${data.mapping.newPath}`);
  if (data.summaryMapping) line('摘要路径', `${data.summaryMapping.oldPath} → ${data.summaryMapping.newPath}`);
  line('受影响页面', data.affectedPages.length ? data.affectedPages.join('、') : '无');
  line('计划操作', `${data.operations.filter(item => item.type === 'move').length} 项移动，${data.operations.filter(item => item.type !== 'move').length} 项关联更新`);
  if (data.links) {
    line('链接修复', `${data.links.repairs.length} 处`);
    line('原有失效链接', `${data.links.preexistingBroken.length} 处`);
    line('原有歧义链接', `${data.links.preexistingAmbiguous.length} 处`);
    line('新增失效链接', `${data.links.newlyBroken.length} 处`);
  }
  if (completed) {
    line('执行状态', data.status === 'complete' ? '验证通过' : `失败（${data.phase}）`);
    line('模型调用尝试', data.modelAttempts.length);
    if (data.afterProof) line('迁移后重扫变更任务', data.afterProof.result.changedTasks.length);
    line('恢复记录', data.journalPath);
    if (data.error) line('失败原因', typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
  }
  const details = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = '查看完整验证数据';
  const raw = document.createElement('pre'); raw.textContent = JSON.stringify(data, null, 2);
  details.append(summary, raw); host.append(details);
}
async function request(action, input) {
  const { token } = await (await fetch('/api/session')).json();
  const response = await fetch(`/api/migration/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organizer-Token': token }, body: JSON.stringify(input) });
  const data = await response.json(); if (!response.ok) throw new Error(`${data.code}: ${data.error}`); return data;
}
document.querySelector('#plan').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  document.querySelector('#review').hidden = true; document.querySelector('#result').hidden = true;
  try { const values = Object.fromEntries(new FormData(event.target)); values.writersPaused = values.writersPaused === 'on'; plan = await request('plan', values); showReport('#details', plan); document.querySelector('#approved').checked = false; document.querySelector('#execute').disabled = false; document.querySelector('#review').hidden = false; document.querySelector('#status').textContent = '请审核方案。'; }
  catch (error) { document.querySelector('#status').textContent = error.message; }
  finally { button.disabled = false; }
});
document.querySelector('#execute').addEventListener('click', async event => {
  if (!document.querySelector('#approved').checked) { document.querySelector('#status').textContent = '请先审核并勾选确认。'; return; }
  event.target.disabled = true; document.querySelector('#status').textContent = '正在执行副本迁移与真实上游重扫…';
  try { const report = await request('execute', { planId: plan.planId, approved: true, writersPaused: document.querySelector('[name=writersPaused]').checked }); showReport('#output', report, true); document.querySelector('#result').hidden = false; document.querySelector('#status').textContent = report.status === 'complete' ? '验证副本迁移完成；原库执行仍禁用。' : '迁移失败，现场与恢复记录已保留。'; }
  catch (error) { document.querySelector('#status').textContent = error.message; }
});
