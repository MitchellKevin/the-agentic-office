// Shared helpers for setup-hooks / remove-hooks. Only touches entries that point at our hook.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOK_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'hook.js');
export const COMMAND = `node "${HOOK_PATH}"`;

// event -> { matcher?, timeout (seconds) }
export const EVENTS = {
  SessionStart: { timeout: 5 },
  UserPromptSubmit: { timeout: 5 },
  PreToolUse: { matcher: '*', timeout: 5 },
  PostToolUse: { matcher: '*', timeout: 5 },
  PostToolUseFailure: { matcher: '*', timeout: 5 },
  Notification: { timeout: 5 },
  Stop: { timeout: 5 },
  SubagentStop: { timeout: 5 },
  SessionEnd: { timeout: 5 },
  PermissionRequest: { matcher: '*', timeout: 60 },
};

export function settingsPath(argv = process.argv) {
  const i = argv.indexOf('--settings');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return path.join(os.homedir(), '.claude', 'settings.json');
}

const isOurs = (h) => typeof h?.command === 'string' && h.command.includes(HOOK_PATH);

export function addHooks(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  s.hooks = s.hooks && typeof s.hooks === 'object' ? s.hooks : {};
  const added = [];
  for (const [event, opt] of Object.entries(EVENTS)) {
    const groups = Array.isArray(s.hooks[event]) ? s.hooks[event] : [];
    if (groups.some((g) => (g.hooks || []).some(isOurs))) continue;
    const group = { hooks: [{ type: 'command', command: COMMAND, timeout: opt.timeout }] };
    if (opt.matcher) group.matcher = opt.matcher;
    groups.push(group);
    s.hooks[event] = groups;
    added.push(event);
  }
  return { settings: s, added };
}

export function removeHooks(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const removed = [];
  if (!s.hooks || typeof s.hooks !== 'object') return { settings: s, removed };
  for (const event of Object.keys(s.hooks)) {
    const groups = Array.isArray(s.hooks[event]) ? s.hooks[event] : null;
    if (!groups) continue;
    const next = [];
    for (const g of groups) {
      const before = (g.hooks || []).length;
      const hooks = (g.hooks || []).filter((h) => !isOurs(h));
      if (hooks.length !== before) removed.push(event);
      if (hooks.length) next.push({ ...g, hooks });
    }
    if (next.length) s.hooks[event] = next; else delete s.hooks[event];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  return { settings: s, removed: [...new Set(removed)] };
}

export function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  return JSON.parse(text); // throws on invalid JSON: we never overwrite a file we can't parse
}

export function backup(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.agent-office-${stamp}.bak`;
  fs.copyFileSync(file, dest);
  return dest;
}

export function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.agent-office-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
