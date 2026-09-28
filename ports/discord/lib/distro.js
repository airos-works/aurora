'use strict';

// Discord's own distribution service, as its Rust updater uses it: a JSON
// manifest names a "full" package for the host and for each module, with its
// SHA-256; a package is a Brotli-compressed tar with delta_manifest.json and
// files/<path>. Haiku has no build of Discord's host, so only the parts that
// run under Aurora are installed: the host's resources/ (the bootstrap app)
// and the modules, whose JavaScript runs and whose Linux native parts are
// replaced (see ../shims) or reported missing.
//
// Layout, as Discord's Linux client keeps it:
//   <root>/app-<host version>/Discord          the launcher (aurora-host)
//   <root>/app-<host version>/aurora.json
//   <root>/app-<host version>/resources/...
//   <root>/app-<host version>/modules/<name>-<version>/<name>/...
//   <root>/aurora-installer.json               what is installed

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const UPDATES = 'https://updates.discord.com/';
// The modules Discord's Linux bootstrap installs before the first start; the
// rest (krisp, rpc, game utils...) are installed when the client asks.
const INITIAL_MODULES = ['discord_desktop_core', 'discord_utils', 'discord_voice', 'discord_erlpack', 'discord_spellcheck'];
const STATE_FILE = 'aurora-installer.json';

function versionString(version) {
  return version.join('.');
}

async function fetchManifest(channel = 'stable') {
  const url = `${UPDATES}distributions/app/manifests/latest?channel=${encodeURIComponent(channel)}&platform=linux&arch=x64`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Discord-Updater/1' } });
  if (!response.ok)
    throw new Error(`The Discord manifest could not be fetched (HTTP ${response.status})`);
  return response.json();
}

async function download(pkg, onProgress) {
  const response = await fetch(pkg.url, { headers: { 'User-Agent': 'Discord-Updater/1' } });
  if (!response.ok || !response.body)
    throw new Error(`${pkg.url}: HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    received += chunk.length;
    if (onProgress)
      onProgress(received, total);
  }
  const data = Buffer.concat(chunks);
  const sum = crypto.createHash('sha256').update(data).digest('hex');
  if (pkg.package_sha256 && sum !== pkg.package_sha256)
    throw new Error(`${pkg.url}: SHA-256 ${sum} is not the manifest's ${pkg.package_sha256}`);
  return data;
}

// The files of a package, from its tar: [{ name, mode, data }].
function unpack(data) {
  const tar = zlib.brotliDecompressSync(data);
  const entries = [];
  const text = (bytes) => bytes.toString('utf8').replace(/\0.*$/s, '');
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0))
      break;
    const size = parseInt(text(header.subarray(124, 136)).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = text(header.subarray(345, 500));
    let name = longName || (prefix ? `${prefix}/${text(header.subarray(0, 100))}` : text(header.subarray(0, 100)));
    longName = null;
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = text(body);
      continue;
    }
    if (type !== '0' && type !== '\0')
      continue;
    const mode = parseInt(text(header.subarray(100, 108)).trim() || '644', 8);
    entries.push({ name, mode, data: body });
  }
  return entries;
}

// Writes files/<path> of a package under directory; keep(path) chooses.
function install(entries, directory, keep = () => true) {
  let count = 0;
  for (const entry of entries) {
    if (!entry.name.startsWith('files/'))
      continue;
    const relative = entry.name.slice('files/'.length);
    if (!relative || relative.includes('..') || !keep(relative))
      continue;
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data, { mode: entry.mode & 0o777 });
    count++;
  }
  return count;
}

