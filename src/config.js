// Loads config.json (next to package.json), expands "~", applies env overrides.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function loadConfig(overrides = {}) {
  const file = process.env.AGENT_OFFICE_CONFIG || path.join(ROOT, 'config.json');
  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = { ...base, ...overrides };
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.AGENT_OFFICE_PROJECTS_DIR) cfg.projectsDir = process.env.AGENT_OFFICE_PROJECTS_DIR;
  cfg.projectsDir = path.resolve(expandHome(cfg.projectsDir));
  // Departments per building. `"orgFile": null` keeps them in memory only.
  if (process.env.AGENT_OFFICE_ORG_FILE) cfg.orgFile = process.env.AGENT_OFFICE_ORG_FILE;
  cfg.orgFile = cfg.orgFile === null ? null : path.resolve(expandHome(cfg.orgFile || '~/.agent-office/org.json'));
  // Project files you add from the page (Files button), one folder per building.
  cfg.files = { ...cfg.files, dir: path.resolve(expandHome(cfg.files?.dir || '~/.agent-office/files')) };
  return cfg;
}
