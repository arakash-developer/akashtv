# AKASH TV

Turns any PC into a YouTube TV screen. Your phone's YouTube app becomes the remote.

## Run
```
npm install
npm start
```
Build an installer: `npm run dist` (output in `dist/`).

## Pair your phone (remote)
1. On the PC: TV UI → Settings → **Link with TV code** — a code appears.
2. On the phone: YouTube app → Profile → Settings → **Watch on TV** → **Enter TV code**.
3. Tap the cast icon on any video → it plays on the PC. Phone controls play/pause/seek/volume/queue.

## Keys on the PC
Arrows / Enter = navigate, Backspace / Esc = back, F11 = fullscreen, Ctrl+R = reload, Ctrl+Q = quit.

## If YouTube says "unsupported"
Change `TV_USER_AGENT` in `main.js` to another smart-TV user agent.

## Next step: auto-discovery (no code needed)
Add a DIAL server (SSDP on the LAN) so the phone sees the PC under the cast button
automatically, like a real TV. The `yt-cast-receiver` npm package implements DIAL + the
YouTube Lounge protocol and is the starting point for that.
