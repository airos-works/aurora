'use strict';

// require('electron') in a utility process: what Electron offers there.

const { MessageChannelMain, MessagePortMain } = require('./message-ports');

const net = {
  fetch: (...args) => fetch(...args),
  isOnline: () => true,
  get online() { return true; },
  request: (options, callback) => require('./net-request').request(options, callback),
  resolveHost: (host, options) => require('./resolve-host').resolveHost(host, options),
};

const systemPreferences = {
  getMediaAccessStatus: () => 'granted',
  isDarkMode: () => false,
};

module.exports = { MessageChannelMain, MessagePortMain, net, systemPreferences };
