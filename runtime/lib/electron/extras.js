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

// Tray: an icon in Deskbar's tray, which the host's aurora-tray add-on
// draws. As on Linux, a click is 'click' and a right click shows the context
// menu.
const trays = new Map();
let nextTrayId = 1;

function trayImage(image) {
  const { nativeImage, NativeImage } = require('./native-image');
  const value = typeof image === 'string' ? nativeImage.createFromPath(image) : image;
  return value instanceof NativeImage ? value : nativeImage.createEmpty();
}

class Tray extends Emitter {
  constructor(image, guid) {
    super();
    this._id = nextTrayId++;
    this._image = trayImage(image);
    this._destroyed = false;
    this._toolTip = '';
    this._title = '';
    this._menu = null;
    this._bounds = { x: 0, y: 0, width: 0, height: 0 };
    trays.set(this._id, this);
    this._command('tray.create', { icon: this._icon() });
  }

  _icon() {
    return this._image.isEmpty() ? '' : this._image.toPNG().toString('base64');
  }

  _command(name, fields = {}) {
    if (this._destroyed || !state.host)
      return;
    // A host without Deskbar items (or Deskbar not running): the tray stays
    // invisible, as on a Linux desktop without a status area.
    state.host.request(name, { id: this._id, ...fields }).catch(() => {});
  }

  // tray.click from the host.
  _clicked(message) {
    if (message.bounds)
      this._bounds = message.bounds;
    const event = createEvent({ altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, triggeredByAccelerator: false });
    const position = { x: message.x, y: message.y };
    if (message.button === 'right') {
      this.emit('right-click', event, this._bounds);
      if (this._menu)
        this.popUpContextMenu(this._menu, position);
    } else if (message.button === 'middle') {
      this.emit('middle-click', event, this._bounds);
    } else if (message.clicks === 2) {
      this.emit('double-click', event, this._bounds);
    } else {
      this.emit('click', event, this._bounds, position);
    }
  }

  destroy() {
    this._command('tray.destroy');
    this._destroyed = true;
    trays.delete(this._id);
  }

  isDestroyed() { return this._destroyed; }
  setImage(image) {
    this._image = trayImage(image);
    this._command('tray.set', { icon: this._icon() });
  }
  setPressedImage() {}
  setToolTip(toolTip) {
    this._toolTip = String(toolTip);
    this._command('tray.set', { toolTip: this._toolTip });
  }
  setTitle(title) { this._title = String(title); }
  getTitle() { return this._title; }
  setIgnoreDoubleClickEvents() {}
  getIgnoreDoubleClickEvents() { return false; }
  displayBalloon(options = {}) {
    if (!this._destroyed)
      new Notification({ title: options.title, body: options.content }).show();
  }
  removeBalloon() {}
  focus() {}
  popUpContextMenu(menu, position) {
    const target = menu || this._menu;
    if (target && !this._destroyed)
      target.popup({ screenPosition: position || null });
  }
  closeContextMenu() {}
  setContextMenu(menu) { this._menu = menu || null; }
  getBounds() { return { ...this._bounds }; }
  getGUID() { return null; }
}

function trayClicked(message) {
  trays.get(message.id)?._clicked(message);
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
  request: (options, callback) => require('./net-request').request(options, callback),
  resolveHost: (host) => require('dns').promises.lookup(host, { all: true }).then((addresses) => ({ endpoints: addresses })),
};

const netLog = {
  startLogging: () => Promise.resolve(),
  stopLogging: () => Promise.resolve(),
  get currentlyLogging() { return false; },
};

const { MessageChannelMain, MessagePortMain } = require('./message-ports');
const messagePorts = require('./message-ports');

