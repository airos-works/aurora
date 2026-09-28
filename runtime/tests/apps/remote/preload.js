'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const Module = require('module');
const { contextBridge, ipcRenderer } = require('electron');

const file = path.join(os.tmpdir(), 'aurora-remote-test.txt');
const report = {};
try {
  report.argv = process.argv.slice(1);
  report.home = os.homedir();
  report.env = typeof process.env.HOME;
  fs.writeFileSync(file, 'hello from the page');
  report.read = fs.readFileSync(file, 'utf8');
  report.bytes = fs.readFileSync(file).length;
  report.isDirectory = fs.statSync(os.tmpdir()).isDirectory();
  report.hash = crypto.createHash('sha256').update('abc').digest('hex');
  const module = new Module(__filename);
  module.paths = Module._nodeModulePaths(__dirname);
  report.modulePaths = Array.isArray(module.paths) && module.paths.length > 0;
  try {
    fs.readFileSync(path.join(os.tmpdir(), 'no-such-file-here'));
  } catch (error) {
    report.missing = error.code;
  }
  report.constructorBlocked = fs.readFileSync.constructor === undefined;
} catch (error) {
  report.error = String(error && error.stack || error);
}

contextBridge.exposeInMainWorld('testApi', {
  read: () => fs.readFileSync(file, 'utf8'),
  finish: (page) => {
    report.page = page;
    childProcess.exec('echo remote', (error, stdout) => {
      report.exec = error ? String(error) : stdout.trim();
      fs.promises.readFile(file, 'utf8').then((text) => {
        report.promise = text;
        ipcRenderer.send('report', report);
      }, (error) => {
        report.error = String(error);
        ipcRenderer.send('report', report);
      });
    });
  },
});
