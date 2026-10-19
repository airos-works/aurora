'use strict';

// Remote modules: Node.js for pages and preload scripts that expect it.
//
// Electron runs a preload with sandbox: false, and a page with
// nodeIntegration, in a renderer with all of Node.js: fs, child_process,
// http, native modules. Aurora's pages are WebKit pages without Node.js, so
// such a require() is served here, in the main process, and the page gets a
// proxy. Every property read, call and `new` on a proxy is a synchronous
// request (the same channel as ipcRenderer.sendSync); functions the page
// passes become stubs that call back into the page; promises settle in the
// page when they settle here.
//
// Values cross by copy when they are data (primitives, arrays, plain objects,
// Buffers, dates, errors, fs.Stats and fs.Dirent) and by reference otherwise
// (functions, class instances). Event emitters and streams cross by
// reference too, but the page's side is a real EventEmitter or stream of the
// page (renderer/bridge.js): the events it listens for are forwarded, and its
// writes come back here. A page never reaches a main-process object's
// constructor or prototype: web content in the same page could otherwise
// climb from any function to Function and run code here.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const stream = require('stream');
const { encode: encodeData } = require('../serialize');

const BLOCKED_KEYS = new Set(['constructor', '__proto__', 'prototype', '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__', 'caller', 'callee', 'arguments']);
const MAX_PLAIN_KEYS = 400;
const MAX_DEPTH = 4;
// Events always forwarded: the page's side of a stream keeps its state from
// them, and a closed emitter is one the page may let go.
const STREAM_EVENTS = ['end', 'close', 'error'];
const EMITTER_EVENTS = ['close', 'error'];
// Events that are never forwarded: they describe the listeners here.
const LOCAL_EVENTS = new Set(['newListener', 'removeListener']);

function isPlain(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isLeaf(value) {
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  return tag === 'Date' || tag === 'RegExp' || tag === 'ArrayBuffer' || ArrayBuffer.isView(value);
}

// An error and the details Node.js hangs on it (code, errno, syscall, path,
// signal, killed, cmd...).
function errorOf(error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  const result = encodeData(failure);
  for (const key of Object.keys(failure)) {
    const value = failure[key];
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
      result[key] = value;
  }
  for (const key of ['code', 'errno', 'syscall', 'path'])
    if (failure[key] !== undefined)
      result[key] = failure[key];
  return result;
}

const STATS_FIELDS = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks',
  'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs'];

function direntType(entry) {
  if (entry.isFile())
    return 'f';
  if (entry.isDirectory())
    return 'd';
  if (entry.isSymbolicLink())
    return 'l';
  if (entry.isFIFO())
    return 'p';
  if (entry.isSocket())
    return 's';
  if (entry.isCharacterDevice())
    return 'c';
  if (entry.isBlockDevice())
    return 'b';
  return 'u';
}

function isStream(value) {
  return value instanceof stream.Stream && (typeof value.read === 'function' || typeof value.write === 'function');
}

class RemoteObjects {
  constructor(contents) {
    this.contents = contents;
    this.objects = new Map();
    this.ids = new WeakMap();
    this.nextId = 1;
    // Stubs for page functions, held weakly: when the stub is collected the
    // page may forget its function too.
    this.callbacks = new Map();
    this.droppedCallbacks = [];
    this.callbackRegistry = new FinalizationRegistry((id) => this.dropCallback(id));
    this.emitters = new Map();
    this.signals = new Map();
  }

  // A reference the page can use: the same object always has the same id.
  handle(object) {
    let id = this.ids.get(object);
    if (!id) {
      id = this.nextId++;
      this.ids.set(object, id);
      this.objects.set(id, object);
    }
    return id;
  }

  object(id) {
    if (!this.objects.has(id))
      throw new Error(`Aurora: the remote object ${id} is gone`);
    return this.objects.get(id);
  }

