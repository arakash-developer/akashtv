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

// PC power actions (small delay so the phone gets the reply first)
const POWER = {
  sleep:    { msg: 'PC is going to sleep',  run: () => execFile('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']) },
  restart:  { msg: 'PC is restarting',      run: () => execFile('shutdown', ['/r', '/t', '0']) },
  shutdown: { msg: 'PC is shutting down',   run: () => execFile('shutdown', ['/s', '/t', '0']) }
};

const ICONS = {
  home:  '<path d="M3 11l9-8 9 8v10h-6v-6H9v6H3z"/>',
  play:  '<path d="M7 4l14 8-14 8z"/>',
  stop:  '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  power: '<path d="M12 2v10M6.3 5.7a8 8 0 1 0 11.4 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  sleep: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  restart: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
};
const svg = (n, size = 26) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor">${ICONS[n]}</svg>`;

const page = (msg) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>AKASH TV</title>
<link rel="icon" href="/icon.png"><link rel="apple-touch-icon" href="/icon.png">
<link rel="manifest" href="/manifest.json?key=${KEY}"><meta name="theme-color" content="#111111">
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;background:#111;color:#fff;font:18px system-ui,sans-serif;min-height:100vh}
  main{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;min-height:100vh;padding:16px 16px 110px}
  main img{width:96px;height:96px}
  h2{margin:0} #msg{opacity:.7;margin:0;text-align:center}
  .big{display:flex;align-items:center;gap:10px;background:#e0102e;color:#fff;border:0;padding:20px 56px;border-radius:16px;font-size:24px}
  nav{position:fixed;left:0;right:0;bottom:0;display:flex;background:#1c1c1c;border-top:1px solid #2a2a2a;padding:8px 8px calc(8px + env(safe-area-inset-bottom))}
  nav button{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;background:none;border:0;color:#bbb;font-size:12px;padding:6px 0}
  nav button:active{color:#fff} nav .power{color:#ff5a6e}
  #sheet{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:flex-end}
  #sheet.open{display:flex}
  #sheet .box{width:100%;background:#1c1c1c;border-radius:20px 20px 0 0;padding:20px 16px calc(20px + env(safe-area-inset-bottom));display:flex;justify-content:space-around}
  #sheet button{display:flex;flex-direction:column;align-items:center;gap:8px;background:none;border:0;color:#fff;font-size:14px;width:30%}
  #sheet button span{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#2a2a2a}
  #confirm{position:fixed;inset:0;background:rgba(0,0,0,.7);display:none;align-items:center;justify-content:center;padding:16px}
  #confirm.open{display:flex}
  #confirm .card{background:#1f1f1f;border-radius:20px;padding:24px 20px 18px;width:100%;max-width:340px;text-align:center}
  #confirm .ic{width:64px;height:64px;border-radius:50%;background:#e0102e;display:flex;align-items:center;justify-content:center;margin:0 auto 14px}
  #confirm h3{margin:0 0 6px;font-size:20px} #confirm p{margin:0 0 20px;opacity:.7;font-size:15px}
  #confirm .row{display:flex;gap:10px} #confirm .row button{flex:1;border:0;border-radius:12px;padding:14px;font-size:16px;color:#fff}
  #confirm .no{background:#333} #confirm .yes{background:#e0102e;font-weight:600}
</style>
<main>
  <img src="/icon.png" alt="">
  <h2>AKASH TV</h2>
  <p id="msg">${msg}</p>
  <button class="big" onclick="act('start')">${svg('play', 22)} Start</button>
</main>
<nav>
  <button onclick="act('status')">${svg('home')}Home</button>
  <button onclick="act('start')">${svg('play')}Start</button>
  <button onclick="act('stop')">${svg('stop')}Stop</button>
  <button class="power" onclick="sheet(true)">${svg('power')}Power</button>
</nav>
<div id="sheet" onclick="if(event.target===this)sheet(false)">
  <div class="box">
    <button data-a="sleep" onclick="power(this)"><span>${svg('sleep', 28)}</span><b>Sleep</b></button>
    <button data-a="restart" onclick="power(this)"><span>${svg('restart', 28)}</span><b>Restart</b></button>
    <button data-a="shutdown" onclick="power(this)"><span>${svg('power', 28)}</span><b>Power off</b></button>
  </div>
</div>
<div id="confirm" onclick="if(event.target===this)closeConfirm()">
  <div class="card">
    <div class="ic" id="c-ic"></div>
    <h3 id="c-title"></h3>
    <p id="c-text"></p>
    <div class="row">
      <button class="no" onclick="closeConfirm()">Cancel</button>
      <button class="yes" id="c-yes"></button>
    </div>
  </div>
</div>
<script>
  const KEY = ${JSON.stringify(KEY)}, msg = document.getElementById('msg');
  async function act(a) {
    msg.textContent = '...';
    try { msg.textContent = (await (await fetch('/' + (a === 'status' ? '' : a) + '?json=1&key=' + KEY)).json()).msg; }
    catch { msg.textContent = 'PC not reachable'; }
  }
  const ASK = {
    sleep:    { t: 'Sleep PC?',     d: 'PC will go to sleep. You will need to wake it manually.', y: 'Sleep' },
    restart:  { t: 'Restart PC?',   d: 'PC will restart now. Unsaved work will be lost.',         y: 'Restart' },
    shutdown: { t: 'Power off PC?', d: 'PC will shut down now. Unsaved work will be lost.',       y: 'Power off' }
  };
  const $ = (id) => document.getElementById(id);
  function sheet(open) { $('sheet').classList.toggle('open', open); }
  function closeConfirm() { $('confirm').classList.remove('open'); }
  function power(b) {
    const a = b.dataset.a, q = ASK[a];
    sheet(false);
    $('c-ic').innerHTML = b.querySelector('span').innerHTML;
    $('c-title').textContent = q.t; $('c-text').textContent = q.d; $('c-yes').textContent = q.y;
    $('c-yes').onclick = () => { closeConfirm(); act(a); };
    $('confirm').classList.add('open');
  }
</script>`;

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
  let msg = isRunning() ? 'AKASH TV is running' : 'AKASH TV is stopped';
  const action = u.pathname.slice(1);
  if (action === 'start') msg = startApp();
  else if (action === 'stop') msg = stopApp();
  else if (POWER[action]) {
    msg = POWER[action].msg;
    console.log('[LAUNCHER] power:', action);
    setTimeout(POWER[action].run, 1500);
  }
  if (u.searchParams.has('json')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ msg, running: isRunning() }));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page(msg));
}).listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('AKASH TV launcher ready. Open on your phone (same Wi-Fi):');
  for (const ip of ips) console.log(`  http://${ip}:${PORT}/?key=${KEY}`);
});
