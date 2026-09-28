'use strict';

// A preload without Electron's sandbox has all of Node.js; Aurora serves it
// from the main process (lib/electron/remote.js).
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const path = require('path');

const timer = setTimeout(() => {
  console.log('FAIL timed out');
  app.exit(1);
}, 30000);

ipcMain.on('report', (event, report) => {
  try {
    assert.strictEqual(report.error, undefined, report.error);
    assert.deepStrictEqual(report.argv, ['--aurora-test=1']);
    assert.strictEqual(report.read, 'hello from the page');
    assert.strictEqual(report.isDirectory, true);
    assert.strictEqual(report.hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.strictEqual(report.bytes, 19);
    assert.strictEqual(report.modulePaths, true);
    assert.strictEqual(report.home, typeof report.home === 'string' && report.home.length > 0 ? report.home : null);
    assert.strictEqual(report.env, 'string');
    assert.strictEqual(report.exec, 'remote');
    assert.strictEqual(report.promise, 'hello from the page');
    assert.strictEqual(report.missing, 'ENOENT');
    assert.strictEqual(report.page, 'hello from the page');
    assert.strictEqual(report.constructorBlocked, true);
    clearTimeout(timer);
    console.log('PASS');
    app.quit();
  } catch (error) {
    console.log(`FAIL ${error.message}\n${JSON.stringify(report, null, 2)}`);
    app.exit(1);
  }
});

app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 500, height: 300, webPreferences: {
    sandbox: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js'),
    additionalArguments: ['--aurora-test=1'] } });
  window.loadFile(path.join(__dirname, 'index.html'));
});