  // Main-process value -> what the page decodes.
  toPage(value, depth = 0, seen = new Set()) {
    switch (typeof value) {
    case 'function': {
      const description = { $a: 'rf', h: this.handle(value), n: String(value.name || '') };
      // util.promisify(execFile) resolves to { stdout, stderr } through it.
      const custom = value[require('util').promisify.custom];
      if (typeof custom === 'function')
        description.pc = this.handle(custom);
      return description;
    }
    case 'symbol':
      return { $a: 'u' };
    case 'object':
      break;
    default:
      return encodeData(value);
    }
    if (value === null)
      return null;
    if (value instanceof Error)
      return errorOf(value);
    if (Buffer.isBuffer(value))
      return { $a: 'buf', v: value.toString('base64') };
    if (isLeaf(value))
      return encodeData(value);
    // A Proxy (a stand-in module that answers any name) must stay live, and
    // must not be asked for .then first.
    if (require('util').types.isProxy(value))
      return { $a: 'ro', h: this.handle(value), c: 'Proxy' };
    if (typeof value.then === 'function')
      return this.promise(value);
    if (value instanceof fs.Stats) {
      const fields = {};
      for (const key of STATS_FIELDS)
        fields[key] = encodeData(value[key]);
      return { $a: 'stats', v: fields };
    }
    if (value instanceof fs.Dirent)
      return { $a: 'dirent', v: { name: encodeData(value.name), parentPath: value.parentPath, path: value.path, t: direntType(value) } };
    // The process object and the main process's own singletons stay plain
    // references: their events are none of the page's business.
    if (value instanceof EventEmitter && value !== process)
      return this.emitter(value);
    if (seen.has(value) || depth > MAX_DEPTH)
      return { $a: 'ro', h: this.handle(value), c: value.constructor && value.constructor.name };
    if (Array.isArray(value)) {
      seen.add(value);
      return { $a: 'arr', v: value.map((item) => this.toPage(item, depth + 1, seen)) };
    }
    if (value instanceof Map || value instanceof Set)
      return encodeData(value);
    if (isPlain(value)) {
      const keys = Object.keys(value);
      if (keys.length <= MAX_PLAIN_KEYS) {
        seen.add(value);
        const result = {};
        for (const key of keys) {
          let item;
          try {
            item = value[key];
          } catch {
            continue;
          }
          result[key] = this.toPage(item, depth + 1, seen);
        }
        // The origin travels with the copy: passed back (as `this`, say),
        // the page's copy stands for this object again.
        return { $a: 'o', h: this.handle(value), v: result };
      }
    }
    return { $a: 'ro', h: this.handle(value), c: value.constructor && value.constructor.name };
  }

  promise(thenable) {
    const id = this.handle(thenable);
    Promise.resolve(thenable).then(
      (value) => this.contents._dispatch('\u0000remote', { settle: id, ok: true, v: this.toPage(value) }),
      (error) => this.contents._dispatch('\u0000remote', { settle: id, ok: false, v: errorOf(error) }));
    return { $a: 'rp', h: id };
  }

  // An event emitter or stream for the page. Its events are recorded from
  // the moment the page first hears of it: until the page has run the code
  // that received it (an 'ack'), they are held, because a child process can
  // exit here between the page's spawn() and its on('exit'). Then the events
  // the page listens for are forwarded.
  emitter(value) {
    const id = this.handle(value);
    const isAStream = isStream(value);
    if (!this.emitters.has(id))
      this.watch(id, value, isAStream);
    const description = { $a: isAStream ? 'st' : 'ee', h: id, c: value.constructor && value.constructor.name };
    if (isAStream) {
      description.r = typeof value.read === 'function' && value.readable !== false;
      description.w = typeof value.write === 'function' && value.writable !== false;
    }
    return description;
  }

