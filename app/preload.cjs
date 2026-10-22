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
  importGame: invoke('game:import'), openGameFolder: invoke('game:folder'), launch: invoke('game:launch'),
  openData: invoke('data:folder'), exportServerPack: invoke('pack:export'), installServerPack: invoke('server:install'), openBedrock: invoke('bedrock:open'),
  registerMango: invoke('mango:register'), verifyMango: invoke('mango:verify'), loginMango: invoke('mango:login'),
  logoutMango: invoke('mango:logout'), mangoStatus: invoke('mango:status'), mangoSaves: invoke('mango:saves'),
  onState: listen('state'), onProgress: listen('progress'),
});
