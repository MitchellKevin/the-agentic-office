import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Tasks } from '../src/tasks.js';
import { Org } from '../src/org.js';
import { Teams, parseHandoff, resolveTarget, turnPrompt, roleSystemPrompt } from '../src/teams.js';
import { Store } from '../src/store.js';
import { startTask, orgChange } from '../src/server.js';
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-teams-'));
const cfg = { ...baseCfg, tasks: { enabled: true, maxRunning: 4 }, teams: { defaultTurns: 8, maxTurns: 30 } };
const find = () => '/fake/claude';
const DEPTS = [
  { id: 'design', name: 'Design', role: 'Draw things.' },
  { id: 'development', name: 'Development', role: 'Build things.' },
  { id: 'qa', name: 'QA', role: 'Test things.' },
];

test('parseHandoff reads the last HANDOFF line, even in a code fence or with braces in strings', () => {
  const reply = 'I made the page.\n\n```\nHANDOFF {"to": "qa", "say": "Ready for testing", "message": "See {src/app.js}; run \\"npm test\\""}\n```\n';
  const h = parseHandoff(reply);
  assert.equal(h.to, 'qa');
  assert.equal(h.say, 'Ready for testing');
  assert.equal(h.message, 'See {src/app.js}; run "npm test"');
  assert.equal(h.before, 'I made the page.');
  // the last one wins
  assert.equal(parseHandoff('HANDOFF {"to":"a","say":"x"}\nmore\nHANDOFF {"to":"b","say":"y"}').to, 'b');
  // missing say: first sentence of the message, clipped
  assert.equal(parseHandoff('HANDOFF {"to":"qa","message":"All done. Next, test it."}').say, 'All done.');
  assert.equal(parseHandoff('HANDOFF {"to":"qa","say":"x"'), null, 'unfinished JSON');
  assert.equal(parseHandoff('no handoff here'), null);
  assert.equal(parseHandoff('HANDOFF {not json}'), null);
  assert.ok(parseHandoff(`HANDOFF {"to":"qa","say":"${'w '.repeat(200)}"}`).say.length <= 90);
});

test('resolveTarget: ids, names, done words, and the next floor as fallback', () => {
  assert.equal(resolveTarget(DEPTS, 'qa', 'design'), 'qa');
  assert.equal(resolveTarget(DEPTS, 'Development', 'design'), 'development');
  assert.equal(resolveTarget(DEPTS, 'done', 'qa'), 'done');
  assert.equal(resolveTarget(DEPTS, 'User', 'qa'), 'done');
  // unknown or itself → the next department in order, or done after the last one
  assert.equal(resolveTarget(DEPTS, 'marketing', 'design'), 'development');
  assert.equal(resolveTarget(DEPTS, 'design', 'design'), 'development');
  assert.equal(resolveTarget(DEPTS, '', 'qa'), 'done');
});

