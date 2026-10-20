'use strict';

// MessageChannelMain and MessagePortMain, with ports that travel: to pages
// (webContents.postMessage), to utility processes (child.postMessage) and
// back (ipcRenderer.postMessage, process.parentPort, a port's own messages).
//
// Electron entangles two ports wherever they end up. Here each process keeps
// an object for every port it has seen: the port itself, or a stand-in whose
// home is the link it went away through. Posting to a stand-in sends the
// message along that link, and the process at the other end does the same,
// so the main process relays between pages and children. The same module
// runs in utility processes (utility.js); pages have their own end
// (renderer/bridge.js). Packets on a link:
//
//   {op: 'deliver', id, data, ports}  the port id receives a message
//   {op: 'closed', id}                the port id's peer closed
//
// `ports` describes the ports a message carries: {id, peer}. The receiver
// makes objects for those it has not seen; a new peer's home is the sender.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const ports = new Map();   // id -> MessagePortMain
const idPrefix = `${crypto.randomBytes(3).toString('hex')}.`;
let nextId = 1;

class MessagePortMain extends EventEmitter {
  constructor(id) {
    super();
    this._id = id || `${idPrefix}${nextId++}`;
    this._other = null;
    this._home = null;       // null: here; else the link it went away through
    this._started = false;
    this._closed = false;
    this._queue = [];
    ports.set(this._id, this);
  }

  postMessage(message, transfer = []) {
    if (this._closed || this._home || !this._other)
      return;
    for (const port of transfer || []) {
      if (!(port instanceof MessagePortMain))
        throw new TypeError('Only MessagePortMain objects can be transferred');
      if (port === this || port === this._other)
        throw new Error('A port cannot transfer itself or its peer');
    }
    this._other._deliver(message, transfer || []);
  }

  start() {
    if (this._started || this._home)
      return;
    this._started = true;
    for (const event of this._queue.splice(0))
      setImmediate(() => this._emitMessage(event));
  }

  close() {
    if (!this._closed && !this._home)
      this._closeHere(true);
  }

  _emitMessage(event) {
    if (!this._closed && !this._home)
      this.emit('message', event);
  }

  // A message for this port.
  _deliver(data, transferred) {
    if (this._closed)
      return;
    if (this._home) {
      const link = this._home;
      link.send({ op: 'deliver', id: this._id, data, ports: transferred.map((port) => port._sendTo(link)) });
      return;
    }
    for (const port of transferred)
      port._arrive();
    const event = { data, ports: transferred };
    if (this._started)
      setImmediate(() => this._emitMessage(event));
    else
      this._queue.push(event);
  }

  // The port goes away through `link`; returns how the other end learns of it.
  _sendTo(link) {
    if (this._home && this._home.disown)
      this._home.disown(this);
    this._home = link;
    this._started = false;
    this._queue.splice(0);
    if (link.adopt)
      link.adopt(this);
    return { id: this._id, peer: this._other ? this._other._id : null };
  }

  // The port is here again.
  _arrive() {
    if (this._home && this._home.disown)
      this._home.disown(this);
    this._home = null;
  }

  // Closes this port; its peer hears of it.
  _closeHere(tellPeer) {
    if (this._closed)
      return;
    this._closed = true;
    ports.delete(this._id);
    if (this._home && this._home.disown)
      this._home.disown(this);
    const other = this._other;
    this._other = null;
    this.emit('close');
    if (!tellPeer || !other || other._closed)
      return;
    other._other = null;
    if (other._home) {
      const link = other._home;
      other._closed = true;
      ports.delete(other._id);
      if (link.disown)
        link.disown(other);
      link.send({ op: 'closed', id: other._id });
    } else {
      other._closeHere(false);
    }
  }
}

class MessageChannelMain {
  constructor() {
    this.port1 = new MessagePortMain();
    this.port2 = new MessagePortMain();
    this.port1._other = this.port2;
    this.port2._other = this.port1;
  }
}

// The ports a packet from `link` carries, as objects here.
function portsFrom(link, descriptors) {
  return (descriptors || []).map(({ id, peer }) => {
    const port = ports.get(id) || new MessagePortMain(id);
    if (!port._home) {
      // New here: until it is delivered, it belongs to the sender.
      port._home = link;
      if (link.adopt)
        link.adopt(port);
    }
    if (!port._other && peer) {
      let other = ports.get(peer);
      if (!other) {
        other = new MessagePortMain(peer);
        other._home = link;
        if (link.adopt)
          link.adopt(other);
      }
      port._other = other;
      other._other = port;
    }
    return port;
  });
}

// A packet that came through `link`.
function receive(link, packet) {
  const port = ports.get(packet.id);
  if (packet.op === 'deliver') {
    const transferred = portsFrom(link, packet.ports);
    if (port)
      port._deliver(packet.data, transferred);
  } else if (packet.op === 'closed' && port) {
    if (port._home) {
      // Its peer was here; the port itself is further on.
      const next = port._home;
      port._closed = true;
      ports.delete(port._id);
      if (next.disown)
        next.disown(port);
      next.send({ op: 'closed', id: port._id });
      return;
    }
    const other = port._other;
    if (other) {
      other._closed = true;
      ports.delete(other._id);
      if (other._home && other._home.disown)
        other._home.disown(other);
    }
    port._other = null;
    port._closeHere(false);
  }
}

// A link to another process: `send` carries packets there. When that
// process goes away, the ports that went there close.
function createLink(name, send) {
  const held = new Set();
  return {
    name,
    send,
    adopt: (port) => held.add(port),
    disown: (port) => held.delete(port),
    gone() {
      for (const port of [...held]) {
        held.delete(port);
        if (port._home === this) {
          port._home = null;
          port._closeHere(true);
        }
      }
    },
  };
}

module.exports = { MessageChannelMain, MessagePortMain, portsFrom, receive, createLink, ports };
