'use strict';

// webContents: a window's page. The host reports raw page state (url,
// title, loading, load generation and outcome); Electron's load events are
// derived from the changes between those snapshots.

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { state, createEvent, defaultUserAgent, toFileURL, Emitter } = require('./common');
const { encode, decode } = require('../serialize');

let ipcMain = null;
function mainIpc() {
  if (!ipcMain)
    ipcMain = require('./ipc-main').ipcMain;
  return ipcMain;
}

let nextFindRequest = 1;

class WebContents extends Emitter {
  constructor(window, options = {}) {
    super();
    this.id = window.id;
    this._window = window;
    this._url = '';
    this._title = '';
    this._engineTitle = '';
    this._loading = false;
    this._generation = null;
    this._finishedGeneration = null;
    this._domReadyGeneration = null;
    this._crashed = false;
    this._destroyed = false;
    this._zoomFactor = options.zoomFactor || 1;
    this._userAgent = options.userAgent || state.userAgentFallback || defaultUserAgent();
    this._audioMuted = false;
    this._windowOpenHandler = null;
    this._pendingLoads = [];
    this._pendingScripts = new Map();
    this._nextScript = 1;
    this._devToolsOpened = false;
    this._backgroundThrottling = true;
    this.ipc = new (require('./ipc-main').IpcMain)();
    this.session = require('./session').fromPartition(options.partition || '');
    this.hostWebContents = null;
    this.devToolsWebContents = null;
    this.debugger = new Emitter();
    Object.assign(this.debugger, {
      attach() {},
      detach() {},
      isAttached: () => false,
      sendCommand: () => Promise.reject(new Error('The debugger protocol is not available in Aurora')),
    });
    this.navigationHistory = {
      canGoBack: () => this.canGoBack(),
      canGoForward: () => this.canGoForward(),
      goBack: () => this.goBack(),
      goForward: () => this.goForward(),
      goToIndex: () => {},
      goToOffset: (offset) => (offset < 0 ? this.goBack() : this.goForward()),
      clear: () => {},
      getActiveIndex: () => 0,
      length: () => 1,
      getEntryAtIndex: () => ({ url: this._url, title: this._title }),
    };
    this._canGoBack = false;
    this._canGoForward = false;
    state.webContents.set(this.id, this);
  }

  static getAllWebContents() {
    return [...state.webContents.values()];
  }

  static getFocusedWebContents() {
    const window = state.windows.get(state.focusedWindowId);
    return window ? window.webContents : null;
  }

  static fromId(id) {
    return state.webContents.get(id) || null;
  }

  static fromFrame() {
    return null;
  }

  static fromDevToolsTargetId() {
    return null;
  }

  get mainFrame() {
    const contents = this;
    return {
      url: this._url,
      name: '',
      top: null,
      parent: null,
      frames: [],
      framesInSubtree: [],
      frameTreeNodeId: 1,
      routingId: 1,
      processId: 1,
      osProcessId: 0,
      visibilityState: 'visible',
      detached: false,
      origin: (() => { try { return new URL(this._url).origin; } catch { return 'null'; } })(),
      executeJavaScript: (code, userGesture) => contents.executeJavaScript(code, userGesture),
      send: (channel, ...args) => contents.send(channel, ...args),
      postMessage: (channel, message) => contents.send(channel, message),
      reload: () => { contents.reload(); return true; },
      isDestroyed: () => contents._destroyed,
      ipc: this.ipc,
    };
  }

  get focusedFrame() {
    return this.mainFrame;
  }

  get zoomFactor() {
    return this._zoomFactor;
  }

  set zoomFactor(factor) {
    this.setZoomFactor(factor);
  }

  get zoomLevel() {
    return this.getZoomLevel();
  }

  set zoomLevel(level) {
    this.setZoomLevel(level);
  }

  get userAgent() {
    return this._userAgent;
  }

  set userAgent(value) {
    this.setUserAgent(value);
  }

  get audioMuted() {
    return this._audioMuted;
  }

  set audioMuted(value) {
    this._audioMuted = !!value;
  }

  get backgroundThrottling() {
    return this._backgroundThrottling;
  }

  set backgroundThrottling(value) {
    this._backgroundThrottling = !!value;
  }

  get frameRate() {
    return 60;
  }

  set frameRate(value) {}

  command(name, fields = {}) {
    if (this._destroyed)
      return;
    state.host.send(name, { id: this.id, ...fields });
  }

