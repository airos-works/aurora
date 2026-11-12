'use strict';

// What the Node.js of newer Electron releases has that the system's Node.js
// (22) lacks, for apps built against them. Electron 40 and later run Node.js
// 24 (V8 13.6 and later): apps such as Signal Desktop use URLPattern and
// Intl.Locale's information methods in their main process and its workers.
// Each is installed only where Node.js has none of its own, so a newer
// Node.js keeps its own.

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
}

function installCompat() {
  // URLPattern: a global since Node.js 24 (23.8).
  if (typeof globalThis.URLPattern !== 'function')
    defineGlobal('URLPattern', require('./vendor/urlpattern').URLPattern);

  // Intl.Locale: V8 13 made the information getters (calendars, textInfo,
  // weekInfo...) methods (getCalendars(), getTextInfo(), getWeekInfo()...),
  // as the proposal now has them. With only the getters, a method answers
  // what its getter does.
  const locale = typeof Intl === 'object' && Intl.Locale && Intl.Locale.prototype;
  if (locale) {
    for (const name of ['calendars', 'collations', 'hourCycles', 'numberingSystems', 'textInfo', 'timeZones',
      'weekInfo']) {
      const method = `get${name[0].toUpperCase()}${name.slice(1)}`;
      if (typeof locale[method] === 'function')
        continue;
      const descriptor = Object.getOwnPropertyDescriptor(locale, name);
      if (!descriptor || typeof descriptor.get !== 'function')
        continue;
      const getter = descriptor.get;
      Object.defineProperty(locale, method, {
        value: { [method]() { return getter.call(this); } }[method],
        writable: true, configurable: true, enumerable: false,
      });
    }
  }
}

module.exports = { installCompat };
