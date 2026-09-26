'use strict';

const { Emitter } = require('./common');

class IpcMain extends Emitter {
  constructor() {
    super();
    this._handlers = new Map();
  }

  handle(channel, handler) {
    if (this._handlers.has(channel))
      throw new Error(`Attempted to register a second handler for '${channel}'`);
    if (typeof handler !== 'function')
      throw new TypeError(`Expected handler to be a function, but got ${typeof handler}`);
    this._handlers.set(channel, handler);
  }

  handleOnce(channel, handler) {
    this.handle(channel, (event, ...args) => {
      this.removeHandler(channel);
      return handler(event, ...args);
    });
  }

  removeHandler(channel) {
    this._handlers.delete(channel);
  }
}

module.exports = { IpcMain, ipcMain: new IpcMain() };
