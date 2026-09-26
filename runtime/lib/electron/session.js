'use strict';

// session: one per partition, matching aurora-host's web contexts. Cookie,
// cache and request interception interfaces are accepted but mostly inert:
// the engine manages its own website data.

const path = require('path');
const { Emitter } = require('./common');

const sessions = new Map();

class Cookies extends Emitter {
  get() { return Promise.resolve([]); }
  set() { return Promise.resolve(); }
  remove() { return Promise.resolve(); }
  flushStore() { return Promise.resolve(); }
}

class WebRequest {
  constructor() {
    this._listeners = {};
  }

  _register(name, filter, listener) {
    this._listeners[name] = typeof filter === 'function' ? filter : listener || null;
  }

  onBeforeRequest(filter, listener) { this._register('onBeforeRequest', filter, listener); }
  onBeforeSendHeaders(filter, listener) { this._register('onBeforeSendHeaders', filter, listener); }
  onSendHeaders(filter, listener) { this._register('onSendHeaders', filter, listener); }
  onHeadersReceived(filter, listener) { this._register('onHeadersReceived', filter, listener); }
  onResponseStarted(filter, listener) { this._register('onResponseStarted', filter, listener); }
  onBeforeRedirect(filter, listener) { this._register('onBeforeRedirect', filter, listener); }
  onCompleted(filter, listener) { this._register('onCompleted', filter, listener); }
  onErrorOccurred(filter, listener) { this._register('onErrorOccurred', filter, listener); }
}

class Session extends Emitter {
  constructor(partition) {
    super();
    this.partition = partition;
    this.cookies = new Cookies();
    this.webRequest = new WebRequest();
    this.protocol = require('./protocol').protocol;
    this.netLog = { startLogging: () => Promise.resolve(), stopLogging: () => Promise.resolve(), currentlyLogging: false };
    this.serviceWorkers = new Emitter();
    Object.assign(this.serviceWorkers, { getAllRunning: () => ({}), getFromVersionID: () => null, getInfoFromVersionID: () => null });
    this.extensions = new Emitter();
    Object.assign(this.extensions, {
      loadExtension: () => Promise.reject(new Error('Extensions are not available in Aurora')),
      removeExtension() {}, getExtension: () => null, getAllExtensions: () => [],
    });
    this.spellCheckerEnabled = false;
    this.storagePath = partition.startsWith('persist:') || partition === '' ? path.join(require('./app').app.getPath('userData'), partition ? `Partitions/${partition.slice(8)}` : 'WebKit') : null;
    this._preloads = [];
    this._userAgent = null;
    this._downloadPath = null;
    this._permissionRequestHandler = null;
    this._permissionCheckHandler = null;
  }

  static fromPartition(partition = '', options = {}) {
    const key = String(partition || '');
    if (!sessions.has(key))
      sessions.set(key, new Session(key, options));
    return sessions.get(key);
  }

  static fromPath(storagePath) {
    return Session.fromPartition(`persist:${path.basename(storagePath)}`);
  }

  static get defaultSession() {
    return Session.fromPartition('');
  }

  isPersistent() { return this.partition === '' || this.partition.startsWith('persist:'); }
  getStoragePath() { return this.storagePath; }
  getCacheSize() { return Promise.resolve(0); }
  clearCache() { return Promise.resolve(); }
  clearStorageData() { return Promise.resolve(); }
  clearData() { return Promise.resolve(); }
  flushStorageData() {}
  clearAuthCache() { return Promise.resolve(); }
  clearHostResolverCache() { return Promise.resolve(); }
  clearCodeCaches() { return Promise.resolve(); }
  setProxy() { return Promise.resolve(); }
  resolveProxy() { return Promise.resolve('DIRECT'); }
  forceReloadProxyConfig() { return Promise.resolve(); }
  closeAllConnections() { return Promise.resolve(); }
  preconnect() {}
  setDownloadPath(directory) { this._downloadPath = directory; }
  enableNetworkEmulation() {}
  disableNetworkEmulation() {}
  setCertificateVerifyProc() {}
  setPermissionRequestHandler(handler) { this._permissionRequestHandler = handler; }
  setPermissionCheckHandler(handler) { this._permissionCheckHandler = handler; }
  setDisplayMediaRequestHandler() {}
  setDevicePermissionHandler() {}
  setUSBProtectedClassesHandler() {}
  setBluetoothPairingHandler() {}
  allowNTLMCredentialsForDomains() {}
  setUserAgent(userAgent) { this._userAgent = userAgent; }
  getUserAgent() { return this._userAgent || require('./common').defaultUserAgent(); }
  setSSLConfig() {}
  getBlobData() { return Promise.resolve(Buffer.alloc(0)); }
  downloadURL(url) {
    const { BrowserWindow } = require('./browser-window');
    const window = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (window)
      window.webContents.downloadURL(url);
  }
  createInterruptedDownload() {}
  setPreloads(preloads) { this._preloads = [...preloads]; }
  getPreloads() { return [...this._preloads]; }
  registerPreloadScript(script) {
    const id = `preload-${this._preloads.length}`;
    if (script && script.filePath && (!script.type || script.type === 'frame'))
      this._preloads.push(script.filePath);
    return id;
  }
  unregisterPreloadScript() {}
  getPreloadScripts() { return this._preloads.map((filePath, index) => ({ id: `preload-${index}`, type: 'frame', filePath })); }
  setCodeCachePath() {}
  setSpellCheckerEnabled(enabled) { this.spellCheckerEnabled = !!enabled; }
  isSpellCheckerEnabled() { return this.spellCheckerEnabled; }
  setSpellCheckerLanguages() {}
  getSpellCheckerLanguages() { return []; }
  setSpellCheckerDictionaryDownloadURL() {}
  listWordsInSpellCheckerDictionary() { return Promise.resolve([]); }
  addWordToSpellCheckerDictionary() { return false; }
  removeWordFromSpellCheckerDictionary() { return false; }
  loadExtension() { return this.extensions.loadExtension(); }
  removeExtension() {}
  getExtension() { return null; }
  getAllExtensions() { return []; }
  getSharedDictionaryUsageInfo() { return Promise.resolve([]); }
  getStoragePathForPartition() { return this.storagePath; }
  get availableSpellCheckerLanguages() { return []; }
}

module.exports = {
  Session,
  fromPartition: Session.fromPartition,
  session: {
    fromPartition: Session.fromPartition,
    fromPath: Session.fromPath,
    get defaultSession() {
      return Session.defaultSession;
    },
  },
};
