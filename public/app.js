// Agent Office — app shell: data source, console counters, toggles, office, panel, approvals.
import { $, esc, fmtTokens, fmtCost, relTime, STATUS_LABEL, store, departmentsOf } from './util.js';
import { liveSource } from './live.js';
import { demoSource } from './demo.js';
import { Panel, Drawer } from './panel.js';
import { TaskDialog } from './tasks.js';
import { DeptDialog, TeamDialog, TeamDrawer } from './team.js';
import { hourOf, isNight, fmtHour, phaseName } from './daylight.js';

document.getElementById('boot')?.remove();

// ---------- no page zoom: only the 3D view zooms ----------
// Trackpad pinch arrives as a ctrl+wheel event; over the canvas the office handles it (and calls
// preventDefault itself), everywhere else we swallow it so the UI never scales.
addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }, { passive: false });
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) addEventListener(t, (e) => e.preventDefault(), { passive: false }); // Safari
addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && ['+', '=', '-', '_', '0'].includes(e.key)) e.preventDefault();
}, { capture: true });
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo') && params.get('demo') !== '0';
const source = DEMO ? demoSource() : liveSource();

// project: the building on show (a project key). Each building's floors are its departments.
const state = { sessions: new Map(), counters: null, approvals: [], tasks: [], showHidden: false, config: {}, org: { projects: {} }, teams: [], project: store.get(DEMO ? 'demoProject' : 'project', DEMO ? 'demo-storefront' : null) };
let office = null;

// ---------- time of day: light by day, dark by night ----------
// "Follow clock" uses the local time. Dragging the slider picks a time yourself; that choice is
// remembered until you press "Follow clock" again. ?hour=21.5 forces a time (handy for screenshots).
const root = document.documentElement;
let skyAuto = store.get('skyAuto', true);
let skyHour = store.get('skyHour', 12);
if (params.has('hour') && Number.isFinite(Number(params.get('hour')))) { skyAuto = false; skyHour = Number(params.get('hour')); }
const SUN_ICON = '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>';
const MOON_ICON = '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>';

function applyTime() {
  const h = skyAuto ? hourOf() : skyHour;
  const theme = isNight(h) ? 'dark' : 'light';
  if (office) office.hour = h;
  if (root.dataset.theme !== theme) {
    const first = !root.dataset.theme;
    if (!first) {
      // Dissolve instead of snapping: the 3D view crossfades, the page colours transition.
      office?.beginCrossfade();
      root.classList.add('theme-fading');
      clearTimeout(applyTime.fadeTimer);
      applyTime.fadeTimer = setTimeout(() => root.classList.remove('theme-fading'), 1700);
    }
    root.dataset.theme = theme;
    office?.readColors();
  }
  office?.setHour(h);
  const night = theme === 'dark';
  $('#skyIcon').innerHTML = night ? MOON_ICON : SUN_ICON;
  $('#skyLabel').textContent = skyAuto ? '' : fmtHour(h);
  $('#themeBtn').title = `Time of day: ${fmtHour(h)}${skyAuto ? ' (following your clock)' : ' (set by you)'}`;
  $('#skyTime').textContent = fmtHour(h);
  $('#skyPhase').textContent = phaseName(h);
  $('#skyAuto').setAttribute('aria-pressed', String(skyAuto));
  const range = $('#skyRange');
  if (document.activeElement !== range) range.value = String(Math.round(h * 4) / 4);
  range.setAttribute('aria-valuetext', `${fmtHour(h)}, ${phaseName(h).toLowerCase()}`);
}
applyTime();
setInterval(() => { if (skyAuto) applyTime(); }, 30_000);

const skyPop = $('#skyPop');
function toggleSky(on = skyPop.hidden) {
  skyPop.hidden = !on;
  $('#themeBtn').setAttribute('aria-expanded', String(on));
  if (on) $('#skyRange').focus();
}
$('#themeBtn').addEventListener('click', () => toggleSky());
$('#skyRange').addEventListener('input', (e) => {
  skyAuto = false;
  skyHour = Number(e.target.value) % 24;
  store.set('skyAuto', false);
  store.set('skyHour', skyHour);
  applyTime();
});
$('#skyAuto').addEventListener('click', () => {
  skyAuto = !skyAuto;
  if (!skyAuto) skyHour = hourOf();
  store.set('skyAuto', skyAuto);
  store.set('skyHour', skyHour);
  $('#skyRange').blur();
  applyTime();
});
skyPop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); toggleSky(false); $('#themeBtn').focus(); } });
document.addEventListener('pointerdown', (e) => { if (!skyPop.hidden && !e.target.closest('.sky-wrap')) toggleSky(false); });

