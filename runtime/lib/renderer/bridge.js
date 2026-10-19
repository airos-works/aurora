'use strict';

// Builds the script injected into pages at document start: Electron's
// renderer-side modules (ipcRenderer, contextBridge, webFrame, webUtils) and
// the window's preload scripts, bundled with the modules they require.
//
// Pages run in WebKit, not in a Node.js renderer, so preloads get what a
// sandboxed Electron preload gets: the electron renderer modules, events,
// timers, url, a small path and buffer, and their own files. Everything runs
// in the page's world; contextBridge.exposeInMainWorld defines the global.
//
// Without the sandbox (sandbox: false, nodeIntegration) a page also gets the
// pure-JavaScript Node.js modules in its own world (node-polyfills.js:
// Buffer, streams, events, util...) and every other module from the main
// process (electron/remote.js). With nodeIntegration and no
// contextIsolation, the page's own scripts get require(), module, process,
// Buffer, global, setImmediate and __dirname, as in Electron.

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');
const { encodeSource, decodeSource } = require('../serialize');
const nodePolyfills = require('./node-polyfills');

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
  return function auroraBridge(config, preloads, encode, decode, nodePolyfills) {
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

    // setImmediate without the clamp of nested timers: a message to a
    // channel of the page's own, as fast as Node.js's.
    const immediates = new Map();
    let nextImmediate = 1;
    // A page function that throws when the main process (or setImmediate)
    // calls it: WebKit would report only "Script error." for a throw out of
    // this script, so without the sandbox the renderer's process hears it
    // with its details, as in Electron.
    function reportUncaught(error) {
      if (!config.remoteModules)
        throw error;
      try {
        if (processShim.listenerCount('uncaughtException') > 0) {
          processShim.emit('uncaughtException', error, 'uncaughtException');
          return;
        }
      } catch (handlerError) {
        error = handlerError;
      }
      console.error('Uncaught', error);
    }

    const runImmediate = (id) => {
      const entry = immediates.get(id);
      if (!entry)
        return;
      immediates.delete(id);
      try {
        entry.callback(...entry.args);
      } catch (error) {
        reportUncaught(error);
      }
    };
    const immediateChannel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
    if (immediateChannel)
      immediateChannel.port1.onmessage = (event) => runImmediate(event.data);
    class Immediate {
      constructor(id) {
        this._id = id;
      }
      ref() {
        return this;
      }
      unref() {
        return this;
      }
      hasRef() {
        return true;
      }
      [Symbol.toPrimitive]() {
        return this._id;
      }
    }
    function setImmediateShim(callback, ...args) {
      const id = nextImmediate++;
      immediates.set(id, { callback, args });
      if (immediateChannel)
        immediateChannel.port2.postMessage(id);
      else
        setTimeout(runImmediate, 0, id);
      return new Immediate(id);
    }
    function clearImmediateShim(immediate) {
      if (immediate !== undefined && immediate !== null)
        immediates.delete(typeof immediate === 'object' ? immediate._id : immediate);
    }

    // The page's own Node.js modules (node-polyfills.js), without the sandbox.
    let node = null;

    // Remote modules (electron/remote.js): Node.js for pages and preloads that
    // run without Electron's sandbox, served by the main process.
    const remote = (() => {
      const proxies = new Map();          // handle -> WeakRef(proxy)
      const handles = new WeakMap();      // proxy or copied object -> handle
      const copies = new Map();           // handle -> live copies of that object
      const callbackIds = new WeakMap();  // page function -> id
      const callbacks = new Map();        // id -> page function
      const promises = new Map();         // handle -> { resolve, reject }
      const emitters = new Map();         // handle -> emitter or stream that has not closed
      const records = new WeakMap();      // emitter proxy -> its state
      const signalIds = new WeakMap();    // page AbortSignal -> id
      const modules = new Map();
      const electronModules = new Map();
      let nextCallback = 1;
      let nextSignal = 1;
      let pending = [];
      let unacknowledged = [];

      function isAlive(handle) {
        const proxy = proxies.get(handle);
        return (proxy && proxy.deref()) || copies.has(handle) || emitters.has(handle);
      }
      const released = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry(({ handle, copy }) => {
        if (copy) {
          const count = (copies.get(handle) || 1) - 1;
          if (count > 0) {
            copies.set(handle, count);
            return;
          }
          copies.delete(handle);
        }
        if (isAlive(handle))
          return;
        pending.push(handle);
        if (pending.length === 1)
          setTimeout(() => {
            // A handle that came back meanwhile stays.
            const ids = pending.filter((id) => !isAlive(id));
            pending = [];
            if (ids.length)
              asyncRequest({ op: 'release', ids });
          }, 1000);
      }) : null;

      function asyncRequest(body) {
        body.t = 'remote';
        post(body).catch(() => {});
      }

      function failure(value) {
        const error = decode(value);
        const result = error instanceof Error ? error : new Error(String(error));
        if (value && typeof value === 'object')
          for (const key of Object.keys(value))
            if (!['$a', 'name', 'message', 'stack'].includes(key))
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

      const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
      function proxyFor(handle, callable, name, custom) {
        const existing = proxies.get(handle);
        const alive = existing && existing.deref();
        if (alive)
          return alive;
        const target = callable ? function () {} : {};
        const proxy = new Proxy(target, {
          get(object, key) {
            if (typeof key === 'symbol') {
              if (custom && (key === promisifyCustom || (node && key === node.util.promisify.custom)))
                return proxyFor(custom, true, `${name}[promisify.custom]`);
              return key === Symbol.toStringTag ? `Remote${callable ? 'Function' : 'Object'}` : undefined;
            }
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
          released.register(proxy, { handle, copy: false });
        return proxy;
      }

      // fs.Stats and fs.Dirent arrive as data, with their methods here.
      const S_IFMT = 0o170000;
      class Stats {
        constructor(fields) {
          for (const key of Object.keys(fields))
            this[key] = decode(fields[key]);
          for (const name of ['atime', 'mtime', 'ctime', 'birthtime'])
            this[name] = new Date(Number(this[`${name}Ms`]));
        }
        isFile() { return (Number(this.mode) & S_IFMT) === 0o100000; }
        isDirectory() { return (Number(this.mode) & S_IFMT) === 0o040000; }
        isSymbolicLink() { return (Number(this.mode) & S_IFMT) === 0o120000; }
        isFIFO() { return (Number(this.mode) & S_IFMT) === 0o010000; }
        isSocket() { return (Number(this.mode) & S_IFMT) === 0o140000; }
        isCharacterDevice() { return (Number(this.mode) & S_IFMT) === 0o020000; }
        isBlockDevice() { return (Number(this.mode) & S_IFMT) === 0o060000; }
      }
      class Dirent {
        constructor(fields) {
          this.name = decode(fields.name);
          this.parentPath = fields.parentPath;
          this.path = fields.path;
          Object.defineProperty(this, '_type', { value: fields.t });
        }
        isFile() { return this._type === 'f'; }
        isDirectory() { return this._type === 'd'; }
        isSymbolicLink() { return this._type === 'l'; }
        isFIFO() { return this._type === 'p'; }
        isSocket() { return this._type === 's'; }
        isCharacterDevice() { return this._type === 'c'; }
        isBlockDevice() { return this._type === 'b'; }
      }

      // Event emitters and streams of the main process: an EventEmitter or a
      // stream of the page, which hears the events it listens for, plus the
      // main object's other members. One stays alive until the main object
      // closes, since a page may keep only its listeners (spawn().on('exit')).
      const STREAM_LOCAL = new Set(['data', 'end', 'close', 'error', 'finish', 'prefinish', 'drain', 'pipe', 'unpipe',
        'readable', 'pause', 'resume', 'newListener', 'removeListener']);
      const EMITTER_LOCAL = new Set(['error', 'close', 'newListener', 'removeListener']);
      // A stream's state is the page's: these never ask the main process, even
      // where the page's side lacks them (a Writable's readable members).
      const STREAM_KEYS = new Set(['readable', 'writable', 'destroyed', 'closed', 'errored', 'allowHalfOpen',
        'readableEnded', 'readableFlowing', 'readableLength', 'readableObjectMode', 'readableHighWaterMark',
        'readableAborted', 'readableDidRead', 'readableEncoding', 'writableEnded', 'writableFinished', 'writableLength',
        'writableObjectMode', 'writableHighWaterMark', 'writableCorked', 'writableNeedDrain', 'writableAborted',
        'read', 'setEncoding', 'pause', 'resume', 'isPaused', 'unpipe', 'unshift', 'wrap', 'push', 'cork', 'uncork',
        'setDefaultEncoding']);

      function emitterFor(value) {
        const existing = proxies.get(value.h);
        const alive = existing && existing.deref();
        if (alive)
          return alive;
        const handle = value.h;
        const record = { handle, isStream: value.$a === 'st', readable: !!value.r, subscribed: new Set(), flowing: false,
          ended: false, closed: false, proxy: null, target: null };
        const target = record.isStream ? streamTarget(record, value) : new node.events.EventEmitter();
        record.target = target;
        const local = record.isStream ? STREAM_LOCAL : EMITTER_LOCAL;
        target.on('newListener', (name) => {
          if (typeof name !== 'string' || local.has(name) || record.subscribed.has(name))
            return;
          record.subscribed.add(name);
          asyncRequest({ op: 'sub', h: handle, n: name });
        });
        // Members whose names start with _ are the page object's own.
        const own = (object, key) => typeof key === 'symbol' || key in object || key.startsWith('_')
          || (record.isStream && STREAM_KEYS.has(key));
        const proxy = new Proxy(target, {
          get(object, key, receiver) {
            if (own(object, key))
              return Reflect.get(object, key, receiver);
            if (key === 'then' || key === 'toJSON')
              return undefined;
            return request({ op: 'get', h: handle, p: key });
          },
          set(object, key, item, receiver) {
            if (own(object, key))
              return Reflect.set(object, key, item, receiver);
            request({ op: 'set', h: handle, p: key, v: toMain(item) });
            return true;
          },
          has(object, key) {
            return own(object, key) ? key in object : request({ op: 'has', h: handle, p: key });
          },
        });
        record.proxy = proxy;
        records.set(proxy, record);
        proxies.set(handle, new WeakRef(proxy));
        handles.set(proxy, handle);
        emitters.set(handle, proxy);
        // The main process holds this object's events until the page has run
        // the code that received it, and has said what it listens for.
        unacknowledged.push(handle);
        if (unacknowledged.length === 1)
          setTimeout(() => {
            const ids = unacknowledged;
            unacknowledged = [];
            asyncRequest({ op: 'ack', ids });
          }, 0);
        return proxy;
      }

      function streamTarget(record, value) {
        const { Duplex, Readable, Writable } = node.stream;
        const handle = record.handle;
        // The main stream ends itself when it is done (destroying it after
        // end() could drop what it has not written yet): the page's side
        // closes when the main one does.
        const options = {
          decodeStrings: false,
          autoDestroy: false,
          destroy(error, callback) {
            if (!record.closed)
              asyncRequest({ op: 'destroy', h: handle, e: error ? encode(error) : null });
            callback(error);
          },
        };
        if (value.r)
          options.read = () => {
            if (!record.flowing) {
              record.flowing = true;
              asyncRequest({ op: 'flow', h: handle });
            }
          };
        if (value.w) {
          options.write = (chunk, encoding, callback) => {
            try {
              request({ op: 'write', h: handle, v: toMain(chunk), e: typeof chunk === 'string' ? encoding : undefined });
            } catch (error) {
              callback(error);
              return;
            }
            callback();
          };
          options.final = (callback) => {
            try {
              request({ op: 'end', h: handle });
            } catch (error) {
              callback(error);
              return;
            }
            callback();
          };
        }
        const Base = value.r && value.w ? Duplex : value.r ? Readable : Writable;
        return new Base(options);
      }

      function emitterEvent(record, name, args) {
        const target = record.target;
        // An error the page does not listen for was the main process's to
        // handle (execFile handles its child's): it must not throw here.
        const unheard = name === 'error' && target.listenerCount('error') === 0;
        if (!record.isStream) {
          if (name === 'close')
            settle(record);
          if (!unheard)
            target.emit(name, ...args);
          return;
        }
        switch (name) {
        case 'data':
          if (record.readable && !target.destroyed)
            target.push(args[0]);
          break;
        case 'end':
          record.ended = true;
          if (record.readable && !target.destroyed)
            target.push(null);
          break;
        case 'error':
          record.closed = true;
          target.destroy(unheard ? undefined : args[0]);
          break;
        case 'close':
          record.closed = true;
          settle(record);
          if (target.destroyed)
            break;
          // What was read but not consumed stays readable.
          if (record.readable && target.readable) {
            if (!record.ended)
              target.push(null);
            target.once('end', () => target.destroy());
          } else {
            target.destroy();
          }
          break;
        default:
          target.emit(name, ...args);
        }
      }

      // A closed emitter is the page's to keep or to let go.
      function settle(record) {
        if (emitters.get(record.handle) !== record.proxy)
          return;
        emitters.delete(record.handle);
        if (released)
          released.register(record.proxy, { handle: record.handle, copy: false });
      }

      function signalFor(signal) {
        let id = signalIds.get(signal);
        if (!id) {
          id = nextSignal++;
          signalIds.set(signal, id);
          if (!signal.aborted)
            signal.addEventListener('abort', () => asyncRequest({ op: 'abort', i: id, r: toMain(signal.reason) }), { once: true });
        }
        return signal.aborted ? { $a: 'sig', i: id, ab: true, r: toMain(signal.reason) } : { $a: 'sig', i: id };
      }

      // Main-process value -> page value.
      function fromMain(value) {
        if (value === null || typeof value !== 'object')
          return value;
        if (Array.isArray(value))
          return value.map(fromMain);
        switch (value.$a) {
        case 'rf':
          return proxyFor(value.h, true, value.n, value.pc);
        case 'ro':
          return proxyFor(value.h, false, value.c);
        case 'ee':
        case 'st':
          return node ? emitterFor(value) : proxyFor(value.h, false, value.c);
        case 'rp':
          return new Promise((resolve, reject) => promises.set(value.h, { resolve, reject }));
        case 'buf':
          return node ? node.buffer.Buffer.from(value.v, 'base64') : decode({ $a: 'ta', t: 'Uint8Array', v: value.v });
        case 'stats':
          return new Stats(value.v);
        case 'dirent':
          return new Dirent(value.v);
        case 'o': {
          const result = {};
          for (const key of Object.keys(value.v))
            result[key] = fromMain(value.v[key]);
          if (value.h) {
            handles.set(result, value.h);
            copies.set(value.h, (copies.get(value.h) || 0) + 1);
            if (released)
              released.register(result, { handle: value.h, copy: true });
          }
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
        if (typeof AbortSignal === 'function' && value instanceof AbortSignal)
          return signalFor(value);
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
        require(name, from) {
          const key = `${from}\u0000${name}`;
          if (!modules.has(key))
            modules.set(key, request({ op: 'require', r: name, f: from }));
          return modules.get(key);
        },
        resolve(name, from) {
          return request({ op: 'resolve', r: name, f: from });
        },
        // A main-process module of electron (clipboard, shell...).
        electron(name) {
          if (!electronModules.has(name))
            electronModules.set(name, request({ op: 'electron', p: name }));
          return electronModules.get(name);
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
          } else if (message.ev !== undefined) {
            const existing = proxies.get(message.ev);
            const proxy = existing && existing.deref();
            const record = proxy && records.get(proxy);
            if (record)
              emitterEvent(record, message.n, (message.a || []).map(fromMain));
          }
        },
      };
    })();

    let zoomFactor = 1;
    Object.defineProperty(window, Symbol.for('aurora.dispatch'), {
      value(name, encodedArgs) {
        try {
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
        } catch (error) {
          reportUncaught(error);
        }
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

    const LiteBuffer = (function () {
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
      version: `v${config.versions.node || '0.0.0'}`,
      release: { name: 'node' },
      title: 'renderer',
      env: config.env ? { ...config.env } : {},
      argv: config.argv,
      execArgv: [],
      execPath: config.execPath,
      pid: config.pid,
      sandboxed: !config.remoteModules,
      contextIsolated: !config.nodeIntegration,
      isMainFrame: isTop,
      resourcesPath: config.resourcesPath,
      // Asked for by libraries; answered here rather than by the main process.
      browser: undefined,
      noDeprecation: undefined,
      throwDeprecation: undefined,
      traceDeprecation: undefined,
      exitCode: undefined,
      domain: undefined,
      config: { variables: {} },
      features: {},
      cwd: () => config.cwd || '/',
      chdir() {
        throw new Error('process.chdir() is not supported in renderer processes');
      },
      exit: () => window.close(),
      emitWarning: (warning) => console.warn(warning),
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
    // process (memoryUsage, kill...), as a Node.js renderer would see it, and
    // electron's main-process modules that a renderer may use (clipboard,
    // shell, nativeImage) are the main process's.
    let pageProcess = processShim;
    if (config.remoteModules) {
      let mainProcess = null;
      const main = () => (mainProcess || (mainProcess = remote.require('process', '/')));
      pageProcess = new Proxy(processShim, {
        get(target, key) {
          if (typeof key === 'symbol' || key in target)
            return target[key];
          return main()[key];
        },
      });
      for (const name of ['clipboard', 'shell', 'nativeImage'])
        Object.defineProperty(electron, name, { get: () => remote.electron(name), enumerable: true, configurable: true });
      // A native module (webpack's node loaders call this) loads in the main
      // process, where Aurora's stand-ins for Haiku apply.
      processShim.dlopen = (module, filename) => {
        module.exports = remote.require(String(filename), '/');
      };
      node = nodePolyfills ? nodePolyfills(pageProcess) : null;
    }
    const Buffer = node ? node.buffer.Buffer : LiteBuffer;

    const runtimeModules = {
      electron, 'electron/renderer': electron, 'electron/common': electron,
      events: EventEmitter,
      timers: { setTimeout, clearTimeout, setInterval, clearInterval,
        setImmediate: setImmediateShim, clearImmediate: clearImmediateShim },
      url: { URL, URLSearchParams, fileURLToPath: (url) => decodeURIComponent(new URL(url).pathname),
        pathToFileURL: (file) => new URL(`file://${encodeURI(file)}`) },
      path: pathShim,
      buffer: { Buffer, constants: { MAX_LENGTH: 2 ** 32, MAX_STRING_LENGTH: 2 ** 29 - 24 }, kMaxLength: 2 ** 32,
        kStringMaxLength: 2 ** 29 - 24, atob, btoa, Blob: window.Blob, File: window.File },
      process: pageProcess,
      util: { inspect: (value) => { try { return JSON.stringify(value); } catch { return String(value); } },
        promisify: (fn) => (...args) => new Promise((resolve, reject) => fn(...args, (error, value) => (error ? reject(error) : resolve(value)))) },
    };
    if (node) {
      // The page's own modules: their classes are the page's, so instanceof
      // and subclassing work (class LineStream extends stream.Transform).
      const { stream } = node;
      const util = Object.assign({}, node.util, { TextEncoder, TextDecoder,
        isDeepStrictEqual(a, b) {
          try {
            node.assert.deepStrictEqual(a, b);
            return true;
          } catch {
            return false;
          }
        } });
      const path = Object.assign({}, node.path);
      path.posix = path;
      path.win32 = node.pathWin32;
      const url = Object.assign({}, node.url, runtimeModules.url,
        { domainToASCII: node.punycode.toASCII, domainToUnicode: node.punycode.toUnicode });
      const buffer = Object.assign({}, node.buffer, { kStringMaxLength: 2 ** 29 - 24,
        constants: { MAX_LENGTH: node.buffer.kMaxLength, MAX_STRING_LENGTH: 2 ** 29 - 24 }, atob, btoa,
        Blob: window.Blob, File: window.File });
      Object.assign(runtimeModules, {
        assert: node.assert, 'assert/strict': node.assert.strict, buffer, events: node.events, path, 'path/posix': path,
        punycode: node.punycode, querystring: node.querystring, stream, 'stream/promises': stream.promises,
        'stream/web': { ReadableStream: window.ReadableStream, WritableStream: window.WritableStream,
          TransformStream: window.TransformStream },
        string_decoder: node.string_decoder,
        'timers/promises': {
          setTimeout: (delay, value) => new Promise((resolve) => setTimeout(resolve, delay, value)),
          setImmediate: (value) => new Promise((resolve) => setImmediateShim(resolve, value)),
        },
        url, util, 'util/types': util.types,
      });
    }

    // require() as a Node.js renderer has it: the page's own modules, then
    // the main process's (resolved from `from`).
    function requireFor(from) {
      const pageRequire = function require(request) {
        const text = String(request);
        const name = text.startsWith('node:') ? text.slice(5) : text;
        if (Object.prototype.hasOwnProperty.call(runtimeModules, name))
          return runtimeModules[name];
        return remote.require(text, from);
      };
      pageRequire.resolve = (request) => remote.resolve(String(request), from);
      pageRequire.cache = Object.create(null);
      return pageRequire;
    }

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

    // nodeIntegration without contextIsolation: the page's scripts have
    // Node.js too (webpack's electron-renderer bundles expect these globals).
    if (config.nodeIntegration && isTop) {
      const file = location.protocol === 'file:' ? decodeURIComponent(location.pathname) : '';
      const from = file || `${config.cwd || '/'}/index.html`;
      const pageRequire = requireFor(from);
      const pageModule = { id: '.', filename: file, loaded: false, exports: {}, children: [], paths: [], require: pageRequire };
      pageRequire.main = pageModule;
      const globals = {
        require: pageRequire, module: pageModule, exports: pageModule.exports, __filename: file,
        __dirname: file ? pathShim.dirname(file) : (config.cwd || '/'), process: pageProcess, Buffer, global: window,
        setImmediate: setImmediateShim, clearImmediate: clearImmediateShim,
      };
      for (const key of Object.keys(globals)) {
        try {
          Object.defineProperty(window, key, { value: globals[key], writable: true, configurable: true });
        } catch {}
      }
    }
    // A file: page's workers. WebKit makes each file its own origin, so such a
    // page cannot start a worker from its own files (Electron can): the
    // script's text, read here, goes in a blob of the page's origin instead.
    if (config.nodeIntegration && isTop && location.protocol === 'file:' && typeof Worker === 'function') {
      const PageWorker = window.Worker;
      const AuroraWorker = function Worker(url, options) {
        let resolved = null;
        try {
          resolved = new URL(String(url), location.href);
        } catch {}
        if (!resolved || resolved.protocol !== 'file:' || (options && options.type === 'module'))
          return new PageWorker(url, options);
        const source = remote.require('fs', '/').readFileSync(decodeURIComponent(resolved.pathname), 'utf8');
        const blob = new Blob([`${source}\n//# sourceURL=${resolved.href}\n`], { type: 'text/javascript' });
        return new PageWorker(URL.createObjectURL(blob), options);
      };
      AuroraWorker.prototype = PageWorker.prototype;
      Object.defineProperty(window, 'Worker', { value: AuroraWorker, writable: true, configurable: true });
    }

    // Electron reports a page's uncaught errors on the renderer's process.
    if (config.remoteModules && isTop) {
      window.addEventListener('error', (event) => {
        if (processShim.listenerCount('uncaughtException') > 0)
          processShim.emit('uncaughtException', event.error !== undefined && event.error !== null ? event.error : event.message,
            'uncaughtException');
      });
      window.addEventListener('unhandledrejection', (event) => {
        if (processShim.listenerCount('unhandledRejection') > 0)
          processShim.emit('unhandledRejection', event.reason, event.promise);
      });
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

    // Frameless windows move by their app-region: drag areas. WebKit drops
    // the property when it parses CSS, so it is read from the page's style
    // text (style elements, stylesheets, style attributes) instead.
    if (config.frameless && isTop) {
      const regionPattern = /(?:-webkit-)?app-region\s*:\s*(no-drag|drag)/i;
      const selectors = { drag: [], 'no-drag': [] };
      const scanned = new Set();
      const scan = (text) => {
        const rule = /([^{}@;]+)\{([^{}]*)\}/g;
        let match;
        while ((match = rule.exec(text))) {
          const region = regionPattern.exec(match[2]);
          if (!region)
            continue;
          for (const selector of match[1].split(',')) {
            const trimmed = selector.trim();
            try {
              if (trimmed) {
                document.querySelector(trimmed);
                selectors[region[1].toLowerCase()].push(trimmed);
              }
            } catch {}
          }
        }
      };
      const scanSheet = (node) => {
        if (node.tagName === 'STYLE' && !scanned.has(node)) {
          scanned.add(node);
          scan(node.textContent || '');
        } else if (node.tagName === 'LINK' && /stylesheet/i.test(node.rel || '') && node.href && !scanned.has(node.href)) {
          scanned.add(node.href);
          fetch(node.href).then((response) => response.text()).then(scan).catch(() => {});
        }
      };
      const watch = () => {
        document.querySelectorAll('style, link[rel~="stylesheet"]').forEach(scanSheet);
        new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node.nodeType !== 1)
                continue;
              if (node.matches('style, link'))
                scanSheet(node);
              node.querySelectorAll('style, link[rel~="stylesheet"]').forEach(scanSheet);
            }
          }
        }).observe(document.documentElement, { childList: true, subtree: true });
      };
      const matches = (node, list) => list.some((selector) => {
        try {
          return node.matches(selector);
        } catch {
          return false;
        }
      });
      const regionOf = (element) => {
        for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
          const inline = regionPattern.exec(node.getAttribute('style') || '');
          if (inline)
            return inline[1].toLowerCase();
          if (matches(node, selectors['no-drag']))
            return 'no-drag';
          if (matches(node, selectors.drag))
            return 'drag';
        }
        return null;
      };
      if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', watch, { once: true });
      else
        watch();
      window.addEventListener('mousedown', (event) => {
        if (event.button !== 0 || regionOf(event.target) !== 'drag')
          return;
        event.preventDefault();
        // Where the press was: the move starts a moment later, elsewhere.
        post({ t: 'window-drag', dbl: event.detail >= 2, x: event.clientX * zoomFactor, y: event.clientY * zoomFactor }).catch(() => {});
      }, true);
    }

    // AURORA_PAGE_CONSOLE=1: the page's console and uncaught errors go to the
    // main process (webContents 'console-message', and its stderr).
    if (config.console) {
      const text = (value) => {
        if (value instanceof Error)
          return `${value.name}: ${value.message}\n${value.stack || ''}`;
        if (typeof value === 'object' && value !== null) {
          try {
            return JSON.stringify(value);
          } catch {}
        }
        return String(value);
      };
      for (const level of ['debug', 'log', 'info', 'warn', 'error']) {
        const original = console[level];
        console[level] = function auroraConsole(...args) {
          post({ t: 'console', level, m: args.map(text).join(' ') }).catch(() => {});
          return original.apply(this, args);
        };
      }
      window.addEventListener('error', (event) => {
        post({ t: 'console', level: 'error', m: `Uncaught ${text(event.error || event.message)}`, line: event.lineno,
          source: event.filename }).catch(() => {});
      });
      window.addEventListener('unhandledrejection', (event) => {
        post({ t: 'console', level: 'error', m: `Unhandled rejection ${text(event.reason)}` }).catch(() => {});
      });
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
function buildBridgeScript({ preloadFiles = [], token, versions, resourcesPath, systemVersion, remoteModules = false,
  nodeIntegration = false, argv = [], frameless = false }) {
  const config = {
    token,
    frameless: !!frameless,
    remoteModules: remoteModules || nodeIntegration,
    nodeIntegration,
    argv,
    execPath: process.execPath,
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    versions,
    resourcesPath,
    systemVersion,
    navigatorPlatform: `Haiku ${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`,
    console: process.env.AURORA_PAGE_CONSOLE === '1',
  };
  // A Node.js renderer inherits the main process's environment and directory.
  if (config.remoteModules) {
    config.env = { ...process.env };
    config.cwd = process.cwd();
  }
  const preloads = preloadFiles.map(bundleSource);
  const polyfills = config.remoteModules ? nodePolyfills.toString() : 'null';
  return `(${bridgeRuntime().toString()})(${JSON.stringify(config)}, [${preloads.join(',\n')}], (${encodeSource}), (${decodeSource}), ${polyfills});`;
}

module.exports = { buildBridgeScript, bundle };
