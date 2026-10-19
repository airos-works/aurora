'use strict';

// shell: Haiku's `open` hands URLs and files to their preferred applications.
// The commands are named by path: an app the roster starts may have no PATH.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { state } = require('./common');

function open(target) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/open', [target], { stdio: 'ignore', detached: true });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`open exited with status ${code}`))));
    child.unref();
  });
}

function trashDirectory() {
  try {
    return execFileSync('/bin/finddir', ['B_TRASH_DIRECTORY'], { encoding: 'utf8' }).trim();
  } catch {
    return path.join(process.env.HOME || '/boot/home', 'Desktop', 'Trash');
  }
}

const shell = {
  openExternal(url) {
    return open(String(url));
  },

  openPath(file) {
    return open(String(file)).then(() => '', (error) => error.message);
  },

  showItemInFolder(file) {
    open(path.dirname(String(file))).catch(() => {});
  },

  trashItem(file) {
    return new Promise((resolve, reject) => {
      const trash = trashDirectory();
      let target = path.join(trash, path.basename(file));
      for (let index = 1; fs.existsSync(target); index++)
        target = path.join(trash, `${path.basename(file)} ${index}`);
      fs.rename(file, target, (error) => (error ? reject(error) : resolve()));
    });
  },

  moveItemToTrash(file) {
    try {
      const trash = trashDirectory();
      fs.renameSync(file, path.join(trash, path.basename(file)));
      return true;
    } catch {
      return false;
    }
  },

  beep() {
    if (state.host)
      state.host.send('app.beep');
  },

  writeShortcutLink() {
    return false;
  },

  readShortcutLink() {
    throw new Error('Shortcut links are a Windows feature');
  },
};

module.exports = { shell };
