'use strict';

// net.request for the main process and utility processes: Electron's
// ClientRequest on Node.js's http and https. As Chromium's network stack
// does, it asks for compressed responses and hands them over decoded, takes
// a 'response' callback, and builds the address from url or its parts.

const zlib = require('zlib');

const DECODERS = {
  gzip: () => zlib.createGunzip(),
  'x-gzip': () => zlib.createGunzip(),
  deflate: () => zlib.createInflate(),
  br: () => zlib.createBrotliDecompress(),
};

function addressOf(options) {
  if (options.url)
    return new URL(options.url);
  const protocol = options.protocol || 'https:';
  const host = options.hostname || options.host || 'localhost';
  const port = options.port ? `:${options.port}` : '';
  return new URL(`${protocol}//${host}${port}${options.path || '/'}`);
}

// The response as Chromium gives it: decoded, without the encoding headers.
function decoded(response) {
  const encoding = String(response.headers['content-encoding'] || '').trim().toLowerCase();
  const decoder = DECODERS[encoding];
  if (!decoder)
    return response;
  const stream = response.pipe(decoder());
  response.on('error', (error) => stream.destroy(error));
  const headers = { ...response.headers };
  delete headers['content-encoding'];
  delete headers['content-length'];
  return Object.assign(stream, {
    statusCode: response.statusCode,
    statusMessage: response.statusMessage,
    headers,
    rawHeaders: response.rawHeaders,
    httpVersion: response.httpVersion,
    socket: response.socket,
  });
}

function request(options, callback) {
  const settings = typeof options === 'string' ? { url: options } : { ...(options || {}) };
  const url = addressOf(settings);
  const module = url.protocol === 'http:' ? require('http') : require('https');
  const headers = { ...(settings.headers || {}) };
  if (!Object.keys(headers).some((name) => name.toLowerCase() === 'accept-encoding'))
    headers['accept-encoding'] = 'gzip, deflate, br';
  const requestOptions = { method: settings.method || 'GET', headers };
  for (const key of ['auth', 'agent', 'rejectUnauthorized', 'timeout'])
    if (settings[key] !== undefined)
      requestOptions[key] = settings[key];
  if (settings.username && !requestOptions.auth)
    requestOptions.auth = `${settings.username}:${settings.password || ''}`;
  const clientRequest = module.request(url, requestOptions);
  const emit = clientRequest.emit;
  clientRequest.emit = function emitDecoded(event, ...args) {
    if (event === 'response' && args[0])
      args[0] = decoded(args[0]);
    return emit.call(this, event, ...args);
  };
  if (typeof callback === 'function')
    clientRequest.once('response', callback);
  clientRequest.chunkedEncoding = false;
  clientRequest.followRedirect = () => {};
  return clientRequest;
}

module.exports = { request };