  loadURL(url, options = {}) {
    if (this._destroyed)
      return Promise.reject(new Error('Object has been destroyed'));
    const target = String(url);
    if (options.userAgent)
      this._userAgent = options.userAgent;
    // A new load aborts the previous one, as in Electron.
    for (const pending of this._pendingLoads.splice(0))
      pending.reject(Object.assign(new Error(`ERR_ABORTED (-3) loading '${pending.url}'`), { code: 'ERR_ABORTED', errno: -3, url: pending.url }));
    this._lastNavigation = { kind: 'load', url: target, time: Date.now() };
    const promise = new Promise((resolve, reject) => this._pendingLoads.push({ url: target, resolve, reject }));
    promise.catch(() => {});
    this.command('wc.loadURL', { url: target, userAgent: options.userAgent || undefined });
    return promise;
  }

  loadFile(file, options = {}) {
    const absolute = path.isAbsolute(file) ? file : path.join(state.appInfo.appPath, file);
    const url = new URL(toFileURL(absolute));
    if (options.query)
      for (const [key, value] of Object.entries(options.query))
        url.searchParams.set(key, value);
    if (options.search)
      url.search = options.search;
    if (options.hash)
      url.hash = options.hash;
    return this.loadURL(url.href);
  }

  downloadURL(url) {
    this.command('wc.download', { url: String(url) });
  }

  getURL() {
    return this._url;
  }

  getTitle() {
    return this._title;
  }

  isDestroyed() {
    return this._destroyed;
  }

  destroy() {
    this._window.destroy();
  }

  close() {
    this._window.close();
  }

  isFocused() {
    return state.focusedWindowId === this.id;
  }

  focus() {
    this.command('wc.focus');
  }

  isLoading() {
    return this._loading;
  }

  isLoadingMainFrame() {
    return this._loading;
  }

  isWaitingForResponse() {
    return this._loading;
  }

  stop() {
    this.command('wc.stop');
  }

  reload() {
    this._lastNavigation = { kind: 'reload', time: Date.now() };
    this.command('wc.reload');
  }

  reloadIgnoringCache() {
    this.reload();
  }

  // A will-prevent-unload listener called preventDefault(): Electron then
  // lets the navigation go ahead. Ours was refused already, so the runtime
  // repeats the one it just asked for, this time ignoring beforeunload.
  _forceLastNavigation() {
    const last = this._lastNavigation;
    if (!last || Date.now() - last.time > 10000)
      return;
    this._lastNavigation = null;
    if (last.kind === 'reload')
      this.command('wc.reload', { force: true });
    else
      this.command('wc.loadURL', { url: last.url, force: true });
  }

  canGoBack() {
    return this._canGoBack;
  }

  canGoForward() {
    return this._canGoForward;
  }

  canGoToOffset() {
    return false;
  }

  goBack() {
    this.command('wc.goBack');
  }

  goForward() {
    this.command('wc.goForward');
  }

  goToIndex() {}

  goToOffset(offset) {
    if (offset < 0)
      this.goBack();
    else if (offset > 0)
      this.goForward();
  }

  clearHistory() {}

  isCrashed() {
    return this._crashed;
  }

  forcefullyCrashRenderer() {}

  setUserAgent(userAgent) {
    this._userAgent = String(userAgent);
    this.command('wc.setUserAgent', { userAgent: this._userAgent });
  }

  getUserAgent() {
    return this._userAgent;
  }

  async insertCSS(css) {
    const key = `aurora-css-${this._nextScript++}`;
    await this.executeJavaScript(`(() => { const style = document.createElement('style'); style.dataset.auroraKey = ${JSON.stringify(key)};`
      + ` style.textContent = ${JSON.stringify(String(css))}; (document.head || document.documentElement).appendChild(style); })()`);
    return key;
  }

  async removeInsertedCSS(key) {
    await this.executeJavaScript(`document.querySelectorAll('style[data-aurora-key=${JSON.stringify(String(key))}]').forEach((node) => node.remove())`);
  }

  // The result is structured-cloned back, like Electron's.
  executeJavaScript(code, userGesture) {
    if (this._destroyed)
      return Promise.reject(new Error('Object has been destroyed'));
    const body = `const __auroraEncode = (${require('../serialize').encodeSource});`
      + ` const __auroraValue = await (0, eval)(${JSON.stringify(String(code))});`
      + ' return JSON.stringify(__auroraEncode(__auroraValue));';
    return state.host.script(this.id, body, true).then((result) => {
      if (result.resultType !== 'string')
        return undefined;
      return decode(JSON.parse(result.result));
    });
  }

  executeJavaScriptInIsolatedWorld(worldId, scripts) {
    return Promise.all((scripts || []).map((script) => this.executeJavaScript(script.code))).then((results) => results[results.length - 1]);
  }

  setIgnoreMenuShortcuts() {}

