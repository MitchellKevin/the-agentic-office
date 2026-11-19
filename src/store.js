// Session store: discovers transcript files, tails them, links subagents to their
// parent, overlays hook events, and emits compact summaries when something changes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Tail } from './tail.js';
import {
  createSession, applyLine, sessionTitle, projectName, contextInfo, totalTokens,
  currentStep, filesChanged, emptyTokens, localDay, stepLabel, basename,
} from './parser.js';
import { combinedStatus, hookStatus } from './status.js';
import { Approvals } from './approvals.js';
import { Tasks } from './tasks.js';
import { Library } from './library.js';
import { GitInfo } from './git.js';
import { Org } from './org.js';
import { Teams } from './teams.js';

const SUB_RE = /(?:^|\/)agent-([A-Za-z0-9_-]+)\.jsonl$/;
const INTERN_LINGER_MS = 5 * 60_000;
const ENDED_LINGER_MS = 60_000;

export class Store extends EventEmitter {
  constructor(cfg, { now = () => Date.now(), git = null, org = null } = {}) {
    super();
    this.cfg = cfg;
    this.now = now;
    // Repo / branch lookups for session folders. A finished lookup can move a robot to its
    // repo's floor, so re-broadcast when one lands.
    this.git = git || new GitInfo({ onUpdate: () => this.scheduleFlush() });
    this.dir = cfg.projectsDir;
    this.files = new Map();     // abs path -> record
    this.sessions = new Map();  // sessionId -> main session
    this.subs = new Map();      // `${sid}/${agentId}` -> subagent session
    this.subsByParent = new Map(); // sid -> Set(key)
    this.hooks = new Map();     // sid or `${sid}/${agentId}` -> { ts, status, reason, tool, label }
    this.hookSeen = new Set();  // session ids that have sent hooks
    this.approvals = new Approvals();
    this.lastSent = new Map();  // id -> JSON of last broadcast summary
    this.lastCounters = '';
    this.flushTimer = null;
    this.approvals.on('change', (e) => { this.emit('approvals', e); this.scheduleFlush(); });
    this.tasks = new Tasks(cfg, { now: () => this.now() });
    this.tasks.on('change', () => { this.emit('tasks', this.tasks.list()); this.scheduleFlush(); });
    // Departments: which floor of its project's building each robot works on.
    // loadConfig() makes orgFile absolute; anything else (a raw config in tests) stays in memory.
    this.org = org || new Org(cfg.orgFile && path.isAbsolute(cfg.orgFile) ? cfg.orgFile : null);
    this.org.on('change', () => { this.emit('org', this.org.toJSON()); this.scheduleFlush(); });
    // Project files per building. loadConfig() makes the folder absolute; a raw config (tests) uses a temp folder.
    const filesDir = cfg.files?.dir;
    this.library = new Library(filesDir && path.isAbsolute(filesDir) ? filesDir : path.join(os.tmpdir(), 'agent-office-files'), {
      maxBytes: (cfg.files?.maxFileMB ?? 50) * 1024 * 1024,
      maxFiles: cfg.files?.maxFiles ?? 200,
    });
    this.teams = new Teams({ tasks: this.tasks, org: this.org, place: (key) => this.folderFor(key), library: this.library, cfg, now: () => this.now() });
    this.teams.on('change', () => { this.emit('teams', this.teams.list()); this.scheduleFlush(); });
  }

  /** Project name for a building key, from any session in it. */
  projectNameOf(projectKey) {
    for (const s of this.sessions.values()) {
      const p = this.placeOf(s);
      if (p.projectKey === projectKey) return p.project;
    }
    return this.org.project(projectKey)?.name || null;
  }

  /** The most recently used folder of a building: where new robots (and team runs) work. */
  folderFor(projectKey) {
    let best = null;
    for (const s of this.sessions.values()) {
      if (!s.cwd || this.placeOf(s).projectKey !== projectKey) continue;
      if (!best || (s.lastActivity ?? 0) > (best.lastActivity ?? 0)) best = s;
    }
    if (!best) return null;
    const where = this.placeOf(best);
    return { cwd: best.cwd, project: where.project || path.basename(best.cwd), branch: where.branch };
  }

