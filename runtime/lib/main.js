'use strict';

// aurora: runs an Electron app on Haiku. Node.js is the main process; the
// app's windows are aurora-host's, drawn by the system WebKit engine.
//
//   aurora [options] <app directory | app.asar | main script> [app arguments]

const fs = require('fs');
const Module = require('module');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const AURORA_VERSION = require('../package.json').version;
const DEFAULT_ELECTRON_VERSION = '43.4.0';
const ELECTRON_NAMES = new Set(['electron', 'electron/main', 'electron/common', 'electron/renderer', 'electron/utility']);

function usage(stream = process.stdout) {
  stream.write(`Aurora ${AURORA_VERSION}: Electron apps on Haiku\n\n`
    + 'Usage: aurora [options] <app directory | app.asar | main script> [app arguments]\n\n'
    + 'Options:\n'
    + '  --dev                 Run as an unpackaged app (app.isPackaged is false)\n'
    + '  --electron-version V  The Electron version to report (default: from the app)\n'
    + '  --host PATH           The aurora-host executable\n'
    + '  --webkit PATH         The WebKit engine bundle directory\n'
    + '  --user-data-dir PATH  Where the app keeps its settings\n'
    + '  --version             Print the version and exit\n');
}

function parseArguments(argv) {
  const options = { dev: false, appArgs: [] };
  let index = 0;
  for (; index < argv.length; index++) {
    const argument = argv[index];
    const [name, inline] = argument.startsWith('--') ? argument.split(/=(.*)/s) : [argument];
    const value = () => (inline !== undefined ? inline : argv[++index]);
    if (name === '--help' || name === '-h') {
      usage();
      process.exit(0);
    } else if (name === '--version' || name === '-v') {
      process.stdout.write(`${AURORA_VERSION}\n`);
      process.exit(0);
    } else if (name === '--dev') {
      options.dev = true;
    } else if (name === '--electron-version') {
      options.electronVersion = value();
    } else if (name === '--host') {
      process.env.AURORA_HOST = value();
    } else if (name === '--webkit') {
      process.env.AURORA_WEBKIT_BUNDLE = value();
    } else if (name === '--user-data-dir') {
      options.userDataDir = value();
    } else if (argument === '--') {
      index++;
      break;
    } else if (argument.startsWith('-')) {
      // Chromium switches (--disable-gpu and so on) mean nothing here.
      continue;
    } else {
      break;
    }
  }
  options.target = argv[index];
  options.appArgs = argv.slice(index + 1);
  return options;
}

function electronVersionOf(manifest) {
  const declared = (manifest.devDependencies && manifest.devDependencies.electron)
    || (manifest.dependencies && manifest.dependencies.electron) || '';
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(declared);
  return match ? `${match[1]}.${match[2] || 0}.${match[3] || 0}` : DEFAULT_ELECTRON_VERSION;
}

// Recent Electron majors track Chromium two majors apart (43 ships 150).
function chromeVersionFor(electronVersion) {
  const major = parseInt(electronVersion, 10) || 43;
  return `${major >= 20 ? major * 2 + 64 : major + 84}.0.0.0`;
}

function cacheRoot() {
  const home = process.env.HOME || '/boot/home';
  return path.join(home, 'config', 'cache', 'Aurora');
}

