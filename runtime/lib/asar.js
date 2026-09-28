'use strict';

// Electron apps usually ship their code in resources/app.asar. Aurora does
// not patch fs to read inside archives; it unpacks each archive once into the
// cache, into a directory that is itself named app.asar, so that paths the
// app builds from __dirname or process.resourcesPath still work. The
// directory around it links to the archive's neighbours, so paths that climb
// out of the archive (Discord's module finds its images in ../app) do too.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function readHeader(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const prefix = Buffer.alloc(8);
    fs.readSync(descriptor, prefix, 0, 8, 0);
    // Pickle: [payload size][header pickle size], then the header pickle:
    // [payload size][string length][JSON].
    const headerSize = prefix.readUInt32LE(4);
    const header = Buffer.alloc(headerSize);
    fs.readSync(descriptor, header, 0, headerSize, 8);
    const length = header.readInt32LE(4);
    const json = JSON.parse(header.toString('utf8', 8, 8 + length));
    return { json, dataOffset: 8 + headerSize };
  } finally {
    fs.closeSync(descriptor);
  }
}

function extract(archive, destination) {
  const { json, dataOffset } = readHeader(archive);
  const unpacked = `${archive}.unpacked`;
  const descriptor = fs.openSync(archive, 'r');
  try {
    const walk = (node, relative) => {
      const target = path.join(destination, relative);
      if (node.files) {
        fs.mkdirSync(target, { recursive: true });
        for (const [name, child] of Object.entries(node.files))
          walk(child, path.join(relative, name));
        return;
      }
      if (node.link) {
        try {
          fs.symlinkSync(path.relative(path.dirname(target), path.join(destination, node.link)), target);
        } catch {}
        return;
      }
      if (node.unpacked) {
        const source = path.join(unpacked, relative);
        if (fs.existsSync(source))
          fs.copyFileSync(source, target);
      } else {
        const size = Number(node.size) || 0;
        const buffer = Buffer.alloc(size);
        if (size)
          fs.readSync(descriptor, buffer, 0, size, dataOffset + Number(node.offset));
        fs.writeFileSync(target, buffer);
      }
      if (node.executable)
        fs.chmodSync(target, 0o755);
    };
    walk(json, '');
  } finally {
    fs.closeSync(descriptor);
  }
}

// <cache>/<key>/<neighbour> -> the archive's neighbour, for each one.
function linkNeighbours(archive, resources) {
  const directory = path.dirname(path.resolve(archive));
  const own = path.basename(archive);
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === own || name === `${own}.unpacked` || name === '.complete')
      continue;
    const link = path.join(resources, name);
    try {
      fs.lstatSync(link);
      continue;
    } catch {}
    try {
      fs.symlinkSync(path.join(directory, name), link);
    } catch {}
  }
}

// Returns the directory to run instead of the archive.
function unpack(archive, cacheRoot) {
  const stat = fs.statSync(archive);
  const key = crypto.createHash('sha256').update(`${path.resolve(archive)}\0${stat.size}\0${stat.mtimeMs}`).digest('hex').slice(0, 16);
  const resources = path.join(cacheRoot, key);
  const destination = path.join(resources, path.basename(archive));
  const marker = path.join(resources, '.complete');
  if (!fs.existsSync(marker)) {
    fs.rmSync(resources, { recursive: true, force: true });
    fs.mkdirSync(destination, { recursive: true });
    extract(archive, destination);
    const unpacked = `${archive}.unpacked`;
    if (fs.existsSync(unpacked)) {
      try {
        fs.symlinkSync(path.resolve(unpacked), `${destination}.unpacked`);
      } catch {}
    }
    fs.writeFileSync(marker, new Date().toISOString());
  }
  linkNeighbours(archive, resources);
  return destination;
}

module.exports = { unpack, readHeader };
