// ESM resolve hook for Node.js versions without module.registerHooks
// (before 22.15): `import ... from 'electron'` gets Aurora's electron module.
// Registered by node-setup.js with module.register(), which passes the
// module's URL (the main process's or a utility process's); runs on the
// loader thread.

let electron = new URL('./electron/esm.mjs', import.meta.url).href;
const NAMES = new Set(['electron', 'electron/main', 'electron/common', 'electron/renderer', 'electron/utility']);

export function initialize(data) {
  if (data && data.electron)
    electron = data.electron;
}

export async function resolve(specifier, context, nextResolve) {
  if (NAMES.has(specifier))
    return { url: electron, format: 'module', shortCircuit: true };
  if (specifier === 'original-fs')
    return nextResolve('node:fs', context);
  return nextResolve(specifier, context);
}
