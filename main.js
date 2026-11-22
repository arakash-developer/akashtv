const { app, BrowserWindow, globalShortcut, net, session, screen } = require('electron');
const fs = require('fs');
const path = require('path');

// Phone pairing, login and settings live in the "pairings" folder next to the app
// (dev: project folder; installed: folder of the .exe), so they survive renames / rebuilds
const APP_DIR = app.isPackaged ? path.dirname(process.execPath) : __dirname;
app.setPath('userData', path.join(APP_DIR, 'pairings'));

const TV_URL = 'https://www.youtube.com/tv';

// GitHub raw URL of user-agents.json (optional)
const REMOTE_UA_LIST_URL = '';

// UA list files (first = user override, editable without rebuilding; second = bundled with the app)
const uaFiles = () => [
  path.join(app.getPath('userData'), 'user-agents.json'),
  path.join(__dirname, 'user-agents.json')
];

const cleanList = (a) => (Array.isArray(a) ? a.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : []);

function loadLocalUAs() {
  const out = [];
  for (const f of uaFiles()) {
    try { out.push(...cleanList(JSON.parse(fs.readFileSync(f, 'utf8')))); } catch {}
  }
  return out;
}

const CHECK_TIMEOUT_MS = 20000;
let win, uaList = [], uaIndex = 0, checking = false, checkTimer = null;
let waiting = false, waitTimer = null, lastSoftRetry = 0;

// Chromium net error codes that mean "connection problem", not "bad user agent"
const NETWORK_ERRORS = new Set([-7, -21, -100, -101, -102, -103, -104, -105, -106, -109, -118, -137, -324]);

function showMessage(html) {
  win.loadURL('data:text/html,' + encodeURIComponent(
    '<body style="background:#000;color:#fff;font:24px sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center">' +
    html + '</body>'));
}

// Pause everything until the internet is back, then run `resume`
function waitForOnline(resume) {
  if (waiting) return;
  waiting = true;
  clearTimeout(checkTimer);
  console.log('[NET] offline, waiting...');
  showMessage('No internet connection.<br>Waiting to reconnect...');
  const poll = () => {
    if (!win) return;
    if (net.isOnline()) { waiting = false; console.log('[NET] back online'); resume(); }
    else waitTimer = setTimeout(poll, 3000);
  };
  waitTimer = setTimeout(poll, 3000);
}

function stopWaiting() { waiting = false; clearTimeout(waitTimer); }

// Reload YouTube TV with the current (already working) user agent
function reloadCurrent() {
  const ua = uaList[uaIndex];
  if (!ua) return start();
  if (!net.isOnline()) return waitForOnline(reloadCurrent);
  win.loadURL(targetURL(), { userAgent: ua });
}

// ---- Resume playback after any reload / UA change ----
let lastWatch = null; // { url, time }

const targetURL = () => (lastWatch ? lastWatch.url : TV_URL);

// Every 5s remember which video is playing and where
setInterval(async () => {
  if (!win || checking || waiting) return;
  try {
    const st = await win.webContents.executeJavaScript(
      `(() => { const v = document.querySelector('video');
        return { url: location.href, time: v && v.duration ? v.currentTime : 0 }; })()`);
    if (!st.url.includes('youtube.com/tv')) return;
    lastWatch = /[?&]v=/.test(st.url) ? { url: st.url, time: st.time || (lastWatch && lastWatch.url === st.url ? lastWatch.time : 0) } : null;
  } catch {}
}, 5000);

// Seek the video back to where it was, once it has loaded
function resumeVideo() {
  if (!lastWatch || lastWatch.time < 5) return;
  const t = Math.floor(lastWatch.time);
  console.log(`[PLAY] resuming at ${t}s`);
  win.webContents.executeJavaScript(`(() => { let n = 0; const iv = setInterval(() => {
    const v = document.querySelector('video');
    if (v && v.readyState >= 1) { if (v.currentTime < ${t} - 3) v.currentTime = ${t}; v.play().catch(() => {}); clearInterval(iv); }
    else if (++n > 60) clearInterval(iv); }, 500); })()`).catch(() => {});
}

const retry = () => (checking ? tryCurrentUA() : reloadCurrent());

const savePath = () => path.join(app.getPath('userData'), 'working-ua.json');
const loadSavedUA = () => { try { return JSON.parse(fs.readFileSync(savePath(), 'utf8')).ua; } catch { return null; } };
const saveUA = (ua) => { try { fs.writeFileSync(savePath(), JSON.stringify({ ua, savedAt: new Date().toISOString() })); } catch {} };

function fetchRemoteUAs() {
  if (!REMOTE_UA_LIST_URL) return Promise.resolve([]);
  return new Promise((resolve) => {
    const req = net.request(REMOTE_UA_LIST_URL);
    let body = '';
    const t = setTimeout(() => { req.abort(); resolve([]); }, 5000);
    req.on('response', (res) => {
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        clearTimeout(t);
        try { resolve(cleanList(JSON.parse(body))); }
        catch { resolve([]); }
      });
    });
    req.on('error', () => { clearTimeout(t); resolve([]); });
    req.end();
  });
}

async function buildUAList() {
  const remote = await fetchRemoteUAs();
  const saved = loadSavedUA();
  const list = [...new Set([saved, ...remote, ...loadLocalUAs()].filter(Boolean))];
  console.log(`[UA] loaded ${list.length} user agents (remote: ${remote.length})`);
  return list;
}

