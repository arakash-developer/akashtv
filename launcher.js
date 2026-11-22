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

// ---- PC clipboard history (text only, kept in memory, newest first) ----
const clips = [];
const MAX_CLIPS = 50;
let watcher = null, lastSeen = 0;
// Tracking runs only while someone has the page open (page pings every few seconds)
function touch() {
  lastSeen = Date.now();
  if (!watcher) { console.log('[CLIP] tracking ON'); watchClipboard(); }
}
setInterval(() => {
  if (watcher && Date.now() - lastSeen > 10000) {
    console.log('[CLIP] tracking OFF');
    const w = watcher; watcher = null; w.kill();
  }
}, 2000);
function watchClipboard() {
  const ps = `Add-Type -AssemblyName System.Windows.Forms; $last = '';
while ($true) {
  try { $t = [System.Windows.Forms.Clipboard]::GetText() } catch { $t = '' }
  if ($t -and $t -ne $last) { $last = $t; [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))); [Console]::Out.Flush() }
  Start-Sleep -Milliseconds 1000
}`;
  const p = spawn('powershell', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true });
  watcher = p;
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split(String.fromCharCode(10)).map((x) => x.trim()); buf = lines.pop();
    for (const l of lines) {
      if (!l) continue;
      const text = Buffer.from(l, 'base64').toString('utf8');
      pcText = text;
      // Text we just put there from the phone: don't record it again as a PC copy (no loop)
      if (text === fromPhone) { fromPhone = null; continue; }
      addClip(text, 'pc');
    }
  });
  p.on('exit', () => { if (watcher === p) { watcher = null; } }); // touch() restarts it if still needed
}

let pcText = null;    // what is on the PC clipboard right now (as far as we know)
let fromPhone = null; // last text the phone pushed to the PC

function addClip(text, from) {
  const i = clips.findIndex((c) => c.text === text);
  if (i >= 0) clips.splice(i, 1);
  clips.unshift({ text, from, at: Date.now() });
  clips.length = Math.min(clips.length, MAX_CLIPS);
}

// Phone -> PC clipboard. Text goes through stdin, so any characters are safe.
function setPCClipboard(text) {
  if (text === pcText) return false;            // already there: nothing to do (no loop / duplicate)
  fromPhone = text; pcText = text;
  const p = spawn('powershell', ['-NoProfile', '-STA', '-Command',
    '[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'], { windowsHide: true });
  p.stdin.end(text, 'utf8');
  addClip(text, 'phone');
  console.log('[CLIP] phone -> PC (' + text.length + ' chars)');
  return true;
}

const MAX_SEND = 100000; // chars

// ---- Files: phone <-> PC Downloads folder ----
const DOWNLOADS = path.join(os.homedir(), 'Downloads');

