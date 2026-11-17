#!/usr/bin/env node
// Agent Office server: static UI, JSON API, SSE live updates and the hook endpoint.
// Binds to 127.0.0.1 only. Reads transcripts read-only. Makes no outbound requests itself;
// the only process it starts is `claude -p`, when you give a robot a task from the page.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, ROOT } from './config.js';
import { Store } from './store.js';
import { startWatcher } from './watcher.js';
import { stepLabel } from './parser.js';
import { ensureWorktree, worktreeRoot, WorktreeError } from './worktrees.js';
import { roleSystemPrompt } from './teams.js';

const PUBLIC = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};
const MAX_BODY = 2 * 1024 * 1024;

export function createServer(cfg, store) {
  const token = crypto.randomBytes(24).toString('hex');
  const clients = new Set(); // { res, ui }
  const allowedHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`, `[::1]:${cfg.port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

  const uiClients = () => [...clients].filter((c) => c.ui).length;

  function send(res, code, body, headers = {}) {
    const isStr = typeof body === 'string';
    res.writeHead(code, {
      'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(isStr ? body : JSON.stringify(body));
  }

  function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.res.write(msg);
  }

  store.on('session', (s) => broadcast('session', s));
  store.on('counters', (c) => broadcast('counters', c));
  store.on('approvals', () => broadcast('approvals', store.approvals.list()));
  store.on('tasks', (list) => broadcast('tasks', list));
  store.on('org', (org) => broadcast('org', org));
  store.on('teams', (list) => broadcast('teams', list));

  const heartbeat = setInterval(() => broadcast('ping', { now: Date.now(), ui: uiClients() }), 15_000);
  heartbeat.unref();

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, urlPath) {
    let rel = urlPath === '/' ? '/index.html' : urlPath;
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'not found');
      const ext = path.extname(file);
      let body = buf;
      if (ext === '.html') body = buf.toString('utf8').replace('__AO_TOKEN__', token);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        ...(ext === '.html' ? {
          'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
          'X-Frame-Options': 'DENY',
        } : {}),
      });
      res.end(body);
    });
  }

  async function handleHook(req, res) {
    let evt;
    try { evt = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
    if (!evt || typeof evt !== 'object') return send(res, 400, { error: 'bad payload' });
    store.applyHook(evt);

    if (evt.hook_event_name !== 'PermissionRequest') return send(res, 200, { ok: true });

    const askTools = new Set(cfg.askTools || []);
    if (askTools.has(evt.tool_name)) return send(res, 200, { wait: false, reason: 'never auto-answered' });
    if (uiClients() === 0) return send(res, 200, { wait: false, reason: 'no browser tab connected' });

    // Agents we started ourselves run headless: there is no terminal prompt to fall back to,
    // so give you much longer to answer in the browser.
    const isTask = !!store.tasks.activeFor(evt.session_id);
    const waitSeconds = isTask ? (cfg.tasks?.approvalWaitSeconds ?? 600) : (cfg.approvalWaitSeconds ?? 45);
    const sess = store.sessions.get(evt.session_id);
    const { item, promise } = store.approvals.add({
      sessionId: evt.session_id,
      agentId: evt.agent_id || null,
      project: sess?.cwd ? path.basename(sess.cwd) : evt.cwd ? path.basename(evt.cwd) : 'unknown',
      tool: evt.tool_name,
      label: stepLabel(evt.tool_name, evt.tool_input || {}),
      input: evt.tool_input ?? null,
      cwd: evt.cwd || null,
      permissionMode: evt.permission_mode || null,
      task: isTask,
    }, waitSeconds * 1000);

    // If the hook process goes away (answered in the terminal, Claude Code killed it), drop the item.
    res.on('close', () => { if (!res.writableEnded) store.approvals.cancel(item.id, 'hook disconnected'); });
    const decision = await promise;
    if (!res.destroyed) send(res, 200, { wait: true, decision });
  }

  const server = http.createServer(async (req, res) => {
    try {
      // DNS-rebinding / cross-site protection.
      if (!allowedHosts.has(req.headers.host || '')) return send(res, 403, 'forbidden host');
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) return send(res, 403, 'forbidden origin');

      const url = new URL(req.url, `http://${req.headers.host}`);
      const p = url.pathname;

      if (req.method === 'GET' && p === '/api/state') return send(res, 200, store.state());

      if (req.method === 'GET' && p.startsWith('/api/session/')) {
        const id = decodeURIComponent(p.slice('/api/session/'.length));
        const d = store.detail(id);
        return d ? send(res, 200, d) : send(res, 404, { error: 'not found' });
      }

      if (req.method === 'GET' && p === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        // Only the real UI (which knows the per-run token) counts as "a tab that can approve".
        const client = { res, ui: url.searchParams.get('token') === token };
        clients.add(client);
        res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(store.state())}\n\n`);
        req.on('close', () => clients.delete(client));
        return;
      }

      if (req.method === 'POST' && p === '/hook') {
        if (origin) return send(res, 403, 'forbidden');
        return handleHook(req, res);
      }

      if (req.method === 'POST' && p.startsWith('/api/approvals/')) {
        if (req.headers['x-ao-token'] !== token) return send(res, 403, { error: 'bad token' });
        const id = decodeURIComponent(p.slice('/api/approvals/'.length));
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
        const ok = store.approvals.decide(id, body.decision);
        return send(res, ok ? 200 : 404, { ok });
      }

      if (req.method === 'GET' && p === '/api/branches') {
        const key = url.searchParams.get('key') || '';
        try { return send(res, 200, await store.branchesFor(key)); }
        catch (e) { return send(res, 500, { error: `Could not read branches: ${e.stderr || e.message}` }); }
      }

      if (req.method === 'POST' && p === '/api/tasks') {
        if (req.headers['x-ao-token'] !== token) return send(res, 403, { error: 'bad token' });
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
        const r = await startTask(store, body || {});
        return send(res, r.error ? r.code || 400 : 200, r.error ? { error: r.error } : { ok: true, task: r.task });
      }

      if (req.method === 'POST' && /^\/api\/tasks\/[^/]+\/stop$/.test(p)) {
        if (req.headers['x-ao-token'] !== token) return send(res, 403, { error: 'bad token' });
        const ok = store.tasks.stop(decodeURIComponent(p.split('/')[3]));
        return send(res, ok ? 200 : 404, { ok });
      }

      if (req.method === 'POST' && p === '/api/org') {
        if (req.headers['x-ao-token'] !== token) return send(res, 403, { error: 'bad token' });
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
        const r = orgChange(store, body || {});
        return send(res, r.error ? r.code || 400 : 200, r.error ? { error: r.error } : { ok: true, org: store.org.toJSON() });
      }

      if (req.method === 'POST' && p === '/api/teams') {
        if (req.headers['x-ao-token'] !== token) return send(res, 403, { error: 'bad token' });
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
        const r = store.teams.start(body || {});
        return send(res, r.error ? r.code || 400 : 200, r.error ? { error: r.error } : { ok: true, run: r.run });
      }

      if (req.method === 'POST' && /^\/api\/teams\/[^/]+\/stop$/.test(p)) {
        if (req.headers['x-ao-token'] !== token) return send(res, 403, { error: 'bad token' });
        const ok = store.teams.stop(decodeURIComponent(p.split('/')[3]));
        return send(res, ok ? 200 : 404, { ok });
      }

      if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(req, res, p);
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[agent-office] request error:', e);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    }
  });

  server.on('close', () => clearInterval(heartbeat));
  return { server, token, clients };
}

/**
 * Department changes from the page. Only buildings the store knows (from sessions) or already
 * has departments for can be changed, and a robot can only be moved within its own building.
 *   { op: 'departments', projectKey, departments: [{ id?, name, role }] }
 *   { op: 'assign', projectKey, sessionId, dept }
 */
export function orgChange(store, { op, projectKey, departments, sessionId, dept }) {
  const key = String(projectKey || '');
  const name = key ? store.projectNameOf(key) : null;
  if (!key || (!name && !store.org.project(key))) return { error: 'Unknown building.', code: 404 };
  if (op === 'departments') return store.org.setDepartments(key, departments, name);
  if (op === 'assign') {
    const s = store.sessions.get(String(sessionId || ''));
    if (!s || store.placeOf(s).projectKey !== key) return { error: 'Unknown robot.', code: 404 };
    return store.org.assign(key, s.id, String(dept || ''), name);
  }
  return { error: 'Unknown change.', code: 400 };
}

/** A department's role for a robot's tasks, as an appended system prompt. */
function roleFor(store, projectKey, deptId, project) {
  return roleSystemPrompt(store.org.department(projectKey, deptId), project);
}

/**
 * Resolves a task request against sessions the store already knows, so the browser can never
 * pick an arbitrary folder:
 *   { sessionId }                     → give that robot the task (it keeps its folder and branch)
 *   { projectKey }                    → hire a new robot in that building's most recently used folder
 *   { projectKey, branch }            → hire a new robot on that branch: in the folder where the
 *                                       branch is checked out, or in a new worktree for it
 *   { projectKey, newBranch, base? }  → create the branch (from base) in a new worktree, hire there
 * `dept` puts a new robot on that department's floor. Robots in a department with a role get
 * that role as an appended system prompt.
 */
export async function startTask(store, { sessionId, projectKey, branch, newBranch, base, prompt, mode, dept }) {
  if (sessionId) {
    const s = store.sessions.get(String(sessionId));
    if (!s) return { error: 'Unknown robot.', code: 404 };
    const sum = store.summary(s);
    if (sum.status === 'working') return { error: 'This robot is busy. Wait until it is your turn.', code: 409 };
    if (sum.status === 'needs_you') return { error: 'This robot is waiting on you. Answer it first.', code: 409 };
    if (sum.team && store.teams.runs.get(sum.team)?.status === 'running') return { error: 'This robot is part of a team run that is still going. Stop the run first.', code: 409 };
    return store.tasks.start({ sessionId: s.id, resume: true, cwd: s.cwd, project: sum.project, prompt, mode, branch: sum.branch, worktree: sum.worktree, dept: sum.dept, systemPrompt: roleFor(store, sum.projectKey, sum.dept, sum.project) });
  }
  if (!projectKey) return { error: 'Pick a robot or a floor.', code: 400 };
  const key = String(projectKey);
  const deptId = dept && store.org.department(key, String(dept)) ? String(dept) : store.org.departmentsOf(key)[0].id;
  const hired = (r) => {
    if (r.task) store.org.assign(key, r.task.sessionId, deptId, store.projectNameOf(key));
    return r;
  };
  const role = (project) => roleFor(store, key, deptId, project);

  if (branch || newBranch) {
    // Check the prompt before touching git, so a typo doesn't leave an empty worktree behind.
    if (!String(prompt || '').trim()) return { error: 'Write a task first.', code: 400 };
    if (!store.tasks.enabled) return { error: 'Tasks are turned off in config.json (tasks.enabled).', code: 403 };
    if (!store.tasks.binary()) return { error: 'Claude Code CLI not found. Set tasks.claudePath in config.json.', code: 503 };
    const repo = await store.repoForKey(key);
    if (!repo) return { error: 'This floor is not a git repository, so it has no branches.', code: 409 };
    let place;
    try {
      place = await ensureWorktree({ git: store.git, repo, branch, newBranch, base, root: worktreeRoot(store.cfg) });
    } catch (e) {
      if (e instanceof WorktreeError) return { error: e.message, code: e.code };
      throw e;
    }
    return hired(store.tasks.start({
      resume: false, cwd: place.cwd, project: repo.name, prompt, mode,
      branch: place.branch, worktree: place.cwd === repo.mainTop ? null : place.cwd,
      dept: deptId, systemPrompt: role(repo.name),
    }));
  }

  const where = store.folderFor(key);
  if (!where) return { error: 'No known folder for that building yet.', code: 404 };
  return hired(store.tasks.start({ resume: false, cwd: where.cwd, project: where.project, prompt, mode, branch: where.branch, dept: deptId, systemPrompt: role(where.project) }));
}

async function main() {
  const cfg = loadConfig();
  if (!fs.existsSync(cfg.projectsDir)) {
    console.warn(`[agent-office] ${cfg.projectsDir} does not exist yet; waiting for Claude Code to create it.`);
  }
  const store = new Store(cfg);
  const t0 = Date.now();
  const res = await store.scan();
  console.log(`[agent-office] indexed ${res.files} transcript files, parsed ${res.loaded} recent ones in ${Date.now() - t0}ms`);
  startWatcher(store);
  setInterval(() => store.flush(), 1000).unref();

  const { server } = createServer(cfg, store);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`[agent-office] port ${cfg.port} is in use. Set PORT=xxxx or change config.json.`);
    else console.error(e);
    process.exit(1);
  });
  // Tasks are child processes: take them down with us rather than leaving them running unseen.
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.tasks.stopAll(); process.exit(0); });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[agent-office] http://localhost:${cfg.port}  (demo: http://localhost:${cfg.port}/?demo=1)`);
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('src/server.js')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
