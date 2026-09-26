'use strict';

// The electron module for the main process, and the routing of aurora-host's
// events to the objects they concern.

const { state, createEvent } = require('./common');
const { app } = require('./app');
const { BrowserWindow } = require('./browser-window');
const { WebContents } = require('./web-contents');
const { ipcMain } = require('./ipc-main');
const { Menu, MenuItem, menuClicked, popupClosed } = require('./menu');
const { dialog } = require('./dialog');
const { shell } = require('./shell');
const { clipboard, screen, nativeTheme } = require('./system');
const { nativeImage, NativeImage } = require('./native-image');
const { session } = require('./session');
const { protocol, schemeRequest } = require('./protocol');
const extras = require('./extras');

const electron = {
  app,
  autoUpdater: extras.autoUpdater,
  BaseWindow: BrowserWindow,
  BrowserView: extras.BrowserView,
  BrowserWindow,
  clipboard,
  contentTracing: extras.contentTracing,
  crashReporter: extras.crashReporter,
  desktopCapturer: extras.desktopCapturer,
  dialog,
  globalShortcut: extras.globalShortcut,
  ImageView: extras.ImageView,
  inAppPurchase: undefined,
  ipcMain,
  Menu,
  MenuItem,
  MessageChannelMain: extras.MessageChannelMain,
  MessagePortMain: extras.MessagePortMain,
  nativeImage,
  NativeImage,
  nativeTheme,
  net: extras.net,
  netLog: extras.netLog,
  Notification: extras.Notification,
  powerMonitor: extras.powerMonitor,
  powerSaveBlocker: extras.powerSaveBlocker,
  protocol,
  pushNotifications: undefined,
  safeStorage: extras.safeStorage,
  screen,
  session,
  ShareMenu: extras.ShareMenu,
  shell,
  systemPreferences: extras.systemPreferences,
  TouchBar: extras.TouchBar,
  Tray: extras.Tray,
  utilityProcess: extras.utilityProcess,
  View: extras.View,
  webContents: {
    getAllWebContents: WebContents.getAllWebContents,
    getFocusedWebContents: WebContents.getFocusedWebContents,
    fromId: WebContents.fromId,
    fromFrame: WebContents.fromFrame,
    fromDevToolsTargetId: WebContents.fromDevToolsTargetId,
  },
  WebContentsView: extras.WebContentsView,
  webFrameMain: extras.webFrameMain,
};

// --- window.open() and middle-click links ------------------------------------

function openWindow(opener, details, newPageRequest) {
  const contents = opener.webContents;
  let result = { action: 'allow' };
  if (contents._windowOpenHandler) {
    try {
      result = contents._windowOpenHandler(details) || { action: 'deny' };
    } catch (error) {
      process.stderr.write(`[aurora] setWindowOpenHandler threw: ${error.stack || error}\n`);
      result = { action: 'deny' };
    }
  }
  if (result.action !== 'allow')
    return null;
  const override = result.overrideBrowserWindowOptions || {};
  const inherited = opener._options.webPreferences || {};
  const options = {
    width: details.width || opener.getBounds().width,
    height: details.height || opener.getBounds().height,
    ...override,
    webPreferences: { ...inherited, ...(override.webPreferences || {}) },
  };
  if (details.x !== undefined && override.x === undefined) {
    options.x = details.x;
    options.y = details.y;
  }
  const child = new BrowserWindow(options, newPageRequest
    ? { newPageRequest, inheritScriptsFrom: opener.id, bridgeToken: opener._bridgeToken }
    : {});
  if (result.outlivesOpener === false)
    opener.once('closed', () => child.isDestroyed() || child.close());
  contents.emit('did-create-window', child, details);
  return child;
}

function newPageRequested(message) {
  const opener = state.windows.get(message.id);
  if (!opener) {
    state.host.send('newpage.decline', { identifier: message.identifier });
    return;
  }
  const details = {
    url: message.url,
    frameName: '',
    features: message.popup ? 'popup' : '',
    disposition: message.popup ? 'new-window' : 'foreground-tab',
    referrer: { url: opener.webContents.getURL(), policy: 'strict-origin-when-cross-origin' },
    postBody: undefined,
    width: message.width,
    height: message.height,
    x: message.x,
    y: message.y,
  };
  const child = openWindow(opener, details, message.identifier);
  if (!child)
    state.host.send('newpage.decline', { identifier: message.identifier });
}

