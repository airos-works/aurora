'use strict';

// A utility process (electron.utilityProcess.fork): plain Node.js started
// by the main process with an IPC channel, made to look like Electron's
// utility process before the app's module runs:
//
//   node utility.js <module> [args...]
//
// process.parentPort talks to the main process; ports it sends arrive as
// MessagePortMain objects (electron/message-ports.js), and ports created
// here can be sent back.

const path = require('path');
const { pathToFileURL } = require('url');
const { applyAppOverrides, installModuleHooks } = require('./node-setup');

const info = JSON.parse(process.env.AURORA_UTILITY || '{}');
delete process.env.AURORA_UTILITY;

const rawSend = process.send.bind(process);
// Nothing is sent once the main process is gone (see 'disconnect' below).
const send = (message) => {
  if (!process.connected)
    return;
  try {
    rawSend(message);
  } catch {}
};
const ports = require('./electron/message-ports');
const link = ports.createLink('parent', (packet) => send({ $aurora: 'port', packet }));

class ParentPort extends require('events').EventEmitter {
  constructor() {
    super();
    this._started = false;
    this._queue = [];
    // Electron starts the port when the first 'message' listener comes.
    this.on('newListener', (name) => {
      if (name === 'message')
        setImmediate(() => this.start());
    });
  }

  start() {
    if (this._started)
      return;
    this._started = true;
    for (const event of this._queue.splice(0))
      this.emit('message', event);
  }

  pause() {
    this._started = false;
  }

  postMessage(message) {
    send({ $aurora: 'parent', data: message });
  }

  _receive(event) {
    if (this._started)
      this.emit('message', event);
    else
      this._queue.push(event);
  }
}

const parentPort = new ParentPort();
process.on('message', (message) => {
  if (!message || typeof message !== 'object')
    return;
  if (message.$aurora === 'parent') {
    const transferred = ports.portsFrom(link, message.ports);
    for (const port of transferred)
      port._arrive();
    parentPort._receive({ data: message.data, ports: transferred });
  } else if (message.$aurora === 'port') {
    ports.receive(link, message.packet);
  }
});
// Electron's utility processes end with the main process: here the channel
// closes when it does, even when it is killed.
process.on('disconnect', () => process.exit(0));
// The channel to the main process must not keep the process alive by
// itself, as Electron's does not: a utility process ends when its work does.
if (process.channel && typeof process.channel.unref === 'function')
  process.channel.unref();
parentPort.on('newListener', (name) => {
  if (name === 'message' && process.channel && typeof process.channel.ref === 'function')
    process.channel.ref();
});
parentPort.on('removeListener', (name) => {
  if (name === 'message' && !parentPort.listenerCount('message') && process.channel && typeof process.channel.unref === 'function')
    process.channel.unref();
});

// Electron's utility process has no process.send: code that tells a forked
// child from a utility process by it must see the latter.
delete process.send;
Object.defineProperty(process, 'parentPort', { value: parentPort, enumerable: true, configurable: true });
process.type = 'utility';
process.versions.electron = info.electronVersion || '43.0.0';
process.versions.chrome = info.chromeVersion || '150.0.0.0';
if (info.auroraVersion)
  process.versions.aurora = info.auroraVersion;
if (info.resourcesPath)
  process.resourcesPath = info.resourcesPath;
applyAppOverrides({ execPath: false });
installModuleHooks(path.join(__dirname, 'electron', 'utility.js'), path.join(__dirname, 'electron', 'utility-esm.mjs'));

const modulePath = path.resolve(process.argv[2]);
process.argv = [process.execPath, modulePath, ...process.argv.slice(3)];
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[utility] unhandled promise rejection: ${reason && reason.stack || reason}\n`);
});
import(pathToFileURL(modulePath).href).catch((error) => {
  process.stderr.write(`aurora: the utility process ${modulePath} failed to start:\n${error && error.stack || error}\n`);
  process.exit(1);
});
