import { app, BrowserWindow, ipcMain, dialog, shell, screen } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, rename, mkdtemp, open, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createOfflineProfile } from '../core/src/accounts.mjs';
import { launcherSettings, switchLauncherMode, serverProvider } from '../core/src/server-mode.mjs';
import { versionCatalog, installVanilla, importDirectory, readMetadata } from './lib/minecraft.mjs';
import { searchContent, projectVersions, projectVersion } from './lib/modrinth.mjs';
import { installContentFile, downloadModpack, importContent, importFromLink } from './lib/content-install.mjs';
import { normalizeDownloadMode } from '../core/src/download-source.mjs';
import { contentKind, hasCatalogue, installsAsInstance } from '../core/src/content.mjs';
import { launchArguments } from './lib/minecraft-rules.mjs';
import { discoverJava, inspectJava } from './lib/java.mjs';
import { getJSON } from './lib/network.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const documentURL = pathToFileURL(path.join(directory, 'index.html')).href;
const smoke = process.argv.includes('--smoke-test');
if (smoke) app.disableHardwareAcceleration();
let window, state, stateFile, dataRoot, task, javaCache;
const running = new Map();
const launching = new Set();
// 镜像失败后的短期冷却，避免每次下载都先撞一次墙。
const sourceHealth = new Map();
let saveQueue = Promise.resolve();
app.setName('LMCL');
app.setAppUserModelId('io.github.llroxy-by.lmcl');
if (!smoke && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { window?.show(); window?.focus(); });

function persist() {
  const content = JSON.stringify(state, null, 2);
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    await writeFile(`${stateFile}.tmp`, content, { mode: 0o600 });
    await rename(`${stateFile}.tmp`, stateFile);
  });
  return saveQueue;
}
function snapshot() {
  return { ...structuredClone(state), version: app.getVersion(), platform: process.platform, arch: process.arch,
    dataRoot, running: [...running.keys()], busy: Boolean(task), java: javaCache ?? [] };
}
function notify() { if (window && !window.isDestroyed()) window.webContents.send('state', snapshot()); }
function progress(value) { if (window && !window.isDestroyed()) window.webContents.send('progress', value); }
function instance(id) {
  const entry = state.instances.find(item => item.id === id);
  if (!entry) throw new Error('未找到这个实例');
  return entry;
}
function register(name, callback) {
  ipcMain.handle(name, async (event, ...args) => {
    let sameDocument = false;
    try {
      // Windows portable extraction may use a short (8.3) temp path while
      // Chromium reports its long equivalent. Compare actual local files.
      sameDocument = realpathSync(fileURLToPath(event.senderFrame.url)) === realpathSync(fileURLToPath(documentURL));
    } catch { /* Reject non-file frames and missing documents. */ }
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !sameDocument) {
      throw new Error('请求来源无效');
    }
    try { return { ok: true, value: await callback(...args) }; }
    catch (error) {
      return { ok: false, error: error.name === 'AbortError' ? '操作已取消' : error.message || '操作失败，请重试' };
    }
  });
}

