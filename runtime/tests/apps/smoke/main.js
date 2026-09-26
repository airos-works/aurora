// A window with visible content and an app menu, for looking at by hand or
// driving with AURORA_REPL. Stays open until closed.
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: async (item, window) => {
        const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Text', extensions: ['txt', 'md'] }] });
        console.log('open dialog:', JSON.stringify(result));
      } },
      { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { label: 'Help', submenu: [
      { label: 'About Aurora Smoke', click: async (item, window) => {
        const result = await dialog.showMessageBox(window, { type: 'info', title: 'About', message: 'Aurora Smoke',
          detail: `Electron ${process.versions.electron} emulated on Node ${process.versions.node}`, buttons: ['OK', 'Website'] });
        if (result.response === 1)
          shell.openExternal('https://www.haiku-os.org');
      } },
      { label: 'Checked', type: 'checkbox', checked: true, click: (item) => console.log('checkbox now', item.checked) },
    ] },
  ]));
  createWindow();
});

function createWindow() {
  const window = new BrowserWindow({ width: 800, height: 600, backgroundColor: '#f4f1ea' });
  window.webContents.on('context-menu', (event, params) => console.log('context-menu at', params.x, params.y, params.selectionText));
  window.loadFile(path.join(__dirname, 'page.html'));
  return window;
}
