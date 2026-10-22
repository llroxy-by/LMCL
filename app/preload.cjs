const { contextBridge, ipcRenderer } = require('electron');
const invoke = channel => async (...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const listen = channel => callback => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('lmcl', {
  getState: invoke('state:get'), saveProfile: invoke('profile:save'), setMode: invoke('mode:set'),
  addProvider: invoke('provider:add'), removeProvider: invoke('provider:remove'), catalog: invoke('provider:catalog'),
  discoverJava: invoke('java:discover'), chooseJava: invoke('java:choose'), saveMemory: invoke('memory:save'),
  versions: invoke('versions:list'), install: invoke('game:install'), cancel: invoke('game:cancel'),
  searchContent: invoke('content:search'), contentVersions: invoke('content:versions'),
  installContent: invoke('content:install'), downloadModpack: invoke('content:modpack'),
  importContent: invoke('content:import'), importLink: invoke('content:link'),
  saveDownload: invoke('download:save'),
  importGame: invoke('game:import'), openGameFolder: invoke('game:folder'), launch: invoke('game:launch'),
  openData: invoke('data:folder'), openBedrock: invoke('bedrock:open'),
  onState: listen('state'), onProgress: listen('progress'),
});
