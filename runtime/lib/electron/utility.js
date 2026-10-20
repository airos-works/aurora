'use strict';

// require('electron') in a utility process: what Electron offers there.

const { MessageChannelMain, MessagePortMain } = require('./message-ports');

const net = {
  fetch: (...args) => fetch(...args),
  isOnline: () => true,
  get online() { return true; },
  request: (options, callback) => require('./net-request').request(options, callback),
  resolveHost: (host) => require('dns').promises.lookup(host, { all: true }).then((addresses) => ({ endpoints: addresses })),
};

const systemPreferences = {
  getMediaAccessStatus: () => 'granted',
  isDarkMode: () => false,
};

module.exports = { MessageChannelMain, MessagePortMain, net, systemPreferences };
