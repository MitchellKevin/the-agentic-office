// One folder per branch: finds the folder where a branch is already checked out, or creates a
// git worktree for it under the worktree root (default ~/agent-office-worktrees/<repo>/<branch>).
// Only ever runs `git worktree add` (and `-b` for a new branch). Never checks out, deletes,
// commits or pushes.
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './config.js';

export class WorktreeError extends Error {
  constructor(message, code = 400) { super(message); this.code = code; }
}

/** File-system friendly version of a branch name: feature/login → feature-login. */
export function slugBranch(branch) {
  const s = String(branch).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  return s || 'branch';
}

/** Rejects anything git would not accept as a branch name (and anything that looks like an option). */
export async function checkBranchName(name, cwd, run) {
  if (typeof name !== 'string' || !name.trim()) throw new WorktreeError('Give the branch a name.');
  name = name.trim();
  if (name.length > 200) throw new WorktreeError('That branch name is too long.');
  if (name.startsWith('-') || /[\s~^:?*[\\]/.test(name)) throw new WorktreeError(`"${name}" is not a valid branch name.`);
  try { await run(['check-ref-format', '--branch', name], cwd); }
  catch { throw new WorktreeError(`"${name}" is not a valid branch name.`); }
  return name;
}

export function worktreeRoot(cfg) {
  return path.resolve(expandHome(cfg.tasks?.worktreeRoot || '~/agent-office-worktrees'));
}

async function branchExists(name, cwd, run) {
  try { await run(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], cwd); return true; } catch { return false; }
}

/**
 * Returns { cwd, branch, created, reused } for the folder an agent should work in.
 *   repo: result of GitInfo.repo() (needs mainTop, name)
 *   branch: existing local branch to work on
 *   newBranch + base: create a branch from base (default: the main folder's current branch)
 */
export async function ensureWorktree({ git, repo, branch, newBranch, base, root }) {
  const run = git.run;
  const mainTop = repo.mainTop;
  const worktrees = (await git.worktrees(mainTop, { fresh: true })).filter((w) => !w.bare && !w.prunable);
  const dirFor = (name) => path.join(root, slugBranch(repo.name), slugBranch(name));

  if (newBranch) {
    const name = await checkBranchName(newBranch, mainTop, run);
    if (await branchExists(name, mainTop, run)) throw new WorktreeError(`Branch "${name}" already exists. Pick it from the list instead.`, 409);
    const from = base ? String(base).trim() : (worktrees.find((w) => w.path === mainTop)?.branch || 'HEAD');
    if (from.startsWith('-')) throw new WorktreeError('Invalid base branch.');
    try { await run(['rev-parse', '--verify', '--quiet', `${from}^{commit}`], mainTop); }
    catch { throw new WorktreeError(`Base "${from}" not found.`, 404); }
    const dest = dirFor(name);
    if (fs.existsSync(dest)) throw new WorktreeError(`The folder ${dest} already exists.`, 409);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { await run(['worktree', 'add', '-b', name, dest, from], mainTop, { timeout: 60_000 }); }
    catch (e) { throw new WorktreeError(`Could not create the worktree: ${e.stderr || e.message}`, 500); }
    git.invalidate(mainTop);
    return { cwd: dest, branch: name, created: true, reused: false };
  }

  const name = await checkBranchName(branch, mainTop, run);
  // Already checked out somewhere (the main folder or an existing worktree): work there.
  const hit = worktrees.find((w) => w.branch === name);
  if (hit) {
    if (!fs.existsSync(hit.path)) throw new WorktreeError(`Branch "${name}" is checked out in ${hit.path}, which no longer exists. Run "git worktree prune" in the repo.`, 409);
    return { cwd: hit.path, branch: name, created: false, reused: true };
  }
  if (!(await branchExists(name, mainTop, run))) throw new WorktreeError(`Branch "${name}" not found.`, 404);
  const dest = dirFor(name);
  if (fs.existsSync(dest)) throw new WorktreeError(`The folder ${dest} already exists but is not a worktree of ${name}.`, 409);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { await run(['worktree', 'add', dest, name], mainTop, { timeout: 60_000 }); }
  catch (e) { throw new WorktreeError(`Could not create the worktree: ${e.stderr || e.message}`, 500); }
  git.invalidate(mainTop);
  return { cwd: dest, branch: name, created: true, reused: false };
}