let safe = store.get('safe', false);
function applySafe() {
  document.body.classList.toggle('safe', safe);
  $('#filmBtn').setAttribute('aria-pressed', String(safe));
  office?.setSafe(safe);
}
$('#filmBtn').addEventListener('click', () => { safe = !safe; store.set('safe', safe); applySafe(); });

// ---------- buy me a coffee (€2,99), link set once in <meta name="donate"> ----------
// Until a real https link is set the button stays visible but inert, so the placeholder never opens.
{
  const btn = $('#coffeeBtn');
  const link = document.querySelector('meta[name="donate"]')?.content?.trim() || '';
  if (/^https:\/\//i.test(link) && !link.includes('YOUR-COFFEE-LINK')) {
    btn.href = link;
  } else {
    btn.setAttribute('aria-disabled', 'true');
    btn.title = 'Buy me a coffee · €2,99 (checkout link coming soon)';
  }
}

let chime = store.get('chime', false);
let audio = null;
function applyChime() { $('#chimeBtn').setAttribute('aria-pressed', String(chime)); }
$('#chimeBtn').addEventListener('click', () => {
  chime = !chime; store.set('chime', chime); applyChime();
  if (chime) { ensureAudio(); playChime(); }
});
function ensureAudio() {
  try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch {}
}
document.addEventListener('pointerdown', () => { if (chime) ensureAudio(); }, { once: true });
function playChime() {
  if (!chime || !audio) return;
  const t = audio.currentTime;
  for (const [i, f] of [[0, 880], [1, 1318.5]]) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0, t + i * 0.12);
    g.gain.linearRampToValueAtTime(0.18, t + i * 0.12 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.6);
    o.connect(g).connect(audio.destination);
    o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.65);
  }
}

// ---------- panel + drawer ----------
const panel = new Panel(source, {
  onOpenSession: (id) => select(id),
  onClose: () => office?.setSelected(null),
  onGiveTask: (id) => taskDlg.open({ sessionId: id }),
  getConfig: () => state.config,
  getDepartments: (key) => departmentsOf(state.org, key),
  onMove: async (s, dept) => {
    const r = await source.assign(s.projectKey, s.id, dept);
    if (r.error) toast(esc(r.error), { kind: 'bad' });
    else toast(`Moving to ${esc(departmentsOf(state.org, s.projectKey).find((d) => d.id === dept)?.name || dept)}: the robot takes the lift.`, { ms: 3500 });
  },
  onSendHome: (id) => sendHome([id]),
});
const drawer = new Drawer(source);
drawer.onOpen = (id) => select(id);
$('#approvalsBtn').addEventListener('click', () => { teamDrawer.toggle(false); drawer.toggle(); });

function select(id) {
  if (!id) { panel.close(); return; }
  // A robot in another building: switch buildings first.
  const s = state.sessions.get(String(id).split('/')[0]);
  if (s && s.projectKey !== state.project) { setProject(s.projectKey); renderNow(); }
  office?.focusSession(id);
  office?.setSelected(id);
  panel.open(id);
}

// ---------- buildings (projects) ----------
const projectSel = $('#projectSel');

/** Every building: projects with robots on show, plus ones with departments set up. Most recent first. */
function projectsList() {
  const map = new Map();
  for (const s of visibleSessions()) {
    let p = map.get(s.projectKey);
    if (!p) map.set(s.projectKey, (p = { key: s.projectKey, name: s.project, repo: false, last: 0, robots: 0, working: 0, needs: 0 }));
    p.robots++;
    p.repo ||= !!s.repo;
    p.last = Math.max(p.last, s.lastActivity || 0);
    if (s.status === 'working') p.working++;
    if (s.status === 'needs_you') p.needs++;
  }
  for (const [key, o] of Object.entries(state.org.projects || {})) {
    if (!map.has(key) && o.name) map.set(key, { key, name: o.name, repo: false, last: 0, robots: 0, working: 0, needs: 0 });
  }
  // Alphabetical, so the menu doesn't reshuffle while robots work.
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}
const mostRecent = (list) => list.reduce((b, p) => (!b || p.last > b.last ? p : b), null);

function currentProject() { return projectsList().find((p) => p.key === state.project) || null; }