  watch(id, emitter, isAStream) {
    const record = { id, emitter, subscribed: new Set(isAStream ? STREAM_EVENTS : EMITTER_EVENTS), held: [],
      acknowledged: false, flowing: false, children: [] };
    // The page handles errors (or reports them); none may end this process.
    record.onError = () => {};
    emitter.on('error', record.onError);
    const objects = this;
    const ownEmit = Object.prototype.hasOwnProperty.call(emitter, 'emit') ? emitter.emit : undefined;
    const emit = emitter.emit;
    emitter.emit = function auroraForwardingEmit(name, ...args) {
      if (typeof name === 'string')
        objects.forward(record, name, args);
      return emit.call(this, name, ...args);
    };
    record.restore = () => {
      if (ownEmit)
        emitter.emit = ownEmit;
      else
        delete emitter.emit;
      emitter.removeListener('error', record.onError);
      if (record.onData)
        emitter.removeListener('data', record.onData);
    };
    this.emitters.set(id, record);
    // A child process's pipes are watched with it, so that what they say
    // before the page asks for them is held too.
    for (const key of ['stdin', 'stdout', 'stderr']) {
      const child = emitter[key];
      if (isAStream || !(child instanceof EventEmitter) || !isStream(child))
        continue;
      const childId = this.handle(child);
      if (!this.emitters.has(childId))
        this.watch(childId, child, true);
      record.children.push(childId);
    }
  }

  forward(record, name, args) {
    if (LOCAL_EVENTS.has(name))
      return;
    if (!record.acknowledged) {
      record.held.push([name, args]);
      return;
    }
    if (record.subscribed.has(name))
      this.sendEvent(record, name, args);
  }

  sendEvent(record, name, args) {
    let encoded;
    try {
      encoded = args.map((arg) => this.toPage(arg));
    } catch (error) {
      encoded = [errorOf(error)];
    }
    this.contents._dispatch('\u0000remote', { ev: record.id, n: name, a: encoded });
  }

  acknowledge(id) {
    const record = this.emitters.get(id);
    if (!record || record.acknowledged)
      return;
    record.acknowledged = true;
    const held = record.held;
    record.held = [];
    for (const [name, args] of held)
      if (record.subscribed.has(name))
        this.sendEvent(record, name, args);
    for (const child of record.children)
      this.acknowledge(child);
  }

  subscribe(id, name) {
    const record = this.emitters.get(id);
    if (!record || LOCAL_EVENTS.has(name))
      return;
    record.subscribed.add(name);
  }

  // The page reads a stream: let it flow (it may already, for a consumer here).
  flow(id) {
    const record = this.emitters.get(id);
    if (!record || record.flowing)
      return;
    record.flowing = true;
    record.subscribed.add('data');
    record.onData = () => {};
    record.emitter.on('data', record.onData);
  }

  unwatch(id) {
    const record = this.emitters.get(id);
    if (!record)
      return;
    this.emitters.delete(id);
    record.restore();
  }

