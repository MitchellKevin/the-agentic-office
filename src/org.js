// Departments: every project is a building, every department one of its floors.
// Stores, per project, the ordered list of departments (name + role) and which robot works on
// which floor. Kept in one small JSON file (config `orgFile`, default ~/.agent-office/org.json);
// with no file configured it lives in memory only. Prompts and conversations are never stored.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const MAX_DEPARTMENTS = 12;
export const MAX_NAME = 40;
export const MAX_ROLE = 2000;
const MAX_ASSIGN = 5000;

/** Ready-made departments for the "Add department" menu. */
export const PRESETS = [
  { id: 'product', name: 'Product', role: 'Turn the goal into clear requirements and acceptance criteria. Decide scope and priorities. Do not write code.' },
  { id: 'design', name: 'Design', role: 'Design the user experience: flows, layout, copy and visual details. Write short specs and change UI markup and styles; leave core logic to Development.' },
  { id: 'development', name: 'Development', role: 'Implement features and fixes in the code. Keep changes focused, follow the existing style, and run the build and tests you touch.' },
  { id: 'qa', name: 'QA', role: 'Review and test the work: run the tests, try edge cases, and report bugs back with exact steps to reproduce. Fix only trivial issues yourself.' },
  { id: 'docs', name: 'Docs', role: 'Write and update documentation, README sections and changelogs for the work that was done.' },
  { id: 'devops', name: 'DevOps', role: 'Handle build, CI, deployment and tooling configuration.' },
  { id: 'security', name: 'Security', role: 'Review the changes for security problems and report concrete risks, each with a fix.' },
  { id: 'research', name: 'Research', role: 'Investigate options: read code, docs and data, and report findings with a recommendation. Do not change code.' },
];

export const DEFAULT_DEPARTMENTS = [{ id: 'general', name: 'General', role: '' }];

export function slug(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'dept';
}

/**
 * Cleans a department list from the page. Keeps known ids (so robots stay on their floor when a
 * department is renamed), makes new ones from the name, and enforces the limits.
 * Returns { departments } or { error }.
 */
export function cleanDepartments(list) {
  if (!Array.isArray(list) || !list.length) return { error: 'A building needs at least one department.' };
  if (list.length > MAX_DEPARTMENTS) return { error: `A building has at most ${MAX_DEPARTMENTS} departments.` };
  const out = [];
  const ids = new Set();
  const names = new Set();
  for (const raw of list) {
    const name = String(raw?.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) return { error: 'Every department needs a name.' };
    if (name.length > MAX_NAME) return { error: `Department names are limited to ${MAX_NAME} characters.` };
    if (names.has(name.toLowerCase())) return { error: `There are two departments called "${name}".` };
    names.add(name.toLowerCase());
    const role = String(raw?.role ?? '').trim();
    if (role.length > MAX_ROLE) return { error: `A role description is limited to ${MAX_ROLE} characters.` };
    let id = typeof raw?.id === 'string' && /^[a-z0-9-]{1,40}$/.test(raw.id) && raw.id !== 'done' ? raw.id : slug(name);
    if (id === 'done') id = 'done-dept';
    const base = id;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    out.push({ id, name, role });
  }
  return { departments: out };
}

export class Org extends EventEmitter {
  /** @param file path of the JSON file, or null to keep everything in memory */
  constructor(file = null, { fsImpl = fs } = {}) {
    super();
    this.file = file;
    this.fs = fsImpl;
    this.data = { version: 1, projects: {} };
    this.saveTimer = null;
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const j = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      if (j && typeof j === 'object' && j.projects && typeof j.projects === 'object') this.data = { version: 1, projects: j.projects };
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`[agent-office] could not read ${this.file}: ${e.message}. Starting with default departments.`);
    }
  }

  /** Writes the file soon (debounced), atomically: a temp file renamed over the old one. */
  save() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 200);
    this.saveTimer.unref?.();
  }

  saveNow() {
    if (!this.file) return;
    try {
      this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      this.fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
      this.fs.renameSync(tmp, this.file);
    } catch (e) {
      console.warn(`[agent-office] could not save ${this.file}: ${e.message}`);
    }
  }

  project(key) { return this.data.projects[key] || null; }

  departmentsOf(key) {
    const p = this.project(key);
    return p?.departments?.length ? p.departments : DEFAULT_DEPARTMENTS;
  }

  department(key, id) { return this.departmentsOf(key).find((d) => d.id === id) || null; }

  /** The department a robot works in: its assignment if that department still exists, else the first floor. */
  deptOf(key, sessionId) {
    const deps = this.departmentsOf(key);
    const a = this.project(key)?.assign?.[sessionId];
    return deps.some((d) => d.id === a) ? a : deps[0].id;
  }

  ensure(key, name) {
    const p = (this.data.projects[key] ||= { name: name || null, departments: null, assign: {} });
    if (name) p.name = name;
    p.assign ||= {};
    return p;
  }

  setDepartments(key, list, name = null) {
    const r = cleanDepartments(list);
    if (r.error) return r;
    const p = this.ensure(key, name);
    p.departments = r.departments;
    const ids = new Set(r.departments.map((d) => d.id));
    for (const [sid, d] of Object.entries(p.assign)) if (!ids.has(d)) delete p.assign[sid];
    this.changed();
    return { departments: r.departments };
  }

  assign(key, sessionId, deptId, name = null) {
    if (!sessionId) return { error: 'Unknown robot.' };
    const deps = this.departmentsOf(key);
    if (!deps.some((d) => d.id === deptId)) return { error: 'Unknown department.' };
    const p = this.ensure(key, name);
    // The default "General" floor exists without being saved: write it down once a robot is placed.
    if (!p.departments?.length) p.departments = deps.map((d) => ({ ...d }));
    if (p.assign[sessionId] === deptId) return { ok: true };
    p.assign[sessionId] = deptId;
    const keys = Object.keys(p.assign);
    if (keys.length > MAX_ASSIGN) for (const k of keys.slice(0, keys.length - MAX_ASSIGN)) delete p.assign[k];
    this.changed();
    return { ok: true };
  }

  changed() { this.save(); this.emit('change'); }

  /** What the page needs: departments per configured project. Assignments travel on each session. */
  toJSON() {
    const projects = {};
    for (const [key, p] of Object.entries(this.data.projects)) {
      if (p.departments?.length) projects[key] = { name: p.name || null, departments: p.departments };
    }
    return { projects, presets: PRESETS, defaults: DEFAULT_DEPARTMENTS };
  }
}
