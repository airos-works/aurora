#!/usr/bin/env node
'use strict';

// Sends expressions to a runtime started with AURORA_REPL=<socket>:
//   node tools/aurora-repl.js <socket> '<expression>' ['<expression>' ...]
// Each prints its result. `electron` and `require` are in scope.

const net = require('net');
const [socketPath, ...expressions] = process.argv.slice(2);
const connection = net.connect(socketPath);
let buffer = '';
let pending = expressions.length;
connection.setEncoding('utf8');
connection.on('connect', () => {
  for (const expression of expressions)
    connection.write(`${expression.replace(/\n/g, ' ')}\n`);
});
connection.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const answer = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    console.log(answer.ok ? answer.value : `ERROR ${answer.error}`);
    if (--pending === 0)
      connection.end();
  }
});
connection.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