// Finds the app: a directory with package.json, a packaged resources layout,
// an app.asar, or a single main script.
function resolveApp(target) {
  if (!target)
    return null;
  let location = path.resolve(target);
  if (!fs.existsSync(location))
    throw new Error(`No app at ${location}`);
  let resourcesPath = null;
  let main = null;
  const stat = fs.statSync(location);
  if (stat.isFile() && location.endsWith('.asar')) {
    resourcesPath = path.dirname(location);
    location = require('./asar').unpack(location, path.join(cacheRoot(), 'asar'));
  } else if (stat.isFile()) {
    main = location;
    location = path.dirname(location);
  } else if (!fs.existsSync(path.join(location, 'package.json'))) {
    for (const candidate of ['resources/app', 'resources/app.asar', 'app', 'app.asar']) {
      const file = path.join(location, candidate);
      if (!fs.existsSync(file))
        continue;
      resourcesPath = path.dirname(file);
      location = candidate.endsWith('.asar') ? require('./asar').unpack(file, path.join(cacheRoot(), 'asar')) : file;
      break;
    }
  }
  let manifest = {};
  const manifestFile = path.join(location, 'package.json');
  if (fs.existsSync(manifestFile))
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (!main) {
    main = path.resolve(location, manifest.main || 'index.js');
    if (!fs.existsSync(main) && fs.existsSync(`${main}.js`))
      main = `${main}.js`;
  }
  if (!resourcesPath)
    resourcesPath = path.basename(location) === 'app' ? path.dirname(location) : location;
  return { appPath: location, main, manifest, resourcesPath };
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
function applyAppOverrides() {
  const { state } = require('./electron/common');
  state.nodePath = process.execPath;
  if (process.env.AURORA_EXEC_PATH)
    process.execPath = path.resolve(process.env.AURORA_EXEC_PATH);
  const platform = process.env.AURORA_PLATFORM;
  if (platform) {
    Object.defineProperty(process, 'platform', { value: platform, enumerable: true, configurable: true });
    require('os').platform = () => platform;
  }
  installNativeModuleLoader(process.env.AURORA_NATIVE_SHIMS);
}

// Native modules: a stand-in when the app ships one; then the module itself;
// then Aurora's own stand-in for a module that cannot load on Haiku
// (lib/shims: keytar). Otherwise a module built for another system (a Linux
// .node) fails as a missing module, which apps treat as optional, instead of
// as a crash.
function installNativeModuleLoader(shims) {
  const load = Module._extensions['.node'];
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

function installModuleHooks() {
  const cjsEntry = path.join(__dirname, 'electron', 'electron.js');
  const esmEntry = pathToFileURL(path.join(__dirname, 'electron', 'esm.mjs')).href;
  if (typeof Module.registerHooks === 'function') {
    Module.registerHooks({
      resolve(specifier, context, nextResolve) {
        if (ELECTRON_NAMES.has(specifier)) {
          const wantsRequire = context.conditions && context.conditions.includes('require') && !context.conditions.includes('import');
          return wantsRequire
            ? { url: pathToFileURL(cjsEntry).href, format: 'commonjs', shortCircuit: true }
            : { url: esmEntry, format: 'module', shortCircuit: true };
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
    Module.register(pathToFileURL(path.join(__dirname, 'loader.mjs')).href);
}

function setDefaultApplicationMenu() {
  const { Menu } = require('./electron/menu');
  if (Menu._applicationMenuSet)
    return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
}

// A development aid: AURORA_REPL=/path/to/socket evaluates each line sent to
// that UNIX socket as an async expression, with `electron` in scope, and
// answers one JSON line. tools/aurora-repl.js is a client.
function startRepl(socketPath, electron) {
  const net = require('net');
  const util = require('util');
  try {
    fs.unlinkSync(socketPath);
  } catch {}
  const server = net.createServer((connection) => {
    let buffer = '';
    connection.setEncoding('utf8');
    connection.on('data', async (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let answer;
        try {
          const evaluate = new Function('electron', 'require', `return (async () => (${line}))();`);
          const value = await evaluate(electron, require);
          answer = { ok: true, value: util.inspect(value, { depth: 4, breakLength: 160 }) };
        } catch (error) {
          answer = { ok: false, error: String(error && error.stack || error) };
        }
        connection.write(`${JSON.stringify(answer)}\n`);
      }
    });
  });
  server.listen(socketPath);
  server.unref();
}

function start() {
  const options = parseArguments(process.argv.slice(2));
  let app;
  try {
    app = resolveApp(options.target);
  } catch (error) {
    process.stderr.write(`aurora: ${error.message}\n`);
    process.exit(1);
  }
  if (!app) {
    usage(process.stderr);
    process.exit(2);
  }

  const { state, createEvent } = require('./electron/common');
  const electronVersion = options.electronVersion || electronVersionOf(app.manifest);
  state.appInfo = {
    name: app.manifest.name || path.basename(app.appPath),
    productName: app.manifest.productName || null,
    version: app.manifest.version || electronVersion,
    appPath: app.appPath,
    electronVersion,
    chromeVersion: chromeVersionFor(electronVersion),
    packaged: !options.dev,
  };
  state.launchArgs = process.argv.slice(1);
  process.versions.electron = electronVersion;
  process.versions.chrome = state.appInfo.chromeVersion;
  process.versions.aurora = AURORA_VERSION;
  process.type = 'browser';
  process.resourcesPath = app.resourcesPath;
  applyAppOverrides();
  process.defaultApp = options.dev || undefined;
  process.argv = options.dev
    ? [process.execPath, app.appPath, ...options.appArgs]
    : [process.execPath, ...options.appArgs];
  process.env.ELECTRON_NO_ATTACH_CONSOLE = '1';

  installModuleHooks();
  const { electron, attachHost } = require('./electron');
  const { trackChildren } = require('./electron/app');
  const { Host } = require('./host');
  const electronApp = electron.app;
  if (options.userDataDir)
    electronApp.setPath('userData', path.resolve(options.userDataDir));
  trackChildren();

  // A packaged app's host is its own executable with its own signature (see
  // docs/PACKAGING.md); otherwise the host keeps the one in its resources.
  const auroraOptions = app.manifest.aurora || {};
  const host = new Host({ signature: process.env.AURORA_SIGNATURE || auroraOptions.signature });
  state.host = host;
  attachHost(host);
  host.once('ready', async (info) => {
    state.readyInfo = info;
    state.screens = info.screens || [];
    state.darkMode = !!info.darkMode;
    state.clipboard = info.clipboard || state.clipboard;
    state.paths = info.paths || {};
    if (!info.engine)
      process.stderr.write(`aurora: the WebKit engine did not start: ${info.engineError}\n`);
    if (!info.embedding)
      process.stderr.write('aurora: this WebKit build has no embedding interfaces; preload scripts and IPC will not work\n');
    const userData = electronApp.getPath('userData');
    fs.mkdirSync(userData, { recursive: true });
    try {
      await host.request('init', { userDataPath: userData, name: electronApp.getName(), downloadsPath: electronApp.getPath('downloads') });
    } catch (error) {
      process.stderr.write(`aurora: the host did not accept its settings: ${error.message}\n`);
    }
    state.ready = true;
    electronApp.emit('will-finish-launching');
    electronApp.emit('ready', createEvent(), {});
    state.resolveReady();
    state.readyPromise.then(() => setImmediate(setDefaultApplicationMenu));
  });
  host.on('exit', ({ code, signal, error }) => {
    if (electronApp._exiting)
      return;
    process.stderr.write(`aurora: the window host ${error ? `could not start: ${error.message}` : `exited (${signal || code})`}\n`);
    process.exit(typeof code === 'number' && code ? code : 1);
  });
  host.start();

  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => electronApp.quit());
  // Electron's main process reports rejections nobody handled and carries on;
  // plain Node.js would end the app.
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`aurora: unhandled promise rejection: ${reason && reason.stack || reason}\n`);
  });
  if (process.env.AURORA_REPL)
    startRepl(process.env.AURORA_REPL, electron);

  const isModule = app.main.endsWith('.mjs') || (app.manifest.type === 'module' && !app.main.endsWith('.cjs'));
  if (isModule) {
    import(pathToFileURL(app.main).href).catch((error) => {
      process.stderr.write(`aurora: the app failed to start:\n${error && error.stack || error}\n`);
      electronApp.exit(1);
    });
  } else {
    try {
      require(app.main);
    } catch (error) {
      process.stderr.write(`aurora: the app failed to start:\n${error && error.stack || error}\n`);
      electronApp.exit(1);
    }
  }
}

start();