  setAudioMuted(muted) {
    this._audioMuted = !!muted;
  }

  isAudioMuted() {
    return this._audioMuted;
  }

  isCurrentlyAudible() {
    return false;
  }

  setZoomFactor(factor) {
    if (!(factor > 0))
      throw new Error('Invalid zoom factor');
    this._zoomFactor = factor;
    this.command('wc.setZoomFactor', { factor });
    this._dispatch('\u0000zoom', factor);
  }

  getZoomFactor() {
    return this._zoomFactor;
  }

  setZoomLevel(level) {
    this.setZoomFactor(Math.pow(1.2, level));
  }

  getZoomLevel() {
    return Math.log(this._zoomFactor) / Math.log(1.2);
  }

  setVisualZoomLevelLimits() {
    return Promise.resolve();
  }

  undo() { this.command('wc.edit', { command: 'undo' }); }
  redo() { this.command('wc.edit', { command: 'redo' }); }
  cut() { this.command('wc.edit', { command: 'cut' }); }
  copy() { this.command('wc.edit', { command: 'copy' }); }
  paste() { this.command('wc.edit', { command: 'paste' }); }
  pasteAndMatchStyle() { this.command('wc.edit', { command: 'paste' }); }
  selectAll() { this.command('wc.edit', { command: 'selectAll' }); }
  delete() { this.executeJavaScript("document.execCommand('delete')").catch(() => {}); }
  unselect() { this.executeJavaScript('window.getSelection().removeAllRanges()').catch(() => {}); }
  centerSelection() {}
  scrollToTop() { this.executeJavaScript('window.scrollTo(0, 0)').catch(() => {}); }
  scrollToBottom() { this.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)').catch(() => {}); }
  adjustSelection() {}
  copyImageAt() {}
  showDefinitionForSelection() {}

  replace(text) {
    this.insertText(text);
  }

  replaceMisspelling(text) {
    this.insertText(text);
  }

  insertText(text) {
    return this.executeJavaScript(`document.execCommand('insertText', false, ${JSON.stringify(String(text))})`).then(() => {});
  }

  findInPage(text, options = {}) {
    const requestId = nextFindRequest++;
    this._findRequest = requestId;
    this.command('wc.find', { text: String(text), forward: options.forward !== false, matchCase: !!options.matchCase });
    return requestId;
  }

  stopFindInPage() {
    this.command('wc.stopFind');
  }

  capturePage() {
    return Promise.resolve(require('./native-image').nativeImage.createEmpty());
  }

  isBeingCaptured() {
    return false;
  }

  getPrintersAsync() {
    return Promise.resolve([]);
  }

  print(options, callback) {
    if (typeof callback === 'function')
      callback(false, 'Printing is not available in Aurora');
  }

  printToPDF() {
    return Promise.reject(new Error('Printing to PDF is not available in Aurora'));
  }

  addWorkSpace() {}
  removeWorkSpace() {}
  setDevToolsWebContents() {}

  openDevTools() {
    this._devToolsOpened = true;
    this.emit('devtools-opened');
  }

  closeDevTools() {
    if (this._devToolsOpened) {
      this._devToolsOpened = false;
      this.emit('devtools-closed');
    }
  }

  isDevToolsOpened() {
    return this._devToolsOpened;
  }

  isDevToolsFocused() {
    return false;
  }

  toggleDevTools() {
    this._devToolsOpened ? this.closeDevTools() : this.openDevTools();
  }

  inspectElement() {}
  inspectSharedWorker() {}
  inspectSharedWorkerById() {}
  getAllSharedWorkers() { return []; }
  inspectServiceWorker() {}

  send(channel, ...args) {
    this._dispatch(String(channel), encode(args));
  }

  sendToFrame(frameId, channel, ...args) {
    this.send(channel, ...args);
  }

  postMessage(channel, message) {
    this.send(channel, message);
  }

  _dispatch(channel, payload) {
    if (this._destroyed)
      return;
    const code = `(() => { const dispatch = window[Symbol.for('aurora.dispatch')];`
      + ` if (dispatch) dispatch(${JSON.stringify(channel)}, ${JSON.stringify(payload)}); })()`;
    state.host.send('wc.exec', { id: this.id, code, req: 0 });
  }

  setWindowOpenHandler(handler) {
    this._windowOpenHandler = typeof handler === 'function' ? handler : null;
  }

  setBackgroundThrottling(allowed) {
    this._backgroundThrottling = !!allowed;
  }

  getBackgroundThrottling() {
    return this._backgroundThrottling;
  }

  getOSProcessId() {
    return 0;
  }

  getProcessId() {
    return this.id;
  }

