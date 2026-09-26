'use strict';

// clipboard, screen and nativeTheme: synchronous in Electron, so they answer
// from what aurora-host last reported and update it as the host tells us.

const { state, Emitter } = require('./common');
const { nativeImage } = require('./native-image');

const clipboard = {
  readText() {
    return state.clipboard.text || '';
  },
  writeText(text) {
    state.clipboard = { text: String(text), html: '' };
    state.host.send('clipboard.write', { text: String(text) });
  },
  readHTML() {
    return state.clipboard.html || '';
  },
  writeHTML(html) {
    state.clipboard = { text: state.clipboard.text, html: String(html) };
    state.host.send('clipboard.write', { html: String(html), text: state.clipboard.text });
  },
  readRTF() {
    return '';
  },
  writeRTF(text) {
    clipboard.writeText(text);
  },
  readImage() {
    return nativeImage.createEmpty();
  },
  writeImage() {},
  readBookmark() {
    return { title: '', url: state.clipboard.text || '' };
  },
  writeBookmark(title, url) {
    clipboard.writeText(url);
  },
  readFindText() {
    return '';
  },
  writeFindText() {},
  clear() {
    state.clipboard = { text: '', html: '' };
    state.host.send('clipboard.clear');
  },
  availableFormats() {
    const formats = [];
    if (state.clipboard.text)
      formats.push('text/plain');
    if (state.clipboard.html)
      formats.push('text/html');
    return formats;
  },
  has(format) {
    return clipboard.availableFormats().includes(format);
  },
  read(format) {
    if (format === 'text/html')
      return clipboard.readHTML();
    return clipboard.readText();
  },
  readBuffer(format) {
    return Buffer.from(clipboard.read(format));
  },
  writeBuffer(format, buffer) {
    clipboard.writeText(buffer.toString());
  },
  write(data) {
    const text = data.text !== undefined ? String(data.text) : (data.bookmark || '');
    const html = data.html !== undefined ? String(data.html) : '';
    state.clipboard = { text, html };
    state.host.send('clipboard.write', { text, html });
  },
};

function toDisplay(screen) {
  return {
    id: screen.id,
    label: 'Display',
    bounds: { ...screen.bounds },
    workArea: { ...screen.workArea },
    size: { width: screen.bounds.width, height: screen.bounds.height },
    workAreaSize: { width: screen.workArea.width, height: screen.workArea.height },
    scaleFactor: screen.scaleFactor || 1,
    rotation: screen.rotation || 0,
    internal: !!screen.internal,
    monochrome: false,
    accelerometerSupport: 'unknown',
    touchSupport: 'unknown',
    colorSpace: '{primaries:BT709, transfer:SRGB, matrix:RGB, range:FULL}',
    colorDepth: 24,
    depthPerComponent: 8,
    displayFrequency: 60,
    detected: true,
    maximumCursorSize: { width: 0, height: 0 },
    nativeOrigin: { x: screen.bounds.x, y: screen.bounds.y },
  };
}

const screen = new Emitter();
Object.assign(screen, {
  getPrimaryDisplay() {
    const primary = state.screens[0] || { id: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
    return toDisplay(primary);
  },
  getAllDisplays() {
    return state.screens.length ? state.screens.map(toDisplay) : [screen.getPrimaryDisplay()];
  },
  getDisplayNearestPoint() {
    return screen.getPrimaryDisplay();
  },
  getDisplayMatching() {
    return screen.getPrimaryDisplay();
  },
  getCursorScreenPoint() {
    return { x: 0, y: 0 };
  },
  screenToDipPoint: (point) => ({ ...point }),
  dipToScreenPoint: (point) => ({ ...point }),
  screenToDipRect: (window, rect) => ({ ...rect }),
  dipToScreenRect: (window, rect) => ({ ...rect }),
});

const nativeTheme = new Emitter();
let themeSource = 'system';
Object.defineProperties(nativeTheme, {
  shouldUseDarkColors: {
    get: () => (themeSource === 'system' ? state.darkMode : themeSource === 'dark'),
    enumerable: true,
  },
  themeSource: {
    get: () => themeSource,
    set: (value) => {
      if (!['system', 'light', 'dark'].includes(value))
        throw new TypeError(`Invalid theme source ${value}`);
      themeSource = value;
      nativeTheme.emit('updated');
    },
    enumerable: true,
  },
  shouldUseHighContrastColors: { get: () => false, enumerable: true },
  shouldUseDarkColorsForSystemIntegratedUI: { get: () => state.darkMode, enumerable: true },
  shouldUseInvertedColorScheme: { get: () => false, enumerable: true },
  inForcedColorsMode: { get: () => false, enumerable: true },
  prefersReducedTransparency: { get: () => false, enumerable: true },
});

module.exports = { clipboard, screen, nativeTheme };
