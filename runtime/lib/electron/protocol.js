'use strict';

// protocol: custom schemes are served by aurora-host through the engine's URL
// scheme handlers, which ask us for every request (scheme.request). The
// aurora-ipc scheme carries ipcRenderer.sendSync.

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { state } = require('./common');

const MIME_TYPES = {
  '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.cjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.wasm': 'application/wasm', '.txt': 'text/plain', '.xml': 'application/xml',
  '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.wav': 'audio/wav',
};

function mimeTypeFor(file) {
  return MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// net.fetch that also reads file:// URLs, as Electron's does.
async function netFetch(input, init) {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('file:')) {
    const file = fileURLToPath(url);
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, { status: 200, headers: { 'content-type': mimeTypeFor(file) } });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  return fetch(input, init);
}

function legacyHandler(kind, handler) {
  return (request) => new Promise((resolve) => {
    const callback = (result) => {
      if (result === undefined || result === null || (typeof result === 'object' && result.error)) {
        resolve(new Response(null, { status: 404 }));
        return;
      }
      if (kind === 'file') {
        const file = typeof result === 'string' ? result : result.path;
        netFetch(require('url').pathToFileURL(file).href).then(resolve);
        return;
      }
      if (kind === 'http') {
        netFetch(result.url, { method: result.method || request.method }).then(resolve, () => resolve(new Response(null, { status: 502 })));
        return;
      }
      const data = Buffer.isBuffer(result) || typeof result === 'string' ? result : result.data;
      const headers = { 'content-type': (result && result.mimeType) || (kind === 'string' ? 'text/plain' : 'application/octet-stream') };
      if (result && result.charset)
        headers['content-type'] += `; charset=${result.charset}`;
      resolve(new Response(data, { status: (result && result.statusCode) || 200, headers: { ...headers, ...((result && result.headers) || {}) } }));
    };
    handler({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), referrer: '' }, callback);
  });
}

const protocol = {
  registerSchemesAsPrivileged(schemes) {
    for (const entry of schemes || [])
      state.privilegedSchemes.set(String(entry.scheme).toLowerCase(), entry.privileges || {});
  },

  handle(scheme, handler) {
    state.protocols.set(String(scheme).toLowerCase(), handler);
  },

  unhandle(scheme) {
    state.protocols.delete(String(scheme).toLowerCase());
  },

  isProtocolHandled(scheme) {
    return state.protocols.has(String(scheme).toLowerCase());
  },

  registerFileProtocol(scheme, handler) { protocol.handle(scheme, legacyHandler('file', handler)); return true; },
  registerBufferProtocol(scheme, handler) { protocol.handle(scheme, legacyHandler('buffer', handler)); return true; },
  registerStringProtocol(scheme, handler) { protocol.handle(scheme, legacyHandler('string', handler)); return true; },
  registerHttpProtocol(scheme, handler) { protocol.handle(scheme, legacyHandler('http', handler)); return true; },
  registerStreamProtocol(scheme, handler) { protocol.handle(scheme, legacyHandler('buffer', handler)); return true; },
  unregisterProtocol(scheme) { protocol.unhandle(scheme); return true; },
  isProtocolRegistered(scheme) { return protocol.isProtocolHandled(scheme); },
  interceptFileProtocol() { return false; },
  interceptStringProtocol() { return false; },
  interceptBufferProtocol() { return false; },
  interceptHttpProtocol() { return false; },
  interceptStreamProtocol() { return false; },
  uninterceptProtocol() { return false; },
  isProtocolIntercepted() { return false; },
};

function respond(identifier, status, headers, body, mimeType) {
  state.host.send('scheme.respond', {
    identifier,
    status,
    mimeType: mimeType || '',
    headers,
    data: body && body.length ? Buffer.from(body).toString('base64') : '',
  });
}

async function schemeRequest(message) {
  const body = message.body ? Buffer.from(message.body, 'base64') : null;
  if (message.scheme === 'aurora-ipc') {
    const window = state.windows.get(message.id);
    let reply = { v: { $a: 'u' } };
    if (window) {
      try {
        reply = window.webContents._syncMessage(JSON.parse(body ? body.toString('utf8') : '{}'), message);
      } catch (error) {
        process.stderr.write(`[aurora] sendSync failed: ${error.stack || error}\n`);
      }
    }
    respond(message.identifier, 200, [['Access-Control-Allow-Origin', '*'], ['Cache-Control', 'no-store']],
      Buffer.from(JSON.stringify(reply)), 'application/json');
    return;
  }
  const handler = state.protocols.get(message.scheme);
  if (!handler) {
    state.host.send('scheme.fail', { identifier: message.identifier, description: `No handler for ${message.scheme}:` });
    return;
  }
  try {
    const init = { method: message.method || 'GET', headers: message.headers || [] };
    if (body && !['GET', 'HEAD'].includes(init.method))
      init.body = body;
    const response = await handler(new Request(message.url, init));
    if (!response) {
      state.host.send('scheme.fail', { identifier: message.identifier, description: 'The handler returned nothing' });
      return;
    }
    const data = Buffer.from(await response.arrayBuffer());
    const headers = [];
    let mimeType = '';
    response.headers.forEach((value, name) => {
      headers.push([name, value]);
      if (name.toLowerCase() === 'content-type')
        mimeType = value;
    });
    if (!mimeType)
      mimeType = mimeTypeFor(new URL(message.url).pathname);
    respond(message.identifier, response.status || 200, headers, data, mimeType);
  } catch (error) {
    state.host.send('scheme.fail', { identifier: message.identifier, description: String(error && error.message || error) });
  }
}

module.exports = { protocol, schemeRequest, netFetch, mimeTypeFor };
