// ?demo=1 — simulated agents so the office can be shown without real sessions.
// Produces the same shapes as the server API. Never talks to the server.

const PROJECTS = [
  { key: 'demo-storefront', name: 'storefront', cwd: '/demo/storefront', branch: 'main' },
  { key: 'demo-api', name: 'payments-api', cwd: '/demo/payments-api', branch: 'feat/refunds' },
  { key: 'demo-docs', name: 'docs-site', cwd: '/demo/docs-site', branch: 'main' },
  { key: 'demo-ml', name: 'forecasting', cwd: '/demo/forecasting', branch: 'exp/seasonality' },
];
// Project files per building (the Files button). A couple to start with, so the drawer has something in it.
const DEMO_FILES = {
  'demo-storefront': [
    { name: 'brand-guidelines.pdf', size: 2_480_000, mtime: Date.now() - 3 * 86400_000 },
    { name: 'checkout-flow.png', size: 640_000, mtime: Date.now() - 86400_000 },
    { name: 'product-brief.md', size: 7_200, mtime: Date.now() - 2 * 3600_000 },
  ],
};
const filesOf = (key) => ({ dir: `~/.agent-office/files/${String(key).replace(/^demo-/, '')}`, files: (DEMO_FILES[key] || []).slice() });
const TITLES = [
  'Add dark mode toggle to settings', 'Fix flaky checkout test', 'Refund endpoint with idempotency keys',
  'Migrate docs to new sidebar', 'Speed up product image loading', 'Investigate memory leak in worker',
  'Write release notes for 2.4', 'Tune seasonality model', 'Add rate limiting to webhooks',
];
const TOOLS = [
  ['Read', (f) => ({ file_path: f })], ['Edit', (f) => ({ file_path: f })], ['Grep', () => ({ pattern: 'useCart' })],
  ['Bash', () => ({ command: 'npm test -- --watch=false' })], ['Glob', () => ({ pattern: 'src/**/*.tsx' })],
  ['Write', (f) => ({ file_path: f })], ['Bash', () => ({ command: 'git diff --stat' })], ['WebFetch', () => ({ url: 'https://example.com/docs' })],
];
const FILES = ['src/App.tsx', 'src/cart/useCart.ts', 'server/refunds.ts', 'docs/sidebar.md', 'model/seasonal.py', 'README.md', 'src/theme.css'];
const INTERN_TASKS = [['Explore', 'Find all cart mutations'], ['general-purpose', 'Audit webhook retries'], ['Plan', 'Plan the migration'], ['Explore', 'Locate image loaders']];

// Departments (floors) of each demo building, floor 1 first.
const PRESETS = [
  { id: 'product', name: 'Product', role: 'Turn the goal into clear requirements and acceptance criteria. Decide scope and priorities. Do not write code.' },
  { id: 'design', name: 'Design', role: 'Design the user experience: flows, layout, copy and visual details. Write short specs and change UI markup and styles; leave core logic to Development.' },
  { id: 'development', name: 'Development', role: 'Implement features and fixes in the code. Keep changes focused, follow the existing style, and run the build and tests you touch.' },
  { id: 'qa', name: 'QA', role: 'Review and test the work: run the tests, try edge cases, and report bugs back with exact steps to reproduce. Fix only trivial issues yourself.' },
  { id: 'docs', name: 'Docs', role: 'Write and update documentation, README sections and changelogs for the work that was done.' },
  { id: 'devops', name: 'DevOps', role: 'Handle build, CI, deployment and tooling configuration.' },
  { id: 'security', name: 'Security', role: 'Review the changes for security problems and report concrete risks, each with a fix.' },
  { id: 'research', name: 'Research', role: 'Investigate options: read code, docs and data, and report findings with a recommendation. Do not change code.' },
];
const preset = (id) => ({ ...PRESETS.find((p) => p.id === id) });
const DEMO_DEPTS = {
  'demo-storefront': ['product', 'design', 'development', 'qa'].map(preset),
  'demo-api': ['development', 'qa', 'security'].map(preset),
  'demo-docs': ['design', 'docs'].map(preset),
  'demo-ml': ['research', 'development'].map(preset),
};
// What each department says when it hands the work on (first pass, and after a fix).
const LINES = {
  product: ['Spec is ready: saved per user, max 50 items, shareable link.', 'Scope is set. Acceptance criteria are in the ticket.'],
  design: ['Mockups done: a heart on every card and a Wishlist page.', 'Flows and copy are ready. Empty state included.'],
  development: ['It\'s built and the tests pass. Over to you!', 'Fixed the edge case and added a test for it.'],
  qa: ['Found a bug: removing the last item leaves an empty header.', 'All green on mobile and desktop. Ship it!'],
  security: ['No injection or auth issues. One rate limit added.', 'Reviewed again: all clear.'],
  docs: ['Docs are written: README section and changelog entry.', 'Docs updated with the final screenshots.'],
  research: ['Option B is 18% more accurate. Details in my notes.', 'Ran it on last year\'s data: it holds up.'],
  devops: ['CI is green and the preview deploy is live.', 'Deploy config updated.'],
};
const TEAM_GOALS = {
  'demo-storefront': 'Add a wishlist to the product pages, with tests',
  'demo-api': 'Add webhook signing with rotating secrets',
  'demo-docs': 'Redesign the getting-started guide',
  'demo-ml': 'Add holiday effects to the seasonality model',
};
const DEMO_DEPT_OF = ['development', 'design', 'development', 'development', 'qa', 'docs', 'docs', 'research', 'development'];
// `npm run record-demo` (?record=1) starts its own team, and quicker.
const RECORDING = typeof location !== 'undefined' && new URLSearchParams(location.search).has('record');

