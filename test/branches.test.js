import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitInfo, parseWorktrees } from '../src/git.js';
import { ensureWorktree, slugBranch, WorktreeError } from '../src/worktrees.js';
import { startTask } from '../src/server.js';
import { Store } from '../src/store.js';
import { cfg as baseCfg } from './helpers.js';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-repo-')));
  const repo = path.join(dir, 'my-app');
  fs.mkdirSync(repo);
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { env: GIT_ENV, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  g('branch', 'feature/login');
  g('branch', 'fix-typo');
  return { dir, repo, root: path.join(dir, 'worktrees'), g };
}

test('parseWorktrees reads porcelain output', () => {
  const out = parseWorktrees('worktree /a\nHEAD 111\nbranch refs/heads/main\n\nworktree /b\nHEAD 222\ndetached\n\n');
  assert.deepEqual(out.map((w) => [w.path, w.branch, w.detached]), [['/a', 'main', false], ['/b', null, true]]);
});

test('slugBranch makes folder-safe names', () => {
  assert.equal(slugBranch('feature/login'), 'feature-login');
  assert.equal(slugBranch('..weird//name..'), 'weird-name');
  assert.equal(slugBranch('///'), 'branch');
});

test('GitInfo knows repos, branches and worktrees; non-repos are flagged', async () => {
  const { repo, dir } = makeRepo();
  const git = new GitInfo();
  const r = await git.repo(repo);
  assert.equal(r.isRepo, true);
  assert.equal(r.name, 'my-app');
  assert.equal(r.branch, 'main');
  assert.equal(r.mainTop, repo);
  assert.equal(r.isWorktree, false);
  assert.equal((await git.repo(dir)).isRepo, false);
  const names = (await git.branches(repo)).map((b) => b.name).sort();
  assert.deepEqual(names, ['feature/login', 'fix-typo', 'main']);
  assert.equal((await git.worktrees(repo))[0].branch, 'main');
});

test('ensureWorktree reuses checked-out branches, creates worktrees for the rest', async () => {
  const { repo, root } = makeRepo();
  const git = new GitInfo();
  const info = await git.repo(repo);

  const onMain = await ensureWorktree({ git, repo: info, branch: 'main', root });
  assert.equal(onMain.cwd, repo);
  assert.equal(onMain.created, false);

  const login = await ensureWorktree({ git, repo: info, branch: 'feature/login', root });
  assert.equal(login.cwd, path.join(root, 'my-app', 'feature-login'));
  assert.equal(login.created, true);
  assert.ok(fs.existsSync(path.join(login.cwd, 'a.txt')));

  const again = await ensureWorktree({ git, repo: info, branch: 'feature/login', root });
  assert.equal(again.cwd, login.cwd);
  assert.equal(again.reused, true);

  // A worktree belongs to the same repo (same floor key) and reports its own branch.
  const wt = await git.repo(login.cwd, { fresh: true });
  assert.equal(wt.key, info.key);
  assert.equal(wt.isWorktree, true);
  assert.equal(wt.branch, 'feature/login');
});

test('ensureWorktree creates new branches and rejects bad input', async () => {
  const { repo, root, g } = makeRepo();
  const git = new GitInfo();
  const info = await git.repo(repo);

  const made = await ensureWorktree({ git, repo: info, newBranch: 'feat/new-thing', base: 'main', root });
  assert.equal(made.branch, 'feat/new-thing');
  assert.ok(String(g('branch', '--list', 'feat/new-thing')).includes('feat/new-thing'));

  await assert.rejects(ensureWorktree({ git, repo: info, newBranch: 'fix-typo', root }), (e) => e instanceof WorktreeError && e.code === 409);
  await assert.rejects(ensureWorktree({ git, repo: info, newBranch: '-rf', root }), WorktreeError);
  await assert.rejects(ensureWorktree({ git, repo: info, newBranch: 'has space', root }), WorktreeError);
  await assert.rejects(ensureWorktree({ git, repo: info, branch: 'nope', root }), (e) => e.code === 404);
  await assert.rejects(ensureWorktree({ git, repo: info, newBranch: 'x', base: 'no-such-base', root }), (e) => e.code === 404);
});

function storeWithRepo(repo, root) {
  const cfg = { ...baseCfg, projectsDir: path.join(os.tmpdir(), 'ao-none'), tasks: { ...baseCfg.tasks, worktreeRoot: root } };
  const store = new Store(cfg);
  const s = store.ensureMain('s-repo', '-my-app');
  s.cwd = repo;
  s.lastActivity = Date.now();
  const started = [];
  store.tasks.start = (args) => { started.push(args); return { task: { ...args, id: 't1' } }; };
  store.tasks.binary = () => '/usr/bin/true';
  return { store, started };
}

test('startTask on a branch hires a robot in that branch\'s worktree, on the repo\'s floor', async () => {
  const { repo, root } = makeRepo();
  const { store, started } = storeWithRepo(repo, root);
  const info = await store.git.repo(repo);
  assert.equal(store.placeOf(store.sessions.get('s-repo')).projectKey, info.key);

  const r = await startTask(store, { projectKey: info.key, branch: 'fix-typo', prompt: 'Fix the typo', mode: 'acceptEdits' });
  assert.equal(r.error, undefined);
  assert.equal(started[0].cwd, path.join(root, 'my-app', 'fix-typo'));
  assert.equal(started[0].branch, 'fix-typo');
  assert.equal(started[0].resume, false);

  const onMain = await startTask(store, { projectKey: info.key, branch: 'main', prompt: 'Go', mode: 'plan' });
  assert.equal(onMain.error, undefined);
  assert.equal(started[1].cwd, repo);
  assert.equal(started[1].worktree, null);

  const nb = await startTask(store, { projectKey: info.key, newBranch: 'feature/robots', prompt: 'Build robots' });
  assert.equal(started[2].branch, 'feature/robots');

  const branches = await store.branchesFor(info.key);
  const byName = Object.fromEntries(branches.branches.map((b) => [b.name, b]));
  assert.equal(byName.main.checkedOut, 'main');
  assert.equal(byName['fix-typo'].checkedOut, 'worktree');
  assert.equal(branches.current, 'main');
});

test('startTask checks the prompt before creating a worktree', async () => {
  const { repo, root } = makeRepo();
  const { store, started } = storeWithRepo(repo, root);
  const info = await store.git.repo(repo);
  const r = await startTask(store, { projectKey: info.key, branch: 'fix-typo', prompt: '   ' });
  assert.equal(r.code, 400);
  assert.equal(started.length, 0);
  assert.equal(fs.existsSync(path.join(root, 'my-app', 'fix-typo')), false);
});
