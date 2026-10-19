'use strict';

// A page with nodeIntegration and no contextIsolation has Node.js in its
// own scripts, as webpack's electron-renderer bundles expect (GitHub
// Desktop's renderer is one).
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const timer = setTimeout(() => {
  console.log('FAIL timed out');
  app.exit(1);
}, 60000);

ipcMain.on('report', (event, report) => {
  clearTimeout(timer);
  const failures = Object.entries(report).filter(([, value]) => value !== true);
  if (failures.length) {
    console.log(`FAIL ${JSON.stringify(Object.fromEntries(failures), null, 2)}`);
    app.exit(1);
    return;
  }
  console.log(`PASS ${Object.keys(report).length} checks`);
  app.quit();
});

ipcMain.on('timing', (event, text) => console.log(text));

app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 500, height: 300, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  window.loadFile(path.join(__dirname, 'index.html'));
});
