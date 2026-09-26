'use strict';

// The smaller Electron modules: notifications, tray, power, updater and the
// rest. Several have no Haiku counterpart yet and do what Electron does on a
// platform without the feature.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { state, createEvent, Emitter } = require('./common');

class Notification extends Emitter {
  constructor(options = {}) {
    super();
    this.title = options.title || '';
    this.subtitle = options.subtitle || '';
    this.body = options.body || '';
    this.silent = !!options.silent;
    this.icon = options.icon;
    this.urgency = options.urgency || 'normal';
    this.timeoutType = options.timeoutType || 'default';
    this.actions = options.actions || [];
    this.closeButtonText = options.closeButtonText || '';
    this.toastXml = options.toastXml;
    this.hasReply = false;
    this._tag = `aurora-notification-${crypto.randomBytes(6).toString('hex')}`;
  }

  static isSupported() {
    return true;
  }

  show() {
    state.host.send('notification.show', { title: this.title, body: [this.subtitle, this.body].filter(Boolean).join('\n'), tag: this._tag });
    setImmediate(() => this.emit('show', createEvent()));
  }

  close() {
    this.emit('close', createEvent());
  }
}

class Tray extends Emitter {
  constructor(image, guid) {
    super();
    this._image = image;
    this._destroyed = false;
    this._toolTip = '';
    this._title = '';
    this._menu = null;
  }

  destroy() { this._destroyed = true; }
  isDestroyed() { return this._destroyed; }
  setImage(image) { this._image = image; }
  setPressedImage() {}
  setToolTip(toolTip) { this._toolTip = String(toolTip); }
  setTitle(title) { this._title = String(title); }
  getTitle() { return this._title; }
  setIgnoreDoubleClickEvents() {}
  getIgnoreDoubleClickEvents() { return false; }
  displayBalloon() {}
  removeBalloon() {}
  focus() {}
  popUpContextMenu(menu) { (menu || this._menu) && (menu || this._menu).popup(); }
  closeContextMenu() {}
  setContextMenu(menu) { this._menu = menu; }
  getBounds() { return { x: 0, y: 0, width: 0, height: 0 }; }
  getGUID() { return null; }
}

const globalShortcut = {
  register() { return false; },
  registerAll() {},
  isRegistered() { return false; },
  unregister() {},
  unregisterAll() {},
};

const powerMonitor = new Emitter();
Object.assign(powerMonitor, {
  getSystemIdleState: () => 'active',
  getSystemIdleTime: () => 0,
  getCurrentThermalState: () => 'nominal',
  isOnBatteryPower: () => false,
  get onBatteryPower() { return false; },
});

let nextBlocker = 1;
const blockers = new Set();
const powerSaveBlocker = {
  start() { const id = nextBlocker++; blockers.add(id); return id; },
  stop(id) { return blockers.delete(id); },
  isStarted(id) { return blockers.has(id); },
};

const systemPreferences = new Emitter();
Object.assign(systemPreferences, {
  getAccentColor: () => '4a90d9ff',
  getColor: () => '#000000',
  getSystemColor: () => '#000000',
  getMediaAccessStatus: () => 'granted',
  askForMediaAccess: () => Promise.resolve(true),
  isAeroGlassEnabled: () => false,
  isDarkMode: () => state.darkMode,
  isInvertedColorScheme: () => false,
  isHighContrastColorScheme: () => false,
  getAnimationSettings: () => ({ shouldRenderRichAnimation: true, scrollAnimationsEnabledBySystem: true, prefersReducedMotion: false }),
  getUserDefault: () => undefined,
  setUserDefault() {},
  removeUserDefault() {},
  canPromptTouchID: () => false,
  promptTouchID: () => Promise.reject(new Error('Touch ID is not available')),
  isTrustedAccessibilityClient: () => false,
  subscribeNotification: () => 0,
  unsubscribeNotification() {},
  subscribeLocalNotification: () => 0,
  unsubscribeLocalNotification() {},
  subscribeWorkspaceNotification: () => 0,
  unsubscribeWorkspaceNotification() {},
  postNotification() {},
  postLocalNotification() {},
  postWorkspaceNotification() {},
  getEffectiveAppearance: () => (state.darkMode ? 'dark' : 'light'),
  get accessibilityDisplayShouldReduceTransparency() { return false; },
});

const autoUpdater = new Emitter();
let feedURL = '';
Object.assign(autoUpdater, {
  setFeedURL(options) { feedURL = typeof options === 'string' ? options : (options && options.url) || ''; },
  getFeedURL: () => feedURL,
  checkForUpdates() {
    setImmediate(() => autoUpdater.emit('error', new Error('Automatic updates are not available in Aurora; use the Haiku package manager')));
  },
  quitAndInstall() { require('./app').app.quit(); },
});

const crashReporter = {
  start() {},
  getLastCrashReport: () => null,
  getUploadedReports: () => [],
  getUploadToServer: () => false,
  setUploadToServer() {},
  addExtraParameter() {},
  removeExtraParameter() {},
  getParameters: () => ({}),
  getCrashesDirectory: () => require('./app').app.getPath('crashDumps'),
};

const contentTracing = {
  getCategories: () => Promise.resolve([]),
  startRecording: () => Promise.resolve(),
  stopRecording: () => Promise.resolve(''),
  getTraceBufferUsage: () => Promise.resolve({ value: 0, percentage: 0 }),
};

