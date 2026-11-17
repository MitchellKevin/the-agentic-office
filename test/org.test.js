import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Org, cleanDepartments, slug, DEFAULT_DEPARTMENTS } from '../src/org.js';

test('a building without departments has one General floor', () => {
  const org = new Org(null);
  assert.deepEqual(org.departmentsOf('k'), DEFAULT_DEPARTMENTS);
  assert.equal(org.deptOf('k', 'any-session'), 'general');
});

test('cleanDepartments keeps ids, makes new ones from names and refuses bad lists', () => {
  const r = cleanDepartments([{ id: 'dev', name: 'Development' }, { name: 'Q&A Team' }, { name: 'Design', role: ' draws ' }]);
  assert.deepEqual(r.departments.map((d) => d.id), ['dev', 'q-a-team', 'design']);
  assert.equal(r.departments[2].role, 'draws');
  assert.ok(cleanDepartments([]).error);
  assert.ok(cleanDepartments([{ name: '' }]).error);
  assert.ok(cleanDepartments([{ name: 'QA' }, { name: 'qa' }]).error, 'duplicate names');
  assert.ok(cleanDepartments(Array.from({ length: 13 }, (_, i) => ({ name: `D${i}` }))).error);
  // ids stay unique, and "done" is reserved for team hand-offs
  assert.deepEqual(cleanDepartments([{ name: 'Ops' }, { id: 'ops', name: 'Ops two' }]).departments.map((d) => d.id), ['ops', 'ops-2']);
  assert.notEqual(cleanDepartments([{ name: 'Done' }]).departments[0].id, 'done');
  assert.equal(slug('Ünïcode Désign'), 'unicode-design');
});

test('assignments follow renames and fall back to floor 1 when a department goes', () => {
  const org = new Org(null);
  org.setDepartments('k', [{ name: 'Development' }, { name: 'QA' }], 'shop');
  assert.ok(org.assign('k', 's1', 'qa').ok);
  assert.equal(org.deptOf('k', 's1'), 'qa');
  assert.ok(org.assign('k', 's1', 'nope').error);
  // rename keeps the id, so the robot stays
  org.setDepartments('k', [{ id: 'development', name: 'Dev' }, { id: 'qa', name: 'Testing' }]);
  assert.equal(org.deptOf('k', 's1'), 'qa');
  // removing QA moves its robots to the bottom floor
  org.setDepartments('k', [{ id: 'development', name: 'Dev' }]);
  assert.equal(org.deptOf('k', 's1'), 'development');
  assert.equal(org.toJSON().projects.k.name, 'shop');
});

test('placing a robot on the default floor writes the default down', () => {
  const org = new Org(null);
  assert.ok(org.assign('k', 's1', 'general').ok);
  assert.deepEqual(org.toJSON().projects.k.departments.map((d) => d.id), ['general']);
});

test('the org file is written atomically and read back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-org-'));
  const file = path.join(dir, 'nested', 'org.json');
  const a = new Org(file);
  a.setDepartments('k', [{ name: 'Design', role: 'draws' }, { name: 'QA' }], 'shop');
  a.assign('k', 's1', 'qa');
  a.saveNow();
  clearTimeout(a.saveTimer); a.saveTimer = null;
  const b = new Org(file);
  assert.deepEqual(b.departmentsOf('k').map((d) => d.name), ['Design', 'QA']);
  assert.equal(b.deptOf('k', 's1'), 'qa');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['org.json'], 'no temp file left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unreadable org file falls back to defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-org-'));
  const file = path.join(dir, 'org.json');
  fs.writeFileSync(file, '{ not json');
  const warn = console.warn; console.warn = () => {};
  try { assert.deepEqual(new Org(file).departmentsOf('k'), DEFAULT_DEPARTMENTS); } finally { console.warn = warn; }
  fs.rmSync(dir, { recursive: true, force: true });
});
