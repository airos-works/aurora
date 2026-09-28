// Tray on the mock host: it clicks the icon, then right-clicks it, and picks
// the first item of the context menu that pops up.
const { app, Tray, Menu, nativeImage } = require('electron');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const seen = [];

app.whenReady().then(() => {
  const tray = new Tray(nativeImage.createFromBuffer(Buffer.from(PNG, 'base64')));
  tray.setToolTip('Aurora tray test');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: () => {
      seen.push('menu');
      const bounds = tray.getBounds();
      console.log(seen.join(',') === 'click,right-click,menu' && bounds.width === 16 ? 'PASS' : `FAIL ${seen} ${JSON.stringify(bounds)}`);
      tray.destroy();
      app.quit();
    } },
    { role: 'quit' },
  ]));
  tray.on('click', (event, bounds, position) => seen.push(position && position.x === 5 ? 'click' : 'click?'));
  tray.on('right-click', () => seen.push('right-click'));
});
