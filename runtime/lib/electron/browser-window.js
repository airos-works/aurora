'use strict';

// BrowserWindow: a native window of aurora-host with one page. Everything
// the host needs to create it is sent at construction; later commands queue
// behind it on the same pipe, so the object is usable at once, as Electron's.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { state, createEvent, Emitter } = require('./common');
const { WebContents } = require('./web-contents');
const { buildBridgeScript } = require('../renderer/bridge');

function appModule() {
  return require('./app').app;
}

function menuModule() {
  return require('./menu');
}

const FORWARDED_OPTIONS = ['title', 'x', 'y', 'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'resizable', 'minimizable', 'maximizable', 'closable', 'focusable', 'alwaysOnTop', 'frame', 'modal',
  'backgroundColor', 'autoHideMenuBar'];

function preloadFiles(webPreferences, sessionPreloads) {
  const files = [];
  for (const file of [...sessionPreloads, webPreferences.preload]) {
    if (!file)
      continue;
    const resolved = path.resolve(String(file).startsWith('file://') ? require('url').fileURLToPath(file) : file);
    if (fs.existsSync(resolved) && !files.includes(resolved))
      files.push(resolved);
  }
  return files;
}

class BrowserWindow extends Emitter {
  constructor(options = {}, internal = {}) {
    super();
    this.id = state.nextWindowId++;
    const webPreferences = { ...(options.webPreferences || {}) };
    this._options = { ...options, webPreferences };
    this._title = options.title || state.appInfo.productName || state.appInfo.name;
    this._visible = options.show !== false;
    this._destroyed = false;
    this._closing = false;
    this._minimized = false;
    this._maximized = false;
    this._fullScreen = false;
    this._focused = false;
    this._menuBarVisible = !options.autoHideMenuBar;
    this._autoHideMenuBar = !!options.autoHideMenuBar;
    this._resizable = options.resizable !== false;
    this._movable = options.movable !== false;
    this._minimizable = options.minimizable !== false;
    this._maximizable = options.maximizable !== false;
    this._closable = options.closable !== false;
    this._focusable = options.focusable !== false;
    this._alwaysOnTop = !!options.alwaysOnTop;
    this._fullScreenable = options.fullscreenable !== false;
    this._opacity = 1;
    this._enabled = true;
    this._menu = undefined;
    this._parent = options.parent instanceof BrowserWindow ? options.parent : null;
    this._minimumSize = [options.minWidth || 0, options.minHeight || 0];
    this._maximumSize = [options.maxWidth || 0, options.maxHeight || 0];
    const display = (state.screens[0] && state.screens[0].workArea) || { x: 0, y: 0, width: 1920, height: 1080 };
    const width = options.width || 800;
    const height = options.height || 600;
    this._bounds = {
      x: options.x !== undefined ? options.x : Math.round(display.x + (display.width - width) / 2),
      y: options.y !== undefined ? options.y : Math.round(display.y + (display.height - height) / 2),
      width,
      height,
    };
    this._bridgeToken = internal.bridgeToken || crypto.randomBytes(16).toString('hex');
    this.webContents = new WebContents(this, {
      partition: webPreferences.partition,
      zoomFactor: webPreferences.zoomFactor,
    });
    this.contentView = { children: [], addChildView() {}, removeChildView() {}, setBounds() {}, getBounds: () => this.getContentBounds() };
    state.windows.set(this.id, this);

    const hostOptions = {};
    for (const key of FORWARDED_OPTIONS) {
      if (options[key] !== undefined)
        hostOptions[key] = options[key];
    }
    hostOptions.title = this._title;
    hostOptions.show = false;
    hostOptions.x = this._bounds.x;
    hostOptions.y = this._bounds.y;
    hostOptions.partition = webPreferences.partition || '';
    hostOptions.userAgent = this.webContents.getUserAgent();
    if (webPreferences.zoomFactor)
      hostOptions.zoomFactor = webPreferences.zoomFactor;
    if (options.transparent && !options.backgroundColor)
      hostOptions.backgroundColor = state.darkMode ? '#1e1e1e' : '#ffffff';
    const schemes = [{ scheme: 'aurora-ipc', secure: true, corsEnabled: true, bypassCSP: true }];
    for (const [scheme, privileges] of state.privilegedSchemes) {
      if (scheme !== 'aurora-ipc')
        schemes.push({ scheme, secure: !!privileges.secure || !!privileges.standard, corsEnabled: !!privileges.corsEnabled,
          bypassCSP: !!privileges.bypassCSP });
    }
    for (const scheme of state.protocols.keys()) {
      if (!schemes.some((entry) => entry.scheme === scheme))
        schemes.push({ scheme, secure: false, corsEnabled: false, bypassCSP: false });
    }
    hostOptions.schemes = schemes;
    if (internal.inheritScriptsFrom) {
      hostOptions.inheritScriptsFrom = internal.inheritScriptsFrom;
    } else {
      const session = this.webContents.session;
      const files = preloadFiles(webPreferences, session.getPreloads ? session.getPreloads() : []);
      const source = buildBridgeScript({
        preloadFiles: files,
        token: this._bridgeToken,
        versions: { ...process.versions },
        resourcesPath: process.resourcesPath,
        systemVersion: require('os').release(),
        // Electron gives a preload all of Node.js only without its sandbox.
        remoteModules: webPreferences.sandbox === false || webPreferences.nodeIntegration === true,
        // Electron honours app-region drag areas only without its frame.
        frameless: options.frame === false || (options.titleBarStyle && options.titleBarStyle !== 'default'),
        argv: [process.execPath, ...(Array.isArray(webPreferences.additionalArguments) ? webPreferences.additionalArguments : [])],
      });
      hostOptions.userScripts = [{ source, when: 'start', allFrames: !!webPreferences.nodeIntegrationInSubFrames }];
      this._preloadFiles = files;
    }
    const menu = menuModule();
    if (state.applicationMenu === null && menu.Menu._applicationMenuSet)
      hostOptions.menu = [];
    this._created = state.host.request('window.create', { id: this.id, options: hostOptions, newPageRequest: internal.newPageRequest || 0 })
      .catch((error) => {
        process.stderr.write(`[aurora] could not create window ${this.id}: ${error.message}\n`);
        this._closed();
      });
    if (options.fullscreen)
      this.setFullScreen(true);
    if (options.center)
      this.center();
    if (this._visible)
      this.show();
    setImmediate(() => {
      if (!this._destroyed)
        appModule().emit('browser-window-created', createEvent(), this);
    });
  }

