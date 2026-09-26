'use strict';

// Values crossing between the main process and pages. Electron uses the
// structured clone algorithm; this encodes the same kinds of values as JSON:
// undefined, NaN and the infinities, BigInt, Date, RegExp, Map, Set, Error,
// ArrayBuffer, typed arrays (Buffers become Uint8Array, as in Electron) and
// cyclic references. Functions and symbols are dropped, as cloning drops them.
//
// The same two functions run in pages (renderer/bridge.js injects their
// source), so they must not use anything outside themselves.

function encode(value) {
  const seen = new Map();
  let next = 0;
  const TYPED = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
    'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];
  function base64(bytes) {
    if (typeof window === 'undefined' && typeof Buffer === 'function') {
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    }
    let text = '';
    for (let index = 0; index < bytes.length; index += 0x8000)
      text += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    return btoa(text);
  }
  function walk(input) {
    switch (typeof input) {
    case 'undefined':
      return { $a: 'u' };
    case 'number':
      return Number.isFinite(input) ? input : { $a: 'n', v: String(input) };
    case 'bigint':
      return { $a: 'b', v: input.toString() };
    case 'string':
    case 'boolean':
      return input;
    case 'function':
    case 'symbol':
      return { $a: 'u' };
    }
    if (input === null)
      return null;
    if (seen.has(input))
      return { $a: 'ref', v: seen.get(input) };
    const tag = Object.prototype.toString.call(input).slice(8, -1);
    if (tag === 'Date')
      return { $a: 'd', v: input.getTime() };
    if (tag === 'RegExp')
      return { $a: 'r', s: input.source, f: input.flags };
    if (tag === 'ArrayBuffer')
      return { $a: 'ab', v: base64(new Uint8Array(input)) };
    if (ArrayBuffer.isView(input)) {
      const type = TYPED.includes(tag) ? tag : (tag === 'DataView' ? 'DataView' : 'Uint8Array');
      return { $a: 'ta', t: type, v: base64(new Uint8Array(input.buffer, input.byteOffset, input.byteLength)) };
    }
    if (input instanceof Error || tag === 'Error')
      return { $a: 'e', name: String(input.name), message: String(input.message), stack: String(input.stack || '') };
    const id = next++;
    seen.set(input, id);
    if (tag === 'Map') {
      const entries = [];
      for (const [key, item] of input)
        entries.push([walk(key), walk(item)]);
      return { $a: 'm', i: id, v: entries };
    }
    if (tag === 'Set') {
      const items = [];
      for (const item of input)
        items.push(walk(item));
      return { $a: 's', i: id, v: items };
    }
    if (Array.isArray(input))
      return { $a: 'arr', i: id, v: input.map(walk) };
    const result = {};
    for (const key of Object.keys(input))
      result[key] = walk(input[key]);
    return { $a: 'o', i: id, v: result };
  }
  return walk(value);
}

function decode(value) {
  const objects = new Map();
  function bytes(text) {
    if (typeof window === 'undefined' && typeof Buffer === 'function') {
      const buffer = Buffer.from(text, 'base64');
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
    const binary = atob(text);
    const result = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++)
      result[index] = binary.charCodeAt(index);
    return result;
  }
  function walk(input) {
    if (input === null || typeof input !== 'object')
      return input;
    if (Array.isArray(input))
      return input.map(walk);
    switch (input.$a) {
    case 'u':
      return undefined;
    case 'n':
      return Number(input.v);
    case 'b':
      return BigInt(input.v);
    case 'd':
      return new Date(input.v);
    case 'r':
      return new RegExp(input.s, input.f);
    case 'ab':
      return bytes(input.v).buffer;
    case 'ta': {
      const data = bytes(input.v);
      if (input.t === 'DataView')
        return new DataView(data.buffer);
      const Type = globalThis[input.t] || Uint8Array;
      const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      return new Type(copy, 0, copy.byteLength / (Type.BYTES_PER_ELEMENT || 1));
    }
    case 'e': {
      const error = new Error(input.message);
      error.name = input.name;
      if (input.stack)
        error.stack = input.stack;
      return error;
    }
    case 'ref':
      return objects.get(input.v);
    case 'm': {
      const map = new Map();
      objects.set(input.i, map);
      for (const [key, item] of input.v)
        map.set(walk(key), walk(item));
      return map;
    }
    case 's': {
      const set = new Set();
      objects.set(input.i, set);
      for (const item of input.v)
        set.add(walk(item));
      return set;
    }
    case 'arr': {
      const array = [];
      objects.set(input.i, array);
      for (const item of input.v)
        array.push(walk(item));
      return array;
    }
    case 'o': {
      const object = {};
      objects.set(input.i, object);
      for (const key of Object.keys(input.v))
        object[key] = walk(input.v[key]);
      return object;
    }
    default: {
      // A plain object from an older encoder: decode its members.
      const object = {};
      for (const key of Object.keys(input))
        object[key] = walk(input[key]);
      return object;
    }
    }
  }
  return walk(value);
}

module.exports = { encode, decode, encodeSource: encode.toString(), decodeSource: decode.toString() };
