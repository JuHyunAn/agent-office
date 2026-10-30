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
  collabSend: (opts) => ipcRenderer.invoke('collab:send', opts),
  collabStop: (roomId, agent) => ipcRenderer.invoke('collab:stop', { roomId, agent }),
  collabSteer: (roomId, agent, text, turn) => ipcRenderer.invoke('collab:steer', { roomId, agent, text, turn }),
  collabClose: (roomId) => ipcRenderer.invoke('collab:close', { roomId }),
  collabModels: () => ipcRenderer.invoke('collab:models'),
  petState: (payload) => ipcRenderer.send('pet:state', payload),
  petFocus: (focus) => ipcRenderer.send('pet:focus', focus),
  setPetMode: (mode) => ipcRenderer.invoke('pet:mode:set', { mode }),
  petsList: () => ipcRenderer.invoke('pets:list'),
  petsPreview: (key) => ipcRenderer.invoke('pets:preview', key),
  petsImport: (kind) => ipcRenderer.invoke('pets:import', kind),
  petsRemove: (key) => ipcRenderer.invoke('pets:remove', key),
  petsSelect: (kind, value) => ipcRenderer.invoke('pets:select', { kind, value }),
  onPetsChanged: on('pets:changed'),
  onPetActivate: on('pet:activate'),
  onPetMode: on('pet:mode'),
  onPermClosed: on('perm:closed'),
  onCollabEvent: on('collab:event'),
  onHookEvent: on('hook:event'),
  onPtyData: on('pty:data'),
  onPtyExit: on('pty:exit'),
});
