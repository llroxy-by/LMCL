const api = window.lmcl;
let state;
let page = 'home';
let versions = [];
let versionFilter = 'release';
let draftName = '';
let draftVersion = '';
let currentProgress;
let mango = { loaded: false, status: null, saves: [], savesLoaded: false };
let toastTimer;

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const icons = {
  home: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  downloads: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  accounts: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6.2 8.3 5 5 0 0 0 7 18Z"/><path d="M9 14h6"/>',
  servers: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M15 6.5h3M15 17.5h3"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="white"/><circle cx="15" cy="17" r="3" fill="white"/>',
};
const names = { home: '我的游戏', downloads: '下载', accounts: '账户', cloud: '云存档', servers: '服务器', settings: '设置', about: '关于 LMCL' };
const svg = key => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[key]}</svg>`;
const button = (action, text, style = '', attributes = '') => `<button class="${style}" data-act="${action}" ${attributes}>${text}</button>`;

function toast(message) {
  const element = document.getElementById('toast');
  element.textContent = String(message ?? '操作失败');
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, 7000);
}
function heading(title, subtitle, actions = '') {
  return `<div class="page-head"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="actions">${actions}</div></div>`;
}
function mangoEmail(status = mango.status) {
  return status?.email ?? status?.user?.email ?? status?.account?.email ?? '';
}
function mangoSignedIn(status = mango.status) {
  return Boolean(status?.authenticated ?? status?.loggedIn ?? status?.signedIn ?? status?.user ?? status?.account);
}
function mangoVerified(status = mango.status) {
  return Boolean(status?.verified ?? status?.emailVerified ?? status?.user?.verified ?? status?.user?.emailVerified ?? status?.account?.verified);
}
function normalizedSaves(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.saves) ? value.saves : [];
  return list.filter(item => item && typeof item === 'object');
}
async function refreshMango({ saves = false } = {}) {
  mango.status = await api.mangoStatus();
  mango.loaded = true;
  if (saves && mangoSignedIn()) {
    mango.saves = normalizedSaves(await api.mangoSaves());
    mango.savesLoaded = true;
  } else if (!mangoSignedIn()) {
    mango.saves = [];
    mango.savesLoaded = false;
  }
}

function renderHome() {
  const actions = button('cloud', '云存档', 'secondary') + button('import', '导入目录') + button('go-download', '＋ 下载游戏', 'primary');
  const list = state.instances.length ? state.instances.map(item => `<article class="instance"><div class="cube">${item.serverConnection ? '🌐' : '◇'}</div><div class="instance-info"><h3>${escape(item.name)}${item.serverConnection ? ` <span class="status-badge verified" style="font-size:11px;">直连: ${escape(item.serverConnection.host)}:${escape(item.serverConnection.port)}</span>` : ''}</h3><p>Minecraft ${escape(item.version)} <span class="tag">${item.serverConnection ? '服务器包' : '原版'}</span>　Java ${escape(item.javaMajor)}</p></div><div class="actions">${button('export-pack', '发布整合包', 'secondary small', `data-id="${escape(item.id)}"`)}${button('instance-folder', '文件夹', 'quiet small', `data-id="${escape(item.id)}"`)}${button('launch', state.running.includes(item.id) ? '运行中' : (item.serverConnection ? '进入服务器' : '启动游戏'), 'primary', `data-id="${escape(item.id)}" ${state.busy || state.running.includes(item.id) ? 'disabled' : ''}`)}</div></article>`).join('') :
    `<section class="empty"><div class="empty-symbol">＋</div><h3>还没有游戏实例</h3><p>下载一个原版版本，或导入已有的游戏目录<br>每个新下载的实例都有独立的存档和设置</p><div class="actions">${button('go-download', '下载游戏', 'primary')}${button('import', '导入已有目录')}</div></section>`;
  const profile = state.profile ?? state.accounts?.find(account => account.id === state.selectedAccountId)?.profile;
  return heading('我的游戏', '管理版本和实例，按自己的方式玩', actions) +
    `<div class="hero"><div><h2>${profile ? `你好，${escape(profile.name)}` : '从一个新世界开始'}</h2><p>${profile ? '选一个实例，继续你的冒险' : '先下载游戏，再创建一个离线角色就能开始体验'}</p></div><div class="hero-actions"><button class="account-pill" data-act="cloud">Mango 云存档　→</button><button class="account-pill" data-nav="accounts">${profile ? `游戏角色 · ${escape(profile.name)}` : '设置游戏角色　→'}</button></div></div>` +
    `<div class="section-title">游戏实例<span>${state.instances.length} 个实例</span></div>${list}<div class="hint-row"><span>普通模式无需接入服务器</span><span>游戏文件从官方来源下载</span><span>当前为功能预览版</span></div>`;
}
function renderDownloads() {
  const choices = versions.filter(version => version.type === versionFilter);
  if (!choices.some(version => version.id === draftVersion)) draftVersion = choices[0]?.id ?? '';
  return heading('下载游戏', '安装一个新版本，让游戏目录保持整洁', button('versions', versions.length ? '刷新版本列表' : '获取版本列表')) +
    `<div class="two-columns"><section class="panel"><h2>原版 Minecraft</h2><p>选择版本，文件会下载并校验到独立实例中</p><form id="install-form"><div class="form-grid"><label>版本类型<select id="version-type"><option value="release" ${versionFilter === 'release' ? 'selected' : ''}>正式版</option><option value="snapshot" ${versionFilter === 'snapshot' ? 'selected' : ''}>快照版</option></select></label><label>游戏版本<select id="version-select" name="version" ${!choices.length ? 'disabled' : ''}>${choices.length ? choices.map(version => `<option value="${escape(version.id)}" ${version.id === draftVersion ? 'selected' : ''}>${escape(version.id)}</option>`).join('') : '<option>先获取版本列表</option>'}</select></label></div><label>实例名称<input id="instance-name" name="name" maxlength="100" placeholder="例如：我的生存存档" value="${escape(draftName)}"></label><button type="submit" class="primary full" ${!choices.length || state.busy ? 'disabled' : ''}>${state.busy ? '正在下载…' : '下载并创建实例'}</button></form></section><section class="panel"><h2>开始之前</h2><p>下载完成后，在设置里选择游戏所需的 Java，再创建离线角色。</p><div class="note warning">Java 需要自行安装。加载器、模组和整合包功能仍在开发中。</div></section></div>`;
}
function mangoAccountPanel() {
  if (!mango.loaded) return `<section class="panel mango-panel"><h2>Mango Network</h2><p class="last">正在读取账户状态…</p></section>`;
  if (mangoSignedIn()) {
    const verified = mangoVerified();
    return `<section class="panel mango-panel"><div class="settings-row"><div><div class="eyebrow">MANGO NETWORK</div><h2>${escape(mangoEmail() || 'Mango 账户')} <span class="status-badge ${verified ? 'verified' : 'pending'}">${verified ? '已验证' : '待验证'}</span></h2><p class="last">${verified ? '邮箱已验证，可以查看云存档。' : '请使用邮件中的验证码完成邮箱验证。'}</p></div>${button('mango-logout', '登出', 'quiet')}</div>${verified ? '' : `<div class="divider"></div><form id="mango-verify-form" class="compact-form"><label>邮箱<input name="email" type="email" autocomplete="email" value="${escape(mangoEmail())}" required maxlength="254"></label><label>验证码<input name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="32" placeholder="邮件验证码"></label><button type="submit" class="primary">验证邮箱</button></form>`}</section>`;
  }
  return `<section class="panel mango-panel"><div class="eyebrow">MANGO NETWORK</div><h2>登录云服务</h2><p>登录后可查看只读云存档列表；客户端不会在渲染层状态中保存密码或令牌。</p><div class="mango-auth-grid"><form id="mango-login-form"><h3>登录</h3><label>邮箱<input name="email" type="email" autocomplete="email" required maxlength="254"></label><label>密码<input name="password" type="password" autocomplete="current-password" required minlength="8" maxlength="256"></label><button type="submit" class="primary full">登录</button></form><form id="mango-register-form"><h3>注册</h3><label>邮箱<input name="email" type="email" autocomplete="email" required maxlength="254"></label><label>密码<input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="256"></label><button type="submit" class="secondary full">注册并发送验证邮件</button></form></div></section>`;
}
function renderAccounts() {
  const profile = state.profile ?? state.accounts?.find(account => account.id === state.selectedAccountId)?.profile;
  return heading('账户', '管理 Mango Network 与本地离线角色') + mangoAccountPanel() +
    `<section class="panel"><h2>离线角色</h2><p>可用于单人游戏或接受离线角色的服务器，不会自动切换你的其他账户</p><form id="profile-form" class="offline-form"><label>角色名称<input name="name" value="${escape(profile?.name)}" placeholder="1–16 位英文字母、数字或下划线" pattern="[a-zA-Z0-9_]{1,16}" required maxlength="16"></label><button class="primary" type="submit">${profile ? '保存角色' : '创建离线角色'}</button></form></section>`;
}
function renderCloud() {
  const refresh = mangoSignedIn() ? button('mango-saves', '刷新列表') : button('go-accounts', '前往登录', 'primary');
  let body;
  if (!mango.loaded) body = '<section class="panel"><p class="last">正在读取 Mango Network 状态…</p></section>';
  else if (!mangoSignedIn()) body = '<section class="empty cloud-empty"><div class="empty-symbol">☁</div><h3>登录后查看云存档</h3><p>云存档在这里以只读方式展示，不会自动覆盖本地世界。</p><button class="primary" data-act="go-accounts">登录 Mango Network</button></section>';
  else if (!mangoVerified()) body = '<section class="empty cloud-empty"><div class="empty-symbol">✉</div><h3>请先验证邮箱</h3><p>完成邮箱验证后才能读取云存档列表。</p><button class="primary" data-act="go-accounts">前往验证</button></section>';
  else if (!mango.savesLoaded) body = '<section class="panel"><p class="last">点击“刷新列表”读取云存档。</p></section>';
  else if (!mango.saves.length) body = '<section class="empty cloud-empty"><div class="empty-symbol">☁</div><h3>还没有云存档</h3><p>此页面仅展示 Mango Network 中已有的存档。</p></section>';
  else body = `<section class="panel cloud-list" aria-label="云存档只读列表">${mango.saves.map(save => `<article class="cloud-save"><div><h3>${escape(save.name ?? save.id ?? '未命名存档')}</h3><p>ID：${escape(save.id ?? '—')}</p></div><div class="cloud-meta"><span>版本 ${escape(save.version ?? '—')}</span><span>${escape(save.size ?? save.bytes ?? '—')} bytes</span><span class="status-badge">只读</span></div></article>`).join('')}</section>`;
  return heading('Mango 云存档', '安全查看云端世界列表；当前客户端不提供修改操作', refresh) + `<div class="note read-only-note">只读状态：列表中的服务端名称、ID 和元数据均按纯文本安全显示。</div>${body}`;
}
function renderServers() {
  if (state.settings.mode !== 'server') return heading('服务器', '服务器接入是可选功能') + '<section class="empty"><h3>当前在普通模式</h3><p>需要接入时，切换右上角的使用模式。</p><button data-mode="server" class="primary">切换到服务器模式</button></section>';
  return heading('服务器', '管理可选服务器接入') + '<section class="panel"><p class="last">服务器接口管理功能保持可用。</p></section>';
}
function renderSettings() {
  return heading('设置', '选择游戏运行环境') + `<section class="panel"><div class="settings-row"><div><h2>Java 运行环境</h2><p class="last">需要与实例要求的 Java 主版本一致</p></div><div class="actions">${button('java-detect', '自动检测')}${button('java-choose', '手动选择', 'secondary')}</div></div>${state.java.map(java => `<div class="java-row"><strong>Java ${escape(java.major)}</strong><code>${escape(java.path)}</code></div>`).join('')}</section><section class="panel"><form id="memory-form" class="settings-row"><div><h2>游戏最大内存</h2><p class="last">设置上限不会立即占用所有内存</p></div><div class="actions"><input aria-label="最大内存 MB" name="memory" type="number" min="1024" max="32768" step="256" value="${escape(state.memoryMB)}" required><span class="note">MB</span><button type="submit">保存</button></div></form></section>`;
}
function renderAbout() {
  return heading('关于 LMCL', '一个还在生长的通用启动器') + `<section class="panel about"><img src="assets/avatar.png" alt="llroxy 的头像"><div><h1>LMCL</h1><div class="version">${escape(state.version)} · 功能预览</div><p class="last">通用 Minecraft Java 启动器，现已提供 Mango Network 账户和云存档只读入口。</p></div></section>`;
}
function render() {
  if (!state) return;
  const items = ['home', 'downloads', 'accounts', 'cloud', ...(state.settings.mode === 'server' ? ['servers'] : []), 'settings'];
  document.getElementById('navigation').innerHTML = items.map(key => `${key === 'settings' ? '<div class="nav-divider"></div>' : ''}<button class="nav-item ${page === key ? 'active' : ''}" data-nav="${key}">${svg(key)}${names[key]}</button>`).join('');
  document.querySelectorAll('[data-mode]').forEach(element => { const active = element.dataset.mode === state.settings.mode; element.classList.toggle('active', active); element.setAttribute('aria-pressed', String(active)); });
  document.getElementById('breadcrumb').textContent = names[page];
  document.getElementById('content').innerHTML = ({ home: renderHome, downloads: renderDownloads, accounts: renderAccounts, cloud: renderCloud, servers: renderServers, settings: renderSettings, about: renderAbout })[page]();
  renderTask();
}
function renderTask() {
  document.getElementById('taskbar').innerHTML = currentProgress ? `<span class="task-text">${escape(currentProgress.phase)}${currentProgress.total ? ` · ${escape(currentProgress.done)}/${escape(currentProgress.total)}` : ''}</span>${currentProgress.total ? `<progress value="${escape(currentProgress.done)}" max="${escape(currentProgress.total)}"></progress>` : ''}${state.busy ? button('cancel', '取消', 'quiet small') : ''}` : '<span>LMCL · 通用 Java 启动器</span><span>Mango Network 已接入</span>';
}

document.addEventListener('click', async event => {
  const element = event.target.closest('button');
  if (!element || element.disabled) return;
  if (element.dataset.nav) { page = element.dataset.nav; render(); document.getElementById('content').scrollTop = 0; return; }
  const action = element.dataset.act;
  const id = element.dataset.id;
  try {
    if (element.dataset.mode) { page = element.dataset.mode === 'server' ? 'servers' : 'home'; await api.setMode(element.dataset.mode); state = await api.getState(); render(); return; }
    if (action === 'go-download') page = 'downloads';
    if (action === 'go-accounts') page = 'accounts';
    if (action === 'cloud') page = 'cloud';
    if (['go-download', 'go-accounts', 'cloud'].includes(action)) { render(); document.getElementById('content').scrollTop = 0; }
    if (action === 'versions') { element.disabled = true; versions = await api.versions(); render(); }
    if (action === 'import') { const added = await api.importGame(); if (added?.length) { state = await api.getState(); page = 'home'; render(); toast(`已导入 ${added.length} 个原版实例`); } }
    if (action === 'launch') { element.disabled = true; await api.launch(id); toast('已启动，游戏窗口将单独打开'); }
    if (action === 'export-pack') {
      const item = state.instances.find(x => x.id === id);
      if (!item) return;
      const host = prompt('请输入服务器连接地址 (Host / IP)：', item.serverConnection?.host || 'play.mangomc.top');
      if (!host) return;
      const portStr = prompt('请输入服务器端口 (Port)：', String(item.serverConnection?.port || 25565));
      if (!portStr) return;
      const port = parseInt(portStr, 10);
      const outName = `${item.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_server_pack.zip`;
      const archivePath = `${state.dataRoot}/${outName}`;
      toast('正在打包并排除敏感单人存档，请稍候…');
      try {
        await api.exportServerPack({
          instanceId: id,
          archivePath,
          packId: `pack_${Date.now()}`,
          name: item.name,
          version: item.version,
          serverConnection: { host: host.trim(), port }
        });
        toast(`整合包打包成功！已保存到：${outName}`);
      } catch (err) {
        toast(`导出失败：${err.message}`);
      }
      return;
    }
    if (action === 'instance-folder') await api.openGameFolder(id);
    if (action === 'cancel') await api.cancel();
    if (action === 'java-detect') { const found = await api.discoverJava(); toast(found.length ? `找到 ${found.length} 个 Java 环境` : '未找到 Java'); }
    if (action === 'java-choose') await api.chooseJava();
    if (action === 'mango-logout') { await api.logoutMango(); mango = { loaded: false, status: null, saves: [], savesLoaded: false }; await refreshMango(); render(); toast('已退出 Mango Network'); }
    if (action === 'mango-saves') { element.disabled = true; await refreshMango({ saves: true }); render(); }
  } catch (error) { toast(error?.message); render(); }
});
document.addEventListener('change', event => {
  if (event.target.id === 'version-type') { versionFilter = event.target.value; draftVersion = ''; render(); }
  if (event.target.id === 'version-select') draftVersion = event.target.value;
});
document.addEventListener('input', event => { if (event.target.id === 'instance-name') draftName = event.target.value; });
document.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const submit = form.querySelector('[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    if (form.id === 'mango-login-form' || form.id === 'mango-register-form') {
      const email = form.elements.email.value;
      const password = form.elements.password.value;
      form.elements.password.value = '';
      if (form.id === 'mango-login-form') await api.loginMango(email, password);
      else await api.registerMango(email, password);
      await refreshMango();
      render();
      toast(form.id === 'mango-login-form' ? 'Mango Network 登录成功' : '验证邮件已发送，请查收邮箱');
      return;
    }
    const data = new FormData(form);
    if (form.id === 'mango-verify-form') { await api.verifyMango(data.get('email'), data.get('code')); await refreshMango(); render(); toast('邮箱验证成功'); return; }
    if (form.id === 'profile-form') { await api.saveProfile(data.get('name')); toast('离线角色已保存'); }
    if (form.id === 'memory-form') { await api.saveMemory(Number(data.get('memory'))); toast('内存设置已保存'); }
    if (form.id === 'install-form') { const entry = await api.install({ version: data.get('version'), name: data.get('name') }); page = 'home'; draftName = ''; state = await api.getState(); render(); toast(`${entry.name} 已下载完成`); }
  } catch (error) { toast(error?.message); }
  finally {
    const password = form.querySelector('input[type="password"]');
    if (password) password.value = '';
    if (submit?.isConnected) submit.disabled = false;
  }
});

api.onState(value => { state = value; render(); });
api.onProgress(value => { currentProgress = value; renderTask(); });
try {
  [state] = await Promise.all([api.getState(), refreshMango().catch(error => { mango.loaded = true; mango.status = null; toast(error?.message); })]);
  render();
  window.__ready = true;
} catch (error) {
  document.getElementById('content').textContent = `配置读取失败：${error?.message ?? '未知错误'}`;
}
