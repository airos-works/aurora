// ESM resolve hook for Node.js versions without module.registerHooks
// (before 22.15): `import ... from 'electron'` gets Aurora's electron module.
// Registered by main.js with module.register(); runs on the loader thread.

const ELECTRON = new URL('./electron/esm.mjs', import.meta.url).href;
const NAMES = new Set(['electron', 'electron/main', 'electron/common', 'electron/renderer', 'electron/utility']);

export async function resolve(specifier, context, nextResolve) {
  if (NAMES.has(specifier))
    return { url: ELECTRON, format: 'module', shortCircuit: true };
  if (specifier === 'original-fs')
    return nextResolve('node:fs', context);
  return nextResolve(specifier, context);
}
