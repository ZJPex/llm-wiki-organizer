// 所有正式页面共用页头、导航和图标；页面内容及其事件绑定保持独立。
const icon = name => `<span class="ui-icon icon-${name}" aria-hidden="true"></span>`;
const pages = {
  '/': ['任务首页', 'home'], '/task-report': ['任务报告', 'recovery'],
  '/recovery': ['恢复与报告', 'recovery'], '/preflight': ['兼容检查', 'preflight'],
  '/backup': ['完整备份', 'recovery'], '/migration': ['副本迁移', 'recovery'],
  '/batch-migration': ['批量迁移', 'recovery'], '/original': ['原库执行', 'recovery'],
  '/inbox': ['日常整理', 'home'], '/restructure': ['首次重构', 'home'],
};

export function renderPageShell(html, requestTarget) {
  const {pathname:route,searchParams}=new URL(requestTarget,'http://organizer.local');
  let [title, current] = pages[route] ?? pages['/'];
  const workspace = route === '/';
  if(workspace){
    const batchId=searchParams.get('batchId'),view=searchParams.get('view');
    const initial=batchId?['集中审核','home']:view==='settings'?['知识库设置','settings']:view==='browse'?['分类浏览','browse']:null;
    if(initial){
      [title,current]=initial;
      // 首帧只呈现目标页标题和加载状态，避免首页在异步初始化前闪现。
      html=html.replace('<h1 id="title">整理任务</h1>',`<h1 id="title">${title}</h1>`)
        .replace('<p id="home-intro">','<p id="home-intro" hidden>')
        .replace('<form id="start">','<form id="start" hidden>')
        .replace('<section id="home"','<section id="home" hidden');
    }
  }
  const item = (key, label, symbol, url) => {
    const active = key === current ? ' aria-current="page"' : '';
    const content = icon(symbol) + label;
    if (workspace && ['home', 'browse', 'settings'].includes(key)) return `<button id="${key}-nav"${active}>${content}</button>`;
    return `<a href="${url}"${active}>${content}</a>`;
  };
  const navigation = `<aside class="app-nav"><nav aria-label="主要导航">${item('home', '整理任务', 'document', '/')}${item('browse', '分类浏览', 'folder', '/?view=browse')}${item('recovery', '恢复与报告', 'history', '/recovery')}</nav><nav aria-label="环境设置">${item('settings', '知识库设置', 'settings', '/?view=settings')}${item('preflight', '兼容检查', 'shield', '/preflight')}</nav></aside>`;
  const header = `<header class="app-header"><a class="brand" href="/" aria-label="知识库整理，返回任务首页"><span class="brand-mark">${icon('book')}</span>知识库整理</a><span id="page-label">${title}</span></header>`;
  const framed = html.replace('<body>', `<body>${header}${navigation}`);
  return workspace ? framed : framed.replace('<main>', '<main class="utility-page">');
}