  static getAllWindows() {
    return [...state.windows.values()];
  }

  static getFocusedWindow() {
    const window = state.windows.get(state.focusedWindowId);
    return window && !window._destroyed ? window : null;
  }

  static fromWebContents(webContents) {
    if (!webContents)
      return null;
    return state.windows.get(webContents.id) || null;
  }

  static fromBrowserView() {
    return null;
  }

  static fromId(id) {
    return state.windows.get(id) || null;
  }

  command(name, fields = {}) {
    if (this._destroyed)
      return;
    state.host.send(name, { id: this.id, ...fields });
  }

  // --- Lifecycle -------------------------------------------------------------

  close() {
    if (this._destroyed)
      return;
    const event = createEvent();
    this.emit('close', event);
    // A 'close' listener may call close() again (pgAdmin does); ask once.
    if (event.defaultPrevented || this._destroyed || this._closing)
      return;
    this._closing = true;
    this.command('window.close');
  }

  destroy() {
    if (this._destroyed)
      return;
    this._closing = true;
    this.command('window.destroy');
  }

  isDestroyed() {
    return this._destroyed;
  }

  _closeRequested(message) {
    // The close button, Command-W, or the page's window.close().
    this.close();
  }

  _closeCancelled() {
    // A beforeunload handler kept the page. Electron: will-prevent-unload,
    // and a listener that prevents it lets the close go ahead.
    this._closing = false;
    const event = createEvent();
    this.webContents.emit('will-prevent-unload', event);
    if (event.defaultPrevented)
      this.destroy();
  }

  _closed() {
    if (this._destroyed)
      return;
    this._destroyed = true;
    this._visible = false;
    state.windows.delete(this.id);
    if (state.focusedWindowId === this.id)
      state.focusedWindowId = null;
    this.webContents._destroy();
    this.emit('closed');
    for (const child of BrowserWindow.getAllWindows()) {
      if (child._parent === this)
        child._parent = null;
    }
    require('./app')._windowClosed();
  }

