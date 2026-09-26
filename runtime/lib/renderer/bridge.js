'use strict';

// Builds the script injected into pages at document start: Electron's
// renderer-side modules (ipcRenderer, contextBridge, webFrame, webUtils) and
// the window's preload scripts, bundled with the modules they require.
//
// Pages run in WebKit, not in a Node.js renderer, so preloads get what a
// sandboxed Electron preload gets: the electron renderer modules, events,
// timers, url, a small path and buffer, and their own files. Everything runs
// in the page's world; contextBridge.exposeInMainWorld defines the global.

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');
const { encodeSource, decodeSource } = require('../serialize');

const RUNTIME_MODULES = new Set(['electron', 'electron/renderer', 'electron/common', 'events', 'timers', 'url',
  'path', 'buffer', 'process', 'util']);

function normalizeBuiltin(request) {
  return request.startsWith('node:') ? request.slice(5) : request;
}

// A CommonJS bundle of a preload and the files it requires, for a page that
// has no Node.js to load them.
function bundle(entry) {
  const modules = [];
  const ids = new Map();
  function add(file) {
    if (ids.has(file))
      return ids.get(file);
    const id = modules.length;
    ids.set(file, id);
    modules.push(null);
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (error) {
      source = `throw new Error(${JSON.stringify(`Cannot read ${file}: ${error.message}`)});`;
    }
    const dependencies = {};
    if (file.endsWith('.json')) {
      source = `module.exports = ${source};`;
    } else {
      const pattern = /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;
      let match;
      while ((match = pattern.exec(source))) {
        const request = match[2];
        const name = normalizeBuiltin(request);
        if (RUNTIME_MODULES.has(name) || dependencies[request] !== undefined)
          continue;
        if (builtinModules.includes(name)) {
          dependencies[request] = -1;
          continue;
        }
        try {
          const resolved = require.resolve(request, { paths: [path.dirname(file)] });
          dependencies[request] = add(resolved);
        } catch {
          dependencies[request] = -2;
        }
      }
    }
    modules[id] = { file, source, dependencies };
    return id;
  }
  add(path.resolve(entry));
  return modules;
}

function bundleSource(entry) {
  const modules = bundle(entry);
  const parts = modules.map((module) =>
    `[${JSON.stringify(module.file)}, function (exports, require, module, __filename, __dirname, process, Buffer, global) {\n`
    + `${module.source}\n}, ${JSON.stringify(module.dependencies)}]`);
  return `[${parts.join(',\n')}]`;
}

