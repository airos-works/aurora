'use strict';

// updater.node for Aurora: the interface of Discord's native updater
// (JSON requests [id, request], answers [id, response] through
// response_handler), backed by what ../install-discord.js installed.
// It reports the installed host and modules, installs the modules the client
// asks for later, and does not update in the client: run the installer again.

const path = require('path');
const distro = require(path.join(process.env.DISCORD_AURORA_PORT || path.join(__dirname, '..'), 'lib', 'distro.js'));

function kindOf(request) {
  return typeof request === 'string' ? request : Object.keys(request || {})[0];
}

class Updater {
  constructor(options) {
    this.respond = options.response_handler;
    this.root = options.root_path;
    this.channel = options.release_channel || 'stable';
  }

  versions() {
    const state = distro.readState(this.root) || {};
    return {
      current_host: state.host_version || null,
      current_modules: state.modules || {},
      last_successful_update: state.manifest || { host_version: state.host_version || null, metadata_version: null },
    };
  }

  command(text) {
    const [id, request] = JSON.parse(text);
    this.handle(request).then(
      (response) => setImmediate(() => this.respond(JSON.stringify([id, response]))),
      (error) => setImmediate(() => this.respond(JSON.stringify([id, {
        Error: { kind: 'Other', details: String((error && error.message) || error), severity: 'NonFatal' },
      }]))));
  }

  command_blocking(text) {
    const [, request] = JSON.parse(text);
    return JSON.stringify(kindOf(request) === 'QueryCurrentVersions' ? { VersionInfo: this.versions() } : 'Ok');
  }

  async handle(request) {
    switch (kindOf(request)) {
    case 'QueryCurrentVersions':
      return { VersionInfo: this.versions() };
    case 'InstallModule': {
      const name = request.InstallModule.name;
      const state = distro.readState(this.root);
      if (!state)
        throw new Error('Discord is not installed');
      if (state.modules[name] !== undefined)
        return 'Ok';
      const manifest = await distro.fetchManifest(this.channel);
      const info = manifest.modules[name];
      if (!info)
        throw new Error(`Discord has no module ${name}`);
      state.modules[name] = await distro.installModule(this.root, state.host_version, name, info);
      distro.writeState(this.root, state);
      return 'Ok';
    }
    default:
      // UpdateToLatest, SetManifests, CollectGarbage, Repair.
      return 'Ok';
    }
  }

  destroy() {}
}

module.exports = { Updater };
