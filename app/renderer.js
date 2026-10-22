const api = window.lmcl;
let state, page = 'home', versions = [], versionFilter = 'release', draftName = '', draftVersion = '', currentProgress;
const catalogs = new Map();
let toastTimer;
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const icons = {
  home: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  downloads: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  accounts: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  servers: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M15 6.5h3M15 17.5h3"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="white"/><circle cx="15" cy="17" r="3" fill="white"/>',
};
const names = { home: '我的游戏', downloads: '下载', accounts: '账户', servers: '服务器', settings: '设置', about: '关于 LMCL' };
const svg = key => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[key]}</svg>`;
const button = (action, text, style = '', attributes = '') => `<button class="${style}" data-act="${action}" ${attributes}>${text}</button>`;
function toast(message) {
  const element = document.getElementById('toast'); element.textContent = message; element.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { element.hidden = true; }, 7000);
}
function heading(title, subtitle, actions = '') {
  return `<div class="page-head"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="actions">${actions}</div></div>`;
}
function renderHome() {
  const actions = button('import', '导入目录') + button('go-download', '＋ 下载游戏', 'primary');
  const list = state.instances.length ? state.instances.map(item => `<article class="instance"><div class="cube">◇</div><div class="instance-info"><h3>${escape(item.name)}</h3><p>Minecraft ${escape(item.version)} <span class="tag">原版</span>　Java ${escape(item.javaMajor)}</p></div><div class="actions">${button('instance-folder', '文件夹', 'quiet small', `data-id="${escape(item.id)}"`)}${button('launch', state.running.includes(item.id) ? '运行中' : '启动游戏', 'primary', `data-id="${escape(item.id)}" ${state.busy || state.running.includes(item.id) ? 'disabled' : ''}`)}</div></article>`).join('') :
    `<section class="empty"><div class="empty-symbol">＋</div><h3>还没有游戏实例</h3><p>下载一个原版版本，或导入已有的游戏目录<br>每个新下载的实例都有独立的存档和设置</p><div class="actions">${button('go-download', '下载游戏', 'primary')}${button('import', '导入已有目录')}</div></section>`;
  return heading('我的游戏', '管理版本和实例，按自己的方式玩', actions) +
    `<div class="hero"><div><h2>${state.profile ? `你好，${escape(state.profile.name)}` : '从一个新世界开始'}</h2><p>${state.profile ? '选一个实例，继续你的冒险' : '先下载游戏，再创建一个离线角色就能开始体验'}</p></div><button class="account-pill" data-nav="accounts">${state.profile ? `离线角色 · ${escape(state.profile.name)}` : '设置游戏角色　→'}</button></div>` +
    `<div class="section-title">游戏实例<span>${state.instances.length} 个实例</span></div>${list}<div class="hint-row"><span>普通模式无需接入服务器</span><span>游戏文件从官方来源下载</span><span>当前为功能预览版</span></div>`;
}
function renderDownloads() {
  const choices = versions.filter(version => version.type === versionFilter);
  if (!choices.some(version => version.id === draftVersion)) draftVersion = choices[0]?.id ?? '';
  return heading('下载游戏', '安装一个新版本，让游戏目录保持整洁', button('versions', versions.length ? '刷新版本列表' : '获取版本列表')) +
    `<div class="tabs"><button class="active">游戏版本</button><button disabled>加载器<small>待接入</small></button><button disabled>模组<small>待接入</small></button><button disabled>整合包<small>待接入</small></button></div><div class="two-columns"><section class="panel"><h2>原版 Minecraft</h2><p>选择版本，文件会下载并校验到独立实例中</p><form id="install-form"><div class="form-grid"><label>版本类型<select id="version-type"><option value="release" ${versionFilter === 'release' ? 'selected' : ''}>正式版</option><option value="snapshot" ${versionFilter === 'snapshot' ? 'selected' : ''}>快照版</option></select></label><label>游戏版本<select id="version-select" name="version" ${!choices.length ? 'disabled' : ''}>${choices.length ? choices.map(version => `<option value="${escape(version.id)}" ${version.id === draftVersion ? 'selected' : ''}>${escape(version.id)}</option>`).join('') : '<option>先获取版本列表</option>'}</select></label></div><label>实例名称<input id="instance-name" name="name" maxlength="100" placeholder="例如：我的生存存档" value="${escape(draftName)}"></label><button type="submit" class="primary full" ${!choices.length || state.busy ? 'disabled' : ''}>${state.busy ? '正在下载…' : '下载并创建实例'}</button><div class="version-message">${choices.length ? `当前有 ${choices.length} 个可选版本` : '点击右上角，从官方获取支持的版本列表'}</div></form></section><section class="panel"><h2>开始之前</h2><p>这版已接入原版下载和离线启动。下载完成后，在设置里选择游戏所需的 Java，再创建离线角色。</p><div class="note warning">Java 需要自行安装。加载器安装、模组搜索和整合包导入还在开发中。</div><div class="divider"></div><h2>已有游戏目录？</h2><p>可导入包含 versions 文件夹的原版游戏目录，不复制或删除原来的文件。</p>${button('import', '选择游戏目录', 'secondary full')}</section></div>`;
}
function renderAccounts() {
  return heading('账户', '优先推荐正版，同时保留外置与离线登录选择') + `<div class="account-grid"><section class="account-card"><div class="account-icon"><i class="ms"></i></div><h2>微软正版登录<span class="tag">推荐</span></h2><p>计划通过微软网页完成授权<br>这个预览版尚未接入</p><button disabled>登录功能开发中</button></section><section class="account-card"><div class="account-icon">L<span class="tag">LittleSkin</span></div><h2>LittleSkin 登录</h2><p>外置角色、皮肤和会话管理<br>这个预览版尚未接入</p><button disabled>登录功能开发中</button></section></div><section class="panel"><h2>离线角色</h2><p>可用于单人游戏或接受离线角色的服务器，不会自动切换你的其他账户</p><form id="profile-form" class="offline-form"><label>角色名称<input name="name" value="${escape(state.profile?.name)}" placeholder="1–16 位英文字母、数字或下划线" pattern="[a-zA-Z0-9_]{1,16}" required maxlength="16"></label><button class="primary" type="submit">${state.profile ? '保存角色' : '创建离线角色'}</button></form>${state.profile ? `<div class="divider"></div><div class="note">当前角色：${escape(state.profile.name)}<br>UUID：<code>${escape(state.profile.uuid)}</code></div>` : ''}</section>`;
}
function renderServers() {
  if (state.settings.mode !== 'server') return heading('服务器', '服务器接入是可选功能') + `<section class="empty"><div class="empty-symbol">⇄</div><h3>当前在普通模式</h3><p>普通功能不依赖任何服务器<br>需要接入时，切换右上角的使用模式</p><button data-mode="server" class="primary">切换到服务器模式</button></section>`;
  const providers = state.settings.providers;
  return heading('服务器', '添加你自己的接入方，公开版不预设任何服务器', button('add-provider', '＋ 添加接口', 'primary')) +
    (providers.length ? providers.map(provider => {
      const result = catalogs.get(provider.id);
      return `<section class="panel"><div class="provider"><div><h3>${escape(provider.name)}</h3><code>${escape(provider.apiRoot)}</code></div><div class="actions">${button('catalog', '查询目录', 'secondary small', `data-id="${escape(provider.id)}"`)}${button('remove-provider', '移除', 'quiet small', `data-id="${escape(provider.id)}"`)}</div></div>${result ? result.error ? `<p class="last">状态未知：${escape(result.error)}</p>` : result.servers.length ? result.servers.map(server => `<div class="server-row"><strong>${escape(server.name)}</strong><span class="status ${escape(server.status.state)}">${({ online: '在线', offline: '离线', unknown: '未知', maintenance: '维护中' })[server.status.state]}${server.status.state === 'online' && server.status.online !== null ? ` · ${server.status.online}/${server.status.max ?? '—'}` : ''}</span></div>`).join('') : '<p class="last">该接入方尚未发布服务器</p>' : '<p class="last">点击查询目录，读取接入方提供的服务器信息</p>'}</section>`;
    }).join('') : `<section class="empty"><div class="empty-symbol">⌘</div><h3>还没有添加服务器接口</h3><p>向服务器运营者获取 LMCL 接入地址<br>也可以随时回到普通模式，使用本地游戏</p>${button('add-provider', '添加第一个接口', 'primary')}</section>`) + `<p class="note">当前支持保存接口与查询目录。服务器整合包安装、授权和发布校验尚未接入。</p>`;
}
function renderSettings() {
  return heading('设置', '先把运行环境选好，其他的慢慢来') + `<section class="panel"><div class="settings-row"><div><h2>Java 运行环境</h2><p>需要与实例要求的 Java 主版本一致</p></div><div class="actions">${button('java-detect', '自动检测')}${button('java-choose', '手动选择', 'secondary')}</div></div>${state.java.length ? state.java.map(java => `<div class="java-row"><strong>Java ${java.major}${java.arch ? ` · ${escape(java.arch)}` : ''}</strong><code>${escape(java.path)}</code></div>`).join('') : `<p class="last">尚未检测 Java。可以扫描已安装环境，或手动选择 ${state.platform === 'win32' ? 'bin/java.exe' : 'Contents/Home/bin/java'}。${state.platform === 'darwin' ? 'M 系列请安装 ARM64 / AArch64 版 Java。' : ''}</p>`}</section><section class="panel"><form id="memory-form" class="settings-row"><div><h2>游戏最大内存</h2><p class="last">设置上限不会立即占用所有内存</p></div><div class="actions"><input aria-label="最大内存 MB" name="memory" type="number" min="1024" max="32768" step="256" value="${state.memoryMB}" required><span class="note">MB</span><button type="submit">保存</button></div></form></section><section class="panel"><div class="settings-row"><div><h2>启动器数据目录</h2><p class="last"><code>${escape(state.dataRoot)}</code></p></div>${button('data-folder', '打开文件夹')}</div></section>${state.platform === 'win32' ? `<section class="panel"><div class="settings-row"><div><h2>打开基岩版</h2><p class="last">仅唤起已安装的应用，不负责下载或更新</p></div>${button('bedrock', '打开基岩版', '', state.platform !== 'win32' ? 'disabled' : '')}</div></section>` : ''}`;
}
function renderAbout() {
  return heading('关于 LMCL', '一个还在生长的通用启动器') + `<section class="panel about"><img src="assets/avatar.png" alt="llroxy 的头像"><div><h1>LMCL</h1><div class="version">${escape(state.version)} · ${state.platform === 'darwin' ? 'macOS Apple Silicon' : 'Windows'} 功能预览</div><p>由 llroxy 发起的 Minecraft Java 启动器项目。普通游戏与整合包功能独立使用，服务器通过可选接口接入。</p><p class="last">这张头像作为界面元素使用，应用图标还没有定稿。当前界面也是临时版本，之后会按设计稿调整。</p></div></section><section class="panel"><h2>这版能做什么</h2><p>原版游戏下载与校验、创建离线角色、检测 Java、导入标准原版目录、启动游戏，以及保存服务器接口和查询目录。</p><h2>接下来</h2><p class="last">微软与 LittleSkin 登录、加载器安装、模组与整合包下载、自动更新，以及正式 UI。</p></section>`;
}
function render() {
  if (!state) return;
  const items = ['home', 'downloads', 'accounts', ...(state.settings.mode === 'server' ? ['servers'] : []), 'settings'];
  document.getElementById('navigation').innerHTML = items.map(key => `${key === 'settings' ? '<div class="nav-divider"></div>' : ''}<button class="nav-item ${page === key ? 'active' : ''}" data-nav="${key}">${svg(key)}${names[key]}</button>`).join('');
  document.querySelectorAll('[data-mode]').forEach(element => { const active = element.dataset.mode === state.settings.mode; element.classList.toggle('active', active); element.setAttribute('aria-pressed', String(active)); });
  document.getElementById('breadcrumb').textContent = names[page];
  document.getElementById('content').innerHTML = ({ home: renderHome, downloads: renderDownloads, accounts: renderAccounts, servers: renderServers, settings: renderSettings, about: renderAbout })[page]();
  renderTask();
}
function renderTask() {
  document.getElementById('taskbar').innerHTML = currentProgress ? `<span class="task-text">${escape(currentProgress.phase)}${currentProgress.total ? ` · ${currentProgress.done}/${currentProgress.total}` : ''}</span>${currentProgress.total ? `<progress value="${currentProgress.done}" max="${currentProgress.total}"></progress>` : ''}${state.busy ? button('cancel', '取消', 'quiet small') : ''}` : '<span>LMCL · 通用 Java 启动器</span><span>功能预览 / 界面待定稿</span>';
}
document.addEventListener('click', async event => {
  const element = event.target.closest('button');
  if (!element || element.disabled) return;
  if (element.dataset.nav) { page = element.dataset.nav; render(); document.getElementById('content').scrollTop = 0; return; }
  const action = element.dataset.act, id = element.dataset.id;
  try {
    if (element.dataset.mode) {
      page = element.dataset.mode === 'server' ? 'servers' : 'home';
      await api.setMode(element.dataset.mode); state = await api.getState(); render(); document.getElementById('content').scrollTop = 0; return;
    }
    if (action === 'go-download') { page = 'downloads'; render(); document.getElementById('content').scrollTop = 0; }
    if (action === 'versions') { element.disabled = true; element.textContent = '获取中…'; versions = await api.versions(); render(); }
    if (action === 'import') { const added = await api.importGame(); if (added?.length) { page = 'home'; state = await api.getState(); render(); toast(`已导入 ${added.length} 个原版实例`); } }
    if (action === 'launch') { element.disabled = true; element.textContent = '准备启动…'; await api.launch(id); toast('已启动，游戏窗口将单独打开'); }
    if (action === 'instance-folder') await api.openGameFolder(id);
    if (action === 'cancel') { await api.cancel(); toast('正在取消下载…'); }
    if (action === 'add-provider') document.getElementById('provider-dialog').showModal();
    if (action === 'close-dialog') document.getElementById('provider-dialog').close();
    if (action === 'remove-provider') { await api.removeProvider(id); catalogs.delete(id); }
    if (action === 'catalog') {
      element.disabled = true; element.textContent = '查询中…';
      try { catalogs.set(id, { servers: await api.catalog(id) }); }
      catch (error) { catalogs.set(id, { error: error.message }); }
      render();
    }
    if (action === 'java-detect') { element.disabled = true; element.textContent = '检测中…'; const found = await api.discoverJava(); toast(found.length ? `找到 ${found.length} 个 Java 环境` : '未找到 Java，请手动选择已安装的 Java'); }
    if (action === 'java-choose') { await api.chooseJava(); }
    if (action === 'data-folder') await api.openData();
    if (action === 'bedrock') await api.openBedrock();
  } catch (error) { toast(error.message); render(); }
});
document.addEventListener('change', event => {
  if (event.target.id === 'version-type') { versionFilter = event.target.value; draftVersion = ''; render(); }
  if (event.target.id === 'version-select') draftVersion = event.target.value;
});
document.addEventListener('input', event => { if (event.target.id === 'instance-name') draftName = event.target.value; });
document.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target, data = new FormData(form), submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    if (form.id === 'profile-form') { await api.saveProfile(data.get('name')); toast('离线角色已保存'); }
    if (form.id === 'memory-form') { await api.saveMemory(Number(data.get('memory'))); toast('内存设置已保存'); }
    if (form.id === 'provider-form') {
      await api.addProvider({ id: data.get('id'), name: data.get('name'), apiRoot: data.get('apiRoot') });
      document.getElementById('provider-dialog').close(); form.reset(); toast('接口已添加，点击查询目录即可读取服务器');
    }
    if (form.id === 'install-form') {
      const entry = await api.install({ version: data.get('version'), name: data.get('name') });
      page = 'home'; draftName = ''; state = await api.getState(); render(); toast(`${entry.name} 已下载完成`);
    }
  } catch (error) { toast(error.message); }
  finally { submit.disabled = false; }
});
api.onState(value => { state = value; render(); });
api.onProgress(value => { currentProgress = value; renderTask(); });
try { state = await api.getState(); render(); window.__ready = true; }
catch (error) { document.getElementById('content').textContent = `配置读取失败：${error.message}`; }