  getType() {
    return 'window';
  }

  getMediaSourceId() {
    return `window:${this.id}:0`;
  }

  getWebRTCIPHandlingPolicy() {
    return 'default';
  }

  setWebRTCIPHandlingPolicy() {}

  getWebRTCUDPPortRange() {
    return { min: 0, max: 0 };
  }

  setWebRTCUDPPortRange() {}

  isOffscreen() {
    return false;
  }

  startPainting() {}
  stopPainting() {}
  isPainting() { return true; }
  invalidate() {}

  getOwnerBrowserWindow() {
    return this._window;
  }

  setImageAnimationPolicy() {}
  startDrag() {}
  savePage() { return Promise.reject(new Error('Saving pages is not available in Aurora')); }
  enableDeviceEmulation() {}
  disableDeviceEmulation() {}
  sendInputEvent() {}
  beginFrameSubscription() {}
  endFrameSubscription() {}
  incrementCapturerCount() {}
  decrementCapturerCount() {}
  setSpellCheckerLanguages() {}

  // --- Host events ----------------------------------------------------------

  _state(message) {
    const previousUrl = this._url;
    const wasLoading = this._loading;
    this._url = message.url || this._url;
    this._canGoBack = !!message.canGoBack;
    this._canGoForward = !!message.canGoForward;
    this._loading = !!message.loading;
    if (typeof message.zoom === 'number' && message.zoom > 0)
      this._zoomFactor = message.zoom;
    if (!wasLoading && this._loading)
      this.emit('did-start-loading');
    const generation = message.loadGeneration;
    if (generation !== undefined && generation !== this._generation) {
      this._generation = generation;
      if (message.loadOutcome === 'loading')
        this.emit('did-start-navigation', createEvent({ url: this._url, isMainFrame: true, isSameDocument: false }),
          this._url, false, true, 1, 1);
    }
    if (this._url && this._url !== previousUrl) {
      const sameDocument = previousUrl && previousUrl.split('#')[0] === this._url.split('#')[0];
      if (sameDocument)
        this.emit('did-navigate-in-page', createEvent(), this._url, true, 1, 1);
      else
        this.emit('did-navigate', createEvent(), this._url, 200, 'OK');
    }
    // Only a change in what the engine reports: it lags behind the title the
    // page's dom-ready message brought.
    if (message.title !== undefined && message.title !== this._engineTitle) {
      this._engineTitle = message.title;
      this._applyTitle(message.title);
    }
    if (generation !== undefined && generation !== this._finishedGeneration) {
      if (message.loadOutcome === 'succeeded') {
        this._finishedGeneration = generation;
        if (this._domReadyGeneration !== generation) {
          this._domReadyGeneration = generation;
          this.emit('dom-ready', createEvent());
        }
        this.emit('did-frame-finish-load', createEvent(), true, 1, 1);
        this.emit('did-finish-load', createEvent());
        for (const pending of this._pendingLoads.splice(0))
          pending.resolve();
      } else if (message.loadOutcome === 'failed' || message.loadOutcome === 'cancelled') {
        this._finishedGeneration = generation;
        const error = message.loadError || {};
        const code = message.loadOutcome === 'cancelled' ? -3 : (error.code ? -Math.abs(error.code) : -2);
        const description = message.loadOutcome === 'cancelled' ? 'ERR_ABORTED' : (error.description || 'ERR_FAILED');
        const url = error.url || this._url;
        if (message.loadOutcome === 'failed')
          this.emit('did-fail-load', createEvent(), code, description, url, true, 1, 1);
        for (const pending of this._pendingLoads.splice(0))
          pending.reject(Object.assign(new Error(`${description} (${code}) loading '${url}'`), { code: description, errno: code, url }));
      }
    }
    if (wasLoading && !this._loading)
      this.emit('did-stop-loading');
  }

  _applyTitle(title) {
    if (title === this._title)
      return;
    this._title = title;
    const event = createEvent();
    this.emit('page-title-updated', event, this._title, true);
    this._window._pageTitleUpdated(event, this._title);
  }

  _domReady() {
    if (this._domReadyGeneration === this._generation)
      return;
    this._domReadyGeneration = this._generation;
    this.emit('dom-ready', createEvent());
  }

  _crashedEvent(message) {
    this._crashed = true;
    const details = { reason: 'crashed', exitCode: message.error || 0 };
    this.emit('render-process-gone', createEvent(), details);
    this.emit('crashed', createEvent(), false);
  }