// Only plain file names inside Downloads (blocks "../" tricks)
function safeName(name) {
  const n = path.basename(String(name || '')).replace(/[<>:"/|?*\x00-\x1f]/g, '_').trim();
  return n && n !== '.' && n !== '..' ? n : null;
}
function inDownloads(name) {
  const n = safeName(name);
  if (!n) return null;
  const full = path.resolve(DOWNLOADS, n);
  return path.dirname(full) === path.resolve(DOWNLOADS) ? full : null;
}
// "photo.jpg" -> "photo (1).jpg" if it already exists
function freeName(name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  let n = name, i = 1;
  while (fs.existsSync(path.join(DOWNLOADS, n))) n = `${base} (${i++})${ext}`;
  return n;
}

function listDownloads() {
  try {
    return fs.readdirSync(DOWNLOADS, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.startsWith('.') && !/\.(crdownload|part|tmp)$/i.test(d.name) && d.name !== 'desktop.ini')
      .map((d) => { const st = fs.statSync(path.join(DOWNLOADS, d.name)); return { name: d.name, size: st.size, at: st.mtimeMs }; })
      .sort((a, b) => b.at - a.at)
      .slice(0, 200);
  } catch { return []; }
}

// Phone -> PC: raw file body streamed straight to disk (no buffering = fast)
function receiveUpload(req, res, rawName) {
  const name = safeName(rawName);
  const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (!name) return json(400, { ok: false, msg: 'Bad file name' });
  const finalName = freeName(name);
  const tmp = path.join(DOWNLOADS, finalName + '.akashtv-part');
  const out = fs.createWriteStream(tmp);
  let failed = false;
  const fail = () => { if (failed) return; failed = true; out.destroy(); fs.rm(tmp, { force: true }, () => {}); };
  req.on('aborted', fail);
  out.on('error', () => { fail(); json(500, { ok: false, msg: 'Could not save file' }); });
  out.on('finish', () => {
    if (failed) return;
    fs.rename(tmp, path.join(DOWNLOADS, freeName(finalName)), (e) => {
      if (e) return json(500, { ok: false, msg: 'Could not save file' });
      console.log('[FILE] phone -> PC:', finalName);
      json(200, { ok: true, name: finalName });
    });
  });
  req.pipe(out);
}

// ---- "Send to AKASH TV" (right-click on any PC file) -> shows up on the phone ----
const SHARED_FILE = path.join(ROOT, 'pairings', 'shared.json');
let shared = [];
try { shared = JSON.parse(fs.readFileSync(SHARED_FILE, 'utf8')); } catch {}
const saveShared = () => { try { fs.writeFileSync(SHARED_FILE, JSON.stringify(shared, null, 2)); } catch {} };
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

function addShared(full) {
  let st;
  try { st = fs.statSync(full); } catch { return null; }
  if (!st.isFile()) return null;
  shared = shared.filter((s) => s.path !== full);
  const item = { id: crypto.randomBytes(6).toString('hex'), path: full, name: path.basename(full), size: st.size, at: Date.now() };
  shared.unshift(item);
  shared.length = Math.min(shared.length, 100);
  saveShared();
  console.log('[FILE] shared to phone:', full);
  return item;
}
function sharedList() {
  return shared.filter((s) => fs.existsSync(s.path)).map(({ id, name, size, at }) => ({ id, name, size, at }));
}

// PC -> phone: stream the file as a download
function sendDownload(res, rawName, id) {
  const sh = id && shared.find((s) => s.id === id);
  const full = sh ? sh.path : inDownloads(rawName);
  let st;
  try { st = full && fs.statSync(full); } catch {}
  if (!st || !st.isFile()) { res.writeHead(404); return res.end('File not found'); }
  // Real file type (instead of a generic one) so the phone browser treats it as a normal file
  const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf', '.txt': 'text/plain',
    '.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.apk': 'application/vnd.android.package-archive' };
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(full))}`
  });
  fs.createReadStream(full, { highWaterMark: 1024 * 1024 }).pipe(res);
}

// PC power actions (small delay so the phone gets the reply first)
const POWER = {
  sleep:    { msg: 'PC is going to sleep',  run: () => execFile('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']) },
  restart:  { msg: 'PC is restarting',      run: () => execFile('shutdown', ['/r', '/t', '0']) },
  shutdown: { msg: 'PC is shutting down',   run: () => execFile('shutdown', ['/s', '/t', '0']) }
};

const ICONS = {
  file:  '<path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5zM8 13v2h8v-2zm0 4v2h5v-2z"/>',
  up:    '<path d="M12 3l6 6h-4v6h-4V9H6zM4 19h16v2H4z"/>',
  down:  '<path d="M10 3h4v6h4l-6 6-6-6h4zM4 19h16v2H4z"/>',
  clip:  '<path d="M9 3h6a1 1 0 0 1 1 1v1h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2V4a1 1 0 0 1 1-1zm0 2v2h6V5zm-1 6v2h8v-2zm0 4v2h6v-2z"/>',
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
  .big.stop{background:#333}
  .spin{width:22px;height:22px;border:3px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:r .8s linear infinite}
  @keyframes r{to{transform:rotate(360deg)}}
  body.busy .big,body.busy nav button{opacity:.45;pointer-events:none}
  body.busy .big{opacity:.8}
  #msg{display:flex;align-items:center;gap:8px}
  #msg i{width:10px;height:10px;border-radius:50%;background:#777;display:inline-block}
  #msg.on i{background:#2ecc71} #msg.load i{background:#f5a623}
  #clips{display:none;padding:16px 16px 110px;max-width:640px;margin:0 auto}
  body.clipview main{display:none} body.clipview #clips{display:block}
  #files{display:none;padding:16px 16px 110px;max-width:640px;margin:0 auto}
  body.fileview main{display:none} body.fileview #files{display:block}
  #files header{display:flex;align-items:center;justify-content:space-between;margin:4px 0 14px}
  #files h2{font-size:22px;margin:0} #files header small{opacity:.6;font-size:13px}
  .upload{display:flex;flex-direction:column;align-items:center;gap:6px;border:2px dashed #e0102e;border-radius:16px;padding:22px;background:#1a1012;color:#fff;cursor:pointer}
  .upload input{display:none} .upload small{opacity:.6;font-size:12px}
  .sec{font-size:15px;margin:22px 0 10px;opacity:.9} .sec small{opacity:.55;font-weight:400;font-size:12px}
  .frow{display:flex;align-items:center;gap:10px;background:#1c1c1c;border:1px solid #2a2a2a;border-radius:12px;padding:10px 12px;margin-bottom:8px}
  .frow .fi{flex:1;min-width:0} .frow .fn{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .frow .fs{font-size:12px;opacity:.6;margin-top:2px}
  .frow a.dl{background:#1d4f8a;color:#fff;border-radius:10px;padding:8px 12px;display:flex;text-decoration:none}
  .frow button.x{background:none;border:0;color:#888;font-size:20px;padding:4px 6px}
  .bar{height:6px;background:#333;border-radius:4px;margin-top:6px;overflow:hidden} .bar i{display:block;height:100%;width:0;background:#e0102e;transition:width .2s}
  .frow.done .bar i{background:#1f8f4e} .frow.err .bar i{background:#888}
  .empty-s{opacity:.5;font-size:14px;margin:4px 2px}
  #toast{position:fixed;left:16px;right:16px;bottom:96px;background:#1f8f4e;color:#fff;padding:12px 16px;border-radius:12px;font-size:15px;text-align:center;opacity:0;transform:translateY(10px);transition:.25s;pointer-events:none}
  #toast.show{opacity:1;transform:none}
  #clips header{display:flex;align-items:center;justify-content:space-between;margin:4px 0 14px}
  #clips h2{font-size:22px} #clips header small{opacity:.6;font-size:13px}
  .clip{background:#1c1c1c;border:1px solid #2a2a2a;border-radius:14px;padding:12px 12px 10px;margin-bottom:10px}
  .clip pre{margin:0 0 8px;white-space:pre-wrap;word-break:break-word;font:15px/1.4 system-ui,sans-serif;max-height:7.2em;overflow:hidden}
  .clip .meta{display:flex;align-items:center;justify-content:space-between;font-size:12px;opacity:.85}
  .clip .meta span{opacity:.6}
  .clip button{background:#2a2a2a;color:#fff;border:0;border-radius:10px;padding:8px 14px;font-size:14px}
  .clip button.done{background:#1f8f4e}
  .clip pre a{color:#6fb4ff;text-decoration:underline;word-break:break-all}
  .clip .meta a.open{background:#1d4f8a;color:#fff;text-decoration:none;border-radius:10px;padding:8px 14px;font-size:14px;margin-left:auto;margin-right:8px}
  .tag{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;margin-right:6px;opacity:1!important}
  .tag.pc{background:#26405e;color:#9cc8ff} .tag.phone{background:#4a2a12;color:#ffb36b}
  .sendbox{background:#1c1c1c;border:1px solid #2a2a2a;border-radius:14px;padding:10px;margin-bottom:16px}
  .sendbox textarea{width:100%;background:#111;color:#fff;border:1px solid #333;border-radius:10px;padding:10px;font:15px system-ui,sans-serif;resize:vertical}
  .sendrow{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px}
  .sendrow small{opacity:.6;font-size:12px}
  .sendrow button{background:#e0102e;color:#fff;border:0;border-radius:10px;padding:10px 16px;font-size:15px;font-weight:600;white-space:nowrap}
  .sendrow button:disabled{opacity:.5}
  .empty{opacity:.6;text-align:center;margin-top:30vh}
  nav button.active{color:#fff}
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
  <p id="msg"><i></i><span>${msg}</span></p>
  <button class="big" id="bigbtn" onclick="act(running ? 'stop' : 'start')"></button>
</main>
<section id="files">
  <header><h2>Files</h2><small id="files-upd"></small></header>
  <label class="upload">
    <input type="file" id="file-input" multiple onchange="uploadFiles(this.files)">
    ${svg('up', 30)}<b>Send files to PC</b><small>Saved in the PC Downloads folder</small>
  </label>
  <div id="up-list"></div>
  <h3 class="sec">From PC <small>(right-click &rarr; Send to AKASH TV)</small></h3>
  <div id="shared-list"></div>
  <h3 class="sec">PC Downloads folder</h3>
  <div id="dl-list"><p class="empty-s">Loading...</p></div>
</section>
<section id="clips">
  <header><h2>Clipboard</h2><small id="clip-upd"></small></header>
  <div class="sendbox">
    <textarea id="send-text" rows="3" placeholder="Paste or type text to send to the PC"></textarea>
    <div class="sendrow"><small id="send-msg">Phone copies sync automatically when allowed</small><button id="send-btn" onclick="sendText()">Send to PC</button></div>
  </div>
  <div id="clip-list"><p class="empty">Loading...</p></div>
</section>
<nav>
  <button id="nav-home" onclick="act('status')">${svg('home')}Home</button>
  <button id="nav-clip" onclick="showClips(true)">${svg('clip')}Clipboard</button>
  <button id="nav-files" onclick="showFiles(true)">${svg('file')}Files</button>
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
  const LOADING = { start: 'Starting AKASH TV...', stop: 'Stopping AKASH TV...', status: 'Checking...',
                    sleep: 'Sending sleep...', restart: 'Sending restart...', shutdown: 'Sending power off...' };
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = async (p) => (await fetch(p + (p.includes('?') ? '&' : '?') + 'json=1&key=' + KEY)).json();
  const big = document.getElementById('bigbtn');
  const BIG = { start: ${JSON.stringify(svg('play', 22))} + ' Start', stop: ${JSON.stringify(svg('stop', 22))} + ' Stop' };
  let running = ${JSON.stringify(msg)}.includes('running');

  // One main button: shows Start when stopped, Stop when running
  function renderBig() { big.innerHTML = running ? BIG.stop : BIG.start; big.classList.toggle('stop', running); }
  function setStatus(text, state) {
    msg.className = state || '';
    msg.querySelector('span').textContent = text;
    if (state !== 'load') { running = state === 'on'; renderBig(); }
  }
  function setBusy(on, a) {
    document.body.classList.toggle('busy', on);
    big.innerHTML = on && (a === 'start' || a === 'stop') ? '<div class="spin"></div> ' + (a === 'start' ? 'Starting' : 'Stopping') : big.innerHTML;
    if (!on) renderBig();
  }

  async function act(a) {
    if (document.body.classList.contains('busy')) return;
    if (document.body.classList.contains('clipview')) showClips(false);
    if (document.body.classList.contains('fileview')) showFiles(false);
    setBusy(true, a);
    setStatus(LOADING[a], 'load');
    const t0 = Date.now();
    try {
      let r = await api('/' + (a === 'status' ? '' : a));
      // wait until the app really is up / down (max ~6s)
      if (a === 'start' || a === 'stop') {
        for (let i = 0; i < 12 && r.running !== (a === 'start'); i++) { await sleepMs(500); r = await api('/'); }
        r.msg = r.running ? 'AKASH TV is running' : 'AKASH TV is stopped';
      }
      await sleepMs(Math.max(0, 1200 - (Date.now() - t0))); // keep loader visible briefly
      setStatus(r.msg, r.running ? 'on' : '');
    } catch { setStatus('PC not reachable', ''); }
    setBusy(false);
  }
  setStatus(msg.textContent, ${JSON.stringify(msg)}.includes('running') ? 'on' : '');
  // ---- Clipboard view (#clips) ----
  let clipTimer = null, clipData = [];
  const ago = (t) => { const s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : Math.floor(s / 3600) + ' h ago'; };
  // ---- Files view (#files) ----
  let filesTimer = null;
  const fmtSize = (b) => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
  function showFiles(on) {
    if (on) showClips(false);
    document.body.classList.toggle('fileview', on);
    document.getElementById('nav-files').classList.toggle('active', on);
    if (on && location.hash !== '#files') history.replaceState(null, '', '#files');
    if (!on && location.hash === '#files') history.replaceState(null, '', location.pathname + location.search);
    clearInterval(filesTimer);
    if (on) { loadFiles(); filesTimer = setInterval(loadFiles, 4000); }
  }
  function fileRow(name, sub, href, onRemove) {
    const r = document.createElement('div'); r.className = 'frow';
    r.innerHTML = '<div class="fi"><div class="fn"></div><div class="fs"></div></div>';
    r.querySelector('.fn').textContent = name; r.querySelector('.fs').textContent = sub;
    if (href) {
      const a = document.createElement('a'); a.className = 'dl'; a.href = href; a.setAttribute('download', name);
      a.innerHTML = ${JSON.stringify(svg('down', 20))}; r.appendChild(a);
    }
    if (onRemove) { const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.onclick = onRemove; r.appendChild(x); }
    return r;
  }
  let filesSig = '';
  async function loadFiles() {
    try {
      const r = await api('/files');
      document.getElementById('files-upd').textContent = 'Updated ' + new Date().toLocaleTimeString();
      const sig = JSON.stringify(r);
      if (sig === filesSig) return;
      filesSig = sig;
      const sl = document.getElementById('shared-list'); sl.innerHTML = '';
      if (!r.shared.length) sl.innerHTML = '<p class="empty-s">Nothing yet. On the PC, right-click a file and choose Send to AKASH TV.</p>';
      r.shared.forEach((f) => sl.appendChild(fileRow(f.name, fmtSize(f.size) + ' · ' + ago(f.at),
        '/download?id=' + f.id + '&key=' + KEY,
        async () => { await api('/unshare?id=' + f.id); filesSig = ''; loadFiles(); })));
      const dl = document.getElementById('dl-list'); dl.innerHTML = '';
      if (!r.files.length) dl.innerHTML = '<p class="empty-s">Downloads folder is empty.</p>';
      r.files.forEach((f) => dl.appendChild(fileRow(f.name, fmtSize(f.size) + ' · ' + ago(f.at),
        '/download?name=' + encodeURIComponent(f.name) + '&key=' + KEY)));
    } catch { document.getElementById('files-upd').textContent = 'PC not reachable'; }
  }
  // Phone -> PC: each file is streamed as-is (no form encoding), 3 at a time
  function uploadOne(file) {
    return new Promise((resolve) => {
      const row = fileRow(file.name, fmtSize(file.size) + ' · waiting...');
      row.querySelector('.fi').insertAdjacentHTML('beforeend', '<div class="bar"><i></i></div>');
      document.getElementById('up-list').prepend(row);
      const bar = row.querySelector('.bar i'), sub = row.querySelector('.fs');
      const xhr = new XMLHttpRequest(), t0 = Date.now();
      xhr.open('PUT', '/upload?name=' + encodeURIComponent(file.name) + '&key=' + KEY);
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const sec = Math.max((Date.now() - t0) / 1000, 0.1);
        bar.style.width = (e.loaded / e.total * 100).toFixed(1) + '%';
        sub.textContent = fmtSize(e.loaded) + ' / ' + fmtSize(e.total) + ' · ' + fmtSize(e.loaded / sec) + '/s';
      };
      xhr.onload = () => {
        let r = {}; try { r = JSON.parse(xhr.responseText); } catch {}
        const ok = xhr.status === 200 && r.ok;
        row.classList.add(ok ? 'done' : 'err'); bar.style.width = '100%';
        sub.textContent = ok ? 'Saved to PC Downloads as ' + r.name + ' · ' + fmtSize(file.size / Math.max((Date.now() - t0) / 1000, 0.1)) + '/s' : 'Failed: ' + (r.msg || xhr.status);
        resolve();
      };
      xhr.onerror = () => { row.classList.add('err'); sub.textContent = 'Failed: PC not reachable'; resolve(); };
      xhr.send(file);
    });
  }
  async function uploadFiles(list) {
    const files = [...list], workers = [];
    for (let w = 0; w < 3; w++) workers.push((async () => { while (files.length) await uploadOne(files.shift()); })());
    await Promise.all(workers);
    document.getElementById('file-input').value = '';
    filesSig = ''; loadFiles();
  }

  function showClips(on) {
    if (on && document.body.classList.contains('fileview')) showFiles(false);
    document.body.classList.toggle('clipview', on);
    document.getElementById('nav-clip').classList.toggle('active', on);
    if (on && location.hash !== '#clips') history.replaceState(null, '', '#clips' );
    if (!on && location.hash) history.replaceState(null, '', location.pathname + location.search);
    clearInterval(clipTimer);
    if (on) { loadClips(); clipTimer = setInterval(loadClips, 3000); }
  }
  async function loadClips() {
    try {
      const r = await api('/clips');
      if (JSON.stringify(r.clips) === JSON.stringify(clipData)) return updTimes();
      clipData = r.clips;
      const list = document.getElementById('clip-list');
      if (!clipData.length) { list.innerHTML = '<p class="empty">Nothing copied on the PC yet.<br>Copy some text on the PC and it will show up here.</p>'; return; }
      list.innerHTML = '';
      clipData.forEach((c) => {
        const d = document.createElement('div'); d.className = 'clip';
        d.innerHTML = '<pre></pre><div class="meta"><div><b class="tag"></b><span></span></div><button>Copy</button></div>';
        linkify(d.querySelector('pre'), c.text);
        const only = soleURL(c.text);
        if (only) {
          const o = document.createElement('a'); o.className = 'open'; o.textContent = 'Open';
          o.href = only; o.target = '_blank'; o.rel = 'noopener noreferrer';
          d.querySelector('.meta').insertBefore(o, d.querySelector('.meta button'));
        }
        const tag = d.querySelector('.tag'); tag.textContent = c.from === 'phone' ? 'Phone' : 'PC'; tag.classList.add(c.from || 'pc');
        d.querySelector('span').dataset.t = c.at;
        d.querySelector('button').onclick = (e) => copyText(c.text, e.target);
        list.appendChild(d);
      });
      updTimes();
    } catch { document.getElementById('clip-upd').textContent = 'PC not reachable'; }
  }
  // Turn URLs in text into clickable links (built with DOM nodes, so clip text can't inject HTML)
  const URL_RE = /(https?:\\/\\/[^\\s<>"']+|www\\.[^\\s<>"']+)/gi;
  const cleanURL = (u) => u.replace(/[.,;:!?)\\]}]+$/, '');
  const hrefOf = (u) => (/^https?:\\/\\//i.test(u) ? u : 'https://' + u);
  function linkify(el, text) {
    el.textContent = '';
    let last = 0;
    text.replace(URL_RE, (m, _g, idx) => {
      const url = cleanURL(m);
      el.appendChild(document.createTextNode(text.slice(last, idx)));
      const a = document.createElement('a');
      a.href = hrefOf(url); a.textContent = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      el.appendChild(a);
      last = idx + url.length;
      return m;
    });
    el.appendChild(document.createTextNode(text.slice(last)));
  }
  // The clip is just one link -> show an "Open" button too
  function soleURL(text) {
    const t = text.trim();
    if (/\\s/.test(t)) return null;
    const m = t.match(URL_RE);
    return m && cleanURL(m[0]) === t ? hrefOf(t) : null;
  }

  function updTimes() {
    document.querySelectorAll('.clip .meta span').forEach((s) => (s.textContent = ago(+s.dataset.t)));
    document.getElementById('clip-upd').textContent = 'Updated ' + new Date().toLocaleTimeString();
  }
  // Works on plain http too (navigator.clipboard needs https)
  async function copyText(text, btn) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {}
    if (!ok) {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
    }
    btn.textContent = ok ? 'Copied ✓' : 'Copy failed'; btn.classList.toggle('done', ok);
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1500);
  }
  // ---- Phone -> PC ----
  // Anti-loop: never send back text that is already in the list (came from the PC or was sent already)
  let lastPhoneText = null;
  try { lastPhoneText = localStorage.getItem('akashtv-last-phone'); } catch {}
  const known = (t) => t === lastPhoneText || clipData.some((c) => c.text === t);

  async function pushToPC(text) {
    const r = await (await fetch('/send?key=' + KEY, { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text })).json();
    lastPhoneText = text;
    try { localStorage.setItem('akashtv-last-phone', text); } catch {}
    loadClips();
    return r;
  }

  async function sendText() {
    const ta = document.getElementById('send-text'), btn = document.getElementById('send-btn'), m = document.getElementById('send-msg');
    const text = ta.value;
    if (!text.trim()) { m.textContent = 'Type or paste something first'; return; }
    btn.disabled = true; btn.textContent = 'Sending...';
    try { const r = await pushToPC(text); m.textContent = r.msg; if (r.ok || r.msg.startsWith('Already')) ta.value = ''; }
    catch { m.textContent = 'PC not reachable'; }
    btn.disabled = false; btn.textContent = 'Send to PC';
  }

  // Auto: when the page opens / comes back to front, read the phone clipboard and send it if it is new.
  // Browsers only allow this on https (or with permission), so it silently does nothing otherwise.
  let syncing = false;
  async function autoSync() {
    if (syncing || document.visibilityState !== 'visible' || !navigator.clipboard || !navigator.clipboard.readText) return;
    syncing = true;
    try {
      if (!clipData.length) await loadClips();
      const t = await navigator.clipboard.readText();
      if (t && t.trim() && !known(t)) {
        const r = await pushToPC(t);
        if (r.ok) document.getElementById('send-msg').textContent = 'Phone clipboard sent to PC';
      }
    } catch {}
    syncing = false;
  }
  document.addEventListener('visibilitychange', autoSync);
  window.addEventListener('focus', autoSync);
  autoSync();

  if (location.hash === '#clips') showClips(true);
  if (location.hash === '#files') showFiles(true);

  // ---- Auto-download: files sent from the PC start downloading by themselves while this page is open ----
  let seen = null;
  try { seen = JSON.parse(localStorage.getItem('akashtv-seen') || 'null'); } catch {}
  const saveSeen = () => { try { localStorage.setItem('akashtv-seen', JSON.stringify(seen.slice(-300))); } catch {} };
  function toast(text) {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = text; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3500);
  }
  function startDownload(f) {
    const a = document.createElement('a');
    a.href = '/download?id=' + f.id + '&key=' + KEY; a.setAttribute('download', f.name);
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function checkShared() {
    if (document.visibilityState !== 'visible') return;
    try {
      const { shared: list } = await api('/shared');
      if (seen === null) { seen = list.map((f) => f.id); return saveSeen(); } // first visit: don't download old ones
      const fresh = list.filter((f) => !seen.includes(f.id)).reverse();
      for (const f of fresh) {
        seen.push(f.id);
        toast('Downloading ' + f.name + ' from PC');
        startDownload(f);
        await sleepMs(800); // small gap so the browser accepts several downloads
      }
      if (fresh.length) { saveSeen(); if (document.body.classList.contains('fileview')) { filesSig = ''; loadFiles(); } }
    } catch {}
  }
  checkShared();
  setInterval(checkShared, 2500);
  document.addEventListener('visibilitychange', checkShared);

  // Heartbeat: PC tracks the clipboard only while this page is open and visible
  let hb = null;
  const ping = () => fetch('/ping?key=' + KEY).catch(() => {});
  function heartbeat() {
    clearInterval(hb);
    if (document.visibilityState === 'visible') { ping(); hb = setInterval(ping, 3000); }
  }
  document.addEventListener('visibilitychange', heartbeat);
  heartbeat();

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
  if (u.pathname === '/ping') { touch(); res.writeHead(204); return res.end(); }
  if (u.pathname === '/files') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ files: listDownloads(), shared: sharedList() }));
  }
  if (u.pathname === '/shared') {
    touch();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ shared: sharedList() }));
  }
  if (u.pathname === '/upload' && req.method === 'PUT') return receiveUpload(req, res, u.searchParams.get('name'));
  if (u.pathname === '/download') return sendDownload(res, u.searchParams.get('name'), u.searchParams.get('id'));
  // Right-click "Send to AKASH TV" on the PC (only accepted from this PC itself)
  if (u.pathname === '/share' && req.method === 'POST') {
    if (!isLocal(req)) { res.writeHead(403); return res.end('Forbidden'); }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const items = body.split(String.fromCharCode(10)).map((x) => x.trim()).filter(Boolean).map(addShared).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: items.length > 0, count: items.length }));
    });
    return;
  }
  if (u.pathname === '/unshare') {
    shared = shared.filter((s) => s.id !== u.searchParams.get('id')); saveShared();
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}');
  }
  if (u.pathname === '/clips') {
    touch();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ clips }));
  }
  // Phone -> PC clipboard (POST body = plain text)
  if (u.pathname === '/send' && req.method === 'POST') {
    touch();
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > MAX_SEND) req.destroy(); });
    req.on('end', () => {
      const ok = body.length > 0 && setPCClipboard(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, msg: ok ? 'Sent to PC clipboard' : body ? 'Already on PC clipboard' : 'Nothing to send' }));
    });
    return;
  }
  if (u.pathname === '/clipboard') u.pathname = '/'; // direct link: /clipboard?key=... opens the page (use #clips)
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
