'use strict';

// MessagePorts between the main process, a page and a utility process. The
// page is the bridge in a vm context, wired to a real WebContents through a
// stand-in host that runs the main process's scripts in it. `node --test tests/`.

const assert = require('assert/strict');
const path = require('path');
const test = require('node:test');
const vm = require('vm');
const { MessageChannel } = require('worker_threads');
const { state } = require('../lib/electron/common');
const { buildBridgeScript } = require('../lib/renderer/bridge');
const { WebContents } = require('../lib/electron/web-contents');
const { MessageChannelMain } = require('../lib/electron/message-ports');
const { ipcMain } = require('../lib/electron/ipc-main');
const { utilityProcess } = require('../lib/electron/extras');

function createPage() {
  let context = null;
  const window = { id: 77, _bridgeToken: 't', _pageTitleUpdated() {} };
  const contents = new WebContents(window, {});
  state.host = {
    send(command, fields) {
      if (command === 'wc.exec')
        setImmediate(() => vm.runInContext(fields.code, context));
    },
    request: () => Promise.resolve(null),
  };
  const handler = { postMessage(text) {
    setImmediate(() => contents._ipcMessage({ body: text, token: 1, frameUrl: 'vscode-file://app/index.html', origin: '' }));
    return Promise.resolve('null');
  } };
  context = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, URL, URLSearchParams, atob, btoa,
    MessageChannel: PageChannel,
    location: { protocol: 'vscode-file:', pathname: '/index.html', href: 'vscode-file://app/index.html' },
    navigator: { platform: 'Haiku x86_64' },
    document: { readyState: 'complete', title: '', addEventListener() {}, documentElement: {} },
    addEventListener() {},
    webkit: { messageHandlers: { aurora: handler } },
  });
  vm.runInContext('window = globalThis; window.top = window;', context);
  vm.runInContext(buildBridgeScript({ preloadFiles: [path.join(__dirname, 'apps/ports/preload.js')], token: 't',
    versions: process.versions, resourcesPath: '/', systemVersion: '1' }), context);
  return { context, contents };
}

// Node.js stays alive for a port with a listener: the pages' ports close
// when the tests end.
const channels = [];
function PageChannel() {
  const channel = new MessageChannel();
  channels.push(channel);
  return channel;
}
test.after(() => {
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test('a port given to a page carries messages both ways and closes', async () => {
  const { context, contents } = createPage();
  vm.runInContext(`
    ipc.on('take-port', (event, message) => {
      const [port] = event.ports;
      window.taken = message;
      port.onmessage = (inner) => port.postMessage(ArrayBuffer.isView(inner.data)
        ? new Uint8Array([...inner.data].map((value) => value * 2)) : 'echo:' + inner.data);
    });
  `, context);
  const { port1, port2 } = new MessageChannelMain();
  const received = [];
  port1.on('message', (event) => received.push(event.data));
  port1.start();
  contents.postMessage('take-port', { nonce: 'n1' }, [port2]);
  await settle();
  assert.deepEqual({ ...context.taken }, { nonce: 'n1' });
  port1.postMessage('hi');
  port1.postMessage(new Uint8Array([1, 2, 3]));
  await settle();
  assert.equal(received[0], 'echo:hi');
  assert.deepEqual([...received[1]], [2, 4, 6]);
  // A new document: the page's ports are gone, and their peers hear it.
  let closed = false;
  port1.on('close', () => { closed = true; });
  contents._state({ url: 'vscode-file://app/index.html', loadGeneration: 2, loadOutcome: 'loading', loading: true });
  assert.equal(closed, true);
  contents._destroy();
});

test('a page sends its own port to the main process', async () => {
  const { context, contents } = createPage();
  const got = new Promise((resolve) => ipcMain.once('page-port', (event, message) => resolve({ event, message })));
  vm.runInContext(`
    const channel = new MessageChannel();
    window.answers = [];
    channel.port1.onmessage = (event) => window.answers.push(event.data);
    ipc.postMessage('page-port', 'take this', [channel.port2]);
  `, context);
  const { event, message } = await got;
  assert.equal(message, 'take this');
  const [port] = event.ports;
  port.on('message', (inner) => port.postMessage(`main:${inner.data}`));
  port.start();
  port.postMessage('first');
  await settle();
  vm.runInContext(`channel.port1.postMessage('second')`, context);
  await settle();
  assert.deepEqual([...context.answers], ['first', 'main:second']);
  vm.runInContext(`channel.port1.close()`, context);
  port.close();
  contents._destroy();
});

test('a page and a utility process talk through ports the main process made', async () => {
  state.nodePath = process.execPath;
  const { context, contents } = createPage();
  vm.runInContext(`
    window.fromChild = [];
    ipc.on('to-child', (event) => {
      const [port] = event.ports;
      port.onmessage = (inner) => window.fromChild.push(inner.data);
      port.postMessage('hello child');
      port.postMessage(new Uint8Array([7, 8]));
    });
  `, context);
  const child = utilityProcess.fork(path.join(__dirname, 'apps/utility/child.mjs'), ['--flag'], { stdio: 'pipe' });
  const messages = [];
  child.on('message', (message) => messages.push(message));
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage('port for you', [port1]);
  contents.postMessage('to-child', null, [port2]);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(messages[0].type, 'ready');
  assert.deepEqual(messages[0].argv, ['--flag']);
  assert.equal(messages[0].hasSend, 'undefined');
  assert.equal(context.fromChild[0], 'echo:hello child');
  assert.deepEqual([...context.fromChild[1].bytes], [7, 8]);
  // The page's document goes: the child's port closes.
  contents._destroy();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(messages.includes('port closed'));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  child.kill();
  await exited;
});