function linkOpenRequested(message) {
  const opener = state.windows.get(message.id);
  if (!opener || !message.url)
    return;
  const details = { url: message.url, frameName: '', features: '', disposition: 'background-tab',
    referrer: { url: opener.webContents.getURL(), policy: 'strict-origin-when-cross-origin' } };
  const child = openWindow(opener, details, 0);
  if (child)
    child.loadURL(message.url);
}

// --- Context menus -------------------------------------------------------------

function contextMenuRequested(message) {
  const window = state.windows.get(message.id);
  if (!window)
    return;
  const contents = window.webContents;
  const selection = message.selected_text || '';
  const editable = !!message.isEditable;
  const media = message.image_url ? 'image' : message.media_url ? 'video' : 'none';
  const params = {
    x: Math.round(message.x), y: Math.round(message.y),
    frame: contents.mainFrame,
    linkURL: message.link_url || '', linkText: message.link_label || '',
    pageURL: contents.getURL(), frameURL: message.frame_url || contents.getURL(),
    srcURL: message.image_url || message.media_url || '', mediaType: media, hasImageContents: media === 'image',
    isEditable: editable, selectionText: selection, titleText: '', altText: '', suggestedFilename: '',
    selectionRect: { x: Math.round(message.x), y: Math.round(message.y), width: 0, height: 0 },
    selectionStartOffset: 0, referrerPolicy: { url: contents.getURL(), policy: 'strict-origin-when-cross-origin' },
    misspelledWord: '', dictionarySuggestions: [], frameCharset: 'UTF-8', formControlType: editable ? 'input-text' : 'none',
    spellcheckEnabled: false, menuSourceType: 'mouse',
    mediaFlags: { inError: false, isPaused: false, isMuted: false, hasAudio: false, isLooping: false, isControlsVisible: false,
      canToggleControls: false, canPrint: false, canSave: false, canShowPictureInPicture: false, isShowingPictureInPicture: false, canRotate: false, canLoop: false },
    editFlags: { canUndo: editable, canRedo: editable, canCut: editable && !!selection, canCopy: !!selection,
      canPaste: editable, canDelete: editable && !!selection, canSelectAll: true, canEditRichly: editable },
  };
  if (contents.listenerCount('context-menu') > 0) {
    contents.emit('context-menu', createEvent(), params);
    return;
  }
  if (process.env.AURORA_DEFAULT_CONTEXT_MENU === '0')
    return;
  // Electron shows nothing here; a Haiku user expects at least these.
  const template = [];
  if (params.linkURL)
    template.push({ label: 'Open Link in Browser', click: () => shell.openExternal(params.linkURL) },
      { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) }, { type: 'separator' });
  if (editable)
    template.push({ role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
  else if (selection)
    template.push({ role: 'copy' }, { role: 'selectAll' });
  else
    template.push({ label: 'Back', enabled: contents.canGoBack(), click: () => contents.goBack() },
      { label: 'Forward', enabled: contents.canGoForward(), click: () => contents.goForward() },
      { role: 'reload' }, { type: 'separator' }, { role: 'selectAll' });
  Menu.buildFromTemplate(template).popup({ window });
}

// --- Downloads --------------------------------------------------------------------

const downloads = new Map();

class DownloadItem extends require('./common').Emitter {
  constructor(message) {
    super();
    this._message = message;
    this._state = 'progressing';
    this._savePath = '';
    this._paused = false;
    this._startTime = Date.now() / 1000;
  }

  getURL() { return this._message.url; }
  getURLChain() { return [this._message.url]; }
  getFilename() { return this._message.filename || require('path').basename(this._message.path || this._message.url); }
  getMimeType() { return ''; }
  getTotalBytes() { return Math.max(0, this._message.total || 0); }
  getReceivedBytes() { return this._message.received || 0; }
  getState() { return this._state; }
  getSavePath() { return this._savePath || this._message.path || ''; }
  setSavePath(file) { this._savePath = String(file); }
  getSaveDialogOptions() { return this._dialogOptions || {}; }
  setSaveDialogOptions(options) { this._dialogOptions = options; }
  getContentDisposition() { return ''; }
  getETag() { return ''; }
  getLastModifiedTime() { return ''; }
  getStartTime() { return this._startTime; }
  getEndTime() { return this._endTime || 0; }
  getCurrentBytesPerSecond() { return 0; }
  getPercentComplete() { const total = this.getTotalBytes(); return total ? Math.round(100 * this.getReceivedBytes() / total) : 0; }
  hasUserGesture() { return true; }
  isPaused() { return this._paused; }
  pause() { this._paused = true; }
  resume() { this._paused = false; }
  canResume() { return false; }
  cancel() { state.host.send('download.cancel', { identifier: this._message.identifier }); }
}

function downloadEvent(message) {
  let item = downloads.get(message.identifier);
  if (message.type === 'started' || !item) {
    if (item)
      return;
    item = new DownloadItem(message);
    downloads.set(message.identifier, item);
    const window = message.window !== undefined ? state.windows.get(message.window) : BrowserWindow.getFocusedWindow();
    const event = createEvent();
    session.defaultSession.emit('will-download', event, item, window ? window.webContents : null);
    if (event.defaultPrevented)
      item.cancel();
    if (message.type === 'started')
      return;
  }
  item._message = { ...item._message, ...message, filename: message.filename || item._message.filename };
  if (message.type === 'progress') {
    item.emit('updated', createEvent(), 'progressing');
    return;
  }
  downloads.delete(message.identifier);
  item._endTime = Date.now() / 1000;
  item._state = message.state || 'interrupted';
  const finish = () => item.emit('done', createEvent(), item._state);
  if (item._state === 'completed' && item._savePath && message.path && item._savePath !== message.path) {
    require('fs').promises.rename(message.path, item._savePath)
      .catch(() => require('fs').promises.copyFile(message.path, item._savePath).then(() => require('fs').promises.unlink(message.path)))
      .catch(() => { item._state = 'interrupted'; })
      .finally(finish);
  } else {
    finish();
  }
}

// --- Wiring --------------------------------------------------------------------

function contentsOf(message) {
  return state.webContents.get(message.id);
}

function attachHost(host) {
  host.on('window.event', (message) => state.windows.get(message.id)?._windowEvent(message));
  host.on('window.close-requested', (message) => state.windows.get(message.id)?._closeRequested(message));
  host.on('window.close-cancelled', (message) => state.windows.get(message.id)?._closeCancelled());
  host.on('window.closed', (message) => state.windows.get(message.id)?._closed());
  host.on('wc.state', (message) => contentsOf(message)?._state(message));
  host.on('wc.crashed', (message) => contentsOf(message)?._crashedEvent(message));
  host.on('wc.new-page', newPageRequested);
  host.on('wc.link-open', linkOpenRequested);
  host.on('wc.link-hover', (message) => contentsOf(message)?.emit('update-target-url', createEvent(), message.url));
  host.on('wc.favicon', (message) => message.iconURL && contentsOf(message)?.emit('page-favicon-updated', createEvent(), [message.iconURL]));
  host.on('wc.find-result', (message) => {
    const contents = contentsOf(message);
    if (contents)
      contents.emit('found-in-page', createEvent(), { requestId: contents._findRequest || 0, activeMatchOrdinal: message.found ? 1 : 0,
        matches: message.found ? 1 : 0, selectionArea: { x: 0, y: 0, width: 0, height: 0 }, finalUpdate: true });
  });
  host.on('wc.context-menu', contextMenuRequested);
  host.on('wc.will-prevent-unload', (message) => {
    const contents = contentsOf(message);
    if (!contents)
      return;
    const event = createEvent();
    contents.emit('will-prevent-unload', event);
    if (event.defaultPrevented)
      contents._forceLastNavigation();
  });
  host.on('ipc.message', (message) => {
    const contents = contentsOf(message);
    if (contents)
      contents._ipcMessage(message);
    else
      host.send('ipc.reply', { token: message.token, error: 'The window is gone' });
  });
  host.on('scheme.request', schemeRequest);
  host.on('menu.click', menuClicked);
  host.on('menu.closed', popupClosed);
  host.on('clipboard.changed', (message) => { state.clipboard = message.clipboard || state.clipboard; });
  host.on('theme.changed', (message) => {
    state.darkMode = !!message.darkMode;
    nativeTheme.emit('updated');
  });
  host.on('download', downloadEvent);
  host.on('app.quit-requested', () => app.quit());
  host.on('app.open-file', (message) => app.emit('open-file', createEvent(), message.path));
}

module.exports = { electron, attachHost };
