#!/usr/bin/env node
'use strict';

// A stand-in for aurora-host that speaks its protocol, for testing the
// runtime on machines without Haiku. Pages are not rendered: a page's inline
// <script>s and the window's user scripts run in a Node.js vm context with a
// minimal document, and window.webkit.messageHandlers.aurora goes to the
// runtime like the real engine's. Enough for preloads, contextBridge, IPC,
// executeJavaScript, window lifecycles, menus and dialogs.

const fs = require('fs');
const os = require('os');
const vm = require('vm');
const { fileURLToPath } = require('url');

const RS = '\x1e';
const log = (...args) => process.env.MOCK_HOST_VERBOSE && process.stderr.write(`[mock-host] ${args.join(' ')}\n`);

function send(event) {
  process.stdout.write(`${RS}${JSON.stringify(event)}\n`);
}

function respond(command, result) {
  if (command.req)
    send({ ev: 'response', req: command.req, result: result === undefined ? null : result });
}

const windows = new Map();
const replies = new Map();
let nextToken = 1;
let generation = 1;
let applicationMenu = null;

function makeDocument(title) {
  const listeners = new Map();
  const element = () => ({ textContent: '', innerHTML: '', dataset: {}, style: {}, children: [],
    appendChild(child) { this.children.push(child); return child; }, remove() {}, setAttribute() {} });
  return {
    readyState: 'loading',
    title,
    head: element(),
    body: element(),
    documentElement: element(),
    addEventListener(type, listener) {
      if (!listeners.has(type))
        listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener() {},
    dispatch(type) {
      for (const listener of listeners.get(type) || [])
        listener({ type });
    },
    createElement: element,
    getElementById: () => element(),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function makeContext(window, url, title) {
  const document = makeDocument(title);
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, structuredClone,
    TextEncoder, TextDecoder, URL, URLSearchParams, performance, btoa, atob, Promise,
    Uint8Array, ArrayBuffer, DataView, Float32Array, Float64Array, Int8Array, Int16Array, Int32Array,
    Uint16Array, Uint32Array, Uint8ClampedArray, BigInt64Array, BigUint64Array, Map, Set, Date, RegExp, Error,
    document,
    location: { href: url },
    navigator: { userAgent: window.options.userAgent || 'mock' },
    XMLHttpRequest: class { open() {} setRequestHeader() {} send() { throw new Error('No synchronous requests in the mock host'); } },
    webkit: {
      messageHandlers: {
        aurora: {
          postMessage(body) {
            const token = nextToken++;
            send({ ev: 'ipc.message', id: window.id, token, name: 'aurora', body: String(body), bodyType: 'string',
              mainFrame: true, frameUrl: url, origin: 'null' });
            return new Promise((resolve, reject) => replies.set(token, { resolve, reject }));
          },
        },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.globalThis = sandbox;
  return vm.createContext(sandbox);
}

function state(window, fields) {
  send({ ev: 'wc.state', id: window.id, url: window.url, title: window.title, loading: false, progress: 1,
    canGoBack: false, canGoForward: false, zoom: 1, ...fields });
}

function loadPage(window, url) {
  window.url = url;
  const loadGeneration = generation++;
  state(window, { loading: true, progress: 0.1, loadGeneration, loadOutcome: 'loading' });
  let html = '';
  try {
    if (url.startsWith('file:'))
      html = fs.readFileSync(fileURLToPath(url), 'utf8');
    else if (url.startsWith('data:text/html,'))
      html = decodeURIComponent(url.slice('data:text/html,'.length));
  } catch (error) {
    state(window, { loading: false, loadGeneration, loadOutcome: 'failed',
      loadError: { code: 2, description: error.message, domain: 'mock', url, provisional: true } });
    return;
  }
  const title = (/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || '';
  window.context = makeContext(window, url, title);
  const scripts = window.userScripts || [];
  setImmediate(() => {
    for (const script of scripts) {
      try {
        vm.runInContext(script.source, window.context, { filename: 'aurora-bridge.js' });
      } catch (error) {
        process.stderr.write(`[mock-host] user script failed: ${error.stack}\n`);
      }
    }
    const pattern = /<script>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = pattern.exec(html))) {
      try {
        vm.runInContext(match[1], window.context, { filename: url });
      } catch (error) {
        process.stderr.write(`[mock-host] page script failed: ${error.stack}\n`);
      }
    }
    window.context.document.readyState = 'complete';
    window.context.document.dispatch('DOMContentLoaded');
    window.title = title;
    state(window, { loading: false, loadGeneration, loadOutcome: 'succeeded' });
    if (!window.readySent) {
      window.readySent = true;
      send({ ev: 'window.event', id: window.id, type: 'ready-to-show', bounds: window.bounds });
    }
  });
}

async function exec(window, command) {
  if (!window.context) {
    send({ ev: 'js.result', id: window.id, req: command.req || 0, error: 'No page' });
    return;
  }
  try {
    const code = command.async ? `(async () => { ${command.code} })()` : command.code;
    const value = await vm.runInContext(code, window.context);
    if (value === undefined)
      send({ ev: 'js.result', id: window.id, req: command.req || 0, result: '', resultType: 'undefined' });
    else if (typeof value === 'string')
      send({ ev: 'js.result', id: window.id, req: command.req || 0, result: value, resultType: 'string' });
    else
      send({ ev: 'js.result', id: window.id, req: command.req || 0, result: JSON.stringify(value), resultType: 'json' });
  } catch (error) {
    send({ ev: 'js.result', id: window.id, req: command.req || 0, error: String(error && error.message || error) });
  }
}

function closeWindow(window) {
  windows.delete(window.id);
  send({ ev: 'window.closed', id: window.id });
}

// Cookie jars per partition, standing in for the engine's website data.
const jars = new Map();

function jar(partition) {
  if (!jars.has(partition || ''))
    jars.set(partition || '', []);
  return jars.get(partition || '');
}

function cookieForURL(cookie, address) {
  const url = new URL(address);
  const domain = cookie.domain.replace(/^\./, '');
  const hostMatches = cookie.domain.startsWith('.')
    ? url.hostname === domain || url.hostname.endsWith(`.${domain}`) : url.hostname === domain;
  return hostMatches && url.pathname.startsWith(cookie.path) && (!cookie.secure || url.protocol === 'https:');
}

function handle(command) {
  log(JSON.stringify(command).slice(0, 300));
  const window = command.id !== undefined ? windows.get(command.id) : null;
  switch (command.cmd) {
  case 'init':
    return respond(command);
  case 'window.create': {
    const options = command.options || {};
    const opener = options.inheritScriptsFrom !== undefined ? windows.get(options.inheritScriptsFrom) : null;
    const created = { id: command.id, options, userScripts: opener ? opener.userScripts : options.userScripts,
      bounds: { x: options.x || 0, y: options.y || 0, width: options.width || 800, height: options.height || 600 },
      title: options.title || '', url: '', menu: options.menu };
    windows.set(command.id, created);
    return respond(command, { id: command.id });
  }
  case 'window.show':
    if (window) {
      send({ ev: 'window.event', id: window.id, type: 'show', bounds: window.bounds });
      send({ ev: 'window.event', id: window.id, type: 'focus', bounds: window.bounds });
    }
    return respond(command, window && window.bounds);
  case 'window.close':
    if (window && process.env.MOCK_HOST_KEEP_ON_CLOSE)
      send({ ev: 'window.close-cancelled', id: window.id });
    else if (window)
      closeWindow(window);
    return respond(command);
  case 'window.destroy':
    if (window)
      closeWindow(window);
    return respond(command);
  case 'window.setTitle':
    if (window)
      window.title = command.title;
    return respond(command);
  case 'window.setMenu':
    if (window)
      window.menu = command.menu;
    return respond(command);
  case 'menu.setApplicationMenu':
    applicationMenu = command.menu;
    return respond(command);
  case 'wc.loadURL':
    if (window)
      loadPage(window, command.url);
    return respond(command);
  case 'wc.exec':
    if (window)
      exec(window, command);
    else
      send({ ev: 'js.result', id: command.id, req: command.req || 0, error: 'No such window' });
    return;
  case 'ipc.reply': {
    const pending = replies.get(command.token);
    if (!pending)
      return;
    replies.delete(command.token);
    if (command.error !== undefined)
      pending.reject(new Error(command.error));
    else
      pending.resolve(command.reply);
    return;
  }
  case 'dialog.open':
    return respond(command, { canceled: false, filePaths: [process.env.MOCK_HOST_OPEN_PATH || '/tmp/example.txt'] });
  case 'dialog.save':
    return respond(command, { canceled: false, filePath: process.env.MOCK_HOST_SAVE_PATH || '/tmp/saved.txt' });
  case 'dialog.message':
    return respond(command, { response: Number(process.env.MOCK_HOST_MESSAGE_RESPONSE || 0), checkboxChecked: false });
  case 'menu.popup':
    respond(command);
    setImmediate(() => send({ ev: 'menu.closed', popup: command.req }));
    return;
  case 'mock.menuClick':
    return;
  case 'session.cookies.get': {
    const cookies = jar(command.partition);
    return respond(command, command.url ? cookies.filter((cookie) => cookieForURL(cookie, command.url)) : cookies);
  }
  case 'session.cookies.set': {
    const cookies = jar(command.partition);
    const cookie = { session: command.cookie.expires === undefined, ...command.cookie };
    const index = cookies.findIndex((other) => other.name === cookie.name && other.domain === cookie.domain && other.path === cookie.path);
    if (index >= 0)
      cookies.splice(index, 1);
    cookies.push(cookie);
    return respond(command);
  }
  case 'session.cookies.remove': {
    const cookies = jar(command.partition);
    jars.set(command.partition || '', cookies.filter((cookie) =>
      !((!command.url || cookieForURL(cookie, command.url)) && (!command.name || cookie.name === command.name))));
    return respond(command);
  }
  case 'session.clearData':
    if (command.types & 1)
      jars.set(command.partition || '', []);
    return respond(command);
  case 'app.quit':
    send({ ev: 'mock.quitting' });
    process.exit(0);
    return;
  default:
    return respond(command);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const start = line.indexOf(RS);
    if (start >= 0)
      handle(JSON.parse(line.slice(start + 1)));
  }
});
process.stdin.on('end', () => process.exit(0));

console.log('this line is noise that the runtime must ignore');
send({
  ev: 'ready', engine: true, engineError: '', embedding: true, websiteData: true,
  screens: [{ id: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1056 }, scaleFactor: 1 }],
  darkMode: false, clipboard: { text: '', html: '' },
  paths: { home: os.homedir(), settings: process.env.MOCK_HOST_SETTINGS || os.tmpdir(), cache: os.tmpdir(),
    desktop: os.tmpdir(), downloads: os.tmpdir(), temp: os.tmpdir() },
});