  // Page value -> main-process value.
  fromPage(value) {
    if (value === null || typeof value !== 'object')
      return value;
    if (Array.isArray(value))
      return value.map((item) => this.fromPage(item));
    switch (value.$a) {
    case 'h':
      return this.object(value.h);
    case 'cb':
      return this.callback(value.i);
    case 'sig':
      return this.signal(value.i, value.ab, value.r);
    case 'o': {
      const result = {};
      for (const [key, item] of Object.entries(value.v))
        result[key] = this.fromPage(item);
      return result;
    }
    case 'arr':
      return value.v.map((item) => this.fromPage(item));
    case 'ta': {
      const decoded = require('../serialize').decode(value);
      // Node's APIs want Buffers where the page has Uint8Arrays.
      return decoded instanceof Uint8Array ? Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength) : decoded;
    }
    default:
      return require('../serialize').decode(value);
    }
  }

  // A page function, as a main-process function. It returns undefined: the
  // page runs it later, as it does an event listener.
  callback(id) {
    const existing = this.callbacks.get(id);
    let stub = existing && existing.deref();
    if (!stub) {
      const objects = this;
      stub = function auroraPageCallback(...args) {
        objects.contents._dispatch('\u0000remote', { call: id, a: args.map((arg) => objects.toPage(arg)) });
      };
      this.callbacks.set(id, new WeakRef(stub));
      this.callbackRegistry.register(stub, id);
    }
    return stub;
  }

  dropCallback(id) {
    const existing = this.callbacks.get(id);
    if (existing && existing.deref())
      return;
    this.callbacks.delete(id);
    this.droppedCallbacks.push(id);
    if (this.droppedCallbacks.length === 1)
      setTimeout(() => {
        const ids = this.droppedCallbacks;
        this.droppedCallbacks = [];
        if (!this.contents.isDestroyed())
          this.contents._dispatch('\u0000remote', { drop: ids });
      }, 1000).unref();
  }

  // A page AbortSignal: the page reports its abort.
  signal(id, aborted, reason) {
    let controller = this.signals.get(id);
    if (!controller) {
      controller = new AbortController();
      this.signals.set(id, controller);
      controller.signal.addEventListener('abort', () => this.signals.delete(id), { once: true });
    }
    if (aborted && !controller.signal.aborted)
      controller.abort(reason === undefined ? undefined : this.fromPage(reason));
    return controller.signal;
  }

  // One synchronous request from the page.
  request(body) {
    try {
      return { v: this.perform(body) };
    } catch (error) {
      return { e: errorOf(error) };
    }
  }

  perform(body) {
    switch (body.op) {
    case 'require': {
      const from = body.f && path.isAbsolute(body.f) ? body.f : path.join(process.cwd(), 'preload.js');
      const request = body.r === 'original-fs' || body.r === 'node:original-fs' ? 'fs' : body.r;
      return this.toPage(Module.createRequire(from)(request));
    }
    case 'resolve': {
      const from = body.f && path.isAbsolute(body.f) ? body.f : path.join(process.cwd(), 'preload.js');
      return Module.createRequire(from).resolve(body.r);
    }
    case 'electron': {
      const key = String(body.p);
      if (!['clipboard', 'shell', 'nativeImage'].includes(key))
        throw new Error(`Aurora: electron.${key} is not available to pages`);
      return this.toPage(require('./index').electron[key]);
    }
    case 'get': {
      const key = String(body.p);
      if (BLOCKED_KEYS.has(key))
        return { $a: 'u' };
      return this.toPage(this.object(body.h)[key]);
    }
    case 'set': {
      const key = String(body.p);
      if (BLOCKED_KEYS.has(key))
        throw new Error(`Aurora: cannot set ${key} on a remote object`);
      this.object(body.h)[key] = this.fromPage(body.v);
      return { $a: 'u' };
    }
    case 'has':
      return !BLOCKED_KEYS.has(String(body.p)) && String(body.p) in this.object(body.h);
    case 'keys': {
      const target = this.object(body.h);
      const keys = [];
      for (const key in target)
        if (!BLOCKED_KEYS.has(key))
          keys.push(key);
      return keys;
    }
    case 'apply': {
      const target = this.object(body.h);
      const self = body.s === undefined || body.s === null ? undefined : this.fromPage(body.s);
      return this.toPage(Reflect.apply(target, self, (body.a || []).map((arg) => this.fromPage(arg))));
    }
    case 'construct': {
      const target = this.object(body.h);
      return this.toPage(Reflect.construct(target, (body.a || []).map((arg) => this.fromPage(arg))));
    }
    // Emitters and streams (asynchronous, except write/end).
    case 'ack':
      for (const id of body.ids || [])
        this.acknowledge(id);
      return { $a: 'u' };
    case 'sub':
      this.subscribe(body.h, String(body.n));
      return { $a: 'u' };
    case 'flow':
      this.flow(body.h);
      return { $a: 'u' };
    case 'write': {
      const target = this.object(body.h);
      const chunk = this.fromPage(body.v);
      if (body.e && typeof chunk === 'string')
        target.write(chunk, body.e);
      else
        target.write(chunk);
      return { $a: 'u' };
    }
    case 'end':
      this.object(body.h).end();
      return { $a: 'u' };
    case 'destroy': {
      const target = this.objects.get(body.h);
      if (target && typeof target.destroy === 'function' && !target.destroyed)
        target.destroy(body.e ? this.fromPage(body.e) : undefined);
      return { $a: 'u' };
    }
    case 'abort':
      this.signal(body.i, true, body.r);
      return { $a: 'u' };
    case 'release':
      for (const id of body.ids || []) {
        const object = this.objects.get(id);
        if (object !== undefined) {
          this.unwatch(id);
          this.objects.delete(id);
          this.ids.delete(object);
        }
      }
      return { $a: 'u' };
    default:
      throw new Error(`Aurora: unknown remote operation ${body.op}`);
    }
  }
}

module.exports = { RemoteObjects };