test('turnPrompt and roleSystemPrompt carry the goal, the roster, the message and the format', () => {
  const p = turnPrompt({ goal: 'Add a wishlist', project: 'shop', departments: DEPTS, dept: DEPTS[1], from: DEPTS[0], message: 'Mockups in docs/wishlist.md', turn: 2, maxTurns: 2 });
  assert.match(p, /^Team task for Development: Add a wishlist/);
  assert.match(p, /- development: Development \(you\)/);
  assert.match(p, /The Design department says to you:\nMockups in docs\/wishlist\.md/);
  assert.match(p, /last turn/);
  assert.match(p, /HANDOFF \{"to"/);
  assert.equal(roleSystemPrompt({ name: 'QA', role: '' }), null);
  assert.match(roleSystemPrompt(DEPTS[2], 'shop'), /QA department of the shop project\. Your role: Test things\./);
});

function team(over = {}) {
  const spawnFn = fakeSpawn();
  const tasks = new Tasks(cfg, { spawnFn, find });
  const org = new Org(null);
  org.setDepartments('k', DEPTS, 'shop');
  const teams = new Teams({ tasks, org, place: (k) => (k === 'k' ? { cwd: tmp, project: 'shop', branch: 'main' } : null), cfg, ...over });
  const reply = (i, text, code = 0) => { const c = spawnFn.calls[i].child; c.stdout.emit('data', text); c.emit('close', code, null); };
  return { spawnFn, tasks, org, teams, reply };
}

test('Teams: departments hand the work on, each with its own resumed robot, until done', () => {
  const { spawnFn, org, teams, reply } = team();
  assert.match(teams.start({ projectKey: 'k', goal: '' }).error, /goal/);
  assert.equal(teams.start({ projectKey: 'nope', goal: 'x' }).code, 404);

  const { run } = teams.start({ projectKey: 'k', goal: 'Add a wishlist', mode: 'plan' });
  assert.equal(run.status, 'running');
  assert.equal(run.current.dept, 'design');
  assert.equal(teams.start({ projectKey: 'k', goal: 'again' }).code, 409, 'one team per building');
  // first turn: a new robot, hired onto the Design floor, with the Design role
  let call = spawnFn.calls[0];
  assert.ok(call.args.includes('--session-id'));
  assert.deepEqual(call.args.slice(-2), ['--append-system-prompt', roleSystemPrompt(DEPTS[0], 'shop')]);
  assert.ok(call.args.includes('plan'));
  assert.match(call.child.stdinData, /The user says to you:\nAdd a wishlist/);
  const designer = teams.list()[0].robots.design;
  assert.equal(org.deptOf('k', designer), 'design');

  reply(0, 'Drew it.\nHANDOFF {"to":"qa","say":"Ready to test","message":"Check the mockups"}');
  let r = teams.list()[0];
  assert.equal(r.current.dept, 'qa');
  assert.equal(r.messages.length, 2);
  assert.deepEqual([r.messages[1].from.dept, r.messages[1].to.dept, r.messages[1].say], ['design', 'qa', 'Ready to test']);
  assert.equal(r.messages[1].from.sessionId, designer);

  // QA sends it back to Design: the same Design robot is resumed
  reply(1, 'Found a bug.\nHANDOFF {"to":"design","say":"The empty state is missing","message":"Add an empty state"}');
  call = spawnFn.calls[2];
  assert.deepEqual(call.args.slice(call.args.indexOf('--resume'), call.args.indexOf('--resume') + 2), ['--resume', designer]);
  assert.match(call.child.stdinData, /The QA department says to you:\nAdd an empty state/);

  // no HANDOFF line: falls back to the next floor (Development), with the reply as the message
  reply(2, 'Added the empty state.');
  r = teams.list()[0];
  assert.equal(r.current.dept, 'development');
  assert.equal(r.messages.at(-1).text, 'Added the empty state.');

  reply(3, 'Built.\nHANDOFF {"to":"done","say":"Wishlist shipped","message":"All in src/wishlist"}');
  r = teams.list()[0];
  assert.equal(r.status, 'done');
  assert.equal(r.messages.at(-1).to, null, 'the last message goes to you');
  assert.equal(r.messages.at(-1).say, 'Wishlist shipped');
  assert.equal(teams.runOf(designer).id, r.id);
});

test('Teams: the turn limit ends a run, a failed turn fails it, stop stops it', async () => {
  let t = team();
  t.teams.start({ projectKey: 'k', goal: 'Loop', maxTurns: 2 });
  t.reply(0, 'HANDOFF {"to":"qa","say":"a"}');
  t.reply(1, 'HANDOFF {"to":"design","say":"b"}');
  let r = t.teams.list()[0];
  assert.equal(r.status, 'limit');
  assert.match(r.messages.at(-1).say, /^Out of turns/);

  t = team();
  t.teams.start({ projectKey: 'k', goal: 'Break', start: 'qa', departments: ['qa', 'design'] });
  assert.equal(t.teams.list()[0].current.dept, 'qa');
  t.spawnFn.calls[0].child.stderr.emit('data', 'Error: not logged in\n');
  t.reply(0, '', 1);
  r = t.teams.list()[0];
  assert.equal(r.status, 'failed');
  assert.match(r.error, /QA could not finish its turn: Error: not logged in/);

  t = team();
  const { run } = t.teams.start({ projectKey: 'k', goal: 'Stop me' });
  assert.ok(t.teams.stop(run.id));
  await new Promise((res) => setImmediate(res));
  assert.equal(t.teams.list()[0].status, 'stopped');
  assert.equal(t.teams.stop(run.id), false);
});

test('startTask puts hired robots on their department with its role; orgChange checks the building', async () => {
  const store = new Store({ ...cfg, projectsDir: tmp });
  store.tasks.spawnFn = fakeSpawn();
  store.tasks.find = find;
  const s = store.ensureMain('robot-1', '-tmp-proj');
  s.cwd = tmp;
  s.lastActivity = Date.now() - 60_000;

  assert.equal(orgChange(store, { op: 'departments', projectKey: '-nope', departments: DEPTS }).code, 404);
  assert.ok(orgChange(store, { op: 'departments', projectKey: '-tmp-proj', departments: DEPTS }).departments);
  assert.equal(store.summary(s).dept, 'design', 'unassigned robots work on floor 1');
  assert.ok(orgChange(store, { op: 'assign', projectKey: '-tmp-proj', sessionId: s.id, dept: 'qa' }).ok);
  assert.equal(store.summary(s).dept, 'qa');
  assert.equal(orgChange(store, { op: 'assign', projectKey: '-tmp-proj', sessionId: 'ghost', dept: 'qa' }).code, 404);

  const hire = await startTask(store, { projectKey: '-tmp-proj', dept: 'development', prompt: 'Build it' });
  assert.equal(store.org.deptOf('-tmp-proj', hire.task.sessionId), 'development');
  const args = store.tasks.spawnFn.calls[0].args;
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], roleSystemPrompt(DEPTS[1], store.folderFor('-tmp-proj').project));
  // an existing robot gets its own department's role
  await startTask(store, { sessionId: s.id, prompt: 'Test it' });
  const args2 = store.tasks.spawnFn.calls[1].args;
  assert.match(args2[args2.indexOf('--append-system-prompt') + 1], /QA department/);
});