// The part of the bridge that is the same in every page, as a function source.
function bridgeRuntime() {
  /* eslint-disable no-undef */
  return function auroraBridge(config, preloads, encode, decode) {
    'use strict';
    const marker = Symbol.for('aurora.bridge');
    if (window[marker])
      return;
    Object.defineProperty(window, marker, { value: true });
    // The engine's Safari-compatible identity says Mac, which makes apps map
    // shortcuts to Meta; on Haiku the Command key reaches pages as Control.
    try {
      if (/Mac/i.test(navigator.platform))
        Object.defineProperty(Navigator.prototype, 'platform', { get: () => config.navigatorPlatform, configurable: true });
    } catch {}
    const handlers = window.webkit && window.webkit.messageHandlers;
    const channel = handlers && handlers.aurora;
    const isTop = window === window.top;
    function post(message) {
      message.k = config.token;
      message.top = isTop;
      if (!channel)
        return Promise.reject(new Error('Aurora: this page cannot reach the main process'));
      return channel.postMessage(JSON.stringify(message));
    }

    class EventEmitter {
      constructor() {
        this._events = new Map();
      }
      on(name, listener) {
        if (!this._events.has(name))
          this._events.set(name, []);
        this._events.get(name).push(listener);
        return this;
      }
      addListener(name, listener) {
        return this.on(name, listener);
      }
      prependListener(name, listener) {
        if (!this._events.has(name))
          this._events.set(name, []);
        this._events.get(name).unshift(listener);
        return this;
      }
      once(name, listener) {
        const wrapper = (...args) => {
          this.removeListener(name, wrapper);
          listener.apply(this, args);
        };
        wrapper.listener = listener;
        return this.on(name, wrapper);
      }
      off(name, listener) {
        return this.removeListener(name, listener);
      }
      removeListener(name, listener) {
        const list = this._events.get(name);
        if (list) {
          const index = list.findIndex((item) => item === listener || item.listener === listener);
          if (index >= 0)
            list.splice(index, 1);
        }
        return this;
      }
      removeAllListeners(name) {
        if (name === undefined)
          this._events.clear();
        else
          this._events.delete(name);
        return this;
      }
      emit(name, ...args) {
        const list = this._events.get(name);
        if (!list || !list.length) {
          if (name === 'error')
            throw args[0];
          return false;
        }
        for (const listener of list.slice())
          listener.apply(this, args);
        return true;
      }
      listeners(name) {
        return (this._events.get(name) || []).map((item) => item.listener || item);
      }
      rawListeners(name) {
        return (this._events.get(name) || []).slice();
      }
      listenerCount(name) {
        return (this._events.get(name) || []).length;
      }
      eventNames() {
        return [...this._events.keys()];
      }
      setMaxListeners() {
        return this;
      }
      getMaxListeners() {
        return Infinity;
      }
    }
    EventEmitter.EventEmitter = EventEmitter;
    EventEmitter.default = EventEmitter;

    const ipcRenderer = new EventEmitter();
    ipcRenderer.send = (name, ...args) => {
      post({ t: 'send', ch: String(name), a: encode(args) }).catch(() => {});
    };
    ipcRenderer.invoke = (name, ...args) =>
      post({ t: 'invoke', ch: String(name), a: encode(args) }).then((text) => {
        const reply = JSON.parse(text);
        if (reply.ok)
          return decode(reply.v);
        const error = decode(reply.e);
        throw error instanceof Error ? error : new Error(String(error));
      });
    ipcRenderer.sendSync = (name, ...args) => {
      const request = new XMLHttpRequest();
      request.open('POST', 'aurora-ipc://sync/', false);
      request.setRequestHeader('Content-Type', 'text/plain');
      request.send(JSON.stringify({ t: 'sync', ch: String(name), a: encode(args), k: config.token, top: isTop }));
      if (request.status !== 200)
        throw new Error(`Aurora: synchronous IPC failed (${request.status})`);
      return decode(JSON.parse(request.responseText).v);
    };
    ipcRenderer.sendToHost = (name, ...args) => ipcRenderer.send(name, ...args);
    ipcRenderer.postMessage = (name, message) => ipcRenderer.send(name, message);

    let zoomFactor = 1;
    Object.defineProperty(window, Symbol.for('aurora.dispatch'), {
      value(name, encodedArgs) {
        if (name === '\u0000zoom') {
          zoomFactor = encodedArgs;
          return;
        }
        const args = decode(encodedArgs);
        ipcRenderer.emit(name, { sender: ipcRenderer, senderId: 0, ports: [] }, ...args);
      },
    });

    const contextBridge = {
      exposeInMainWorld(key, api) {
        Object.defineProperty(window, key, { value: api, enumerable: true, configurable: false, writable: false });
      },
      exposeInIsolatedWorld(worldId, key, api) {
        contextBridge.exposeInMainWorld(key, api);
      },
      executeInMainWorld({ func, args }) {
        return func(...(args || []));
      },
    };

    const webFrame = {
      routingId: 1,
      get top() {
        return webFrame;
      },
      setZoomFactor(factor) {
        zoomFactor = factor;
        post({ t: 'zoom', v: factor }).catch(() => {});
      },
      getZoomFactor() {
        return zoomFactor;
      },
      setZoomLevel(level) {
        webFrame.setZoomFactor(Math.pow(1.2, level));
      },
      getZoomLevel() {
        return Math.log(zoomFactor) / Math.log(1.2);
      },
      setVisualZoomLevelLimits() {},
      setSpellCheckProvider() {},
      insertCSS(css) {
        const style = document.createElement('style');
        style.textContent = css;
        const append = () => (document.head || document.documentElement).appendChild(style);
        if (document.documentElement)
          append();
        else
          document.addEventListener('DOMContentLoaded', append, { once: true });
        return String(Math.random());
      },
      removeInsertedCSS() {},
      executeJavaScript(code) {
        return Promise.resolve().then(() => (0, eval)(code));
      },
      getResourceUsage() {
        return {};
      },
      clearCache() {},
    };

    const webUtils = {
      getPathForFile(file) {
        return (file && file.path) || '';
      },
    };

    const Buffer = (function () {
      class AuroraBuffer extends Uint8Array {
        static from(value, encoding) {
          if (typeof value === 'string') {
            if (encoding === 'base64') {
              const binary = atob(value);
              const result = new AuroraBuffer(binary.length);
              for (let index = 0; index < binary.length; index++)
                result[index] = binary.charCodeAt(index);
              return result;
            }
            const bytes = new TextEncoder().encode(value);
            const result = new AuroraBuffer(bytes.length);
            result.set(bytes);
            return result;
          }
          if (value instanceof ArrayBuffer)
            return new AuroraBuffer(value);
          const result = new AuroraBuffer(value.length);
          result.set(value);
          return result;
        }
        static alloc(size) {
          return new AuroraBuffer(size);
        }
        static isBuffer(value) {
          return value instanceof AuroraBuffer;
        }
        static concat(list) {
          const total = list.reduce((sum, item) => sum + item.length, 0);
          const result = new AuroraBuffer(total);
          let offset = 0;
          for (const item of list) {
            result.set(item, offset);
            offset += item.length;
          }
          return result;
        }
        toString(encoding) {
          if (encoding === 'base64') {
            let text = '';
            for (let index = 0; index < this.length; index += 0x8000)
              text += String.fromCharCode.apply(null, this.subarray(index, index + 0x8000));
            return btoa(text);
          }
          return new TextDecoder().decode(this);
        }
      }
      return AuroraBuffer;
    })();

    const processShim = new EventEmitter();
    Object.assign(processShim, {
      type: 'renderer',
      platform: config.platform,
      arch: config.arch,
      versions: config.versions,
      env: {},
      argv: [],
      execArgv: [],
      pid: 0,
      sandboxed: true,
      contextIsolated: true,
      isMainFrame: isTop,
      resourcesPath: config.resourcesPath,
      cwd: () => '/',
      nextTick: (callback, ...args) => queueMicrotask(() => callback(...args)),
      hrtime: Object.assign((previous) => {
        const now = performance.now() * 1e6;
        const seconds = Math.floor(now / 1e9);
        const nanos = Math.floor(now % 1e9);
        return previous ? [seconds - previous[0], nanos - previous[1]] : [seconds, nanos];
      }, { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) }),
      getSystemVersion: () => config.systemVersion,
      getProcessMemoryInfo: () => Promise.resolve({}),
      getHeapStatistics: () => ({}),
      getCPUUsage: () => ({ percentCPUUsage: 0, idleWakeupsPerSecond: 0 }),
      crash() {},
      hang() {},
    });

    const pathShim = {
      sep: '/',
      delimiter: ':',
      basename(file, extension) {
        let base = String(file).replace(/\/+$/, '').split('/').pop();
        if (extension && base.endsWith(extension))
          base = base.slice(0, -extension.length);
        return base;
      },
      dirname(file) {
        const parts = String(file).replace(/\/+$/, '').split('/');
        parts.pop();
        return parts.join('/') || (String(file).startsWith('/') ? '/' : '.');
      },
      extname(file) {
        const base = pathShim.basename(file);
        const dot = base.lastIndexOf('.');
        return dot > 0 ? base.slice(dot) : '';
      },
      join(...parts) {
        return pathShim.normalize(parts.filter((part) => part !== '').join('/'));
      },
      normalize(file) {
        const absolute = String(file).startsWith('/');
        const result = [];
        for (const part of String(file).split('/')) {
          if (!part || part === '.')
            continue;
          if (part === '..' && result.length && result[result.length - 1] !== '..')
            result.pop();
          else if (part !== '..' || !absolute)
            result.push(part);
        }
        return (absolute ? '/' : '') + result.join('/') || (absolute ? '/' : '.');
      },
      resolve(...parts) {
        let result = '';
        for (const part of parts) {
          if (String(part).startsWith('/'))
            result = part;
          else if (part)
            result = result ? `${result}/${part}` : part;
        }
        return pathShim.normalize(result.startsWith('/') ? result : `/${result}`);
      },
      isAbsolute: (file) => String(file).startsWith('/'),
    };
    pathShim.posix = pathShim;

    const electron = {
      ipcRenderer, contextBridge, webFrame, webUtils,
      crashReporter: { start() {}, addExtraParameter() {}, removeExtraParameter() {}, getParameters: () => ({}) },
      nativeImage: { createEmpty: () => ({ isEmpty: () => true, toDataURL: () => '' }) },
      shell: { openExternal: (url) => ipcRenderer.invoke('\u0000shell.openExternal', url) },
    };
    const runtimeModules = {
      electron, 'electron/renderer': electron, 'electron/common': electron,
      events: EventEmitter,
      timers: { setTimeout, clearTimeout, setInterval, clearInterval,
        setImmediate: (callback, ...args) => setTimeout(callback, 0, ...args), clearImmediate: clearTimeout },
      url: { URL, URLSearchParams, fileURLToPath: (url) => decodeURIComponent(new URL(url).pathname),
        pathToFileURL: (file) => new URL(`file://${encodeURI(file)}`) },
      path: pathShim,
      buffer: { Buffer },
      process: processShim,
      util: { inspect: (value) => { try { return JSON.stringify(value); } catch { return String(value); } },
        promisify: (fn) => (...args) => new Promise((resolve, reject) => fn(...args, (error, value) => (error ? reject(error) : resolve(value)))) },
    };

    function load(modules) {
      const cache = new Map();
      function requireFrom(index) {
        return function require(request) {
          const name = request.startsWith('node:') ? request.slice(5) : request;
          if (Object.prototype.hasOwnProperty.call(runtimeModules, name))
            return runtimeModules[name];
          const target = modules[index][2][request];
          if (target === -1)
            throw new Error(`Aurora: module "${request}" is not available to preload scripts`);
          if (target === undefined || target < 0)
            throw new Error(`Aurora: cannot find module "${request}"`);
          return run(target);
        };
      }
      function run(index) {
        if (cache.has(index))
          return cache.get(index).exports;
        const [file, factory] = modules[index];
        const module = { exports: {}, id: file, filename: file, loaded: false };
        cache.set(index, module);
        const directory = file.slice(0, file.lastIndexOf('/')) || '/';
        factory.call(module.exports, module.exports, requireFrom(index), module, file, directory, processShim, Buffer, window);
        module.loaded = true;
        return module.exports;
      }
      return run(0);
    }

    for (const modules of preloads) {
      try {
        load(modules);
      } catch (error) {
        console.error('Aurora: the preload script failed:', error);
        post({ t: 'preload-error', m: String(error && error.stack || error) }).catch(() => {});
      }
    }

    if (isTop) {
      // The title as parsed: the engine reports it only after the load ends.
      const ready = () => post({ t: 'dom-ready', title: document.title }).catch(() => {});
      if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', ready, { once: true });
      else
        ready();
    }
  };
  /* eslint-enable no-undef */
}

// The complete script for a window. preloadFiles are absolute paths.
function buildBridgeScript({ preloadFiles = [], token, versions, resourcesPath, systemVersion }) {
  const config = {
    token,
    platform: process.platform,
    arch: process.arch,
    versions,
    resourcesPath,
    systemVersion,
    navigatorPlatform: `Haiku ${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`,
  };
  const preloads = preloadFiles.map(bundleSource);
  return `(${bridgeRuntime().toString()})(${JSON.stringify(config)}, [${preloads.join(',\n')}], (${encodeSource}), (${decodeSource}));`;
}

module.exports = { buildBridgeScript, bundle };