function registerHandlers() {
  register('state:get', () => snapshot());
  register('profile:save', async name => {
    state.profile = createOfflineProfile(name); await persist(); notify(); return state.profile;
  });
  register('mode:set', async mode => {
    state.settings = switchLauncherMode(state.settings, mode); await persist(); notify();
  });
  register('provider:add', async input => {
    const provider = serverProvider(input);
    if (state.settings.providers.some(item => item.id.toLowerCase() === provider.id.toLowerCase())) throw new Error('已有同名的接入方 ID');
    state.settings = launcherSettings({ ...state.settings, providers: [...state.settings.providers, provider] });
    await persist(); notify();
  });
  register('provider:remove', async id => {
    state.settings.providers = state.settings.providers.filter(provider => provider.id !== id); await persist(); notify();
  });
  register('provider:catalog', async id => {
    if (state.settings.mode !== 'server') throw new Error('请先切换到服务器模式');
    const provider = state.settings.providers.find(item => item.id === id);
    if (!provider?.enabled) throw new Error('接入方未启用');
    const data = await getJSON(new URL('v1/servers', provider.apiRoot).href);
    if (data.schemaVersion !== 1 || !Array.isArray(data.servers) || data.servers.length > 500) throw new Error('接口目录格式不符合 v1 约定');
    return data.servers.map(server => ({ id: String(server.id).slice(0, 128), name: String(server.name).slice(0, 200),
      status: server.status && ['online', 'offline', 'unknown', 'maintenance'].includes(server.status.state) ? {
        state: server.status.state,
        online: Number.isSafeInteger(server.status.online) && server.status.online >= 0 ? server.status.online : null,
        max: Number.isSafeInteger(server.status.max) && server.status.max >= 0 ? server.status.max : null,
      } : { state: 'unknown', online: null, max: null },
    }));
  });
  register('java:discover', async () => { javaCache = await discoverJava(state.javaPath); notify(); return javaCache; });
  register('java:choose', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择 Java 可执行文件', properties: ['openFile'],
      ...(process.platform === 'win32' ? { filters: [{ name: 'Java', extensions: ['exe'] }] } : {}) });
    if (result.canceled) return;
    const file = result.filePaths[0];
    if (!/^java(?:\.exe)?$/i.test(path.basename(file))) throw new Error('请选择 bin 目录中的 java.exe（或 java）');
    const java = await inspectJava(file);
    state.javaPath = file; javaCache = [java]; await persist(); notify(); return java;
  });
  register('memory:save', async memory => {
    if (!Number.isInteger(memory) || memory < 1024 || memory > 32768) throw new Error('内存范围为 1024–32768 MB');
    state.memoryMB = memory; await persist(); notify();
  });
  register('versions:list', async () => (await versionCatalog()).map(({ id, type, releaseTime }) => ({ id, type, releaseTime })));
  register('game:install', async ({ version, name }) => {
    if (task) throw new Error('请等待当前下载结束，或先取消下载');
    if (typeof version !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(version) || typeof name !== 'string' || name.length > 100) throw new Error('版本或名称无效');
    task = new AbortController(); notify();
    try {
      const entry = await installVanilla({ version, name, gamesRoot: path.join(dataRoot, 'instances'), signal: task.signal, onProgress: progress });
      state.instances.push(entry); await persist(); return entry;
    } finally { task = null; progress(null); notify(); }
  });
  register('game:cancel', () => { task?.abort(); });
  register('game:import', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择包含 versions 的游戏目录', properties: ['openDirectory'] });
    if (result.canceled) return [];
    const entries = await importDirectory(result.filePaths[0]);
    const added = entries.filter(entry => !state.instances.some(old => old.root === entry.root && old.version === entry.version));
    state.instances.push(...added); await persist(); notify(); return added;
  });
  register('game:folder', async id => {
    const result = await shell.openPath(instance(id).root);
    if (result) throw new Error(result);
  });
  register('game:launch', async id => {
    if (task) throw new Error('请先等待下载完成');
    if (!state.profile) throw new Error('请先在账户页创建离线角色');
    if (running.has(id) || launching.has(id)) throw new Error('这个实例已经在启动或运行');
    launching.add(id);
    try {
    const entry = instance(id), metadata = await readMetadata(entry);
    await access(path.join(entry.root, 'versions', entry.version, `${entry.version}.jar`)).catch(() => { throw new Error('缺少游戏 jar 文件，请重新下载完整版本'); });
    const available = await discoverJava(state.javaPath);
    javaCache = available;
    const required = metadata.javaVersion?.majorVersion ?? entry.javaMajor;
    const java = available.find(item => item.major === required);
    if (!java) throw new Error(`这个版本需要 Java ${required}${process.platform === 'darwin' ? '（ARM64 / AArch64）' : ''}，请安装后在设置页检测或选择`);
    const args = launchArguments(metadata, { root: entry.root, profile: createOfflineProfile(state.profile.name), memoryMB: state.memoryMB });
    const log = await open(path.join(entry.root, 'lmcl-game.log'), 'w');
    try {
      const child = spawn(java.path, args, { cwd: entry.root, shell: false, windowsHide: true, detached: false, stdio: ['ignore', log.fd, log.fd] });
      // Reserve before waiting for spawn so repeated clicks cannot launch twice.
      running.set(id, child);
      child.once('exit', code => { running.delete(id); progress({ phase: code === 0 ? '游戏已退出' : `游戏已退出（${code}），可在实例文件夹查看 lmcl-game.log`, done: 0, total: 0 }); notify(); });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      notify(); return { started: true };
    } catch (error) { running.delete(id); throw error; }
    finally { await log.close(); }
    } finally { launching.delete(id); }
  });
  register('content:search', async input => {
    const kind = contentKind(input?.kind);
    if (!hasCatalogue(kind)) throw new Error('这个分类没有可浏览的公共目录，请用链接或本地文件导入');
    return searchContent({ kind, query: input?.query, gameVersion: input?.gameVersion,
      loader: input?.loader, offset: input?.offset, limit: input?.limit });
  });
  register('content:versions', async input => {
    const kind = contentKind(input?.kind);
    if (!hasCatalogue(kind)) throw new Error('这个分类没有可浏览的公共目录');
    return projectVersions({ projectId: input?.projectId, kind,
      gameVersion: input?.gameVersion, loader: input?.loader });
  });
  // 下载任务串行执行：同一时刻只允许一个下载，避免进度条互相覆盖。
  register('content:install', async input => {
    if (task) throw new Error('请等待当前下载结束，或先取消下载');
    const kind = contentKind(input?.kind);
    if (installsAsInstance(kind)) throw new Error('整合包请用整合包下载');
    const entry = instance(input?.instanceId);
    task = new AbortController(); notify();
    try {
      const file = await projectVersion({ projectId: input?.projectId, versionId: input?.versionId, kind });
      return await installContentFile({ kind, instanceRoot: entry.root, file,
        mode: state.downloadMode, mirrorBase: state.contentMirror, health: sourceHealth,
        signal: task.signal, onProgress: progress });
    } finally { task = null; progress(null); notify(); }
  });
  register('content:modpack', async input => {
    if (task) throw new Error('请等待当前下载结束，或先取消下载');
    if (contentKind(input?.kind) !== 'modpack') throw new Error('仅适用于整合包');
    task = new AbortController(); notify();
    try {
      const file = await projectVersion({ projectId: input?.projectId, versionId: input?.versionId, kind: 'modpack' });
      return await downloadModpack({ dataRoot, file, mode: state.downloadMode, mirrorBase: state.contentMirror,
        health: sourceHealth, signal: task.signal, onProgress: progress });
    } finally { task = null; progress(null); notify(); }
  });
  register('content:import', async input => {
    if (task) throw new Error('请等待当前下载结束，或先取消下载');
    const kind = contentKind(input?.kind);
    const filters = { mod: ['jar'], modpack: ['mrpack', 'zip'], resourcepack: ['zip'], shader: ['zip'], schematic: ['litematic', 'schem', 'nbt'] }[kind];
    const picked = await dialog.showOpenDialog(window, { title: '选择要导入的文件', properties: ['openFile'],
      filters: [{ name: kind, extensions: filters }] });
    if (picked.canceled) return null;
    return importContent({ kind, sourcePath: picked.filePaths[0],
      instanceRoot: installsAsInstance(kind) ? '' : instance(input?.instanceId).root, dataRoot });
  });
  register('content:link', async input => {
    if (task) throw new Error('请等待当前下载结束，或先取消下载');
    const kind = contentKind(input?.kind);
    const entry = instance(input?.instanceId);
    task = new AbortController(); notify();
    try {
      return await importFromLink({ kind, instanceRoot: entry.root, url: input?.url,
        fileName: input?.fileName, signal: task.signal, onProgress: progress });
    } finally { task = null; progress(null); notify(); }
  });
  register('download:save', async input => {
    const mode = normalizeDownloadMode(input?.mode);
    const mirror = typeof input?.contentMirror === 'string' ? input.contentMirror.trim() : '';
    if (mirror && !/^https:\/\/[^\s]+$/.test(mirror)) throw new Error('镜像地址必须是 https 链接');
    state.downloadMode = mode; state.contentMirror = mirror;
    await persist(); notify(); return { downloadMode: mode, contentMirror: mirror };
  });
  register('data:folder', async () => { const result = await shell.openPath(dataRoot); if (result) throw new Error(result); });
  register('bedrock:open', async () => {
    if (process.platform !== 'win32') throw new Error('此入口仅适用于 Windows');
    await shell.openExternal('minecraft://');
  });
}

