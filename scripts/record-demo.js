#!/usr/bin/env node
// Records a short feature video of the demo office: `npm run record-demo` → site/assets/demo.mp4
//
// How it works (no dependencies, no ffmpeg):
//  - serves public/ on a random local port and opens ?demo=1 (simulated agents only, no real data)
//    in headless Chrome over the DevTools protocol;
//  - replaces the page's clock (performance.now, Date, timers, requestAnimationFrame) with a fake
//    one, so every frame is rendered at an exact time step however slow the machine is;
//  - a scripted tour (captions, a moving cursor, clicks) runs inside the page on that clock;
//  - each frame is screenshotted and handed to a second page that encodes H.264 with WebCodecs
//    and writes an MP4 file.
//
//  - a soundtrack is composed in the encoder page with Web Audio (an original lofi loop: keys,
//    bass, swung drums, vinyl crackle), encoded to AAC and muxed in as a second track.
//
// Options (env): CHROME_PATH, RECORD_FPS (30), RECORD_GL (swiftshader|metal|default), RECORD_OUT,
//   RECORD_BITRATE (video bits per second, 4000000: keeps the MP4 well under GitHub's 50 MB warning),
//   RECORD_MUSIC: path to your own audio file (mp3/m4a/wav…) to use instead, or "none" for no audio.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
// The landing page plays this file, so it is recorded straight into site/ (one copy in the repo).
const OUT = path.resolve(process.env.RECORD_OUT || path.join(ROOT, 'site', 'assets', 'demo.mp4'));
// Preview frames are scratch output (media/ is git-ignored); copy the ones the site needs into site/assets/.
const STILLS = path.join(ROOT, 'media', 'stills');
const FPS = Number(process.env.RECORD_FPS) || 30;
const BITRATE = Number(process.env.RECORD_BITRATE) || 4_000_000;
const VIEW = { width: 1440, height: 810, scale: 4 / 3 }; // → 1920×1080 frames
const OUT_W = Math.round(VIEW.width * VIEW.scale), OUT_H = Math.round(VIEW.height * VIEW.scale);
const DURATION = 130; // seconds, an upper bound: recording stops shortly after the end card
const MUSIC = process.env.RECORD_MUSIC ? (process.env.RECORD_MUSIC === 'none' ? 'none' : path.resolve(process.env.RECORD_MUSIC)) : null;
if (MUSIC && MUSIC !== 'none' && !fs.existsSync(MUSIC)) { console.error(`RECORD_MUSIC file not found: ${MUSIC}`); process.exit(1); }

if (typeof WebSocket === 'undefined') {
  console.error('record-demo needs Node 22 or newer (for the built-in WebSocket).');
  process.exit(1);
}

// ---------------------------------------------------------------- static server
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
let resolveUpload;
const uploaded = new Promise((r) => (resolveUpload = r));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/out') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, buf);
      res.end('ok');
      resolveUpload(buf.length);
    });
    return;
  }
  if (url.pathname === '/encoder.html') { res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(ENCODER_HTML); return; }
  if (url.pathname === '/__music' && MUSIC && MUSIC !== 'none') {
    fs.readFile(MUSIC, (err, buf) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(buf); });
    return;
  }
  if (url.pathname === '/__video.html') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end('<!doctype html><style>html,body{margin:0;background:#000}video{width:100vw;height:100vh;display:block}</style><video src="/__video.mp4" muted preload="auto"></video>');
    return;
  }
  if (url.pathname === '/__video.mp4' && fs.existsSync(OUT)) {
    const size = fs.statSync(OUT).size;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = Number(m[1]), end = m[2] ? Number(m[2]) : size - 1;
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      fs.createReadStream(OUT, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(OUT).pipe(res);
    }
    return;
  }
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

