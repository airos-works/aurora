// A utility process for tests/runtime.test.js: echoes on the ports it gets.
import { MessageChannelMain } from 'electron';

process.parentPort.on('message', (event) => {
  if (event.data === 'make-channel') {
    // A port made here goes to the main process.
    const { port1, port2 } = new MessageChannelMain();
    port2.on('message', (inner) => port2.postMessage(`child-made:${inner.data}`));
    port2.start();
    process.parentPort.postMessage({ type: 'made', platform: process.platform, type2: process.type });
    // Sent back through a port the main process gave earlier.
    globalThis.reply.postMessage('here is a port', [port1]);
    return;
  }
  const [port] = event.ports;
  globalThis.reply = port;
  port.on('message', (inner) => {
    const data = inner.data;
    port.postMessage(data instanceof Uint8Array ? { bytes: [...data] } : `echo:${data}`);
  });
  port.on('close', () => process.parentPort.postMessage('port closed'));
  port.start();
  process.parentPort.postMessage({ type: 'ready', argv: process.argv.slice(2), hasSend: typeof process.send });
});
