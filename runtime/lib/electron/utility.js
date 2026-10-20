'use strict';

// require('electron') in a utility process: what Electron offers there.

const { MessageChannelMain, MessagePortMain } = require('./message-ports');

const net = {
  fetch: (...args) => fetch(...args),
  isOnline: () => true,
  get online() { return true; },
  request(options) {
    const url = new URL(typeof options === 'string' ? options : options.url || `${options.protocol || 'https:'}//${options.hostname || options.host}${options.path || '/'}`);
    const module = url.protocol === 'http:' ? require('http') : require('https');
    return module.request(url, { method: (options && options.method) || 'GET', headers: (options && options.headers) || {} });
  },
  resolveHost: (host) => require('dns').promises.lookup(host, { all: true }).then((addresses) => ({ endpoints: addresses })),
};

const systemPreferences = {
  getMediaAccessStatus: () => 'granted',
  isDarkMode: () => false,
};

module.exports = { MessageChannelMain, MessagePortMain, net, systemPreferences };
