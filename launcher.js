// AKASH TV remote launcher: open the link on your phone (same Wi-Fi) to start / stop the app.
// Run: npm run launcher   (or let start-launcher-on-boot.ps1 start it with Windows)
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PORT = 8765;
const ROOT = __dirname;
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const CONFIG = path.join(ROOT, 'pairings', 'launcher.json');

// Secret key in the link, so others on the Wi-Fi can't control the PC
function loadKey() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')).key; } catch {}
  const key = crypto.randomBytes(9).toString('base64url');
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ key }, null, 2));
  return key;
}
const KEY = loadKey();

let child = null;
const isRunning = () => !!child && child.exitCode === null && !child.killed;

function startApp() {
  if (isRunning()) return 'AKASH TV is already running';
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(ELECTRON, [ROOT], { cwd: ROOT, env, detached: true, stdio: 'ignore' });
  child.on('exit', () => { child = null; });
  child.unref();
  console.log('[LAUNCHER] started app');
  return 'AKASH TV started';
}

function stopApp() {
  if (isRunning()) { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F']); child = null; }
  else execFile('taskkill', ['/FI', 'WINDOWTITLE eq AKASH TV', '/T', '/F']);
  console.log('[LAUNCHER] stopped app');
  return 'AKASH TV stopped';
}

const page = (msg) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AKASH TV</title>
<link rel="icon" href="/icon.png"><link rel="apple-touch-icon" href="/icon.png">
<link rel="manifest" href="/manifest.json?key=${KEY}"><meta name="theme-color" content="#111111">
<body style="margin:0;background:#111;color:#fff;font:18px sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:20px">
<h2 style="margin:0">AKASH TV</h2>
<p style="opacity:.7;margin:0">${msg}</p>
<a href="/start?key=${KEY}" style="background:#e0102e;color:#fff;padding:22px 60px;border-radius:14px;text-decoration:none;font-size:24px">&#9654; Start</a>
<a href="/stop?key=${KEY}" style="background:#333;color:#fff;padding:14px 48px;border-radius:14px;text-decoration:none">&#9632; Stop</a>
</body>`;

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  // App icon for the phone home-screen shortcut (not secret)
  if (u.pathname === '/icon.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
    return fs.createReadStream(path.join(ROOT, 'assets', 'icon.png')).pipe(res);
  }
  if (u.searchParams.get('key') !== KEY) { res.writeHead(403); return res.end('Forbidden'); }
  if (u.pathname === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    return res.end(JSON.stringify({
      name: 'AKASH TV', short_name: 'AKASH TV', start_url: `/?key=${KEY}`, scope: '/',
      display: 'standalone', background_color: '#111111', theme_color: '#111111',
      icons: [{ src: '/icon.png', sizes: '256x256', type: 'image/png', purpose: 'any' }]
    }));
  }
  let msg = isRunning() ? 'Running' : 'Stopped';
  if (u.pathname === '/start') msg = startApp();
  else if (u.pathname === '/stop') msg = stopApp();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page(msg));
}).listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('AKASH TV launcher ready. Open on your phone (same Wi-Fi):');
  for (const ip of ips) console.log(`  http://${ip}:${PORT}/?key=${KEY}`);
});