function label(name, input) {
  const base = (p) => String(p || '').split('/').pop();
  if (['Read', 'Edit', 'Write'].includes(name)) return `${name} ${base(input.file_path)}`;
  if (name === 'Bash') return `Bash ${input.command}`;
  if (name === 'Grep') return `Grep "${input.pattern}"`;
  if (name === 'Glob') return `Glob ${input.pattern}`;
  if (name === 'WebFetch') return 'WebFetch example.com';
  return name;
}

export function demoSource() {
  const rnd = (n) => Math.floor(Math.random() * n);
  const now = () => Date.now();
  const sessions = [];
  const approvals = [];
  const tasks = [];
  const teams = [];
  const org = { projects: Object.fromEntries(PROJECTS.map((p) => [p.key, { name: p.name, departments: DEMO_DEPTS[p.key].map((d) => ({ ...d })) }])), presets: PRESETS, defaults: [{ id: 'general', name: 'General', role: '' }] };
  const orgView = () => JSON.parse(JSON.stringify(org));
  const deptsOf = (key) => org.projects[key]?.departments || org.defaults;
  let h = null;
  let costToday = 3.12, tokensToday = 1840000;

  const plan = [
    [0, 'working', 'main'], [0, 'your_turn', 'feature/dark-mode'], [0, 'needs_you', 'feature/dark-mode'],
    [1, 'working', 'feat/refunds'], [1, 'idle', 'main'], [2, 'your_turn', 'main'], [2, 'working', 'docs/new-sidebar'],
    [3, 'working', 'exp/seasonality'], [3, 'needs_you', 'main'],
  ];
  const EXTRA_BRANCHES = { 'demo-storefront': ['fix/checkout-flake', 'release/2.4'], 'demo-api': ['feat/webhooks'], 'demo-docs': [], 'demo-ml': ['exp/holidays'] };
  const branchPath = (p, b) => (b === p.branch ? p.cwd : `~/agent-office-worktrees/${p.name}/${b.replace(/[^A-Za-z0-9._-]+/g, '-')}`);
  plan.forEach(([pi, status, br], i) => {
    const p = PROJECTS[pi];
    sessions.push({
      id: `demo-${i}`, project: p.name, projectKey: p.key, cwd: branchPath(p, br), branch: br, repo: true, worktree: br === p.branch ? null : branchPath(p, br), dept: DEMO_DEPT_OF[i], team: null,
      title: TITLES[i % TITLES.length], model: i % 3 === 0 ? 'claude-sonnet-5-5' : 'claude-opus-5-5', entrypoint: 'cli',
      status, reason: '', source: 'transcript', hooks: i % 2 === 0, current: null,
      startedAt: now() - (60 + i * 7) * 60000, lastActivity: now() - (status === 'idle' ? 45 * 60000 : rnd(60000)),
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, total: 0 }, cost: 0,
      context: { used: 40000 + rnd(300000), window: 1000000, pct: 0 }, steps: 0, errors: 0, files: 0, interns: [], pending: 0, hidden: false,
      _steps: [], _convo: [], _files: new Map(), _next: now() + 1000 + rnd(4000),
    });
  });
  for (const s of sessions) {
    s._convo.push({ role: 'user', kind: 'prompt', text: s.title, ts: s.startedAt });
    for (let k = 0; k < 6 + rnd(10); k++) fakeStep(s, true);
    if (s.status === 'working') startTool(s);
    if (s.status === 'needs_you') askApproval(s);
  }
  sessions[0].interns = [intern(sessions[0], 0, 'working'), intern(sessions[0], 1, 'working')];
  sessions[7].interns = [intern(sessions[7], 2, 'working')];

  function intern(s, k, status) {
    const [type, description] = INTERN_TASKS[k % INTERN_TASKS.length];
    return { id: `${s.id}/a${k}`, agentId: `a${k}`, parentId: s.id, type, description, status, current: { tool: 'Grep', label: 'Grep "TODO"' }, startedAt: now(), lastActivity: now(), tokens: 20000, cost: 0.04, steps: 3 };
  }

  function fakeStep(s, done) {
    const [name, mk] = TOOLS[rnd(TOOLS.length)];
    const file = '/demo/' + s.project + '/' + FILES[rnd(FILES.length)];
    const input = mk(file);
    const start = done ? s.startedAt + s._steps.length * 40000 : now();
    const dur = 300 + rnd(name === 'Bash' ? 20000 : 3000);
    const status = done ? (rnd(14) === 0 ? 'error' : 'ok') : 'open';
    const st = { id: 'st' + Math.random().toString(36).slice(2), tool: name, label: label(name, input), input, start, end: done ? start + dur : null, durationMs: done ? dur : 0, status, result: done ? 'ok' : null, background: false, subagent: null };
    s._steps.push(st);
    s._convo.push({ role: 'assistant', kind: 'tool', text: st.label, ts: start });
    if (done && ['Edit', 'Write'].includes(name)) {
      const f = s._files.get(file) || { path: file, count: 0, tools: [name], lastTs: start };
      f.count++; s._files.set(file, f);
    }
    addUsage(s);
    return st;
  }

  function addUsage(s) {
    const t = s.tokens;
    const inc = { input: 20 + rnd(50), output: 200 + rnd(1500), cacheRead: 20000 + rnd(40000), cacheWrite5m: rnd(3000), cacheWrite1h: 0 };
    for (const k of Object.keys(inc)) t[k] += inc[k];
    t.total = t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
    const c = (inc.input * 4 + inc.output * 20 + inc.cacheRead * 0.2 + inc.cacheWrite5m * 5) / 1e6;
    s.cost += c; costToday += c; tokensToday += inc.input + inc.output + inc.cacheRead + inc.cacheWrite5m;
    s.context.used = Math.min(950000, s.context.used + rnd(4000));
    s.context.pct = s.context.used / s.context.window;
  }

  function startTool(s) {
    const st = fakeStep(s, false);
    s.current = { tool: st.tool, label: st.label };
    s.status = 'working';
    s.lastActivity = now();
  }

  function finishTool(s) {
    const st = s._steps[s._steps.length - 1];
    if (st && st.status === 'open') {
      st.status = rnd(12) === 0 ? 'error' : 'ok';
      st.end = now(); st.durationMs = st.end - st.start; st.result = 'ok';
      if (['Edit', 'Write'].includes(st.tool)) {
        const f = s._files.get(st.input.file_path) || { path: st.input.file_path, count: 0, tools: [st.tool], lastTs: st.start };
        f.count++; s._files.set(st.input.file_path, f);
      }
    }
    s.current = null;
  }

  function askApproval(s) {
    const st = startTool(s) || s._steps[s._steps.length - 1];
    s.status = 'needs_you';
    s.reason = 'permission request';
    const a = { id: 'ap' + Math.random().toString(36).slice(2), sessionId: s.id, agentId: null, project: s.project, tool: st.tool, label: st.label, input: st.input, ts: now(), expiresAt: now() + 45000 };
    approvals.push(a);
    s.pending = 1;
  }

  function summary(s) {
    s.steps = s._steps.length;
    s.errors = s._steps.filter((x) => x.status === 'error').length;
    s.files = s._files.size;
    const { _steps, _convo, _files, _next, _task, _teamUntil, _dismissed, ...rest } = s;
    return { ...rest, task: _task || null, tokens: { ...s.tokens }, context: { ...s.context }, interns: s.interns.map((i) => ({ ...i })) };
  }

  // ---------- departments ----------
  function setDepartments(key, list) {
    if (!org.projects[key]) return { error: 'Unknown building.' };
    if (!Array.isArray(list) || !list.length) return { error: 'A building needs at least one department.' };
    if (list.length > 12) return { error: 'A building has at most 12 departments.' };
    const ids = new Set(), names = new Set(), out = [];
    for (const r of list) {
      const name = String(r.name || '').trim();
      if (!name) return { error: 'Every department needs a name.' };
      if (names.has(name.toLowerCase())) return { error: `There are two departments called "${name}".` };
      names.add(name.toLowerCase());
      let id = r.id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'dept';
      const base = id;
      for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
      ids.add(id);
      out.push({ id, name, role: String(r.role || '').trim() });
    }
    org.projects[key].departments = out;
    for (const s of sessions) if (s.projectKey === key && !ids.has(s.dept)) { s.dept = out[0].id; h.session(summary(s)); }
    h.org(orgView());
    return { ok: true };
  }

  function dismiss(key, ids) {
    const dismissed = [], skipped = [];
    for (const id of ids || []) {
      const s = sessions.find((x) => x.id === id && x.projectKey === key);
      const run = s?.team && teams.find((r) => r.id === s.team);
      const reason = !s ? 'Unknown robot.' : s._task ? 'It is on a task. Stop the task first.' : s.status === 'working' ? 'It is working.'
        : s.status === 'needs_you' ? 'It is waiting on you.' : run?.status === 'running' ? 'It is part of a team that is still working.' : null;
      if (reason) { skipped.push({ id, reason }); continue; }
      s._dismissed = true; s.hidden = true; s.dismissed = true;
      dismissed.push(id);
      h.session(summary(s));
    }
    h.counters(counters());
    return { dismissed, skipped };
  }

  function assign(key, sessionId, dept) {
    const s = sessions.find((x) => x.id === sessionId && x.projectKey === key);
    if (!s) return { error: 'Unknown robot.' };
    if (!deptsOf(key).some((d) => d.id === dept)) return { error: 'Unknown department.' };
    s.dept = dept;
    h.session(summary(s));
    return { ok: true };
  }

  // ---------- team runs (simulated) ----------
  // One department works at a time for a few seconds, then hands over to the next floor.
  // QA (when there is one, after Development) sends it back once with a bug, then signs off.
  function hire(p, dept, title) {
    const s = {
      id: `demo-${sessions.length}`, project: p.name, projectKey: p.key, cwd: p.cwd, branch: p.branch, repo: true, worktree: null, dept, team: null,
      title, model: 'claude-opus-5-5', entrypoint: 'sdk-cli',
      status: 'working', reason: '', source: 'transcript', hooks: true, current: null, startedAt: now(), lastActivity: now(),
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, total: 0 }, cost: 0,
      context: { used: 20000, window: 1000000, pct: 0.02 }, steps: 0, errors: 0, files: 0, interns: [], pending: 0, hidden: false,
      _steps: [], _convo: [], _files: new Map(), _next: now() + 1500,
    };
    sessions.push(s);
    return s;
  }

  const teamView = () => teams.map((r) => ({ ...r, departments: r.departments.map(({ id, name }) => ({ id, name })), robots: { ...r.robots }, messages: r.messages.map((m) => ({ ...m })), _bounced: undefined }));

  function teamTurn(run, dept, from, text, say) {
    run.turn++;
    const p = PROJECTS.find((x) => x.key === run.projectKey);
    let s = sessions.find((x) => x.id === run.robots[dept.id]);
    // New robots walk in a moment after the hand-off, like a real hire.
    const delay = s ? 0 : 1800;
    if (!s) { s = hire(p, dept.id, `${dept.name}: ${run.goal}`); s.status = 'your_turn'; s.hidden = true; run.robots[dept.id] = s.id; s.team = run.id; }
    run.current = { dept: dept.id, sessionId: s.id, taskId: null, startedAt: now() };
    run.messages.push({ id: 'm' + Math.random().toString(36).slice(2), ts: now(), turn: run.turn, from: from ? { dept: from.id, name: from.name, sessionId: run.robots[from.id] } : null, to: { dept: dept.id, name: dept.name, sessionId: s.id }, say, text });
    setTimeout(() => {
      if (run.status !== 'running') return;
      s.hidden = false;
      s._convo.push({ role: 'user', kind: 'prompt', text: `Team task for ${dept.name}: ${run.goal}\n\n${from ? from.name : 'The user'} says to you:\n${text}`, ts: now() });
      startTool(s);
      // The demo recording shows a whole hand-off in a few seconds.
      s._teamUntil = now() + (RECORDING ? 4500 + rnd(1000) : 9000 + rnd(5000));
      s._next = now() + 1500;
      h.session(summary(s));
    }, delay);
  }

  function teamTurnDone(s) {
    s._teamUntil = null;
    finishTool(s);
    s.status = 'your_turn'; s.reason = 'finished a turn'; s.current = null;
    const run = teams.find((r) => r.id === s.team && r.status === 'running');
    if (!run) return;
    const dept = run.departments.find((d) => d.id === run.current?.dept);
    if (!dept) return;
    const i = run.departments.indexOf(dept);
    const dev = run.departments.find((d) => d.id === 'development');
    const second = (run._bounced && dept.id === 'qa') || (run._fixing && dept.id === 'development') ? 1 : 0;
    let say = (LINES[dept.id] || ['Done with my part.', 'Done again.'])[second];
    let next = run.departments[i + 1] || null;
    if (dept.id === 'qa' && dev && !run._bounced && run.departments.indexOf(dev) < i) { next = dev; run._bounced = true; run._fixing = true; }
    else if (dept.id === 'development' && run._fixing) { next = run.departments.find((d) => d.id === 'qa') || next; run._fixing = false; }
    const text = `${say}\n\n(Simulated: in the real office this is the department's own summary of what it did, where, and what the next department should do.)`;
    s._convo.push({ role: 'assistant', kind: 'text', text: `${say}\n\nHANDOFF {"to": "${next ? next.id : 'done'}", "say": "${say.replace(/"/g, '\'')}"}`, ts: now() });
    h.session(summary(s));
    run.current = null;
    if (!next || run.turn >= run.maxTurns) {
      run.messages.push({ id: 'm' + Math.random().toString(36).slice(2), ts: now(), turn: run.turn, from: { dept: dept.id, name: dept.name, sessionId: s.id }, to: null, say: next ? `Out of turns. ${say}` : say, text });
      run.status = next ? 'limit' : 'done'; run.endedAt = now();
      h.teams(teamView());
      // keep the demo lively: the same building starts another goal after a while
      if (run.auto) setTimeout(() => autoTeam(run.projectKey), 45000);
      return;
    }
    teamTurn(run, next, dept, text, say);
    h.teams(teamView());
  }

  function startTeam({ projectKey, goal, mode, departments, start, maxTurns }) {
    goal = String(goal || '').trim();
    if (!goal) return { error: 'Write the team goal first.' };
    if (teams.some((r) => r.projectKey === projectKey && r.status === 'running')) return { error: 'A team is already working in this building. Stop it first, or wait until it is done.' };
    const all = deptsOf(projectKey);
    const ids = new Set(departments?.length ? departments : all.map((d) => d.id));
    const team = all.filter((d) => ids.has(d.id));
    if (!team.length) return { error: 'Pick at least one department for the team.' };
    const first = team.find((d) => d.id === start) || team[0];
    const p = PROJECTS.find((x) => x.key === projectKey);
    if (!p) return { error: 'Unknown building.' };
    const run = {
      id: 'run' + Math.random().toString(36).slice(2), projectKey, project: p.name, branch: p.branch, goal, fullGoal: goal, mode: mode || 'acceptEdits',
      departments: team, status: 'running', startedAt: now(), endedAt: null, turn: 0, maxTurns: Math.max(1, Math.min(30, Number(maxTurns) || 8)),
      current: null, robots: {}, messages: [], error: null,
    };
    teams.push(run);
    teamTurn(run, first, null, goal, goal.length > 90 ? goal.slice(0, 89) + '…' : goal);
    h.teams(teamView());
    return { run: teamView().at(-1) };
  }

  function stopTeam(id) {
    const run = teams.find((r) => r.id === id);
    if (!run || run.status !== 'running') return false;
    const s = sessions.find((x) => x.id === run.current?.sessionId);
    if (s) { s._teamUntil = null; finishTool(s); s.status = 'your_turn'; s.reason = 'interrupted'; s._convo.push({ role: 'user', kind: 'interrupt', text: '', ts: now() }); h.session(summary(s)); }
    run.status = 'stopped'; run.endedAt = now(); run.current = null;
    h.teams(teamView());
    return true;
  }

  function autoTeam(key) {
    if (teams.some((r) => r.projectKey === key && r.status === 'running')) return;
    const r = startTeam({ projectKey: key, goal: TEAM_GOALS[key], mode: 'acceptEdits', maxTurns: 8 });
    const run = teams.find((x) => x.id === r.run?.id);
    if (run) run.auto = true;
  }

  function counters() {
    const vis = sessions;
    return {
      needsYou: vis.filter((s) => s.status === 'needs_you').length,
      working: vis.filter((s) => s.status === 'working').length,
      interns: vis.reduce((n, s) => n + s.interns.filter((i) => i.status === 'working').length, 0),
      tokensToday, costToday, approvals: approvals.length,
      tokensTodayBreakdown: { input: Math.round(tokensToday * 0.001), output: Math.round(tokensToday * 0.02), cacheRead: Math.round(tokensToday * 0.94), cacheWrite5m: Math.round(tokensToday * 0.039), cacheWrite1h: 0 },
    };
  }

  function resolveApproval(a, decision) {
    approvals.splice(approvals.indexOf(a), 1);
    const s = sessions.find((x) => x.id === a.sessionId);
    if (s) {
      s.pending = 0;
      const st = s._steps[s._steps.length - 1];
      if (decision === 'deny' && st) { st.status = 'denied'; st.end = now(); st.durationMs = st.end - st.start; s.current = null; }
      s.status = 'working'; s.reason = ''; s._next = now() + 1500;
      h.session(summary(s));
    }
    h.approvals(approvals.slice());
    h.counters(counters());
  }

  function tick() {
    const t = now();
    for (const s of sessions) {
      if (s.status === 'idle' || s._dismissed || t < s._next) continue;
      // Team robots work their turn, hand over, and then wait for the next one.
      if (s._teamUntil) {
        finishTool(s);
        addUsage(s);
        if (t >= s._teamUntil) teamTurnDone(s);
        else { startTool(s); s._next = t + 1800 + rnd(2500); h.session(summary(s)); }
        continue;
      }
      if (s.team && s.status === 'your_turn') continue;
      if (s.status === 'needs_you') {
        const a = approvals.find((x) => x.sessionId === s.id);
        if (a && t > a.expiresAt) resolveApproval(a, 'allow');
        continue;
      }
      if (s.status === 'working') {
        finishTool(s);
        addUsage(s);
        const r = Math.random();
        if (r < 0.62) { startTool(s); s._next = t + 2000 + rnd(5000); }
        else if (r < 0.74) { askApproval(s); s._next = t + 4000; h.approvals(approvals.slice()); }
        else {
          s.status = 'your_turn'; s.reason = 'finished a turn'; s.current = null;
          s._convo.push({ role: 'assistant', kind: 'text', text: 'Done. I made the change and the tests pass.', ts: t });
          s._next = t + 12000 + rnd(15000);
          if (s._task) finishTask(s._task, 'done');
        }
      } else if (s.status === 'your_turn') {
        s._convo.push({ role: 'user', kind: 'prompt', text: 'Great, next: ' + TITLES[rnd(TITLES.length)].toLowerCase(), ts: t });
        startTool(s); s._next = t + 2500 + rnd(4000);
      }
      for (const i of s.interns) {
        if (i.status === 'working' && Math.random() < 0.15) { i.status = 'done'; i.lastActivity = t; i.current = null; }
        else if (i.status === 'working') { const [n, mk] = TOOLS[rnd(4)]; i.current = { tool: n, label: label(n, mk('/x/' + FILES[rnd(FILES.length)])) }; i.lastActivity = t; }
      }
      s.interns = s.interns.filter((i) => i.status !== 'done' || t - i.lastActivity < 120000);
      if (s.status === 'working' && s.interns.length < 2 && Math.random() < 0.08) s.interns.push(intern(s, rnd(4) + s.interns.length * 4, 'working'));
      s.lastActivity = t;
      h.session(summary(s));
    }
    h.counters(counters());
  }

  function finishTask(id, status) {
    const task = tasks.find((x) => x.id === id);
    const s = sessions.find((x) => x._task === id);
    if (s) s._task = null;
    if (!task || task.status !== 'running') return;
    task.status = status; task.endedAt = now();
    if (s && status === 'stopped') { finishTool(s); s.status = 'your_turn'; s.reason = 'interrupted'; s._next = now() + 20000; s._convo.push({ role: 'user', kind: 'interrupt', text: '', ts: now() }); h.session(summary(s)); }
    h.tasks(tasks.slice());
  }

  function branchesOf(key) {
    const p = PROJECTS.find((x) => x.key === key);
    if (!p) return { isRepo: false, branches: [] };
    const names = new Set([p.branch, ...sessions.filter((s) => s.projectKey === key).map((s) => s.branch), ...(EXTRA_BRANCHES[key] || [])]);
    return {
      isRepo: true, name: p.name, current: p.branch,
      branches: [...names].map((name) => {
        const on = sessions.filter((s) => s.projectKey === key && s.branch === name && !s.hidden);
        return {
          name, date: now(), robots: on.length,
          working: on.filter((s) => s.status === 'working').length,
          needs: on.filter((s) => s.status === 'needs_you').length,
          checkedOut: name === p.branch ? 'main' : on.length ? 'worktree' : null,
          path: on.length || name === p.branch ? branchPath(p, name) : null,
        };
      }),
    };
  }

  function startTask({ sessionId, projectKey, branch, newBranch, prompt, mode, dept }) {
    prompt = String(prompt || '').trim();
    if (!prompt) return { error: 'Write a task first.' };
    let s;
    if (sessionId) {
      s = sessions.find((x) => x.id === sessionId);
      if (!s) return { error: 'Unknown robot.' };
      if (s.status === 'working') return { error: 'This robot is busy. Wait until it is your turn.' };
      if (s.status === 'needs_you') return { error: 'This robot is waiting on you. Answer it first.' };
      // A robot that was sent home comes back to work.
      s._dismissed = false; s.dismissed = false; s.hidden = false;
    } else {
      const p = PROJECTS.find((x) => x.key === projectKey);
      if (!p) return { error: 'No known folder for that building yet.' };
      if (newBranch) {
        newBranch = String(newBranch).trim();
        if (!/^[A-Za-z0-9._/-]+$/.test(newBranch) || newBranch.startsWith('-')) return { error: `"${newBranch}" is not a valid branch name.` };
        if (branchesOf(p.key).branches.some((b) => b.name === newBranch)) return { error: `Branch "${newBranch}" already exists. Pick it from the list instead.` };
        (EXTRA_BRANCHES[p.key] ||= []).push(newBranch);
      }
      const br = newBranch || branch || p.branch;
      const deps = deptsOf(p.key);
      s = {
        id: `demo-${sessions.length}`, project: p.name, projectKey: p.key, cwd: branchPath(p, br), branch: br, repo: true, worktree: br === p.branch ? null : branchPath(p, br),
        dept: deps.some((d) => d.id === dept) ? dept : deps[0].id, team: null,
        title: prompt.length > 60 ? prompt.slice(0, 60) + '…' : prompt, model: 'claude-opus-5-5', entrypoint: 'sdk-cli',
        status: 'working', reason: '', source: 'transcript', hooks: true, current: null, startedAt: now(), lastActivity: now(),
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, total: 0 }, cost: 0,
        context: { used: 20000, window: 1000000, pct: 0.02 }, steps: 0, errors: 0, files: 0, interns: [], pending: 0, hidden: false,
        _steps: [], _convo: [], _files: new Map(), _next: now() + 1500,
      };
      sessions.push(s);
    }
    const task = { id: 'task' + Math.random().toString(36).slice(2), sessionId: s.id, newRobot: !sessionId, project: s.project, cwd: s.cwd, branch: s.branch, worktree: s.worktree, mode: mode || 'acceptEdits', prompt, status: 'running', startedAt: now(), endedAt: null, exitCode: null, error: null, output: '' };
    tasks.push(task);
    s._task = task.id;
    s._convo.push({ role: 'user', kind: 'prompt', text: prompt, ts: now() });
    s.status = 'working'; s.reason = ''; s.lastActivity = now();
    startTool(s); s._next = now() + 2500;
    h.session(summary(s));
    h.tasks(tasks.slice());
    h.counters(counters());
    return { task };
  }

  return {
    mode: 'demo',
    connect(handlers) {
      h = handlers;
      h.status('demo');
      h.state({ now: now(), sessions: sessions.map(summary), counters: counters(), approvals: approvals.slice(), tasks: [], org: orgView(), teams: [], config: { hideOlderThanHours: 12, tasks: { enabled: true, available: true, defaultMode: 'acceptEdits', worktreeRoot: '~/agent-office-worktrees' }, teams: { defaultTurns: 8, maxTurns: 30 }, files: { maxFileBytes: 50 * 1024 * 1024, maxFiles: 200 } } });
      setInterval(tick, 700);
      // A team is already at work in the first building, so the lift has something to do.
      if (!RECORDING) setTimeout(() => autoTeam(PROJECTS[0].key), 3500);
    },
    async detail(id) {
      const [sid, aid] = id.split('/');
      const s = sessions.find((x) => x.id === sid);
      if (!s) return null;
      if (aid) {
        const i = s.interns.find((x) => x.id === id);
        if (!i) return null;
        return { summary: { ...i, title: i.description, project: s.project, context: { used: 30000, window: 1000000, pct: 0.03 } }, isSubagent: true, parentId: s.id, steps: [], conversation: [{ role: 'user', kind: 'prompt', text: i.description, ts: i.startedAt }], files: [], tokens: { input: 900, output: 4000, cacheRead: 15000, cacheWrite5m: 100, cacheWrite1h: 0, total: 20000, cost: i.cost, byModel: [], context: { used: 30000, window: 1000000, pct: 0.03 } }, costState: null, subagents: [], approvals: [] };
      }
      const sum = summary(s);
      return {
        summary: sum, isSubagent: false, parentId: null,
        steps: s._steps.map((x) => ({ ...x, durationMs: x.status === 'open' ? now() - x.start : x.durationMs })),
        conversation: s._convo.slice(),
        files: [...s._files.values()],
        tokens: { ...s.tokens, cost: s.cost, unpriced: false, byModel: [{ model: s.model, tokens: s.tokens, total: s.tokens.total, cost: s.cost }], context: sum.context },
        costState: null,
        subagents: s.interns.map((i) => ({ ...i })),
        approvals: approvals.filter((a) => a.sessionId === s.id),
      };
    },
    async decide(id, decision) {
      const a = approvals.find((x) => x.id === id);
      if (!a) return false;
      resolveApproval(a, decision);
      return true;
    },
    async startTask(body) { return startTask(body); },
    async branches(key) { return branchesOf(key); },
    // Project files live only in this page: nothing is uploaded in the demo.
    async listFiles(key) { return filesOf(key); },
    async uploadFile(key, file) {
      await new Promise((r) => setTimeout(r, 250));
      const list = (DEMO_FILES[key] ||= []);
      const f = { name: file.name || 'file', size: file.size, mtime: now() };
      const i = list.findIndex((x) => x.name === f.name);
      if (i >= 0) list[i] = f; else list.push(f);
      list.sort((a, b) => a.name.localeCompare(b.name));
      return { file: f, ...filesOf(key) };
    },
    async removeFile(key, name) {
      DEMO_FILES[key] = (DEMO_FILES[key] || []).filter((f) => f.name !== name);
      return filesOf(key);
    },
    async stopTask(id) { finishTask(id, 'stopped'); return true; },
    async setDepartments(key, list) { return setDepartments(key, list); },
    async assign(key, sessionId, dept) { return assign(key, sessionId, dept); },
    async dismiss(key, ids) { return dismiss(key, ids); },
    async startTeam(body) { return startTeam(body); },
    async stopTeam(id) { return stopTeam(id); },
  };
}