  // ---------- discovery ----------

  classify(file) {
    const rel = path.relative(this.dir, file);
    if (rel.startsWith('..') || !rel.endsWith('.jsonl')) return null;
    const parts = rel.split(path.sep);
    if (parts.length === 2) {
      return { kind: 'main', projectDir: parts[0], sid: parts[1].slice(0, -6) };
    }
    // <proj>/<sid>/subagents/[workflows/wf_x/]agent-<id>.jsonl
    if (parts.length >= 4 && parts[2] === 'subagents') {
      const m = rel.match(SUB_RE);
      if (!m) return null;
      const workflow = parts.length >= 6 && parts[3] === 'workflows' ? parts[4] : null;
      return { kind: 'sub', projectDir: parts[0], sid: parts[1], agentId: m[1], workflow };
    }
    return null;
  }

  record(file, stat = null) {
    let rec = this.files.get(file);
    if (rec) return rec;
    const c = this.classify(file);
    if (!c) return null;
    rec = { file, ...c, tail: new Tail(file), loaded: false, mtime: stat?.mtimeMs ?? 0, size: stat?.size ?? 0 };
    this.files.set(file, rec);
    return rec;
  }

  async scan() {
    const now = this.now();
    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    const cutoff = Math.min(now - this.cfg.hideOlderThanHours * 3600_000, midnight.getTime());
    const found = [];
    const walk = async (dir, depth) => {
      let ents;
      try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 5) await walk(p, depth + 1);
        } else if (e.name.endsWith('.jsonl')) {
          found.push(p);
        }
      }
    };
    await walk(this.dir, 0);
    const toLoad = [];
    for (const p of found) {
      let st;
      const known = this.files.get(p);
      if (known) {
        // Already indexed: only re-read if it grew (covers missed watch events).
        try { st = await fs.promises.stat(p); } catch { continue; }
        if (st.size !== known.tail.offset && (known.loaded || st.mtimeMs >= cutoff)) toLoad.push(known);
        continue;
      }
      try { st = await fs.promises.stat(p); } catch { continue; }
      const rec = this.record(p, st);
      if (rec && st.mtimeMs >= cutoff) toLoad.push(rec);
    }
    // Main sessions first so subagents can link to a parent that exists.
    toLoad.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'main' ? -1 : 1));
    for (const rec of toLoad) await this.readRecord(rec);
    this.scheduleFlush(0);
    return { files: found.length, loaded: toLoad.length };
  }

  async onFileEvent(file) {
    let rec = this.files.get(file);
    if (!rec) {
      if (!file.endsWith('.jsonl')) {
        // A meta.json may show up after the agent file; re-read it lazily.
        if (file.endsWith('.meta.json')) {
          const key = this.metaKey(file);
          const sub = key && this.subs.get(key);
          if (sub && !sub.meta) sub.meta = await this.readMeta(file.replace(/\.meta\.json$/, '.jsonl'));
        }
        return;
      }
      let st;
      try { st = await fs.promises.stat(file); } catch { return; }
      rec = this.record(file, st);
      if (!rec) return;
    }
    await this.readRecord(rec);
  }

  metaKey(file) {
    const c = this.classify(file.replace(/\.meta\.json$/, '.jsonl'));
    return c && c.kind === 'sub' ? `${c.sid}/${c.agentId}` : null;
  }

  async readMeta(jsonlFile) {
    try {
      return JSON.parse(await fs.promises.readFile(jsonlFile.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    } catch { return null; }
  }

  ensureMain(sid, projectDir, file = null) {
    let s = this.sessions.get(sid);
    if (!s) {
      s = createSession({ id: sid, file, projectDir });
      this.sessions.set(sid, s);
    }
    if (file && !s.file) s.file = file;
    if (projectDir && !s.projectDir) s.projectDir = projectDir;
    return s;
  }

  async readRecord(rec) {
    let s;
    if (rec.kind === 'main') {
      s = this.ensureMain(rec.sid, rec.projectDir, rec.file);
    } else {
      const key = `${rec.sid}/${rec.agentId}`;
      s = this.subs.get(key);
      if (!s) {
        s = createSession({ id: key, file: rec.file, projectDir: rec.projectDir, parentId: rec.sid, agentId: rec.agentId });
        s.workflow = rec.workflow;
        this.subs.set(key, s);
        if (!this.subsByParent.has(rec.sid)) this.subsByParent.set(rec.sid, new Set());
        this.subsByParent.get(rec.sid).add(key);
      }
      if (!s.meta) s.meta = await this.readMeta(rec.file);
    }
    const res = await rec.tail.read(
      (obj) => applyLine(s, obj, this.cfg),
      () => { s.parseErrors++; },
    );
    if (res.truncated) {
      // The file was rewritten: rebuild the session from scratch.
      const fresh = createSession({ id: s.id, file: s.file, projectDir: s.projectDir, parentId: s.parentId, agentId: s.agentId, meta: s.meta });
      fresh.workflow = s.workflow;
      if (rec.kind === 'main') this.sessions.set(s.id, fresh); else this.subs.set(s.id, fresh);
      rec.tail.reset();
      await rec.tail.read((obj) => applyLine(fresh, obj, this.cfg), () => { fresh.parseErrors++; });
    }
    rec.loaded = true;
    if (res.lines || res.truncated) this.scheduleFlush();
    return res;
  }

  /** Files worth polling (fs.watch can miss events): recently active ones. */
  hotFiles() {
    const now = this.now();
    const out = [];
    for (const rec of this.files.values()) {
      const s = rec.kind === 'main' ? this.sessions.get(rec.sid) : this.subs.get(`${rec.sid}/${rec.agentId}`);
      if (s && s.lastActivity && now - s.lastActivity < 30 * 60_000) out.push(rec);
    }
    return out;
  }

  // ---------- hooks ----------

  applyHook(evt) {
    const sid = evt.session_id;
    if (!sid || !evt.hook_event_name) return null;
    const now = this.now();
    // Make sure a session exists even before its transcript is written.
    let projectDir = null;
    if (evt.transcript_path) projectDir = basename(path.dirname(evt.transcript_path));
    const main = this.ensureMain(sid, projectDir, evt.transcript_path || null);
    if (!main.cwd && evt.cwd) main.cwd = evt.cwd;
    this.hookSeen.add(sid);

    const agentId = evt.agent_id || null;
    const key = agentId ? `${sid}/${agentId}` : sid;
    const ev = evt.hook_event_name;

    if (ev === 'SubagentStop' && agentId) {
      this.hooks.set(key, { ts: now, status: 'your_turn', reason: 'finished' });
    } else if (ev === 'SubagentStop') {
      // older payloads without agent_id: nothing reliable to attach to
    } else {
      const st = hookStatus(evt, this.cfg);
      if (st) {
        const label = evt.tool_name ? stepLabel(evt.tool_name, evt.tool_input || {}) : null;
        const prev = this.hooks.get(key);
        // A bare Notification(permission) has no tool; keep the last tool label.
        this.hooks.set(key, { ts: now, ...st, tool: evt.tool_name || prev?.tool || null, label: label || (st.status === 'needs_you' ? prev?.label : null) || null });
      }
    }

    // The terminal moved on: any pending browser approval for this agent is stale.
    if (['PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStop', 'SessionEnd', 'UserPromptSubmit'].includes(ev)) {
      this.approvals.cancelFor(sid, ev === 'SessionEnd' ? undefined : agentId);
    }
    // Pick up transcript changes sooner.
    if (evt.transcript_path) this.onFileEvent(evt.transcript_path).catch(() => {});
    this.scheduleFlush();
    return { sid, key };
  }

  // ---------- views ----------

  internStatus(sub, parent, now) {
    const hook = this.hooks.get(sub.id) || null;
    const c = combinedStatus(sub, hook, now, this.cfg, false);
    let status = c.status;
    if (status === 'your_turn' || status === 'idle' || status === 'ended') status = 'done';
    // Foreground Agent call already returned → the subagent is done.
    const callId = sub.meta?.toolUseId;
    const step = callId && parent ? parent.stepsById.get(callId) : null;
    if (step && step.status !== 'open' && !step.background && status === 'working') status = 'done';
    return { status, reason: c.reason, step: c.step };
  }

  internSummary(sub, parent, now) {
    const st = this.internStatus(sub, parent, now);
    const call = sub.meta?.toolUseId && parent ? parent.subagentCalls.get(sub.meta.toolUseId) : null;
    const step = st.step || currentStep(sub);
    const hook = this.hooks.get(sub.id);
    const cur = step ? { tool: step.tool, label: step.label } : (hook && st.status === 'working' && hook.tool ? { tool: hook.tool, label: hook.label } : null);
    return {
      id: sub.id,
      agentId: sub.agentId,
      parentId: sub.parentId,
      type: sub.meta?.agentType || call?.subagentType || (sub.workflow ? 'workflow' : 'agent'),
      description: sub.meta?.description || call?.description || sessionTitle(sub),
      workflow: sub.workflow || null,
      status: st.status,
      reason: st.reason,
      current: cur,
      model: sub.model,
      startedAt: sub.startedAt,
      lastActivity: sub.lastActivity,
      tokens: totalTokens(sub.tokens),
      cost: sub.cost,
      steps: sub.steps.length,
    };
  }

  summary(s, now = this.now()) {
    const hook = this.hooks.get(s.id) || null;
    const pending = this.approvals.list().filter((a) => a.sessionId === s.id).length;
    const c = combinedStatus(s, hook, now, this.cfg, pending > 0);
    const step = c.step || currentStep(s);
    let current = null;
    if (step) current = { tool: step.tool, label: step.label };
    else if (c.source === 'hook' && hook?.tool && (c.status === 'working' || c.status === 'needs_you')) current = { tool: hook.tool, label: hook.label };

    const interns = [];
    for (const key of this.subsByParent.get(s.id) || []) {
      const sub = this.subs.get(key);
      if (!sub) continue;
      const i = this.internSummary(sub, s, now);
      if (i.status !== 'done' || (i.lastActivity && now - i.lastActivity < INTERN_LINGER_MS)) interns.push(i);
    }
    interns.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    // A task was just handed over: show the robot getting up to work before the transcript catches up.
    const task = this.tasks.activeFor(s.id);
    if (task && (c.status === 'your_turn' || c.status === 'idle' || c.status === 'ended') && task.startedAt >= (s.lastActivity ?? 0)) {
      c.status = 'working';
      c.reason = 'starting a task';
    }
    if (interns.some((i) => i.status === 'needs_you') && c.status !== 'needs_you') {
      c.status = 'needs_you';
      c.reason = 'an intern needs you';
    }

    const lastSeen = Math.max(s.lastActivity ?? 0, hook?.ts ?? 0);
    const hideMs = this.cfg.hideOlderThanHours * 3600_000;
    // Sent home: gone from the office until the session does something new.
    const sentHome = this.org.dismissedAt(s.id);
    const dismissed = !task && sentHome > 0 && lastSeen <= sentHome;
    const hidden = !task && (c.status !== 'needs_you' && now - lastSeen > hideMs) ||
      (c.status === 'ended' && now - (hook?.ts ?? 0) > ENDED_LINGER_MS) ||
      (!s.lastActivity && !hook) || dismissed;

    const files = filesChanged(s);
    const errors = s.steps.reduce((n, st) => n + (st.status === 'error' ? 1 : 0), 0);
    const today = s.byDay.get(localDay(now));
    const where = this.placeOf(s);
    return {
      id: s.id,
      project: where.project,
      projectKey: where.projectKey,
      cwd: s.cwd,
      branch: where.branch,
      repo: where.repo,
      worktree: where.worktree,
      dept: this.org.deptOf(where.projectKey, s.id),
      team: this.teams.runOf(s.id)?.id || null,
      title: sessionTitle(s),
      model: s.model,
      entrypoint: s.entrypoint,
      status: c.status,
      reason: c.reason,
      source: c.source,
      hooks: this.hookSeen.has(s.id),
      current,
      startedAt: s.startedAt,
      lastActivity: lastSeen || null,
      tokens: { ...s.tokens, total: totalTokens(s.tokens) },
      cost: s.cost,
      todayTokens: today ? totalTokens(today.tokens) : 0,
      todayCost: today ? today.cost : 0,
      unpriced: s.unpriced,
      context: contextInfo(s, this.cfg),
      steps: s.steps.length,
      errors,
      files: files.length,
      interns,
      pending,
      task: task ? task.id : null,
      hidden,
      dismissed,
    };
  }

  /**
   * Which floor and branch a session belongs to. Git repos are grouped by their shared .git
   * directory, so agents in different worktrees of one repo share a floor. Folders that aren't
   * git repos keep one floor per folder, as before.
   */
  placeOf(s) {
    const r = s.cwd ? this.git.peek(s.cwd) : undefined;
    const tBranch = s.gitBranch && s.gitBranch !== 'HEAD' ? s.gitBranch : null;
    if (r?.isRepo) {
      return {
        projectKey: r.key,
        project: r.name,
        // The transcript records the branch line by line, so it is right for a running session
        // even if someone switched the folder's checkout later.
        branch: tBranch || r.branch || null,
        repo: true,
        worktree: r.isWorktree ? r.top : null,
      };
    }
    return { projectKey: s.projectDir || projectName(s), project: projectName(s), branch: tBranch, repo: false, worktree: null };
  }

  /** Repo info for a floor key, from any session on it with a known folder. */
  async repoForKey(projectKey) {
    for (const s of this.sessions.values()) {
      if (!s.cwd) continue;
      if (this.placeOf(s).projectKey !== projectKey) continue;
      const r = await this.git.repo(s.cwd);
      if (r.isRepo) return r;
    }
    return null;
  }

  /** Branch list for a floor: local branches, which robots are on each, and where it is checked out. */
  async branchesFor(projectKey) {
    const repo = await this.repoForKey(projectKey);
    if (!repo) return { isRepo: false, branches: [] };
    const [branches, worktrees] = await Promise.all([this.git.branches(repo.mainTop), this.git.worktrees(repo.mainTop)]);
    const robots = new Map();
    const now = this.now();
    for (const s of this.sessions.values()) {
      const p = this.placeOf(s);
      if (p.projectKey !== projectKey || !p.branch) continue;
      const sum = this.summary(s, now);
      if (sum.hidden) continue;
      const b = robots.get(p.branch) || { robots: 0, working: 0, needs: 0 };
      b.robots++;
      if (sum.status === 'working') b.working++;
      if (sum.status === 'needs_you') b.needs++;
      robots.set(p.branch, b);
    }
    const byBranch = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch, w]));
    return {
      isRepo: true,
      name: repo.name,
      mainTop: repo.mainTop,
      current: worktrees.find((w) => w.path === repo.mainTop)?.branch || null,
      branches: branches.map((b) => {
        const wt = byBranch.get(b.name);
        return {
          name: b.name,
          date: b.date,
          ...(robots.get(b.name) || { robots: 0, working: 0, needs: 0 }),
          checkedOut: wt ? (wt.path === repo.mainTop ? 'main' : 'worktree') : null,
          path: wt?.path || null,
        };
      }),
    };
  }

  counters(now = this.now(), summaries = null) {
    const day = localDay(now);
    const sums = summaries || new Map([...this.sessions.values()].map((s) => [s.id, this.summary(s, now)]));
    let needsYou = 0, working = 0, interns = 0, tokens = emptyTokens(), cost = 0;
    const add = (s) => {
      const b = s.byDay.get(day);
      if (!b) return;
      for (const k of Object.keys(tokens)) tokens[k] += b.tokens[k];
      cost += b.cost;
    };
    for (const s of this.sessions.values()) {
      add(s);
      const sum = sums.get(s.id);
      if (!sum || sum.hidden) continue;
      if (sum.status === 'needs_you') needsYou++;
      else if (sum.status === 'working') working++;
      interns += sum.interns.filter((i) => i.status === 'working').length;
    }
    for (const s of this.subs.values()) add(s);
    return { needsYou, working, interns, tokensToday: totalTokens(tokens), tokensTodayBreakdown: tokens, costToday: cost, approvals: this.approvals.items.size };
  }

  state() {
    const now = this.now();
    const sessions = [...this.sessions.values()].map((s) => this.summary(s, now));
    const sums = new Map(sessions.map((x) => [x.id, x]));
    return { now, sessions, counters: this.counters(now, sums), approvals: this.approvals.list(), tasks: this.tasks.list(), org: this.org.toJSON(), teams: this.teams.list(), config: this.publicConfig() };
  }

  publicConfig() {
    const c = this.cfg;
    return {
      hideOlderThanHours: c.hideOlderThanHours, idleMinutes: c.idleMinutes, approvalWaitSeconds: c.approvalWaitSeconds, projectsDir: c.projectsDir,
      tasks: { enabled: this.tasks.enabled, available: !!this.tasks.binary(), defaultMode: c.tasks?.defaultMode || 'acceptEdits', worktreeRoot: c.tasks?.worktreeRoot || '~/agent-office-worktrees' },
      teams: { defaultTurns: this.teams.defaultTurns, maxTurns: this.teams.turnLimit },
      files: { maxFileBytes: this.library.maxBytes, maxFiles: this.library.maxFiles },
    };
  }

  detail(id) {
    const s = this.sessions.get(id) || this.subs.get(id);
    if (!s) return null;
    const now = this.now();
    const parent = s.parentId ? this.sessions.get(s.parentId) : null;
    const summary = s.parentId ? { ...this.internSummary(s, parent, now), title: sessionTitle(s), project: projectName(s), cwd: s.cwd, context: contextInfo(s, this.cfg), tokens: { ...s.tokens, total: totalTokens(s.tokens) } } : this.summary(s, now);
    const subByCall = new Map();
    for (const key of this.subsByParent.get(s.id) || []) {
      const sub = this.subs.get(key);
      if (sub?.meta?.toolUseId) subByCall.set(sub.meta.toolUseId, key);
    }
    const steps = s.steps.map((st) => ({
      id: st.id, tool: st.tool, label: st.label, input: st.input, start: st.start, end: st.end,
      durationMs: st.status === 'open' && st.start ? now - st.start : st.durationMs,
      status: st.status, result: st.resultPreview, background: st.background,
      subagent: subByCall.get(st.id) || null,
    }));
    const byModel = [...s.byModel.entries()].map(([model, b]) => ({ model, tokens: b.tokens, total: totalTokens(b.tokens), cost: b.cost }));
    const subagents = [...(this.subsByParent.get(s.id) || [])].map((k) => this.subs.get(k)).filter(Boolean).map((sub) => this.internSummary(sub, s, now));
    return {
      summary,
      isSubagent: !!s.parentId,
      parentId: s.parentId,
      steps,
      conversation: s.convo,
      files: filesChanged(s),
      tokens: { ...s.tokens, total: totalTokens(s.tokens), cost: s.cost, unpriced: s.unpriced, byModel, context: contextInfo(s, this.cfg), maxContext: s.maxContext },
      costState: s.costState,
      subagents,
      approvals: this.approvals.list().filter((a) => a.sessionId === (s.parentId || s.id)),
      meta: { file: s.file, version: s.version, entrypoint: s.entrypoint, branch: s.gitBranch, parseErrors: s.parseErrors, lines: s.lines },
    };
  }

  // ---------- change detection ----------

  scheduleFlush(delay = 250) {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, delay);
  }

  /** Emit 'session' for every summary that changed since last time, and 'counters'. */
  flush() {
    const now = this.now();
    const sums = new Map();
    for (const s of this.sessions.values()) {
      const sum = this.summary(s, now);
      sums.set(s.id, sum);
      const json = JSON.stringify(sum);
      if (this.lastSent.get(s.id) !== json) {
        this.lastSent.set(s.id, json);
        this.emit('session', sum);
      }
    }
    const counters = this.counters(now, sums);
    const cj = JSON.stringify(counters);
    if (cj !== this.lastCounters) {
      this.lastCounters = cj;
      this.emit('counters', counters);
    }
  }
}
