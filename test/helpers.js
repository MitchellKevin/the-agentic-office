import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, applyLine } from '../src/parser.js';

export const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const cfg = JSON.parse(fs.readFileSync(path.join(FIX, '..', '..', 'config.json'), 'utf8'));

export function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function parseFile(file, opts = {}) {
  const s = createSession({ id: opts.id || 's1', ...opts });
  for (const o of readLines(file)) applyLine(s, o, cfg);
  return s;
}

export const MAIN = path.join(FIX, 'projects', '-work-demo-app', 's1.jsonl');
export const SUB = path.join(FIX, 'projects', '-work-demo-app', 's1', 'subagents', 'agent-abc123.jsonl');
