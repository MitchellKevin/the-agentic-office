import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, applyLine } from '../src/parser.js';
import { transcriptStatus, combinedStatus, hookStatus } from '../src/status.js';
import { parseFile, MAIN, cfg } from './helpers.js';

const T0 = Date.parse('2026-01-01T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function session(lines) {
  const s = createSession({ id: 'st' });
  lines.forEach((l, i) => applyLine(s, { uuid: 'l' + i, ...l }, cfg));
  return s;
}
const prompt = (ms, text = 'do it') => ({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: text } });
const tool = (ms, name, id = 't1', input = {}) => ({ type: 'assistant', timestamp: iso(ms), message: { id: 'm' + id, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } });
const result = (ms, id = 't1') => ({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const reply = (ms, stop = 'end_turn') => ({ type: 'assistant', timestamp: iso(ms), message: { id: 'mr' + ms, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'done' }], stop_reason: stop } });

test('prompt just sent → working (thinking)', () => {
  const s = session([prompt(T0)]);
  assert.equal(transcriptStatus(s, T0 + 2000, cfg).status, 'working');
});

test('long tool running → working with current step', () => {
  const s = session([prompt(T0), tool(T0 + 1000, 'Bash', 't1', { command: 'npm test' })]);
  const r = transcriptStatus(s, T0 + 60_000, cfg);
  assert.equal(r.status, 'working');
  assert.equal(r.step.label, 'Bash npm test');
});

test('quick tool open > 8s → needs_you (probably permission)', () => {
  const s = session([prompt(T0), tool(T0 + 1000, 'Edit', 't1', { file_path: '/x/server.js' })]);
  assert.equal(transcriptStatus(s, T0 + 5000, cfg).status, 'working');
  const r = transcriptStatus(s, T0 + 10_000, cfg);
  assert.equal(r.status, 'needs_you');
  assert.equal(r.guessed, true);
});

test('AskUserQuestion / ExitPlanMode open → needs_you immediately', () => {
  for (const name of ['AskUserQuestion', 'ExitPlanMode']) {
    const s = session([prompt(T0), tool(T0 + 1000, name)]);
    assert.equal(transcriptStatus(s, T0 + 1500, cfg).status, 'needs_you', name);
  }
});

test('tool result back → working; end_turn → your_turn', () => {
  const s = session([prompt(T0), tool(T0 + 1000, 'Read'), result(T0 + 1200)]);
  assert.equal(transcriptStatus(s, T0 + 2000, cfg).status, 'working');
  applyLine(s, { uuid: 'z', ...reply(T0 + 3000) }, cfg);
  assert.equal(transcriptStatus(s, T0 + 4000, cfg).status, 'your_turn');
});

test('streaming assistant (stop_reason null) → working', () => {
  const s = session([prompt(T0), reply(T0 + 1000, null)]);
  assert.equal(transcriptStatus(s, T0 + 2000, cfg).status, 'working');
});

test('> idleMinutes since last activity → idle', () => {
  const s = session([prompt(T0), reply(T0 + 1000)]);
  assert.equal(transcriptStatus(s, T0 + 31 * 60_000, cfg).status, 'idle');
});

test('fixture session ends as your_turn', () => {
  const s = parseFile(MAIN);
  assert.equal(transcriptStatus(s, Date.parse('2026-01-10T10:01:00Z'), cfg).status, 'your_turn');
});

test('hook events map to statuses', () => {
  assert.equal(hookStatus({ hook_event_name: 'UserPromptSubmit' }, cfg).status, 'working');
  assert.equal(hookStatus({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }, cfg).status, 'needs_you');
  assert.equal(hookStatus({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }, cfg).status, 'needs_you');
  assert.equal(hookStatus({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }, cfg).status, 'needs_you');
  assert.equal(hookStatus({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }, cfg).status, 'your_turn');
  assert.equal(hookStatus({ hook_event_name: 'Stop' }, cfg).status, 'your_turn');
  assert.equal(hookStatus({ hook_event_name: 'SessionEnd' }, cfg).status, 'ended');
});

test('fresh hook overrides transcript heuristic; stale hook does not', () => {
  const s = session([prompt(T0), tool(T0 + 1000, 'Bash')]);
  const hook = { ts: T0 + 1200, status: 'needs_you', reason: 'permission request' };
  assert.equal(combinedStatus(s, hook, T0 + 3000, cfg).status, 'needs_you');
  applyLine(s, { uuid: 'r', ...result(T0 + 9000) }, cfg);
  assert.equal(combinedStatus(s, hook, T0 + 9500, cfg).status, 'working');
});

test('pending approval forces needs_you; SessionEnd forces ended', () => {
  const s = session([prompt(T0)]);
  assert.equal(combinedStatus(s, null, T0 + 1000, cfg, true).status, 'needs_you');
  assert.equal(combinedStatus(s, { ts: T0, status: 'ended' }, T0 + 1000, cfg).status, 'ended');
});
