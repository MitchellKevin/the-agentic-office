import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, applyLine, sessionTitle, projectName, contextInfo, filesChanged, stepLabel, currentStep } from '../src/parser.js';
import { parseFile, MAIN, SUB, cfg } from './helpers.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('basic metadata, title precedence and project name', () => {
  const s = parseFile(MAIN);
  assert.equal(projectName(s), 'demo-app');
  assert.equal(s.cwd, '/work/demo-app');
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.gitBranch, 'main');
  // ai-title beats the first prompt
  assert.equal(sessionTitle(s), 'Fix empty-password login bug');
  // the /clear command and the isMeta image line are not the first prompt
  assert.equal(s.firstPrompt, 'Fix the login bug in server.js');
  assert.equal(s.costState.totalCostUSD, 0.05);
});

test('title falls back to summary, then first real prompt', () => {
  const s = createSession({ id: 'x' });
  applyLine(s, { type: 'user', uuid: '1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: '<system-reminder>hi</system-reminder>' } }, cfg);
  applyLine(s, { type: 'user', uuid: '2', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'Add dark mode' }] } }, cfg);
  assert.equal(sessionTitle(s), 'Add dark mode');
  applyLine(s, { type: 'summary', summary: 'Dark mode work' }, cfg);
  assert.equal(sessionTitle(s), 'Dark mode work');
});

test('usage is deduped by message.id (streamed lines repeat usage)', () => {
  const s = parseFile(MAIN);
  assert.deepEqual(s.tokens, { input: 33, output: 295, cacheRead: 9400, cacheWrite5m: 300, cacheWrite1h: 1000 });
  assert.equal(s.messages.size, 6);
});

test('estimated cost uses per-model price and the 1h/5m cache-write split', () => {
  const s = parseFile(MAIN);
  // see test/README in comments: opus-5-5 = $4 in, $20 out, $0.20 read, $5 5m write, $8 1h write
  near(s.cost, 0.017412);
  assert.equal(s.unpriced, false);
});

test('context usage = last turn input + cache read + cache write', () => {
  const s = parseFile(MAIN);
  const c = contextInfo(s, cfg);
  assert.equal(c.used, 2103);
  assert.equal(c.window, 1000000);
});

test('context window auto-bumps when observed context exceeds the table', () => {
  const s = createSession({ id: 'big' });
  applyLine(s, { type: 'assistant', uuid: 'a', timestamp: '2026-01-01T00:00:00Z', message: { id: 'm', model: 'claude-haiku-4-5', role: 'assistant', content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, cache_read_input_tokens: 300000, output_tokens: 1 } } }, cfg);
  assert.equal(contextInfo(s, cfg).window, 1000000);
});

test('steps pair tool_use with tool_result, with duration, errors and denials', () => {
  const s = parseFile(MAIN);
  assert.equal(s.steps.length, 6);
  const [edit, bash, write, agent, multi, nb] = s.steps;
  assert.equal(edit.label, 'Edit server.js');
  assert.equal(edit.status, 'ok');
  assert.equal(edit.durationMs, 2000);
  assert.equal(bash.label, 'Bash npm test');
  assert.equal(bash.status, 'error');
  assert.equal(bash.durationMs, 10000);
  assert.equal(write.status, 'denied');
  assert.equal(agent.label, 'Explore: Find auth code');
  assert.equal(multi.status, 'ok');
  assert.equal(nb.status, 'ok');
  assert.equal(s.openSteps.size, 0);
  assert.equal(currentStep(s), null);
});

test('files changed: Edit/MultiEdit/NotebookEdit counted, denied Write excluded', () => {
  const s = parseFile(MAIN);
  const files = filesChanged(s);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.equal(byPath['/work/demo-app/server.js'].count, 2);
  assert.deepEqual(byPath['/work/demo-app/server.js'].tools.sort(), ['Edit', 'MultiEdit']);
  assert.ok(byPath['/work/demo-app/analysis.ipynb']);
  assert.equal(byPath['/work/demo-app/README.md'], undefined);
});

test('subagent calls are recorded with type and description', () => {
  const s = parseFile(MAIN);
  const call = s.subagentCalls.get('toolu_agent');
  assert.equal(call.subagentType, 'Explore');
  assert.equal(call.description, 'Find auth code');
});

test('subagent transcript parses on its own with its own model and tokens', () => {
  const sub = parseFile(SUB, { id: 'abc123', parentId: 's1', meta: { description: 'Find auth code', toolUseId: 'toolu_agent' } });
  assert.equal(sub.model, 'claude-haiku-5-5');
  assert.equal(sub.tokens.input, 220);
  assert.equal(sessionTitle(sub), 'Find auth code');
  assert.equal(sub.steps[0].label, 'Grep "login"');
});

test('interrupt closes open steps and ends the turn', () => {
  const s = createSession({ id: 'i' });
  applyLine(s, { type: 'assistant', uuid: 'a', timestamp: '2026-01-01T00:00:00Z', message: { id: 'm', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'sleep 100' } }], stop_reason: 'tool_use' } }, cfg);
  assert.equal(s.openSteps.size, 1);
  applyLine(s, { type: 'user', uuid: 'b', timestamp: '2026-01-01T00:00:05Z', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }, cfg);
  assert.equal(s.openSteps.size, 0);
  assert.equal(s.steps[0].status, 'interrupted');
  assert.equal(s.lastEvent.kind, 'interrupt');
});

test('synthetic assistant messages do not count tokens or set the model', () => {
  const s = createSession({ id: 'y' });
  applyLine(s, { type: 'assistant', uuid: 'a', timestamp: '2026-01-01T00:00:00Z', message: { id: 'm', model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }], usage: { input_tokens: 0, output_tokens: 0 } } }, cfg);
  assert.equal(s.model, null);
  assert.equal(s.messages.size, 0);
});

test('step labels', () => {
  assert.equal(stepLabel('Read', { file_path: '/a/b/c.ts' }), 'Read c.ts');
  assert.equal(stepLabel('WebFetch', { url: 'https://example.com/x' }), 'WebFetch example.com');
  assert.equal(stepLabel('mcp__github__create_issue', {}), 'github: create_issue');
  assert.equal(stepLabel('AskUserQuestion', {}), 'Asking you a question');
});
