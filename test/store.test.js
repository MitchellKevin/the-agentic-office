import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Store } from '../src/store.js';
import { FIX, cfg } from './helpers.js';

const NOW = Date.parse('2026-01-10T10:01:00Z');
const mk = () => new Store({ ...cfg, projectsDir: path.join(FIX, 'projects') }, { now: () => NOW });

test('scan loads main sessions and links subagents via meta.json toolUseId', async () => {
  const store = mk();
  store.cfg.hideOlderThanHours = 1e6; // fixtures are old; load them all
  await store.scan();
  assert.equal(store.sessions.size, 1);
  assert.equal(store.subs.size, 1);
  const d = store.detail('s1');
  const agentStep = d.steps.find((s) => s.id === 'toolu_agent');
  assert.equal(agentStep.subagent, 's1/abc123');
  assert.equal(d.subagents[0].type, 'Explore');
  assert.equal(d.subagents[0].description, 'Find auth code');
  assert.equal(d.subagents[0].status, 'done');
  const sum = store.summary(store.sessions.get('s1'));
  assert.equal(sum.project, 'demo-app');
  assert.equal(sum.status, 'your_turn');
  assert.equal(sum.files, 2);
  assert.equal(sum.errors, 1);
  store.approvals.removeAllListeners();
});

test('hooks overlay status, create sessions before transcripts exist, and cancel approvals', async () => {
  const store = mk();
  store.cfg.hideOlderThanHours = 1e6;
  await store.scan();
  const s1 = store.sessions.get('s1');
  // fresh hook beats transcript
  store.now = () => s1.lastActivity + 1000;
  store.applyHook({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm run build' } });
  let sum = store.summary(s1);
  assert.equal(sum.status, 'working');
  assert.equal(sum.current.label, 'Bash npm run build');
  assert.equal(sum.hooks, true);

  const { promise } = store.approvals.add({ sessionId: 's1', agentId: null, tool: 'Bash' }, 10_000);
  assert.equal(store.summary(s1).status, 'needs_you');
  store.applyHook({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.equal(await promise, null);
  assert.equal(store.approvals.items.size, 0);

  store.applyHook({ session_id: 'new-session', hook_event_name: 'UserPromptSubmit', cwd: '/work/other', transcript_path: path.join(FIX, 'projects', '-work-other', 'new-session.jsonl') });
  const ns = store.summary(store.sessions.get('new-session'));
  assert.equal(ns.project, 'other');
  assert.equal(ns.status, 'working');
  assert.equal(ns.hidden, false);
});
