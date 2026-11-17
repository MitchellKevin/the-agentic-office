import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Tasks, findClaude, taskArgs, taskEnv } from '../src/tasks.js';
import { createServer, startTask } from '../src/server.js';
import { Store } from '../src/store.js';
import { cfg as baseCfg } from './helpers.js';

function fakeSpawn() {
  const calls = [];
  const fn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stdin = Object.assign(new EventEmitter(), { end(d) { child.stdinData = d; } });
    child.kill = (sig) => { child.killed = sig; setImmediate(() => child.emit('close', null, sig)); };
    calls.push({ bin, args, opts, child });
    return child;
  };
  fn.calls = calls;
  return fn;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-tasks-'));
const cfg = { ...baseCfg, tasks: { enabled: true, maxRunning: 2 } };
const find = () => '/fake/claude';

test('taskArgs: resume an existing robot vs hire a new one; prompt never in argv', () => {
  assert.deepEqual(taskArgs({ sessionId: 'abc', resume: true, mode: 'plan' }), ['-p', '--permission-mode', 'plan', '--resume', 'abc']);
  assert.deepEqual(taskArgs({ sessionId: 'new', resume: false, mode: 'acceptEdits' }), ['-p', '--permission-mode', 'acceptEdits', '--session-id', 'new']);
});

test('taskEnv drops the nested-session markers', () => {
  const env = taskEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' }, 't1');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.AGENT_OFFICE_TASK, 't1');
});

test('Tasks: runs, pipes the prompt on stdin, finishes, and validates input', async () => {
  const spawnFn = fakeSpawn();
  const tasks = new Tasks(cfg, { spawnFn, find });
  let changes = 0;
  tasks.on('change', () => changes++);

  assert.match(tasks.start({ sessionId: 's1', resume: true, cwd: tmp, prompt: '  ' }).error, /Write a task/);
  assert.match(tasks.start({ sessionId: 's1', resume: true, cwd: tmp, prompt: 'x', mode: 'bypassPermissions' }).error, /Unknown mode/);
  assert.match(tasks.start({ sessionId: 's1', resume: true, cwd: '/definitely/not/here', prompt: 'x' }).error, /Folder not found/);
  assert.match(tasks.start({ sessionId: 's1', resume: true, cwd: 'relative', prompt: 'x' }).error, /no known working folder/);
  assert.equal(spawnFn.calls.length, 0);

  const { task } = tasks.start({ sessionId: 's1', resume: true, cwd: tmp, prompt: '--help me fix the build', mode: 'plan' });
  assert.equal(task.status, 'running');
  assert.equal(task.sessionId, 's1');
  const call = spawnFn.calls[0];
  assert.equal(call.bin, '/fake/claude');
  assert.equal(call.opts.cwd, tmp);
  assert.ok(!call.args.includes('--help me fix the build'), 'prompt is not an argument');
  assert.equal(call.child.stdinData, '--help me fix the build');
  assert.equal(tasks.activeFor('s1').id, task.id);
  assert.match(tasks.start({ sessionId: 's1', resume: true, cwd: tmp, prompt: 'again' }).error, /already on a task/);

  call.child.stdout.emit('data', 'All fixed.');
  call.child.emit('close', 0, null);
  assert.equal(task.status, 'done');
  assert.equal(task.output, 'All fixed.');
  assert.equal(tasks.activeFor('s1'), null);
  assert.ok(changes >= 2);
});

