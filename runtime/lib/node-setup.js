'use strict';

// What makes plain Node.js look like Electron's Node.js, for the main
// process (main.js) and for utility processes (utility.js): the electron
// module, asar archives, the app's platform and native modules, fs.watch.

const fs = require('fs');
const Module = require('module');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const ELECTRON_NAMES = new Set(['electron', 'electron/main', 'electron/common', 'electron/renderer', 'electron/utility']);

function cacheRoot() {
  const home = process.env.HOME || '/boot/home';
  return path.join(home, 'config', 'cache', 'Aurora');
}

// What an app expects of the Electron it was built for, set by its launcher
// (aurora.json "env"):
// - AURORA_EXEC_PATH: process.execPath and app.getPath('exe'). Apps that
//   find their install from the executable (Discord's updater does) see the
//   launcher; Node.js children still start from the real node.
// - AURORA_PLATFORM: process.platform and os.platform(), for an app with no
//   case for "haiku" (Discord's Linux build is the nearest).
// - AURORA_NATIVE_SHIMS: a directory of JavaScript stand-ins for native
//   modules, <name>.js for <name>.node.
// Returns the path of Node.js itself.
function applyAppOverrides({ execPath = true } = {}) {
  completeEnvironment();
  const nodePath = process.execPath;
  if (execPath && process.env.AURORA_EXEC_PATH)
    process.execPath = path.resolve(process.env.AURORA_EXEC_PATH);
  const platform = process.env.AURORA_PLATFORM;
  if (platform) {
    Object.defineProperty(process, 'platform', { value: platform, enumerable: true, configurable: true });
    require('os').platform = () => platform;
  }
  installNativeModuleLoader(process.env.AURORA_NATIVE_SHIMS);
  installWatchFallback();
  return nodePath;
}

// An app the roster starts from a server (not from Deskbar or a shell) can
// have no PATH or HOME: the app's children (git, ssh, open) need both, as
// Haiku's shells set them (/boot/system/boot/SetupEnvironment).
function completeEnvironment() {
  if (!process.env.HOME) {
    // os.homedir() answers HOME itself while it is set, even empty.
    try {
      process.env.HOME = require('os').userInfo().homedir;
    } catch {
      process.env.HOME = '/boot/home';
    }
  }
  if (!process.env.PATH) {
    const home = process.env.HOME;
    process.env.PATH = [`${home}/config/non-packaged/bin`, `${home}/config/bin`, `${home}/config/apps`,
      '/boot/system/non-packaged/bin', '/bin', '/boot/system/apps', '/boot/system/preferences'].join(':');
  }
}

// Node.js has no fs.watch on Haiku (libuv answers ENOSYS). There a watched
// path is polled instead (fs.watchFile), through an FSWatcher-like emitter
// that reports 'change' when the path's status changes and 'rename' when it
// is replaced or removed.
function installWatchFallback() {
  const { EventEmitter } = require('events');
  const watch = fs.watch;
  if (watch.aurora)
    return;
  fs.watch = function auroraWatch(filename, options, listener) {
    try {
      return watch.apply(this, arguments);
    } catch (error) {
      if (error.code !== 'ENOSYS')
        throw error;
    }
    if (typeof options === 'function') {
      listener = options;
      options = {};
    } else if (typeof options === 'string') {
      options = { encoding: options };
    }
    options = options || {};
    const file = filename instanceof URL ? fileURLToPath(filename) : String(filename);
    const name = path.basename(file);
    const watcher = new EventEmitter();
    const changed = (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size && current.ino === previous.ino)
        return;
      watcher.emit('change', current.ino !== previous.ino || current.nlink === 0 ? 'rename' : 'change', name);
    };
    fs.watchFile(file, { interval: 500, persistent: options.persistent !== false }, changed);
    if (listener)
      watcher.on('change', listener);
    watcher.close = () => {
      fs.unwatchFile(file, changed);
      process.nextTick(() => watcher.emit('close'));
    };
    watcher.ref = () => watcher;
    watcher.unref = () => watcher;
    return watcher;
  };
  fs.watch.aurora = true;
  // fs.promises.watch: the same events as an async iterator.
  if (fs.promises && fs.promises.watch) {
    fs.promises.watch = async function* auroraWatchPromise(filename, options = {}) {
      const settings = typeof options === 'string' ? { encoding: options } : (options || {});
      const watcher = fs.watch(filename, { persistent: settings.persistent, recursive: settings.recursive,
        encoding: settings.encoding });
      const queue = [];
      let wake = null;
      watcher.on('change', (eventType, name) => {
        queue.push({ eventType, filename: name });
        if (wake)
          wake();
      });
      const signal = settings.signal;
      const abort = () => {
        watcher.close();
        if (wake)
          wake();
      };
      if (signal)
        signal.addEventListener('abort', abort, { once: true });
      try {
        while (!signal || !signal.aborted) {
          if (!queue.length)
            await new Promise((resolve) => { wake = resolve; });
          wake = null;
          while (queue.length)
            yield queue.shift();
        }
      } finally {
        watcher.close();
      }
    };
  }
}

