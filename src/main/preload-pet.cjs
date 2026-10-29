'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('pet', {
  onState: on('pet:state'),
  onUsage: on('pet:usage'),
  usageRefresh: () => ipcRenderer.send('pet:usage:refresh'),
  usageToggle: (expanded) => ipcRenderer.send('pet:usage:toggle', !!expanded),
  hover: (b) => ipcRenderer.send('pet:hover', !!b),
  drag: (phase) => ipcRenderer.send('pet:drag', phase),
  size: (width, height) => ipcRenderer.send('pet:size', { width, height }),
  open: (key, tabId) => ipcRenderer.send('pet:open', { key, tabId }),
  sprite: (kind, key) => ipcRenderer.invoke('pet:sprite', { kind, key }),
  answer: (permId, decision) => ipcRenderer.send('pet:perm', { permId, decision }),
});