test('Tasks: new robot gets its own session id; failures keep stderr; stop marks stopped; cap on running', async () => {
  const spawnFn = fakeSpawn();
  const tasks = new Tasks(cfg, { spawnFn, find });
  const a = tasks.start({ resume: false, cwd: tmp, prompt: 'one' }).task;
  assert.ok(a.newRobot);
  assert.match(a.sessionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(spawnFn.calls[0].args.slice(-2), ['--session-id', a.sessionId]);

  const b = tasks.start({ resume: false, cwd: tmp, prompt: 'two' }).task;
  assert.equal(tasks.start({ resume: false, cwd: tmp, prompt: 'three' }).code, 429);

  spawnFn.calls[0].child.stderr.emit('data', 'Error: not logged in\n');
  spawnFn.calls[0].child.emit('close', 1, null);
  assert.equal(a.status, 'failed');
  assert.match(a.error, /not logged in/);

  assert.ok(tasks.stop(b.id));
  assert.equal(spawnFn.calls[1].child.killed, 'SIGINT');
  await new Promise((r) => setImmediate(r));
  assert.equal(b.status, 'stopped');
  assert.equal(tasks.stop(b.id), false);
});

test('Tasks: no CLI or turned off → clear errors, nothing spawned', () => {
  const spawnFn = fakeSpawn();
  assert.equal(new Tasks(cfg, { spawnFn, find: () => null }).start({ resume: false, cwd: tmp, prompt: 'x' }).code, 503);
  assert.equal(new Tasks({ ...cfg, tasks: { enabled: false } }, { spawnFn, find }).start({ resume: false, cwd: tmp, prompt: 'x' }).code, 403);
  assert.equal(spawnFn.calls.length, 0);
});

test('findClaude: config path, then PATH, then the newest editor-bundled binary', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-home-'));
  const mk = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '#!/bin/sh\n'); fs.chmodSync(p, 0o755); return p; };
  assert.equal(findClaude({}, { env: { PATH: '' }, home }), null);
  mk(path.join(home, '.vscode/extensions/anthropic.claude-code-2.1.9-darwin-arm64/resources/native-binary/claude'));
  const newest = mk(path.join(home, '.vscode/extensions/anthropic.claude-code-2.1.10-darwin-arm64/resources/native-binary/claude'));
  assert.equal(findClaude({}, { env: { PATH: '' }, home }), newest);
  const onPath = mk(path.join(home, 'bin/claude'));
  assert.equal(findClaude({}, { env: { PATH: path.join(home, 'bin') }, home }), onPath);
  assert.equal(findClaude({ tasks: { claudePath: newest } }, { env: { PATH: path.join(home, 'bin') }, home }), newest);
  assert.equal(findClaude({ tasks: { claudePath: '/nope/claude' } }, { env: {}, home }), null);
});

function storeWithRobot(sid = 'robot-1', projectDir = '-tmp-proj') {
  const store = new Store({ ...cfg, projectsDir: tmp });
  store.tasks.spawnFn = fakeSpawn();
  store.tasks.find = find;
  const s = store.ensureMain(sid, projectDir);
  s.cwd = tmp;
  s.lastActivity = Date.now() - 5 * 60_000;
  return { store, s };
}

test('startTask: resolves folders from known sessions only and refuses busy robots', async () => {
  const { store, s } = storeWithRobot();
  assert.equal((await startTask(store, { prompt: 'x' })).code, 400);
  assert.equal((await startTask(store, { sessionId: 'nobody', prompt: 'x' })).code, 404);
  assert.equal((await startTask(store, { projectKey: '-nope', prompt: 'x' })).code, 404);

  // A brand-new robot on the floor: cwd comes from the session we know, not the request.
  const hire = await startTask(store, { projectKey: '-tmp-proj', prompt: 'hire', cwd: '/etc' });
  assert.ok(hire.task.newRobot);
  assert.equal(store.tasks.spawnFn.calls[0].opts.cwd, tmp);

  // Give the existing robot a task: it shows as working straight away.
  const give = await startTask(store, { sessionId: s.id, prompt: 'give' });
  assert.equal(give.task.sessionId, s.id);
  const sum = store.summary(s);
  assert.equal(sum.status, 'working');
  assert.equal(sum.task, give.task.id);
  assert.match((await startTask(store, { sessionId: s.id, prompt: 'again' })).error, /busy/);
});

test('POST /api/tasks needs the page token and reports errors as JSON', async () => {
  const { store, s } = storeWithRobot('robot-2');
  const port = 4391;
  const scfg = { ...cfg, port, projectsDir: tmp };
  const { server, token } = createServer(scfg, store);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${port}/api/tasks`;
  try {
    let r = await fetch(url, { method: 'POST', body: JSON.stringify({ sessionId: s.id, prompt: 'x' }) });
    assert.equal(r.status, 403);
    r = await fetch(url, { method: 'POST', headers: { 'X-AO-Token': token, Origin: 'http://evil.example' }, body: '{}' });
    assert.equal(r.status, 403);
    r = await fetch(url, { method: 'POST', headers: { 'X-AO-Token': token }, body: JSON.stringify({ sessionId: s.id, prompt: '' }) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Write a task/);
    r = await fetch(url, { method: 'POST', headers: { 'X-AO-Token': token }, body: JSON.stringify({ sessionId: s.id, prompt: 'Run the tests' }) });
    assert.equal(r.status, 200);
    const { task } = await r.json();
    assert.equal(task.status, 'running');
    assert.equal(store.state().tasks.length, 1);

    r = await fetch(`${url}/${task.id}/stop`, { method: 'POST' });
    assert.equal(r.status, 403);
    r = await fetch(`${url}/${task.id}/stop`, { method: 'POST', headers: { 'X-AO-Token': token } });
    assert.equal(r.status, 200);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
