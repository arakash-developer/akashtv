// Renders assets/logo.svg to PNG + ICO. Run: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'assets');
const sizes = [16, 24, 32, 48, 64, 128, 256];

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(dir, 'logo.svg'), 'utf8');
  const win = new BrowserWindow({ show: false, width: 300, height: 300, webPreferences: { offscreen: true } });
  await win.loadURL('about:blank');
  const pngs = {};
  for (const s of sizes) {
    const b64 = await win.webContents.executeJavaScript(`new Promise(r => {
      const img = new Image();
      img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = ${s};
        const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, ${s}, ${s});
        r(c.toDataURL('image/png').split(',')[1]); };
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
    })`);
    pngs[s] = Buffer.from(b64, 'base64');
  }
  fs.writeFileSync(path.join(dir, 'icon.png'), pngs[256]);

  // ICO file with embedded PNG images
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((s) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(s >= 256 ? 0 : s, 0); e.writeUInt8(s >= 256 ? 0 : s, 1);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(pngs[s].length, 8); e.writeUInt32LE(offset, 12);
    offset += pngs[s].length;
    return e;
  });
  fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([header, ...entries, ...sizes.map((s) => pngs[s])]));
  console.log('icon.png + icon.ico written to', dir);
  app.quit();
});
