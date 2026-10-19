'use strict';

// app: lifecycle, paths and single-instance locking. Quitting follows
// Electron: before-quit, then every window is closed (any may refuse), then
// will-quit and quit, and the process exits with the host.

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { state, createEvent, home, Emitter } = require('./common');

const children = new Set();

class CommandLine {
  constructor() {
    this.switches = new Map();
    this.arguments = [];
  }

  appendSwitch(name, value) { this.switches.set(String(name), value === undefined ? '' : String(value)); }
  appendArgument(value) { this.arguments.push(String(value)); }
  hasSwitch(name) { return this.switches.has(String(name)); }
  getSwitchValue(name) { return this.switches.get(String(name)) || ''; }
  removeSwitch(name) { this.switches.delete(String(name)); }
}

function windows() {
  return require('./browser-window').BrowserWindow.getAllWindows();
}

class App extends Emitter {
  constructor() {
    super();
    this.commandLine = new CommandLine();
    this._paths = {};
    this._quitting = false;
    this._exiting = false;
    this._badgeCount = 0;
    this._relaunch = null;
    this._lock = null;
    this._aboutOptions = {};
    this._accessibility = false;
    this.dock = undefined;
    this.runningUnderARM64Translation = false;
  }

  get name() { return this.getName(); }
  set name(value) { this.setName(value); }
  get isPackaged() { return state.appInfo.packaged; }
  get applicationMenu() { return require('./menu').Menu.getApplicationMenu(); }
  set applicationMenu(menu) { require('./menu').Menu.setApplicationMenu(menu); }
  get badgeCount() { return this._badgeCount; }
  set badgeCount(count) { this.setBadgeCount(count); }
  get userAgentFallback() { return state.userAgentFallback || require('./common').defaultUserAgent(); }
  set userAgentFallback(value) { state.userAgentFallback = value ? String(value) : null; }
  get accessibilitySupportEnabled() { return this._accessibility; }
  set accessibilitySupportEnabled(value) { this._accessibility = !!value; }

  getName() {
    return state.appInfo.productName || state.appInfo.name;
  }

  setName(name) {
    state.appInfo.productName = String(name);
  }

  getVersion() {
    return state.appInfo.version;
  }

  // Undocumented in Electron, but apps call it (Discord sets its host version).
  setVersion(version) {
    state.appInfo.version = String(version);
  }

  getAppPath() {
    return state.appInfo.appPath;
  }

  isReady() {
    return state.ready;
  }

  whenReady() {
    return state.readyPromise;
  }

  getPath(name) {
    if (this._paths[name])
      return this._paths[name];
    const userHome = home();
    const settings = (state.paths && state.paths.settings) || path.join(userHome, 'config', 'settings');
    switch (name) {
    case 'home': return userHome;
    case 'appData': return settings;
    case 'userData':
    case 'sessionData': return path.join(this.getPath('appData'), this.getName());
    case 'temp': return os.tmpdir();
    case 'exe': return process.execPath;
    case 'module': return process.execPath;
    case 'desktop': return (state.paths && state.paths.desktop) || path.join(userHome, 'Desktop');
    case 'documents': return userHome;
    case 'downloads': return (state.paths && state.paths.downloads) || path.join(userHome, 'Downloads');
    case 'music':
    case 'pictures':
    case 'videos': return userHome;
    case 'logs': return path.join(this.getPath('userData'), 'logs');
    case 'crashDumps': return path.join(this.getPath('userData'), 'Crashpad');
    case 'recent': return path.join(this.getPath('userData'), 'Recent');
    case 'cache': return (state.paths && state.paths.cache) || path.join(userHome, 'config', 'cache');
    default:
      throw new Error(`Failed to get '${name}' path`);
    }
  }

  setPath(name, value) {
    this._paths[name] = String(value);
  }

  setAppLogsPath(value) {
    this._paths.logs = value || this.getPath('logs');
  }

