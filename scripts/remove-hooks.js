#!/usr/bin/env node
// Removes only the Agent Office hook entries from ~/.claude/settings.json (or --settings <path>).
import { settingsPath, readSettings, backup, removeHooks, writeSettings } from './hooks-lib.js';

const file = settingsPath();
let settings;
try { settings = readSettings(file); } catch (e) {
  console.error(`Could not parse ${file}: ${e.message}\nNothing was changed.`);
  process.exit(1);
}
const { settings: next, removed } = removeHooks(settings);
if (!removed.length) {
  console.log(`No Agent Office hooks found in ${file}. Nothing to do.`);
  process.exit(0);
}
const bak = backup(file);
writeSettings(file, next);
console.log(`Removed Agent Office hooks for: ${removed.join(', ')}`);
if (bak) console.log(`Backup: ${bak}`);