function tryCurrentUA() {
  const ua = uaList[uaIndex];
  if (!net.isOnline()) { checking = true; return waitForOnline(tryCurrentUA); }
  console.log(`[UA] trying #${uaIndex + 1}/${uaList.length}`);
  checking = true;
  win.webContents.setUserAgent(ua);
  win.loadURL(targetURL(), { userAgent: ua });
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => verify(), CHECK_TIMEOUT_MS);
}

function nextUA(reason) {
  if (!checking || waiting) return;
  if (!net.isOnline()) return waitForOnline(tryCurrentUA); // not the UA's fault
  console.log(`[UA] failed (${reason})`);
  clearTimeout(checkTimer);
  uaIndex++;
  if (uaIndex < uaList.length) return tryCurrentUA();
  checking = false;
  showMessage('No working TV user agent found.<br>Update the list and press Ctrl+R.');
}

async function verify() {
  if (!checking || waiting) return;
  const url = win.webContents.getURL();
  if (!url.includes('youtube.com/tv')) return nextUA('redirected away from /tv');
  try {
    const ok = await win.webContents.executeJavaScript(
      `!!document.querySelector('ytlr-app, [class*="ytlr"]') ||
       [...document.querySelectorAll('*')].some(e => e.tagName.startsWith('YTLR-'))`);
    if (ok) {
      checking = false;
      clearTimeout(checkTimer);
      saveUA(uaList[uaIndex]);
      console.log('[UA] working, saved.');
      resumeVideo();
    } else nextUA('TV interface not detected');
  } catch { nextUA('page check error'); }
}

async function start() {
  stopWaiting();
  uaList = await buildUAList();
  uaIndex = 0;
  checking = true;
  if (!uaList.length) return nextUA('user-agents.json is empty or missing');
  tryCurrentUA();
}

// ---- Which monitor to open on (chosen from the phone, saved by launcher.js) ----
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function chosenDisplay() {
  let want = null;
  try { want = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).display; } catch {}
  const all = screen.getAllDisplays();
  if (!want) return screen.getPrimaryDisplay();
  // Windows reports physical pixels, Electron may use scaled ones: match by the monitor's top-left corner
  return all.find((d) => d.bounds.x === want.x && d.bounds.y === want.y)
    || screen.getDisplayNearestPoint({ x: want.x + 10, y: want.y + 10 })
    || screen.getPrimaryDisplay();
}
function moveToChosenDisplay() {
  if (!win) return;
  const d = chosenDisplay();
  const wasFull = win.isFullScreen();
  if (wasFull) win.setFullScreen(false);
  win.setBounds({ x: d.bounds.x + 50, y: d.bounds.y + 50, width: 1280, height: 720 });
  if (wasFull) setTimeout(() => win && win.setFullScreen(true), 300);
  console.log('[DISPLAY] using display at', d.bounds.x, d.bounds.y);
}
// Follow changes made from the phone while the app is running
let lastDisplaySetting; // undefined until first check
setInterval(() => {
  let cur = 'null';
  try { cur = JSON.stringify(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).display || null); } catch {}
  if (lastDisplaySetting !== undefined && cur !== lastDisplaySetting) moveToChosenDisplay();
  lastDisplaySetting = cur;
}, 2000);

function createWindow() {
  const disp = chosenDisplay();
  win = new BrowserWindow({
    title: 'AKASH TV', icon: path.join(__dirname, 'assets', 'icon.png'), x: disp.bounds.x + 50, y: disp.bounds.y + 50, width: 1280, height: 720, fullscreen: true, autoHideMenuBar: true, backgroundColor: '#000000',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  win.on('page-title-updated', (e) => e.preventDefault()); // keep "AKASH TV" as window title
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.webContents.on('did-navigate', (_e, url) => {
    if (url.startsWith('data:') || url.includes('youtube.com/tv') || url.includes('accounts.google.com')) return;
    if (checking) return nextUA('redirected to ' + url);
    // While watching: first try a quiet reload with the same UA; only re-test all UAs if it happens again soon
    if (Date.now() - lastSoftRetry > 60000) {
      lastSoftRetry = Date.now();
      console.log('[UA] redirected while watching, reloading with same UA');
      reloadCurrent();
    } else start();
  });

  win.webContents.on('did-finish-load', () => {
    if (win.webContents.getURL().startsWith('data:')) return;
    if (checking) setTimeout(verify, 6000);
    else resumeVideo();
  });

  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 || waiting) return; // -3 = aborted by a new navigation
    console.log(`[NET] load failed (${code} ${desc})`);
    if (!net.isOnline()) return waitForOnline(retry);
    if (NETWORK_ERRORS.has(code)) { clearTimeout(checkTimer); return setTimeout(retry, 5000); }
    if (!checking) setTimeout(reloadCurrent, 5000);
  });

  win.webContents.on('render-process-gone', (_e, d) => {
    console.log(`[APP] page crashed (${d.reason}), reloading`);
    if (!waiting) setTimeout(retry, 2000);
  });

  win.webContents.on('unresponsive', () => {
    console.log('[APP] page unresponsive, reloading');
    if (!waiting) retry();
  });

  win.on('closed', () => { stopWaiting(); clearTimeout(checkTimer); win = null; });
  start();
}

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Write phone pairing + login to disk now (protects against power-off / force close)
function flushStorage() {
  try { session.defaultSession.flushStorageData(); session.defaultSession.cookies.flushStore(); } catch {}
}

app.whenReady().then(() => {
  createWindow();
  setInterval(flushStorage, 30000);
  globalShortcut.register('F11', () => win && win.setFullScreen(!win.isFullScreen()));
  globalShortcut.register('CommandOrControl+R', () => win && start());
  globalShortcut.register('CommandOrControl+Q', () => app.quit());
});

app.on('before-quit', flushStorage);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());