  getLocale() {
    const language = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '').split('.')[0];
    if (language && language !== 'C' && language !== 'POSIX')
      return language.replace('_', '-');
    try {
      return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
    } catch {
      return 'en-US';
    }
  }

  getSystemLocale() { return this.getLocale(); }
  getPreferredSystemLanguages() { return [this.getLocale()]; }
  getLocaleCountryCode() { return (this.getLocale().split('-')[1] || '').toUpperCase(); }

  // --- Quitting ---------------------------------------------------------------

  quit() {
    if (this._quitting || this._exiting)
      return;
    const event = createEvent();
    this.emit('before-quit', event);
    if (event.defaultPrevented)
      return;
    this._quitting = true;
    const open = windows();
    if (!open.length) {
      this._finishQuit();
      return;
    }
    for (const window of open)
      window.close();
    // A window that stayed open refuses the quit, as in Electron.
    setTimeout(() => {
      if (this._quitting && windows().some((window) => !window._closing && !window.isDestroyed()))
        this._quitting = false;
    }, 0);
  }

  _windowClosed() {
    if (windows().length)
      return;
    if (this._quitting) {
      this._finishQuit();
      return;
    }
    if (this._exiting)
      return;
    if (this.listenerCount('window-all-closed') > 0)
      this.emit('window-all-closed');
    else
      this.quit();
  }

  _finishQuit() {
    const event = createEvent();
    this.emit('will-quit', event);
    if (event.defaultPrevented) {
      this._quitting = false;
      return;
    }
    this.emit('quit', createEvent(), 0);
    this._shutdown(0);
  }

  exit(code = 0) {
    if (this._exiting)
      return;
    this._exiting = true;
    for (const window of windows())
      window.destroy();
    this._shutdown(code);
  }

  _shutdown(code) {
    this._exiting = true;
    if (this._lock)
      this._lock.release();
    for (const child of children) {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill('SIGTERM');
        } catch {}
      }
    }
    if (this._relaunch) {
      const { execPath, args } = this._relaunch;
      spawn(execPath, args, { detached: true, stdio: 'ignore', cwd: process.cwd(), env: process.env }).unref();
    }
    const finish = () => process.exit(code);
    if (state.host && !state.host.exited) {
      state.host.once('exit', finish);
      state.host.send('app.quit');
      setTimeout(finish, 4000).unref();
    } else {
      finish();
    }
  }

  relaunch(options = {}) {
    const args = options.args || process.argv.slice(1);
    this._relaunch = { execPath: options.execPath || process.execPath, args: [...process.execArgv, ...args] };
  }

  focus() {
    const { BrowserWindow } = require('./browser-window');
    const window = BrowserWindow.getFocusedWindow() || windows()[0];
    if (window)
      window.focus();
  }

  hide() {
    for (const window of windows())
      window.hide();
  }

  show() {
    for (const window of windows())
      window.show();
  }

  isHidden() {
    return windows().every((window) => !window.isVisible());
  }

  // --- Single instance ----------------------------------------------------------

  requestSingleInstanceLock(additionalData) {
    if (this._lock)
      return true;
    const directory = this.getPath('userData');
    fs.mkdirSync(directory, { recursive: true });
    const lockFile = path.join(directory, 'SingletonLock');
    const socketFile = path.join(os.tmpdir(), `aurora-${process.getuid ? process.getuid() : 0}-${this.getName().replace(/[^A-Za-z0-9_.-]/g, '_')}.sock`);
    let owner = null;
    try {
      owner = parseInt(fs.readFileSync(lockFile, 'utf8'), 10);
    } catch {}
    if (owner && owner !== process.pid) {
      let alive = false;
      try {
        process.kill(owner, 0);
        alive = true;
      } catch (error) {
        alive = error.code === 'EPERM';
      }
      if (alive) {
        // Tell the first instance, then let this one quit.
        const client = net.connect(socketFile);
        const pending = new Promise((resolve) => {
          client.on('connect', () => client.end(JSON.stringify({ argv: process.argv, cwd: process.cwd(), data: additionalData })));
          client.on('close', resolve);
          client.on('error', resolve);
        });
        this._singleInstanceMessage = pending;
        return false;
      }
    }
    fs.writeFileSync(lockFile, String(process.pid));
    try {
      fs.unlinkSync(socketFile);
    } catch {}
    const server = net.createServer((connection) => {
      let text = '';
      connection.setEncoding('utf8');
      connection.on('data', (chunk) => { text += chunk; });
      connection.on('end', () => {
        let message = {};
        try {
          message = JSON.parse(text);
        } catch {}
        this.emit('second-instance', createEvent(), message.argv || [], message.cwd || '', message.data);
      });
    });
    server.on('error', () => {});
    server.listen(socketFile);
    server.unref();
    this._lock = {
      release: () => {
        server.close();
        try {
          fs.unlinkSync(socketFile);
        } catch {}
        try {
          if (parseInt(fs.readFileSync(lockFile, 'utf8'), 10) === process.pid)
            fs.unlinkSync(lockFile);
        } catch {}
      },
    };
    return true;
  }

  hasSingleInstanceLock() {
    return !!this._lock;
  }

  releaseSingleInstanceLock() {
    if (this._lock) {
      this._lock.release();
      this._lock = null;
    }
  }

  // --- Everything else ------------------------------------------------------------

  setBadgeCount(count) {
    this._badgeCount = count || 0;
    return true;
  }

  getBadgeCount() {
    return this._badgeCount;
  }

  isUnityRunning() { return false; }
  addRecentDocument() {}
  clearRecentDocuments() {}
  getRecentDocuments() { return []; }
  // Links of a scheme open with the app's launcher (host: app.protocolClient),
  // which starts the app with the link: a second instance passes it to the
  // first through 'second-instance'. Only a packaged app has a launcher.
  setAsDefaultProtocolClient(protocol) {
    if (!state.host || !state.host.launcher)
      return false;
    this._protocolClients = this._protocolClients || new Set();
    this._protocolClients.add(String(protocol).toLowerCase());
    state.host.request('app.protocolClient', { scheme: String(protocol), op: 'set' }).catch(() => {});
    return true;
  }

  removeAsDefaultProtocolClient(protocol) {
    if (!this._protocolClients || !this._protocolClients.delete(String(protocol).toLowerCase()))
      return false;
    state.host.request('app.protocolClient', { scheme: String(protocol), op: 'remove' }).catch(() => {});
    return true;
  }

  isDefaultProtocolClient(protocol) {
    return !!this._protocolClients && this._protocolClients.has(String(protocol).toLowerCase());
  }
  getApplicationNameForProtocol() { return ''; }
  getApplicationInfoForProtocol() { return Promise.reject(new Error('Not available on Haiku')); }
  setUserTasks() { return false; }
  getJumpListSettings() { return { minItems: 0, removedItems: [] }; }
  setJumpList() {}
  setAppUserModelId() {}
  setActivationPolicy() {}
  setUserActivity() {}
  getCurrentActivityType() { return ''; }
  invalidateCurrentActivity() {}
  resignCurrentActivity() {}
  updateCurrentActivity() {}
  importCertificate(options, callback) { if (callback) callback(-1); }
  configureHostResolver() {}
  disableHardwareAcceleration() {}
  disableDomainBlockingFor3DAPIs() {}
  isHardwareAccelerationEnabled() { return true; }
  getAppMetrics() {
    const usage = process.cpuUsage();
    return [{ pid: process.pid, type: 'Browser', creationTime: Date.now() - process.uptime() * 1000,
      cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0, cumulativeCPUUsage: (usage.user + usage.system) / 1e6 },
      memory: { workingSetSize: Math.round(process.memoryUsage().rss / 1024), peakWorkingSetSize: 0 }, sandboxed: false }];
  }
  // Chromium's shapes: apps walk gpuDevice and read feature states. WebKit
  // composites with Mesa (llvmpipe), which Chromium would report as software.
  getGPUFeatureStatus() {
    const software = 'enabled';
    return { '2d_canvas': software, canvas_oop_rasterization: 'disabled_off', gpu_compositing: software,
      multiple_raster_threads: 'enabled_on', opengl: 'enabled_on', rasterization: software,
      raw_draw: 'disabled_off', skia_graphite: 'disabled_off', video_decode: 'unavailable_software',
      video_encode: 'unavailable_software', vulkan: 'disabled_off', webgl: software, webgl2: software, webgpu: 'disabled_off' };
  }
  getGPUInfo(infoType = 'basic') {
    const info = {
      auxAttributes: { amdSwitchable: false, canSupportThreadedTextureMailbox: false, glRenderer: 'llvmpipe',
        glVendor: 'Mesa', glVersion: '', inProcessGpu: true, optimus: false, sandboxed: false, softwareRendering: true },
      gpuDevice: [{ active: true, cudaComputeCapabilityMajor: 0, deviceId: 0, driverVendor: 'Mesa', driverVersion: '',
        gpuPreference: 0, revision: 0, subSysId: 0, vendorId: 0 }],
      machineModelName: '',
      machineModelVersion: '',
    };
    if (infoType === 'complete')
      Object.assign(info, { featureStatus: this.getGPUFeatureStatus(), videoDecodeAcceleratorSupportedProfile: [],
        videoEncodeAcceleratorSupportedProfile: [] });
    return Promise.resolve(info);
  }
  getLoginItemSettings() { return { openAtLogin: false, openAsHidden: false, wasOpenedAtLogin: false, wasOpenedAsHidden: false, restoreState: false, executableWillLaunchAtLogin: false, launchItems: [] }; }
  setLoginItemSettings() {}
  isAccessibilitySupportEnabled() { return this._accessibility; }
  setAccessibilitySupportEnabled(value) { this._accessibility = !!value; }
  setAboutPanelOptions(options) { this._aboutOptions = { ...options }; }
  showAboutPanel() {
    const options = this._aboutOptions;
    const name = options.applicationName || this.getName();
    const version = options.applicationVersion || this.getVersion();
    const detail = [options.copyright, options.credits, options.website].filter(Boolean).join('\n');
    require('./dialog').dialog.showMessageBox({ type: 'info', title: `About ${name}`, message: `${name} ${version}`, detail, buttons: ['OK'] });
  }
  isEmojiPanelSupported() { return false; }
  showEmojiPanel() {}
  startAccessingSecurityScopedResource() { return () => {}; }
  enableSandbox() {}
  isInApplicationsFolder() { return true; }
  moveToApplicationsFolder() { return false; }
  isSecureKeyboardEntryEnabled() { return false; }
  setSecureKeyboardEntryEnabled() {}
  setProxy(config) { return require('./session').session.defaultSession.setProxy(config); }
  resolveProxy(url) { return require('./session').session.defaultSession.resolveProxy(url); }
  setClientCertRequestPasswordHandler() {}
  getFileIcon() { return Promise.resolve(require('./native-image').nativeImage.createEmpty()); }
  setAppLogsPathIfNeeded() {}
}

const app = new App();

// Children the app starts are ended when it quits, as a crash or a relaunch
// would otherwise leave them (pgAdmin's Python server, for one) running.
function trackChildren() {
  const childProcess = require('child_process');
  const { promisify } = require('util');
  const track = (child, args) => {
    const options = args.find((value) => value && typeof value === 'object' && !Array.isArray(value)) || {};
    if (child && !options.detached) {
      children.add(child);
      child.once('exit', () => children.delete(child));
    }
  };
  for (const name of ['spawn', 'fork', 'execFile', 'exec']) {
    const original = childProcess[name];
    childProcess[name] = function tracked(...args) {
      const child = original.apply(this, args);
      track(child, args);
      return child;
    };
    // util.promisify(execFile) resolves to { stdout, stderr } through this.
    const custom = original[promisify.custom];
    if (typeof custom === 'function')
      Object.defineProperty(childProcess[name], promisify.custom, {
        value: function trackedPromise(...args) {
          const promise = custom.apply(this, args);
          track(promise.child, args);
          return promise;
        },
      });
  }
}

module.exports = { app, App, _windowClosed: () => app._windowClosed(), trackChildren };
