'use strict';

// Runtime tests that need no Haiku: `npm test` or `node --test tests/`.

const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const RUNTIME = path.resolve(__dirname, '..');
const MOCK_HOST = path.join(__dirname, 'mock-host.js');

function runApp(app, env = {}) {
  const settings = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-test-'));
  const result = spawnSync(process.execPath, [path.join(RUNTIME, 'lib/main.js'), app], {
    env: { ...process.env, AURORA_HOST: MOCK_HOST, MOCK_HOST_SETTINGS: settings, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
  fs.rmSync(settings, { recursive: true, force: true });
  return result;
}

test('values survive the trip between processes', () => {
  const { encode, decode } = require('../lib/serialize');
  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  const value = {
    undefinedValue: undefined, notANumber: NaN, infinity: -Infinity, big: 12n, date: new Date(1234),
    pattern: /a+b/gi, map: new Map([[1, { deep: true }]]), set: new Set(['x']), bytes: Buffer.from('hi'),
    floats: new Float64Array([0.5, 2]), error: new RangeError('bad'), list: [1, null, undefined], cyclic,
    $a: 'a key that looks like a tag',
  };
  const copy = decode(JSON.parse(JSON.stringify(encode(value))));
  assert.equal(copy.undefinedValue, undefined);
  assert.ok('undefinedValue' in copy);
  assert.ok(Number.isNaN(copy.notANumber));
  assert.equal(copy.infinity, -Infinity);
  assert.equal(copy.big, 12n);
  assert.equal(copy.date.getTime(), 1234);
  assert.equal(copy.pattern.flags, 'gi');
  assert.deepEqual(copy.map.get(1), { deep: true });
  assert.ok(copy.set.has('x'));
  assert.ok(copy.bytes instanceof Uint8Array && !Buffer.isBuffer(copy.bytes));
  assert.deepEqual([...copy.floats], [0.5, 2]);
  assert.equal(copy.error.name, 'RangeError');
  assert.deepEqual(copy.list, [1, null, undefined]);
  assert.equal(copy.cyclic.self, copy.cyclic);
  assert.equal(copy.$a, value.$a);
});

test('accelerators become Haiku shortcuts only with Command and without Alt', () => {
  const { parseAccelerator } = require('../lib/electron/menu');
  assert.deepEqual(parseAccelerator('CmdOrCtrl+Shift+Z'),
    { command: true, alt: false, modifiers: ['shift'], key: 'Z', label: 'Alt+Shift+Z' });
  assert.equal(parseAccelerator('Ctrl++').key, '+');
  assert.equal(parseAccelerator('Shift+Alt+Q').command, false);
  assert.equal(parseAccelerator('F11').label, 'F11');
  assert.equal(parseAccelerator(''), null);
});

test('menus serialize with roles, labels and ids', () => {
  const { Menu, serializeMenu } = require('../lib/electron/menu');
  const menu = Menu.buildFromTemplate([{ role: 'editMenu' }, { label: '&File', submenu: [{ label: 'Open', click() {} }] }]);
  const items = serializeMenu(menu, 99);
  assert.equal(items[0].label, 'Edit');
  assert.equal(items[0].submenu[0].role, 'undo');
  assert.equal(items[1].submenu[0].role, undefined);
  assert.ok(items[1].submenu[0].id);
  assert.equal(menu.getMenuItemById('nothing'), null);
});

test('asar archives unpack beside their unpacked files and neighbours', () => {
  const { unpack, readHeader } = require('../lib/asar');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-asar-'));
  // A minimal archive with two files, one of them "unpacked".
  const content = Buffer.from('module.exports = 42;\n');
  const header = { files: { 'package.json': { size: 13, offset: '0' }, lib: { files: {
    'answer.js': { size: content.length, offset: '13' }, 'native.node': { size: 4, unpacked: true } } } } };
  const json = Buffer.from(JSON.stringify(header));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4);
  json.copy(padded);
  const pickle = Buffer.alloc(8 + padded.length);
  pickle.writeUInt32LE(4 + padded.length, 0);
  pickle.writeInt32LE(json.length, 4);
  padded.copy(pickle, 8);
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(pickle.length, 4);
  const archive = path.join(directory, 'app.asar');
  fs.writeFileSync(archive, Buffer.concat([prefix, pickle, Buffer.from('{"main":"x"}\n'), content]));
  fs.mkdirSync(path.join(directory, 'app.asar.unpacked', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'app.asar.unpacked', 'lib', 'native.node'), 'ELF!');
  fs.writeFileSync(path.join(directory, 'beside.txt'), 'next door');
  assert.equal(readHeader(archive).json.files.lib.files['answer.js'].size, content.length);
  const unpacked = unpack(archive, path.join(directory, 'cache'));
  assert.equal(path.basename(unpacked), 'app.asar');
  assert.equal(fs.readFileSync(path.join(unpacked, 'lib/answer.js'), 'utf8'), content.toString());
  assert.equal(fs.readFileSync(path.join(unpacked, 'lib/native.node'), 'utf8'), 'ELF!');
  assert.equal(JSON.parse(fs.readFileSync(path.join(unpacked, 'package.json'), 'utf8')).main, 'x');
  // Paths that climb out of the archive reach its neighbours.
  assert.equal(fs.readFileSync(path.join(unpacked, '..', 'beside.txt'), 'utf8'), 'next door');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('preloads are bundled with the files they require', () => {
  const { bundle } = require('../lib/renderer/bridge');
  const modules = bundle(path.join(__dirname, 'apps/basic/preload.js'));
  assert.equal(modules.length, 2);
  assert.ok(modules[0].file.endsWith('preload.js'));
  assert.equal(modules[0].dependencies['./helper.js'], 1);
  assert.equal(modules[0].dependencies['electron/renderer'], undefined);
});

test('an ESM app with a preload runs end to end on the mock host', () => {
  const result = runApp(path.join(__dirname, 'apps/basic'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS$/m);
  assert.match(result.stdout, /^quit event$/m);
});

test('session cookies and clearStorageData reach the host', () => {
  const result = runApp(path.join(__dirname, 'apps/cookies'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS$/m);
});

test('a tray reports clicks and pops up its menu where it was clicked', () => {
  const result = runApp(path.join(__dirname, 'apps/tray'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS$/m);
});

test('an app started without PATH or HOME gets Haiku\'s defaults', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-env-'));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'aurora-env-test', main: 'main.js' }));
  fs.writeFileSync(path.join(app, 'main.js'), `
    const { app } = require('electron');
    console.log('PATH=' + process.env.PATH);
    console.log('HOME=' + process.env.HOME);
    app.whenReady().then(() => app.quit());
  `);
  // The mock host finds node through PATH (#!/usr/bin/env node): name it.
  const host = path.join(app, 'mock-host');
  fs.writeFileSync(host, `#!/bin/sh\nexec "${process.execPath}" "${MOCK_HOST}" "$@"\n`, { mode: 0o755 });
  const result = runApp(app, { PATH: '', HOME: '', AURORA_HOST: host });
  fs.rmSync(app, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^PATH=.*:\/bin:/m);
  assert.match(result.stdout, /^HOME=\/.+/m);
});

test('net.request takes a response callback and decodes compressed responses', async () => {
  const http = require('http');
  const zlib = require('zlib');
  const { request } = require('../lib/electron/net-request');
  const server = http.createServer((incoming, response) => {
    const accepted = incoming.headers['accept-encoding'] || '';
    response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': accepted.includes('gzip') ? 'gzip' : 'identity' });
    const body = Buffer.from(JSON.stringify({ path: incoming.url, accepted }));
    response.end(accepted.includes('gzip') ? zlib.gzipSync(body) : body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const answer = await new Promise((resolve, reject) => {
    const clientRequest = request({ protocol: 'http:', hostname: '127.0.0.1', port, path: '/gallery?x=1' }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, encoding: response.headers['content-encoding'], body: JSON.parse(text) }));
    });
    clientRequest.on('error', reject);
    clientRequest.end();
  });
  server.close();
  assert.equal(answer.status, 200);
  assert.equal(answer.encoding, undefined);
  assert.equal(answer.body.path, '/gallery?x=1');
  assert.match(answer.body.accepted, /gzip/);
});
