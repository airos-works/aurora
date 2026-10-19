'use strict';

// Node.js in pages (nodeIntegration): the bridge's page side runs in a vm
// context, as a page would, and its synchronous requests reach the main
// process's RemoteObjects directly. `node --test tests/`.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const vm = require('vm');
const { buildBridgeScript } = require('../lib/renderer/bridge');
const { RemoteObjects } = require('../lib/electron/remote');

function plain(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function createPage({ file = path.join(os.tmpdir(), 'aurora-page', 'index.html') } = {}) {
  let context = null;
  const dispatch = Symbol.for('aurora.dispatch');
  const contents = {
    // As the host does: later, in order, one script per turn.
    _dispatch(channel, payload) {
      setImmediate(() => context[dispatch](channel, payload));
    },
    isDestroyed: () => false,
  };
  const remote = new RemoteObjects(contents);
  class XMLHttpRequest {
    open() {}
    setRequestHeader() {}
    send(body) {
      this.status = 200;
      this.responseText = JSON.stringify(remote.request(JSON.parse(body)));
    }
  }
  const listeners = [];
  // No MessageChannel: Node.js would stay alive for its port (setImmediate
  // then falls back to timers).
  context = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, URL, URLSearchParams,
    TextEncoder, TextDecoder, atob, btoa, performance, AbortController, AbortSignal,
    XMLHttpRequest,
    location: { protocol: 'file:', pathname: file, href: `file://${file}` },
    navigator: { platform: 'Haiku x86_64' },
    document: { readyState: 'complete', title: '', addEventListener() {}, documentElement: {} },
    addEventListener: (type, listener) => listeners.push([type, listener]),
    webkit: { messageHandlers: { aurora: { postMessage(text) {
      const message = JSON.parse(text);
      if (message.t === 'remote')
        remote.request(message);
      return Promise.resolve('null');
    } } } },
  });
  vm.runInContext('window = globalThis; window.top = window;', context);
  vm.runInContext(buildBridgeScript({ token: 't', versions: process.versions, resourcesPath: '/', systemVersion: '1',
    nodeIntegration: true }), context);
  // Results come back as data of this realm, for deepEqual.
  const run = (code) => {
    const value = vm.runInContext(code, context);
    return value && typeof value.then === 'function' ? Promise.resolve(value).then(plain) : plain(value);
  };
  return { context, remote, run };
}

test('pages with nodeIntegration get require, module, process, Buffer and __dirname', () => {
  const page = createPage();
  const result = page.run(`({
    require: typeof require, module: typeof module.exports, dirname: __dirname, buffer: Buffer.from('aGk=', 'base64').toString(),
    platform: process.platform, env: typeof process.env.PATH, immediate: typeof setImmediate, global: global === window,
    pathJoin: require('path').join('/a', 'b', '../c'), events: typeof require('events').EventEmitter,
    stringMax: require('buffer').kStringMaxLength > 0, util: typeof require('util').promisify,
    stripped: require('util').stripVTControlCharacters('\\u001b[31mred\\u001b[0m, \\u001b]8;;x\\u0007link'),
    win32: require('path').win32.join('C:\\\\a', 'b'),
  })`);
  assert.equal(result.require, 'function');
  assert.equal(result.module, 'object');
  assert.equal(result.dirname, path.join(os.tmpdir(), 'aurora-page'));
  assert.equal(result.buffer, 'hi');
  assert.equal(result.platform, process.platform);
  assert.equal(result.env, 'string');
  assert.equal(result.immediate, 'function');
  assert.equal(result.global, true);
  assert.equal(result.pathJoin, '/a/c');
  assert.equal(result.events, 'function');
  assert.equal(result.stringMax, true);
  assert.equal(result.util, 'function');
  assert.equal(result.stripped, 'red, link');
  assert.equal(result.win32, 'C:\\a\\b');
});

