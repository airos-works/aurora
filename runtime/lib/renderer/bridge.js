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
        if (builtinModules.includes(name) || name === 'original-fs') {
          dependencies[request] = -1;
          continue;
        }
        try {
          const resolved = require.resolve(request, { paths: [path.dirname(file)] });
          // A name that resolves to a builtin (an alias) is one too.
          if (!path.isAbsolute(resolved)) {
            dependencies[request] = -1;
            continue;
          }
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

    // Remote modules (electron/remote.js): Node.js for preloads that run
    // without Electron's sandbox, served by the main process.
    const remote = (() => {
      const proxies = new Map();          // handle -> WeakRef(proxy)
      const handles = new WeakMap();      // proxy or copied object -> handle
      const callbackIds = new WeakMap();  // page function -> id
      const callbacks = new Map();        // id -> page function
      const promises = new Map();         // handle -> { resolve, reject }
      const modules = new Map();
      let nextCallback = 1;
      let pending = [];
      const released = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry((handle) => {
        pending.push(handle);
        if (pending.length === 1)
          setTimeout(() => {
            const ids = pending;
            pending = [];
            post({ t: 'remote', op: 'release', ids }).catch(() => {});
          }, 1000);
      }) : null;

      function failure(value) {
        const error = decode(value);
        const result = error instanceof Error ? error : new Error(String(error));
        for (const key of ['code', 'errno', 'syscall', 'path'])
          if (value && value[key] !== undefined)
            result[key] = value[key];
        return result;
      }

      function request(body) {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', 'aurora-ipc://sync/', false);
        xhr.setRequestHeader('Content-Type', 'text/plain');
        body.t = 'remote';
        body.k = config.token;
        body.top = isTop;
        xhr.send(JSON.stringify(body));
        if (xhr.status !== 200)
          throw new Error(`Aurora: remote module request failed (${xhr.status})`);
        const reply = JSON.parse(xhr.responseText);
        if (reply.e)
          throw failure(reply.e);
        return fromMain(reply.v);
      }

      function proxyFor(handle, callable, name) {
        const existing = proxies.get(handle);
        const alive = existing && existing.deref();
        if (alive)
          return alive;
        const target = callable ? function () {} : {};
        const proxy = new Proxy(target, {
          get(object, key) {
            if (typeof key === 'symbol')
              return key === Symbol.toStringTag ? `Remote${callable ? 'Function' : 'Object'}` : undefined;
            if (callable && (key === 'call' || key === 'apply' || key === 'bind'))
              return Function.prototype[key];
            if (callable && key === 'name')
              return name;
            if (key === 'toString')
              return () => `[remote ${callable ? 'function' : 'object'} ${name || handle}]`;
            if (key === 'prototype')
              return object.prototype;
            return request({ op: 'get', h: handle, p: key });
          },
          set(object, key, value) {
            if (typeof key === 'symbol')
              return false;
            request({ op: 'set', h: handle, p: key, v: toMain(value) });
            return true;
          },
          has(object, key) {
            return typeof key === 'string' && request({ op: 'has', h: handle, p: key });
          },
          ownKeys(object) {
            const keys = request({ op: 'keys', h: handle });
            if (callable && !keys.includes('prototype'))
              keys.push('prototype');
            return keys;
          },
          getOwnPropertyDescriptor(object, key) {
            if (key === 'prototype' && callable)
              return Reflect.getOwnPropertyDescriptor(object, key);
            if (typeof key !== 'string' || !request({ op: 'has', h: handle, p: key }))
              return undefined;
            return { value: request({ op: 'get', h: handle, p: key }), writable: true, enumerable: true, configurable: true };
          },
          apply(object, self, args) {
            const target = self === undefined || self === null || self === window || self === globalThis ? null : toMain(self);
            return request({ op: 'apply', h: handle, s: target, a: args.map(toMain) });
          },
          construct(object, args) {
            return request({ op: 'construct', h: handle, a: args.map(toMain) });
          },
        });
        proxies.set(handle, new WeakRef(proxy));
        handles.set(proxy, handle);
        if (released)
          released.register(proxy, handle);
        return proxy;
      }

      // Main-process value -> page value.
      function fromMain(value) {
        if (value === null || typeof value !== 'object')
          return value;
        if (Array.isArray(value))
          return value.map(fromMain);
        switch (value.$a) {
        case 'rf':
          return proxyFor(value.h, true, value.n);
        case 'ro':
          return proxyFor(value.h, false, value.c);
        case 'rp':
          return new Promise((resolve, reject) => promises.set(value.h, { resolve, reject }));
        case 'o': {
          const result = {};
          for (const key of Object.keys(value.v))
            result[key] = fromMain(value.v[key]);
          if (value.h)
            handles.set(result, value.h);
          return result;
        }
        case 'arr':
          return value.v.map(fromMain);
        case 'e':
          return failure(value);
        default:
          return decode(value);
        }
      }

      // Page value -> what the main process decodes.
      function toMain(value) {
        if (typeof value === 'function') {
          if (handles.has(value))
            return { $a: 'h', h: handles.get(value) };
          let id = callbackIds.get(value);
          if (!id) {
            id = nextCallback++;
            callbackIds.set(value, id);
            callbacks.set(id, value);
          }
          return { $a: 'cb', i: id };
        }
        if (value === null || typeof value !== 'object')
          return encode(value);
        if (handles.has(value))
          return { $a: 'h', h: handles.get(value) };
        if (Array.isArray(value))
          return { $a: 'arr', v: value.map(toMain) };
        const tag = Object.prototype.toString.call(value).slice(8, -1);
        if (tag === 'Object') {
          const result = {};
          for (const key of Object.keys(value))
            result[key] = toMain(value[key]);
          return { $a: 'o', v: result };
        }
        return encode(value);
      }

      return {
        require(request, from) {
          const key = `${from}\u0000${request}`;
          if (!modules.has(key))
            modules.set(key, fromMainRequest(request, from));
          return modules.get(key);
        },
        dispatch(message) {
          if (message.settle !== undefined) {
            const waiting = promises.get(message.settle);
            if (!waiting)
              return;
            promises.delete(message.settle);
            if (message.ok)
              waiting.resolve(fromMain(message.v));
            else
              waiting.reject(failure(message.v));
          } else if (message.call !== undefined) {
            const callback = callbacks.get(message.call);
            if (callback)
              callback(...(message.a || []).map(fromMain));
          }
        },
      };
      function fromMainRequest(name, from) {
        return request({ op: 'require', r: name, f: from });
      }
    })();

    let zoomFactor = 1;
    Object.defineProperty(window, Symbol.for('aurora.dispatch'), {
      value(name, encodedArgs) {
        if (name === '\u0000zoom') {
          zoomFactor = encodedArgs;
          return;
        }
        if (name === '\u0000remote') {
          remote.dispatch(encodedArgs);
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
      argv: config.argv,
      execArgv: [],
      execPath: config.execPath,
      pid: config.pid,
      sandboxed: !config.remoteModules,
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
    // Without the sandbox, what the page's process lacks comes from the main
    // process (its environment, say), as a Node.js renderer would see it.
    let pageProcess = processShim;
    if (config.remoteModules) {
      let mainProcess = null;
      const main = () => (mainProcess || (mainProcess = remote.require('process', '/')));
      Object.defineProperty(processShim, 'env', { get: () => main().env, set() {}, configurable: true });
      pageProcess = new Proxy(processShim, {
        get(target, key) {
          if (typeof key === 'symbol' || key in target)
            return target[key];
          return main()[key];
        },
      });
    }

    const runtimeModules = {
      electron, 'electron/renderer': electron, 'electron/common': electron,
      events: EventEmitter,
      timers: { setTimeout, clearTimeout, setInterval, clearInterval,
        setImmediate: (callback, ...args) => setTimeout(callback, 0, ...args), clearImmediate: clearTimeout },
      url: { URL, URLSearchParams, fileURLToPath: (url) => decodeURIComponent(new URL(url).pathname),
        pathToFileURL: (file) => new URL(`file://${encodeURI(file)}`) },
      path: pathShim,
      buffer: { Buffer, constants: { MAX_LENGTH: 2 ** 32, MAX_STRING_LENGTH: 2 ** 29 - 24 }, kMaxLength: 2 ** 32,
        kStringMaxLength: 2 ** 29 - 24, atob, btoa, Blob: window.Blob, File: window.File },
      process: pageProcess,
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
          if (target === undefined || target < 0) {
            // Without Electron's sandbox a preload has all of Node.js.
            if (config.remoteModules)
              return remote.require(request, modules[index][0]);
            if (target === -1)
              throw new Error(`Aurora: module "${request}" is not available to preload scripts`);
            throw new Error(`Aurora: cannot find module "${request}"`);
          }
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
        factory.call(module.exports, module.exports, requireFrom(index), module, file, directory, pageProcess, Buffer, window);
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
        // WebKit's stack has no message line.
        const text = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error);
        post({ t: 'preload-error', m: text }).catch(() => {});
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
function buildBridgeScript({ preloadFiles = [], token, versions, resourcesPath, systemVersion, remoteModules = false, argv = [] }) {
  const config = {
    token,
    remoteModules,
    argv,
    execPath: process.execPath,
    pid: process.pid,
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
