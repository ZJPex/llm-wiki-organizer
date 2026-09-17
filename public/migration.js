let plan;
async function request(action, input) {
  const { token } = await (await fetch('/api/session')).json();
  const response = await fetch(`/api/migration/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organizer-Token': token }, body: JSON.stringify(input) });
  const data = await response.json(); if (!response.ok) throw new Error(`${data.code}: ${data.error}`); return data;
}
document.querySelector('#plan').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  document.querySelector('#review').hidden = true; document.querySelector('#result').hidden = true;
  try { const values = Object.fromEntries(new FormData(event.target)); values.writersPaused = values.writersPaused === 'on'; plan = await request('plan', values); document.querySelector('#details').textContent = JSON.stringify(plan, null, 2); document.querySelector('#approved').checked = false; document.querySelector('#execute').disabled = false; document.querySelector('#review').hidden = false; document.querySelector('#status').textContent = '请审核方案。'; }
  catch (error) { document.querySelector('#status').textContent = error.message; }
  finally { button.disabled = false; }
});
document.querySelector('#execute').addEventListener('click', async event => {
  if (!document.querySelector('#approved').checked) { document.querySelector('#status').textContent = '请先审核并勾选确认。'; return; }
  event.target.disabled = true; document.querySelector('#status').textContent = '正在执行副本迁移与真实上游重扫…';
  try { const report = await request('execute', { planId: plan.planId, approved: true, writersPaused: document.querySelector('[name=writersPaused]').checked }); document.querySelector('#output').textContent = JSON.stringify(report, null, 2); document.querySelector('#result').hidden = false; document.querySelector('#status').textContent = report.status === 'complete' ? '验证副本迁移完成；原库执行仍禁用。' : '迁移失败，现场与 journal 已保留。'; }
  catch (error) { document.querySelector('#status').textContent = error.message; }
});