async function smokeTest() {
  const output = process.env.LMCL_SMOKE_OUT || path.join(process.cwd(), 'smoke-output');
  await mkdir(output, { recursive: true });
  const timer = setTimeout(() => { app.exit(1); }, 60000);
  try {
    const result = await window.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 10000;
      while (!window.__ready && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      if (!window.__ready) throw new Error('UI failed to initialize');
      await window.lmcl.saveProfile('LMCL_Test');
      await window.lmcl.setMode('server');
      let state = await window.lmcl.getState();
      if (state.settings.mode !== 'server' || state.settings.providers.length) throw new Error('Server mode isolation failed');
      await window.lmcl.setMode('normal');
      state = await window.lmcl.getState();
      if (state.profile.name !== 'LMCL_Test') throw new Error('Profile lost during mode switch');
      if (!document.querySelector('.avatar').complete || !document.querySelector('.avatar').naturalWidth) throw new Error('Avatar did not load');
      return { title: document.title, mode: state.settings.mode, profile: state.profile.name, providers: state.settings.providers.length };
    })()`);
    await new Promise(resolve => setTimeout(resolve, 500));
    await writeFile(path.join(output, 'home.png'), (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`document.querySelector('[data-nav="downloads"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 300));
    await writeFile(path.join(output, 'downloads.png'), (await window.webContents.capturePage()).toPNG());
    const layouts = [];
    for (const size of [[window.getBounds().width, window.getBounds().height], window.getMinimumSize()]) {
      window.setSize(...size);
      await new Promise(resolve => setTimeout(resolve, 200));
      for (const page of ['home', 'downloads', 'accounts', 'settings', 'about']) {
        const layout = await window.webContents.executeJavaScript(`(() => {
          document.getElementById('content').scrollTop = 10000;
          document.querySelector('[data-nav="${page}"]').click();
          const content = document.getElementById('content');
          const footer = document.getElementById('taskbar').getBoundingClientRect();
          return { page: '${page}', width: innerWidth, height: innerHeight,
            overflow: Math.max(document.documentElement.scrollWidth - innerWidth, content.scrollWidth - content.clientWidth),
            footerVisible: footer.top >= 0 && footer.bottom <= innerHeight + 1,
            scrollTop: content.scrollTop };
        })()`);
        if (layout.overflow > 1 || !layout.footerVisible || layout.scrollTop !== 0) throw new Error(`Compact layout overflow: ${JSON.stringify(layout)}`);
        layouts.push(layout);
        if (page === 'home' || page === 'downloads') {
          await new Promise(resolve => setTimeout(resolve, 160));
          await writeFile(path.join(output, `${page}-small.png`), (await window.webContents.capturePage()).toPNG());
        }
      }
    }
    const java = await discoverJava();
    if (process.platform === 'darwin' && java.some(item => item.arch !== 'arm64')) throw new Error('Non-ARM Java discovered on Mac');
    await writeFile(path.join(output, 'smoke.json'), JSON.stringify({ ok: true, platform: process.platform, arch: process.arch, version: app.getVersion(), java, ...result, layouts }, null, 2));
    clearTimeout(timer); app.exit(0);
  } catch (error) {
    await writeFile(path.join(output, 'smoke-error.txt'), error.stack || String(error));
    try {
      const details = await window.webContents.executeJavaScript(`JSON.stringify({url:location.href,text:document.body.innerText,bridge:typeof window.lmcl})`);
      await writeFile(path.join(output, 'smoke-page.json'), details);
      await writeFile(path.join(output, 'error.png'), (await window.webContents.capturePage()).toPNG());
    } catch { /* Preserve the original failure report. */ }
    clearTimeout(timer); app.exit(1);
  }
}

