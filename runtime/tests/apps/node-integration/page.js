// Runs as a page script: require, module, process, Buffer and __dirname are
// globals here.
(async () => {
  const { ipcRenderer } = require('electron');
  const report = {};
  const check = async (name, test) => {
    try {
      const result = await test();
      report[name] = result === true ? true : `got ${JSON.stringify(result)}`;
    } catch (error) {
      report[name] = `threw ${error && error.stack || error}`;
    }
  };
  const started = performance.now();
  const fs = require('fs');
  const os = require('os');
  const Path = require('path');
  const { spawn, execFile } = require('child_process');
  const { promisify } = require('util');
  const { Transform } = require('stream');

  await check('globals', () => typeof module.exports === 'object' && __dirname.endsWith('node-integration')
    && typeof process.env.HOME === 'string' && typeof setImmediate === 'function' && global === window);
  await check('buffer', () => Buffer.from('aGVsbG8=', 'base64').toString() === 'hello');
  await check('fs', async () => {
    const file = Path.join(os.tmpdir(), 'aurora-node-integration.txt');
    await fs.promises.writeFile(file, 'written by the page');
    const stats = await fs.promises.stat(file);
    const bytes = fs.readFileSync(file);
    return stats.isFile() && stats.size === 19 && Buffer.isBuffer(bytes) && bytes.toString() === 'written by the page';
  });
  await check('execFile', async () => {
    const result = await promisify(execFile)('echo', ['from execFile']);
    return result.stdout === 'from execFile\n' || { stdout: result.stdout, type: typeof result, keys: Object.keys(result) };
  });
  await check('spawn streams', () => new Promise((resolve) => {
    const child = spawn('sh', ['-c', 'read line; echo "got $line"; echo "progress 50%" >&2']);
    const lines = [];
    child.stderr.pipe(new Transform({ transform(chunk, encoding, callback) {
      callback(null, chunk.toString().trim());
    } })).on('data', (line) => lines.push(String(line)));
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stdin.end('hello\n');
    child.on('close', (code) => resolve((code === 0 && stdout === 'got hello\n' && lines[0] === 'progress 50%') || { code, stdout, lines }));
  }));
  await check('net server and client', () => new Promise((resolve) => {
    const net = require('net');
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => socket.end(`echo:${chunk}`));
    });
    server.listen(0, '127.0.0.1', () => {
      const client = net.connect(server.address().port, '127.0.0.1', () => client.write('ping'));
      let text = '';
      client.on('data', (data) => { text += data; });
      client.on('end', () => {
        server.close();
        resolve(text === 'echo:ping');
      });
      client.on('error', (error) => resolve(String(error)));
    });
  }));
  await check('dlopen keytar stand-in', () => {
    const module = { exports: {} };
    process.dlopen(module, Path.join(__dirname, 'keytar.node'));
    return typeof module.exports.getPassword === 'function';
  });
  await check('clipboard', () => {
    const { clipboard } = require('electron');
    return typeof clipboard.writeText === 'function';
  });
  await check('setImmediate is fast', () => new Promise((resolve) => {
    const begin = performance.now();
    let count = 0;
    const next = () => (++count < 100 ? setImmediate(next) : resolve(performance.now() - begin < 200));
    setImmediate(next);
  }));
  ipcRenderer.send('timing', `checks took ${Math.round(performance.now() - started)} ms`);
  ipcRenderer.send('report', report);
})();
