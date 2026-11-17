#!/usr/bin/env node
// Adds Agent Office hooks to ~/.claude/settings.json (or --settings <path>). Keeps existing hooks.
import { settingsPath, readSettings, backup, addHooks, writeSettings, HOOK_PATH } from './hooks-lib.js';

const file = settingsPath();
let settings;
try { settings = readSettings(file); } catch (e) {
  console.error(`Could not parse ${file}: ${e.message}\nNothing was changed.`);
  process.exit(1);
}
const { settings: next, added } = addHooks(settings);
if (!added.length) {
  console.log(`Agent Office hooks are already installed in ${file}. Nothing to do.`);
  process.exit(0);
}
const bak = backup(file);
writeSettings(file, next);
console.log(`Added Agent Office hooks for: ${added.join(', ')}`);
console.log(`Settings: ${file}`);
if (bak) console.log(`Backup:   ${bak}`);
console.log(`Hook:     ${HOOK_PATH}`);
console.log('New Claude Code sessions pick this up automatically; running sessions may need a restart.');
console.log('Undo any time with: npm run remove-hooks');
