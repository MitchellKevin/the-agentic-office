import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Library, safeName, folderName, joinPrompts } from '../src/library.js';
import { taskArgs } from '../src/tasks.js';
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
    child.kill = () => {};
    calls.push({ bin, args, opts, child });
    return child;
  };
  fn.calls = calls;
  return fn;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-lib-'));
const newRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao-lib-root-'));

test('safeName strips folders and control characters, and never yields . or ..', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('C:\\Users\\me\\brief.pdf'), 'brief.pdf');
  assert.equal(safeName('.env'), '.env');
  assert.equal(safeName('a\u0000b<c>.txt'), 'a_b_c_.txt');
  assert.equal(safeName('..'), 'file');
  assert.equal(safeName(''), 'file');
});

test('folderName is readable and unique per building key', () => {
  assert.match(folderName('git:/Users/me/shop/.git'), /^shop-[0-9a-f]{8}$/);
  assert.match(folderName('-Users-me-notes'), /^Users-me-notes-[0-9a-f]{8}$/);
  assert.notEqual(folderName('git:/a/shop/.git'), folderName('git:/b/shop/.git'));
});

test('Library: add, replace, list, remove, limits', () => {
  const lib = new Library(newRoot(), { maxBytes: 10, maxFiles: 2 });
  assert.deepEqual(lib.list('k'), []);
  assert.equal(lib.note('k'), null);
  assert.equal(lib.save('k', 'a.md', Buffer.alloc(0)).code, 400);
  assert.equal(lib.save('k', 'a.md', Buffer.alloc(11)).code, 413);

  assert.equal(lib.save('k', '../a.md', Buffer.from('one')).file.name, 'a.md');
  lib.save('k', 'a.md', Buffer.from('two!'));
  assert.deepEqual(lib.list('k').map((f) => [f.name, f.size]), [['a.md', 4]]);
  assert.equal(fs.readFileSync(path.join(lib.dirFor('k'), 'a.md'), 'utf8'), 'two!');

  lib.save('k', 'b.png', Buffer.from('x'));
  assert.equal(lib.save('k', 'c.txt', Buffer.from('x')).code, 400, 'over maxFiles');
  assert.ok(lib.save('k', 'b.png', Buffer.from('y')).file, 'replacing is fine at the limit');

  // Buildings don't see each other's files.
  assert.deepEqual(lib.list('other'), []);

  assert.equal(lib.remove('k', '../k/a.md'), false);
  assert.equal(lib.remove('k', 'a.md'), true);
  assert.equal(lib.remove('k', 'a.md'), false);
  assert.deepEqual(lib.list('k').map((f) => f.name), ['b.png']);
});

test('Library: the note names the folder and the files; forTask adds the folder', () => {
  const lib = new Library(newRoot());
  assert.deepEqual(lib.forTask('k'), { note: null, addDirs: [] });
  lib.save('k', 'brief.md', Buffer.from('# brief'));
  const note = lib.note('k');
  assert.ok(note.includes(lib.dirFor('k')));
  assert.match(note, /- brief\.md/);
  assert.deepEqual(lib.forTask('k'), { note, addDirs: [lib.dirFor('k')] });
  assert.equal(joinPrompts(null, 'a', '', 'b'), 'a\n\nb');
  assert.equal(joinPrompts(null), null);
});

test('taskArgs adds each folder with --add-dir', () => {
  assert.deepEqual(taskArgs({ sessionId: 's', resume: true, mode: 'plan', addDirs: ['/x'] }),
    ['-p', '--permission-mode', 'plan', '--resume', 's', '--add-dir', '/x']);
});

function storeWithRobot(sid = 'robot-lib') {
  const store = new Store({ ...baseCfg, projectsDir: tmp, tasks: { enabled: true }, files: { dir: newRoot() } });
  store.tasks.spawnFn = fakeSpawn();
  store.tasks.find = () => '/fake/claude';
  const s = store.ensureMain(sid, '-tmp-proj');
  s.cwd = tmp;
  s.lastActivity = Date.now() - 5 * 60_000;
  return { store, s };
}

