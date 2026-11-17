import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tail } from '../src/tail.js';

test('reads incrementally and holds a partial last line until it is complete', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-tail-'));
  const f = path.join(dir, 'x.jsonl');
  fs.writeFileSync(f, '{"a":1}\n{"b":');
  const t = new Tail(f);
  const got = [];
  await t.read((o) => got.push(o));
  assert.deepEqual(got, [{ a: 1 }]);
  fs.appendFileSync(f, '2}\n{"c":"é');          // multi-byte char split across writes
  await t.read((o) => got.push(o));
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }]);
  fs.appendFileSync(f, '"}\n');
  await t.read((o) => got.push(o));
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }, { c: 'é' }]);
  assert.equal(t.offset, fs.statSync(f).size);
});

test('multi-byte UTF-8 split across chunk reads decodes correctly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-tail-'));
  const f = path.join(dir, 'x.jsonl');
  const fd = fs.openSync(f, 'w');
  const buf = Buffer.from('{"t":"日本"}\n');
  fs.writeSync(fd, buf.subarray(0, 8)); // cuts through a 3-byte char
  const t = new Tail(f);
  const got = [];
  await t.read((o) => got.push(o));
  fs.writeSync(fd, buf.subarray(8));
  fs.closeSync(fd);
  await t.read((o) => got.push(o));
  assert.deepEqual(got, [{ t: '日本' }]);
});

test('bad lines are reported, truncation resets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-tail-'));
  const f = path.join(dir, 'x.jsonl');
  fs.writeFileSync(f, 'not json\n{"a":1}\n');
  const t = new Tail(f);
  const got = [], bad = [];
  await t.read((o) => got.push(o), (l) => bad.push(l));
  assert.equal(bad.length, 1);
  fs.writeFileSync(f, '{"z":1}\n');
  const r = await t.read((o) => got.push(o));
  assert.equal(r.truncated, true);
  assert.deepEqual(got.at(-1), { z: 1 });
});

test('missing file is not an error', async () => {
  const t = new Tail(path.join(os.tmpdir(), 'does-not-exist-ao.jsonl'));
  const r = await t.read(() => {});
  assert.equal(r.missing, true);
});
