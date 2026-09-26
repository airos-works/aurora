'use strict';

// Menu and MenuItem. Menus are drawn by aurora-host as Haiku menus: the menu
// bar of each window, and pop-up menus. Templates are serialized with a
// fresh id per item; clicks come back as menu.click with that id.

const { state, createEvent, Emitter } = require('./common');

let nextItemId = 1;
// Item id -> MenuItem, for every menu currently shown somewhere. Replaced as
// menus are replaced, so rebuilding menus often does not grow it.
const liveItems = new Map();
const itemsByOwner = new Map();

const isMac = false;

// Electron's role defaults on Linux: labels and accelerators.
const ROLE_DEFAULTS = {
  undo: { label: 'Undo', accelerator: 'CommandOrControl+Z' },
  redo: { label: 'Redo', accelerator: 'Shift+CommandOrControl+Z' },
  cut: { label: 'Cut', accelerator: 'CommandOrControl+X' },
  copy: { label: 'Copy', accelerator: 'CommandOrControl+C' },
  paste: { label: 'Paste', accelerator: 'CommandOrControl+V' },
  pasteandmatchstyle: { label: 'Paste and Match Style', accelerator: 'Shift+CommandOrControl+V' },
  delete: { label: 'Delete' },
  selectall: { label: 'Select All', accelerator: 'CommandOrControl+A' },
  reload: { label: 'Reload', accelerator: 'CommandOrControl+R' },
  forcereload: { label: 'Force Reload', accelerator: 'Shift+CommandOrControl+R' },
  toggledevtools: { label: 'Toggle Developer Tools', accelerator: 'Control+Shift+I' },
  resetzoom: { label: 'Actual Size', accelerator: 'CommandOrControl+0' },
  zoomin: { label: 'Zoom In', accelerator: 'CommandOrControl+Plus' },
  zoomout: { label: 'Zoom Out', accelerator: 'CommandOrControl+-' },
  togglefullscreen: { label: 'Toggle Full Screen', accelerator: 'F11' },
  minimize: { label: 'Minimize', accelerator: 'CommandOrControl+M' },
  zoom: { label: 'Zoom' },
  close: { label: 'Close Window', accelerator: 'CommandOrControl+W' },
  quit: { label: 'Quit', accelerator: 'CommandOrControl+Q' },
  about: { label: 'About' },
  hide: { label: 'Hide' },
  hideothers: { label: 'Hide Others' },
  unhide: { label: 'Show All' },
  front: { label: 'Bring All to Front' },
  window: { label: 'Window' },
  help: { label: 'Help' },
  services: { label: 'Services' },
  recentdocuments: { label: 'Open Recent' },
  clearrecentdocuments: { label: 'Clear Menu' },
  togglespellchecker: { label: 'Check Spelling While Typing' },
  showsubstitutions: { label: 'Show Substitutions' },
};

const SUBMENU_ROLES = {
  editmenu: () => ({
    label: 'Edit',
    submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' },
      { role: 'paste' }, { role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }],
  }),
  viewmenu: () => ({
    label: 'View',
    submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
  }),
  windowmenu: () => ({ label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] }),
  filemenu: () => ({ label: 'File', submenu: [{ role: isMac ? 'close' : 'quit' }] }),
  appmenu: () => ({ label: state.appInfo.productName || state.appInfo.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }),
  sharemenu: () => ({ label: 'Share', submenu: [] }),
};

// "CmdOrCtrl+Shift+Z" -> { command, modifiers, key, label }. Only Command
// shortcuts without Alt become Haiku menu shortcuts (see shortcutPolicy);
// the rest are shown next to the label, as the page may use those keys.
function parseAccelerator(accelerator) {
  if (!accelerator || typeof accelerator !== 'string')
    return null;
  const parts = accelerator.split('+').map((part) => part.trim());
  let key = parts.pop();
  if (key === '' && parts.length) {
    parts.pop();
    key = '+';
  }
  let command = false;
  let alt = false;
  const modifiers = [];
  const labels = [];
  for (const part of parts) {
    const name = part.toLowerCase();
    if (['command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl', 'super', 'meta'].includes(name)) {
      command = true;
    } else if (['alt', 'option', 'altgr'].includes(name)) {
      alt = true;
      modifiers.push('option');
    } else if (name === 'shift') {
      modifiers.push('shift');
    }
  }
  if (command)
    labels.push('Alt');
  if (modifiers.includes('shift'))
    labels.push('Shift');
  if (alt)
    labels.push('Opt');
  labels.push(key.length === 1 ? key.toUpperCase() : key);
  return { command, alt, modifiers, key, label: labels.join('+') };
}

