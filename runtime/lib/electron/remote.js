'use strict';

// Remote modules: Node.js for preload scripts that expect it.
//
// Electron runs a preload with sandbox: false in the renderer with all of
// Node.js: fs, child_process, http, native modules. Aurora's pages are WebKit
// pages without Node.js, so a preload's require() of such a module is served
// here, in the main process, and the page gets a proxy. Every property read,
// call and `new` on a proxy is a synchronous request (the same channel as
// ipcRenderer.sendSync); functions the page passes become stubs that call back
// into the page; promises settle in the page when they settle here.
//
// Values cross by copy when they are data (primitives, arrays, plain objects,
// Buffers, dates, errors) and by reference otherwise (functions, class
// instances). A page never reaches a main-process object's constructor or
// prototype: web content in the same page could otherwise climb from any
// function to Function and run code here.

const path = require('path');
const Module = require('module');
const { encode: encodeData } = require('../serialize');

const BLOCKED_KEYS = new Set(['constructor', '__proto__', 'prototype', '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__', 'caller', 'callee', 'arguments']);
const MAX_PLAIN_KEYS = 400;
const MAX_DEPTH = 4;

function isPlain(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isLeaf(value) {
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  return tag === 'Date' || tag === 'RegExp' || tag === 'ArrayBuffer' || ArrayBuffer.isView(value);
}

function errorOf(error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  const result = encodeData(failure);
  for (const key of ['code', 'errno', 'syscall', 'path'])
    if (failure[key] !== undefined)
      result[key] = failure[key];
  return result;
}

class RemoteObjects {
  constructor(contents) {
    this.contents = contents;
    this.objects = new Map();
    this.ids = new WeakMap();
    this.nextId = 1;
    this.callbacks = new Map();
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
    case 'function':
      return { $a: 'rf', h: this.handle(value), n: String(value.name || '') };
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
    if (isLeaf(value))
      return encodeData(value);
    if (typeof value.then === 'function')
      return this.promise(value);
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
    let stub = this.callbacks.get(id);
    if (!stub) {
      const objects = this;
      stub = function auroraPageCallback(...args) {
        objects.contents._dispatch('\u0000remote', { call: id, a: args.map((arg) => objects.toPage(arg)) });
      };
      this.callbacks.set(id, stub);
    }
    return stub;
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
    case 'release':
      for (const id of body.ids || []) {
        const object = this.objects.get(id);
        if (object !== undefined) {
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
