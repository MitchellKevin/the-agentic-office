// Tasks: give a robot (an existing session) a new prompt, or hire a new robot on a floor.
// Each task is one headless `claude -p` process. Prompts go in on stdin (never through a
// shell), the working directory always comes from a session we already know, and finished
// tasks linger for a while so the UI can show how they ended.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { expandHome } from './config.js';

export const MODES = ['acceptEdits', 'plan', 'auto'];
export const MAX_PROMPT = 20_000;
const TAIL = 4000;
const LINGER_MS = 10 * 60_000;

function isExec(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

function cmpVersion(a, b) {
  const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Finds the Claude Code CLI. Order: config `tasks.claudePath`, PATH, the usual install
 * locations, then the newest binary bundled with an editor extension or the desktop app
 * (people who only use Claude Code in VS Code or the desktop app have no `claude` on PATH).
 */
export function findClaude(cfg = {}, { env = process.env, home = os.homedir() } = {}) {
  const configured = cfg.tasks?.claudePath;
  if (configured) return isExec(expandHome(configured)) ? expandHome(configured) : null;

  const exe = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const n of exe) if (isExec(path.join(dir, n))) return path.join(dir, n);
  }
  for (const p of [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]) if (isExec(p)) return p;

  const bundled = [];
  for (const ed of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
    const dir = path.join(home, ed, 'extensions');
    let ents = [];
    try { ents = fs.readdirSync(dir); } catch { continue; }
    for (const e of ents) {
      const m = e.match(/^anthropic\.claude-code-(\d+\.\d+\.\d+)/);
      if (!m) continue;
      const bin = path.join(dir, e, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
      if (isExec(bin)) bundled.push({ v: m[1], bin });
    }
  }
  const desktop = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
  let vers = [];
  try { vers = fs.readdirSync(desktop); } catch {}
  for (const v of vers) {
    if (!/^\d+\.\d+\.\d+$/.test(v)) continue;
    let hashes = [];
    try { hashes = fs.readdirSync(path.join(desktop, v)); } catch {}
    for (const h of hashes) {
      const bin = path.join(desktop, v, h, 'claude.app', 'Contents', 'MacOS', 'claude');
      if (isExec(bin)) bundled.push({ v, bin });
    }
  }
  bundled.sort((a, b) => cmpVersion(b.v, a.v));
  return bundled[0]?.bin || null;
}

/**
 * argv for one task. The prompt is not in here: it goes in on stdin. A department's role goes
 * in as an appended system prompt (an argv entry, never through a shell).
 */
export function taskArgs({ sessionId, resume, mode, systemPrompt = null }) {
  const args = ['-p', '--permission-mode', mode];
  if (resume) args.push('--resume', sessionId);
  else args.push('--session-id', sessionId);
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  return args;
}

/** Environment for the child: drop the markers that make Claude Code think it is nested. */
export function taskEnv(env = process.env, taskId) {
  const out = { ...env, AGENT_OFFICE_TASK: taskId };
  delete out.CLAUDECODE;
  delete out.CLAUDE_CODE_ENTRYPOINT;
  delete out.CLAUDE_CODE_SSE_PORT;
  return out;
}

export class Tasks extends EventEmitter {
  constructor(cfg, { spawnFn = spawn, now = () => Date.now(), find = findClaude } = {}) {
    super();
    this.cfg = cfg;
    this.spawnFn = spawnFn;
    this.now = now;
    this.find = find;
    this.items = new Map(); // id -> { task, child, timer }
  }

  get enabled() { return this.cfg.tasks?.enabled !== false; }
  get maxRunning() { return this.cfg.tasks?.maxRunning ?? 6; }
  binary() { return this.enabled ? this.find(this.cfg) : null; }

  list() {
    return [...this.items.values()].map((e) => e.task).sort((a, b) => a.startedAt - b.startedAt);
  }

  running() { return this.list().filter((t) => t.status === 'running'); }

  activeFor(sessionId) {
    return this.list().find((t) => t.sessionId === sessionId && t.status === 'running') || null;
  }

  /**
   * Starts a task. `sessionId` + `resume: true` gives an existing robot a new prompt;
   * `resume: false` hires a new robot (a fresh session id is generated here).
   * Returns { task } or { error, code }.
   */
  start({ sessionId = null, resume = false, cwd, project, prompt, mode, branch = null, worktree = null, systemPrompt = null, dept = null, team = null, outputLimit = TAIL, maxPrompt = MAX_PROMPT }) {
    if (!this.enabled) return { error: 'Tasks are turned off in config.json (tasks.enabled).', code: 403 };
    prompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (!prompt) return { error: 'Write a task first.', code: 400 };
    if (prompt.length > maxPrompt) return { error: `Tasks are limited to ${maxPrompt.toLocaleString()} characters.`, code: 400 };
    mode = mode || this.cfg.tasks?.defaultMode || 'acceptEdits';
    if (!MODES.includes(mode)) return { error: 'Unknown mode.', code: 400 };
    if (!cwd || !path.isAbsolute(cwd)) return { error: 'This robot has no known working folder yet.', code: 409 };
    try { if (!fs.statSync(cwd).isDirectory()) throw 0; } catch { return { error: `Folder not found: ${cwd}`, code: 409 }; }
    if (resume && this.activeFor(sessionId)) return { error: 'This robot is already on a task.', code: 409 };
    if (this.running().length >= this.maxRunning) return { error: `${this.maxRunning} tasks are already running. Wait for one to finish or stop one.`, code: 429 };
    const bin = this.binary();
    if (!bin) return { error: 'Claude Code CLI not found. Set tasks.claudePath in config.json.', code: 503 };

    const id = crypto.randomUUID();
    if (!resume) sessionId = crypto.randomUUID();
    const task = {
      id, sessionId, newRobot: !resume, project: project || path.basename(cwd), cwd, mode, branch, worktree, dept, team,
      prompt: prompt.length > 300 ? prompt.slice(0, 300) + '…' : prompt,
      status: 'running', startedAt: this.now(), endedAt: null, exitCode: null, error: null, output: '',
    };
    let child;
    try {
      child = this.spawnFn(bin, taskArgs({ sessionId, resume, mode, systemPrompt: systemPrompt ? String(systemPrompt).slice(0, 8000) : null }), {
        cwd, env: taskEnv(process.env, id), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (e) {
      return { error: `Could not start Claude Code: ${e.message}`, code: 500 };
    }
    const entry = { task, child, timer: null, stopping: false, stderr: '', full: '', limit: Math.max(TAIL, outputLimit) };
    this.items.set(id, entry);

    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (c) => {
      task.output = (task.output + c).slice(-TAIL);
      if (entry.limit > TAIL) entry.full = (entry.full + c).slice(-entry.limit);
    });
    child.stderr?.on('data', (c) => { entry.stderr = (entry.stderr + c).slice(-TAIL); });
    child.on('error', (e) => this._finish(id, null, e.message));
    child.on('close', (code, signal) => this._finish(id, code, signal ? `stopped (${signal})` : null));
    child.stdin?.on('error', () => {});
    child.stdin?.end(prompt);

    this.emit('change');
    return { task };
  }

  stop(id) {
    const e = this.items.get(id);
    if (!e || e.task.status !== 'running') return false;
    e.stopping = true;
    try { e.child.kill('SIGINT'); } catch {}
    // Claude Code exits on SIGINT; make sure it really goes away.
    setTimeout(() => { if (e.task.status === 'running') { try { e.child.kill('SIGTERM'); } catch {} } }, 4000).unref?.();
    return true;
  }

  stopAll() {
    for (const e of this.items.values()) if (e.task.status === 'running') { try { e.child.kill('SIGTERM'); } catch {} }
  }

  _finish(id, code, err) {
    const e = this.items.get(id);
    if (!e || e.task.status !== 'running') return;
    const t = e.task;
    t.endedAt = this.now();
    t.exitCode = code;
    if (e.stopping) t.status = 'stopped';
    else if (code === 0) t.status = 'done';
    else {
      t.status = 'failed';
      t.error = (e.stderr.trim() || err || `exited with code ${code}`).slice(-1000);
    }
    e.timer = setTimeout(() => { this.items.delete(id); this.emit('change'); }, LINGER_MS);
    e.timer.unref?.();
    // Team runs listen for this to read the reply and pass the work on.
    this.emit('finished', t, e.limit > TAIL ? e.full : t.output);
    this.emit('change');
  }
}