// ---------------------------------------------------------------- Chrome + CDP
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const c = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : process.platform === 'win32'
      ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return c.find((p) => fs.existsSync(p));
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && this.pending.has(d.id)) {
        const { resolve, reject } = this.pending.get(d.id);
        this.pending.delete(d.id);
        d.error ? reject(new Error(`${d.error.message} ${d.error.data || ''}`)) : resolve(d.result);
      } else if (d.method) for (const l of this.listeners) l(d);
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  once(method, sessionId) {
    return new Promise((resolve) => {
      const l = (d) => { if (d.method === method && (!sessionId || d.sessionId === sessionId)) { this.listeners.splice(this.listeners.indexOf(l), 1); resolve(d.params); } };
      this.listeners.push(l);
    });
  }
  async page(url, { width, height, scale }, beforeLoad) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => this.send(m, p, sessionId);
    await s('Page.enable'); await s('Runtime.enable');
    if (width) await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    if (beforeLoad) await s('Page.addScriptToEvaluateOnNewDocument', { source: beforeLoad });
    const loaded = this.once('Page.loadEventFired', sessionId);
    await s('Page.navigate', { url });
    await loaded;
    return { sessionId, send: s, eval: async (expr, awaitPromise = false) => {
      const r = await s('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    } };
  }
}

async function launch(gl) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome not found. Set CHROME_PATH to a Chrome or Chromium binary.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-record-'));
  const glFlags = gl === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : gl === 'metal' ? ['--use-angle=metal'] : [];
  const proc = spawn(chrome, ['--headless=new', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--remote-debugging-port=0', `--window-size=${VIEW.width},${VIEW.height}`, '--autoplay-policy=no-user-gesture-required', ...glFlags, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('Chrome did not start')), 20000);
    proc.stderr.on('data', (c) => { buf += c; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
    proc.on('exit', () => reject(new Error('Chrome exited early')));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return { proc, cdp: new CDP(ws), dir };
}

// ---------------------------------------------------------------- fake clock (runs before the app's scripts)
const FAKE_CLOCK = `(() => {
  let now = 0; const epoch = Date.now();
  const raf = new Map(); let rafId = 0;
  const timers = new Map(); let tid = 0;
  window.requestAnimationFrame = (cb) => { raf.set(++rafId, cb); return rafId; };
  window.cancelAnimationFrame = (id) => { raf.delete(id); };
  performance.now = () => now;
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(epoch + now); }
    static now() { return epoch + now; }
  }
  window.Date = FakeDate;
  window.setTimeout = (fn, ms = 0, ...args) => { timers.set(++tid, { at: now + Math.max(0, +ms || 0), fn, args }); return tid; };
  window.setInterval = (fn, ms = 0, ...args) => { const every = Math.max(1, +ms || 0); timers.set(++tid, { at: now + every, fn, args, every }); return tid; };
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
  // Advance the clock by dt ms: run due timers in order, then one animation frame.
  window.__step = (dt) => {
    const target = now + dt;
    for (let guard = 0; guard < 10000; guard++) {
      let next = null;
      for (const e of timers) if (e[1].at <= target && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      const [id, t] = next;
      now = Math.max(now, t.at);
      if (t.every) t.at += t.every; else timers.delete(id);
      try { if (typeof t.fn === 'function') t.fn(...t.args); } catch (e) { console.error(e); }
    }
    now = target;
    const q = [...raf.values()]; raf.clear();
    for (const cb of q) { try { cb(now); } catch (e) { console.error(e); } }
    return now;
  };
})();`;

// ---------------------------------------------------------------- the tour (runs inside the page, on the fake clock)
const DIRECTOR = String.raw`(() => {
  const $ = (s) => document.querySelector(s);
  const ao = window.__ao;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  async function tween(ms, fn) { const t0 = performance.now(); for (;;) { const k = Math.min(1, (performance.now() - t0) / ms); fn(ease(k), k); if (k >= 1) return; await frame(); } }

  // Clean frame: no demo chip, hints or connection text.
  for (const s of ['#modeChip', '.hint', '#connState', '.footer-bar']) { const el = $(s); if (el) el.style.display = 'none'; }

  // ---- captions
  const style = document.createElement('style');
  style.textContent = '.rec-cap{position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:99990;pointer-events:none;text-align:center;padding:14px 26px 16px;border-radius:18px;background:rgba(18,20,26,.82);color:#fff;box-shadow:0 12px 40px rgba(0,0,0,.35);backdrop-filter:blur(8px);font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:900px}'
    + '.rec-cap b{display:block;font-size:30px;letter-spacing:-.01em;font-weight:700}.rec-cap span{display:block;margin-top:4px;font-size:17px;color:#d8dce3}'
    + '.rec-cursor{position:fixed;left:0;top:0;z-index:99999;pointer-events:none;width:30px;height:30px;filter:drop-shadow(0 3px 6px rgba(0,0,0,.4))}'
    + '.rec-ring{position:fixed;z-index:99998;pointer-events:none;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #e0a458}'
    + '.rec-end{position:fixed;inset:0;z-index:99995;display:grid;place-content:center;text-align:center;background:radial-gradient(circle at 50% 40%,rgba(30,34,44,.92),rgba(10,12,16,.97));color:#fff;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}'
    + '.toasts{bottom:auto!important;top:118px!important}'
    + '.rec-end h1{font-size:72px;margin:18px 0 8px;letter-spacing:-.02em}.rec-end p{font-size:24px;color:#cfd4dc;margin:6px 0}.rec-end code{font-size:22px;background:#e0a458;color:#1b1f27;padding:6px 14px;border-radius:10px;font-weight:700}';
  document.head.append(style);
  const cap = document.createElement('div'); cap.className = 'rec-cap'; cap.style.opacity = '0'; document.body.append(cap);
  // Keep the caption centred in the free space: left of the side panel when it is open.
  (function keepCentred() {
    const p = document.getElementById('panel');
    const right = p && !p.hidden ? p.getBoundingClientRect().width + 24 : 0;
    cap.style.left = ((innerWidth - right) / 2) + 'px';
    cap.style.maxWidth = Math.min(900, innerWidth - right - 260) + 'px';
    requestAnimationFrame(keepCentred);
  })();
  async function caption(title, sub) {
    if (cap.style.opacity !== '0') await tween(250, (k) => { cap.style.opacity = String(1 - k); });
    cap.innerHTML = '<b>' + title + '</b>' + (sub ? '<span>' + sub + '</span>' : '');
    tween(350, (k) => { cap.style.opacity = String(k); cap.style.transform = 'translateX(-50%) translateY(' + (1 - k) * 12 + 'px)'; });
  }
  async function hideCaption() { await tween(300, (k) => { cap.style.opacity = String(1 - k); }); }

  // ---- cursor
  const cur = document.createElement('div'); cur.className = 'rec-cursor';
  cur.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2.5 19 13.2l-6.6 1.1 3.9 7.3-2.9 1.5-3.9-7.3L4.8 20Z" fill="#fff" stroke="#1b1f27" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.body.append(cur);
  let cx = innerWidth * 0.62, cy = innerHeight * 0.55;
  const place = () => { cur.style.transform = 'translate(' + (cx - 4) + 'px,' + (cy - 3) + 'px)'; };
  place();
  async function moveTo(x, y, ms = 700) { const x0 = cx, y0 = cy; await tween(ms, (k) => { cx = x0 + (x - x0) * k; cy = y0 + (y - y0) * k; place(); }); }
  async function moveToEl(el, ms) { if (!el) return; const r = el.getBoundingClientRect(); await moveTo(r.left + Math.min(r.width / 2, 60), r.top + r.height / 2, ms); }
  async function pulse() {
    const ring = document.createElement('div'); ring.className = 'rec-ring'; ring.style.left = cx + 'px'; ring.style.top = cy + 'px'; document.body.append(ring);
    await tween(380, (k) => { ring.style.transform = 'scale(' + (0.4 + k * 0.8) + ')'; ring.style.opacity = String(1 - k); });
    ring.remove();
  }
  async function click(el, ms) { if (!el) return; await moveToEl(el, ms); pulse(); await sleep(120); el.click(); }
  async function type(el, text, perChar = 38) {
    if (!el) return;
    el.focus();
    for (const ch of text) { el.value += ch; el.dispatchEvent(new Event('input', { bubbles: true })); await sleep(perChar); }
  }
  async function orbit(dYaw, ms) { const y0 = ao.office.cam.yaw; ao.office.camAnim = null; await tween(ms, (k) => { ao.office.cam.yaw = y0 + dYaw * k; ao.office.camAnim = null; }); }
  async function setHour(from, to, ms) {
    const r = $('#skyRange');
    await tween(ms, (k) => { r.value = String(from + (to - from) * k); r.dispatchEvent(new Event('input', { bubbles: true })); });
    r.blur();
  }
  const sessions = () => [...ao.state.sessions.values()];

  // ---- cinematic camera
  // Shots write the office camera directly (and keep its own fly-to animation off), so they can
  // go closer, lower and longer than the app's views. fov narrows for a telephoto look.
  const O = ao.office;
  const FOV = O.cam.fov, FLOOR_H = 3.6, LIFT_X = 0.95, LIFT_Z = 1.4;
  const lerp = (a, b, k) => a + (b - a) * k;
  const camNow = () => ({ target: [...O.cam.target], dist: O.cam.dist, pitch: O.cam.pitch, yaw: O.cam.yaw, fov: O.cam.fov });
  function setCam(c) { O.camAnim = null; O.userMoved = true; Object.assign(O.cam, c, { target: [...c.target] }); }
  // Move the camera to "to" (any of target/dist/pitch/yaw/fov). linear: a constant-speed drift.
  async function shot(to, ms, linear = false) {
    const a = camNow(), b = { ...a, ...to };
    await tween(ms, (e, k) => {
      const t = linear ? k : e;
      setCam({ target: a.target.map((v, i) => lerp(v, b.target[i], t)), dist: lerp(a.dist, b.dist, t), pitch: lerp(a.pitch, b.pitch, t), yaw: lerp(a.yaw, b.yaw, t), fov: lerp(a.fov, b.fov, t) });
    });
  }
  // Keep a moving thing in frame: the target eases after where(), the rest drifts to "to".
  async function follow(where, ms, to = {}, until = () => false) {
    const a = camNow(), b = { ...a, ...to };
    const t0 = performance.now();
    for (;;) {
      const k = Math.min(1, (performance.now() - t0) / ms), e = ease(Math.min(1, k * 2.5));
      const p = where();
      const tgt = p ? O.cam.target.map((v, i) => lerp(v, p[i], 0.12)) : O.cam.target;
      setCam({ target: tgt, dist: lerp(a.dist, b.dist, e), pitch: lerp(a.pitch, b.pitch, e), yaw: lerp(a.yaw, b.yaw, k), fov: lerp(a.fov, b.fov, e) });
      if (k >= 1 || until()) return;
      await frame();
    }
  }
  // The app's own view for the current floor/building, back at the normal lens.
  function appView(ms = 1100) { O.cam.fov = FOV; O.flyTo(O.viewCamera(), ms / 1000); return sleep(ms); }
  const worldPos = (node) => node && node.world ? [node.world[12], node.world[13], node.world[14]] : null;
  const robot = (id) => O.people.get(id);
  const robotHead = (p, up = 1.0) => { const w = p && worldPos(p.group); return w && [w[0], w[1] + up, w[2]]; };
  const traveller = () => [...O.people.values()].find((p) => p.trip);
  const cabPos = () => { const w = worldPos(O.cab); return w && [O.dims.W + LIFT_X, w[1] + 1.3, LIFT_Z]; };
  // A three-quarter close-up on a robot's face (robots face along their yaw).
  const closeUpCam = (p, side = 0.7, up = 1.0) => { const h = robotHead(p, up); return h && { target: h, dist: 2.7, pitch: 0.3, yaw: p.yaw + side, fov: 0.48 }; };
  async function closeUp(p, ms, side, up) { const c = closeUpCam(p, side, up); if (c) await shot(c, ms); }

  // ---- letterbox + clean frame for the cinematic parts
  const UI = ['.console', '#floors', '#floorBar', '.zoom', '.legend'].map((s) => $(s)).filter(Boolean);
  const bars = ['top', 'bottom'].map((side) => {
    const b = document.createElement('div');
    b.style.cssText = 'position:fixed;left:0;right:0;height:0;background:#000;z-index:99980;pointer-events:none;' + side + ':0';
    document.body.append(b); return b;
  });
  let cine = false;
  async function cinema(on, ms = 600) {
    if (on === cine) return; cine = on;
    await tween(ms, (k) => {
      const v = on ? k : 1 - k;
      for (const b of bars) b.style.height = (v * 9) + 'vh';
      for (const el of UI) el.style.opacity = String(1 - v);
    });
    for (const el of UI) el.style.visibility = on ? 'hidden' : '';
  }
  // A dip to black, for hard cuts between shots.
  const dip = document.createElement('div');
  dip.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;z-index:99985;pointer-events:none';
  document.body.append(dip);
  // c: the new camera, or a function run while the screen is black that returns it.
  async function cut(c, ms = 260) {
    await tween(ms, (k) => { dip.style.opacity = String(k); });
    if (typeof c === 'function') c = c();
    setCam({ ...camNow(), ...(c || {}) });
    await frame();
    await tween(ms, (k) => { dip.style.opacity = String(1 - k); });
  }

  async function run() {
    const F = 'demo-storefront';
    const DEV = 'development';
    // 1 — the building: open at street level on the entrance sign, crane up the facade to the
    //     rooftop sign, then pull back to the whole building as the UI fades in
    let { W, D, N } = O.dims;
    let roofY = (N + 1) * FLOOR_H;
    for (const el of UI) el.style.opacity = '0';
    for (const b of bars) b.style.height = '9vh';
    cine = true;
    cur.style.opacity = '0';
    dip.style.opacity = '1';
    setCam({ target: [W / 2, 2.6, D], dist: 10, pitch: 0.06, yaw: 0.32, fov: 0.42 });
    await sleep(100);
    tween(700, (k) => { dip.style.opacity = String(1 - k); });
    await shot({ dist: 7, yaw: 0.12 }, 2400, true);
    // crane up while pulling back, so the whole glass facade passes by rather than one floor
    await shot({ target: [W / 2, roofY * 0.55, D], dist: 26, pitch: 0.12, yaw: 0.02, fov: 0.5 }, 1900);
    await shot({ target: [W / 2, roofY + 2.4, D - 0.6], dist: 15, pitch: 0.1, yaw: -0.08, fov: 0.46 }, 1900);
    await sleep(300);
    caption('Agent Office', 'Every project is a building, every Claude Code agent a robot inside');
    cinema(false, 900);
    tween(900, (k) => { cur.style.opacity = String(k); });
    await appView(2400);
    await orbit(0.3, 2600);

    // 2 — floors
    caption('One floor per department', 'Development, Design, QA… with live status right on the facade');
    await moveToEl($('#projectSel'), 800);
    pulse();
    await sleep(500);
    await moveToEl($('[data-floor="' + DEV + '"]'), 700);
    await sleep(300);
    await click($('[data-floor="' + DEV + '"]'), 200);
    await sleep(1600);

    // 3 — robots
    caption('Every session is a robot', 'Working, waiting for you, your turn or idle: you see it at a glance');
    await moveTo(innerWidth * 0.55, innerHeight * 0.5, 900);
    // close-ups: a robot typing at its monitor, then one waving because it needs you
    // (the typing robot may be on another floor: the view switches to it without a fly-over)
    const busyS = O.sessions.find((s) => s.dept === DEV && s.status === 'working') || O.sessions.find((s) => s.status === 'working' && robot(s.id) && !robot(s.id).trip);
    const needyS = O.sessions.find((s) => s.dept === DEV && s.status === 'needs_you') || O.sessions.find((s) => s.status === 'needs_you');
    const onFloor = (s) => { O.view = { mode: 'floor', key: s.dept }; O.emitFloors(); };
    if (busyS || needyS) {
      cur.style.opacity = '0';
      await cinema(true, 500);
      if (busyS) { onFloor(busyS); await closeUp(robot(busyS.id), 1500, 0.9); await shot({ dist: 2.3, yaw: O.cam.yaw + 0.35 }, 2400, true); }
      if (needyS) {
        if (busyS) await cut(() => { onFloor(needyS); return closeUpCam(robot(needyS.id), -0.6, 1.25); }, 220);
        else { onFloor(needyS); await closeUp(robot(needyS.id), 1500, -0.6, 1.25); }
        await shot({ dist: 2.4, yaw: O.cam.yaw + 0.3 }, 2400, true);
      }
      cinema(false, 700);
      O.view = { mode: 'floor', key: DEV }; O.emitFloors();
      await appView(1300);
      cur.style.opacity = '1';
    } else { await orbit(-0.28, 4200); }
    await sleep(400);

    // 4 — branches
    caption('Branches get their own zone', 'Pick a branch and the camera flies to its robots');
    const sel = $('#fbBranch');
    await moveToEl(sel, 800);
    pulse();
    await sleep(250);
    if (sel) { sel.value = 'feature/dark-mode'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    await sleep(3200);
    if (sel) { sel.value = ''; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    await sleep(1400);

    // 5 — conversation + message box
    caption('Talk to any robot', 'Read its conversation and give it the next task, right from the panel');
    // Stay in this building: a robot from another project would switch the whole view over.
    let free = null;
    for (let k = 0; k < 30 && !free; k++) {
      free = sessions().find((s) => s.projectKey === F && (s.status === 'your_turn' || s.status === 'idle'));
      if (!free) await sleep(100);
    }
    if (free) {
      ao.office.focusSession(free.id);
      await sleep(900);
      const hit = ao.office.hits.find((h) => h.id === free.id);
      if (hit) await moveTo((hit.x0 + hit.x1) / 2, (hit.y0 + hit.y1) / 2, 800);
      pulse();
      ao.select(free.id);
      await sleep(900);
      await click($('[data-tab="conversation"]'), 600);
      await sleep(500);
      const box = $('#pComposeText');
      await moveToEl(box, 600);
      await type(box, 'Add a dark mode toggle to the settings page', 42);
      await sleep(300);
      await click($('#pComposeSend'), 400);
      await sleep(2200);
      ao.panel.close();
    } else await sleep(4000);

    // 6 — new task on a new branch
    if (O.project && O.project.key !== F) { ao.setProject(F); await sleep(900); } // back to the storefront building
    caption('Start agents on any branch', 'Each branch runs in its own git worktree, so agents never collide');
    await click($('#fbTask'), 800);
    for (let k = 0; k < 40 && $('#tBranchRow').hidden; k++) await sleep(50); // branch list loads async
    await sleep(400);
    const bsel = $('#tBranch');
    await moveToEl(bsel, 500);
    pulse();
    if (bsel) { bsel.value = '__new__'; bsel.dispatchEvent(new Event('change', { bubbles: true })); }
    await sleep(400);
    await type($('#tNewName'), 'feature/onboarding', 45);
    await sleep(200);
    const prompt = $('#tPrompt');
    if (prompt) prompt.value = '';
    await moveToEl(prompt, 400);
    await type(prompt, 'Build a three-step onboarding flow for new users', 30);
    await sleep(500);
    await click($('#tSend'), 500);
    await sleep(3000);
    ao.panel.close();

    // 7 — a team: the departments hand the work on, by lift, with a speech bubble
    caption('Departments work as a team', 'Give them one goal: each takes its turn, then rides the lift to hand over');
    await click($('#teamBtn'), 800);
    await sleep(500);
    await click($('#tdStart'), 600);
    await sleep(400);
    const goal = $('#tmGoal');
    if (goal) goal.value = '';
    await moveToEl(goal, 400);
    await type(goal, 'Add a wishlist to the product pages', 32);
    await sleep(300);
    await click($('#tmSend'), 500);
    await sleep(600);
    ao.teamDrawer.toggle(false);
    ao.office.showFloor('product');
    await sleep(1300);
    cur.style.opacity = '0';
    await cinema(true, 500);
    // Product takes its turn: close on its robot until it gets up for the lift
    const prod = robot((O.sessions.find((s) => s.dept === 'product' && s.status === 'working') || O.sessions.find((s) => s.dept === 'product') || {}).id);
    if (prod) { await closeUp(prod, 1400, 0.9); await follow(() => robotHead(prod), 4200, { dist: 2.4, yaw: O.cam.yaw + 0.3 }, () => !!prod.trip); }
    else await sleep(4000);
    for (let k = 0; k < 40 && !traveller(); k++) await sleep(100);
    // follow the Product robot itself (other robots may be riding the lift too)
    let tr = prod && prod.trip ? prod : traveller();
    const stage = () => (tr && tr.trip ? tr.trip.stage : null);
    const atLift = () => ['waitLift', 'board', 'ride'].includes(stage());
    // a high tracking shot as it walks to the lift (high, so the walls never get in the way)
    if (tr) await follow(() => robotHead(tr, 0.8), 9000, { dist: 8, pitch: 0.95, yaw: Math.PI / 4 + 0.3, fov: 0.55 }, atLift);
    // the lift arriving and the ride up, from outside the glass shaft, with the facade beside it
    O.view = { mode: 'building', key: null }; O.emitFloors();
    await cut(() => ({ target: cabPos() || O.cam.target, dist: 17, pitch: 0.14, yaw: Math.PI / 2 + 0.55, fov: 0.6 }), 200);
    await follow(cabPos, 10000, { dist: 15, yaw: Math.PI / 2 + 0.35 }, () => !atLift());
    // in on the floor it went to, for the hand-over: "Spec is ready…" — "On it!"
    const dest = (tr && tr.lvl && !tr.lvl.lobby && tr.lvl.key) || 'design';
    O.view = { mode: 'floor', key: dest }; O.emitFloors();
    await cut(() => ({ target: robotHead(tr, 0.8) || O.cam.target, dist: 7.5, pitch: 0.85, yaw: Math.PI / 4 - 0.2, fov: 0.55 }), 200);
    await follow(() => robotHead(tr, 0.8), 6500, { dist: 6, pitch: 0.75, yaw: Math.PI / 4 + 0.25 });
    cinema(false, 600);
    O.showFloor(dest);
    await sleep(900);
    cur.style.opacity = '1';

    // 8 — approvals
    caption('Approve from the browser', 'Permission requests land in one place: Allow or Deny');
    await click($('#approvalsBtn'), 800);
    await sleep(900);
    const allow = document.querySelector('#dBody .btn.allow');
    if (allow) { await click(allow, 700); await sleep(900); }
    else await sleep(1000);
    await click($('#dClose'), 500);
    await sleep(300);

    // 9 — day to night
    ao.panel.close();
    caption('Day and night follow your clock', 'The city lights up after sunset');
    ao.office.showBuilding();
    await moveTo(innerWidth - 150, 30, 900);
    await sleep(700);
    await setHour(10.5, 21.5, 4200);
    await sleep(400);
    cur.style.opacity = '0';
    // a low sweep through the lit-up streets, rising to the glowing sign on the roof
    ({ W, D, N } = O.dims); roofY = (N + 1) * FLOOR_H; // new robots may have grown the building
    cinema(true, 700);
    await cut({ target: [W / 2, 3, D + 6], dist: 34, pitch: 0.05, yaw: Math.PI / 4 + 0.75, fov: 0.5 }, 300);
    await shot({ yaw: Math.PI / 4 - 0.1, dist: 30, target: [W / 2, roofY * 0.5, D / 2] }, 4200, true);
    await hideCaption();
    await shot({ target: [W / 2, roofY + 2.4, D - 0.6], dist: 13, pitch: 0.14, yaw: 0.05, fov: 0.44 }, 3000);
    await sleep(900);

    // 10 — end card
    const end = document.createElement('div'); end.className = 'rec-end'; end.style.opacity = '0';
    end.innerHTML = '<div><svg viewBox="0 0 32 32" width="120" height="120"><path d="M16 4v4" stroke="#e0a458" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="3.6" r="2.3" fill="#e0a458"/><rect x="2.5" y="14" width="3.5" height="8" rx="1.75" fill="#b07a3a"/><rect x="26" y="14" width="3.5" height="8" rx="1.75" fill="#b07a3a"/><rect x="5" y="8" width="22" height="20" rx="6.5" fill="#e0a458"/><rect x="8.2" y="12.6" width="15.6" height="9.6" rx="4.3" fill="#1b1f27"/><circle cx="12.7" cy="17.4" r="2.1" fill="#5ff0d0"/><circle cx="19.3" cy="17.4" r="2.1" fill="#5ff0d0"/></svg>'
      + '<h1>Agent Office</h1><p>Runs 100% on your machine · no telemetry · no dependencies</p><p style="margin-top:22px"><code>npm start</code></p></div>';
    document.body.append(end);
    cur.style.display = 'none';
    await tween(700, (k) => { end.style.opacity = String(k); });
    window.__done = true;
  }
  window.__done = false;
  run().catch((e) => { console.error('tour failed:', e); window.__done = true; });
})();`;

// ---------------------------------------------------------------- encoder page (WebCodecs H.264 + a small MP4 writer)
const ENCODER_HTML = String.raw`<!doctype html><meta charset="utf-8"><title>encoder</title><script>
let enc, cfg, desc = null, fps = 30, W = 0, H = 0, err = null;
const samples = [];
window.__init = async (w, h, f, bitrate) => {
  W = w; H = h; fps = f;
  const base = { width: w, height: h, bitrate, framerate: f, avc: { format: 'avc' } };
  // Constrained baseline: no B-frames, so samples are in presentation order (no ctts box needed).
  for (const codec of ['avc1.42e028', 'avc1.42e02a', 'avc1.42001f']) {
    for (const hardwareAcceleration of ['prefer-software', 'no-preference']) {
      const c = { ...base, codec, hardwareAcceleration };
      try { if ((await VideoEncoder.isConfigSupported(c)).supported) { cfg = c; break; } } catch {}
    }
    if (cfg) break;
  }
  if (!cfg) throw new Error('This Chrome cannot encode H.264 with WebCodecs');
  enc = new VideoEncoder({
    output: (chunk, meta) => {
      const d = meta && meta.decoderConfig && meta.decoderConfig.description;
      if (d && !desc) desc = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
      const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b);
      samples.push({ data: b, key: chunk.type === 'key' });
    },
    error: (e) => { err = String(e); },
  });
  enc.configure(cfg);
  return cfg.codec;
};
window.__frame = async (b64, i) => {
  if (err) throw new Error(err);
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bin], { type: 'image/jpeg' }));
  const vf = new VideoFrame(bmp, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
  enc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
  vf.close(); bmp.close();
  while (enc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4));
  return samples.length;
};

// ---- MP4 writer: ftyp + mdat + moov, one H.264 track, all samples in one chunk.
const enc8 = (s) => new TextEncoder().encode(s);
function cat(parts) { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; }
const u8 = (v) => new Uint8Array([v & 255]);
const u16 = (v) => new Uint8Array([(v >> 8) & 255, v & 255]);
const u32 = (v) => new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
const zeros = (n) => new Uint8Array(n);
function box(type, ...p) { const body = cat(p.flat()); return cat([u32(8 + body.length), enc8(type), body]); }
function full(type, version, flags, ...p) { return box(type, u8(version), u8(flags >> 16), u8(flags >> 8), u8(flags), ...p); }
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32);

// Descriptor length in the 4-byte form used by esds.
const descLen = (n) => new Uint8Array([0x80 | ((n >> 21) & 127), 0x80 | ((n >> 14) & 127), 0x80 | ((n >> 7) & 127), n & 127]);
function descr(tag, ...p) { const body = cat(p.flat()); return cat([u8(tag), descLen(body.length), body]); }

function sttsEntries(deltas) {
  const runs = [];
  for (const d of deltas) { const last = runs[runs.length - 1]; if (last && last[1] === d) last[0]++; else runs.push([1, d]); }
  return [u32(runs.length), ...runs.flatMap(([c, d]) => [u32(c), u32(d)])];
}

/** video: { samples, desc } · audio: { samples:[{data, dur(ticks)}], rate, channels, codec:'aac'|'opus', asc, preSkip } | null */
function mux(audio) {
  const TS = 90000, delta = Math.round(TS / fps), n = samples.length;
  const vDurMs = Math.round(n * 1000 / fps);
  const ftyp = box('ftyp', enc8('isom'), u32(0x200), enc8('isom'), enc8('iso2'), enc8('avc1'), enc8('mp41'));
  const vBody = cat(samples.map((s) => s.data));
  const aBody = audio ? cat(audio.samples.map((s) => s.data)) : new Uint8Array(0);
  const mdatHeader = cat([u32(8 + vBody.length + aBody.length), enc8('mdat')]);
  const vOffset = ftyp.length + mdatHeader.length;
  const aOffset = vOffset + vBody.length;
  const dinf = () => box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));

  // ---- video track
  const name = enc8('Agent Office'); const comp = zeros(32); comp[0] = name.length; comp.set(name, 1);
  const avc1 = box('avc1', zeros(6), u16(1), u16(0), u16(0), zeros(12), u16(W), u16(H), u32(0x00480000), u32(0x00480000), u32(0), u16(1), comp, u16(0x18), u16(0xffff), box('avcC', desc));
  const keys = []; samples.forEach((s, i) => { if (s.key) keys.push(u32(i + 1)); });
  const vStbl = box('stbl',
    full('stsd', 0, 0, u32(1), avc1),
    full('stts', 0, 0, u32(1), u32(n), u32(delta)),
    full('stss', 0, 0, u32(keys.length), ...keys),
    full('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
    full('stsz', 0, 0, u32(0), u32(n), ...samples.map((s) => u32(s.data.length))),
    full('stco', 0, 0, u32(1), u32(vOffset)));
  const vTrak = box('trak',
    full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(vDurMs), zeros(8), u16(0), u16(0), u16(0), u16(0), ...MATRIX, u32(W << 16), u32(H << 16)),
    box('mdia',
      full('mdhd', 0, 0, u32(0), u32(0), u32(TS), u32(n * delta), u16(0x55c4), u16(0)),
      full('hdlr', 0, 0, u32(0), enc8('vide'), zeros(12), enc8('VideoHandler'), u8(0)),
      box('minf', full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)), dinf(), vStbl)));

  // ---- audio track
  let aTrak = null, aDurMs = 0;
  if (audio && audio.samples.length) {
    const an = audio.samples.length;
    const aTicks = audio.samples.reduce((t, s) => t + s.dur, 0);
    aDurMs = Math.round(aTicks * 1000 / audio.rate);
    let entry;
    if (audio.codec === 'aac') {
      const esds = full('esds', 0, 0,
        descr(0x03, u16(2), u8(0),
          descr(0x04, u8(0x40), u8(0x15), zeros(3), u32(192000), u32(192000), descr(0x05, audio.asc)),
          descr(0x06, u8(0x02))));
      entry = box('mp4a', zeros(6), u16(1), zeros(8), u16(audio.channels), u16(16), u16(0), u16(0), u32(audio.rate << 16), esds);
    } else {
      const dOps = box('dOps', u8(0), u8(audio.channels), u16(audio.preSkip), u32(audio.rate), u16(0), u8(0));
      entry = box('Opus', zeros(6), u16(1), zeros(8), u16(audio.channels), u16(16), u16(0), u16(0), u32(audio.rate << 16), dOps);
    }
    const aStbl = box('stbl',
      full('stsd', 0, 0, u32(1), entry),
      full('stts', 0, 0, ...sttsEntries(audio.samples.map((s) => s.dur))),
      full('stsc', 0, 0, u32(1), u32(1), u32(an), u32(1)),
      full('stsz', 0, 0, u32(0), u32(an), ...audio.samples.map((s) => u32(s.data.length))),
      full('stco', 0, 0, u32(1), u32(aOffset)));
    aTrak = box('trak',
      full('tkhd', 0, 3, u32(0), u32(0), u32(2), u32(0), u32(aDurMs), zeros(8), u16(0), u16(1), u16(0x0100), u16(0), ...MATRIX, u32(0), u32(0)),
      box('mdia',
        full('mdhd', 0, 0, u32(0), u32(0), u32(audio.rate), u32(aTicks), u16(0x55c4), u16(0)),
        full('hdlr', 0, 0, u32(0), enc8('soun'), zeros(12), enc8('SoundHandler'), u8(0)),
        box('minf', full('smhd', 0, 0, u16(0), u16(0)), dinf(), aStbl)));
  }
  const durMs = Math.max(vDurMs, aDurMs);
  const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(durMs), u32(0x00010000), u16(0x0100), zeros(10), ...MATRIX, zeros(24), u32(aTrak ? 3 : 2));
  const moov = box('moov', mvhd, vTrak, ...(aTrak ? [aTrak] : []));
  return cat([ftyp, mdatHeader, vBody, aBody, moov]);
}

// ---- soundtrack: an original lofi loop, rendered offline with Web Audio
function makeRng(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646; }
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

async function composeLofi(dur, sr) {
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
  const rnd = makeRng(20261117);
  const noiseBuf = (secs) => { const b = ctx.createBuffer(1, Math.ceil(secs * sr), sr); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1; return b; };
  const NOISE = noiseBuf(2);

  // master: warm low-pass → glue compressor → out, with fade in / fade out
  const master = ctx.createGain();
  const warm = ctx.createBiquadFilter(); warm.type = 'lowpass'; warm.frequency.value = 5200; warm.Q.value = 0.4;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -20; comp.ratio.value = 3; comp.attack.value = 0.008; comp.release.value = 0.22; comp.knee.value = 12;
  const out = ctx.createGain(); out.gain.value = 0.85;
  master.connect(warm); warm.connect(comp); comp.connect(out); out.connect(ctx.destination);
  master.gain.setValueAtTime(0.0001, 0);
  master.gain.exponentialRampToValueAtTime(1, 2.2);
  master.gain.setValueAtTime(1, Math.max(2.3, dur - 4.5));
  master.gain.linearRampToValueAtTime(0, dur - 0.05);

  // reverb: decaying stereo noise impulse
  const ir = ctx.createBuffer(2, Math.ceil(2.4 * sr), sr);
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = (rnd() * 2 - 1) * Math.pow(1 - i / d.length, 2.4); }
  const rev = ctx.createConvolver(); rev.buffer = ir;
  const revOut = ctx.createGain(); revOut.gain.value = 0.32; rev.connect(revOut); revOut.connect(master);

  const bpm = 78, beat = 60 / bpm, bar = beat * 4;
  const swing = beat * 0.09;              // late off-beat 8ths
  const bars = Math.ceil(dur / bar) + 1;

  // keys bus: tremolo + side-chain style dip on each kick
  const keys = ctx.createGain(); keys.gain.value = 0.5;
  const duck = ctx.createGain(); duck.gain.value = 1;
  keys.connect(duck); duck.connect(master); duck.connect(rev);
  const trem = ctx.createOscillator(); trem.frequency.value = 4.2; const tremAmt = ctx.createGain(); tremAmt.gain.value = 0.07; trem.connect(tremAmt); tremAmt.connect(keys.gain); trem.start(0);
  // tape wobble: slow pitch drift shared by the melodic parts
  const wob = ctx.createOscillator(); wob.frequency.value = 0.47; const wobAmt = ctx.createGain(); wobAmt.gain.value = 7; wob.connect(wobAmt); wob.start(0);

  // drums bus: crunchy and dull, like a sampled break
  const drums = ctx.createGain(); drums.gain.value = 0.85;
  const dLp = ctx.createBiquadFilter(); dLp.type = 'lowpass'; dLp.frequency.value = 3800;
  const shaper = ctx.createWaveShaper(); const curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 1.8); } shaper.curve = curve;
  drums.connect(shaper); shaper.connect(dLp); dLp.connect(master);

  const bass = ctx.createGain(); bass.gain.value = 0.55;
  const bLp = ctx.createBiquadFilter(); bLp.type = 'lowpass'; bLp.frequency.value = 420;
  bass.connect(bLp); bLp.connect(master);

  // ---- instruments
  function epiano(t, midi, len, vel) {
    const f = midiHz(midi);
    const car = ctx.createOscillator(); car.type = 'sine'; car.frequency.value = f;
    const mod = ctx.createOscillator(); mod.type = 'sine'; mod.frequency.value = f;
    const modAmt = ctx.createGain(); modAmt.gain.setValueAtTime(f * 1.1, t); modAmt.gain.exponentialRampToValueAtTime(f * 0.12, t + 0.5);
    mod.connect(modAmt); modAmt.connect(car.frequency);
    wobAmt.connect(car.detune);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.11 * vel, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.035 * vel, t + 1.2);
    g.gain.setValueAtTime(0.035 * vel, t + len);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.6);
    const pan = ctx.createStereoPanner(); pan.pan.value = (rnd() - 0.5) * 0.5;
    car.connect(g); g.connect(pan); pan.connect(keys);
    car.start(t); mod.start(t); car.stop(t + len + 0.7); mod.stop(t + len + 0.7);
  }
  function chord(t, notes, len, vel) {
    notes.forEach((m, i) => epiano(t + i * 0.016 + rnd() * 0.006, m, len, vel * (0.85 + rnd() * 0.25)));
  }
  function bassNote(t, midi, len) {
    const f = midiHz(midi);
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
    const s = ctx.createOscillator(); s.type = 'sine'; s.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.5, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.25, t + len * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.08);
    o.connect(g); s.connect(g); g.connect(bass);
    o.start(t); s.start(t); o.stop(t + len + 0.1); s.stop(t + len + 0.1);
  }
  function kick(t) {
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(115, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.95, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    o.connect(g); g.connect(drums); o.start(t); o.stop(t + 0.45);
    // the keys duck under the kick
    duck.gain.setValueAtTime(1, t); duck.gain.linearRampToValueAtTime(0.62, t + 0.02); duck.gain.linearRampToValueAtTime(1, t + 0.32);
  }
  function snare(t, vel = 1) {
    const n = ctx.createBufferSource(); n.buffer = NOISE; n.loopStart = rnd(); n.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 0.7;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.38 * vel, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    n.connect(bp); bp.connect(g); g.connect(drums);
    const sendR = ctx.createGain(); sendR.gain.value = 0.25; g.connect(sendR); sendR.connect(rev);
    n.start(t, rnd()); n.stop(t + 0.22);
    const b = ctx.createOscillator(); b.type = 'triangle'; b.frequency.setValueAtTime(200, t); b.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    const bg = ctx.createGain(); bg.gain.setValueAtTime(0.18 * vel, t); bg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    b.connect(bg); bg.connect(drums); b.start(t); b.stop(t + 0.12);
  }
  function hat(t, vel, open) {
    const n = ctx.createBufferSource(); n.buffer = NOISE; n.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7200;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.07 * vel, t); g.gain.exponentialRampToValueAtTime(0.001, t + (open ? 0.22 : 0.045));
    n.connect(hp); hp.connect(g); g.connect(drums);
    n.start(t, rnd()); n.stop(t + (open ? 0.25 : 0.06));
  }
  function lead(t, midi, len) {
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = midiHz(midi);
    wobAmt.connect(o.detune);
    const vib = ctx.createOscillator(); vib.frequency.value = 5; const vibAmt = ctx.createGain(); vibAmt.gain.value = 6; vib.connect(vibAmt); vibAmt.connect(o.detune);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.055, t + 0.05);
    g.gain.setValueAtTime(0.05, t + len * 0.8); g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.25);
    o.connect(lp); lp.connect(g); g.connect(master);
    const s = ctx.createGain(); s.gain.value = 0.5; g.connect(s); s.connect(rev);
    o.start(t); vib.start(t); o.stop(t + len + 0.3); vib.stop(t + len + 0.3);
  }

  // ---- vinyl: hiss + crackle across the whole track
  const hiss = ctx.createBufferSource(); hiss.buffer = NOISE; hiss.loop = true;
  const hissF = ctx.createBiquadFilter(); hissF.type = 'bandpass'; hissF.frequency.value = 3500; hissF.Q.value = 0.4;
  const hissG = ctx.createGain(); hissG.gain.value = 0.012;
  hiss.connect(hissF); hissF.connect(hissG); hissG.connect(master); hiss.start(0);
  const crackle = ctx.createBuffer(1, Math.ceil(dur * sr), sr);
  { const d = crackle.getChannelData(0); const pops = Math.floor(dur * 22);
    for (let k = 0; k < pops; k++) { const at = Math.floor(rnd() * (d.length - 200)); const a = (rnd() < 0.08 ? 0.5 : 0.12) * (rnd() < 0.5 ? -1 : 1); for (let j = 0; j < 60; j++) d[at + j] += a * Math.exp(-j / 6) * (rnd() * 0.6 + 0.4); } }
  const cr = ctx.createBufferSource(); cr.buffer = crackle;
  const crF = ctx.createBiquadFilter(); crF.type = 'highpass'; crF.frequency.value = 900;
  const crG = ctx.createGain(); crG.gain.value = 0.35;
  cr.connect(crF); crF.connect(crG); crG.connect(master); cr.start(0);

  // ---- arrangement
  const prog = [
    { bass: 41, notes: [57, 60, 64, 67] }, // Fmaj9
    { bass: 40, notes: [55, 59, 62, 66] }, // Em9
    { bass: 38, notes: [53, 57, 60, 64] }, // Dm9
    { bass: 36, notes: [52, 55, 59, 62] }, // Cmaj9
  ];
  const penta = [72, 74, 76, 79, 81, 84];
  const motif = [[0, 2, 1], [1.5, 3, 0.5], [2, 4, 1.5], [3.5, 2, 0.5], [4, 1, 1], [5.5, 0, 1.5]]; // [beat, scale step, length]
  for (let b = 0; b < bars; b++) {
    const t0 = 0.15 + b * bar;
    if (t0 > dur) break;
    const c = prog[b % prog.length];
    const last = t0 + bar > dur - 4.5;
    chord(t0, c.notes, beat * 2.2, 1);
    chord(t0 + beat * 2.5 + swing, c.notes.slice(1), beat * 1.2, 0.6);
    if (b >= 1) { bassNote(t0, c.bass, beat * 1.6); bassNote(t0 + beat * 2.5 + swing, c.bass, beat * 0.9); bassNote(t0 + beat * 3.5 + swing, c.bass + 7, beat * 0.45); }
    if (b >= 2 && !last) {
      kick(t0); kick(t0 + beat * 1.75 + swing * 0.5); kick(t0 + beat * 2.5 + swing);
      snare(t0 + beat); snare(t0 + beat * 3); if (b % 4 === 3) snare(t0 + beat * 3.75 + swing, 0.35);
      for (let h = 0; h < 8; h++) hat(t0 + h * beat / 2 + (h % 2 ? swing : 0), h % 2 ? 0.55 : 0.9, h === 7 && b % 2 === 1);
    }
    // melody from bar 8, two-bar phrases with small variations
    if (b >= 8 && b % 2 === 0 && !last) {
      for (const [bt, step, l] of motif) {
        if (rnd() < 0.18) continue;
        const shift = (b / 2) % 2 === 1 && step < 4 ? 1 : 0;
        lead(t0 + bt * beat + (bt % 1 ? swing : 0), penta[step + shift], l * beat);
      }
    }
  }
  return ctx.startRendering();
}

async function fileMusic(dur, sr) {
  const raw = await (await fetch('/__music')).arrayBuffer();
  const decodeCtx = new OfflineAudioContext(2, sr, sr);
  const src = await decodeCtx.decodeAudioData(raw);
  // Trim (or pad) to the video and fade out at the end.
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
  const s = ctx.createBufferSource(); s.buffer = src;
  const g = ctx.createGain(); g.gain.setValueAtTime(1, 0); g.gain.setValueAtTime(1, Math.max(0, dur - 4)); g.gain.linearRampToValueAtTime(0, dur);
  s.connect(g); g.connect(ctx.destination); s.start(0);
  return ctx.startRendering();
}

/** Encode an AudioBuffer: AAC if this Chrome can, otherwise Opus. */
async function encodeAudio(buf) {
  const sr = buf.sampleRate, ch = Math.min(2, buf.numberOfChannels);
  let codec = null, conf = null;
  for (const c of [{ codec: 'mp4a.40.2', kind: 'aac', bitrate: 192000 }, { codec: 'opus', kind: 'opus', bitrate: 160000 }]) {
    const cf = { codec: c.codec, sampleRate: sr, numberOfChannels: ch, bitrate: c.bitrate };
    try { if ((await AudioEncoder.isConfigSupported(cf)).supported) { codec = c.kind; conf = cf; break; } } catch {}
  }
  if (!codec) return null;
  const out = []; let description = null, aerr = null;
  const ae = new AudioEncoder({
    output: (chunk, meta) => {
      const d = meta && meta.decoderConfig && meta.decoderConfig.description;
      if (d && !description) description = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
      const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b);
      out.push({ data: b, durUs: chunk.duration || 0 });
    },
    error: (e) => { aerr = String(e); },
  });
  ae.configure(conf);
  const step = 4800;
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  for (let off = 0; off < buf.length; off += step) {
    const nFr = Math.min(step, buf.length - off);
    const planar = new Float32Array(nFr * ch);
    for (let c = 0; c < ch; c++) planar.set(chans[c].subarray(off, off + nFr), c * nFr);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: nFr, numberOfChannels: ch, timestamp: Math.round(off / sr * 1e6), data: planar });
    ae.encode(ad); ad.close();
    while (ae.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
  }
  await ae.flush();
  if (aerr) throw new Error(aerr);
  const frameLen = codec === 'aac' ? 1024 : 960;
  const samplesOut = out.map((s) => ({ data: s.data, dur: s.durUs ? Math.round(s.durUs * sr / 1e6) : frameLen }));
  // AAC: AudioSpecificConfig from the encoder, or build AAC-LC for this rate / channel count.
  let asc = description;
  if (codec === 'aac' && (!asc || !asc.length)) {
    const idx = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(sr);
    asc = new Uint8Array([(2 << 3) | (idx >> 1), ((idx & 1) << 7) | (ch << 3)]);
  }
  const preSkip = codec === 'opus' && description && description.length >= 12 ? (description[10] | (description[11] << 8)) : 312;
  return { samples: samplesOut, rate: sr, channels: ch, codec, asc, preSkip };
}

window.__finish = async (music) => {
  await enc.flush();
  if (err) throw new Error(err);
  if (!desc) throw new Error('encoder gave no avcC description');
  let audio = null;
  if (music !== 'none') {
    const dur = samples.length / fps, sr = 48000;
    const buf = music === 'file' ? await fileMusic(dur, sr) : await composeLofi(dur, sr);
    audio = await encodeAudio(buf);
  }
  const mp4 = mux(audio);
  const r = await fetch('/out', { method: 'POST', body: mp4 });
  return r.ok ? { bytes: mp4.length, frames: samples.length, codec: cfg.codec, audio: audio ? (audio.codec === 'aac' ? 'AAC' : 'Opus') + ' ' + (audio.rate / 1000) + ' kHz' : null } : null;
};
</script>`;

// ---------------------------------------------------------------- --stills: check the MP4 plays, save a few frames
async function stills(base) {
  if (!fs.existsSync(OUT)) throw new Error(`No video at ${OUT}. Record one first.`);
  const browser = await launch('swiftshader');
  const page = await browser.cdp.page(`${base}/__video.html`, { width: 960, height: 540, scale: 1 });
  const info = await page.eval(`new Promise((res) => { const v = document.querySelector('video');
    if (v.readyState >= 1) res({ d: v.duration, w: v.videoWidth, h: v.videoHeight });
    v.onloadedmetadata = () => res({ d: v.duration, w: v.videoWidth, h: v.videoHeight }); v.onerror = () => res({ error: String(v.error && v.error.message || v.error && v.error.code) }); })`, true);
  if (info.error) throw new Error(`Chrome could not play the MP4: ${info.error}`);
  // Play a couple of seconds to check the soundtrack decodes too.
  const audioBytes = await page.eval(`new Promise(async (res) => { const v = document.querySelector('video'); v.currentTime = 20;
    try { await v.play(); } catch {} setTimeout(() => { v.pause(); res(v.webkitAudioDecodedByteCount || 0); }, 2500); })`, true);
  console.log(`Plays fine: ${info.d.toFixed(1)}s, ${info.w}×${info.h}, audio ${audioBytes > 0 ? `decoding (${Math.round(audioBytes / 1024)} KB in 2.5s)` : 'none'}`);
  const dir = STILLS;
  fs.mkdirSync(dir, { recursive: true });
  const times = [...Array(Math.floor(info.d / 3)).keys()].map((i) => 1.5 + i * 3).concat(info.d - 0.5).filter((t) => t < info.d);
  for (const t of times) {
    await page.eval(`new Promise((res) => { const v = document.querySelector('video'); v.onseeked = () => requestAnimationFrame(() => requestAnimationFrame(res)); v.currentTime = ${t}; })`, true);
    const shot = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
    const f = path.join(dir, `t${String(t.toFixed(1)).padStart(4, '0')}.jpg`);
    fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
    console.log(`  ${path.relative(process.cwd(), f)}`);
  }
  await closeBrowser(browser);
}

/** Quit Chrome, wait until it has really exited, then remove its temp profile. */
async function closeBrowser(browser) {
  const gone = new Promise((r) => { if (browser.proc.exitCode !== null) r(); else browser.proc.once('exit', r); });
  browser.proc.kill();
  await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
  try { fs.rmSync(browser.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}

// ---------------------------------------------------------------- main
async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  if (process.argv.includes('--stills')) { await stills(base); server.close(); return; }
  const order = process.env.RECORD_GL ? [process.env.RECORD_GL] : process.platform === 'darwin' ? ['metal', 'swiftshader'] : ['default', 'swiftshader'];

  let browser, app, gl;
  for (gl of order) {
    browser = await launch(gl);
    app = await browser.cdp.page(`${base}/?demo=1&record=1&hour=10.5`, VIEW, FAKE_CLOCK);
    browser.cdp.listeners.push((d) => {
      if (d.sessionId === app.sessionId && d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'warning')) {
        console.log('  page:', d.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
      }
    });
    // Let the page boot on the fake clock.
    for (let i = 0; i < 90; i++) await app.eval('window.__step && window.__step(16)');
    const ok = await app.eval('!!(window.__ao && window.__ao.office)');
    if (ok) break;
    console.log(`  WebGL did not start with GL=${gl}, trying the next option…`);
    browser.proc.kill(); browser = null;
  }
  if (!browser) throw new Error('The 3D view could not start in headless Chrome.');
  console.log(`Recording ${DURATION}s at ${FPS} fps, ${OUT_W}×${OUT_H} (GL: ${gl})…`);

  const encoder = await browser.cdp.page(`${base}/encoder.html`, {});
  const codec = await encoder.eval(`__init(${OUT_W}, ${OUT_H}, ${FPS}, ${BITRATE})`, true);
  console.log(`  encoder: ${codec}`);

  await app.eval(DIRECTOR);
  const total = DURATION * FPS;
  const t0 = Date.now();
  let i = 0;
  for (; i < total; i++) {
    await app.eval(`window.__step(${1000 / FPS})`);
    const shot = await app.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, optimizeForSpeed: true });
    await encoder.eval(`__frame(${JSON.stringify(shot.data)}, ${i})`, true);
    if (i % FPS === 0) {
      const el = (Date.now() - t0) / 1000;
      const eta = i ? Math.round((el / i) * (total - i)) : 0;
      process.stdout.write(`\r  ${String(Math.floor(i / FPS)).padStart(2)}s / ${DURATION}s of video · ${eta ? `about ${eta}s left` : ''}        `);
    }
    // Stop a second after the end card is fully in.
    if (i > FPS * 10 && i % FPS === 0 && await app.eval('window.__done === true')) {
      for (let k = 0; k < FPS * 1.5; k++, i++) {
        await app.eval(`window.__step(${1000 / FPS})`);
        const s = await app.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, optimizeForSpeed: true });
        await encoder.eval(`__frame(${JSON.stringify(s.data)}, ${i + 1})`, true);
      }
      i++;
      break;
    }
  }
  process.stdout.write(`\n  ${MUSIC === 'none' ? 'no soundtrack' : MUSIC ? `adding ${path.basename(MUSIC)}` : 'composing the lofi soundtrack'} and encoding…\n`);
  const music = MUSIC === 'none' ? 'none' : MUSIC ? 'file' : 'lofi';
  const result = await encoder.eval(`__finish(${JSON.stringify(music)})`, true);
  if (!result) throw new Error('Could not write the MP4.');
  await uploaded;
  console.log(`Saved ${path.relative(process.cwd(), OUT)} · ${(result.frames / FPS).toFixed(1)}s · ${(result.bytes / 1e6).toFixed(1)} MB · ${result.codec}${result.audio ? ` + ${result.audio}` : ''} · took ${Math.round((Date.now() - t0) / 1000)}s`);
  await closeBrowser(browser);
  server.close();
}

main().catch((e) => { console.error('\nrecord-demo failed:', e.message); process.exit(1); });