// safeStorage: AES-256-GCM with a per-user key kept in a mode 600 file in
// Aurora's settings. That is weaker than a system keychain, which Haiku does
// not offer to Node.js programs yet, but keeps data unreadable in backups.
function storageKey() {
  const directory = path.join(require('./app').app.getPath('appData'), 'Aurora');
  const file = path.join(directory, 'safe-storage.key');
  try {
    return fs.readFileSync(file);
  } catch {}
  fs.mkdirSync(directory, { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

const safeStorage = {
  isEncryptionAvailable: () => true,
  isAsyncEncryptionAvailable: () => Promise.resolve(true),
  getSelectedStorageBackend: () => 'basic_text',
  setUsePlainTextEncryption() {},
  encryptString(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', storageKey(), iv);
    const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from('au1'), iv, cipher.getAuthTag(), data]);
  },
  decryptString(buffer) {
    const input = Buffer.from(buffer);
    if (input.subarray(0, 3).toString() !== 'au1')
      throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', storageKey(), input.subarray(3, 15));
    decipher.setAuthTag(input.subarray(15, 31));
    return Buffer.concat([decipher.update(input.subarray(31)), decipher.final()]).toString('utf8');
  },
  encryptStringAsync(text) { return Promise.resolve(safeStorage.encryptString(text)); },
  decryptStringAsync(buffer) { return Promise.resolve({ shouldReEncrypt: false, result: safeStorage.decryptString(buffer) }); },
};

const net = {
  fetch: (...args) => require('./protocol').netFetch(...args),
  isOnline: () => true,
  get online() { return true; },
  request(options) {
    const url = new URL(typeof options === 'string' ? options : options.url || `${options.protocol || 'https:'}//${options.hostname || options.host}${options.path || '/'}`);
    const module = url.protocol === 'http:' ? require('http') : require('https');
    const request = module.request(url, { method: (options && options.method) || 'GET', headers: (options && options.headers) || {} });
    request.chunkedEncoding = false;
    return request;
  },
  resolveHost: (host) => require('dns').promises.lookup(host, { all: true }).then((addresses) => ({ endpoints: addresses })),
};

const netLog = {
  startLogging: () => Promise.resolve(),
  stopLogging: () => Promise.resolve(),
  get currentlyLogging() { return false; },
};

class MessagePortMain extends Emitter {
  constructor() {
    super();
    this._other = null;
    this._started = false;
    this._queue = [];
  }

  postMessage(message) {
    const other = this._other;
    if (!other)
      return;
    const event = { data: message, ports: [] };
    if (other._started)
      setImmediate(() => other.emit('message', event));
    else
      other._queue.push(event);
  }

  start() {
    this._started = true;
    for (const event of this._queue.splice(0))
      setImmediate(() => this.emit('message', event));
  }

  close() {
    const other = this._other;
    this._other = null;
    if (other) {
      other._other = null;
      other.emit('close');
    }
    this.emit('close');
  }
}

class MessageChannelMain {
  constructor() {
    this.port1 = new MessagePortMain();
    this.port2 = new MessagePortMain();
    this.port1._other = this.port2;
    this.port2._other = this.port1;
  }
}

// utilityProcess: a Node.js child with a message port, as fork gives.
const utilityProcess = {
  fork(modulePath, args = [], options = {}) {
    const child = require('child_process').fork(modulePath, args, {
      cwd: options.cwd, env: options.env || process.env, execArgv: options.execArgv, stdio: options.stdio === 'pipe' ? 'pipe' : 'inherit',
      serialization: 'advanced',
    });
    const handle = new Emitter();
    Object.assign(handle, {
      pid: child.pid,
      stdout: child.stdout || null,
      stderr: child.stderr || null,
      postMessage: (message) => child.send(message),
      kill: () => child.kill(),
    });
    child.on('spawn', () => handle.emit('spawn'));
    child.on('message', (data) => handle.emit('message', data));
    child.on('exit', (code) => handle.emit('exit', code));
    return handle;
  },
};

const webFrameMain = {
  fromId: () => null,
  fromFrameToken: () => null,
};

const desktopCapturer = {
  getSources: () => Promise.resolve([]),
};

class Unsupported {
  constructor() {
    throw new Error(`${new.target.name} is not available in Aurora yet`);
  }
}

class BrowserView extends Unsupported {}
class WebContentsView extends Unsupported {}
class View extends Unsupported {}
class ImageView extends Unsupported {}

class TouchBar {
  constructor() {}
}
for (const name of ['TouchBarButton', 'TouchBarColorPicker', 'TouchBarGroup', 'TouchBarLabel', 'TouchBarPopover',
  'TouchBarScrubber', 'TouchBarSegmentedControl', 'TouchBarSlider', 'TouchBarSpacer', 'TouchBarOtherItemsProxy'])
  TouchBar[name] = class {};

class ShareMenu {
  popup() {}
  closePopup() {}
}

module.exports = {
  Notification, Tray, globalShortcut, powerMonitor, powerSaveBlocker, systemPreferences, autoUpdater,
  crashReporter, contentTracing, safeStorage, net, netLog, MessageChannelMain, MessagePortMain, utilityProcess,
  webFrameMain, desktopCapturer, BrowserView, WebContentsView, View, ImageView, TouchBar, ShareMenu,
};
