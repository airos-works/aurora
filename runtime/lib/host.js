'use strict';

// The connection to aurora-host, the native process that owns the windows.
// Messages are JSON lines starting with an ASCII record separator (0x1e);
// see docs/PROTOCOL.md. Other output of the host is passed to our stderr.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const RS = '\x1e';
const TRACE = process.env.AURORA_TRACE === '1';

function trace(direction, text) {
  if (TRACE)
    process.stderr.write(`[aurora ${direction}] ${text.length > 400 ? `${text.slice(0, 400)}…` : text}\n`);
}

function exists(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readSettings() {
  const home = process.env.HOME || '/boot/home';
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'config/settings/Aurora/settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

// Where the native host and the WebKit engine are. Environment variables
// win, then ~/config/settings/Aurora/settings.json, then the installed and
// source-tree layouts.
function locate() {
  const settings = readSettings();
  const runtimeRoot = path.resolve(__dirname, '..');
  const hostCandidates = [
    process.env.AURORA_HOST,
    settings.host,
    path.join(runtimeRoot, 'aurora-host'),
    path.join(runtimeRoot, '..', 'aurora-host'),
    path.join(runtimeRoot, '..', 'host', 'aurora-host'),
    path.join(runtimeRoot, '..', 'build', 'aurora-host'),
  ].filter(Boolean);
  const host = hostCandidates.find(exists) || hostCandidates[hostCandidates.length - 1];
  const bundleCandidates = [
    process.env.AURORA_WEBKIT_BUNDLE,
    settings.webkitBundle,
    path.join(runtimeRoot, 'webkit'),
    '/boot/system/data/summit/webkit',
    '/boot/home/config/non-packaged/data/summit/webkit',
  ].filter(Boolean);
  const bundle = bundleCandidates.find((candidate) => fs.existsSync(path.join(candidate, 'lib'))) || null;
  const mesaCandidates = [process.env.AURORA_MESA_LIB, settings.mesaLib, '/boot/home/summit-mesa/prefix/lib'].filter(Boolean);
  const mesa = mesaCandidates.find((candidate) => fs.existsSync(candidate)) || null;
  return { host, bundle, mesa };
}

class Host extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.nextRequest = 1;
    this.pending = new Map();
    this.scripts = new Map();
    this.buffer = '';
    this.child = null;
    this.exited = false;
  }

  // Launcher mode: the host started us and waits on descriptors 3 and 4.
  attach(input, output) {
    const net = require('net');
    const reader = new net.Socket({ fd: input, readable: true, writable: false });
    const writer = new net.Socket({ fd: output, readable: false, writable: true });
    this.child = { stdin: writer, stdout: reader, pid: 0 };
    reader.setEncoding('utf8');
    reader.on('data', (chunk) => this.receive(chunk));
    writer.on('error', () => {});
    reader.on('close', () => {
      this.exited = true;
      for (const { reject } of [...this.pending.values(), ...this.scripts.values()])
        reject(new Error('The Aurora host exited'));
      this.pending.clear();
      this.scripts.clear();
      this.emit('exit', { code: 0, signal: null });
    });
  }

  start() {
    if (process.env.AURORA_HOST_FDS) {
      const [input, output] = process.env.AURORA_HOST_FDS.split(',').map(Number);
      delete process.env.AURORA_HOST_FDS;
      this.attach(input, output);
      return;
    }
    const { host, bundle, mesa } = this.options.location || locate();
    const env = { ...process.env, ...(this.options.env || {}), AURORA_HOST_CHILD: '1' };
    if (bundle) {
      env.WEBKIT_EXEC_PATH = bundle;
      const libraries = [mesa, path.join(bundle, 'lib'), env.LIBRARY_PATH || '/boot/system/lib'].filter(Boolean);
      env.LIBRARY_PATH = libraries.join(':');
    }
    const args = this.options.signature ? ['--signature', this.options.signature] : [];
    this.child = spawn(this.options.command || host, [...(this.options.commandArgs || []), ...args], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
    });
    this.child.on('error', (error) => {
      this.exited = true;
      this.emit('exit', { code: null, error });
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.receive(chunk));
    this.child.stdin.on('error', () => {});
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      for (const { reject } of [...this.pending.values(), ...this.scripts.values()])
        reject(new Error('The Aurora host exited'));
      this.pending.clear();
      this.scripts.clear();
      this.emit('exit', { code, signal });
    });
  }

  receive(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const start = line.indexOf(RS);
      if (start < 0) {
        if (line.trim())
          process.stderr.write(`[aurora-host] ${line}\n`);
        continue;
      }
      let message;
      trace('<', line.slice(start + 1));
      try {
        message = JSON.parse(line.slice(start + 1));
      } catch (error) {
        process.stderr.write(`[aurora] unreadable host message: ${error.message}\n`);
        continue;
      }
      this.dispatch(message);
    }
  }

  dispatch(message) {
    if (message.ev === 'response') {
      const pending = this.pending.get(message.req);
      if (!pending)
        return;
      this.pending.delete(message.req);
      if (message.error !== undefined)
        pending.reject(new Error(message.error));
      else
        pending.resolve(message.result);
      return;
    }
    if (message.ev === 'js.result') {
      const pending = this.scripts.get(message.req);
      if (pending) {
        this.scripts.delete(message.req);
        if (message.error !== undefined)
          pending.reject(new Error(message.error));
        else
          pending.resolve(message);
      }
      return;
    }
    this.emit('event', message);
    this.emit(message.ev, message);
  }

  // Runs a script in a window's page; resolves with the js.result message.
  script(windowId, code, asAsyncFunction) {
    if (this.exited || !this.child)
      return Promise.reject(new Error('The Aurora host is not running'));
    const req = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.scripts.set(req, { resolve, reject });
      this.send('wc.exec', { id: windowId, code, async: !!asAsyncFunction, req });
    });
  }

  send(command, fields = {}) {
    if (this.exited || !this.child)
      return;
    const line = RS + JSON.stringify({ cmd: command, ...fields }) + '\n';
    trace('>', line.slice(1, -1));
    this.child.stdin.write(line);
  }

  request(command, fields = {}) {
    if (this.exited || !this.child)
      return Promise.reject(new Error('The Aurora host is not running'));
    const req = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.pending.set(req, { resolve, reject });
      this.send(command, { ...fields, req });
    });
  }

  stop() {
    if (this.child && !this.exited) {
      try {
        this.child.stdin.end();
      } catch {}
    }
  }
}

module.exports = { Host, locate };