function shortcutPolicy() {
  return process.env.AURORA_MENU_SHORTCUTS || 'command';
}

class MenuItem {
  constructor(options = {}) {
    const role = options.role ? String(options.role) : undefined;
    const roleKey = role ? role.toLowerCase() : undefined;
    let template = { ...options };
    if (roleKey && SUBMENU_ROLES[roleKey] && !options.submenu)
      template = { ...SUBMENU_ROLES[roleKey](), ...options };
    const defaults = (roleKey && ROLE_DEFAULTS[roleKey]) || {};
    this.id = template.id !== undefined ? String(template.id) : undefined;
    this.role = role;
    this.type = template.type || (template.submenu ? 'submenu' : 'normal');
    this.label = template.label !== undefined ? String(template.label) : (defaults.label || '');
    this.sublabel = template.sublabel || '';
    this.toolTip = template.toolTip || '';
    this.accelerator = template.accelerator !== undefined ? template.accelerator : defaults.accelerator;
    this.icon = template.icon;
    this.enabled = template.enabled !== false;
    this.visible = template.visible !== false;
    this.checked = !!template.checked;
    this.registerAccelerator = template.registerAccelerator !== false;
    this.acceleratorWorksWhenHidden = template.acceleratorWorksWhenHidden !== false;
    this.click = typeof template.click === 'function' ? template.click : null;
    this.commandId = nextItemId++;
    this.userAccelerator = null;
    this.sharingItem = template.sharingItem;
    this.before = template.before;
    this.after = template.after;
    this.beforeGroupContaining = template.beforeGroupContaining;
    this.afterGroupContaining = template.afterGroupContaining;
    this.menu = null;
    if (template.submenu !== undefined && template.submenu !== null) {
      this.submenu = template.submenu instanceof Menu ? template.submenu : Menu.buildFromTemplate(template.submenu);
      this.type = 'submenu';
    } else {
      this.submenu = null;
    }
  }

  _invoke(window, checked) {
    if (this.type === 'checkbox')
      this.checked = !!checked;
    else if (this.type === 'radio' && this.menu) {
      const index = this.menu.items.indexOf(this);
      let first = index;
      while (first > 0 && this.menu.items[first - 1].type === 'radio')
        first--;
      for (let item = first; item < this.menu.items.length && this.menu.items[item].type === 'radio'; item++)
        this.menu.items[item].checked = item === index;
    }
    const focused = window || require('./browser-window').BrowserWindow.getFocusedWindow();
    const event = { triggeredByAccelerator: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
    if (this.click) {
      this.click(this, focused, event);
      return;
    }
    this._performRole(focused);
  }

  // Roles aurora-host cannot do by itself (it does edit, zoom, reload,
  // full screen, minimize, close and quit).
  _performRole(window) {
    const role = (this.role || '').toLowerCase();
    const contents = window && window.webContents;
    switch (role) {
    case 'toggledevtools':
      if (contents)
        contents.toggleDevTools();
      break;
    case 'about':
      require('./app').app.showAboutPanel();
      break;
    case 'delete':
      if (contents)
        contents.delete();
      break;
    default:
      break;
    }
  }

  _serialize(owner) {
    const itemId = `m${nextItemId++}`;
    liveItems.set(itemId, this);
    const list = itemsByOwner.get(owner) || new Set();
    list.add(itemId);
    itemsByOwner.set(owner, list);
    const result = {
      id: itemId,
      label: this.label,
      type: this.type,
      enabled: this.enabled,
      visible: this.visible,
      checked: this.checked,
    };
    // Roles the host performs itself; others are reported as clicks.
    if (this.role && !this.click)
      result.role = this.role;
    const accelerator = parseAccelerator(this.accelerator);
    if (accelerator) {
      const policy = shortcutPolicy();
      const install = this.registerAccelerator && policy !== 'none' && accelerator.command
        && (policy === 'all' || !accelerator.alt);
      if (install) {
        result.command = true;
        result.key = accelerator.key;
        result.modifiers = accelerator.modifiers;
      }
      result.acceleratorLabel = accelerator.label;
    }
    if (this.submenu)
      result.submenu = this.submenu.items.map((item) => item._serialize(owner));
    return result;
  }
}

class Menu extends Emitter {
  constructor() {
    super();
    this.items = [];
  }