test('startTask: robots are told about the building\'s files and may read the folder', async () => {
  const { store, s } = storeWithRobot();
  await startTask(store, { sessionId: s.id, prompt: 'no files yet' });
  let args = store.tasks.spawnFn.calls[0].args;
  assert.ok(!args.includes('--add-dir'));
  store.tasks.items.clear();

  const key = store.placeOf(s).projectKey;
  store.library.save(key, 'spec.pdf', Buffer.from('%PDF'));
  await startTask(store, { projectKey: key, prompt: 'read the spec' });
  args = store.tasks.spawnFn.calls[1].args;
  const dir = store.library.dirFor(key);
  assert.equal(args[args.indexOf('--add-dir') + 1], dir);
  const sys = args[args.indexOf('--append-system-prompt') + 1];
  assert.ok(sys.includes(dir));
  assert.match(sys, /spec\.pdf/);
});

test('/api/files: token, known buildings only, add, list, remove, size limit', async () => {
  const { store, s } = storeWithRobot('robot-lib-2');
  store.library.maxBytes = 1024;
  const key = store.placeOf(s).projectKey;
  const port = 4393;
  const { server, token } = createServer({ ...baseCfg, port, projectsDir: tmp }, store);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const url = (q) => `http://127.0.0.1:${port}/api/files?${q}`;
  const H = { 'X-AO-Token': token };
  try {
    let r = await fetch(url(`key=${encodeURIComponent(key)}`));
    assert.equal(r.status, 403);
    r = await fetch(url('key=nope'), { headers: H });
    assert.equal(r.status, 404);

    r = await fetch(url(`key=${encodeURIComponent(key)}&name=${encodeURIComponent('brand guide.md')}`), { method: 'POST', headers: H, body: '# brand' });
    assert.equal(r.status, 200);
    let j = await r.json();
    assert.equal(j.file.name, 'brand guide.md');
    assert.deepEqual(j.files.map((f) => f.name), ['brand guide.md']);
    assert.equal(j.dir, store.library.dirFor(key));

    r = await fetch(url(`key=${encodeURIComponent(key)}&name=big.bin`), { method: 'POST', headers: H, body: Buffer.alloc(2048) });
    assert.equal(r.status, 413);

    r = await fetch(url(`key=${encodeURIComponent(key)}`), { headers: H });
    assert.deepEqual((await r.json()).files.map((f) => f.name), ['brand guide.md']);

    r = await fetch(url(`key=${encodeURIComponent(key)}&name=${encodeURIComponent('brand guide.md')}`), { method: 'DELETE', headers: H });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).files, []);
    r = await fetch(url(`key=${encodeURIComponent(key)}&name=gone.md`), { method: 'DELETE', headers: H });
    assert.equal(r.status, 404);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('SessionStart hook: a session you start yourself is told about the project files', async () => {
  const { store } = storeWithRobot('robot-lib-3');
  store.library.save('-tmp-proj', 'brief.md', Buffer.from('# brief'));
  const port = 4394;
  const { server } = createServer({ ...baseCfg, port, projectsDir: tmp }, store);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const hook = (evt) => fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST', body: JSON.stringify(evt) }).then((r) => r.json());
  try {
    const evt = { hook_event_name: 'SessionStart', session_id: 'fresh-1', cwd: tmp, transcript_path: path.join(tmp, '-tmp-proj', 'fresh-1.jsonl') };
    const r = await hook(evt);
    assert.ok(r.context.includes(store.library.dirFor('-tmp-proj')));
    assert.match(r.context, /brief\.md/);

    const none = await hook({ ...evt, session_id: 'fresh-2', transcript_path: path.join(tmp, '-elsewhere', 'fresh-2.jsonl') });
    assert.equal(none.context, undefined);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
