'use strict';

// State shared by the electron module's parts: the host connection, the
// registries of windows and web contents, and what the host told us at start.

const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');

const state = {
  host: null,
  ready: false,
  readyInfo: null,
  readyPromise: null,
  resolveReady: null,
  windows: new Map(),       // id -> BrowserWindow
  webContents: new Map(),   // id -> WebContents
  nextWindowId: 1,
  appInfo: {
    name: 'Electron',
    productName: null,
    version: '0.0.0',
    appPath: process.cwd(),
    electronVersion: '43.0.0',
    chromeVersion: '150.0.0.0',
    packaged: true,
  },
  screens: [],
  darkMode: false,
  clipboard: { text: '', html: '' },
  paths: {},
  focusedWindowId: null,
  applicationMenu: null,
  protocols: new Map(),     // scheme -> handler (protocol.handle)
  privilegedSchemes: new Map(),
  userAgentFallback: null,
};

state.readyPromise = new Promise((resolve) => {
  state.resolveReady = resolve;
});

// A small preventable event, as Electron passes to listeners.
function createEvent(extra = {}) {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...extra,
  };
  return event;
}

function home() {
  return process.env.HOME || os.homedir() || '/boot/home';
}

function defaultUserAgent() {
  const info = state.appInfo;
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  // pgAdmin and others match /Electron\/([\d.]+\d+)/, and must not see "Mac".
  return `Mozilla/5.0 (Haiku ${arch}) AppleWebKit/605.1.15 (KHTML, like Gecko) `
    + `${(info.productName || info.name).replace(/\s+/g, '')}/${info.version} `
    + `Chrome/${info.chromeVersion} Electron/${info.electronVersion} Version/26.0 Safari/605.1.15`;
}

function toFileURL(file) {
  return require('url').pathToFileURL(path.resolve(file)).href;
}

class Emitter extends EventEmitter {}

module.exports = { state, createEvent, home, defaultUserAgent, toFileURL, Emitter };