function setProject(key) {
  if (!key || key === state.project) return;
  state.project = key;
  store.set(DEMO ? 'demoProject' : 'project', key);
  showAllBranches = false;
  // The open robot works in another building now on show: close its panel.
  const open = panel.openId && state.sessions.get(panel.openId.split('/')[0]);
  if (open && open.projectKey !== key) panel.close();
}

function renderProjects(list) {
  const html = list.length
    ? list.map((p) => {
      const bits = [p.needs ? `${p.needs} need${p.needs === 1 ? 's' : ''} you` : '', p.working ? `${p.working} working` : ''].filter(Boolean).join(', ');
      return `<option value="${esc(p.key)}">${p.needs ? '● ' : ''}${esc(p.name)}${bits ? ` · ${esc(bits)}` : ''}</option>`;
    }).join('')
    : '<option value="" disabled selected>No projects yet</option>';
  // Don't rewrite the options while the menu is open: that would close it.
  if (document.activeElement === projectSel) return;
  if (projectSel.dataset.html !== html) { projectSel.innerHTML = html; projectSel.dataset.html = html; }
  if (state.project) projectSel.value = state.project;
}
projectSel.addEventListener('change', () => { setProject(projectSel.value); renderNow(); projectSel.blur(); });

// ---------- sending robots home (by taxi) ----------
// The robots leave straight away; the server then hides their sessions until they do something
// new. Nothing is deleted. If the server says no, the robots turn round and go back to work.
async function sendHome(ids) {
  const key = state.project;
  const list = ids.map((id) => state.sessions.get(id)).filter((s) => s && s.projectKey === key);
  if (!list.length) return;
  for (const s of list) office?.sendHome(s.id);
  if (panel.openId && list.some((s) => s.id === panel.openId)) panel.close();
  const r = await source.dismiss(key, list.map((s) => s.id));
  if (r.error) {
    for (const s of list) office?.comeBack(s.id);
    toast(esc(r.error), { kind: 'bad' });
    return;
  }
  for (const k of r.skipped || []) office?.comeBack(k.id);
  const n = r.dismissed?.length || 0;
  if (n) toast(n === 1 ? 'A robot is on its way home by taxi. It comes back if its session is used again.' : `${n} robots are on their way home by taxi.`, { ms: 4500 });
  if (r.skipped?.length) {
    const why = [...new Set(r.skipped.map((k) => k.reason))].join(' ');
    toast(`${r.skipped.length === 1 ? 'A robot stayed' : `${r.skipped.length} robots stayed`}: ${esc(why)}`, { kind: 'bad', ms: 7000 });
  }
}

/** Robots that can go home in a clean-up: nothing has happened for a while (idle) or the session ended. */
function idleRobots() {
  return visibleSessions().filter((s) => s.projectKey === state.project && (s.status === 'idle' || s.status === 'ended') && !s.task);
}

$('#cleanBtn').addEventListener('click', () => {
  const list = idleRobots();
  const name = currentProject()?.name || 'this building';
  if (!list.length) {
    toast(`No idle robots in ${esc(name)}. To send a robot home that isn't idle yet, open it and press <b>🚕 Send home</b>.`, { ms: 6000 });
    return;
  }
  const ok = confirm(`Send ${list.length} idle robot${list.length === 1 ? '' : 's'} in ${name} home by taxi?\n\nThey leave the office. Their transcripts stay on disk, and a robot comes back as soon as its session is used again.`);
  if (ok) sendHome(list.map((s) => s.id));
});

// ---------- departments ----------
const deptDlg = new DeptDialog(source, () => ({ org: state.org, project: state.project, projectName: currentProject()?.name }));
$('#deptAdd').addEventListener('click', () => deptDlg.open(state.project, { add: true }));
$('#deptEdit').addEventListener('click', () => deptDlg.open(state.project));

// ---------- teams ----------
const teamDlg = new TeamDialog(source, () => ({ org: state.org, config: state.config, projectName: currentProject()?.name }), (run) => {
  teamDrawer.toggle(true);
  toast(`The team is on it: ${esc(run?.departments?.find((d) => d.id === run.current?.dept)?.name || 'the first department')} starts.`, { ms: 4000 });
});
const teamDrawer = new TeamDrawer(source, {
  onOpenSession: (id) => select(id),
  onStart: () => teamDlg.open(state.project),
  onShowFloor: (dept) => office?.showFloor(dept),
});
$('#teamBtn').addEventListener('click', () => { drawer.toggle(false); teamDrawer.toggle(); });

