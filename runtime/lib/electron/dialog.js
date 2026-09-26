'use strict';

// dialog: Tracker file panels and alerts, shown by aurora-host. The *Sync
// variants cannot wait on the host from this thread, so they run the host in
// one-shot dialog mode as a separate process.

const { spawnSync } = require('child_process');
const { state } = require('./common');

function splitArguments(windowOrOptions, maybeOptions) {
  const { BrowserWindow } = require('./browser-window');
  if (windowOrOptions instanceof BrowserWindow || windowOrOptions === null)
    return [windowOrOptions, maybeOptions || {}];
  return [null, windowOrOptions || {}];
}

function syncDialog(kind, options) {
  const { locate, engineLibraries } = require('../host');
  const { host, bundle } = locate();
  const env = { ...process.env };
  if (bundle)
    env.LIBRARY_PATH = [engineLibraries(bundle), env.LIBRARY_PATH || '/boot/system/lib'].join(':');
  const result = spawnSync(host, ['--dialog', kind, JSON.stringify(options)], { env, encoding: 'utf8', maxBuffer: 16 << 20 });
  const line = (result.stdout || '').split('\n').find((text) => text.startsWith('\x1e'));
  if (!line)
    throw new Error(`The ${kind} dialog could not be shown`);
  const answer = JSON.parse(line.slice(1));
  if (answer.error !== undefined)
    throw new Error(answer.error);
  return answer.result;
}

const dialog = {
  showOpenDialog(windowOrOptions, maybeOptions) {
    const [, options] = splitArguments(windowOrOptions, maybeOptions);
    return state.host.request('dialog.open', { options });
  },

  showOpenDialogSync(windowOrOptions, maybeOptions) {
    const [, options] = splitArguments(windowOrOptions, maybeOptions);
    const result = syncDialog('open', options);
    return result.canceled ? undefined : result.filePaths;
  },

  showSaveDialog(windowOrOptions, maybeOptions) {
    const [, options] = splitArguments(windowOrOptions, maybeOptions);
    return state.host.request('dialog.save', { options });
  },

  showSaveDialogSync(windowOrOptions, maybeOptions) {
    const [, options] = splitArguments(windowOrOptions, maybeOptions);
    const result = syncDialog('save', options);
    return result.canceled ? '' : result.filePath;
  },

  showMessageBox(windowOrOptions, maybeOptions) {
    const [, options] = splitArguments(windowOrOptions, maybeOptions);
    return state.host.request('dialog.message', { options: normalizeMessageBox(options) });
  },

  showMessageBoxSync(windowOrOptions, maybeOptions) {
    const [, options] = splitArguments(windowOrOptions, maybeOptions);
    return syncDialog('message', normalizeMessageBox(options)).response;
  },

  showErrorBox(title, content) {
    if (state.host && state.ready)
      state.host.send('dialog.error', { title: String(title), content: String(content) });
    else
      process.stderr.write(`${title}\n${content}\n`);
  },

  showCertificateTrustDialog() {
    return Promise.resolve();
  },
};

function normalizeMessageBox(options) {
  const result = { ...options };
  result.message = String(options.message || '');
  result.buttons = Array.isArray(options.buttons) && options.buttons.length ? options.buttons.map(String) : ['OK'];
  if (typeof options.defaultId !== 'number')
    result.defaultId = 0;
  if (typeof options.cancelId !== 'number') {
    const index = result.buttons.findIndex((label) => /^(cancel|no)$/i.test(label));
    result.cancelId = index >= 0 ? index : (result.buttons.length === 1 ? 0 : -1);
  }
  delete result.signal;
  delete result.icon;
  return result;
}

module.exports = { dialog };
