// Every browser and server file must at least parse. The browser modules can't be imported in
// Node (they touch the DOM), so this runs `node --check` on each one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const dir of ['public', 'src', 'hooks', 'scripts']) {
  for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith('.js'))) {
    test(`parses: ${dir}/${f}`, () => {
      const r = spawnSync(process.execPath, ['--check', path.join(ROOT, dir, f)], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    });
  }
}
