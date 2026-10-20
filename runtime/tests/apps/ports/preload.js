// tests/message-ports.test.js: the page gets ipcRenderer, as VS Code's
// preload hands ports to its page with window.postMessage.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ipc', {
  on: (channel, listener) => ipcRenderer.on(channel, listener),
  postMessage: (channel, message, transfer) => ipcRenderer.postMessage(channel, message, transfer),
});
