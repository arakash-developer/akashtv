const { app, BrowserWindow, globalShortcut, net } = require('electron');
const fs = require('fs');
const path = require('path');

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
  console.log(`[UA] trying #${uaIndex + 1}/${uaList.length}`);
  checking = true;
  win.webContents.setUserAgent(ua);
  win.loadURL(TV_URL, { userAgent: ua });
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => verify(), CHECK_TIMEOUT_MS);
}

function nextUA(reason) {
  if (!checking) return;
  console.log(`[UA] failed (${reason})`);
  clearTimeout(checkTimer);
  uaIndex++;
  if (uaIndex < uaList.length) return tryCurrentUA();
  checking = false;
  win.loadURL('data:text/html,' + encodeURIComponent(
    '<body style="background:#000;color:#fff;font:24px sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center">' +
    'No working TV user agent found.<br>Update the list and press Ctrl+R.</body>'));
}

async function verify() {
  if (!checking) return;
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
    } else nextUA('TV interface not detected');
  } catch { nextUA('page check error'); }
}

async function start() {
  uaList = await buildUAList();
  uaIndex = 0;
  checking = true;
  if (!uaList.length) return nextUA('user-agents.json is empty or missing');
  tryCurrentUA();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 720, fullscreen: true, autoHideMenuBar: true, backgroundColor: '#000000',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.webContents.on('did-navigate', (_e, url) => {
    if (url.startsWith('data:') || url.includes('youtube.com/tv') || url.includes('accounts.google.com')) return;
    if (checking) nextUA('redirected to ' + url);
    else start();
  });

  win.webContents.on('did-finish-load', () => { if (checking) setTimeout(verify, 6000); });

  win.on('closed', () => { win = null; });
  start();
}

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(() => {
  createWindow();
  globalShortcut.register('F11', () => win && win.setFullScreen(!win.isFullScreen()));
  globalShortcut.register('CommandOrControl+R', () => win && start());
  globalShortcut.register('CommandOrControl+Q', () => app.quit());
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());