  _windowEvent(message) {
    if (message.bounds)
      this._bounds = { ...message.bounds };
    const app = appModule();
    switch (message.type) {
    case 'focus':
      this._focused = true;
      state.focusedWindowId = this.id;
      this.emit('focus');
      app.emit('browser-window-focus', createEvent(), this);
      break;
    case 'blur':
      this._focused = false;
      if (state.focusedWindowId === this.id)
        state.focusedWindowId = null;
      this.emit('blur');
      app.emit('browser-window-blur', createEvent(), this);
      break;
    case 'move':
      this.emit('move');
      this._settle('moved');
      break;
    case 'resize':
      this.emit('resize');
      this._settle('resized');
      break;
    case 'minimize':
      this._minimized = true;
      this.emit('minimize');
      break;
    case 'restore':
      this._minimized = false;
      this.emit('restore');
      break;
    case 'maximize':
      this._maximized = true;
      this.emit('maximize');
      break;
    case 'unmaximize':
      this._maximized = false;
      this.emit('unmaximize');
      break;
    case 'enter-full-screen':
      this._fullScreen = true;
      this.emit('enter-full-screen');
      break;
    case 'leave-full-screen':
      this._fullScreen = false;
      this.emit('leave-full-screen');
      break;
    case 'ready-to-show':
      this.emit('ready-to-show');
      break;
    default:
      break;
    }
  }

  // 'moved' and 'resized' follow the last of a burst of changes.
  _settle(name) {
    clearTimeout(this[`_${name}Timer`]);
    this[`_${name}Timer`] = setTimeout(() => {
      if (!this._destroyed)
        this.emit(name);
    }, 150);
  }

  _pageTitleUpdated(event, title) {
    if (!event.defaultPrevented && title)
      this.setTitle(title);
  }

  // --- Visibility and state --------------------------------------------------

  show() {
    this._visible = true;
    const wasHidden = !this._shown;
    this._shown = true;
    this.command('window.show', { activate: true });
    if (wasHidden)
      setImmediate(() => !this._destroyed && this.emit('show'));
  }

  showInactive() {
    this._visible = true;
    this._shown = true;
    this.command('window.show', { activate: false });
    setImmediate(() => !this._destroyed && this.emit('show'));
  }

  hide() {
    if (!this._visible)
      return;
    this._visible = false;
    this.command('window.hide');
    setImmediate(() => !this._destroyed && this.emit('hide'));
  }

  isVisible() {
    return this._visible && !this._destroyed;
  }

  focus() {
    this.command('window.focus');
  }

  blur() {
    this.command('window.blur');
  }

  isFocused() {
    return state.focusedWindowId === this.id;
  }

  isModal() {
    return !!this._options.modal;
  }

  maximize() {
    this.command('window.maximize');
  }

  unmaximize() {
    this.command('window.unmaximize');
  }

  isMaximized() {
    return this._maximized;
  }

  minimize() {
    this.command('window.minimize');
  }

  restore() {
    this.command('window.restore');
  }

  isMinimized() {
    return this._minimized;
  }

  isNormal() {
    return !this._minimized && !this._maximized && !this._fullScreen;
  }

  setFullScreen(flag) {
    this.command('window.setFullScreen', { flag: !!flag });
  }

  isFullScreen() {
    return this._fullScreen;
  }

  setSimpleFullScreen(flag) {
    this.setFullScreen(flag);
  }

  isSimpleFullScreen() {
    return this._fullScreen;
  }

  setKiosk(flag) {
    this.setFullScreen(flag);
  }

  isKiosk() {
    return this._fullScreen;
  }

  get fullScreen() { return this._fullScreen; }
  set fullScreen(flag) { this.setFullScreen(flag); }
  get simpleFullScreen() { return this._fullScreen; }
  set simpleFullScreen(flag) { this.setFullScreen(flag); }
  get kiosk() { return this._fullScreen; }
  set kiosk(flag) { this.setFullScreen(flag); }

  // --- Geometry --------------------------------------------------------------

  setBounds(bounds) {
    this._bounds = { ...this._bounds, ...bounds };
    this.command('window.setBounds', this._bounds);
  }

  getBounds() {
    return { ...this._bounds };
  }

  getContentBounds() {
    return this.getBounds();
  }

  setContentBounds(bounds) {
    this.setBounds(bounds);
  }

  getNormalBounds() {
    return this.getBounds();
  }

  setSize(width, height) {
    this.setBounds({ width, height });
  }

