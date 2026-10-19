// The modules a page with nodeIntegration gets in its own world, so that
// classes (Buffer, streams, EventEmitter) are the page's and `instanceof`
// works. Modules that reach the system (fs, child_process, net, os...) come
// from the main process instead (runtime/lib/electron/remote.js).
const stream = require('readable-stream');

module.exports = {
  assert: require('assert/'),
  buffer: require('buffer/'),
  events: require('events/'),
  path: require('path-browserify'),
  // path-browserify has no win32; Node.js 0.12's path module does.
  pathWin32: require('path/path.js').win32,
  punycode: require('punycode/'),
  querystring: require('querystring-es3'),
  stream,
  string_decoder: require('string_decoder/'),
  url: require('url/'),
  util: require('util/'),
};