  // The page's message handler: ipcRenderer.send/invoke and bridge notices.
  async _ipcMessage(message) {
    let body;
    try {
      body = JSON.parse(message.body);
    } catch {
      state.host.send('ipc.reply', { token: message.token, error: 'Malformed message' });
      return;
    }
    if (body.k !== this._window._bridgeToken) {
      state.host.send('ipc.reply', { token: message.token, error: 'Unknown sender' });
      return;
    }
    const reply = (value) => state.host.send('ipc.reply', { token: message.token, reply: value });
    switch (body.t) {
    case 'send': {
      reply('null');
      const args = decode(body.a) || [];
      const event = this._ipcEvent(message, body);
      this.emit('ipc-message', event, body.ch, ...args);
      if (!this.ipc.emit(body.ch, event, ...args))
        mainIpc().emit(body.ch, event, ...args);
      return;
    }
    case 'invoke': {
      const args = decode(body.a) || [];
      const event = this._ipcEvent(message, body);
      try {
        const value = await this._invoke(body.ch, event, args);
        reply(JSON.stringify({ ok: true, v: encode(value) }));
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const remote = new Error(`Error invoking remote method '${body.ch}': ${failure.name}: ${failure.message}`);
        reply(JSON.stringify({ ok: false, e: encode(remote) }));
      }
      return;
    }
    case 'window-drag':
      // A press in the page's app-region: drag area (renderer/bridge.js).
      reply('null');
      if (body.dbl) {
        if (this._window.isMaximized())
          this._window.unmaximize();
        else if (this._window.isMaximizable())
          this._window.maximize();
      } else {
        this._window.command('window.beginMove', { x: Number(body.x) || 0, y: Number(body.y) || 0 });
      }
      return;
    case 'remote':
      // Asynchronous remote-module requests (releasing references).
      reply('null');
      this._remoteObjects().request(body);
      return;
    case 'dom-ready':
      reply('null');
      if (body.top !== false && typeof body.title === 'string' && body.title)
        this._applyTitle(body.title);
      this._domReady();
      return;
    case 'zoom':
      reply('null');
      if (body.v > 0)
        this.setZoomFactor(body.v);
      return;
    case 'preload-error':
      reply('null');
      this.emit('preload-error', createEvent(), '', new Error(body.m));
      process.stderr.write(`[aurora] preload error in window ${this.id}: ${body.m}\n`);
      return;
    default:
      reply('null');
    }
  }

  async _invoke(channel, event, args) {
    if (channel === '\u0000shell.openExternal')
      return require('./shell').shell.openExternal(args[0]);
    const handler = this.ipc._handlers.get(channel) || mainIpc()._handlers.get(channel);
    if (!handler)
      throw new Error(`No handler registered for '${channel}'`);
    return handler(event, ...args);
  }

  _ipcEvent(message, body) {
    const contents = this;
    const frame = {
      url: message.frameUrl || this._url,
      top: null,
      parent: null,
      frameTreeNodeId: body.top ? 1 : 2,
      routingId: body.top ? 1 : 2,
      processId: 1,
      name: '',
      origin: message.origin,
      isDestroyed: () => false,
      send: (channel, ...args) => contents.send(channel, ...args),
      postMessage: (channel, value) => contents.send(channel, value),
      executeJavaScript: (code) => contents.executeJavaScript(code),
    };
    return {
      type: 'frame',
      sender: this,
      senderFrame: frame,
      frameId: frame.routingId,
      processId: 1,
      ports: [],
      returnValue: undefined,
      reply: (channel, ...args) => contents.send(channel, ...args),
      preventDefault() {},
    };
  }

  // Synchronous ipcRenderer.sendSync, arriving as an aurora-ipc:// request.
  _syncMessage(body, request) {
    if (body.k !== this._window._bridgeToken)
      return { v: encode(undefined) };
    if (body.t === 'remote')
      return this._remoteObjects().request(body);
    const event = this._ipcEvent({ frameUrl: this._url, origin: '' }, body);
    const args = decode(body.a) || [];
    this.emit('ipc-message-sync', event, body.ch, ...args);
    if (!this.ipc.emit(body.ch, event, ...args))
      mainIpc().emit(body.ch, event, ...args);
    return { v: encode(event.returnValue) };
  }

  // Node.js modules served to this page's preload scripts (remote.js).
  _remoteObjects() {
    if (!this._remote) {
      const { RemoteObjects } = require('./remote');
      this._remote = new RemoteObjects(this);
    }
    return this._remote;
  }

  _destroy() {
    if (this._destroyed)
      return;
    this._remote = null;
    this._destroyed = true;
    for (const pending of this._pendingLoads.splice(0))
      pending.reject(new Error('The window was closed'));
    state.webContents.delete(this.id);
    this.emit('destroyed');
  }
}

module.exports = { WebContents };