  getSize() {
    return [this._bounds.width, this._bounds.height];
  }

  setContentSize(width, height) {
    this.setSize(width, height);
  }

  getContentSize() {
    return this.getSize();
  }

  setPosition(x, y) {
    this.setBounds({ x, y });
  }

  getPosition() {
    return [this._bounds.x, this._bounds.y];
  }

  center() {
    this.command('window.center');
    const display = (state.screens[0] && state.screens[0].workArea) || { x: 0, y: 0, width: 1920, height: 1080 };
    this._bounds.x = Math.round(display.x + (display.width - this._bounds.width) / 2);
    this._bounds.y = Math.round(display.y + (display.height - this._bounds.height) / 2);
  }

  setMinimumSize(width, height) {
    this._minimumSize = [width, height];
    this._sendSizeLimits();
  }

  getMinimumSize() {
    return [...this._minimumSize];
  }

  setMaximumSize(width, height) {
    this._maximumSize = [width, height];
    this._sendSizeLimits();
  }

  getMaximumSize() {
    return [...this._maximumSize];
  }

  _sendSizeLimits() {
    this.command('window.setSizeLimits', {
      minWidth: this._minimumSize[0] || 1, minHeight: this._minimumSize[1] || 1,
      maxWidth: this._maximumSize[0] || 32769, maxHeight: this._maximumSize[1] || 32769,
    });
  }

  setAspectRatio() {}

  setResizable(flag) {
    this._resizable = !!flag;
    this.command('window.setResizable', { flag: this._resizable });
  }

  isResizable() {
    return this._resizable;
  }

  get resizable() { return this._resizable; }
  set resizable(flag) { this.setResizable(flag); }

  setMovable(flag) { this._movable = !!flag; }
  isMovable() { return this._movable; }
  get movable() { return this._movable; }
  set movable(flag) { this._movable = !!flag; }
  setMinimizable(flag) { this._minimizable = !!flag; }
  isMinimizable() { return this._minimizable; }
  get minimizable() { return this._minimizable; }
  set minimizable(flag) { this._minimizable = !!flag; }
  setMaximizable(flag) { this._maximizable = !!flag; }
  isMaximizable() { return this._maximizable; }
  get maximizable() { return this._maximizable; }
  set maximizable(flag) { this._maximizable = !!flag; }
  setFullScreenable(flag) { this._fullScreenable = !!flag; }
  isFullScreenable() { return this._fullScreenable; }
  get fullScreenable() { return this._fullScreenable; }
  set fullScreenable(flag) { this._fullScreenable = !!flag; }
  setClosable(flag) { this._closable = !!flag; }
  isClosable() { return this._closable; }
  get closable() { return this._closable; }
  set closable(flag) { this._closable = !!flag; }
  setFocusable(flag) { this._focusable = !!flag; }
  isFocusable() { return this._focusable; }
  get focusable() { return this._focusable; }
  set focusable(flag) { this._focusable = !!flag; }

  setAlwaysOnTop(flag) {
    this._alwaysOnTop = !!flag;
    this.command('window.setAlwaysOnTop', { flag: this._alwaysOnTop });
  }

  isAlwaysOnTop() {
    return this._alwaysOnTop;
  }

  moveAbove() {}

  moveTop() {
    this.focus();
  }

  setEnabled(flag) {
    this._enabled = !!flag;
  }

  isEnabled() {
    return this._enabled;
  }

  setTitle(title) {
    this._title = String(title);
    this.command('window.setTitle', { title: this._title });
  }

  getTitle() {
    return this._title;
  }

  get title() { return this._title; }
  set title(value) { this.setTitle(value); }

  setBackgroundColor(color) {
    this._options.backgroundColor = color;
  }

  getBackgroundColor() {
    return this._options.backgroundColor || '#FFFFFF';
  }

  setOpacity(opacity) {
    this._opacity = opacity;
  }

  getOpacity() {
    return this._opacity;
  }

  // --- Page ------------------------------------------------------------------

  loadURL(url, options) {
    return this.webContents.loadURL(url, options);
  }

  loadFile(file, options) {
    return this.webContents.loadFile(file, options);
  }

  reload() {
    this.webContents.reload();
  }

  capturePage(...args) {
    return this.webContents.capturePage(...args);
  }

  focusOnWebView() {
    this.webContents.focus();
  }