// New team messages play out in the building: the sender takes the lift to whoever it is
// talking to, and both get a speech bubble.
const seenMessages = new Set();
let prevRuns = new Map();
function setTeams(list, initial = false) {
  for (const r of list) {
    for (const m of r.messages) {
      if (seenMessages.has(m.id)) continue;
      seenMessages.add(m.id);
      if (initial || r.projectKey !== state.project) continue;
      office?.deliver({ from: m.from?.sessionId || null, to: m.to?.sessionId || null, toDept: m.to?.dept || null, say: safe ? `${m.from?.name || 'You'} → ${m.to?.name || 'you'}` : m.say, done: !m.to });
    }
    const was = prevRuns.get(r.id);
    if (!initial && was === 'running' && r.status !== 'running') {
      const last = r.messages.at(-1);
      const where = r.projectKey === state.project ? '' : ` in ${esc(r.project)}`;
      if (r.status === 'done') toast(`Team done${where}: <span class="sensitive">${esc(last?.say || r.goal)}</span>`, { ms: 9000 });
      else if (r.status === 'limit') toast(`The team ran out of turns${where}. See the team feed for where it got to.`, { ms: 9000 });
      else if (r.status === 'failed') toast(`Team stopped${where}: <span class="sensitive">${esc(r.error || 'a turn failed')}</span>`, { kind: 'bad', ms: 12000 });
    }
  }
  prevRuns = new Map(list.map((r) => [r.id, r.status]));
  state.teams = list;
  const running = list.filter((r) => r.status === 'running').length;
  const b = $('#teamBadge');
  b.hidden = !running;
  b.textContent = running;
  teamDrawer.set(list, state.project, currentProject()?.name);
}

// ---------- tasks ----------
let pendingHire = null; // session id of a robot we just hired, to fly to when it walks in
const taskDlg = new TaskDialog(source, () => state, (task) => {
  branchCache.clear(); // a task may have created a branch or a worktree
  if (task.newRobot) {
    pendingHire = task.sessionId;
    toast(`Hiring a robot on ${esc(task.project)}${task.branch ? ` · ⎇ <span class="sensitive">${esc(task.branch)}</span>` : ''}…`);
    if (state.sessions.has(task.sessionId)) { select(task.sessionId); pendingHire = null; }
  } else {
    select(task.sessionId);
  }
});
function openTaskDialog() {
  const id = panel.openId && !panel.openId.includes('/') ? panel.openId : null;
  const dept = office?.view?.mode === 'floor' ? office.view.key : null;
  taskDlg.open(id ? { sessionId: id } : state.project ? { projectKey: state.project, dept, branch: (dept && office.view.branch) || null } : null);
}
$('#taskBtn').addEventListener('click', openTaskDialog);

