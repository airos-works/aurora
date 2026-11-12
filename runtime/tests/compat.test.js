'use strict';

// What apps built for newer Electron releases expect (Signal Desktop, Electron
// 45): newer Node.js globals in the main process and its workers, Electron's
// net.resolveHost answer, sendSync replies set after an await, Node.js's
// setImmediate in preloads, and class instances whose methods a native
// module calls back. `node --test tests/`.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const vm = require('vm');
const { EventEmitter } = require('events');
const { buildBridgeScript } = require('../lib/renderer/bridge');
const { RemoteObjects } = require('../lib/electron/remote');
const { encode, decode } = require('../lib/serialize');

test('compat gives Node.js URLPattern and Intl.Locale\'s information methods', () => {
  // (Node.js 22 has neither; a newer Node.js keeps its own)
  const { installCompat } = require('../lib/compat');
  installCompat();
  const pattern = new URLPattern({ protocol: 'https', hostname: 'signal.me', pathname: '/' });
  assert.equal(pattern.test('https://signal.me/#eu/abc'), true);
  assert.equal(pattern.test('https://example.com/'), false);
  assert.equal(new Intl.Locale('he').getTextInfo().direction, 'rtl');
  assert.equal(typeof new Intl.Locale('en-AU').getWeekInfo().firstDay, 'number');
  assert.ok(Array.isArray(new Intl.Locale('ja-JP').getCalendars()));
});

test('worker threads get the app\'s platform and the compat globals', async () => {
  const { installWorkerSetup } = require('../lib/node-setup');
  installWorkerSetup();
  const { Worker } = require('worker_threads');
  const previous = process.env.AURORA_PLATFORM;
  process.env.AURORA_PLATFORM = 'aurora-test-os';
  try {
    const worker = new Worker(`
      const { parentPort, Worker } = require('worker_threads');
      const nested = new Worker("require('worker_threads').parentPort.postMessage(process.platform)", { eval: true });
      nested.once('message', (platform) => parentPort.postMessage({
        platform: process.platform, nested: platform, urlPattern: typeof URLPattern,
        textInfo: typeof new Intl.Locale('en').getTextInfo,
      }));
    `, { eval: true });
    const result = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    await worker.terminate();
    assert.deepEqual(result, { platform: 'aurora-test-os', nested: 'aurora-test-os', urlPattern: 'function',
      textInfo: 'function' });
  } finally {
    if (previous === undefined)
      delete process.env.AURORA_PLATFORM;
    else
      process.env.AURORA_PLATFORM = previous;
  }
});

test('net.resolveHost answers with Electron\'s address families', async () => {
  const { resolveHost } = require('../lib/electron/resolve-host');
  const all = await resolveHost('localhost');
  assert.ok(all.endpoints.length > 0);
  for (const endpoint of all.endpoints) {
    assert.ok(['ipv4', 'ipv6'].includes(endpoint.family), endpoint.family);
    assert.equal(typeof endpoint.address, 'string');
  }
  const v4 = await resolveHost('localhost', { queryType: 'A' });
  assert.ok(v4.endpoints.every((endpoint) => endpoint.family === 'ipv4'));
});

test('sendSync waits for a returnValue a listener sets after an await', async () => {
  const { WebContents } = require('../lib/electron/web-contents');
  const contents = Object.create(WebContents.prototype);
  EventEmitter.call(contents);
  Object.assign(contents, { _window: { _bridgeToken: 'k' }, _url: 'file:///page.html', ipc: new EventEmitter() });
  contents.ipc.on('get-config', async (event, name) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    event.returnValue = { hello: name };
  });
  contents.ipc.on('at-once', (event) => {
    event.returnValue = 42;
  });
  const later = contents._syncMessage({ k: 'k', t: 'sync', ch: 'get-config', a: encode(['page']) });
  assert.equal(typeof later.then, 'function');
  assert.deepEqual(decode((await later).v), { hello: 'page' });
  assert.equal(decode(contents._syncMessage({ k: 'k', t: 'sync', ch: 'at-once', a: encode([]) }).v), 42);
  // Nobody listens: undefined at once, as before.
  assert.equal(decode(contents._syncMessage({ k: 'k', t: 'sync', ch: 'nobody', a: encode([]) }).v), undefined);
});

// A page (the bridge in a vm context) whose remote requests reach a
// RemoteObjects here, as in node-integration.test.js.
function createPage({ preloadFiles = [] } = {}) {
  let context = null;
  const dispatch = Symbol.for('aurora.dispatch');
  const remote = new RemoteObjects({
    _dispatch(channel, payload) {
      setImmediate(() => context[dispatch](channel, payload));
    },
    isDestroyed: () => false,
  });
  class XMLHttpRequest {
    open() {}
    setRequestHeader() {}
    send(body) {
      this.status = 200;
      this.responseText = JSON.stringify(remote.request(JSON.parse(body)));
    }
  }
  context = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, URL, URLSearchParams,
    TextEncoder, TextDecoder, atob, btoa, performance, AbortController, AbortSignal, XMLHttpRequest,
    location: { protocol: 'file:', pathname: '/page.html', href: 'file:///page.html' },
    navigator: { platform: 'Haiku x86_64' },
    document: { readyState: 'complete', title: '', addEventListener() {}, documentElement: {} },
    addEventListener() {},
    webkit: { messageHandlers: { aurora: { postMessage(text) {
      const message = JSON.parse(text);
      if (message.t === 'remote')
        remote.request(message);
      return Promise.resolve('null');
    } } } },
  });
  vm.runInContext('window = globalThis; window.top = window;', context);
  vm.runInContext(buildBridgeScript({ token: 't', versions: process.versions, resourcesPath: '/', systemVersion: '1',
    remoteModules: true, nodeIntegration: true, preloadFiles }), context);
  return context;
}

test('a preload without the sandbox has setImmediate', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-preload-'));
  const preload = path.join(directory, 'preload.js');
  fs.writeFileSync(preload, 'window.kind = typeof setImmediate; setImmediate((value) => { window.ran = value; }, 7);\n');
  try {
    const page = createPage({ preloadFiles: [preload] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(page.kind, 'function');
    assert.equal(page.ran, 7);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a class instance the page passes keeps its methods as callbacks', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-listener-'));
  const module = path.join(directory, 'native-like.js');
  // As a native module does with libsignal's listener wrappers: it keeps the
  // object and calls its methods later.
  fs.writeFileSync(module, 'exports.listen = (listener) => { setImmediate(() => listener.receivedAddress("addr", 3)); };\n');
  try {
    const page = createPage();
    vm.runInContext(`
      class Base { receivedAddress(address, ack) { this.got.push([address, ack]); } }
      class Wrapper extends Base { constructor() { super(); this.got = []; } }
      window.listener = new Wrapper();
      require(${JSON.stringify(module)}).listen(window.listener);
    `, page);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(JSON.parse(JSON.stringify(page.listener.got)), [['addr', 3]]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