test('dismiss: idle robots go home until their session does something new; busy ones stay', async () => {
  let now = Date.now();
  const store = new Store({ ...cfg, projectsDir: tmp }, { now: () => now });
  store.tasks.spawnFn = fakeSpawn();
  store.tasks.find = find;
  const idle = store.ensureMain('idle-1', '-tmp-proj');
  idle.cwd = tmp;
  idle.lastActivity = now - 60_000;
  const busy = store.ensureMain('busy-1', '-tmp-proj');
  busy.cwd = tmp;
  busy.lastActivity = now - 60_000;
  await startTask(store, { sessionId: busy.id, prompt: 'Keep going' });

  assert.equal(orgChange(store, { op: 'dismiss', projectKey: '-tmp-proj', sessionIds: [] }).code, 400);
  const r = orgChange(store, { op: 'dismiss', projectKey: '-tmp-proj', sessionIds: [idle.id, busy.id, 'ghost'] });
  assert.deepEqual(r.dismissed, [idle.id]);
  assert.deepEqual(r.skipped.map((k) => k.id), [busy.id, 'ghost']);
  assert.match(r.skipped[0].reason, /task/);

  let sum = store.summary(idle);
  assert.equal(sum.hidden, true);
  assert.equal(sum.dismissed, true);
  assert.equal(store.summary(busy).hidden, false);

  // the session is used again: the robot is back
  now += 5000;
  idle.lastActivity = now;
  sum = store.summary(idle);
  assert.equal(sum.dismissed, false);
  assert.equal(sum.hidden, false);
});