app.whenReady().then(async () => {
  if (smoke) app.setPath('userData', await mkdtemp(path.join(os.tmpdir(), 'lmcl-smoke-')));
  dataRoot = app.getPath('userData'); stateFile = path.join(dataRoot, 'launcher.json');
  await mkdir(dataRoot, { recursive: true });
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('配置文件无法读取，请备份后检查 launcher.json');
    state = { schemaVersion: 1, settings: launcherSettings(), profile: null, instances: [], javaPath: '', memoryMB: 4096,
      downloadMode: 'auto', contentMirror: '' };
  }
  state.settings = launcherSettings(state.settings);
  if (!Array.isArray(state.instances)) throw new Error('实例列表格式无效');
  // 旧配置没有下载源字段，补默认值；坏值退回自动，避免直接打不开启动器。
  try { state.downloadMode = normalizeDownloadMode(state.downloadMode); } catch { state.downloadMode = 'auto'; }
  if (typeof state.contentMirror !== 'string') state.contentMirror = '';
  const area = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(960, area.width - 32), height = Math.min(660, area.height - 32);
  window = new BrowserWindow({ width, height, minWidth: Math.min(820, width), minHeight: Math.min(560, height),
    title: 'LMCL', backgroundColor: '#f5f6fa', show: !smoke, autoHideMenuBar: true,
    webPreferences: { preload: path.join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.on('render-process-gone', () => { if (smoke) app.exit(1); });
  registerHandlers();
  await window.loadFile(path.join(directory, 'index.html'));
  if (smoke) await smokeTest();
}).catch(error => {
  if (!smoke) dialog.showErrorBox('LMCL 启动失败', error.message);
  console.error(error); app.exit(1);
});
app.on('window-all-closed', () => { task?.abort(); app.quit(); });
