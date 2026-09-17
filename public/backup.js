const form = document.querySelector('#backup-form');
let report;
form.addEventListener('submit', async event => {
  event.preventDefault();
  const status = document.querySelector('#status');
  form.querySelector('button').disabled = true;
  document.querySelector('#result').hidden = true;
  status.textContent = '正在检查三目录并完整复制、校验，请保持外部写入停止…';
  try {
    const { token } = await (await fetch('/api/session')).json();
    const data = new FormData(form);
    const input = Object.fromEntries(data); input.writersPaused = data.has('writersPaused');
    const response = await fetch('/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organizer-Token': token }, body: JSON.stringify(input) });
    report = await response.json();
    if (!response.ok) throw new Error(report.error);
    document.querySelector('#summary').textContent = `批次 ${report.batchId}：${report.status === 'complete' ? '备份与副本校验完成' : '失败，已停止'}；恢复备份校验：${report.backupVerified ? '通过' : '未通过'}；验证副本校验：${report.validationVerified ? '通过' : '未通过'}；阶段：${report.phase}`;
    document.querySelector('#identities').replaceChildren(...[['原库', report.originalPath], ['恢复备份', report.backupPath], ['验证副本', report.validationPath], ['持久化报告', report.reportPath]].flatMap(([label, value]) => { const dt = document.createElement('dt'); dt.textContent = label; const dd = document.createElement('dd'); dd.textContent = value ?? '尚未建立'; return [dt, dd]; }));
    document.querySelector('#errors').replaceChildren(...report.errors.map(error => { const li = document.createElement('li'); li.textContent = `${error.code}：${error.message}`; return li; }));
    document.querySelector('#result').hidden = false;
    status.textContent = '流程结束。';
  } catch (error) { status.textContent = error.message; }
  finally { form.querySelector('button').disabled = false; }
});
document.querySelector('#download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `backup-${report.batchId}.json`; a.click(); URL.revokeObjectURL(url);
});
