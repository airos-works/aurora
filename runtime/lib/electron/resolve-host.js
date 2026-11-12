'use strict';

// net.resolveHost(host, options) as Electron has it (main and utility
// processes): { endpoints: [{ address, family: 'ipv4' | 'ipv6' }] }, from the
// system's resolver. options.queryType 'A' or 'AAAA' asks for one family.
async function resolveHost(host, options = {}) {
  const lookup = { all: true, verbatim: true };
  if (options && options.queryType === 'A')
    lookup.family = 4;
  else if (options && options.queryType === 'AAAA')
    lookup.family = 6;
  const addresses = await require('dns').promises.lookup(String(host), lookup);
  return {
    endpoints: addresses.map(({ address, family }) => ({
      address,
      family: family === 4 ? 'ipv4' : family === 6 ? 'ipv6' : 'unspec',
    })),
  };
}

module.exports = { resolveHost };