const toasts = $('#toasts');
function toast(html, { kind = '', open = null, ms = 6000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${html}</span>${open ? '<button class="link-btn">Open</button>' : ''}<button class="icon-btn" aria-label="Dismiss">✕</button>`;
  el.querySelector('.link-btn')?.addEventListener('click', () => { select(open); el.remove(); });
  el.querySelector('.icon-btn').addEventListener('click', () => el.remove());
  toasts.append(el);
  setTimeout(() => el.remove(), ms);
}

let prevTasks = new Map();
function setTasks(list) {
  for (const t of list) {
    const was = prevTasks.get(t.id);
    if (!was || was === t.status || t.status === 'running') continue;
    const s = state.sessions.get(t.sessionId);
    const who = s ? `<span class="sensitive">${esc(s.title)}</span>` : esc(t.project);
    const canOpen = s ? t.sessionId : null;
    if (t.status === 'failed') {
      toast(`Task failed: ${who}${t.error ? `<br><small class="sensitive">${esc(t.error.split('\n').filter(Boolean).at(-1).slice(0, 160))}</small>` : ''}`, { kind: 'bad', open: canOpen, ms: 12000 });
      if (pendingHire === t.sessionId) pendingHire = null;
    } else if (t.status === 'done' && panel.openId !== t.sessionId) {
      toast(`Task done: ${who}`, { open: canOpen });
    }
  }
  prevTasks = new Map(list.map((t) => [t.id, t.status]));
  state.tasks = list;
  const running = list.filter((t) => t.status === 'running').length;
  const b = $('#tasksBadge');
  b.hidden = !running;
  b.textContent = running;
  $('#taskBtn').title = running ? `${running} task${running === 1 ? '' : 's'} running. Give a robot a task (T)` : 'Give a robot a task (T)';
  panel.setTasks(list);
}

// ---------- floor menu ----------
// Floors are the departments of the building on show. The open floor shows its branches: the
// ones with robots first, then (folded) the repo's other branches, which come from git via the
// server. Click a branch to fly to its zone; "+" gives a new robot a task on that branch.
const floorsList = $('#floorsList');
const branchCache = new Map(); // project key -> { at, info }
let lastFloors = { list: [], view: { mode: 'building' } };
let showAllBranches = false;

async function loadBranches(key, force = false) {
  const hit = branchCache.get(key);
  if (!force && hit && Date.now() - hit.at < 20_000) return;
  if (!source.branches) return;
  branchCache.set(key, { at: Date.now(), info: hit?.info || null });
  const info = await source.branches(key);
  branchCache.set(key, { at: Date.now(), info });
  renderFloors(lastFloors.list, lastFloors.view);
}

function branchRows(f, view) {
  if (!f.repo) return '';
  const focus = view.branch || null;
  const fromGit = branchCache.get(state.project)?.info;
  const withBots = new Map(f.branches.map((b) => [b.name, b]));
  const others = (fromGit?.branches || []).filter((b) => !withBots.has(b.name));
  const row = (b, bots) => `<div class="branch-row${focus === b.name ? ' active' : ''}${b.needs ? ' needs' : ''}" role="listitem">
      <button class="branch-btn" data-branch="${esc(b.name)}" data-floor-key="${esc(f.key)}" title="${bots ? 'Fly to this branch' : 'No robots on this branch yet'}">
        <span class="bicon">⎇</span><span class="bname sensitive">${esc(b.name)}</span>
        <span class="fmeta">${b.needs ? `<i class="d n"></i>${b.needs}` : ''}${b.working ? `<i class="d w"></i>${b.working}` : ''}${bots && !b.needs && !b.working ? `<span class="muted">${b.robots}</span>` : ''}</span>
      </button>
      <button class="branch-add" data-task-branch="${esc(b.name)}" data-floor-key="${esc(f.key)}" title="Give a new robot a task on ${esc(b.name)}" aria-label="New task on ${esc(b.name)}">+</button>
    </div>`;
  const shown = showAllBranches ? others : [];
  return `<div class="branches" role="list" aria-label="Branches of ${esc(f.name)}">
      <button class="branch-btn all${!focus ? ' active' : ''}" data-branch="" data-floor-key="${esc(f.key)}"><span class="bicon">◎</span><span class="bname">All branches</span></button>
      ${f.branches.map((b) => row(b, true)).join('')}
      ${others.length ? `<button class="branch-more" data-more>${showAllBranches ? 'Hide' : 'Show'} ${others.length} other branch${others.length === 1 ? '' : 'es'}</button>` : ''}
      ${shown.map((b) => row(b, false)).join('')}
      <button class="branch-new" data-new-branch="${esc(f.key)}">＋ New branch…</button>
    </div>`;
}

// The bar at the top of the 3D view while you're inside a floor: which floor, which branch
// (a dropdown with every branch of the repo), and a button for a task right here.
const floorBar = $('#floorBar'), fbBranch = $('#fbBranch');
function renderFloorBar(list, view) {
  const f = view.mode === 'floor' ? list.find((x) => x.key === view.key) : null;
  floorBar.hidden = !f;
  if (!f) return;
  $('#fbFloor').innerHTML = `<b>${f.number}</b> ${esc(f.name)}`;
  $('#fbBranchWrap').hidden = !f.repo;
  const note = $('#fbNote');
  note.hidden = f.repo;
  note.textContent = f.repo ? '' : 'Not a git repo, so no branches';
  $('#fbTaskLabel').textContent = view.branch ? `Task on ${view.branch}` : 'New task here';
  if (!f.repo) return;
  const fromGit = branchCache.get(state.project)?.info;
  const withBots = new Map(f.branches.map((b) => [b.name, b]));
  const others = (fromGit?.branches || []).filter((b) => !withBots.has(b.name));
  const count = (b) => [b.working ? `${b.working} working` : '', b.needs ? `${b.needs} need${b.needs === 1 ? 's' : ''} you` : '', !b.working && !b.needs ? `${b.robots} robot${b.robots === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
  const html = `<option value="">All branches (${f.branches.length})</option>`
    + `<optgroup label="With robots">${f.branches.map((b) => `<option value="${esc(b.name)}">${esc(b.name)} · ${esc(count(b))}</option>`).join('')}</optgroup>`
    + (others.length ? `<optgroup label="Other branches">${others.map((b) => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join('')}</optgroup>` : '')
    + '<option value="__new__">＋ New branch…</option>';
  if (fbBranch.dataset.html !== html) { fbBranch.innerHTML = html; fbBranch.dataset.html = html; }
  fbBranch.value = view.branch || '';
  floorBar.dataset.key = f.key;
}
fbBranch.addEventListener('change', () => {
  const key = floorBar.dataset.key;
  const v = fbBranch.value;
  if (v === '__new__') { fbBranch.value = lastFloors.view.branch || ''; taskDlg.open({ projectKey: state.project, dept: key, newBranch: true }); return; }
  // A branch without robots on this floor has no desks to fly to: offer a task on it straight away.
  const hasBots = lastFloors.list.find((x) => x.key === key)?.branches.some((b) => b.name === v);
  if (v && !hasBots) { fbBranch.value = lastFloors.view.branch || ''; taskDlg.open({ projectKey: state.project, dept: key, branch: v }); return; }
  office?.showBranch(key, v || null);
});
$('#fbTask').addEventListener('click', () => {
  const v = lastFloors.view;
  if (v.mode === 'floor') taskDlg.open({ projectKey: state.project, dept: v.key, branch: v.branch || null });
});

function renderFloors(list, view) {
  lastFloors = { list, view };
  renderFloorBar(list, view);
  const building = `<button class="floor-btn building${view.mode === 'building' ? ' active' : ''}" data-floor="" role="listitem">
      <span class="fnum">⌂</span><span class="fname">Building</span><span class="fmeta">${list.length} floor${list.length === 1 ? '' : 's'}</span></button>`;
  floorsList.innerHTML = building + list.map((f) => {
    const active = view.mode === 'floor' && view.key === f.key;
    if (active && f.repo && state.project) loadBranches(state.project);
    return `<button class="floor-btn${active ? ' active' : ''}${f.needs ? ' needs' : ''}" data-floor="${esc(f.key)}" role="listitem" title="${esc(f.name)}: ${f.sessions} robot${f.sessions === 1 ? '' : 's'}">
      <span class="fnum">${f.number}</span>
      <span class="fname">${esc(f.name)}</span>
      <span class="fmeta">${f.needs ? `<i class="d n"></i>${f.needs}` : ''}${f.working ? `<i class="d w"></i>${f.working}` : ''}${!f.needs && !f.working ? `<span class="muted">${f.sessions}</span>` : ''}</span>
    </button>${active ? branchRows(f, view) : ''}`;
  }).join('') + '<div class="floors-lobby"><span class="fnum">L</span>Lobby</div>';
}
floorsList.addEventListener('click', (e) => {
  const add = e.target.closest('[data-task-branch]');
  if (add) { taskDlg.open({ projectKey: state.project, dept: add.dataset.floorKey, branch: add.dataset.taskBranch }); return; }
  const nb = e.target.closest('[data-new-branch]');
  if (nb) { taskDlg.open({ projectKey: state.project, dept: nb.dataset.newBranch, newBranch: true }); return; }
  if (e.target.closest('[data-more]')) { showAllBranches = !showAllBranches; renderFloors(lastFloors.list, lastFloors.view); return; }
  const br = e.target.closest('[data-branch]');
  if (br) { office?.showBranch(br.dataset.floorKey, br.dataset.branch || null); return; }
  const b = e.target.closest('[data-floor]');
  if (!b) return;
  showAllBranches = false;
  if (b.dataset.floor) office?.showFloor(b.dataset.floor); else office?.showBuilding();
});

$('#cNeeds').addEventListener('click', () => {
  const s = visibleSessions().find((x) => x.status === 'needs_you');
  if (s) select(s.id);
  else if (state.approvals.length) drawer.toggle(true);
});
$('#hiddenBtn').addEventListener('click', () => { state.showHidden = !state.showHidden; renderAll(); });

// ---------- office ----------
const tooltip = $('#tooltip');
try {
  const { Office } = await import('./office.js');
  office = new Office($('#office'), {
    onSelect: (id) => select(id),
    onFloors: (list, view) => renderFloors(list, view),
    onHover: (hit, x, y) => {
      if (!hit) { tooltip.hidden = true; return; }
      let html;
      if (hit.floor) {
        const f = hit.floor;
        html = `<b>Floor ${f.number} · ${esc(f.name)}</b><div class="muted">${f.sessions} session${f.sessions === 1 ? '' : 's'} · ${f.working} working${f.needs ? ` · <span style="color:var(--needs)">${f.needs} need${f.needs === 1 ? 's' : ''} you</span>` : ''}${f.yourTurn ? ` · ${f.yourTurn} your turn` : ''}${f.idle ? ` · ${f.idle} idle` : ''}</div><div class="muted">Click to go inside</div>`;
      } else if (hit.intern) {
        const i = hit.intern;
        html = `<b>${esc(i.type)} intern</b><span class="sensitive">${esc(i.description)}</span><div class="muted">${esc(STATUS_LABEL[i.status] || i.status)}${i.current ? ' · <span class="sensitive">' + esc(safe ? i.current.tool : i.current.label) + '</span>' : ''}</div>`;
      } else {
        const s = hit.session;
        html = `<b class="sensitive">${esc(s.title)}</b><div class="muted">${esc(s.project)} · ${esc(STATUS_LABEL[s.status] || s.status)}${s.reason && s.status !== 'working' ? ' (' + esc(s.reason) + ')' : ''}</div><div class="muted">${fmtTokens(s.tokens.total)} tokens · ${fmtCost(s.cost)} est. · ${relTime(s.lastActivity)}</div>`;
      }
      tooltip.innerHTML = html;
      tooltip.hidden = false;
      const r = tooltip.getBoundingClientRect();
      tooltip.style.left = Math.min(innerWidth - r.width - 8, x + 14) + 'px';
      tooltip.style.top = Math.min(innerHeight - r.height - 8, y + 14) + 'px';
    },
  });
  applyTime();
  office.start();
  // `npm run record-demo` drives the page through this handle; it only exists with ?record=1.
  if (params.has('record')) window.__ao = { office, panel, taskDlg, drawer, teamDlg, teamDrawer, deptDlg, select, state, source, setProject: (k) => { setProject(k); renderNow(); } };
  if (params.has('zoom')) setTimeout(() => office.zoomBy(Number(params.get('zoom')) || 1), 50);
  $('#zoomIn').addEventListener('click', () => office.zoomBy(1.25));
  $('#zoomOut').addEventListener('click', () => office.zoomBy(0.8));
  $('#zoomFit').addEventListener('click', () => office.fit());
} catch (e) {
  console.error(e);
  $('#empty').hidden = false;
  $('#empty').innerHTML = `<h2>3D view unavailable</h2><p>${esc(e.message)}</p><p>Your browser needs WebGL2. The console, panel and approvals still work.</p>`;
}
applySafe();
applyChime();

// ---------- rendering ----------
function visibleSessions() {
  return [...state.sessions.values()].filter((s) => state.showHidden || !s.hidden);
}

let raf = 0;
function renderAll() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; renderNow(); });
}

