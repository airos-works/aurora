'use strict';

// discord_utils.node for Aurora. The native module watches games, input and
// processes on Windows and Linux; on Haiku none of that is available, so it
// answers with nothing to report. Names it does not know are no-ops, since
// the client calls many of them only where a feature exists.

const os = require('os');

const known = {
  init() {},
  setServiceChannel() {},
  getIdleMilliseconds: () => 0,
  getSystemIdleTimeMs: () => 0,
  getWaylandSystemIdleTimeMs: () => 0,
  getCPUCoreCount: () => os.cpus().length,
  getDiscordMemoryUsage: () => ({}),
  getDiscordMemoryUsageElectronRenderer: () => ({}),
  getDiscordIsElevated: () => false,
  getPidFromWindowHandle: () => 0,
  getWindowHandleFromPid: () => 0,
  setCandidateGamesCallback() {},
  setObservedGamesCallback() {},
  setGameCandidateOverrides() {},
  inputWatchAll() {},
  inputEventRegister() {},
  inputEventUnregister() {},
  inputGetRegisteredEvents: () => [],
  inputSetFocused() {},
  shouldDisplayNotifications: () => true,
};

// Names a caller probes for, which must not look like functions.
const ABSENT = new Set(['then', 'toJSON', '__esModule', 'default', 'constructor', 'prototype']);

module.exports = new Proxy(known, {
  get(target, key) {
    if (typeof key === 'symbol' || key in target)
      return target[key];
    if (ABSENT.has(key))
      return undefined;
    return function auroraNoOp() {
      return undefined;
    };
  },
});