  blurWebView() {}

  // --- Menu --------------------------------------------------------------------

  setMenu(menu) {
    this._menu = menu || null;
    this.command('window.setMenu', { menu: menu ? menuModule().serializeMenu(menu, this.id) : [] });
  }

  removeMenu() {
    this.setMenu(null);
  }

  getMenu() {
    return this._menu || null;
  }

  setMenuBarVisibility(visible) {
    this._menuBarVisible = !!visible;
    this.command('window.setMenuBarVisibility', { visible: this._menuBarVisible });
  }

  isMenuBarVisible() {
    return this._menuBarVisible;
  }

  get menuBarVisible() { return this._menuBarVisible; }
  set menuBarVisible(value) { this.setMenuBarVisibility(value); }

  setAutoHideMenuBar(hide) {
    this._autoHideMenuBar = !!hide;
    this.setMenuBarVisibility(!hide);
  }

  isMenuBarAutoHide() {
    return this._autoHideMenuBar;
  }

  get autoHideMenuBar() { return this._autoHideMenuBar; }
  set autoHideMenuBar(value) { this.setAutoHideMenuBar(value); }

  // --- Family and platform extras -----------------------------------------------

  setParentWindow(parent) {
    this._parent = parent || null;
  }

  getParentWindow() {
    return this._parent;
  }

  getChildWindows() {
    return BrowserWindow.getAllWindows().filter((window) => window._parent === this);
  }

  setProgressBar() {}
  setOverlayIcon() {}
  setIcon() {}
  flashFrame() {}
  setSkipTaskbar() {}
  setHasShadow() {}
  hasShadow() { return true; }
  invalidateShadow() {}
  setShape() {}
  setThumbarButtons() { return false; }
  setThumbnailClip() {}
  setThumbnailToolTip() {}
  setAppDetails() {}
  setRepresentedFilename(file) { this._representedFilename = file; }
  getRepresentedFilename() { return this._representedFilename || ''; }
  setDocumentEdited(edited) { this._documentEdited = !!edited; }
  isDocumentEdited() { return !!this._documentEdited; }
  setVisibleOnAllWorkspaces() {}
  isVisibleOnAllWorkspaces() { return false; }
  setIgnoreMouseEvents() {}
  setContentProtection() {}
  isContentProtected() { return false; }
  setAutoHideCursor() {}
  setVibrancy() {}
  setBackgroundMaterial() {}
  setTrafficLightPosition() {}
  getTrafficLightPosition() { return { x: 0, y: 0 }; }
  setWindowButtonVisibility() {}
  setWindowButtonPosition() {}
  getWindowButtonPosition() { return null; }
  setTouchBar() {}
  setTitleBarOverlay() {}
  setSheetOffset() {}
  selectPreviousTab() {}
  selectNextTab() {}
  mergeAllWindows() {}
  moveTabToNewWindow() {}
  toggleTabBar() {}
  addTabbedWindow() {}
  showAllTabs() {}
  previewFile() {}
  closeFilePreview() {}
  hookWindowMessage() {}
  isWindowMessageHooked() { return false; }
  unhookWindowMessage() {}
  unhookAllWindowMessages() {}
  getMediaSourceId() { return `window:${this.id}:0`; }
  getNativeWindowHandle() { return Buffer.alloc(8); }
  setBrowserView() {}
  getBrowserView() { return null; }
  addBrowserView() { throw new Error('BrowserView is not available in Aurora'); }
  removeBrowserView() {}
  setTopBrowserView() {}
  getBrowserViews() { return []; }
  showDefinitionForSelection() {}
  get excludedFromShownWindowsMenu() { return false; }
  set excludedFromShownWindowsMenu(value) {}
  get accessibleTitle() { return this._title; }
  set accessibleTitle(value) {}
  get documentEdited() { return !!this._documentEdited; }
  set documentEdited(value) { this._documentEdited = !!value; }
  get representedFilename() { return this.getRepresentedFilename(); }
  set representedFilename(value) { this.setRepresentedFilename(value); }
  get visibleOnAllWorkspaces() { return false; }
  set visibleOnAllWorkspaces(value) {}
  get shadow() { return true; }
  set shadow(value) {}
  get snapped() { return false; }
  get tabbingIdentifier() { return undefined; }
}

module.exports = { BrowserWindow };