function renderNow() {
  const vis = visibleSessions();
  const projects = projectsList();
  if (!projects.some((p) => p.key === state.project) && projects.length) state.project = mostRecent(projects).key;
  const cur = projects.find((p) => p.key === state.project) || null;
  renderProjects(projects);
  $('#deptAdd').disabled = $('#deptEdit').disabled = $('#cleanBtn').disabled = !cur;
  $('#teamBtn').disabled = !cur;
  office?.setProject(cur ? { key: cur.key, name: cur.name, repo: cur.repo, departments: departmentsOf(state.org, cur.key) } : null);
  office?.setSessions(vis.filter((s) => s.projectKey === state.project));
  teamDrawer.set(state.teams, state.project, cur?.name);
  const hiddenCount = [...state.sessions.values()].filter((s) => s.hidden && s.status !== 'ended').length;
  const hb = $('#hiddenBtn');
  hb.hidden = !hiddenCount && !state.showHidden;
  // Hidden: older sessions, and robots you sent home.
  hb.textContent = state.showHidden ? 'Hide older and sent-home sessions' : `Show ${hiddenCount} hidden session${hiddenCount === 1 ? '' : 's'}`;
  if (office) {
    $('#empty').hidden = vis.length > 0;
    $('#emptyHours').textContent = state.config.hideOlderThanHours ?? 12;
  }
  renderCounters();
  renderApprovals();
}