function readState(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, STATE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

function writeState(root, state) {
  fs.writeFileSync(path.join(root, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

function hostDirectory(root, version) {
  return path.join(root, `app-${versionString(version)}`);
}

// The Haiku launcher for a host: a copy of aurora-host with Discord's name
// and icon, and the aurora.json that runs the bootstrap app in resources/.
function writeLauncher(root, version, port) {
  const directory = hostDirectory(root, version);
  const launcher = path.join(directory, 'Discord');
  const host = process.env.AURORA_HOST_BINARY || '/boot/system/data/aurora/aurora-host';
  fs.copyFileSync(host, launcher);
  fs.chmodSync(launcher, 0o755);
  const { execFileSync } = require('child_process');
  const resources = path.join(port, 'files', 'Discord.rsrc');
  if (fs.existsSync(resources)) {
    execFileSync('xres', ['-o', launcher, resources]);
    execFileSync('mimeset', ['-f', launcher]);
  }
  // Discord's bootstrap loads <exe dir>/updater.node, and takes an older
  // update path when there is none. Aurora loads shims/updater.js for it
  // (AURORA_NATIVE_SHIMS), so the file only has to exist.
  fs.writeFileSync(path.join(directory, 'updater.node'), 'Aurora: Discord\'s updater is shims/updater.js in the port.\n');
  const config = {
    app: 'resources/app.asar',
    env: {
      // Discord's updater finds its install from the executable, and its
      // Linux code paths are the nearest to Haiku's.
      AURORA_EXEC_PATH: launcher,
      AURORA_PLATFORM: 'linux',
      AURORA_NATIVE_SHIMS: path.join(port, 'shims'),
      DISCORD_AURORA_PORT: port,
    },
  };
  // A development runtime instead of the installed aurora package's.
  if (process.env.AURORA_RUNTIME_MAIN)
    config.runtime = process.env.AURORA_RUNTIME_MAIN;
  fs.writeFileSync(path.join(directory, 'aurora.json'), `${JSON.stringify(config, null, 2)}\n`);
  return launcher;
}

async function installHost(root, manifest, port, log = () => {}) {
  const version = manifest.full.host_version;
  const directory = hostDirectory(root, version);
  log(`Downloading Discord ${versionString(version)}...`);
  const data = await download(manifest.full, (received, total) => log(null, received, total));
  const entries = unpack(data);
  // resources/ is the app; the rest is Linux's Electron.
  const count = install(entries, directory, (file) => file.startsWith('resources/') || file === 'discord.png');
  log(`Installed ${count} files of the host in ${directory}`);
  writeLauncher(root, version, port);
  return version;
}

async function installModule(root, hostVersion, name, moduleInfo, log = () => {}) {
  const version = moduleInfo.full.module_version;
  const directory = path.join(hostDirectory(root, hostVersion), 'modules', `${name}-${version}`, name);
  log(`Downloading ${name} ${version}...`);
  const data = await download(moduleInfo.full, (received, total) => log(null, received, total));
  const count = install(unpack(data), directory);
  log(`Installed ${count} files of ${name}`);
  return version;
}

// A complete install, or an update to the latest host and modules.
async function installLatest(root, port, { channel = 'stable', log = () => {}, modules } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const manifest = await fetchManifest(channel);
  const previous = readState(root);
  const host = manifest.full.host_version;
  // What the updater calls the last successful update: the manifest's
  // metadata (the client reads its build number from it).
  const state = { channel, host_version: host, modules: {}, updated: new Date().toISOString(),
    manifest: { host_version: host, metadata_version: manifest.metadata_version ?? null,
      required_modules: manifest.required_modules || INITIAL_MODULES, required_update: !!manifest.required_update } };
  const sameHost = previous && versionString(previous.host_version) === versionString(host);
  if (!sameHost || !fs.existsSync(path.join(hostDirectory(root, host), 'resources', 'app.asar')))
    await installHost(root, manifest, port, log);
  else
    writeLauncher(root, host, port);
  const wanted = new Set(modules || manifest.required_modules || INITIAL_MODULES);
  if (previous && sameHost)
    for (const name of Object.keys(previous.modules || {}))
      wanted.add(name);
  for (const name of wanted) {
    const info = manifest.modules[name];
    if (!info)
      continue;
    const version = info.full.module_version;
    const installed = previous && sameHost && previous.modules && previous.modules[name] === version
      && fs.existsSync(path.join(hostDirectory(root, host), 'modules', `${name}-${version}`, name));
    state.modules[name] = installed ? version : await installModule(root, host, name, info, log);
  }
  writeState(root, state);
  return state;
}

module.exports = {
  INITIAL_MODULES, fetchManifest, download, unpack, install, readState, writeState,
  hostDirectory, writeLauncher, installHost, installModule, installLatest, versionString,
};