// utilityProcess: a Node.js child (lib/utility.js) that looks like Electron's
// utility process. Its IPC channel carries process.parentPort's messages and
// the packets of the ports it holds.
function stdioFor(option) {
  const each = Array.isArray(option) ? option.slice(0, 3) : [option || 'inherit', option || 'inherit', option || 'inherit'];
  while (each.length < 3)
    each.push('inherit');
  return [...each.map((value) => (value === 'pipe' || value === 'ignore' || value === 'inherit' ? value : 'inherit')), 'ipc'];
}

// Chromium switches mean nothing to Node.js, which refuses unknown options.
function nodeOptions(execArgv) {
  const allowed = process.allowedNodeEnvironmentFlags;
  return (execArgv || []).filter((argument) => allowed.has(String(argument).split('=')[0]));
}

class UtilityProcess extends Emitter {
  constructor(modulePath, args, options) {
    super();
    const info = { electronVersion: state.appInfo.electronVersion, chromeVersion: state.appInfo.chromeVersion,
      auroraVersion: process.versions.aurora, resourcesPath: process.resourcesPath, serviceName: options.serviceName };
    const env = { ...(options.env || process.env), AURORA_UTILITY: JSON.stringify(info) };
    for (const name of ['AURORA_PLATFORM', 'AURORA_NATIVE_SHIMS']) {
      if (process.env[name] && env[name] === undefined)
        env[name] = process.env[name];
    }
    this._child = require('child_process').fork(path.join(__dirname, '..', 'utility.js'), [modulePath, ...args], {
      cwd: options.cwd, env, execArgv: nodeOptions(options.execArgv), stdio: stdioFor(options.stdio),
      serialization: 'advanced',
      // Node.js itself, not an app's launcher standing in for process.execPath.
      execPath: state.nodePath || process.execPath,
    });
    const child = this._child;
    this.pid = child.pid;
    this.stdout = child.stdout || null;
    this.stderr = child.stderr || null;
    this._link = messagePorts.createLink(`utility ${modulePath}`, (packet) => this._send({ $aurora: 'port', packet }));
    this._exited = false;
    child.on('spawn', () => {
      this.pid = child.pid;
      this.emit('spawn');
    });
    child.on('message', (message) => {
      if (!message || typeof message !== 'object')
        return;
      if (message.$aurora === 'parent')
        this.emit('message', message.data);
      else if (message.$aurora === 'port')
        messagePorts.receive(this._link, message.packet);
    });
    child.on('error', (error) => {
      if (!this.pid)
        this.emit('error', 'FatalError', modulePath, String(error && error.message || error));
    });
    child.on('exit', (code, signal) => {
      if (this._exited)
        return;
      this._exited = true;
      this.pid = undefined;
      this._link.gone();
      this.emit('exit', typeof code === 'number' ? code : (signal ? 1 : 0));
    });
  }

  _send(message) {
    if (this._exited || !this._child.connected)
      return;
    try {
      this._child.send(message);
    } catch (error) {
      process.stderr.write(`[aurora] cannot send to a utility process: ${error.message}\n`);
    }
  }

  postMessage(message, transfer = []) {
    for (const port of transfer || []) {
      if (!(port instanceof MessagePortMain))
        throw new TypeError('Only MessagePortMain objects can be transferred');
    }
    this._send({ $aurora: 'parent', data: message, ports: (transfer || []).map((port) => port._sendTo(this._link)) });
  }

  kill() {
    if (this._exited)
      return false;
    return this._child.kill('SIGTERM');
  }
}

const utilityProcess = {
  fork(modulePath, args = [], options = {}) {
    return new UtilityProcess(String(modulePath), (args || []).map(String), options || {});
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
  Notification, Tray, trayClicked, globalShortcut, powerMonitor, powerSaveBlocker, systemPreferences, autoUpdater,
  crashReporter, contentTracing, safeStorage, net, netLog, MessageChannelMain, MessagePortMain, utilityProcess,
  webFrameMain, desktopCapturer, BrowserView, WebContentsView, View, ImageView, TouchBar, ShareMenu,
};