// Native modules: a stand-in when the app ships one; then the module itself;
// then Aurora's own stand-in for a module that cannot load on Haiku
// (lib/shims: keytar). Otherwise a module built for another system (a Linux
// .node) fails as a missing module, which apps treat as optional, instead of
// as a crash.
function installNativeModuleLoader(shims) {
  const load = Module._extensions['.node'];
  if (load.aurora)
    return;
  const shimFor = (directory, filename) => {
    const shim = directory && path.join(directory, `${path.basename(filename, '.node')}.js`);
    return shim && fs.existsSync(shim) ? shim : null;
  };
  Module._extensions['.node'] = function loadNative(module, filename) {
    const appShim = shimFor(shims, filename);
    if (appShim) {
      module.exports = require(appShim);
      return;
    }
    try {
      return load(module, filename);
    } catch (error) {
      const ownShim = shimFor(path.join(__dirname, 'shims'), filename);
      if (ownShim) {
        module.exports = require(ownShim);
        return;
      }
      const missing = new Error(`Cannot find module '${filename}': it is not a native module for ${process.env.AURORA_PLATFORM || 'this system'} (${error.message})`);
      missing.code = 'MODULE_NOT_FOUND';
      throw missing;
    }
  };
  Module._extensions['.node'].aurora = true;
}

// require() into an .asar archive, which Electron reads in place (Discord's
// modules are "require('./core.asar')"): the archive is unpacked once into
// the cache, and the request resolves there.
function resolveAsar(request, parentFile) {
  if (typeof request !== 'string' || !/\.asar(\/|$)/.test(request))
    return null;
  const base = path.isAbsolute(request) ? request
    : (request.startsWith('.') && parentFile ? path.resolve(path.dirname(parentFile), request) : null);
  const match = base && base.match(/^(.*?\.asar)(\/.*)?$/);
  if (!match)
    return null;
  try {
    if (!fs.statSync(match[1]).isFile())
      return null;
  } catch {
    return null;
  }
  const unpacked = require('./asar').unpack(match[1], path.join(cacheRoot(), 'asar'));
  return match[2] ? path.join(unpacked, match[2]) : unpacked;
}

// require('electron') and import 'electron' load `cjsEntry` and `esmEntry`
// (the main process's or a utility process's electron module).
function installModuleHooks(cjsEntry, esmEntry) {
  const esmURL = pathToFileURL(esmEntry).href;
  if (typeof Module.registerHooks === 'function') {
    Module.registerHooks({
      resolve(specifier, context, nextResolve) {
        if (ELECTRON_NAMES.has(specifier)) {
          const wantsRequire = context.conditions && context.conditions.includes('require') && !context.conditions.includes('import');
          return wantsRequire
            ? { url: pathToFileURL(cjsEntry).href, format: 'commonjs', shortCircuit: true }
            : { url: esmURL, format: 'module', shortCircuit: true };
        }
        if (specifier === 'original-fs')
          return nextResolve('node:fs', context);
        const parent = context.parentURL && context.parentURL.startsWith('file:') ? fileURLToPath(context.parentURL) : null;
        const inAsar = resolveAsar(specifier, parent);
        if (inAsar)
          return nextResolve(inAsar, context);
        return nextResolve(specifier, context);
      },
    });
    return;
  }
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function resolveElectron(request, ...rest) {
    if (ELECTRON_NAMES.has(request))
      return cjsEntry;
    if (request === 'original-fs')
      return 'fs';
    const parent = rest[0];
    const inAsar = resolveAsar(request, parent && parent.filename);
    if (inAsar)
      return resolveFilename.call(this, inAsar, ...rest);
    return resolveFilename.call(this, request, ...rest);
  };
  if (typeof Module.register === 'function')
    Module.register(pathToFileURL(path.join(__dirname, 'loader.mjs')).href, { data: { electron: esmURL } });
}

module.exports = { cacheRoot, applyAppOverrides, completeEnvironment, installWatchFallback, installNativeModuleLoader,
  resolveAsar, installModuleHooks, ELECTRON_NAMES };