function renderCounters() {
  const c = state.counters;
  if (!c) return;
  $('#vNeeds').textContent = c.needsYou;
  $('#cNeeds').classList.toggle('active', c.needsYou > 0);
  $('#vWorking').textContent = c.working;
  $('#vInterns').textContent = c.interns ? `+${c.interns} intern${c.interns === 1 ? '' : 's'}` : '';
  $('#vTokens').textContent = fmtTokens(c.tokensToday);
  const b = c.tokensTodayBreakdown;
  if (b) $('#cTokens').title = `Input ${b.input.toLocaleString()}\nOutput ${b.output.toLocaleString()}\nCache read ${b.cacheRead.toLocaleString()}\nCache write ${(b.cacheWrite5m + b.cacheWrite1h).toLocaleString()}`;
  $('#vCost').textContent = fmtCost(c.costToday);
  document.title = c.needsYou ? `(${c.needsYou}) Agent Office` : 'Agent Office';
}

function renderApprovals() {
  const n = state.approvals.length;
  const badge = $('#approvalsBadge');
  badge.hidden = !n;
  badge.textContent = n;
  const hint = DEMO
    ? 'Demo approvals: decisions only affect the simulation.'
    : 'Allow or Deny answers Claude Code directly. If nobody answers in time, the normal terminal prompt appears.';
  drawer.set(state.approvals, hint);
}

