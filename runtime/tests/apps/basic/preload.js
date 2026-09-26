const { contextBridge, ipcRenderer } = require('electron/renderer');
const helper = require('./helper.js');

contextBridge.exposeInMainWorld('api', {
  ping: (value) => ipcRenderer.invoke('ping', value),
  fail: () => ipcRenderer.invoke('fail'),
  ready: () => ipcRenderer.send('ready-for-message'),
  report: (report) => ipcRenderer.send('report', { ...report, helper: helper.name, platform: process.platform }),
  onMessage: (callback) => ipcRenderer.on('from-main', (_event, ...args) => callback(...args)),
});
