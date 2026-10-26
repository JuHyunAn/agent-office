'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('office', {
  status: () => ipcRenderer.invoke('app:status'),
  getWeather: () => ipcRenderer.invoke('weather:current'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  createPty: (opts) => ipcRenderer.invoke('pty:create', opts),
  writePty: (tabId, data) => ipcRenderer.send('pty:write', { tabId, data }),
  resizePty: (tabId, cols, rows) => ipcRenderer.send('pty:resize', { tabId, cols, rows }),
  killPty: (tabId) => ipcRenderer.invoke('pty:kill', { tabId }),
  setGlobalHooks: (enabled) => ipcRenderer.invoke('hooks:global:set', { enabled }),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  onHookEvent: on('hook:event'),
  onPtyData: on('pty:data'),
  onPtyExit: on('pty:exit'),
});
