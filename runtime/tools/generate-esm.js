#!/usr/bin/env node
'use strict';

// Regenerates lib/electron/esm.mjs, the ESM face of the electron module, from
// the keys index.js exports. Run it after adding a module to index.js.

const fs = require('fs');
const path = require('path');

const directory = path.join(__dirname, '..', 'lib', 'electron');
const keys = Object.keys(require(path.join(directory, 'index.js')).electron);
const lines = [
  "// import ... from 'electron' in the main process. Generated from index.js by",
  '// tools/generate-esm.js; keep the export list in step with it.',
  '',
  "import { createRequire } from 'module';",
  '',
  "const electron = createRequire(import.meta.url)('./electron.js');",
  '',
  'export default electron;',
  ...keys.map((key) => `export const ${key} = electron.${key};`),
];
fs.writeFileSync(path.join(directory, 'esm.mjs'), `${lines.join('\n')}\n`);
console.log(`${keys.length} exports`);
