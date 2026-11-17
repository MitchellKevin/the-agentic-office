// Agent Office — a 3D office building in a small city, on top of the tiny WebGL renderer in gl.js.
// The building is one project: a lobby, one floor per department (Development, Design, QA…) and
// a roof. A glass lift runs up the side; robots ride it when they change department or go and
// talk to another department. Characters are sessions, small characters with a badge are
// subagents ("interns").
// View modes: 'building' (outside, overview) and 'floor' (camera flies into one floor; floors
// above and that floor's glass front are cut away).
import { Renderer, Node, MeshBuilder, lin, mix3, scale3 } from './gl.js';
import { daylight } from './daylight.js';

const DESK_SPACING = 3;
const MAX_COLS = 3;
const FLOOR_H = 3.6;
const SLAB = 0.24;
const WALL_H = FLOOR_H - SLAB;
const T = 0.2;
const WALK_SPEED = 1.5;
// The lift shaft sits outside the street-side wall (x = W), near the back corner.
const LIFT_W = 1.9;            // depth of the shaft, along x
const LIFT_L = 1.9;            // width of the shaft, along z
const LIFT_Z = 1.4;            // centre of the shaft along z
const LIFT_DOOR = 0.62;        // half the door opening
const CAB_SLOTS = [[-0.32, -0.36], [-0.32, 0.36], [0.34, -0.36], [0.34, 0.36]];
const ACKS = ['On it!', 'Got it, thanks.', 'Great, I\'ll take it from here.', 'Thanks! Starting now.', 'Okay, leave it with me.'];

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) { let s = seed % 2147483647 || 1; return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const SKIN = ['#f2d1b3', '#e6b48f', '#c98e64', '#a86f47', '#7c4f31', '#f6dcc6'];
const HAIR = ['#2b2118', '#5a3b22', '#a5672f', '#d8b067', '#1f1f26', '#7a2e22', '#b9b3ab'];
const PANTS = ['#33415c', '#3d3d45', '#5b4636', '#2e4a3e'];
const CAR_COLORS = ['#d8473d', '#3a78c2', '#f2f0ea', '#2b2d33', '#e0a458', '#4c9a6a'];

function lookFor(id) {
  const h = hash(id);
  return {
    shirt: `hsl(${h % 360}, 52%, 52%)`,
    paint: `hsl(${h % 360}, ${45 + ((h >>> 4) % 20)}%, ${50 + ((h >>> 9) % 12)}%)`,
    skin: SKIN[(h >>> 8) % SKIN.length],
    hair: HAIR[(h >>> 12) % HAIR.length],
    pants: PANTS[(h >>> 20) % PANTS.length],
    style: (h >>> 16) % 3,
  };
}
function angleLerp(a, b, t) {
  const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + d * t;
}
function lerpN(a, b, t) { return a.map((v, i) => v + (b[i] - v) * t); }

// ---------- canvas textures ----------
function canvas(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); return c; }
function codeCanvas() {
  return canvas(256, 512, (g) => {
    g.fillStyle = '#10181d'; g.fillRect(0, 0, 256, 512);
    const cols = ['#7ee0b8', '#f0c674', '#81a2be', '#cc99cc', '#e6e1d8'];
    const rnd = rng(7);
    for (let y = 10; y < 512; y += 14) {
      let x = 12 + Math.floor(rnd() * 3) * 16;
      const n = 1 + Math.floor(rnd() * 4);
      for (let k = 0; k < n && x < 240; k++) {
        const w = 14 + rnd() * 60;
        g.fillStyle = cols[Math.floor(rnd() * cols.length)];
        g.fillRect(x, y, Math.min(w, 244 - x), 6);
        x += w + 8;
      }
    }
  });
}
function signCanvas(name, accent, bg, fg) {
  return canvas(512, 128, (g) => {
    g.fillStyle = bg; roundRect(g, 4, 4, 504, 120, 18); g.fill();
    g.fillStyle = accent; roundRect(g, 4, 4, 30, 120, 14); g.fill(); g.fillRect(20, 4, 14, 120);
    g.fillStyle = fg; g.font = '600 56px ui-sans-serif, system-ui, -apple-system, sans-serif'; g.textBaseline = 'middle';
    let t = name; while (t.length > 1 && g.measureText(t).width > 440) t = t.slice(0, -1);
    if (t !== name) t = t.slice(0, -1) + '…';
    g.fillText(t, 56, 68);
  });
}
function logoCanvas(dark, name) {
  return canvas(1024, 192, (g, w, h) => {
    g.fillStyle = dark ? '#1b1f27' : '#2a2622'; roundRect(g, 0, 0, w, h, 26); g.fill();
    // robot head logo
    const cx = 110, cy = 104;
    g.strokeStyle = '#e0a458'; g.lineWidth = 9; g.lineCap = 'round';
    g.beginPath(); g.moveTo(cx, cy - 66); g.lineTo(cx, cy - 46); g.stroke();
    g.fillStyle = '#e0a458'; g.beginPath(); g.arc(cx, cy - 70, 11, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#b07a3a'; roundRect(g, cx - 72, cy - 14, 16, 38, 8); g.fill(); roundRect(g, cx + 56, cy - 14, 16, 38, 8); g.fill();
    g.fillStyle = '#e0a458'; roundRect(g, cx - 60, cy - 48, 120, 108, 32); g.fill();
    g.fillStyle = '#1b1f27'; roundRect(g, cx - 43, cy - 22, 86, 52, 22); g.fill();
    g.fillStyle = '#5ff0d0'; g.beginPath(); g.arc(cx - 19, cy + 4, 10, 0, Math.PI * 2); g.arc(cx + 19, cy + 4, 10, 0, Math.PI * 2); g.fill();
    g.fillStyle = dark ? '#ffe6c2' : '#fff6ea';
    g.textBaseline = 'middle';
    // The project's name next to the logo: shrink to fit, then truncate with an ellipsis.
    const label = String(name || 'Agent Office').toUpperCase(), maxW = w - 200 - 36;
    let size = 96;
    const font = (s) => `700 ${s}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
    g.font = font(size);
    while (size > 56 && g.measureText(label).width > maxW) g.font = font(size -= 4);
    let t = label; while (t.length > 1 && g.measureText(t).width > maxW) t = t.slice(0, -1);
    if (t !== label) t = t.slice(0, -1) + '…';
    g.fillText(t, 200, 102);
  });
}
function skyCanvas({ top, mid, hor }, stars) {
  // With flipY the canvas top row maps to the bottom of the dome and the bottom row to the zenith.
  return canvas(512, 512, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, hor); grad.addColorStop(0.5, hor); grad.addColorStop(0.535, mid); grad.addColorStop(0.75, top); grad.addColorStop(1, top);
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    if (stars > 0) {
      const rnd = rng(42);
      for (let i = 0; i < 420; i++) {
        const x = rnd() * w, y = h * 0.56 + rnd() * h * 0.44, r = rnd() * 1.1 + 0.3;
        // in twilight the stars near the horizon fade out first
        const fade = clamp((y / h - 0.56) / 0.44 + stars * 1.4 - 0.4, 0, 1);
        g.fillStyle = `rgba(255,255,255,${(0.35 + rnd() * 0.6) * fade})`;
        g.fillRect(x, y, r, r);
      }
    }
  });
}
const FACADE_STYLES = 5;
function facadeCanvas(style, dark, seed) {
  return canvas(256, 448, (g, W, H) => {
    const rnd = rng(seed);
    const cw = W / 4, ch = H / 4;
    const lit = () => dark && rnd() < 0.38;
    const litCol = () => (rnd() < 0.7 ? '#ffd58a' : '#d8ecff');
    if (style === 0) { // office: stone grid with punched windows
      g.fillStyle = dark ? '#2a2d34' : '#ddd7cc'; g.fillRect(0, 0, W, H);
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        const x = c * cw + cw * 0.14, y = r * ch + ch * 0.2, w = cw * 0.72, h = ch * 0.58;
        g.fillStyle = lit() ? litCol() : dark ? '#10141b' : '#7d95aa'; g.fillRect(x, y, w, h);
        if (!dark) { g.fillStyle = 'rgba(255,255,255,.28)'; g.fillRect(x, y, w, h * 0.22); }
        g.fillStyle = dark ? '#1e2026' : '#c9c2b5'; g.fillRect(x - 2, y + h, w + 4, 4);
      }
    } else if (style === 1) { // glass curtain wall
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, dark ? '#0e1822' : '#6f9fbb'); grad.addColorStop(1, dark ? '#0a121a' : '#4f7f9c');
      g.fillStyle = grad; g.fillRect(0, 0, W, H);
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (lit()) { g.fillStyle = litCol(); g.globalAlpha = 0.85; g.fillRect(c * cw + 3, r * ch + 10, cw - 6, ch - 22); g.globalAlpha = 1; }
      g.fillStyle = dark ? '#1b232c' : '#2f3e4a';
      for (let c = 0; c <= 4; c++) g.fillRect(c * cw - 2, 0, 4, H);
      for (let r = 0; r <= 4; r++) g.fillRect(0, r * ch - 7, W, 12);
      if (!dark) { g.fillStyle = 'rgba(255,255,255,.12)'; g.beginPath(); g.moveTo(0, H * 0.9); g.lineTo(W * 0.6, 0); g.lineTo(W * 0.85, 0); g.lineTo(W * 0.25, H); g.closePath(); g.fill(); }
    } else if (style === 2) { // brick apartments
      g.fillStyle = dark ? '#3a2621' : '#9b5a43'; g.fillRect(0, 0, W, H);
      g.fillStyle = dark ? 'rgba(0,0,0,.25)' : 'rgba(60,20,10,.18)';
      for (let y = 0; y < H; y += 8) g.fillRect(0, y, W, 2);
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        const x = c * cw + cw * 0.27, y = r * ch + ch * 0.22, w = cw * 0.46, h = ch * 0.52;
        g.fillStyle = dark ? '#5a4a40' : '#efe8dc'; g.fillRect(x - 4, y - 4, w + 8, h + 8);
        g.fillStyle = lit() ? '#ffcf86' : dark ? '#121418' : '#34404a'; g.fillRect(x, y, w, h);
        g.fillStyle = dark ? '#5a4a40' : '#efe8dc'; g.fillRect(x + w / 2 - 1.5, y, 3, h);
      }
    } else if (style === 3) { // dark modern with ribbon windows
      g.fillStyle = dark ? '#23262c' : '#454a52'; g.fillRect(0, 0, W, H);
      for (let r = 0; r < 4; r++) {
        const y = r * ch + ch * 0.28, h = ch * 0.44;
        g.fillStyle = dark ? '#0c1016' : '#9fb6c4'; g.fillRect(0, y, W, h);
        for (let c = 0; c < 8; c++) if (lit()) { g.fillStyle = litCol(); g.fillRect(c * W / 8, y, W / 8, h); }
        g.fillStyle = dark ? '#1a1d22' : '#30353c';
        for (let c = 0; c <= 8; c++) g.fillRect(c * W / 8 - 1.5, y, 3, h);
        if (!dark) { g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(0, y, W, h * 0.2); }
      }
    } else { // classic stone with tall windows and cornices
      g.fillStyle = dark ? '#37332b' : '#e8dec9'; g.fillRect(0, 0, W, H);
      for (let r = 0; r < 4; r++) {
        g.fillStyle = dark ? '#2b2822' : '#d2c6ad'; g.fillRect(0, r * ch, W, 7);
        for (let c = 0; c < 4; c++) {
          const x = c * cw + cw * 0.3, y = r * ch + ch * 0.16, w = cw * 0.4, h = ch * 0.66;
          g.fillStyle = dark ? '#2b2822' : '#bfb196'; g.fillRect(x - 4, y - 6, w + 8, h + 10);
          g.fillStyle = lit() ? '#ffd28a' : dark ? '#121418' : '#5d7385'; g.fillRect(x, y, w, h);
        }
      }
    }
  });
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// ---------- the office ----------
export class Office {
  constructor(canvasEl, { onSelect, onHover, onFloors } = {}) {
    this.canvas = canvasEl;
    this.onSelect = onSelect || (() => {});
    this.onHover = onHover || (() => {});
    this.onFloors = onFloors || (() => {});
    this.r = new Renderer(canvasEl);
    this.canvasEl = canvasEl;
    this.root = new Node();
    this.sessions = [];
    this.floors = new Map();     // project key -> floor
    this.floorOrder = [];
    this.people = new Map();
    this.interns = new Map();
    this.project = null;         // { key, name, departments: [{ id, name }] }
    this.pendingSays = [];       // speech for robots that haven't walked in yet
    this.gone = new Map();       // robots that left by taxi: id -> time, so they don't pop back in
    this.taxi = null;            // the taxi at the rank in front of the building, when one is coming
    const self = this;
    this.lobbyLvl = { key: '__lobby', name: 'Lobby', index: -1, oy: 0, lobby: true, get node() { return self.lobby; }, get liftDoors() { return self.lobbyDoors; } };
    this.resetLift();
    this.view = { mode: 'building', key: null };
    this.hoverFloor = null;
    this.safe = false;
    this.selected = null;
    this.t = 0;
    this.hits = [];
    this.eye = [30, 20, 30];
    this.dims = { W: 12, D: 10, N: 0 };
    this.cam = { target: [6, 6, 5], yaw: Math.PI / 4, pitch: 0.3, dist: 50, fov: 0.62 };
    this.camAnim = null;
    this.codeTex = this.r.texture(codeCanvas(), { repeat: true });
    this.labels = document.createElement('div');
    this.labels.className = 'labels';
    canvasEl.parentElement.appendChild(this.labels);
    this.sky = new Node(this.r.meshes.sphere, { color: [1, 1, 1], sky: true, unlit: true });
    this.root.add(this.sky);
    this.world = new Node();
    this.root.add(this.world);
    this.readColors();
    this.bindInput();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvasEl);
  }

  // ---------- public API ----------
  /** Sessions of the building on show. Each one has `dept`: the floor it works on. */
  setSessions(list) { this.sessions = list; this.layout(); }

  /**
   * The building on show: { key, name, departments: [{ id, name }] }. Switching to another
   * project dissolves to the new building; changing departments rebuilds the floors in place.
   */
  setProject(p) {
    const next = { key: p?.key || '', name: p?.name || 'Agent Office', repo: !!p?.repo, departments: (p?.departments?.length ? p.departments : [{ id: 'general', name: 'General' }]).map((d) => ({ id: d.id, name: d.name })) };
    const prev = this.project;
    if (prev && prev.key === next.key && prev.name === next.name && prev.repo === next.repo && JSON.stringify(prev.departments) === JSON.stringify(next.departments)) return;
    this.project = next;
    if (!prev || prev.key !== next.key) {
      if (prev) this.beginCrossfade(700);
      this.clearScene();
      this.sessions = []; // the new building's robots arrive with the next setSessions()
      this.floorOrder = [];
      this.view = { mode: 'building', key: null };
      this.layoutKey = '';
      this.userMoved = false;
    } else if (prev.name !== next.name) {
      this.structSig = ''; // repaint the name sign over the entrance
    }
    this.layout();
  }

  /**
   * A team message: the sender walks over (by lift if needed), says its line and walks back.
   * m: { from: sessionId|null, to: sessionId|null, toDept, say, done }
   *  - from null: the user briefs a robot (a bubble over the robot, once it has walked in)
   *  - done: the sender rides down to the lobby and reports to reception
   */
  deliver(m) {
    const sp = m.from ? this.people.get(m.from) : null;
    const say = String(m.say || '').trim();
    if (!say) return;
    if (!sp) {
      if (m.to) this.queueSay(m.to, say, 7, 'brief');
      return;
    }
    if (m.done) {
      this.plan(sp, [
        { lobby: true, wait: 6.5, talk: [{ at: 0, who: 'me', text: say, secs: 5 }, { at: 2.2, who: 'desk', text: 'Thanks! I\'ll let them know.', secs: 3.6 }] },
        { home: true },
      ]);
      return;
    }
    const ack = ACKS[hash(`${m.to}${say}`) % ACKS.length];
    this.plan(sp, [
      { visit: m.to, dept: m.toDept, wait: 6.5, talk: [{ at: 0, who: 'me', text: say, secs: 5 }, { at: 2.4, who: 'them', text: ack, secs: 3.4 }] },
      { home: true },
    ]);
  }

  /**
   * Sends a robot home: it says goodbye, takes the lift down, walks out of the front door and
   * gets into a taxi at the rank. Returns false if there's no such robot (or it's already going).
   */
  sendHome(id) {
    const p = this.people.get(id);
    if (!p || p.leaving) return false;
    p.leaving = true;
    p.queue = [];
    p.cup = false;
    p.say = { text: 'Bye, everyone!', until: this.t + 2.6, kind: 'say' };
    if (this.selected === id) this.selected = null;
    if (p.trip) {
      const t = p.trip;
      t.stops = [...t.stops.slice(0, t.i), { taxi: true }];
      if (t.stage !== 'ride' && t.stage !== 'board' && t.stage !== 'alight') this.startStop(p);
    } else {
      this.plan(p, [{ taxi: true }]);
    }
    return true;
  }

  /** The server said no: the robot turns round and goes back to its desk. */
  comeBack(id) {
    this.gone.delete(id);
    const p = this.people.get(id);
    if (!p?.leaving) return;
    p.leaving = false;
    p.say = { text: 'Oh, I\'m staying after all.', until: this.t + 3, kind: 'say' };
    const t = p.trip;
    if (!t) return;
    t.stops = [...t.stops.slice(0, t.i), { home: true }];
    if (t.stage !== 'ride' && t.stage !== 'board' && t.stage !== 'alight') this.startStop(p);
  }

  /** Takes a robot out of the building for good (it got into the taxi). */
  removePerson(p) {
    p.group.detach(); p.deskNode?.detach();
    p.label?.remove(); p.moreLabel?.label?.remove(); p.talkHolder?.label?.remove();
    this.lift.riders.delete(p);
    this.people.delete(p.id);
    this.gone.set(p.id, this.t);
  }

  /** A speech bubble over a robot for a few seconds. Waits up to a minute for robots not here yet. */
  queueSay(id, text, secs = 5, kind = 'say') {
    const p = this.people.get(id);
    if (p) { p.say = { text, until: this.t + secs, kind }; return; }
    this.pendingSays.push({ id, text, secs, kind, expires: this.t + 60 });
  }
  setSafe(on) { this.safe = on; }
  setSelected(id) { this.selected = id; }
  start() {
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now; this.t += dt;
      this.update(dt);
      this.draw(dt);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
  zoomBy(f) { this.camAnim = null; this.cam.dist = clamp(this.cam.dist / f, 3, 260); }
  fit() { this.flyTo(this.viewCamera(), 0.6); }
  showBuilding() { this.view = { mode: 'building', key: null }; this.flyTo(this.viewCamera()); this.emitFloors(); }
  showFloor(key) {
    if (!this.floors.has(key)) return;
    this.view = { mode: 'floor', key };
    this.flyTo(this.viewCamera());
    this.emitFloors();
  }
  stepFloor(dir) {
    const keys = this.floorOrder.filter((k) => this.floors.has(k));
    if (!keys.length) return;
    if (this.view.mode === 'building') { this.showFloor(dir > 0 ? keys[0] : keys[keys.length - 1]); return; }
    const i = keys.indexOf(this.view.key) + dir;
    if (i < 0 || i >= keys.length) this.showBuilding(); else this.showFloor(keys[i]);
  }
  focusSession(id) {
    const sid = String(id).split('/')[0];
    const s = this.sessions.find((x) => x.id === sid);
    const key = s && this.people.get(sid)?.floor?.key;
    if (!key) return;
    const otherBranch = this.view.branch && (s.branch || 'detached') !== this.view.branch;
    if (this.view.mode !== 'floor' || this.view.key !== key || otherBranch) this.showFloor(key);
  }

  /** Takes every floor, robot and label down (theme change, another building). */
  clearScene() {
    for (const f of this.floors.values()) { f.node.detach(); f.tagHolder?.label?.remove(); (f.zoneTex || []).forEach((t) => this.r.deleteTexture(t)); }
    for (const p of this.people.values()) { p.group.detach(); p.deskNode?.detach(); p.label?.remove(); p.moreLabel?.label?.remove(); p.talkHolder?.label?.remove(); }
    for (const it of this.interns.values()) { it.group.detach(); it.label?.remove(); }
    this.floors.clear(); this.people.clear(); this.interns.clear();
    this.pendingSays = [];
    this.gone.clear();
    this.taxi?.node.detach();
    this.taxi = null;
    this.recSay = null;
    this.structSig = '';
    this.resetLift();
  }

  resetLift() {
    this.lift = { y: 0, at: this.lobbyLvl, target: null, state: 'idle', door: 0, dwell: 0, riders: new Set() };
  }

  readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    const dark = (cs.getPropertyValue('color-scheme') || '').includes('dark');
    this.dark = dark;
    this.css = {
      wallL: v('--c-wall-l'), wallR: v('--c-wall-r'), wallTop: v('--c-wall-top'),
      deskTop: v('--c-desk-top'), deskSide: v('--c-desk-l'), monitor: v('--c-monitor'), screenOff: v('--c-screen-off'),
      screenOn: v('--c-screen-on'), chair: v('--c-chair'), sign: v('--c-sign'), signText: v('--c-sign-text'),
      plant: v('--c-plant'), pot: v('--c-pot'), machine: v('--c-machine'),
      working: v('--working'), needs: v('--needs'), turn: v('--turn'), idle: v('--idle'), accent: v('--accent'),
      carpetL: v('--carpet-l'), carpetS: v('--carpet-s'),
    };
    const C = this.css;
    const facade = dark ? '#3a3f4b' : '#efe8dc';
    this.mats = {
      facade: { color: lin(facade) }, facadeDark: { color: scale3(lin(facade), 0.82) },
      concrete: { color: lin(dark ? '#4a4f5a' : '#cfc8bc') },
      deskTop: { color: lin(C.deskTop) }, deskSide: { color: lin(C.deskSide) },
      monitor: { color: lin(C.monitor) }, chair: { color: lin(C.chair) },
      chairSeat: { color: mix3(lin(C.chair), [1, 1, 1], 0.12) },
      plant: { color: lin(C.plant) }, plantDark: { color: scale3(lin(C.plant), 0.7) }, pot: { color: lin(C.pot) },
      machine: { color: lin(C.machine) }, machineDark: { color: scale3(lin(C.machine), 0.4) },
      window: dark ? { color: [0.9, 0.7, 0.35], emissive: [1.3, 0.9, 0.35], noShadow: true } : { color: [0.45, 0.6, 0.72], emissive: [0.05, 0.07, 0.09], noShadow: true },
      windowIn: dark ? { color: [0.05, 0.07, 0.15], emissive: [0.02, 0.03, 0.07], noShadow: true } : { color: [0.62, 0.78, 0.92], emissive: [0.25, 0.3, 0.36], noShadow: true },
      glass: { color: dark ? [0.25, 0.35, 0.5] : [0.6, 0.78, 0.9], alpha: dark ? 0.16 : 0.22, emissive: dark ? [0.01, 0.02, 0.04] : [0.05, 0.07, 0.09], spec: 1.4, shine: 120 },
      glassHover: { color: lin(C.accent), alpha: 0.35, emissive: scale3(lin(C.accent), 0.15) },
      mullion: { color: lin(dark ? '#2a2e36' : '#5d636e') },
      cup: { color: [0.92, 0.9, 0.86] }, coffee: { color: [0.2, 0.1, 0.05] },
      led: { color: lin(C.working), unlit: true },
      key: { color: mix3(lin(C.monitor), [1, 1, 1], 0.25) },
      steam: { color: [1, 1, 1], alpha: 0.35, noShadow: true },
      ring: { color: lin(C.accent), unlit: true, alpha: 0.9, noShadow: true },
      badge: { color: [1, 1, 1] }, lanyard: { color: lin(C.accent) },
      grass: { color: lin(dark ? '#1f3324' : '#8fbf72') },
      road: { color: lin(dark ? '#1c1e22' : '#4a4d53') },
      paving: { color: lin(dark ? '#3b3e45' : '#d6d1c7') },
      curb: { color: lin(dark ? '#4c5059' : '#bdb7ab') },
      paint: { color: lin(dark ? '#9a9a8a' : '#f4f1e6'), noShadow: true },
      trunk: { color: lin('#6b4a30') }, leaf: { color: lin(dark ? '#2c5a35' : '#5e9e4f') }, leaf2: { color: lin(dark ? '#25502e' : '#4f8c43') },
      pole: { color: lin(dark ? '#565b66' : '#3d4149') },
      lamp: dark ? { color: [3, 2.4, 1.3], unlit: true, noShadow: true } : { color: lin('#e8e4da'), noShadow: true },
      tire: { color: [0.03, 0.03, 0.03] }, carGlass: { color: lin(dark ? '#1b2330' : '#2d3a48') },
      head: dark ? { color: [3, 2.8, 2], unlit: true } : { color: [0.9, 0.9, 0.85] },
      cloud: dark ? { color: lin('#4a5672'), emissive: [0.02, 0.025, 0.04], noShadow: true } : { color: [1, 1, 1], emissive: [0.32, 0.33, 0.35], noShadow: true },
      roofTop: { color: lin(dark ? '#30343c' : '#b9b2a6') }, unit: { color: lin(dark ? '#5a606b' : '#e2ddd3') },
      marble: { color: lin(dark ? '#4b4f58' : '#f1ece3') },
      liftDoor: { color: lin(dark ? '#8e959f' : '#b9bfc8'), spec: 1.1, shine: 80 },
      liftFrame: { color: lin(dark ? '#3a3f48' : '#4a505a'), spec: 0.6, shine: 40 },
      cabFloor: { color: lin(dark ? '#3c3530' : '#7a6a5a') },
      cabLight: dark ? { color: [2.6, 2.4, 2.0], unlit: true, noShadow: true } : { color: [1.4, 1.38, 1.3], unlit: true, noShadow: true },
      liftLamp: { color: lin(C.accent), unlit: true, noShadow: true },
      liftGlass: { color: dark ? [0.3, 0.42, 0.55] : [0.62, 0.8, 0.9], alpha: dark ? 0.14 : 0.18, emissive: dark ? [0.01, 0.02, 0.04] : [0.05, 0.07, 0.09], spec: 1.4, shine: 120, noShadow: true },
    };
    this.skyKey = null;
    this.setHour(this.hour ?? 12);
    (this.facadeTex || []).forEach((t) => this.r.deleteTexture(t));
    this.facadeTex = Array.from({ length: FACADE_STYLES }, (_, i) => this.r.texture(facadeCanvas(i, dark, 11 + i * 7), { repeat: true }));
    // rebuild everything with the new palette
    this.clearScene();
    const keepCam = !!this.layoutKey;
    this.layoutKey = keepCam ? 'theme' : '';
    this.layout();
  }

  /**
   * Time of day (0–24). Moves the sun and tints the light and sky. Day vs night (palette, lit
   * windows, street lamps) follows the page theme, which the app sets from the same hour.
   */
  setHour(hour) {
    this.hour = hour;
    let d = daylight(hour);
    // The page theme decides day vs night. If they disagree for a moment (theme not applied
    // yet), fall back to plain midday or midnight rather than mixing the two.
    if (d.night !== this.dark) d = daylight(this.dark ? 0 : 13);
    this.env = d.env;
    this.sunGlow = d.sunGlow;
    this.moonAlpha = d.moonAlpha;
    // Redraw the sky dome only when it visibly changes: dragging the slider fires a lot.
    const key = `${d.sky.top}${d.sky.mid}${d.sky.hor}${d.stars.toFixed(2)}`;
    if (key !== this.skyKey) {
      this.skyKey = key;
      this.r.deleteTexture(this.skyTex);
      this.skyTex = this.r.texture(skyCanvas(d.sky, d.stars));
      this.sky.mat = { color: [1, 1, 1], sky: true, unlit: true, tex: this.skyTex };
    }
  }

  /**
   * Freeze what is on screen on top of the canvas and dissolve it away, so a palette swap
   * (day ↔ night) fades instead of snapping. Call it right before readColors().
   */
  beginCrossfade(ms = 1600) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const src = this.canvasEl;
    if (!src?.width || !src?.height) return;
    // The WebGL canvas doesn't keep its drawing buffer, so draw a fresh frame and copy it in the
    // same task, before the browser clears it.
    try { this.draw(0); } catch { return; }
    const snap = document.createElement('canvas');
    snap.width = src.width; snap.height = src.height;
    const g = snap.getContext('2d');
    g.drawImage(src, 0, 0);
    // A fade still running (slider dragged back and forth): keep its half-faded picture on top.
    const prev = this.fade;
    if (prev) {
      g.globalAlpha = prev.opacity();
      g.drawImage(prev.el, 0, 0, snap.width, snap.height);
      prev.el.remove();
    }
    snap.className = 'scene-fade';
    snap.setAttribute('aria-hidden', 'true');
    src.after(snap);
    const t0 = performance.now();
    const fade = { el: snap, opacity: () => { const t = clamp((performance.now() - t0) / ms, 0, 1); return 1 - t * t * (3 - 2 * t); } };
    this.fade = fade;
    const step = () => {
      if (this.fade !== fade) return;
      const o = fade.opacity();
      snap.style.opacity = String(o);
      if (o <= 0) { snap.remove(); this.fade = null; return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- layout ----------
  layout() {
    // One floor per department, in the building's order (floor 1 first), empty ones included.
    // A robot whose department no longer exists works on the first floor.
    const deps = this.project?.departments?.length ? this.project.departments : [{ id: 'general', name: 'General' }];
    const byRoom = new Map(deps.map((d) => [d.id, { key: d.id, name: d.name, sessions: [] }]));
    for (const s of this.sessions) {
      if (this.gone.has(s.id)) continue; // drove off in a taxi; the server catches up in a moment
      (byRoom.get(s.dept) || byRoom.get(deps[0].id)).sessions.push(s);
    }
    this.floorOrder = deps.map((d) => d.id);
    const specs = this.floorOrder.map((k) => byRoom.get(k));

    let W = 11, D = 9;
    for (const r of specs) {
      r.sessions.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0) || a.id.localeCompare(b.id));
      const n = Math.max(1, r.sessions.length);
      r.cols = Math.min(MAX_COLS, n);
      // Git floors: one zone per branch. Zones are packed into desk rows (a branch with one
      // robot doesn't need a whole row to itself); big branches span several full rows.
      r.repo = !!this.project?.repo || r.sessions.some((s) => s.repo);
      const groups = new Map();
      for (const s of r.sessions) {
        const b = r.repo ? (s.branch || 'detached') : '';
        if (!groups.has(b)) groups.set(b, []);
        groups.get(b).push(s);
      }
      const rank = (b) => (['main', 'master', 'develop', 'dev'].includes(b) ? 0 : 1);
      r.groups = [...groups.entries()].map(([branch, list]) => ({ branch, sessions: list }))
        .sort((a, b) => rank(a.branch) - rank(b.branch) || a.branch.localeCompare(b.branch));
      let row = 0, used = 0;
      r.cells = [];   // { session, col, row, branch }
      for (const g of r.groups) {
        if (g.sessions.length >= r.cols || used + g.sessions.length > r.cols) { if (used) { row++; used = 0; } }
        for (const s of g.sessions) {
          if (used >= r.cols) { row++; used = 0; }
          r.cells.push({ session: s, col: used, row, branch: g.branch });
          used++;
        }
      }
      r.rows = row + 1;
      W = Math.max(W, r.cols * DESK_SPACING + 3.5);
      D = Math.max(D, r.rows * DESK_SPACING + 3.2);
    }
    const N = specs.length;
    const structSig = `${W},${D}`;
    if (structSig !== this.structSig) {
      this.structSig = structSig;
      this.dims = { W, D, N };
      this.world.children.slice().forEach((c) => c.detach());
      if (this.city) for (const m of this.city.meshes) this.r.deleteMesh(m);
      this.city = this.buildCity(W, D); this.world.add(this.city.node);
      this.lobby = this.buildLobby(W, D); this.world.add(this.lobby);
      this.roof = this.buildRoof(W, D); this.world.add(this.roof);
      this.cab = this.buildCab(W); this.world.add(this.cab);
      if (this.taxi) this.world.add(this.taxi.node);
      for (const f of this.floors.values()) { f.shellSig = null; this.world.add(f.node); }
      // Robots in the lift or the lobby move over to the rebuilt ones.
      for (const p of this.people.values()) {
        if (p.trip?.stage === 'ride') this.cab.add(p.group);
        else if (p.trip && p.lvl === this.lobbyLvl) this.lobby.add(p.group);
      }
    }
    this.dims = { W, D, N };
    this.roof.at(0, (N + 1) * FLOOR_H, 0);

    const keep = new Set();
    const keepKeys = new Set(this.floorOrder);
    specs.forEach((spec, index) => {
      keep.add(spec.key);
      let f = this.floors.get(spec.key);
      if (!f) {
        f = { key: spec.key, node: new Node(), shell: null, glass: [], shellSig: null };
        this.floors.set(spec.key, f);
        this.world.add(f.node);
      }
      f.index = index; f.name = spec.name; f.spec = spec;
      f.oy = (index + 1) * FLOOR_H;
      f.node.at(0, f.oy, 0);
      const sig = `${W},${D},${spec.name}`;
      if (f.shellSig !== sig) {
        f.shell?.detach();
        const built = this.buildFloorShell(spec, W, D);
        f.shell = built.node; f.glass = built.glass; f.steam = built.steam; f.machine = built.machine; f.liftDoors = built.liftDoors;
        f.node.add(f.shell);
        f.shellSig = sig;
        for (const p of this.people.values()) if (p.floor === f) { p.deskNode?.detach(); p.deskNode = null; }
      }
      const extraX = W - (spec.cols * DESK_SPACING + 3.5), extraZ = D - (spec.rows * DESK_SPACING + 3.2);
      f.desks = spec.cells.map(({ session: s, col, row, branch }) => {
        const cx = 3.3 + extraX / 2 + col * DESK_SPACING, cz = 2.9 + extraZ / 2 + row * DESK_SPACING;
        return { session: s, cx, cz, seat: { x: cx, z: cz + 0.78 }, branch };
      });
      for (const d of f.desks) this.placePerson(d, f, keepKeys);
      this.buildZones(f, spec);
    });
    for (const [k, f] of this.floors) {
      if (keep.has(k)) continue;
      f.node.detach(); f.tagHolder?.label?.remove(); (f.zoneTex || []).forEach((t) => this.r.deleteTexture(t));
      this.floors.delete(k);
    }
    const live = new Set(this.sessions.map((s) => s.id));
    for (const [id, p] of this.people) {
      if (live.has(id) && !this.gone.has(id)) continue;
      // On its way to the taxi: its desk goes, the robot stays until it gets in.
      if (p.leaving) { p.deskNode?.detach(); p.deskNode = null; continue; }
      p.group.detach(); p.deskNode?.detach(); p.label?.remove(); p.moreLabel?.label?.remove(); p.talkHolder?.label?.remove();
      this.lift.riders.delete(p);
      this.people.delete(id);
    }
    // Once the server has them hidden too, forget the robots that left.
    // (With "show hidden sessions" on they stay in the list: let them walk back in after a while.)
    for (const [id, at] of this.gone) if (!live.has(id) || this.t - at > 20) this.gone.delete(id);
    // A department went away under the lift: it heads for the nearest real stop again.
    const L = this.lift;
    if (L.at && !this.isLevel(L.at)) { L.at = null; L.door = 0; L.state = 'idle'; }
    if (L.target && !this.isLevel(L.target)) { L.target = null; if (L.state === 'moving') L.state = 'idle'; }

    const liveInterns = new Set();
    for (const f of this.floors.values()) for (const d of f.desks) {
      (d.session.interns || []).forEach((it, i) => { liveInterns.add(it.id); this.placeIntern(it, d, i, f); });
    }
    for (const [id, it] of this.interns) if (!liveInterns.has(id)) { it.group.detach(); it.label?.remove(); this.interns.delete(id); }

    if (this.view.mode === 'floor' && !this.floors.has(this.view.key)) this.view = { mode: 'building', key: null };
    const key = `${W},${D},${N}`;
    if (key !== this.layoutKey) {
      const first = !this.layoutKey;
      const theme = this.layoutKey === 'theme';
      this.layoutKey = key;
      const cam = this.viewCamera();
      if (first) Object.assign(this.cam, cam, { target: [...cam.target] });
      else if (!theme && !this.userMoved) this.flyTo(cam, 0.8);
    }
    this.emitFloors();
  }

  /**
   * Branch zones on a git floor: a tinted rug under each branch's desks and a hanging sign with
   * the branch name. Rebuilt only when the zones change.
   */
  buildZones(f, spec) {
    const zones = [];
    if (spec.repo) {
      for (const g of spec.groups) {
        const desks = f.desks.filter((d) => d.branch === g.branch);
        if (!desks.length) continue;
        const xs = desks.map((d) => d.cx), zs = desks.map((d) => d.cz);
        zones.push({
          branch: g.branch,
          x0: Math.min(...xs) - 1.05, x1: Math.max(...xs) + 1.05,
          z0: Math.min(...zs) - 0.85, z1: Math.max(...zs) + 1.45,
          signZ: Math.min(...zs) - 0.9,
        });
      }
    }
    f.zones = zones;
    const sig = JSON.stringify(zones);
    if (sig === f.zoneSig) return;
    f.zoneSig = sig;
    f.zoneNode?.detach();
    (f.zoneTex || []).forEach((t) => this.r.deleteTexture(t));
    f.zoneTex = [];
    f.zoneMats = new Map();
    if (!zones.length) { f.zoneNode = null; return; }
    const g = new Node();
    const C = this.css;
    for (const z of zones) {
      const hue = hash(z.branch) % 360;
      const rugBase = lin(`hsl(${hue}, 45%, ${this.dark ? '32%' : '76%'})`);
      const rug = { color: rugBase, noShadow: true, base: rugBase };
      f.zoneMats.set(z.branch, rug);
      g.add(this.box(rug, (z.x0 + z.x1) / 2, 0.02, (z.z0 + z.z1) / 2, z.x1 - z.x0, 0.006, z.z1 - z.z0));
      // hanging sign behind the zone's first desk row (behind the monitors, so it never hides a robot)
      const tex = this.r.texture(signCanvas(z.branch, `hsl(${hue}, 60%, 48%)`, C.sign, C.signText));
      f.zoneTex.push(tex);
      const sw = Math.min(2.6, z.x1 - z.x0 - 0.2), sh = sw / 4, sy = 2.45;
      const sx = (z.x0 + z.x1) / 2;
      g.add(new Node(this.r.meshes.plane, { color: [1, 1, 1], tex, emissive: [0.04, 0.04, 0.04], noShadow: true }).at(sx, sy, z.signZ).size(sw, sh, 1));
      g.add(this.box(this.mats.mullion, sx, sy, z.signZ - 0.015, sw + 0.06, sh + 0.06, 0.02));
      const cable = WALL_H - (sy + sh / 2);
      for (const dx of [-sw * 0.4, sw * 0.4]) g.add(this.cyl(this.mats.mullion, sx + dx, sy + sh / 2 + cable / 2, z.signZ - 0.015, 0.008, cable));
    }
    f.zoneNode = g;
    f.node.add(g);
  }

  /** Fly to one branch's zone on a floor; robots on other branches fade back. */
  showBranch(key, branch) {
    if (!this.floors.has(key)) return;
    this.view = branch ? { mode: 'floor', key, branch } : { mode: 'floor', key };
    this.flyTo(this.viewCamera());
    this.emitFloors();
  }

  /** True when a branch is in focus on this floor and the session is on another one. */
  dimmed(session, floor) {
    const v = this.view;
    return !!(v.branch && v.mode === 'floor' && floor && floor.key === v.key && (session.branch || 'detached') !== v.branch);
  }

  emitFloors() {
    const list = this.floorOrder.filter((k) => this.floors.has(k)).map((k) => this.floorInfo(this.floors.get(k)));
    const json = JSON.stringify([list, this.view]);
    if (json === this.lastFloorsJson) return;
    this.lastFloorsJson = json;
    this.onFloors(list.slice().reverse(), { ...this.view });
  }

  floorInfo(f) {
    const ss = f.spec.sessions;
    const internsNeed = ss.reduce((n, s) => n + (s.interns || []).filter((i) => i.status === 'needs_you').length, 0);
    return {
      key: f.key, name: f.name, number: f.index + 1, sessions: ss.length,
      working: ss.filter((s) => s.status === 'working').length,
      needs: ss.filter((s) => s.status === 'needs_you').length + internsNeed,
      yourTurn: ss.filter((s) => s.status === 'your_turn').length,
      idle: ss.filter((s) => s.status === 'idle').length,
      interns: ss.reduce((n, s) => n + (s.interns || []).filter((i) => i.status === 'working').length, 0),
      repo: !!f.spec.repo,
      branches: f.spec.repo ? f.spec.groups.map((g) => ({
        name: g.branch,
        robots: g.sessions.length,
        working: g.sessions.filter((s) => s.status === 'working').length,
        needs: g.sessions.filter((s) => s.status === 'needs_you').length,
      })) : [],
    };
  }

  viewCamera() {
    const { W, D, N } = this.dims;
    const aspect = this.w / Math.max(1, this.h);
    const adj = aspect < 1 ? (1 / aspect) * 0.9 : 1;
    const tf = Math.tan(this.cam.fov / 2);
    if (this.view.mode === 'floor' && this.floors.has(this.view.key)) {
      const f = this.floors.get(this.view.key);
      const z = this.view.branch ? f.zones?.find((x) => x.branch === this.view.branch) : null;
      if (z) {
        const zr = Math.max(3.2, Math.hypot(z.x1 - z.x0, z.z1 - z.z0) / 2 + 1.2);
        return { target: [(z.x0 + z.x1) / 2, f.oy + 0.9, (z.z0 + z.z1) / 2], dist: clamp((zr / tf) * 1.3 * adj, 6, 60), pitch: 0.74, yaw: Math.PI / 4 };
      }
      const r = Math.hypot(W, D) / 2;
      return { target: [W / 2, f.oy + 0.9, D / 2], dist: clamp((r / tf) * 1.12 * adj, 8, 120), pitch: 0.72, yaw: Math.PI / 4 };
    }
    const H = (N + 1) * FLOOR_H + 2;
    const r = Math.hypot(W, D, H) / 2 + 2;
    return { target: [W / 2, H * 0.55, D / 2], dist: clamp((r / tf) * 1.55 * adj, 24, 220), pitch: 0.17, yaw: Math.PI / 4 + 0.1 };
  }

  flyTo(to, dur = 1.1) {
    this.userMoved = false;
    this.camAnim = { from: { target: [...this.cam.target], dist: this.cam.dist, pitch: this.cam.pitch, yaw: this.cam.yaw }, to, t: 0, dur };
  }

  // ---------- builders ----------
  box(mat, x, y, z, w, h, d) { return new Node(this.r.meshes.box, mat).at(x, y, z).size(w, h, d); }
  cyl(mat, x, y, z, r, h) { return new Node(this.r.meshes.cyl, mat).at(x, y, z).size(r, h, r); }
  ball(mat, x, y, z, rx, ry = rx, rz = rx) { return new Node(this.r.meshes.sphere, mat).at(x, y, z).size(rx, ry, rz); }

  /**
   * One storey of the glass lift shaft, outside the x = W wall: corner posts, glass on three
   * sides, a slab edge, the landing wall with its sliding doors and a lamp over them.
   * Local y runs from y0 to y1. Returns the two door panels.
   */
  addShaft(g, W, y0, y1) {
    const M = this.mats;
    const x0 = W, x1 = W + LIFT_W, z0 = LIFT_Z - LIFT_L / 2, z1 = LIFT_Z + LIFT_L / 2;
    const h = y1 - y0, yc = (y0 + y1) / 2;
    for (const [x, z] of [[x1, z0], [x1, z1], [x0 + 0.05, z0], [x0 + 0.05, z1]]) g.add(this.box(M.liftFrame, x, yc, z, 0.1, h, 0.1));
    g.add(this.box(M.liftGlass, x1, yc, LIFT_Z, 0.03, h, LIFT_L - 0.1));
    for (const z of [z0, z1]) g.add(this.box(M.liftGlass, (x0 + x1) / 2, yc, z, LIFT_W - 0.1, h, 0.03));
    // slab edge at this storey's floor level
    g.add(this.box(M.liftFrame, x1, -0.06, LIFT_Z, 0.14, 0.12, LIFT_L + 0.1));
    for (const z of [z0, z1]) g.add(this.box(M.liftFrame, (x0 + x1) / 2, -0.06, z, LIFT_W, 0.12, 0.14));
    // landing wall: a lintel over the doors and a strip either side of them
    const doorH = 2.4;
    g.add(this.box(M.facade, x0 + 0.06, (doorH + y1) / 2, LIFT_Z, 0.08, y1 - doorH, LIFT_L - 0.1));
    const side = (LIFT_L / 2 - LIFT_DOOR) - 0.05;
    for (const s of [-1, 1]) g.add(this.box(M.facade, x0 + 0.06, doorH / 2, LIFT_Z + s * (LIFT_DOOR + side / 2), 0.08, doorH, side));
    g.add(this.box(M.liftLamp, x0 - 0.0, doorH + 0.16, LIFT_Z, 0.02, 0.06, 0.34));
    const doors = [-1, 1].map((s) => this.box(M.liftDoor, x0 + 0.13, doorH / 2, LIFT_Z + s * LIFT_DOOR / 2, 0.04, doorH - 0.02, LIFT_DOOR));
    g.add(...doors);
    return doors;
  }

  cabX(W = this.dims.W) { return W + LIFT_W / 2 + 0.06; }

  /** The lift car: glass on all sides so you can see who rides, a floor, a roof and a light. */
  buildCab(W) {
    const M = this.mats;
    const g = new Node();
    const cx = this.cabX(W), w = LIFT_W - 0.4, l = LIFT_L - 0.28, h = 2.5;
    g.add(this.box(M.cabFloor, cx, 0.03, LIFT_Z, w, 0.06, l));
    g.add(this.box(M.liftFrame, cx, h, LIFT_Z, w, 0.08, l));
    g.add(this.box(M.cabLight, cx, h - 0.05, LIFT_Z, w * 0.6, 0.02, l * 0.5));
    for (const [dx, dz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) g.add(this.box(M.liftFrame, cx + dx * w / 2, h / 2, LIFT_Z + dz * l / 2, 0.06, h, 0.06));
    g.add(this.box(M.liftGlass, cx + w / 2, h / 2, LIFT_Z, 0.02, h, l));
    for (const s of [-1, 1]) g.add(this.box(M.liftGlass, cx, h / 2, LIFT_Z + s * l / 2, w, h, 0.02));
    g.add(this.box(M.liftFrame, cx + w / 2 - 0.05, 0.95, LIFT_Z, 0.04, 0.04, l - 0.1));
    return g;
  }

  // ---------- the taxi ----------
  /** Where taxis stop: the kerb lane in front of the entrance. Cars face +x, so a taxi heading -x has its left side to the kerb. */
  taxiRank(W = this.dims.W, D = this.dims.D) { return { x: W / 2 + 0.5, z: D + 5.35, lane: D + 6.5 }; }

  /** A yellow cab with a roof sign, built facing +x like the city's cars. */
  buildTaxi() {
    const g = new Node();
    const paint = { color: lin('#f2c230'), spec: 0.8, shine: 80 };
    const glass = { color: lin(this.dark ? '#1b2330' : '#2d3a48'), spec: 1, shine: 90 };
    const black = { color: [0.03, 0.03, 0.03] };
    g.add(this.box(paint, 0, 0.42, 0, 2.3, 0.5, 1.04));
    g.add(this.box(glass, -0.1, 0.83, 0, 1.25, 0.36, 0.94));
    g.add(this.box(paint, -0.1, 1.03, 0, 1.15, 0.06, 0.92));
    for (const s of [-1, 1]) g.add(this.box(black, 0, 0.5, s * 0.522, 2.0, 0.07, 0.01));
    const sign = this.dark ? { color: [3, 2.5, 1.1], unlit: true, noShadow: true } : { color: lin('#fff3c4'), emissive: [0.25, 0.22, 0.12] };
    g.add(this.box(sign, -0.1, 1.15, 0, 0.24, 0.16, 0.5));
    for (const [wx, wz] of [[-0.72, 0.5], [0.72, 0.5], [-0.72, -0.5], [0.72, -0.5]]) g.add(this.cyl(black, wx, 0.2, wz, 0.2, 0.16).turn(Math.PI / 2, 0, 0));
    const head = this.dark ? { color: [3, 2.8, 2], unlit: true } : { color: [0.92, 0.92, 0.88] };
    for (const s of [-1, 1]) {
      g.add(this.box(head, 1.155, 0.48, s * 0.32, 0.02, 0.1, 0.18));
      g.add(this.box({ color: [0.7, 0.05, 0.04], unlit: this.dark }, -1.155, 0.5, s * 0.32, 0.02, 0.08, 0.16));
    }
    return g;
  }

  /**
   * One taxi at a time: it is called when a robot waits at the rank, drives up the kerb lane,
   * pulls in, waits while the robots get in, and drives off down the street.
   */
  updateTaxi(dt) {
    const people = [...this.people.values()];
    const waiting = people.filter((p) => p.trip?.stage === 'taxiWait');
    const boarding = people.filter((p) => p.trip?.stage === 'taxiBoard');
    const rank = this.taxiRank();
    let T = this.taxi;
    if (!T) {
      if (!waiting.length) return;
      T = this.taxi = {
        node: this.buildTaxi(), state: 'arrive', pos: { x: rank.x + 75, z: rank.lane }, yaw: Math.PI, age: 0, timer: 0,
        path: [{ x: rank.x + 8, z: rank.lane }, { x: rank.x + 3, z: rank.z }, { x: rank.x, z: rank.z }],
      };
      this.world.add(T.node);
    }
    T.age += dt;
    if (T.state === 'arrive' || T.state === 'leave') {
      let left = 0, prev = T.pos;
      for (const q of T.path) { left += Math.hypot(q.x - prev.x, q.z - prev.z); prev = q; }
      const v = T.state === 'arrive' ? Math.min(11, 0.8 + left * 0.9) : Math.min(11, 0.8 + T.timer * 4);
      if (T.state === 'leave') T.timer += dt;
      let step = v * dt;
      while (step > 0 && T.path.length) {
        const q = T.path[0], dx = q.x - T.pos.x, dz = q.z - T.pos.z, d = Math.hypot(dx, dz);
        if (d > 1e-4) T.want = Math.atan2(-dz, dx);
        if (d <= step) { T.pos = { ...q }; T.path.shift(); step -= d; } else { T.pos.x += (dx / d) * step; T.pos.z += (dz / d) * step; step = 0; }
      }
      if (T.want != null) T.yaw = angleLerp(T.yaw, T.want, Math.min(1, dt * 5));
      if (!T.path.length) {
        if (T.state === 'arrive') { T.state = 'stopped'; T.timer = 0; T.want = Math.PI; }
        else { T.node.detach(); this.taxi = null; return; }
      }
    } else if (T.state === 'stopped') {
      T.timer += dt;
      T.yaw = angleLerp(T.yaw, Math.PI, Math.min(1, dt * 5));
      // Everyone at the rank gets in through the kerb-side door.
      for (const p of waiting) {
        p.trip.stage = 'taxiBoard';
        p.path = [{ x: rank.x + 0.25, z: rank.z - 1.2 }];
        p.phase = 'walking';
      }
      if (!waiting.length && !boarding.length && T.timer > 1.4) {
        T.state = 'leave'; T.timer = 0;
        T.path = [{ x: rank.x - 4, z: rank.lane }, { x: rank.x - 80, z: rank.lane }];
      }
    }
    T.node.pos = [T.pos.x, -0.26, T.pos.z];
    T.node.rot = [0, T.yaw, 0];
  }

  /** From anywhere in the lobby out through the front door to a spot at the kerb. */
  taxiRoute(from, to) {
    const { W, D } = this.dims;
    const door = W / 2 + 0.3, inside = D - 1.9, outside = D + 1.4;
    const pts = [];
    if (from.z < D) pts.push({ x: from.x, z: inside }, { x: door, z: inside });
    pts.push({ x: door, z: outside }, { x: to.x, z: outside }, { x: to.x, z: to.z });
    return pts;
  }

  /** Back walls (x=0, z=0) with windows; glass + mullions on the street sides (x=W, z=D). */
  addEnvelope(g, W, D, { doorAt = null } = {}) {
    const M = this.mats;
    g.add(this.box(M.facade, -T / 2, WALL_H / 2, D / 2 - T / 2, T, WALL_H, D + T));
    g.add(this.box(M.facadeDark, W / 2 - T / 2, WALL_H / 2, -T / 2, W + T, WALL_H, T));
    // each window: a lit pane on the outside, a view of the sky on the inside
    for (let x = 3.4; x < W - 1.4; x += 2.6) g.add(this.box(M.window, x, 1.75, -T - 0.006, 1.7, 1.5, 0.012), this.box(M.windowIn, x, 1.75, 0.006, 1.7, 1.5, 0.012), this.box(M.mullion, x, 1.0, 0.03, 1.8, 0.05, 0.06));
    for (let z = 3.0; z < D - 1.0; z += 2.6) g.add(this.box(M.window, -T - 0.006, 1.75, z, 0.012, 1.5, 1.7), this.box(M.windowIn, 0.006, 1.75, z, 0.012, 1.5, 1.7), this.box(M.mullion, 0.03, 1.0, z, 0.06, 0.05, 1.8));
    for (const [x, z] of [[W, 0], [W, D], [0, D]]) g.add(this.box(M.facade, x, WALL_H / 2, z, 0.32, WALL_H, 0.32));
    const glass = [];
    // The x = W glass has an opening onto the lift landing.
    const ga = LIFT_Z - LIFT_DOOR, gb = LIFT_Z + LIFT_DOOR;
    glass.push(this.box(M.glass, W, WALL_H / 2, (0.15 + ga) / 2, 0.04, WALL_H, ga - 0.15));
    glass.push(this.box(M.glass, W, WALL_H / 2, (gb + D - 0.15) / 2, 0.04, WALL_H, D - 0.15 - gb));
    glass.push(this.box(M.glass, W, (WALL_H + 2.4) / 2, LIFT_Z, 0.04, WALL_H - 2.4, gb - ga));
    for (let z = 2.2; z < D - 0.3; z += 2.2) if (z < ga - 0.1 || z > gb + 0.1) glass.push(this.box(M.mullion, W, WALL_H / 2, z, 0.07, WALL_H, 0.07));
    for (const z of [ga, gb]) glass.push(this.box(M.mullion, W, WALL_H / 2, z, 0.08, WALL_H, 0.08));
    glass.push(this.box(M.mullion, W, 1.0, (0 + ga) / 2, 0.06, 0.05, ga));
    glass.push(this.box(M.mullion, W, 1.0, (gb + D) / 2, 0.06, 0.05, D - gb));
    glass.push(this.box(M.mullion, W, 2.4, LIFT_Z, 0.08, 0.08, gb - ga));
    if (doorAt == null) {
      glass.push(this.box(M.glass, W / 2, WALL_H / 2, D, W - 0.3, WALL_H, 0.04));
      glass.push(this.box(M.mullion, W / 2, 1.0, D, W, 0.05, 0.06));
    } else {
      const dw = 2.2, left = doorAt - dw / 2, right = doorAt + dw / 2;
      const doorGlass = { ...M.glass, alpha: M.glass.alpha + 0.12 };
      glass.push(this.box(M.glass, left / 2, WALL_H / 2, D, left, WALL_H, 0.04));
      glass.push(this.box(M.glass, (right + W) / 2, WALL_H / 2, D, W - right, WALL_H, 0.04));
      glass.push(this.box(M.glass, doorAt, (WALL_H + 2.4) / 2, D, dw, WALL_H - 2.4, 0.04));
      glass.push(this.box(M.mullion, left, WALL_H / 2, D, 0.1, WALL_H, 0.1), this.box(M.mullion, right, WALL_H / 2, D, 0.1, WALL_H, 0.1));
      glass.push(this.box(M.mullion, doorAt, 2.4, D, dw, 0.1, 0.1));
      // Sliding doors (with their handles): they open when a robot walks up to them.
      const leaves = [
        { node: this.box(doorGlass, doorAt - 0.53, 1.2, D + 0.02, 1.02, 2.38, 0.03), x: doorAt - 0.53, dir: -1 },
        { node: this.box(doorGlass, doorAt + 0.53, 1.2, D + 0.02, 1.02, 2.38, 0.03), x: doorAt + 0.53, dir: 1 },
        { node: this.box(M.mullion, doorAt - 0.12, 1.1, D + 0.06, 0.03, 0.5, 0.03), x: doorAt - 0.12, dir: -1 },
        { node: this.box(M.mullion, doorAt + 0.12, 1.1, D + 0.06, 0.03, 0.5, 0.03), x: doorAt + 0.12, dir: 1 },
      ];
      glass.push(...leaves.map((l) => l.node));
      this.entrance = leaves;
    }
    for (let x = 2.2; x < W - 0.3; x += 2.2) if (doorAt == null || Math.abs(x - doorAt) > 1.2) glass.push(this.box(M.mullion, x, WALL_H / 2, D, 0.07, WALL_H, 0.07));
    g.add(...glass);
    return glass;
  }

  buildFloorShell(spec, W, D) {
    const M = this.mats, C = this.css;
    const g = new Node();
    const hue = hash(spec.key) % 360;
    const carpet = lin(`hsl(${hue}, ${C.carpetS}, ${C.carpetL})`);
    g.add(this.box(M.concrete, W / 2, -SLAB / 2, D / 2, W + 0.24, SLAB, D + 0.24));
    g.add(this.box({ color: carpet }, W / 2, 0.006, D / 2, W - 0.1, 0.012, D - 0.1));
    g.add(this.box({ color: mix3(carpet, [1, 1, 1], 0.12), noShadow: true }, W / 2 + 0.6, 0.014, D / 2 + 0.3, W - 2.8, 0.005, D - 2.2));
    const glass = this.addEnvelope(g, W, D);
    const signTex = this.r.texture(signCanvas(spec.name || 'project', `hsl(${hue}, 55%, 50%)`, C.sign, C.signText));
    const sw = 2.8;
    g.add(new Node(this.r.meshes.plane, { color: [1, 1, 1], tex: signTex, emissive: [0.03, 0.03, 0.03], noShadow: true }).at(0.4 + sw / 2, 2.75, 0.012).size(sw, sw / 4, 1));
    const mx = 0.4, mz = 1.35;
    g.add(this.box(M.deskSide, mx, 0.42, mz, 0.62, 0.84, 1.3));
    g.add(this.box(M.deskTop, mx, 0.86, mz, 0.68, 0.04, 1.36));
    g.add(this.box(M.machine, mx - 0.02, 1.13, mz - 0.25, 0.42, 0.5, 0.44));
    g.add(this.box(M.machineDark, mx + 0.2, 1.12, mz - 0.25, 0.02, 0.22, 0.26));
    g.add(this.box(M.led, mx + 0.21, 1.3, mz - 0.33, 0.01, 0.03, 0.03));
    g.add(this.cyl(M.cup, mx + 0.08, 0.93, mz + 0.25, 0.05, 0.1), this.cyl(M.cup, mx + 0.08, 0.93, mz + 0.4, 0.05, 0.1));
    this.addPlant(g, W - 0.75, D - 0.75);
    const steam = [0, 1, 2].map(() => this.ball(M.steam, mx, 1.45, mz - 0.2, 0.05));
    g.add(...steam);
    const liftDoors = this.addShaft(g, W, -SLAB, WALL_H);
    return { node: g, glass, steam, machine: { x: mx, z: mz }, liftDoors };
  }

  addPlant(g, px, pz, s = 1) {
    const M = this.mats;
    g.add(this.cyl(M.pot, px, 0.2 * s, pz, 0.2 * s, 0.4 * s));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      g.add(this.ball(i % 2 ? M.plant : M.plantDark, px + Math.cos(a) * 0.14 * s, (0.62 + (i % 3) * 0.08) * s, pz + Math.sin(a) * 0.14 * s, 0.12 * s, 0.3 * s, 0.12 * s).turn(Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4));
    }
    g.add(this.ball(M.plant, px, 0.85 * s, pz, 0.14 * s, 0.24 * s, 0.14 * s));
  }

  buildLobby(W, D) {
    const M = this.mats;
    const g = new Node();
    g.add(this.box(M.concrete, W / 2, -0.15, D / 2, W + 0.24, 0.3, D + 0.24));
    g.add(this.box(M.marble, W / 2, 0.006, D / 2, W - 0.1, 0.012, D - 0.1));
    const door = W / 2;
    this.addEnvelope(g, W, D, { doorAt: door });
    g.add(this.box(M.deskSide, door, 0.55, D / 2 - 0.5, 3.2, 1.1, 0.8));
    g.add(this.box(M.deskTop, door, 1.12, D / 2 - 0.5, 3.3, 0.05, 0.9));
    g.add(this.box(M.monitor, door + 0.8, 1.38, D / 2 - 0.75, 0.6, 0.38, 0.04));
    // The logo banner carries the project's name; buildRoof() reuses this texture.
    this.r.deleteTexture(this.logoTex);
    this.logoTex = this.r.texture(logoCanvas(this.dark, this.project?.name));
    const logo = { color: [1, 1, 1], tex: this.logoTex, emissive: [0.05, 0.05, 0.05], noShadow: true };
    g.add(new Node(this.r.meshes.plane, logo).at(door, 2.35, 0.012).size(4.2, 4.2 * 192 / 1024, 1));
    this.addPlant(g, 1.0, D - 1.0, 1.4);
    this.addPlant(g, W - 1.0, D - 1.0, 1.4);
    g.add(this.box({ color: lin(this.css.accent) }, 2.2, 0.25, 2.4, 0.9, 0.5, 2.2), this.box({ color: scale3(lin(this.css.accent), 0.8) }, 1.85, 0.6, 2.4, 0.2, 0.6, 2.2));
    const rig = this.buildRig(lookFor('receptionist'));
    rig.root.at(door - 0.6, 0, D / 2 - 1.3);
    rig.hips.pos = [0, 0.53, 0];
    rig.legL.hip.rot[0] = rig.legR.hip.rot[0] = -Math.PI / 2;
    rig.legL.knee.rot[0] = rig.legR.knee.rot[0] = Math.PI / 2;
    this.receptionist = rig;
    g.add(rig.root);
    g.add(this.box(M.chairSeat, door - 0.6, 0.44, D / 2 - 1.3, 0.5, 0.07, 0.48));
    g.add(this.box(M.mullion, door, 2.75, D + 0.75, 3.6, 0.12, 1.5));
    // The project's name over the entrance: every building is one project.
    this.r.deleteTexture(this.nameTex);
    const name = this.project?.name || 'Agent Office';
    this.nameTex = this.r.texture(signCanvas(name, this.css.accent, this.css.sign, this.css.signText));
    g.add(new Node(this.r.meshes.plane, { color: [1, 1, 1], tex: this.nameTex, emissive: this.dark ? [0.02, 0.02, 0.02] : [0.05, 0.05, 0.05], texEmit: this.dark ? 0.6 : 0, noShadow: true }).at(door, 3.14, D + 0.07).size(3.0, 0.75, 1));
    g.add(this.box({ color: lin(this.dark ? '#22252b' : '#5b5348'), noShadow: true }, door, 0.02, D + 0.9, 2.4, 0.02, 1.4));
    this.lobbyDoors = this.addShaft(g, W, -0.3, WALL_H);
    return g;
  }

  buildRoof(W, D) {
    const M = this.mats;
    const g = new Node();
    g.add(this.box(M.concrete, W / 2, -SLAB / 2, D / 2, W + 0.3, SLAB + 0.06, D + 0.3));
    g.add(this.box(M.roofTop, W / 2, 0.02, D / 2, W, 0.04, D));
    const p = 0.7;
    g.add(this.box(M.facade, W / 2, p / 2, -0.05, W + 0.3, p, 0.2), this.box(M.facade, W / 2, p / 2, D + 0.05, W + 0.3, p, 0.2));
    g.add(this.box(M.facade, -0.05, p / 2, D / 2, 0.2, p, D + 0.3), this.box(M.facade, W + 0.05, p / 2, D / 2, 0.2, p, D + 0.3));
    for (const [x, z] of [[2.2, 2.2], [4.2, 2.2]]) {
      g.add(this.box(M.unit, x, 0.45, z, 1.5, 0.9, 1.2));
      g.add(this.cyl(M.mullion, x, 0.92, z, 0.42, 0.04));
    }
    g.add(this.box(M.unit, W - 2.2, 0.6, 2.0, 2.0, 1.2, 1.6));
    // the lift's machine room on top of the shaft
    g.add(this.box(M.facade, W + LIFT_W / 2, 0.75, LIFT_Z, LIFT_W + 0.12, 1.5, LIFT_L + 0.12));
    g.add(this.box(M.roofTop, W + LIFT_W / 2, 1.52, LIFT_Z, LIFT_W + 0.24, 0.06, LIFT_L + 0.24));
    g.add(this.box(M.liftFrame, W + LIFT_W + 0.07, 0.8, LIFT_Z, 0.02, 0.5, 0.8));
    g.add(this.cyl(M.pole, W - 1.4, 2.0, D - 1.6, 0.05, 4));
    g.add(this.ball({ color: lin(this.css.needs), unlit: true }, W - 1.4, 4.05, D - 1.6, 0.09));
    // At night the sign glows with its own colours (texEmit), so the letters light up and the dark board stays dark.
    const logo = { color: [1, 1, 1], tex: this.logoTex, emissive: this.dark ? [0.02, 0.02, 0.02] : [0.06, 0.06, 0.06], texEmit: this.dark ? 0.85 : 0, noShadow: true };
    const sw = Math.min(W - 2, 9);
    g.add(this.cyl(M.pole, W / 2 - sw * 0.35, 1.1, D - 0.6, 0.06, 1.6), this.cyl(M.pole, W / 2 + sw * 0.35, 1.1, D - 0.6, 0.06, 1.6));
    g.add(this.box(M.mullion, W / 2, 1.95 + sw * 0.09, D - 0.66, sw + 0.2, sw * 0.19 + 0.2, 0.08));
    g.add(new Node(this.r.meshes.plane, logo).at(W / 2, 1.95 + sw * 0.09, D - 0.61).size(sw, sw * 192 / 1024, 1));
    return g;
  }

  /**
   * The city: a street grid around Agent Office's block. Everything static is batched into a few
   * meshes (base, glowing bits, one per facade style), so thousands of objects cost ~8 draw calls.
   */
  buildCity(W, D) {
    const dark = this.dark;
    const rnd = rng(9001);
    const MB = () => new MeshBuilder(this.r);
    const base = MB(), glow = MB(), fac = Array.from({ length: FACADE_STYLES }, MB), foliage = MB();
    const c = lin;
    const P = {
      asphalt: c(dark ? '#191b1f' : '#4a4d54'),
      paving: c(dark ? '#3a3d44' : '#d3cec4'), paving2: c(dark ? '#43464e' : '#e2ddd3'),
      curb: c(dark ? '#555962' : '#a8a296'),
      paint: c(dark ? '#7f7e74' : '#f1eee4'), yellow: c(dark ? '#8a7a3a' : '#e8c24a'),
      roof: c(dark ? '#2b2e35' : '#a7a196'), roof2: c(dark ? '#30333a' : '#b8b1a5'),
      unit: c(dark ? '#555b66' : '#e0dbd1'), tower: c(dark ? '#4a4f58' : '#8a8378'),
      shopDark: c(dark ? '#141820' : '#2a3540'), shopLit: dark ? [0.62, 0.42, 0.2] : c('#3a4a58'),
      pole: c(dark ? '#4e535d' : '#3d4149'),
      trunk: c('#6b4a30'), leaf: c(dark ? '#2b5534' : '#5c9c4e'), leaf2: c(dark ? '#244c2c' : '#4b8a41'), leaf3: c(dark ? '#335f30' : '#6faa52'),
      soil: c(dark ? '#2a221c' : '#6b5643'), planter: c(dark ? '#4a4e57' : '#bdb7ab'),
      water: dark ? [0.25, 0.5, 0.9] : c('#7fc0e0'), bench: c(dark ? '#5a4632' : '#8a6a48'),
      lampHead: dark ? [3.2, 2.5, 1.3] : c('#efebe2'),
      grass: c(dark ? '#21402a' : '#7fb565'),
    };
    const AWN = ['#c94c3c', '#2f6f8f', '#3f8a5a', '#d8a033', '#6b4fa0', '#2a2d33', '#e07a5f'].map(c);
    const SIGN = ['#e94f37', '#1f7a8c', '#f2a541', '#3b8ea5', '#c2549d', '#2e2e2e', '#ffffff'].map(c);
    const CARS = ['#d8473d', '#3a78c2', '#f2f0ea', '#2b2d33', '#e0a458', '#4c9a6a', '#9aa3ad', '#7b2d3b', '#f2f0ea', '#1f2a44'].map(c);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const lamps = [];

    const RW = 9, SW = 2.6, NB = 4;
    const bx0 = -7.5, bz0 = -7.5, BX = W + 11.5, BZ = D + 11.5, PX = BX + RW, PZ = BZ + RW;
    const roadX = (i) => bx0 + i * PX - RW / 2;   // centre of the road along z, west of block column i
    const roadZ = (j) => bz0 + j * PZ - RW / 2;   // centre of the road along x, north of block row j
    const ext = (NB + 1) * Math.max(PX, PZ);

    // asphalt everywhere; blocks sit on top as raised pavements
    base.box(P.asphalt, W / 2, -0.4, D / 2, ext * 2 + 400, 0.28, ext * 2 + 400);
    // lane markings
    for (let k = -NB; k <= NB + 1; k++) {
      for (let b = -NB - 1; b <= NB; b++) {
        for (let t = 1.5; t < BX - 1; t += 4.5) base.box(P.paint, bx0 + b * PX + t + 1, -0.255, roadZ(k), 2.2, 0.012, 0.16);
        for (let t = 1.5; t < BZ - 1; t += 4.5) base.box(P.paint, roadX(k), -0.255, bz0 + b * PZ + t + 1, 0.16, 0.012, 2.2);
      }
    }
    // crosswalks + traffic lights around our block
    const crosswalk = (x, z, alongX) => {
      for (let t = -RW / 2 + 0.8; t < RW / 2 - 0.5; t += 1.1) {
        if (alongX) base.box(P.paint, x, -0.254, z + t, 2.6, 0.012, 0.55); else base.box(P.paint, x + t, -0.254, z, 0.55, 0.012, 2.6);
      }
    };
    for (const i of [0, 1]) for (const j of [0, 1]) {
      const ix = roadX(i), iz = roadZ(j);
      crosswalk(ix + RW / 2 + 1.8, iz, true); crosswalk(ix - RW / 2 - 1.8, iz, true);
      crosswalk(ix, iz + RW / 2 + 1.8, false); crosswalk(ix, iz - RW / 2 - 1.8, false);
      // traffic light on the corner of our block
      const cx = i ? bx0 + BX - 0.6 : bx0 + 0.6, cz = j ? bz0 + BZ - 0.6 : bz0 + 0.6;
      base.cyl(P.pole, cx, 1.7, cz, 0.07, 3.4);
      base.box(P.pole, cx, 3.55, cz, 0.32, 0.95, 0.32);
      const green = (i + j) % 2 === 0;
      glow.ball(green ? [0.3, 0.2, 0.2] : [3, 0.35, 0.25], cx + 0.17, 3.85, cz + 0.17, 0.09);
      glow.ball([0.35, 0.3, 0.1], cx + 0.17, 3.55, cz + 0.17, 0.09);
      glow.ball(green ? [0.4, 3, 1.1] : [0.15, 0.3, 0.2], cx + 0.17, 3.25, cz + 0.17, 0.09);
    }

    const tree = (x, z, s = 1, planter = true) => {
      if (planter) { base.box(P.planter, x, 0.04, z, 1.3 * s, 0.1, 1.3 * s); base.box(P.soil, x, 0.06, z, 1.05 * s, 0.1, 1.05 * s); }
      base.cyl(P.trunk, x, 0.9 * s, z, 0.11 * s, 1.8 * s);
      foliage.ball(pick([P.leaf, P.leaf2, P.leaf3]), x, 2.3 * s, z, 1.0 * s, 0.9 * s, 1.0 * s, false);
      foliage.ball(pick([P.leaf, P.leaf2, P.leaf3]), x + 0.35 * s, 2.85 * s, z - 0.2 * s, 0.65 * s, 0.6 * s, 0.65 * s, false);
      foliage.ball(pick([P.leaf, P.leaf2]), x - 0.4 * s, 2.6 * s, z + 0.25 * s, 0.55 * s, 0.5 * s, 0.55 * s, false);
    };
    const lamp = (x, z, dx, dz) => {
      base.cyl(P.pole, x, 2.1, z, 0.07, 4.2);
      const rot = Math.atan2(dx, dz);
      base.box(P.pole, x + dx * 0.55, 4.15, z + dz * 0.55, 0.06, 0.06, 1.1, [0, rot, 0]);
      (dark ? glow : base).box(P.lampHead, x + dx * 1.1, 4.08, z + dz * 1.1, 0.45, 0.1, 0.28, [0, rot, 0]);
      lamps.push([x + dx * 1.1, 3.95, z + dz * 1.1]);
    };
    const car = (b, x, z, rotY, color, y = -0.26) => {
      const cs = Math.cos(rotY), sn = Math.sin(rotY);
      const at = (lx, ly, lz) => [x + lx * cs + lz * sn, y + ly, z - lx * sn + lz * cs];
      const part = (kind, l, size, col, rx = 0) => b.add(kind, at(...l), [rx, rotY, 0], size, col);
      part('box', [0, 0.42, 0], [2.2, 0.5, 1.0], color);
      part('box', [-0.1, 0.82, 0], [1.2, 0.36, 0.92], c(dark ? '#1b2330' : '#2d3a48'));
      part('box', [-0.1, 1.02, 0], [1.1, 0.06, 0.9], color);
      for (const [wx, wz] of [[-0.7, 0.5], [0.7, 0.5], [-0.7, -0.5], [0.7, -0.5]]) part('lowCyl', [wx, 0.2, wz], [0.2, 0.16, 0.2], [0.03, 0.03, 0.03], Math.PI / 2);
      part('box', [1.1, 0.48, 0.32], [0.03, 0.1, 0.18], dark ? [1, 0.95, 0.75] : [0.92, 0.92, 0.88]);
      part('box', [1.1, 0.48, -0.32], [0.03, 0.1, 0.18], dark ? [1, 0.95, 0.75] : [0.92, 0.92, 0.88]);
      part('box', [-1.1, 0.5, 0.32], [0.03, 0.08, 0.16], [0.6, 0.05, 0.04]);
      part('box', [-1.1, 0.5, -0.32], [0.03, 0.08, 0.16], [0.6, 0.05, 0.04]);
    };
    const roofTop = (cx, cz, w, d, h) => {
      base.box(P.roof, cx, h + 0.18, cz, w + 0.3, 0.36, d + 0.3);
      base.box(P.roof2, cx, h + 0.37, cz, w - 0.5, 0.03, d - 0.5);
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) base.box(P.unit, cx + (rnd() - 0.5) * Math.max(0, w - 3), h + 0.82, cz + (rnd() - 0.5) * Math.max(0, d - 3), 1.4 + rnd(), 0.9, 1.0 + rnd() * 0.6);
      if (rnd() < 0.22 && w > 6) {
        const tx = cx + (rnd() - 0.5) * (w - 4), tz = cz + (rnd() - 0.5) * (d - 4);
        for (const [lx, lz] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) base.box(P.tower, tx + lx, h + 1.2, tz + lz, 0.1, 1.7, 0.1);
        base.cyl(P.tower, tx, h + 2.9, tz, 1.05, 1.8, [0, 0, 0], false);
        base.ball(P.tower, tx, h + 3.8, tz, 1.05, 0.45, 1.05, false);
      }
      if (h > 24 && rnd() < 0.6) {
        base.cyl(P.pole, cx + w * 0.2, h + 2.4, cz - d * 0.2, 0.06, 4.4);
        glow.ball([3, 0.25, 0.2], cx + w * 0.2, h + 4.65, cz - d * 0.2, 0.12);
      }
    };
    const building = (x0, z0, x1, z1, h, style) => {
      const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const tv = 0.86 + rnd() * 0.22;
      const tint = [tv, tv * (0.97 + rnd() * 0.04), tv * (0.94 + rnd() * 0.08)];
      const shopH = 3.4;
      if (h > 18 && rnd() < 0.45) {
        const ph = 6 + rnd() * 4;
        fac[style].box(tint, cx, shopH + (ph - shopH) / 2, cz, w, ph - shopH, d, [0, 0, 0], 'facade');
        base.box(P.roof, cx, ph + 0.12, cz, w + 0.2, 0.24, d + 0.2);
        const tw = w * (0.55 + rnd() * 0.2), td = d * (0.55 + rnd() * 0.2);
        const s2 = rnd() < 0.5 ? style : (style + 1 + Math.floor(rnd() * 4)) % FACADE_STYLES;
        fac[s2].box(tint, cx, ph + (h - ph) / 2, cz, tw, h - ph, td, [0, 0, 0], 'facade');
        roofTop(cx, cz, tw, td, h);
      } else {
        fac[style].box(tint, cx, shopH + (h - shopH) / 2, cz, w, h - shopH, d, [0, 0, 0], 'facade');
        roofTop(cx, cz, w, d, h);
      }
      // street level: recessed shop windows, corner piers, sign band, awnings
      const litShops = rnd() < 0.75;
      (dark && litShops ? glow : base).box(dark && litShops ? P.shopLit : P.shopDark, cx, shopH / 2, cz, w - 0.5, shopH, d - 0.5);
      for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) fac[style].box(tint, px + (px === x0 ? 0.25 : -0.25), shopH / 2, pz + (pz === z0 ? 0.25 : -0.25), 0.5, shopH, 0.5);
      base.box(pick(SIGN), cx, shopH - 0.3, cz, w + 0.04, 0.55, d + 0.04);
      for (const [nx, nz] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
        if (rnd() > 0.6) continue;
        const along = nz !== 0 ? w : d;
        const len = along * (0.4 + rnd() * 0.4);
        const ax = cx + nx * (w / 2 + 0.55), az = cz + nz * (d / 2 + 0.55);
        if (nz !== 0) base.box(pick(AWN), ax, shopH - 0.95, az, len, 0.06, 1.1, [nz * 0.32, 0, 0]);
        else base.box(pick(AWN), ax, shopH - 0.95, az, 1.1, 0.06, len, [0, 0, -nx * 0.32]);
      }
    };

    // ---------- blocks ----------
    for (let i = -NB; i <= NB; i++) for (let j = -NB; j <= NB; j++) {
      const ox = bx0 + i * PX, oz = bz0 + j * PZ;
      const near = Math.abs(i) <= 2 && Math.abs(j) <= 2;
      base.box(P.curb, ox + BX / 2, -0.135, oz + BZ / 2, BX, 0.27, BZ);
      base.box(P.paving, ox + BX / 2, -0.13, oz + BZ / 2, BX - 0.36, 0.26, BZ - 0.36);
      if (i === 0 && j === 0) {
        // Agent Office plaza
        base.box(P.paving2, W / 2, 0.004, D + 2.4, W + 2, 0.01, 3.6);
        for (const [x, z] of [[-4.2, -4.2], [W + 1.6, -4.2], [-4.2, D + 1.6], [-4.2, D / 2]]) tree(x, z, 1.05);
        for (const dx of [-3.2, 3.2]) { base.box(P.bench, W / 2 + dx, 0.42, D + 3.4, 1.8, 0.08, 0.5); base.box(P.pole, W / 2 + dx, 0.2, D + 3.4, 1.6, 0.4, 0.08); }
        // taxi rank at the kerb in front of the entrance: a yellow bay and a sign
        const rank = this.taxiRank(W, D);
        for (const dz of [-0.62, 0.62]) base.box(P.yellow, rank.x, -0.252, rank.z + dz, 5.6, 0.012, 0.1);
        for (const dx of [-2.8, 2.8]) base.box(P.yellow, rank.x + dx, -0.252, rank.z, 0.1, 0.012, 1.34);
        base.cyl(P.pole, rank.x + 2.4, 1.2, D + 3.85, 0.04, 2.4);
        base.box(P.yellow, rank.x + 2.4, 2.55, D + 3.85, 0.62, 0.32, 0.06);
        base.box(P.asphalt, rank.x + 2.4, 2.55, D + 3.885, 0.5, 0.12, 0.01);
        const flagCols = [c(this.css.accent), c('#3a78c2'), c('#4c9a6a')];
        flagCols.forEach((fc, k) => {
          const fx = W + 2.2, fz = D - 1 - k * 1.4;
          base.cyl(P.pole, fx, 3.5, fz, 0.05, 7);
          base.box(fc, fx, 6.3, fz + 0.65, 0.03, 0.9, 1.3);
        });
      } else if (i === 1 && j === 1) {
        // a paved square with a fountain, café umbrellas and trees: keeps the view to the building open
        const cx = ox + BX / 2, cz = oz + BZ / 2;
        base.box(P.paving2, cx, 0.004, cz, BX - 6, 0.01, BZ - 6);
        base.cyl(P.planter, cx, 0.3, cz, 3.2, 0.6, [0, 0, 0], false);
        glow.cyl(P.water, cx, 0.58, cz, 2.95, 0.04, [0, 0, 0], false);
        base.cyl(P.planter, cx, 1.0, cz, 0.35, 1.4);
        base.cyl(P.planter, cx, 1.75, cz, 1.0, 0.18, [0, 0, 0], false);
        glow.cyl(P.water, cx, 1.85, cz, 0.85, 0.04);
        for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; tree(cx + Math.cos(a) * 8.5, cz + Math.sin(a) * 7, 1.0); }
        for (let k = 0; k < 4; k++) {
          const ux = ox + 4 + k * 3.2, uz = oz + BZ - 4.5;
          base.cyl(P.pole, ux, 1.1, uz, 0.04, 2.2);
          base.ball(pick(AWN), ux, 2.25, uz, 1.25, 0.28, 1.25);
          base.cyl(P.bench, ux, 0.38, uz, 0.45, 0.05);
        }
        for (const [gx, gz] of [[ox + 3.5, oz + 3.5], [ox + BX - 3.5, oz + 3.5]]) base.box(P.grass, gx, 0.03, gz, 4, 0.06, 4);
      } else {
        const front = i >= 0 && j >= 0 && i <= 2 && j <= 2;
        const behind = i < 0 || j < 0;
        const x0 = ox + SW, z0 = oz + SW, x1 = ox + BX - SW, z1 = oz + BZ - SW;
        const sx = rnd() < 0.7 ? 2 : 1, sz = rnd() < 0.7 ? 2 : 1;
        const gap = 0.7;
        for (let a = 0; a < sx; a++) for (let b = 0; b < sz; b++) {
          const lx0 = x0 + ((x1 - x0) * a) / sx + (a ? gap / 2 : 0), lx1 = x0 + ((x1 - x0) * (a + 1)) / sx - (a < sx - 1 ? gap / 2 : 0);
          const lz0 = z0 + ((z1 - z0) * b) / sz + (b ? gap / 2 : 0), lz1 = z0 + ((z1 - z0) * (b + 1)) / sz - (b < sz - 1 ? gap / 2 : 0);
          let h;
          const dist = Math.hypot(i, j);
          if (front) h = (i + j <= 1 ? 4.2 : 5) + rnd() * (i + j <= 1 ? 3 : 6);
          else {
            // mid-rise close by so the sky stays visible; a skyline of towers further out
            h = 9 + rnd() * 9 + (behind && dist >= 2 ? rnd() * 10 : 0);
            if (behind && dist >= 3 && rnd() < 0.22) h = 34 + rnd() * 22;
          }
          building(lx0, lz0, lx1, lz1, h, Math.floor(rnd() * FACADE_STYLES));
        }
      }
      if (near) {
        // street trees and lamps along the pavement, parked cars at the kerb
        const edges = [
          { x0: ox, z0: oz + 1.0, x1: ox + BX, z1: oz + 1.0, dx: 0, dz: -1 },
          { x0: ox, z0: oz + BZ - 1.0, x1: ox + BX, z1: oz + BZ - 1.0, dx: 0, dz: 1 },
          { x0: ox + 1.0, z0: oz, x1: ox + 1.0, z1: oz + BZ, dx: -1, dz: 0 },
          { x0: ox + BX - 1.0, z0: oz, x1: ox + BX - 1.0, z1: oz + BZ, dx: 1, dz: 0 },
        ];
        for (const e of edges) {
          const len = Math.hypot(e.x1 - e.x0, e.z1 - e.z0);
          const ux = (e.x1 - e.x0) / len, uz = (e.z1 - e.z0) / len;
          for (let t = 3.5; t < len - 3; t += 8.5) {
            const x = e.x0 + ux * t, z = e.z0 + uz * t;
            const nearEntrance = i === 0 && j === 0 && e.dz === 1 && Math.abs(x - W / 2) < 4;
            if (!nearEntrance && (i !== 0 || j !== 0 || e.dz === 1 || e.dx === 1)) tree(x, z, 0.85 + rnd() * 0.3);
          }
          for (let t = 7.5; t < len - 3; t += 17) lamp(e.x0 + ux * t + e.dx * 0.1, e.z0 + uz * t + e.dz * 0.1, e.dx, e.dz);
          for (let t = 4; t < len - 3; t += 6.2) {
            if (rnd() > 0.45) continue;
            const x = e.x0 + ux * t + e.dx * 2.3, z = e.z0 + uz * t + e.dz * 2.3;
            const col = pick(CARS); // drawn even when skipped, so the rest of the city stays the same
            if (i === 0 && j === 0 && e.dz === 1 && Math.abs(x - W / 2) < 6.5) continue; // keep the taxi rank free
            car(base, x, z, Math.atan2(-uz, ux), col);
          }
        }
      }
    }

    // ---------- assemble static batches ----------
    const node = new Node();
    const meshes = [];
    const addBatch = (b, mat) => { if (b.empty) return; const m = b.build(); meshes.push(m); node.add(new Node(m, mat)); };
    addBatch(base, { color: [1, 1, 1], spec: 0.05, shine: 12 });
    addBatch(foliage, { color: [1, 1, 1], spec: 0.08, shine: 10 });
    addBatch(glow, { color: [1, 1, 1], unlit: true, noShadow: true });
    fac.forEach((b, k) => addBatch(b, { color: [1, 1, 1], tex: this.facadeTex[k], texEmit: dark ? 0.42 : 0, spec: k === 1 || k === 3 ? 0.9 : 0.12, shine: k === 1 || k === 3 ? 90 : 14 }));

    // ---------- moving cars ----------
    const cars = [];
    const lanes = [];
    for (const k of [-1, 0, 1, 2]) {
      lanes.push({ axis: 'x', lane: roadZ(k) + 2.0, dir: 1 }, { axis: 'x', lane: roadZ(k) - 2.0, dir: -1 });
      lanes.push({ axis: 'z', lane: roadX(k) - 2.0, dir: 1 }, { axis: 'z', lane: roadX(k) + 2.0, dir: -1 });
    }
    lanes.forEach((ln, k) => {
      for (let q = 0; q < 2; q++) {
        const b = MB();
        car(b, 0, 0, 0, pick(CARS), 0);
        const m = b.build(); meshes.push(m);
        const n = new Node(m, { color: [1, 1, 1], spec: 0.7, shine: 70 });
        node.add(n);
        cars.push({ node: n, axis: ln.axis, lane: ln.lane, speed: ln.dir * (5 + rnd() * 4), offset: rnd() * 400 + q * 180 });
      }
    });

    // ---------- clouds ----------
    const clouds = [];
    for (let i = 0; i < 16; i++) {
      const b = MB();
      const n = 4 + Math.floor(rnd() * 4);
      for (let k = 0; k < n; k++) b.ball([1, 1, 1], (k - n / 2) * 2.4 + rnd(), rnd() * 1.3, (rnd() - 0.5) * 2.6, 2.4 + rnd() * 1.8, 1.5 + rnd() * 0.9, 2.2 + rnd() * 1.2, false);
      const m = b.build(); meshes.push(m);
      const cn = new Node(m, this.mats.cloud).at(W / 2 + (rnd() - 0.5) * 260, 30 + rnd() * 22, D / 2 - 40 - rnd() * 120);
      node.add(cn);
      clouds.push({ node: cn, speed: 0.8 + rnd() * 0.8 });
    }
    return { node, cars, clouds, lamps, meshes, span: ext * 2 };
  }

  buildDesk(d) {
    const M = this.mats;
    const g = new Node();
    const { cx, cz } = d;
    const H = 0.74;
    g.add(this.box(M.deskTop, cx, H - 0.03, cz, 1.7, 0.06, 0.9));
    for (const [lx, lz] of [[-0.8, -0.4], [0.8, -0.4], [-0.8, 0.4], [0.8, 0.4]]) g.add(this.box(M.deskSide, cx + lx, (H - 0.06) / 2, cz + lz, 0.06, H - 0.06, 0.06));
    g.add(this.box(M.deskSide, cx, 0.45, cz - 0.42, 1.55, 0.5, 0.03));
    g.add(this.cyl(M.monitor, cx, H + 0.13, cz - 0.22, 0.03, 0.26));
    g.add(this.box(M.monitor, cx, H + 0.01, cz - 0.22, 0.32, 0.02, 0.2));
    g.add(this.box(M.monitor, cx, H + 0.47, cz - 0.24, 0.92, 0.54, 0.05));
    const screenMat = { color: [1, 1, 1], unlit: true, tex: this.codeTex, uvScale: [1, 0.32], uvOff: [0, (hash(d.session.id) % 100) / 100], noShadow: true };
    g.add(new Node(this.r.meshes.plane, screenMat).at(cx, H + 0.47, cz - 0.213).size(0.84, 0.46, 1));
    g.add(this.box(M.key, cx, H + 0.012, cz + 0.12, 0.6, 0.02, 0.18));
    g.add(this.box(M.key, cx + 0.45, H + 0.01, cz + 0.14, 0.08, 0.02, 0.12));
    const mug = new Node(); mug.add(this.cyl(M.cup, 0, 0.05, 0, 0.045, 0.1), this.cyl(M.coffee, 0, 0.1, 0, 0.038, 0.004));
    mug.at(cx - 0.62, H, cz + 0.05);
    g.add(mug);
    const chair = new Node();
    chair.add(this.box(M.chairSeat, 0, 0.44, 0, 0.5, 0.07, 0.48));
    chair.add(this.cyl(M.chair, 0, 0.24, 0, 0.03, 0.36));
    chair.add(this.box(M.chair, 0, 0.05, 0, 0.5, 0.04, 0.06), this.box(M.chair, 0, 0.05, 0, 0.06, 0.04, 0.5));
    chair.add(this.box(M.chair, 0, 0.74, 0.25, 0.46, 0.5, 0.06));
    chair.at(d.seat.x, 0, d.seat.z);
    g.add(chair);
    return { node: g, screenMat, mug };
  }

  // ---------- people ----------
  /** A robot with the same joint layout as before: hips → legs/knees, torso → arms/elbows, head. Faces +z. */
  buildRig(look, scale = 1, intern = false) {
    const R = this.r.meshes;
    const paint = { color: lin(look.paint) };
    const paintDark = { color: scale3(lin(look.paint), 0.62) };
    const metal = { color: lin(this.dark ? '#a7aeb9' : '#cdd3dc'), spec: 0.9, shine: 60 };
    const joint = { color: lin('#3a3f48'), spec: 0.6, shine: 40 };
    const visor = { color: lin('#0d1014'), spec: 1.0, shine: 90 };
    const eye = { color: [0.3, 0.95, 0.85], unlit: true, noShadow: true };
    const led = { color: [0.3, 0.95, 0.85], unlit: true, noShadow: true };
    paint.spec = 0.5; paint.shine = 40; paintDark.spec = 0.4; paintDark.shine = 30;
    const m = { paint, paintDark, metal, joint, visor, eye, led };
    const root = new Node();
    const body = new Node(); root.add(body);
    const hips = new Node(); body.add(hips);
    hips.add(this.box(joint, 0, 0, 0, 0.28, 0.12, 0.18));
    hips.add(this.cyl(metal, 0, 0.06, 0, 0.07, 0.08));
    const leg = (side) => {
      const p = new Node().at(side * 0.09, -0.04, 0);
      p.add(new Node(R.sphere, joint).size(0.065, 0.065, 0.065));
      p.add(new Node(R.cyl, metal).at(0, -0.13, 0).size(0.045, 0.24, 0.045));
      const knee = new Node().at(0, -0.26, 0);
      knee.add(new Node(R.sphere, joint).size(0.06, 0.06, 0.06));
      knee.add(new Node(R.cyl, paint).at(0, -0.12, 0).size(0.062, 0.2, 0.062));
      knee.add(this.box(paintDark, 0, -0.245, 0.035, 0.13, 0.07, 0.2));
      knee.add(this.box(joint, 0, -0.275, 0.035, 0.14, 0.02, 0.21));
      p.add(knee);
      return { hip: p, knee };
    };
    const L = leg(-1), Rr = leg(1);
    hips.add(L.hip, Rr.hip);
    const torso = new Node().at(0, 0.04, 0); hips.add(torso);
    torso.add(new Node(R.sphere, paint).at(0, 0.21, 0).size(0.2, 0.23, 0.16));
    torso.add(new Node(R.cyl, paintDark).at(0, 0.06, 0).size(0.15, 0.08, 0.15));
    torso.add(this.box(visor, 0, 0.22, 0.135, 0.17, 0.12, 0.04).turn(-0.12, 0, 0));
    const chestLed = this.box(led, 0, 0.19, 0.157, 0.11, 0.018, 0.01).turn(-0.12, 0, 0);
    torso.add(chestLed);
    torso.add(this.box(led, -0.045, 0.245, 0.151, 0.025, 0.025, 0.01).turn(-0.12, 0, 0), this.box({ color: [1, 0.75, 0.3], unlit: true }, 0.0, 0.245, 0.151, 0.025, 0.025, 0.01).turn(-0.12, 0, 0));
    if (intern) {
      torso.add(this.box(this.mats.lanyard, 0, 0.36, 0.1, 0.16, 0.02, 0.06).turn(0.5, 0, 0));
      torso.add(this.box(this.mats.badge, 0.09, 0.12, 0.16, 0.07, 0.09, 0.012));
      torso.add(this.box({ color: lin(this.css.accent) }, 0.09, 0.14, 0.167, 0.05, 0.015, 0.004));
    }
    const arm = (side) => {
      const p = new Node().at(side * 0.22, 0.34, 0);
      p.add(new Node(R.sphere, paintDark).size(0.075, 0.075, 0.075));
      p.add(new Node(R.cyl, metal).at(0, -0.1, 0).size(0.034, 0.18, 0.034));
      const elbow = new Node().at(0, -0.2, 0);
      elbow.add(new Node(R.sphere, joint).size(0.048, 0.048, 0.048));
      elbow.add(new Node(R.cyl, paint).at(0, -0.09, 0).size(0.045, 0.15, 0.045));
      elbow.add(new Node(R.sphere, joint).at(0, -0.19, 0).size(0.05, 0.045, 0.05));
      elbow.add(this.box(metal, side * 0.02, -0.225, 0.02, 0.018, 0.05, 0.02), this.box(metal, -side * 0.02, -0.225, 0.02, 0.018, 0.05, 0.02));
      p.add(elbow);
      return { shoulder: p, elbow };
    };
    const AL = arm(-1), AR = arm(1);
    torso.add(AL.shoulder, AR.shoulder);
    torso.add(new Node(R.cyl, metal).at(0, 0.44, 0).size(0.045, 0.08, 0.045));
    const head = new Node().at(0, 0.45, 0); torso.add(head);
    head.add(new Node(R.sphere, paint).at(0, 0.17, 0).size(0.19, 0.165, 0.175));
    head.add(new Node(R.sphere, visor).at(0, 0.16, 0.045).size(0.165, 0.1, 0.14));
    const eyes = [-1, 1].map((sd) => new Node(R.sphere, eye).at(sd * 0.058, 0.165, 0.178).size(0.03, 0.03, 0.012));
    head.add(...eyes);
    for (const sd of [-1, 1]) {
      head.add(new Node(R.cyl, paintDark).at(sd * 0.19, 0.16, 0).size(0.055, 0.04, 0.055).turn(0, 0, Math.PI / 2));
      head.add(new Node(R.cyl, metal).at(sd * 0.215, 0.16, 0).size(0.03, 0.02, 0.03).turn(0, 0, Math.PI / 2));
    }
    head.add(new Node(R.cyl, metal).at(0.05, 0.37, -0.02).size(0.011, 0.12, 0.011));
    const antennaTip = new Node(R.sphere, led).at(0.05, 0.44, -0.02).size(0.028, 0.028, 0.028);
    head.add(antennaTip);
    if (look.style === 1) head.add(new Node(R.cyl, paintDark).at(0, 0.33, 0).size(0.07, 0.03, 0.07));
    if (look.style === 2) head.add(this.box(paintDark, 0, 0.3, -0.02, 0.04, 0.05, 0.22));
    if (intern) head.add(this.box({ color: lin(this.css.accent) }, 0, 0.32, 0, 0.3, 0.02, 0.03));
    const cup = new Node(); cup.add(this.cyl(this.mats.cup, 0, 0, 0, 0.045, 0.1)); cup.at(0, -0.24, 0.04); cup.visible = false;
    AR.elbow.add(cup);
    const laptop = new Node();
    laptop.add(this.box(this.mats.monitor, 0, 0, 0, 0.34, 0.02, 0.22));
    const lscreen = { color: [1, 1, 1], unlit: true, tex: this.codeTex, uvScale: [1, 0.25], uvOff: [0, Math.random()], noShadow: true };
    laptop.add(this.box(this.mats.monitor, 0, 0.11, -0.11, 0.34, 0.22, 0.015).turn(-0.25, 0, 0));
    laptop.add(new Node(this.r.meshes.plane, lscreen).at(0, 0.11, -0.1).size(0.3, 0.19, 1).turn(-0.25, 0, 0));
    laptop.at(0, 0.62, 0.24); laptop.visible = false;
    root.add(laptop);
    const ring = new Node(this.r.meshes.cyl, this.mats.ring).at(0, 0.02, 0).size(0.42, 0.01, 0.42);
    ring.visible = false;
    root.add(ring);
    root.scl = [scale, scale, scale];
    return { root, body, hips, legL: L, legR: Rr, torso, armL: AL, armR: AR, head, cup, laptop, lscreen, ring, mats: m, eyes, eyeMat: eye, ledMat: led, antennaTip };
  }

  /** Eye / LED colour and expression for a status. */
  robotFace(R, status, seed = 0) {
    const t = this.t, C = this.css;
    let col, eyeH = 1, blink = 1;
    if (status === 'needs_you') { col = mix3(lin(C.needs), [1, 1, 1], 0.15); blink = Math.sin(t * 10) > 0 ? 1 : 0.25; }
    else if (status === 'working') { col = lin(C.screenOn); blink = 0.75 + 0.25 * Math.sin(t * 3 + seed); }
    else if (status === 'your_turn') { col = mix3(lin(C.turn), [1, 1, 1], 0.2); blink = 0.6 + 0.4 * Math.sin(t * 1.2 + seed); }
    else { col = [0.25, 0.27, 0.3]; eyeH = 0.18; blink = 0.3; }
    // occasional blink
    if (status !== 'idle' && status !== 'done' && ((t + (seed % 7)) % 4.5) < 0.12) eyeH = 0.15;
    if (status === 'done') { col = [0.35, 0.37, 0.4]; eyeH = 0.5; }
    R.eyeMat.color = scale3(col, status === 'idle' || status === 'done' ? 1 : 2.6);
    R.ledMat.color = scale3(col, blink * 2.2);
    for (const e of R.eyes) e.scl = [0.03, 0.03 * eyeH, 0.012];
  }

  placePerson(d, f, keepKeys) {
    const s = d.session;
    let p = this.people.get(s.id);
    if (!p) {
      const rig = this.buildRig(lookFor(s.id));
      p = { id: s.id, rig, group: rig.root, pos: { ...d.seat }, yaw: Math.PI, phase: 'seated', timer: 1 + (hash(s.id) % 40) / 10, path: null, walk: 0, queue: [] };
      this.people.set(s.id, p);
    }
    // Moved to another department: get up, take the lift and walk to the new desk.
    const moved = p.floor && p.floor !== f && keepKeys?.has(p.floor.key) && this.floors.get(p.floor.key) === p.floor;
    p.d = d; p.floor = f; p.session = s;
    if (moved && !p.trip) this.plan(p, [{ home: true }]);
    if (!p.trip) { p.lvl = f; if (p.group.parent !== f.node) f.node.add(p.group); }
    if (!p.deskNode || p.deskBuilt !== `${d.cx},${d.cz}` || p.deskNode.parent !== f.node) {
      p.deskNode?.detach();
      const desk = this.buildDesk(d);
      p.deskNode = desk.node; p.deskParts = desk; p.deskBuilt = `${d.cx},${d.cz}`;
      f.node.add(desk.node);
      if (p.phase === 'seated' && !p.trip) p.pos = { ...d.seat };
    }
  }

  // ---------- trips: walking, the lift, talking ----------
  isLevel(l) { return !!l && (l === this.lobbyLvl || this.floors.get(l.key) === l); }

  /**
   * Sends a robot on a trip: a list of stops it visits in order. A stop is
   *   { home: true }                    its own desk (it sits down there)
   *   { lobby: true, ... }              the reception desk in the lobby
   *   { visit: sessionId, dept, ... }   next to that robot's desk (or the middle of its floor)
   * plus `wait` (seconds to stay) and `talk` ([{ at, who: 'me'|'them'|'desk', text, secs }]).
   * A robot that is already out finishes its trip first.
   */
  plan(p, stops) {
    if (p.trip) {
      // Already out and about: replace the walk home with the new stops.
      const t = p.trip;
      if (t.stops[t.i]?.home && t.stage !== 'ride' && t.stage !== 'board' && t.stage !== 'alight') { t.stops = [...t.stops.slice(0, t.i), ...stops]; this.startStop(p); }
      else p.queue.push(stops);
      return;
    }
    p.trip = { stops, i: 0, stage: null };
    p.dest = null;
    p.cup = false;
    if (!this.isLevel(p.lvl)) p.lvl = p.floor;
    this.startStop(p);
  }

  /** Where a stop is: { lvl, x, z, face, target? }. Resolved when the robot sets off, and again on arrival. */
  resolveStop(p, st) {
    const { W, D } = this.dims;
    if (st.home) return { lvl: p.floor, x: p.d.seat.x, z: p.d.seat.z };
    if (st.lobby) return { lvl: this.lobbyLvl, x: W / 2 + 0.25, z: D / 2 + 0.5, face: { x: W / 2 - 0.6, z: D / 2 - 1.3 } };
    if (st.taxi) {
      // a place in the queue on the pavement, by the taxi rank
      const k = [...this.people.values()].filter((o) => o !== p && o.leaving && o.trip?.where?.taxi).length % 5;
      return { lvl: this.lobbyLvl, x: this.taxiRank().x + 0.3 - k * 0.6, z: D + 3.55, face: { x: this.taxiRank().x, z: D + 10 }, taxi: true, label: 'Taxi' };
    }
    const q = st.visit ? this.people.get(st.visit) : null;
    if (q?.d && q.floor && this.isLevel(q.floor)) {
      return { lvl: q.floor, x: q.d.cx + 0.8, z: q.d.seat.z + 0.45, face: { x: q.d.seat.x, z: q.d.seat.z }, target: q };
    }
    const f = this.floors.get(st.dept) || p.floor;
    return { lvl: f, x: W / 2 + 1.5, z: D - 1.8, face: { x: W / 2, z: D / 2 } };
  }

  landing(k = 0) {
    const W = this.dims.W;
    return { x: W - 0.55 - Math.floor(k / 3) * 0.5, z: LIFT_Z + ((k % 3) - 1) * 0.42 };
  }

  /** A walk on one floor: out to an aisle, along a corridor (the lift one near the lift), in to the spot. */
  route(from, to) {
    const W = this.dims.W;
    const corridor = from.x > W - 1.4 || to.x > W - 1.4 ? W - 0.6 : 1.25;
    const aisle = (z) => z + 0.62;
    const pts = [];
    if (Math.abs(from.x - corridor) > 0.2) pts.push({ x: from.x, z: aisle(from.z) }, { x: corridor, z: aisle(from.z) });
    if (Math.abs(to.x - corridor) > 0.2) pts.push({ x: corridor, z: aisle(to.z) }, { x: to.x, z: aisle(to.z) });
    pts.push({ x: to.x, z: to.z });
    return pts;
  }

  startStop(p) {
    const t = p.trip;
    const st = t.stops[t.i];
    if (!st) return this.endTrip(p);
    const where = this.resolveStop(p, st);
    t.where = where;
    if (where.lvl !== p.lvl) {
      const k = [...this.people.values()].filter((o) => o !== p && o.trip && (o.trip.stage === 'toLift' || o.trip.stage === 'waitLift') && o.lvl === p.lvl).length;
      t.stage = 'toLift';
      t.liftTo = where.lvl;
      t.spot = this.landing(k % 6);
      p.path = this.route(p.pos, t.spot);
    } else {
      t.stage = 'walk';
      p.path = st.taxi ? this.taxiRoute(p.pos, where) : this.route(p.pos, where);
    }
    p.phase = 'walking';
  }

  endTrip(p) {
    if (p.leaving) return this.removePerson(p);
    p.trip = null;
    p.path = null;
    p.lvl = p.floor;
    if (p.group.parent !== p.floor.node) p.floor.node.add(p.group);
    p.pos = { ...p.d.seat };
    p.phase = 'seated';
    p.timer = 8 + (hash(p.id) % 50) / 10;
    const next = p.queue.shift();
    if (next) this.plan(p, next);
  }

  /** Moves along p.path; true when the end is reached. */
  walkPath(p, dt, speed = WALK_SPEED * 1.6) {
    let step = speed * dt;
    p.walk += step * 7;
    while (step > 0 && p.path?.length) {
      const tg = p.path[0];
      const dx = tg.x - p.pos.x, dz = tg.z - p.pos.z, dist = Math.hypot(dx, dz);
      if (dist <= step) { p.pos = { x: tg.x, z: tg.z }; p.path.shift(); step -= dist; }
      else { p.pos.x += (dx / dist) * step; p.pos.z += (dz / dist) * step; step = 0; p.targetYaw = Math.atan2(dx, dz); }
    }
    return !p.path?.length;
  }

  stepTrip(p, dt) {
    const t = p.trip, L = this.lift;
    // The floor it stood on was removed (department deleted): straight back to its desk.
    if (t.stage !== 'ride' && !this.isLevel(p.lvl)) { p.queue = []; return this.endTrip(p); }
    if (p.group.parent !== (t.stage === 'ride' ? this.cab : p.lvl.node)) (t.stage === 'ride' ? this.cab : p.lvl.node).add(p.group);
    if (t.liftTo && !this.isLevel(t.liftTo)) { t.stops[t.i] = p.leaving ? { taxi: true } : { home: true }; t.liftTo = p.leaving ? this.lobbyLvl : p.floor; }
    switch (t.stage) {
      case 'taxiWait':
        p.targetYaw = 0; // facing the street
        break;
      case 'taxiBoard':
        if (this.walkPath(p, dt)) return this.removePerson(p);
        break;
      case 'toLift':
        if (this.walkPath(p, dt)) { t.stage = 'waitLift'; p.phase = 'standing'; p.targetYaw = Math.PI / 2; }
        break;
      case 'waitLift':
        p.targetYaw = Math.PI / 2;
        if (L.at === p.lvl && L.state === 'open' && L.riders.size < CAB_SLOTS.length) {
          t.stage = 'board';
          t.slot = [0, 1, 2, 3].find((k) => ![...L.riders].some((o) => o.trip?.slot === k)) ?? 0;
          L.riders.add(p);
          const cx = this.cabX(), [sx, sz] = CAB_SLOTS[t.slot];
          p.path = [{ x: this.dims.W - 0.2, z: LIFT_Z }, { x: this.dims.W + 0.45, z: LIFT_Z }, { x: cx + sx, z: LIFT_Z + sz }];
          p.phase = 'walking';
        }
        break;
      case 'board':
        if (this.walkPath(p, dt, WALK_SPEED * 1.3)) { t.stage = 'ride'; p.phase = 'standing'; p.targetYaw = -Math.PI / 2; this.cab.add(p.group); }
        break;
      case 'ride':
        p.targetYaw = -Math.PI / 2;
        if (L.at === t.liftTo && L.state === 'open') {
          L.riders.delete(p);
          p.lvl = t.liftTo;
          p.lvl.node.add(p.group);
          t.stage = 'alight';
          const sp = this.landing(t.slot || 0);
          p.path = [{ x: this.dims.W + 0.45, z: LIFT_Z }, { x: this.dims.W - 0.2, z: LIFT_Z }, sp];
          p.phase = 'walking';
        }
        break;
      case 'alight':
        if (this.walkPath(p, dt, WALK_SPEED * 1.3)) { t.liftTo = null; this.startStop(p); }
        break;
      case 'walk':
        if (this.walkPath(p, dt)) {
          const st = t.stops[t.i];
          if (st.taxi) { t.stage = 'taxiWait'; p.phase = 'standing'; p.targetYaw = 0; break; }
          // Home, unless it was moved to another department on the way: then off to the lift again.
          if (st.home) { if (p.floor === p.lvl) return this.endTrip(p); this.startStop(p); break; }
          // The robot we came for may have moved meanwhile: walk on to where it is now.
          const now = this.resolveStop(p, st);
          if (now.lvl === p.lvl && Math.hypot(now.x - p.pos.x, now.z - p.pos.z) > 0.6) { t.where = now; p.path = this.route(p.pos, now); break; }
          t.stage = 'stay';
          t.timer = 0;
          t.fired = new Set();
          p.phase = 'standing';
          const face = now.face || t.where.face;
          if (face) p.targetYaw = Math.atan2(face.x - p.pos.x, face.z - p.pos.z);
          t.target = now.target || null;
        }
        break;
      case 'stay': {
        const st = t.stops[t.i];
        t.timer += dt;
        (st.talk || []).forEach((line, k) => {
          if (t.fired.has(k) || t.timer < line.at) return;
          t.fired.add(k);
          const until = this.t + (line.secs || 4);
          if (line.who === 'me') p.say = { text: line.text, until, kind: 'say' };
          else if (line.who === 'them' && t.target && this.people.get(t.target.id) === t.target) t.target.say = { text: line.text, until, kind: 'reply' };
          else if (line.who === 'desk') this.recSay = { text: line.text, until };
        });
        if (t.target && this.people.get(t.target.id) === t.target && t.target.lvl === p.lvl && t.target.phase === 'seated') {
          const tp = t.target.rig.root.pos;
          p.targetYaw = Math.atan2(tp[0] - p.pos.x, tp[2] - p.pos.z);
        }
        if (t.timer >= (st.wait || 3)) { t.i++; this.startStop(p); }
        break;
      }
    }
  }

  /**
   * The lift: one car that serves calls in a simple, collective way. Riders' floors first
   * (nearest first), otherwise the nearest floor where someone is waiting. Doors open, people
   * get out and in, doors close.
   */
  updateLift(dt) {
    const L = this.lift;
    const travellers = [...this.people.values()].filter((p) => p.trip);
    const waiting = travellers.filter((p) => p.trip.stage === 'waitLift' && this.isLevel(p.lvl));
    const riders = [...L.riders].filter((p) => p.trip);
    const levels = [this.lobbyLvl, ...this.floors.values()];
    const nearest = (list) => list.reduce((b, l) => (!b || Math.abs(l.oy - L.y) < Math.abs(b.oy - L.y) ? l : b), null);
    switch (L.state) {
      case 'idle': {
        if (L.at && Math.abs(L.at.oy - L.y) > 0.01) { L.target = L.at; L.state = 'moving'; break; }
        const here = L.at && (waiting.some((p) => p.lvl === L.at) || riders.some((p) => p.trip.stage === 'ride' && p.trip.liftTo === L.at));
        if (here) { L.state = 'opening'; break; }
        const dest = riders.filter((p) => p.trip.stage === 'ride').map((p) => p.trip.liftTo).filter((l) => this.isLevel(l));
        const target = nearest(dest.length ? dest : waiting.map((p) => p.lvl)) || (L.at ? null : nearest(levels));
        if (target) { L.target = target; L.state = 'moving'; }
        break;
      }
      case 'moving': {
        if (!L.target || !this.isLevel(L.target)) { L.target = null; L.at = null; L.state = 'idle'; break; }
        const d = L.target.oy - L.y;
        const v = Math.min(2.6, 0.45 + Math.abs(d) * 1.4);
        if (Math.abs(d) <= v * dt) { L.y = L.target.oy; L.at = L.target; L.target = null; L.state = 'opening'; }
        else { L.y += Math.sign(d) * v * dt; L.at = null; }
        break;
      }
      case 'opening':
        L.door = Math.min(1, L.door + dt / 0.7);
        if (L.door >= 1) { L.state = 'open'; L.dwell = 0; }
        break;
      case 'open': {
        L.dwell += dt;
        const moving = travellers.some((p) => (p.trip.stage === 'board' || p.trip.stage === 'alight') && (p.lvl === L.at || L.riders.has(p)));
        const pending = waiting.some((p) => p.lvl === L.at && L.riders.size < CAB_SLOTS.length) || riders.some((p) => p.trip.stage === 'ride' && p.trip.liftTo === L.at);
        if ((!moving && !pending && L.dwell > 1.2) || L.dwell > 14) L.state = 'closing';
        break;
      }
      case 'closing':
        L.door = Math.max(0, L.door - dt / 0.7);
        if (L.door <= 0) L.state = 'idle';
        break;
    }
    // Riders that got lost (their session went away) don't hold the car.
    for (const p of L.riders) if (!p.trip || !this.people.has(p.id)) L.riders.delete(p);
    if (this.cab) this.cab.pos = [0, L.y, 0];
    for (const lvl of levels) {
      const doors = lvl.liftDoors;
      if (!doors) continue;
      const open = L.at === lvl && L.state !== 'moving' ? ease(L.door) : 0;
      doors[0].pos[2] = LIFT_Z - LIFT_DOOR / 2 - open * 0.55;
      doors[1].pos[2] = LIFT_Z + LIFT_DOOR / 2 + open * 0.55;
    }
  }

  placeIntern(it, d, i, f) {
    let n = this.interns.get(it.id);
    if (!n) {
      const rig = this.buildRig(lookFor(it.id), 0.68, true);
      n = { id: it.id, rig, group: rig.root };
      this.interns.set(it.id, n);
    }
    if (n.group.parent !== f.node) f.node.add(n.group);
    const spots = [[1.2, 0.55], [-1.2, 0.55], [1.2, -0.45], [-1.2, -0.45], [0.65, 1.25], [-0.65, 1.25]];
    const sp = spots[i % spots.length];
    n.home = { x: d.cx + sp[0], z: d.cz + sp[1] };
    n.faceTo = { x: d.cx, z: d.cz };
    n.intern = it; n.parent = d.session; n.index = i; n.floor = f;
    n.hidden = i >= spots.length;
  }

  pathTo(from, to) {
    const corridorX = 1.25;
    const aisle = (z) => z + 0.62;
    const pts = [];
    if (Math.abs(from.x - corridorX) > 0.2) pts.push({ x: from.x, z: aisle(from.z) }, { x: corridorX, z: aisle(from.z) });
    if (Math.abs(to.x - corridorX) > 0.2) pts.push({ x: corridorX, z: aisle(to.z) }, { x: to.x, z: aisle(to.z) });
    pts.push({ ...to });
    return pts;
  }

  floorVisible(f) {
    if (this.view.mode === 'building') return true;
    const sel = this.floors.get(this.view.key);
    return !sel || f.index <= sel.index;
  }

  // ---------- animation ----------
  update(dt) {
    const t = this.t;
    const sel = this.view.mode === 'floor' ? this.floors.get(this.view.key) : null;
    for (const f of this.floors.values()) {
      f.node.visible = this.floorVisible(f);
      const showGlass = sel !== f;
      const hover = !sel && this.hoverFloor === f.key;
      for (const gNode of f.glass) {
        gNode.visible = showGlass;
        if (gNode.mat === this.mats.glass || gNode.mat === this.mats.glassHover) gNode.mat = hover ? this.mats.glassHover : this.mats.glass;
      }
    }
    if (this.roof) this.roof.visible = !sel;
    // Branch zones: light up the one in focus, tone down the rest.
    for (const f of this.floors.values()) {
      if (!f.zoneMats?.size) continue;
      const focus = this.view.mode === 'floor' && this.view.key === f.key ? this.view.branch : null;
      for (const [branch, m] of f.zoneMats) {
        m.color = focus && focus !== branch ? scale3(m.base, 0.75) : m.base;
        m.emissive = focus === branch ? scale3(m.base, 0.35 + 0.08 * Math.sin(t * 2.5)) : null;
      }
    }

    for (const f of this.floors.values()) {
      let walker = 0;
      let busy = false;
      for (const d of f.desks) {
        const p = this.people.get(d.session.id);
        if (!p || p.leaving) continue;
        if (p.trip) { this.stepTrip(p, dt); this.pose(p, dt); continue; }
        const s = p.session;
        const stand = { x: f.machine.x + 0.75 + (walker % 2) * 0.5, z: f.machine.z - 0.2 + Math.floor(walker / 2) * 0.55 };
        if (p.phase !== 'seated') walker++;
        if (s.status === 'your_turn') {
          p.timer -= dt;
          if (p.phase === 'seated' && p.timer <= 0) { p.phase = 'walking'; p.dest = 'machine'; p.path = this.pathTo(p.pos, stand); }
          else if (p.phase === 'atMachine' && p.timer <= 0) { p.phase = 'walking'; p.dest = 'desk'; p.path = this.pathTo(p.pos, d.seat); }
        } else if (p.phase !== 'seated' && p.dest !== 'desk') {
          p.phase = 'walking'; p.dest = 'desk'; p.path = this.pathTo(p.pos, d.seat);
        }
        if (p.phase === 'walking' && p.path) {
          let step = (s.status === 'your_turn' ? WALK_SPEED : WALK_SPEED * 2) * dt;
          p.walk += step * 7;
          while (step > 0 && p.path.length) {
            const tg = p.path[0];
            const dx = tg.x - p.pos.x, dz = tg.z - p.pos.z, dist = Math.hypot(dx, dz);
            if (dist <= step) { p.pos = { ...tg }; p.path.shift(); step -= dist; }
            else { p.pos.x += (dx / dist) * step; p.pos.z += (dz / dist) * step; step = 0; p.targetYaw = Math.atan2(dx, dz); }
          }
          if (!p.path.length) {
            if (p.dest === 'machine') { p.phase = 'atMachine'; p.timer = 4 + (hash(s.id) % 30) / 10; p.targetYaw = -Math.PI / 2; }
            else { p.phase = 'seated'; p.timer = 8 + (hash(s.id + Math.floor(t)) % 60) / 10; p.cup = true; }
          }
        }
        if (p.phase === 'atMachine') busy = true;
        if (s.status === 'working') p.cup = false;
        this.pose(p, dt);
      }
      f.steam?.forEach((n, i) => {
        n.visible = busy;
        const ph = (t * 0.6 + i / 3) % 1;
        n.pos = [f.machine.x + 0.05 + Math.sin(t * 3 + i) * 0.03, 1.42 + ph * 0.5, f.machine.z - 0.15];
        n.scl = [0.04 + ph * 0.06, 0.04 + ph * 0.06, 0.04 + ph * 0.06];
        n.mat = { ...this.mats.steam, alpha: 0.4 * (1 - ph) };
      });
    }
    for (const n of this.interns.values()) this.poseIntern(n, dt);

    // robots on their way home (their desks may already be gone), and the taxi that takes them
    for (const p of this.people.values()) {
      if (!p.leaving) continue;
      if (p.trip) this.stepTrip(p, dt);
      if (this.people.has(p.id)) this.pose(p, dt);
    }
    this.updateTaxi(dt);
    // the front doors slide open for anyone walking through them
    if (this.entrance) {
      const { W, D } = this.dims;
      const near = [...this.people.values()].some((p) => p.trip && p.lvl === this.lobbyLvl && Math.abs(p.pos.x - W / 2) < 1.6 && Math.abs(p.pos.z - D) < 1.8);
      this.doorOpen = clamp((this.doorOpen || 0) + (near ? dt : -dt) / 0.6, 0, 1);
      const o = ease(this.doorOpen) * 0.98;
      for (const l of this.entrance) l.node.pos[0] = l.x + l.dir * o;
    }

    // the lift, and speech for robots that have just walked in
    this.updateLift(dt);
    if (this.cab) this.cab.visible = !sel || this.lift.y <= sel.oy + 0.05;
    if (this.pendingSays.length) {
      this.pendingSays = this.pendingSays.filter((q) => {
        const p = this.people.get(q.id);
        if (p) { p.say = { text: q.text, until: this.t + q.secs, kind: q.kind }; return false; }
        return q.expires > this.t;
      });
    }

    if (this.receptionist) {
      const R = this.receptionist, k = Math.sin(t * 9) * 0.1;
      R.armL.shoulder.rot = [-0.95 + k, 0, -0.15]; R.armL.elbow.rot = [-0.75, 0, 0];
      R.armR.shoulder.rot = [-0.95 - k, 0, 0.15]; R.armR.elbow.rot = [-0.75, 0, 0];
      R.head.rot = [0.05, Math.sin(t * 0.3) * 0.4, 0];
      this.robotFace(R, 'your_turn', 3);
    }
    if (this.city) {
      const span = Math.min(this.city.span, 320);
      for (const c of this.city.cars) {
        const pos = ((c.offset + t * c.speed) % span + span) % span - span / 2;
        if (c.axis === 'x') { c.node.pos = [this.dims.W / 2 + pos, -0.26, c.lane]; c.node.rot = [0, c.speed > 0 ? 0 : Math.PI, 0]; }
        else { c.node.pos = [c.lane, -0.26, this.dims.D / 2 + pos]; c.node.rot = [0, c.speed > 0 ? -Math.PI / 2 : Math.PI / 2, 0]; }
      }
      for (const c of this.city.clouds) {
        c.node.pos[0] += c.speed * dt;
        if (c.node.pos[0] > this.dims.W / 2 + 150) c.node.pos[0] -= 300;
      }
    }
  }

  pose(p, dt) {
    const R = p.rig, s = p.session, t = this.t;
    const seatedPhase = p.phase === 'seated';
    const needs = s.status === 'needs_you';
    const sitting = seatedPhase && !needs;
    for (const n of [R.legL.hip, R.legL.knee, R.legR.hip, R.legR.knee, R.armL.shoulder, R.armL.elbow, R.armR.shoulder, R.armR.elbow, R.head, R.torso]) n.rot = [0, 0, 0];
    R.cup.visible = false;
    let x = p.pos.x, z = p.pos.z, hipY = 0.6, yaw = p.targetYaw ?? Math.PI;

    if (sitting) {
      hipY = 0.53; yaw = Math.PI;
      z = p.d.seat.z - 0.05;
      R.legL.hip.rot[0] = R.legR.hip.rot[0] = -Math.PI / 2;
      R.legL.knee.rot[0] = R.legR.knee.rot[0] = Math.PI / 2;
      if (s.status === 'working') {
        const k1 = Math.sin(t * 16) * 0.12, k2 = Math.sin(t * 16 + 2) * 0.12;
        R.armL.shoulder.rot = [-0.95 + k1, 0, -0.15]; R.armL.elbow.rot = [-0.75, 0, 0];
        R.armR.shoulder.rot = [-0.95 + k2, 0, 0.15]; R.armR.elbow.rot = [-0.75, 0, 0];
        R.head.rot = [0.12 + Math.sin(t * 0.7) * 0.04, Math.sin(t * 0.5) * 0.12, 0];
      } else if (s.status === 'idle') {
        R.torso.rot = [0.18, 0, 0];
        R.head.rot = [0.5, 0, 0.25];
        R.armL.shoulder.rot = [-0.35, 0, 0]; R.armR.shoulder.rot = [-0.35, 0, 0];
        R.armL.elbow.rot = [-0.6, 0, 0]; R.armR.elbow.rot = [-0.6, 0, 0];
      } else {
        R.torso.rot = [-0.12, 0, 0];
        R.armL.shoulder.rot = [-0.3, 0, -0.1];
        if (p.cup) { R.armR.shoulder.rot = [-0.6 + Math.max(0, Math.sin(t * 0.8)) * 0.5, 0, 0.1]; R.armR.elbow.rot = [-1.5, 0, 0]; R.cup.visible = true; }
        R.head.rot = [-0.05, Math.sin(t * 0.4) * 0.3, 0];
      }
    } else if (needs && seatedPhase) {
      x = p.d.seat.x + 0.5; z = p.d.seat.z + 0.1;
      yaw = Math.atan2(this.eye[0] - x, this.eye[2] - z);
      const wv = Math.sin(t * 9) * 0.35;
      R.armR.shoulder.rot = [0, 0, 2.6 + wv]; R.armR.elbow.rot = [0, 0, 0.3 + wv * 0.5];
      R.armL.shoulder.rot = [0, 0, -0.15];
      hipY = 0.6 + Math.abs(Math.sin(t * 4.5)) * 0.03;
    } else if (p.phase === 'walking') {
      const ph = p.walk;
      R.legL.hip.rot[0] = Math.sin(ph) * 0.55; R.legR.hip.rot[0] = -Math.sin(ph) * 0.55;
      R.legL.knee.rot[0] = Math.max(0, Math.sin(ph + 1.2)) * 0.8; R.legR.knee.rot[0] = Math.max(0, -Math.sin(ph + 1.2)) * 0.8;
      R.armL.shoulder.rot[0] = -Math.sin(ph) * 0.45; R.armR.shoulder.rot[0] = Math.sin(ph) * 0.45;
      R.armL.elbow.rot[0] = R.armR.elbow.rot[0] = -0.35;
      hipY = 0.6 + Math.abs(Math.cos(ph)) * 0.025;
      if (p.dest === 'desk' && s.status === 'your_turn') { R.armR.shoulder.rot = [-0.7, 0, 0]; R.armR.elbow.rot = [-1.2, 0, 0]; R.cup.visible = true; }
    } else if (p.phase === 'atMachine') {
      R.armR.shoulder.rot = [-0.8, 0, 0]; R.armR.elbow.rot = [-0.9, 0, 0];
      R.armL.shoulder.rot = [-0.2, 0, -0.1];
      R.head.rot = [0.2, 0, 0];
      R.cup.visible = (this.t % 6) > 2;
    } else if (p.phase === 'standing') {
      // Waiting for the lift, riding it, or talking to someone.
      const talking = p.say && p.say.until > t;
      if (talking) {
        const k = Math.sin(t * 5 + hash(p.id)) * 0.25;
        R.armR.shoulder.rot = [-0.7 + k, 0, 0.25]; R.armR.elbow.rot = [-0.9 - k * 0.6, 0, 0];
        R.armL.shoulder.rot = [-0.2, 0, -0.12];
        R.head.rot = [Math.sin(t * 6) * 0.06, 0, Math.sin(t * 2.5) * 0.05];
      } else {
        R.armL.shoulder.rot = [0, 0, -0.08]; R.armR.shoulder.rot = [0, 0, 0.08];
        R.head.rot = [0.05, Math.sin(t * 0.6 + hash(p.id)) * 0.25, 0];
      }
    }
    // Seated robots that are told something look up from the screen.
    if (sitting && p.say && p.say.until > t) R.head.rot = [-0.05, 0.35, 0];
    this.robotFace(R, s.status, hash(s.id) % 100);
    p.yaw = angleLerp(p.yaw, yaw, Math.min(1, dt * 10));
    R.root.pos = [x, 0, z];
    R.root.rot = [0, p.yaw, 0];
    R.hips.pos = [0, hipY, 0];
    R.ring.visible = this.selected === s.id;
    if (R.ring.visible) R.ring.pos = [0, 0.02, sitting ? -0.02 : 0];
    // A branch is in focus and this robot is on another one: fade it back.
    const dim = this.dimmed(s, p.floor);
    if (dim !== p.wasDim) {
      p.wasDim = dim;
      for (const k of Object.keys(R.mats)) R.mats[k].alpha = dim ? 0.22 : undefined;
    }

    const dp = p.deskParts;
    if (dp) {
      const C = this.css;
      const on = s.status === 'working' || s.status === 'needs_you';
      dp.screenMat.tex = on ? this.codeTex : null;
      dp.screenMat.color = s.status === 'needs_you' ? scale3(mix3(lin(C.needs), [1, 1, 1], 0.2), 1.6)
        : on ? [1.45, 1.45, 1.45]
        : s.status === 'your_turn' ? scale3(lin(C.turn), 0.35 + 0.1 * Math.sin(this.t * 1.5 + hash(s.id)))
        : lin(C.screenOff);
      if (s.status === 'working') dp.screenMat.uvOff = [0, (dp.screenMat.uvOff[1] + dt * 0.08) % 1];
      dp.mug.visible = !!p.cup && sitting;
    }
  }

  poseIntern(n, dt) {
    const R = n.rig, it = n.intern, t = this.t;
    for (const x of [R.legL.hip, R.legL.knee, R.legR.hip, R.legR.knee, R.armL.shoulder, R.armL.elbow, R.armR.shoulder, R.armR.elbow, R.head, R.torso]) x.rot = [0, 0, 0];
    n.group.visible = !n.hidden;
    R.root.pos = [n.home.x, 0, n.home.z];
    R.root.rot = [0, Math.atan2(n.faceTo.x - n.home.x, n.faceTo.z - n.home.z), 0];
    R.hips.pos = [0, 0.6, 0];
    R.laptop.visible = it.status === 'working';
    if (it.status === 'working') {
      const k = Math.sin(t * 14 + n.index) * 0.1;
      R.armL.shoulder.rot = [-0.9 + k, 0, -0.1]; R.armL.elbow.rot = [-0.9, 0, 0];
      R.armR.shoulder.rot = [-0.9 - k, 0, 0.1]; R.armR.elbow.rot = [-0.9, 0, 0];
      R.head.rot = [0.35, 0, 0];
      R.lscreen.uvOff = [0, (R.lscreen.uvOff[1] + dt * 0.1) % 1];
    } else if (it.status === 'needs_you') {
      const wv = Math.sin(t * 9) * 0.35;
      R.armR.shoulder.rot = [0, 0, 2.5 + wv];
      R.hips.pos = [0, 0.6 + Math.abs(Math.sin(t * 5)) * 0.04, 0];
    } else {
      R.head.rot = [0.1, 0, 0];
    }
    this.robotFace(R, it.status, hash(it.id) % 100);
    let fade = it.status === 'done' ? clamp(1 - (Date.now() - (it.lastActivity || 0)) / 300000, 0.15, 0.7) : 1;
    if (this.dimmed(n.parent, n.floor)) fade = Math.min(fade, 0.2);
    for (const k of Object.keys(R.mats)) R.mats[k].alpha = fade < 1 ? fade : undefined;
    R.ring.visible = this.selected === it.id;
  }

  // ---------- camera & drawing ----------
  camera(dt) {
    if (this.camAnim) {
      const a = this.camAnim;
      a.t += dt / a.dur;
      const k = ease(Math.min(1, a.t));
      this.cam.target = lerpN(a.from.target, a.to.target, k);
      this.cam.dist = (a.from.dist + (a.to.dist - a.from.dist) * k) * (1 + Math.sin(Math.PI * k) * 0.18);
      this.cam.pitch = a.from.pitch + (a.to.pitch - a.from.pitch) * k;
      this.cam.yaw = angleLerp(a.from.yaw, a.to.yaw, k);
      if (a.t >= 1) this.camAnim = null;
    }
    const c = this.cam;
    const eye = [
      c.target[0] + c.dist * Math.cos(c.pitch) * Math.sin(c.yaw),
      c.target[1] + c.dist * Math.sin(c.pitch),
      c.target[2] + c.dist * Math.cos(c.pitch) * Math.cos(c.yaw),
    ];
    if (eye[1] < 0.6) eye[1] = 0.6;
    this.eye = eye;
    return { eye, target: c.target, fov: c.fov, near: 0.1, far: 900 };
  }

  draw(dt = 0) {
    const cam = this.camera(dt);
    this.sky.pos = [...cam.eye];
    this.sky.scl = [600, 600, 600];
    const { W, D, N } = this.dims;
    const sel = this.view.mode === 'floor' ? this.floors.get(this.view.key) : null;
    const shadowBox = sel
      ? { center: [W / 2, sel.oy + 1, D / 2], radius: Math.hypot(W, D) / 2 + 3 }
      : { center: [W / 2, 6, D / 2], radius: Math.max(70, Math.hypot(W, D, (N + 2) * FLOOR_H) / 2 + 8) };
    const env = { ...this.env, fogRange: [Math.max(60, this.cam.dist * 1.5), Math.max(260, this.cam.dist * 4)], shadowBox };

    const glows = [];
    const L = this.env.lightDir;
    const sp = [cam.eye[0] + L[0] * 400, cam.eye[1] + L[1] * 400, cam.eye[2] + L[2] * 400];
    const sg = this.sunGlow;
    if (!sg) { if (this.moonAlpha > 0.01) glows.push({ pos: sp, size: 26, color: [1.8, 1.85, 2], alpha: this.moonAlpha, noFog: true }); }
    else if (sg.alpha > 0.01) glows.push({ pos: sp, size: sg.size, color: sg.color, alpha: sg.alpha, noFog: true }, { pos: sp, size: sg.size * 3, color: sg.halo, alpha: 0.35 * sg.alpha, noFog: true });
    for (const p of this.people.values()) {
      const s = p.session; if (!s || !p.d || !p.floor || !this.floorVisible(p.floor)) continue;
      if (s.status === 'working' || s.status === 'needs_you') {
        const col = s.status === 'needs_you' ? lin(this.css.needs) : lin(this.css.screenOn);
        const a = (this.dark ? 0.55 : 0.32) * (sel ? 1 : 0.7);
        glows.push({ pos: [p.d.cx, p.floor.oy + 1.22, p.d.cz - 0.1], size: 1.5, color: col, alpha: a * (0.9 + 0.1 * Math.sin(this.t * 3 + hash(s.id))) });
      }
    }
    for (const n of this.interns.values()) {
      if (n.intern.status === 'working' && !n.hidden && this.floorVisible(n.floor)) glows.push({ pos: [n.home.x, n.floor.oy + 0.62, n.home.z], size: 0.6, color: lin(this.css.screenOn), alpha: this.dark ? 0.4 : 0.22 });
    }
    if (this.dark && this.taxi) {
      // headlights and the roof sign
      const T = this.taxi, cs = Math.cos(T.yaw), sn = Math.sin(T.yaw);
      for (const s of [-0.32, 0.32]) glows.push({ pos: [T.pos.x + 1.2 * cs + s * sn, 0.22, T.pos.z - 1.2 * sn + s * cs], size: 1.1, color: [1, 0.95, 0.8], alpha: 0.5 });
      glows.push({ pos: [T.pos.x - 0.1 * cs, 0.92, T.pos.z + 0.1 * sn], size: 0.9, color: [1, 0.85, 0.4], alpha: 0.45 });
    }
    if (this.dark && this.cab?.visible) glows.push({ pos: [this.cabX(), this.lift.y + 2.3, LIFT_Z], size: 1.8, color: [1, 0.9, 0.7], alpha: 0.4 });
    if (this.dark && this.city) for (const l of this.city.lamps) if (Math.hypot(l[0] - W / 2, l[2] - D / 2) < 75) glows.push({ pos: l, size: 2.8, color: [1, 0.8, 0.45], alpha: 0.45 });
    this.r.render(this.root, cam, env, glows);
    this.drawLabels();
  }

  drawLabels() {
    const W = this.w, H = this.h;
    this.hits = [];
    const sel = this.view.mode === 'floor' ? this.floors.get(this.view.key) : null;
    const probe = this.r.project(this.cam.target, W, H), probe2 = this.r.project([this.cam.target[0], this.cam.target[1] + 1.4, this.cam.target[2]], W, H);
    const near = Math.abs(probe.y - probe2.y) > 38;
    const place = (owner, world, html, cls, interactive = false) => {
      let el = owner.label;
      if (!el) {
        el = document.createElement('div'); owner.label = el; this.labels.appendChild(el);
        if (interactive) el.addEventListener('click', () => owner.onClick?.());
      }
      if (!html) { el.hidden = true; return; }
      const p = this.r.project(world, W, H);
      if (p.behind || p.x < -100 || p.x > W + 100 || p.y < -100 || p.y > H + 100) { el.hidden = true; return; }
      el.hidden = false;
      if (el._cls !== cls) { el.className = cls; el._cls = cls; }
      if (el._html !== html) { el.innerHTML = html; el._html = html; }
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      el.style.zIndex = String(10000 - Math.round(p.w * 10));
    };

    for (const p of this.people.values()) {
      const s = p.session; if (!s || !p.floor) continue;
      // Robots on a trip stand on another floor, in the lobby, or in the lift.
      const riding = p.trip?.stage === 'ride';
      const lvl = riding ? null : (this.isLevel(p.lvl) ? p.lvl : p.floor);
      const pos = p.rig.root.pos, oy = riding ? this.lift.y : lvl.oy;
      const visible = riding ? !!this.cab?.visible : this.floorVisible(lvl);
      const here = !!sel && (riding ? visible : sel === lvl);
      const show = here && !this.dimmed(s, p.floor);
      const standing = s.status === 'needs_you' || p.phase !== 'seated';
      const headY = s.status === 'needs_you' && !p.trip ? 1.82 : standing ? 1.62 : 1.5;
      const talk = p.say && p.say.until > this.t ? p.say : null;
      let html = null, cls = 'lbl';
      if (show && !p.leaving && (!talk || s.status === 'needs_you')) {
        if (s.status === 'needs_you') {
          const txt = near ? esc(this.bubbleText(s) || s.reason || 'needs you') : '';
          html = `<span class="alert">!</span>${txt ? `<span class="alert-text">${txt}</span>` : ''}`;
          cls = 'lbl needs';
        } else if (s.status === 'working') {
          html = near ? (s.current ? `<span class="speech">${esc(this.bubbleText(s))}</span>` : '<span class="speech dots"><i></i><i></i><i></i></span>') : null;
          cls = 'lbl work';
        } else if (s.status === 'idle') {
          html = '<span class="zzz"><i>z</i><i>z</i><i>z</i></span>'; cls = 'lbl idle';
        }
      }
      place(p, [pos[0], oy + headY, pos[2]], html, cls);
      // What it says to another robot (or you), or where it is heading.
      let th = null;
      if (visible && !this.dimmed(s, p.floor)) {
        if (talk) {
          const who = talk.kind === 'brief' ? 'From you' : p.floor.name;
          th = `<span class="say ${esc(talk.kind)}"><b>${esc(who)}</b><span class="say-text sensitive">${esc(talk.text)}</span></span>`;
        } else if (p.trip && p.trip.stage !== 'stay' && (!sel || here)) {
          const w = p.trip.where, to = w?.lvl;
          if (p.trip.stage === 'taxiWait') th = '<span class="trip">🚕 Waiting for a taxi</span>';
          else if (w?.taxi && p.trip.stage !== 'taxiBoard') th = '<span class="trip">🚕 Going home</span>';
          else if (to && to !== lvl) th = `<span class="trip">→ ${esc(to.name)}</span>`;
        }
      }
      place((p.talkHolder ||= {}), [pos[0], oy + headY + (html && talk ? 0.45 : 0), pos[2]], th, 'lbl talk');
      if (show) {
        const a = this.r.project([pos[0], oy, pos[2]], W, H), b2 = this.r.project([pos[0], oy + headY - 0.05, pos[2]], W, H);
        if (!a.behind) {
          const half = Math.max(10, Math.abs(a.y - b2.y) * 0.3);
          this.hits.push({ id: s.id, session: s, x0: a.x - half, x1: a.x + half, y0: b2.y - half * 0.4, y1: a.y + 4, depth: a.w });
        }
      }
    }
    for (const n of this.interns.values()) {
      const it = n.intern;
      const pos = n.rig.root.pos, oy = n.floor.oy;
      const show = sel && sel === n.floor && !n.hidden && !this.dimmed(n.parent, n.floor);
      place(n, [pos[0], oy + 1.18, pos[2]], show && it.status === 'needs_you' ? '<span class="alert small">!</span>' : null, 'lbl needs');
      if (!show) continue;
      const a = this.r.project([pos[0], oy, pos[2]], W, H), b2 = this.r.project([pos[0], oy + 1.05, pos[2]], W, H);
      if (!a.behind) {
        const half = Math.max(7, Math.abs(a.y - b2.y) * 0.3);
        this.hits.push({ id: it.id, intern: it, parent: n.parent, x0: a.x - half, x1: a.x + half, y0: b2.y - half * 0.4, y1: a.y + 3, depth: a.w });
      }
    }
    for (const p of this.people.values()) {
      if (!p.floor || !p.d) continue;
      const extra = (p.session?.interns?.length || 0) - 6;
      const holder = (p.moreLabel ||= {});
      const show = sel && sel === p.floor && extra > 0;
      place(holder, [p.d.cx + 1.2, p.floor.oy + 1.3, p.d.cz - 0.4], show ? `<span class="more">+${extra}</span>` : null, 'lbl');
    }

    // reception answers robots that come down to report
    const { W: BW, D: BD } = this.dims;
    const rs = this.recSay && this.recSay.until > this.t ? this.recSay : null;
    place((this.recHolder ||= {}), [BW / 2 - 0.6, 1.62, BD / 2 - 1.3], rs ? `<span class="say reply"><b>Reception</b><span class="say-text">${esc(rs.text)}</span></span>` : null, 'lbl talk');

    // floor tags on the facade + clickable floor areas (building view only)
    for (const f of this.floors.values()) {
      const info = this.floorInfo(f);
      const holder = (f.tagHolder ||= { onClick: () => this.showFloor(f.key) });
      const html = !sel
        ? `<span class="ftag${info.needs ? ' needs' : ''}${this.hoverFloor === f.key ? ' hover' : ''}"><b>${info.number}</b><span class="fname">${esc(f.name)}</span>${info.working ? `<i class="d w"></i>${info.working}` : ''}${info.needs ? `<i class="d n"></i>${info.needs}` : ''}</span>`
        : null;
      place(holder, [BW + 0.5, f.oy + FLOOR_H * 0.5, BD + 0.5], html, 'lbl floor', true);
      if (!sel) {
        const P = (x, y, z) => this.r.project([x, y, z], W, H);
        const y0 = f.oy - SLAB, y1 = f.oy + WALL_H;
        const faceX = [P(BW, y0, 0), P(BW, y0, BD), P(BW, y1, BD), P(BW, y1, 0)];
        const faceZ = [P(0, y0, BD), P(BW, y0, BD), P(BW, y1, BD), P(0, y1, BD)];
        if (![...faceX, ...faceZ].some((q) => q.behind)) this.hits.push({ floor: f, polys: [faceX, faceZ], depth: 1e9 });
      }
    }
  }

  bubbleText(s) {
    if (!s.current) return null;
    if (this.safe) return s.current.tool;
    const l = s.current.label || '';
    return l.length > 32 ? l.slice(0, 31) + '…' : l;
  }

  hitTest(x, y) {
    let best = null;
    for (const h of this.hits) {
      const inside = h.polys ? h.polys.some((poly) => pointInPoly(x, y, poly)) : x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1;
      if (inside && (!best || h.depth < best.depth)) best = h;
    }
    return best;
  }

  bindInput() {
    const c = this.canvas;
    const pointers = new Map();
    let drag = null, pinch = null, moved = false;
    const rect = () => c.getBoundingClientRect();

    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = false;
      if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, rotate: e.button === 2 || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey };
      else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        drag = null;
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        this.camAnim = null;
        this.cam.dist = clamp(this.cam.dist * pinch.d / d, 3, 260);
        this.cam.yaw -= ang - pinch.ang;
        this.pan(mx - pinch.mx, my - pinch.my);
        pinch = { d, ang, mx, my };
        moved = true; this.userMoved = true;
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true;
        if (moved) {
          this.camAnim = null;
          if (drag.rotate) {
            this.cam.yaw -= dx * 0.006;
            this.cam.pitch = clamp(this.cam.pitch + dy * 0.004, 0.08, 1.45);
          } else this.pan(dx, dy);
          drag.x = e.clientX; drag.y = e.clientY;
          this.userMoved = true;
          c.classList.add('dragging');
        }
        return;
      }
      const r = rect();
      const hit = this.hitTest(e.clientX - r.left, e.clientY - r.top);
      this.hoverFloor = hit?.floor ? hit.floor.key : null;
      c.classList.toggle('hovering', !!hit);
      this.onHover(hit ? (hit.floor ? { floor: this.floorInfo(hit.floor) } : hit) : null, e.clientX, e.clientY);
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (drag && !moved) {
        const r = rect();
        const hit = this.hitTest(e.clientX - r.left, e.clientY - r.top);
        if (hit?.floor) { this.hoverFloor = null; this.onHover(null); this.showFloor(hit.floor.key); }
        else this.onSelect(hit ? hit.id : null);
      }
      drag = null;
      c.classList.remove('dragging');
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { this.hoverFloor = null; this.onHover(null); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camAnim = null;
      this.cam.dist = clamp(this.cam.dist * Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0012)), 3, 260);
      this.userMoved = true;
    }, { passive: false });
  }

  pan(dx, dy) {
    const c = this.cam;
    const k = c.dist * Math.tan(c.fov / 2) * 2 / Math.max(1, this.h);
    const rx = Math.cos(c.yaw), rz = -Math.sin(c.yaw);
    const fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw);
    const fwd = dy / Math.max(0.35, Math.sin(c.pitch));
    c.target[0] += (-dx * rx + fwd * fx) * k;
    c.target[2] += (-dx * rz + fwd * fz) * k;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.w = r.width; this.h = r.height;
    this.r.resize(r.width, r.height, Math.min(2, window.devicePixelRatio || 1));
    if (!this.userMoved && this.layoutKey && !this.camAnim) { const cam = this.viewCamera(); Object.assign(this.cam, cam, { target: [...cam.target] }); }
  }
}

function norm(v) { const l = Math.hypot(...v); return v.map((x) => x / l); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
