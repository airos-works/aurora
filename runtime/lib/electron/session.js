'use strict';

// session: one per partition, matching aurora-host's web contexts. Cookies
// and clearing website data go to the engine when it has the interfaces (the
// host's ready event says websiteData); request interception is accepted
// but inert.

const path = require('path');
const { Emitter, state, createEvent } = require('./common');

const sessions = new Map();

// The engine's website data types (WebKitEmbedding.h, B_WEBKIT_DATA_*).
const DATA = { cookies: 1, cache: 2, localStorage: 4, indexedDB: 8, serviceWorkers: 16 };
const ALL_DATA = 0xffffffff;
// Electron's clearStorageData storages, and clearData's dataTypes.
const STORAGES = {
  cookies: DATA.cookies, localstorage: DATA.localStorage, indexdb: DATA.indexedDB,
  serviceworkers: DATA.serviceWorkers, cachestorage: DATA.serviceWorkers,
};
const DATA_TYPES = {
  cookies: DATA.cookies, cache: DATA.cache, localStorage: DATA.localStorage, indexedDB: DATA.indexedDB,
  serviceWorkers: DATA.serviceWorkers, backgroundFetch: DATA.serviceWorkers,
};

function hasWebsiteData() {
  return !!(state.readyInfo && state.readyInfo.websiteData && state.host);
}

function sameSiteToEngine(value) {
  return value === 'strict' || value === 'lax' ? value : 'none';
}

// An engine cookie as Electron's Cookie.
function toElectronCookie(cookie) {
  const result = {
    name: cookie.name, value: cookie.value, domain: cookie.domain,
    hostOnly: !cookie.domain.startsWith('.'), path: cookie.path || '/',
    secure: !!cookie.secure, httpOnly: !!cookie.httpOnly, session: !!cookie.session,
    sameSite: cookie.sameSite === 'strict' || cookie.sameSite === 'lax' ? cookie.sameSite : 'unspecified',
  };
  if (!cookie.session && typeof cookie.expires === 'number')
    result.expirationDate = cookie.expires / 1000;
  return result;
}

function domainMatches(cookieDomain, filter) {
  const domain = cookieDomain.replace(/^\./, '').toLowerCase();
  const wanted = String(filter).replace(/^\./, '').toLowerCase();
  return domain === wanted || domain.endsWith(`.${wanted}`);
}

class Cookies extends Emitter {
  constructor(session) {
    super();
    this._session = session;
  }

  _request(command, fields) {
    return state.host.request(command, { partition: this._session.partition, ...fields });
  }

  async get(filter = {}) {
    if (!hasWebsiteData())
      return [];
    const cookies = (await this._request('session.cookies.get', { url: filter.url || '' })) || [];
    return cookies.map(toElectronCookie).filter((cookie) =>
      (filter.name === undefined || cookie.name === filter.name)
      && (filter.domain === undefined || domainMatches(cookie.domain, filter.domain))
      && (filter.path === undefined || cookie.path === filter.path)
      && (filter.secure === undefined || cookie.secure === !!filter.secure)
      && (filter.httpOnly === undefined || cookie.httpOnly === !!filter.httpOnly)
      && (filter.session === undefined || cookie.session === !!filter.session));
  }

  async set(details = {}) {
    let url;
    try {
      url = new URL(details.url);
    } catch {
      throw new Error(`Failed to set cookie: the URL ${JSON.stringify(details.url)} is not valid`);
    }
    // Without a domain the cookie belongs to the URL's host alone; with one,
    // to the domain and its subdomains. The default path is the URL's
    // directory, as a Set-Cookie header without Path would have.
    const domain = details.domain ? (details.domain.startsWith('.') ? details.domain : `.${details.domain}`) : url.hostname;
    const directory = url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/';
    const cookie = {
      name: String(details.name || ''), value: String(details.value || ''), domain,
      path: details.path || directory, secure: !!details.secure, httpOnly: !!details.httpOnly,
      sameSite: sameSiteToEngine(details.sameSite),
    };
    if (typeof details.expirationDate === 'number')
      cookie.expires = details.expirationDate * 1000;
    if (!hasWebsiteData())
      return;
    await this._request('session.cookies.set', { cookie });
    this.emit('changed', createEvent(), toElectronCookie({ ...cookie, session: cookie.expires === undefined }), 'explicit', false);
  }

  async remove(url, name) {
    if (!hasWebsiteData())
      return;
    const removed = await this.get({ url, name });
    await this._request('session.cookies.remove', { url: String(url || ''), name: String(name || '') });
    for (const cookie of removed)
      this.emit('changed', createEvent(), cookie, 'explicit', true);
  }

  flushStore() { return Promise.resolve(); }
}

async function clearWebsiteData(session, types, origin) {
  if (!hasWebsiteData() || !types)
    return;
  if (origin) {
    // The engine removes a type for every site at once. For one origin only
    // its cookies can go; clearing the rest would lose other sites' data.
    if (types & DATA.cookies) {
      for (const cookie of await session.cookies.get({ url: origin }))
        await session.cookies.remove(origin, cookie.name);
    }
    return;
  }
  // Cookies one by one: removing them as website data does nothing in
  // WebKit's curl network backend (deleteAllCookiesModifiedSince is a stub).
  if (types & DATA.cookies)
    await state.host.request('session.cookies.remove', { partition: session.partition, url: '', name: '' });
  const rest = types & ~DATA.cookies;
  if (rest)
    await state.host.request('session.clearData', { partition: session.partition, types: rest });
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
    this.cookies = new Cookies(this);
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
  clearCache() { return clearWebsiteData(this, DATA.cache); }
  clearStorageData(options = {}) {
    const storages = Array.isArray(options.storages) ? options.storages : Object.keys(STORAGES);
    const types = storages.reduce((mask, storage) => mask | (STORAGES[String(storage).toLowerCase()] || 0), 0);
    return clearWebsiteData(this, types, options.origin);
  }
  clearData(options = {}) {
    const types = Array.isArray(options.dataTypes)
      ? options.dataTypes.reduce((mask, type) => mask | (DATA_TYPES[type] || 0), 0) : ALL_DATA;
    const origins = Array.isArray(options.origins) ? options.origins : [];
    if (origins.length)
      return Promise.all(origins.map((origin) => clearWebsiteData(this, types, origin))).then(() => {});
    return clearWebsiteData(this, types);
  }
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
