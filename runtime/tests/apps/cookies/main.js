'use strict';

// session.cookies and clearStorageData against the mock host's cookie jar.
const assert = require('assert');
const { app, session } = require('electron');

app.whenReady().then(async () => {
  const cookies = session.defaultSession.cookies;
  const changes = [];
  cookies.on('changed', (event, cookie, cause, removed) => changes.push(`${removed ? '-' : '+'}${cookie.name}`));

  await cookies.set({ url: 'https://example.com/app/page', name: 'host', value: '1' });
  await cookies.set({ url: 'https://example.com/', name: 'wide', value: '2', domain: 'example.com', path: '/',
    secure: true, httpOnly: true, expirationDate: 4102444800, sameSite: 'lax' });
  await cookies.set({ url: 'https://other.org/', name: 'other', value: '3' });

  const all = await cookies.get({});
  assert.deepStrictEqual(all.map((cookie) => cookie.name).sort(), ['host', 'other', 'wide']);
  const host = all.find((cookie) => cookie.name === 'host');
  assert.strictEqual(host.domain, 'example.com');
  assert.strictEqual(host.hostOnly, true);
  assert.strictEqual(host.path, '/app');
  assert.strictEqual(host.session, true);
  assert.strictEqual(host.sameSite, 'unspecified');
  const wide = all.find((cookie) => cookie.name === 'wide');
  assert.strictEqual(wide.domain, '.example.com');
  assert.strictEqual(wide.hostOnly, false);
  assert.strictEqual(wide.expirationDate, 4102444800);
  assert.strictEqual(wide.sameSite, 'lax');
  assert.strictEqual(wide.httpOnly, true);

  // A subdomain sees the domain cookie but not the host-only one.
  const sub = await cookies.get({ url: 'https://www.example.com/app/x' });
  assert.deepStrictEqual(sub.map((cookie) => cookie.name), ['wide']);
  assert.deepStrictEqual((await cookies.get({ domain: 'example.com' })).map((cookie) => cookie.name).sort(), ['host', 'wide']);
  assert.deepStrictEqual((await cookies.get({ name: 'other' })).map((cookie) => cookie.domain), ['other.org']);
  assert.deepStrictEqual((await cookies.get({ secure: true })).map((cookie) => cookie.name), ['wide']);

  await cookies.remove('https://other.org/', 'other');
  assert.deepStrictEqual((await cookies.get({})).map((cookie) => cookie.name).sort(), ['host', 'wide']);

  // One origin: only its cookies go.
  await session.defaultSession.clearStorageData({ origin: 'https://www.example.com', storages: ['cookies'] });
  assert.deepStrictEqual((await cookies.get({})).map((cookie) => cookie.name), ['host']);
  await session.defaultSession.clearStorageData();
  assert.deepStrictEqual(await cookies.get({}), []);

  // Partitions keep their own cookies.
  const other = session.fromPartition('persist:work');
  await other.cookies.set({ url: 'https://example.com/', name: 'work', value: 'w' });
  assert.deepStrictEqual((await cookies.get({})).length, 0);
  assert.deepStrictEqual((await other.cookies.get({})).map((cookie) => cookie.name), ['work']);

  // The default session's own changes; the other partition's are its own.
  assert.deepStrictEqual(changes, ['+host', '+wide', '+other', '-other', '-wide']);
  console.log('PASS');
  app.quit();
}).catch((error) => {
  console.log(`FAIL ${error.stack}`);
  app.exit(1);
});
