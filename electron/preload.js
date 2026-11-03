const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set([
  'notify:click',
  'badge',
  'game:result',
  'chat:visible',
  'update:status'
]);

contextBridge.exposeInMainWorld('deco', {
  getProfile: () => ipcRenderer.invoke('profile:get'),
  saveProfile: (patch) => ipcRenderer.invoke('profile:save', patch),
  readHistory: (pair) => ipcRenderer.invoke('history:read', pair),
  saveHistory: (pair, messages) => ipcRenderer.invoke('history:save', pair, messages),
  beginDrag: () => ipcRenderer.send('drag:begin'),
  hideGame: () => ipcRenderer.invoke('game:hide'),
  toggleChat: () => ipcRenderer.invoke('chat:toggle'),
  showChat: () => ipcRenderer.invoke('chat:show'),
  snap: () => ipcRenderer.invoke('window:snap'),
  popupMenu: () => ipcRenderer.send('menu:popup'),
  expandBar: (on) => ipcRenderer.send('bar:expand', !!on),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  notify: (payload) => ipcRenderer.send('notify', payload),
  badge: (payload) => ipcRenderer.send('badge', payload),
  version: () => ipcRenderer.invoke('app:version'),
  hashPassword: (pseudo, password) => ipcRenderer.invoke('crypto:password-hash', { pseudo, password }),
  startHost: (roomCode) => ipcRenderer.invoke('host:start', roomCode),
  stopHost: () => ipcRenderer.invoke('host:stop'),
  hostInfo: () => ipcRenderer.invoke('host:info'),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  on: (channel, callback) => {
    if (!CHANNELS.has(channel)) return () => {};
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
