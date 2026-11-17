// Read-only git queries (repo, branches, worktrees), cached briefly.
// Every call goes through execFile (no shell) with a timeout, and GIT_OPTIONAL_LOCKS=0 so
// looking at a repo never takes the index lock away from an agent that is working in it.
import { execFile } from 'node:child_process';
import path from 'node:path';

export function runGit(args, cwd, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || '').trim(); reject(err); return; }
      resolve(String(stdout));
    });
  });
}

/** Parses `git worktree list --porcelain`. */
export function parseWorktrees(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: null, head: null, detached: false, bare: false, locked: false, prunable: false }; out.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('locked')) cur.locked = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return out;
}

export class GitInfo {
  /**
   * @param onUpdate called when a cached repo lookup finishes (so the store can re-broadcast)
   */
  constructor({ ttlMs = 20_000, run = runGit, onUpdate = () => {}, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.run = run;
    this.onUpdate = onUpdate;
    this.now = now;
    this.repos = new Map();     // cwd -> { at, value, pending }
    this.lists = new Map();     // `${kind}:${mainTop}` -> { at, value }
  }

  /** Full lookup for a folder. Resolves { isRepo:false } outside git. */
  async repo(cwd, { fresh = false } = {}) {
    const hit = this.repos.get(cwd);
    if (!fresh && hit && hit.value && this.now() - hit.at < this.ttlMs) return hit.value;
    if (!fresh && hit?.pending) return hit.pending;
    const pending = this._lookup(cwd).then((value) => {
      this.repos.set(cwd, { at: this.now(), value, pending: null });
      const changed = JSON.stringify(hit?.value) !== JSON.stringify(value);
      if (changed) this.onUpdate(cwd, value);
      return value;
    });
    this.repos.set(cwd, { at: hit?.at ?? 0, value: hit?.value ?? null, pending });
    return pending;
  }

  /** Synchronous cached value (or undefined); refreshes in the background when stale. */
  peek(cwd) {
    if (!cwd) return undefined;
    const hit = this.repos.get(cwd);
    if (!hit || (!hit.pending && this.now() - hit.at >= this.ttlMs)) this.repo(cwd).catch(() => {});
    return hit?.value ?? undefined;
  }

  async _lookup(cwd) {
    try {
      const out = await this.run(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--abbrev-ref', 'HEAD'], cwd);
      const [top, commonDir, head] = out.split('\n').map((s) => s.trim());
      if (!top || !commonDir) return { isRepo: false };
      // The main worktree is the folder that owns the shared .git directory.
      const mainTop = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : top;
      return {
        isRepo: true,
        key: `git:${commonDir}`,
        name: path.basename(mainTop),
        top,
        mainTop,
        commonDir,
        branch: head && head !== 'HEAD' ? head : null,
        isWorktree: top !== mainTop,
      };
    } catch {
      return { isRepo: false };
    }
  }

  async _list(kind, mainTop, fresh, fn) {
    const k = `${kind}:${mainTop}`;
    const hit = this.lists.get(k);
    if (!fresh && hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const value = await fn();
    this.lists.set(k, { at: this.now(), value });
    return value;
  }

  /** Local branches, most recently committed first. */
  branches(mainTop, { fresh = false } = {}) {
    return this._list('branches', mainTop, fresh, async () => {
      const out = await this.run(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/heads'], mainTop);
      return out.split('\n').filter(Boolean).map((l) => {
        const [name, date] = l.split('\t');
        return { name, date: Number(date) * 1000 || null };
      });
    });
  }

  worktrees(mainTop, { fresh = false } = {}) {
    return this._list('worktrees', mainTop, fresh, async () => parseWorktrees(await this.run(['worktree', 'list', '--porcelain'], mainTop)));
  }

  invalidate(mainTop) {
    this.lists.delete(`branches:${mainTop}`);
    this.lists.delete(`worktrees:${mainTop}`);
    for (const [cwd, v] of this.repos) if (v.value?.mainTop === mainTop) v.at = 0;
  }
}