test('fs answers with Buffers, Stats and Dirents of the page', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-fs-'));
  fs.writeFileSync(path.join(directory, 'a.txt'), 'hello');
  fs.mkdirSync(path.join(directory, 'sub'));
  const page = createPage();
  page.context.directory = directory;
  const result = await page.run(`(async () => {
    const fs = require('fs');
    const Path = require('path');
    const bytes = fs.readFileSync(Path.join(directory, 'a.txt'));
    const stats = await require('fs/promises').stat(directory);
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    let missing = null;
    try { fs.statSync(Path.join(directory, 'nope')); } catch (error) { missing = error.code; }
    return { isBuffer: Buffer.isBuffer(bytes), text: bytes.toString('utf8'), isDirectory: stats.isDirectory(),
      mtime: stats.mtime instanceof Date, entries: entries.map((entry) => entry.name + ':' + entry.isDirectory()).sort(), missing };
  })()`);
  assert.deepEqual(result, { isBuffer: true, text: 'hello', isDirectory: true, mtime: true,
    entries: ['a.txt:false', 'sub:true'], missing: 'ENOENT' });
  fs.rmSync(directory, { recursive: true, force: true });
});

test('execFile results and errors carry what Node.js gives them', async () => {
  const page = createPage();
  const result = await page.run(`new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile('sh', ['-c', 'echo out; echo err >&2; exit 3'], { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error && error.code, stdout, stderr });
    });
  })`);
  assert.deepEqual(result, { code: 3, stdout: 'out\n', stderr: 'err\n' });
  const promisified = await page.run(`require('util').promisify(require('child_process').execFile)('echo', ['promised'])`);
  assert.equal(promisified.stdout, 'promised\n');
});

test('a child process is an emitter with streams of the page', async () => {
  const page = createPage();
  const result = await page.run(`new Promise((resolve) => {
    const { spawn } = require('child_process');
    const { Transform } = require('stream');
    const child = spawn('sh', ['-c', 'read line; echo "got $line"; echo progress 1 >&2; echo progress 2 >&2']);
    const lines = [];
    // A page Transform fed by the child's stderr, as byline does.
    const splitter = new Transform({ transform(chunk, encoding, callback) {
      for (const line of chunk.toString().split('\\n')) if (line) this.push(line);
      callback();
    }, readableObjectMode: true });
    child.stderr.pipe(splitter).on('data', (line) => lines.push(line));
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text) => { stdout += text; });
    child.stdin.end('hello\\n');
    child.on('exit', (code) => {
      child.on('close', () => resolve({ code, stdout, lines, pid: typeof child.pid, emitter: child instanceof require('events') }));
    });
  })`);
  assert.deepEqual(result, { code: 0, stdout: 'got hello\n', lines: ['progress 1', 'progress 2'], pid: 'number', emitter: true });
});

test('a net server of the page talks to clients through page streams', async () => {
  const page = createPage();
  const port = await page.run(`new Promise((resolve, reject) => {
    const net = require('net');
    const server = net.createServer((socket) => {
      let received = '';
      socket.on('data', (chunk) => {
        received += chunk.toString('utf8');
        if (received.includes('\\0')) socket.end('echo:' + received.replace('\\0', ''));
      });
      socket.on('error', () => {});
    });
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  })`);
  const net = require('net');
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write('ping\0'));
    let text = '';
    socket.on('data', (chunk) => { text += chunk; });
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
  });
  assert.equal(reply, 'echo:ping');
});

test('an aborted signal of the page stops a child process', async () => {
  const page = createPage();
  const result = await page.run(`new Promise((resolve) => {
    const controller = new AbortController();
    require('child_process').execFile('sleep', ['5'], { signal: controller.signal }, (error) => {
      resolve(error && (error.name + ':' + error.code));
    });
    setTimeout(() => controller.abort(), 50);
  })`);
  assert.equal(result, 'AbortError:ABORT_ERR');
});

test('crypto hashes through a remote stream', () => {
  const page = createPage();
  const hash = page.run(`require('crypto').createHash('sha256').update('abc').digest('hex')`);
  assert.equal(hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