// ---------- chime on new needs_you ----------
const prevStatus = new Map();
function checkNeeds(s) {
  const was = prevStatus.get(s.id);
  prevStatus.set(s.id, s.status);
  if (s.status === 'needs_you' && was && was !== 'needs_you' && !s.hidden) playChime();
}

// ---------- data ----------
const conn = $('#connState');
let knownApprovals = new Set();
source.connect({
  status(st) {
    if (st === 'demo') { $('#modeChip').hidden = false; conn.textContent = 'Simulated agents'; conn.className = 'conn'; return; }
    conn.textContent = st === 'live' ? '' : 'Reconnecting to the local server…';
    conn.className = st === 'live' ? 'conn' : 'conn bad';
  },
  state(s) {
    state.sessions = new Map(s.sessions.map((x) => [x.id, x]));
    for (const x of s.sessions) prevStatus.set(x.id, x.status);
    state.counters = s.counters;
    state.approvals = s.approvals || [];
    state.config = s.config || {};
    state.org = s.org || { projects: {} };
    setTasks(s.tasks || []);
    setTeams(s.teams || [], true);
    knownApprovals = new Set(state.approvals.map((a) => a.id));
    renderAll();
  },
  org(o) { state.org = o; renderAll(); },
  teams(list) { setTeams(list); },
  session(s) {
    checkNeeds(s);
    state.sessions.set(s.id, s);
    if (pendingHire === s.id) { pendingHire = null; renderNow(); select(s.id); }
    renderAll();
    if (panel.openId && (panel.openId === s.id || panel.openId.startsWith(s.id + '/'))) throttledPanelRefresh();
  },
  counters(c) { state.counters = c; renderCounters(); },
  tasks(list) { setTasks(list); },
  approvals(list) {
    const fresh = list.filter((a) => !knownApprovals.has(a.id));
    knownApprovals = new Set(list.map((a) => a.id));
    state.approvals = list;
    renderApprovals();
    if (fresh.length) { if (!DEMO) drawer.toggle(true); playChime(); }
    if (panel.openId) throttledPanelRefresh();
  },
});

let lastPanelRefresh = 0, panelTimer = null;
function throttledPanelRefresh() {
  const wait = 800 - (Date.now() - lastPanelRefresh);
  if (wait <= 0) { lastPanelRefresh = Date.now(); panel.refresh(); return; }
  clearTimeout(panelTimer);
  panelTimer = setTimeout(() => { lastPanelRefresh = Date.now(); panel.refresh(); }, wait);
}

addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select') || taskDlg.isOpen || teamDlg.isOpen || deptDlg.isOpen) return;
  if ((e.key === 't' || e.key === 'T') && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); openTaskDialog(); return; }
  if (e.key === 'Escape') {
    if (!$('#teamDrawer').hidden) teamDrawer.toggle(false);
    else if (!$('#drawer').hidden) drawer.toggle(false);
    else if (panel.openId) panel.close();
    else office?.showBuilding();
  }
  if (e.key === 'f') office?.fit();
  if (e.key === 'b') office?.showBuilding();
  if (e.key === ']' || e.key === 'PageUp') { e.preventDefault(); office?.stepFloor(1); }
  if (e.key === '[' || e.key === 'PageDown') { e.preventDefault(); office?.stepFloor(-1); }
});
