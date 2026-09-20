const form = document.querySelector('#preflight');
const status = document.querySelector('#status');
let report;
form.addEventListener('submit', async event => {
  event.preventDefault();
  form.querySelector('button').disabled = true;
  document.querySelector('#report').hidden = true;
  status.textContent = '正在读取文件并建立内容哈希基线…';
  try {
    const { token } = await (await fetch('/api/session')).json();
    const data = new FormData(form);
    const response = await fetch('/api/preflight', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organizer-Token': token }, body: JSON.stringify({ libraryPath: data.get('libraryPath'), wikiSourcePath: data.get('wikiSourcePath'), writersPaused: data.has('writersPaused') }) });
    report = await response.json();
    if (!response.ok) throw new Error(report.error);
    document.querySelector('#summary').textContent = `Markdown：${report.markdownCount ?? 0}；有摄取记录：${report.ingestedCount ?? 0}。源码版本：${report.version.detected ?? '未知'}；支持只读格式：${report.version.supported.join(', ')}；版本证据：${report.version.verifiedSource ? '指纹匹配' : '未核验'}。关联概况：${JSON.stringify(report.associations)}。`;
    document.querySelector('#blockers').replaceChildren(...report.blockers.map(item => { const li = document.createElement('li'); li.textContent = item.message; return li; }));
    const labels = { new: '未发现摄取记录', ingested: '已摄取', changed: '已摄取但内容变化', unknown: '无法判断', 'missing-association': '已摄取但关联缺失' };
    document.querySelector('#sources').replaceChildren(...report.sources.map(source => { const tr = document.createElement('tr'); for (const value of [source.identity, labels[source.status]]) { const td = document.createElement('td'); td.textContent = value; tr.append(td); } return tr; }));
    document.querySelector('#report').hidden = false;
    status.textContent = '预检完成；历史执行仍受兼容验证限制。';
  } catch (error) { status.textContent = error.message; }
  finally { form.querySelector('button').disabled = false; }
});
document.querySelector('#download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'organizer-preflight.json'; a.click(); URL.revokeObjectURL(url);
});

import '/planning-ui.js';