  static buildFromTemplate(template) {
    if (!Array.isArray(template))
      throw new TypeError('Invalid template for Menu: Menu template must be an array');
    const menu = new Menu();
    for (const entry of template) {
      if (!entry || typeof entry !== 'object')
        throw new TypeError('Invalid template for MenuItem: must have at least one of label, role or type');
      menu.append(entry instanceof MenuItem ? entry : new MenuItem(entry));
    }
    return menu;
  }

  static setApplicationMenu(menu) {
    if (menu !== null && !(menu instanceof Menu))
      throw new TypeError('Invalid menu');
    state.applicationMenu = menu;
    Menu._applicationMenuSet = true;
    releaseOwner('app');
    if (state.host)
      state.host.send('menu.setApplicationMenu', { menu: menu ? serializeMenu(menu, 'app') : null });
  }

  static getApplicationMenu() {
    return state.applicationMenu;
  }

  static sendActionToFirstResponder() {}

  append(item) {
    const menuItem = item instanceof MenuItem ? item : new MenuItem(item);
    menuItem.menu = this;
    this.items.push(menuItem);
  }

  insert(position, item) {
    const menuItem = item instanceof MenuItem ? item : new MenuItem(item);
    menuItem.menu = this;
    this.items.splice(position, 0, menuItem);
  }

  getMenuItemById(id) {
    for (const item of this.items) {
      if (item.id === id)
        return item;
      if (item.submenu) {
        const found = item.submenu.getMenuItemById(id);
        if (found)
          return found;
      }
    }
    return null;
  }

  popup(options = {}) {
    const { BrowserWindow } = require('./browser-window');
    // electron-context-menu passes a BrowserWindow here; Electron reads it as {}.
    const settings = options instanceof BrowserWindow ? {} : (options || {});
    const window = settings.window || BrowserWindow.getFocusedWindow();
    const owner = `popup${nextItemId++}`;
    const fields = { menu: this.items.map((item) => item._serialize(owner)), window: window ? window.id : -1 };
    if (typeof settings.x === 'number' && typeof settings.y === 'number' && window) {
      const bounds = window.getContentBounds();
      fields.x = bounds.x + settings.x;
      fields.y = bounds.y + settings.y;
    }
    this.emit('menu-will-show', createEvent());
    popups.set(owner, { menu: this, callback: settings.callback });
    pendingPopups.push(owner);
    state.host.request('menu.popup', fields).catch(() => popupClosed());
  }

  closePopup() {}
}

const popups = new Map();
const pendingPopups = [];

function releaseOwner(owner) {
  const list = itemsByOwner.get(owner);
  if (!list)
    return;
  for (const id of list)
    liveItems.delete(id);
  itemsByOwner.delete(owner);
}

function serializeMenu(menu, ownerId) {
  const owner = typeof ownerId === 'number' ? `window${ownerId}` : ownerId;
  releaseOwner(owner);
  return menu.items.map((item) => item._serialize(owner));
}

// menu.click from the host: a menu bar item or a pop-up item.
function menuClicked(message) {
  const item = liveItems.get(message.item);
  if (!item)
    return;
  const { BrowserWindow } = require('./browser-window');
  const window = message.window !== undefined ? BrowserWindow.fromId(message.window) : BrowserWindow.getFocusedWindow();
  item._invoke(window, message.checked);
}

// menu.closed: a pop-up menu went away. Pop-ups are answered in order.
function popupClosed() {
  const owner = pendingPopups.shift();
  if (!owner)
    return;
  const popup = popups.get(owner);
  popups.delete(owner);
  // Clicks are delivered before the close; keep their items briefly.
  setTimeout(() => releaseOwner(owner), 1000);
  if (popup) {
    popup.menu.emit('menu-will-close', createEvent());
    if (typeof popup.callback === 'function')
      popup.callback();
  }
}

module.exports = { Menu, MenuItem, serializeMenu, menuClicked, popupClosed, parseAccelerator };
