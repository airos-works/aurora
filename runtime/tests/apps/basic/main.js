// Exercises the runtime the way pgAdmin does: named and default ESM imports,
// a preload with contextBridge, invoke/send/on, executeJavaScript, quitting.
import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import electron from 'electron';
import assert from 'assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const results = {};
const timer = setTimeout(() => fail(new Error(`timed out: ${JSON.stringify(results)}`)), 15000);

function fail(error) {
  console.log(`FAIL ${error.stack || error}`);
  app.exit(1);
}

ipcMain.handle('ping', (event, value) => ({ pong: value, when: new Date(0), bytes: new Uint8Array([1, 2, 3]), sender: event.sender.id }));
ipcMain.handle('fail', () => { throw new Error('nope'); });
ipcMain.on('ready-for-message', (event) => event.sender.send('from-main', 'hello', 42));
ipcMain.on('report', (event, report) => {
  try {
    assert.equal(report.hasApi, true);
    assert.equal(report.pong, 'x');
    assert.equal(report.date, true);
    assert.equal(report.bytes, true);
    assert.equal(report.fail, true);
    assert.deepEqual(report.message, ['hello', 42]);
    assert.equal(report.helper, 'helper');
    assert.equal(report.platform, 'haiku' === process.platform ? 'haiku' : process.platform);
    assert.equal(results.readyToShow, true);
    assert.deepEqual(results.exec.list, [1, null, undefined]);
    assert.equal(results.exec.title, 'Basic Test');
    assert.equal(results.title, 'Basic Test');
    assert.equal(app.getName(), 'Aurora Basic Test');
    assert.equal(app.getVersion(), '1.2.3');
    assert.equal(process.versions.electron, '43.4.0');
    assert.equal(electron.app, app);
    clearTimeout(timer);
    console.log('PASS');
    app.quit();
  } catch (error) {
    fail(error);
  }
});

app.on('quit', () => console.log('quit event'));

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'File', submenu: [{ role: 'quit' }] }]));
  const window = new BrowserWindow({ show: false, width: 640, height: 480,
    webPreferences: { preload: path.join(directory, 'preload.js') } });
  window.once('ready-to-show', () => {
    results.readyToShow = true;
    window.show();
  });
  window.webContents.on('did-finish-load', async () => {
    results.title = window.getTitle();
    results.exec = await window.webContents.executeJavaScript('({ a: 1, list: [1, null, undefined], title: document.title })');
  });
  await window.loadFile('index.html');
}).catch(fail);
