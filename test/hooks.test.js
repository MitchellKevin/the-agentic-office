import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { addHooks, removeHooks, EVENTS, HOOK_PATH } from '../scripts/hooks-lib.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { cfg as baseCfg, FIX } from './helpers.js';

const ROOT = path.resolve(path.dirname(HOOK_PATH), '..');

test('addHooks keeps existing hooks and is idempotent; removeHooks undoes exactly', () => {
  const original = {
    model: 'opus',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter.sh' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    },
  };
  const copy = JSON.parse(JSON.stringify(original));
  const { settings, added } = addHooks(copy);
  assert.deepEqual(added.sort(), Object.keys(EVENTS).sort());
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'my-linter.sh');
  assert.equal(settings.hooks.PermissionRequest[0].hooks[0].timeout, 60);
  assert.equal(settings.hooks.UserPromptSubmit[0].matcher, undefined);
  assert.equal(addHooks(settings).added.length, 0, 'second run adds nothing');
  const { settings: back, removed } = removeHooks(settings);
  assert.equal(removed.length, Object.keys(EVENTS).length);
  assert.deepEqual(back, original);
});

test('removeHooks drops the hooks key entirely when only ours were present', () => {
  const { settings } = addHooks({ model: 'x' });
  assert.deepEqual(removeHooks(settings).settings, { model: 'x' });
});

test('setup-hooks / remove-hooks CLI round-trip on a temp settings file with backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-settings-'));
  const file = path.join(dir, 'settings.json');
  const original = { permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } };
  fs.writeFileSync(file, JSON.stringify(original, null, 2));
  execFileSync('node', [path.join(ROOT, 'scripts/setup-hooks.js'), '--settings', file]);
  const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(installed.hooks.PermissionRequest);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.agent-office-') && f.endsWith('.bak')));
  execFileSync('node', [path.join(ROOT, 'scripts/remove-hooks.js'), '--settings', file]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
});

test('setup-hooks refuses to touch an unparsable settings file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-settings-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => execFileSync('node', [path.join(ROOT, 'scripts/setup-hooks.js'), '--settings', file], { stdio: 'pipe' }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

// ---------- hook.js end-to-end ----------

function runHook(payload, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('node', [HOOK_PATH], { env: { ...process.env, AGENT_OFFICE_PORT: String(port) } });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.on('close', (code) => resolve({ code, out, ms: Date.now() - t0 }));
    p.stdin.end(JSON.stringify(payload));
  });
}

const perm = { session_id: 'hook-s1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, cwd: '/work/demo-app', transcript_path: path.join(FIX, 'projects', '-work-demo-app', 'hook-s1.jsonl') };

test('hook exits 0 quickly with no output when the server is down', async () => {
  const r = await runHook(perm, 4398);
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.ok(r.ms < 3000, `took ${r.ms}ms`);
});

test('hook: no tab → no output; tab + Allow → allow JSON; AskUserQuestion never answered', async () => {
  const port = 4396;
  const cfg = { ...baseCfg, port, projectsDir: path.join(FIX, 'projects'), approvalWaitSeconds: 5 };
  const store = new Store(cfg);
  const { server, token } = createServer(cfg, store);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    // 1) no browser tab connected
    let r = await runHook(perm, port);
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.equal(store.sessions.get('hook-s1').id, 'hook-s1');

    // 2) connect a "tab" (SSE with the UI token), then approve from the API
    const sse = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: `/events?token=${token}`, headers: { Host: `127.0.0.1:${port}` } }, (res) => resolve({ req, res }));
    });
    const pending = runHook(perm, port);
    let item = null;
    for (let i = 0; i < 50 && !item; i++) { await new Promise((r) => setTimeout(r, 50)); item = store.approvals.list()[0]; }
    assert.ok(item, 'approval queued');
    assert.equal(item.tool, 'Bash');
    // token is required
    const bad = await fetch(`http://127.0.0.1:${port}/api/approvals/${item.id}`, { method: 'POST', body: '{"decision":"allow"}' });
    assert.equal(bad.status, 403);
    const ok = await fetch(`http://127.0.0.1:${port}/api/approvals/${item.id}`, { method: 'POST', headers: { 'X-AO-Token': token }, body: '{"decision":"allow"}' });
    assert.equal(ok.status, 200);
    r = await pending;
    assert.deepEqual(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });

    // 3) deny path
    const pending2 = runHook(perm, port);
    item = null;
    for (let i = 0; i < 50 && !item; i++) { await new Promise((r) => setTimeout(r, 50)); item = store.approvals.list()[0]; }
    await fetch(`http://127.0.0.1:${port}/api/approvals/${item.id}`, { method: 'POST', headers: { 'X-AO-Token': token }, body: '{"decision":"deny"}' });
    r = await pending2;
    assert.equal(JSON.parse(r.out).hookSpecificOutput.decision.behavior, 'deny');
    assert.equal(JSON.parse(r.out).hookSpecificOutput.decision.message, 'Denied from Agent Office');

    // 4) AskUserQuestion is flagged but never auto-answered, even with a tab open
    r = await runHook({ ...perm, tool_name: 'AskUserQuestion' }, port);
    assert.equal(r.out, '');
    assert.equal(store.approvals.list().length, 0);
    assert.equal(store.summary(store.sessions.get('hook-s1')).status, 'needs_you');

    // 5) other events are fire-and-forget
    r = await runHook({ session_id: 'hook-s1', hook_event_name: 'Stop' }, port);
    assert.equal(r.out, '');
    sse.req.destroy();
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
