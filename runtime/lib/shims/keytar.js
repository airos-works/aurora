'use strict';

// keytar's native module (keytar.node) on Haiku: passwords in Haiku's key
// store, through the host (host/Keychain.cpp), which keystore_server knows as
// the app; the user is asked once to let the app in. keytar's JavaScript
// checks its arguments and calls these, which answer with promises.

const { state } = require('../electron/common');

function call(command, fields) {
  if (!state.host)
    return Promise.reject(new Error('The key store is not available before the app is ready'));
  return state.host.request(command, fields);
}

module.exports = {
  getPassword: (service, account) => call('keystore.get', { service, account }),
  setPassword: (service, account, password) => call('keystore.set', { service, account, password }).then(() => undefined),
  deletePassword: (service, account) => call('keystore.delete', { service, account }),
  findPassword: (service) => call('keystore.find', { service }).then((found) => (found.length ? found[0].password : null)),
  findCredentials: (service) => call('keystore.find', { service }),
};
