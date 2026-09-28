#!/usr/bin/env node
'use strict';

// Installs (or updates) Discord for Aurora from Discord's own servers:
//   install-discord [root]         (default ~/config/settings/discord)
// Discord's client is not ours to ship; this downloads it on your machine, as
// Discord's Linux installer does, and makes a Haiku launcher for it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const distro = require('./lib/distro');

const root = path.resolve(process.argv[2] || path.join(os.homedir(), 'config', 'settings', 'discord'));
let lastPercent = -1;
function log(message, received, total) {
  if (message) {
    if (lastPercent >= 0)
      process.stdout.write('\n');
    lastPercent = -1;
    console.log(message);
    return;
  }
  const percent = total ? Math.floor((received * 100) / total) : -1;
  if (percent !== lastPercent && percent >= 0) {
    lastPercent = percent;
    process.stdout.write(`\r  ${percent}%`);
  }
}

distro.installLatest(root, __dirname, { log }).then((state) => {
  const launcher = path.join(distro.hostDirectory(root, state.host_version), 'Discord');
  const menu = path.join(os.homedir(), 'config', 'settings', 'deskbar', 'menu', 'Applications');
  fs.mkdirSync(menu, { recursive: true });
  const link = path.join(menu, 'Discord');
  try {
    fs.unlinkSync(link);
  } catch {}
  fs.symlinkSync(launcher, link);
  console.log(`Discord ${distro.versionString(state.host_version)} is installed in ${root}`);
  console.log(`Start it from Deskbar (Applications > Discord) or run: "${launcher}"`);
}, (error) => {
  console.error(`install-discord: ${error.message}`);
  process.exit(1);
});
