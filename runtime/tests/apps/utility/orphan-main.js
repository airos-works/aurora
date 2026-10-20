'use strict';

// tests/message-ports.test.js: a main process that starts a utility process,
// prints its pid and is then killed, as a crashed app would be.
const path = require('path');
const { state } = require('../../../lib/electron/common');
state.nodePath = process.execPath;
const { utilityProcess, MessageChannelMain } = require('../../../lib/electron/extras');

const child = utilityProcess.fork(path.join(__dirname, 'child.mjs'), [], { stdio: 'ignore' });
const { port2 } = new MessageChannelMain();
child.postMessage('port for you', [port2]);
child.on('message', () => {
  process.stdout.write(`${child.pid}\n`, () => process.kill(process.pid, 'SIGKILL'));
});
