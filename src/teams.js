// Team runs: the departments of one building work on a goal together, on their own.
// One department works at a time. When its turn ends it hands the work to another department
// (or to you, when the goal is met) with a HANDOFF line at the end of its reply:
//   HANDOFF {"to": "qa", "say": "Login page is ready for testing", "message": "…details…"}
// "say" is the short line shown in the speech bubble, "message" is what the next department
// reads. Every department gets its own robot for the run, resumed on each of its turns, so it
// remembers what it did before. A run stops at its turn limit so it can never loop forever.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export const MAX_GOAL = 8000;
export const MAX_SAY = 90;
export const MAX_MESSAGE = 4000;
const KEEP_RUNS = 20;
const DONE_WORDS = new Set(['done', 'user', 'you', 'finish', 'finished', 'complete', 'end']);

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};
const clipBlock = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};
const firstSentence = (s) => clip(String(s || '').split(/(?<=[.!?])\s|\n/)[0], MAX_SAY);

/**
 * Finds the last HANDOFF {...} in a reply. Tolerates code fences and text after the JSON.
 * Returns { to, say, message, before } or null.
 */
export function parseHandoff(text) {
  const s = String(text || '');
  const at = s.lastIndexOf('HANDOFF');
  if (at < 0) return null;
  const rest = s.slice(at + 7);
  const open = rest.indexOf('{');
  if (open < 0) return null;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let k = open; k < rest.length; k++) {
    const c = rest[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { end = k; break; }
  }
  if (end < 0) return null;
  let o;
  try { o = JSON.parse(rest.slice(open, end + 1)); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const message = clipBlock(o.message ?? o.text ?? '', MAX_MESSAGE);
  return {
    to: String(o.to ?? '').trim(),
    say: clip(o.say ?? '', MAX_SAY) || firstSentence(message),
    message,
    before: s.slice(0, at).replace(/`+\s*$/, '').trim(),
  };
}

/** Where a handoff goes: a department id of this run, or 'done'. Falls back to the next floor in order. */
export function resolveTarget(departments, to, current) {
  const t = String(to || '').trim().toLowerCase();
  if (DONE_WORDS.has(t)) return 'done';
  const hit = departments.find((d) => d.id === t || d.name.toLowerCase() === t);
  if (hit && hit.id !== current) return hit.id;
  const i = departments.findIndex((d) => d.id === current);
  return i >= 0 && i + 1 < departments.length ? departments[i + 1].id : 'done';
}

/** The system prompt that gives a robot its department's role. */
export function roleSystemPrompt(dept, projectName = null) {
  if (!dept?.role) return null;
  return `You work in the ${dept.name} department${projectName ? ` of the ${projectName} project` : ''}. Your role: ${dept.role}`;
}

/** The prompt for one turn of a team run. */
export function turnPrompt({ goal, project, departments, dept, from, message, turn, maxTurns }) {
  const roster = departments.map((d) => `- ${d.id}: ${d.name}${d.id === dept.id ? ' (you)' : ''}${d.role ? ` — ${d.role}` : ''}`).join('\n');
  const fromLabel = from ? `The ${from.name} department` : 'The user';
  const last = turn >= maxTurns;
  return [
    `Team task for ${dept.name}: ${clip(goal, 100)}`,
    '',
    `You are the ${dept.name} department in an autonomous team of AI agents working together on the ${project} project. Nobody is watching this turn, so work on your own and do not ask questions: make reasonable choices and mention them in your message.`,
    '',
    'Team goal (from the user):',
    goal,
    '',
    'Departments:',
    roster,
    '',
    `${fromLabel} says to you:`,
    message || '(no message)',
    '',
    `This is turn ${turn} of at most ${maxTurns}.${last ? ' It is the last turn: finish up and hand off to "done".' : ''}`,
    `Do your department's part of the work now. Don't do other departments' jobs; hand off to them instead.`,
    'When you are finished, end your reply with exactly one line in this format (valid JSON, on one line):',
    'HANDOFF {"to": "<a department id from the list, or \\"done\\" when the whole goal is met>", "say": "<one short sentence, at most 12 words, that you say to them>", "message": "<what they need to know: what you did, where, and what they should do next>"}',
  ].join('\n');
}

export class Teams extends EventEmitter {
  /**
   * @param tasks  the Tasks runner
   * @param org    the Org (departments and assignments)
   * @param place  (projectKey) => { cwd, project, branch } | null — the folder a run works in
   */
  constructor({ tasks, org, place, cfg = {}, now = () => Date.now() }) {
    super();
    this.tasks = tasks;
    this.org = org;
    this.place = place;
    this.cfg = cfg;
    this.now = now;
    this.runs = new Map();
    this.tasks.on('finished', (task, output) => this.onFinished(task, output));
  }

  get defaultTurns() { return this.cfg.teams?.defaultTurns ?? 8; }
  get turnLimit() { return this.cfg.teams?.maxTurns ?? 30; }

  list() {
    return [...this.runs.values()].map((r) => this.view(r)).sort((a, b) => a.startedAt - b.startedAt);
  }

  view(r) {
    const { cwd, ...pub } = r;
    return { ...pub, departments: r.departments.map(({ id, name }) => ({ id, name })), robots: { ...r.robots }, messages: r.messages.map((m) => ({ ...m })) };
  }

  /** The run a robot belongs to (latest first), or null. */
  runOf(sessionId) {
    let hit = null;
    for (const r of this.runs.values()) if (Object.values(r.robots).includes(sessionId)) hit = r;
    return hit;
  }

  start({ projectKey, goal, mode, departments, start, maxTurns }) {
    if (!this.tasks.enabled) return { error: 'Tasks are turned off in config.json (tasks.enabled).', code: 403 };
    goal = typeof goal === 'string' ? goal.trim() : '';
    if (!goal) return { error: 'Write the team goal first.', code: 400 };
    if (goal.length > MAX_GOAL) return { error: `A team goal is limited to ${MAX_GOAL.toLocaleString()} characters.`, code: 400 };
    if (!projectKey) return { error: 'Pick a building first.', code: 400 };
    for (const r of this.runs.values()) {
      if (r.projectKey === projectKey && r.status === 'running') return { error: 'A team is already working in this building. Stop it first, or wait until it is done.', code: 409 };
    }
    const all = this.org.departmentsOf(projectKey);
    const ids = Array.isArray(departments) && departments.length ? new Set(departments.map(String)) : new Set(all.map((d) => d.id));
    const team = all.filter((d) => ids.has(d.id));
    if (!team.length) return { error: 'Pick at least one department for the team.', code: 400 };
    const first = team.find((d) => d.id === start) || team[0];
    const where = this.place(projectKey);
    if (!where?.cwd) return { error: 'No known folder for this building yet. Start one Claude Code session in it first.', code: 404 };
    const turns = Math.max(1, Math.min(this.turnLimit, Math.round(Number(maxTurns) || this.defaultTurns)));

    const run = {
      id: crypto.randomUUID(), projectKey, project: where.project, cwd: where.cwd, branch: where.branch || null,
      goal: goal.length > 600 ? goal.slice(0, 600) + '…' : goal, fullGoal: goal, mode: mode || this.cfg.tasks?.defaultMode || 'acceptEdits',
      departments: team, status: 'running', startedAt: this.now(), endedAt: null,
      turn: 0, maxTurns: turns, current: null, robots: {}, messages: [], error: null,
    };
    this.runs.set(run.id, run);
    const r = this.turn(run, first, null, goal, clip(goal, MAX_SAY));
    if (r.error) {
      this.runs.delete(run.id);
      return r;
    }
    this.trim();
    this.emit('change');
    return { run: this.view(run) };
  }

  stop(id) {
    const r = this.runs.get(id);
    if (!r || r.status !== 'running') return false;
    r.stopping = true;
    if (r.current?.taskId && this.tasks.stop(r.current.taskId)) return true;
    this.end(r, 'stopped');
    return true;
  }

  /** Starts one department's turn and records the message that started it. */
  turn(run, dept, from, message, say) {
    run.turn++;
    const sessionId = run.robots[dept.id] || null;
    const r = this.tasks.start({
      sessionId, resume: !!sessionId, cwd: run.cwd, project: run.project, mode: run.mode, branch: run.branch,
      prompt: turnPrompt({ goal: run.fullGoal, project: run.project, departments: run.departments, dept, from, message, turn: run.turn, maxTurns: run.maxTurns }),
      systemPrompt: roleSystemPrompt(dept, run.project),
      dept: dept.id, team: run.id, outputLimit: 64_000, maxPrompt: MAX_GOAL + MAX_MESSAGE + 8000,
    });
    if (r.error) return r;
    if (!sessionId) {
      run.robots[dept.id] = r.task.sessionId;
      this.org.assign(run.projectKey, r.task.sessionId, dept.id, run.project);
    }
    run.current = { dept: dept.id, sessionId: r.task.sessionId, taskId: r.task.id, startedAt: this.now() };
    run.messages.push({
      id: crypto.randomUUID(), ts: this.now(), turn: run.turn,
      from: from ? { dept: from.id, name: from.name, sessionId: run.robots[from.id] || null } : null,
      to: { dept: dept.id, name: dept.name, sessionId: r.task.sessionId },
      say, text: clipBlock(message, MAX_MESSAGE),
    });
    return r;
  }

  onFinished(task, output) {
    const run = [...this.runs.values()].find((r) => r.current?.taskId === task.id);
    if (!run || run.status !== 'running') return;
    const dept = run.departments.find((d) => d.id === run.current.dept);
    run.current = null;
    if (task.status === 'stopped' || run.stopping) return this.end(run, 'stopped');
    if (task.status !== 'done') return this.end(run, 'failed', `${dept?.name || 'A department'} could not finish its turn: ${(task.error || 'the task failed').split('\n').filter(Boolean).at(-1) || 'the task failed'}`);

    const h = parseHandoff(output);
    const text = h?.message || clipBlock(h?.before ?? output, MAX_MESSAGE) || '(no reply)';
    const say = h?.say || firstSentence(text) || 'Done with my part.';
    const target = resolveTarget(run.departments, h?.to, dept.id);
    const outOfTurns = target !== 'done' && run.turn >= run.maxTurns;
    if (target === 'done' || outOfTurns) {
      run.messages.push({
        id: crypto.randomUUID(), ts: this.now(), turn: run.turn,
        from: { dept: dept.id, name: dept.name, sessionId: task.sessionId }, to: null,
        say: outOfTurns ? clip(`Out of turns. ${say}`, MAX_SAY) : say, text,
      });
      return this.end(run, outOfTurns ? 'limit' : 'done');
    }
    const next = run.departments.find((d) => d.id === target);
    const r = this.turn(run, next, dept, text, say);
    if (r.error) return this.end(run, 'failed', `Could not hand off to ${next.name}: ${r.error}`);
    this.emit('change');
  }

  end(run, status, error = null) {
    run.status = status;
    run.error = error;
    run.endedAt = this.now();
    run.current = null;
    this.emit('change');
  }

  trim() {
    const done = [...this.runs.values()].filter((r) => r.status !== 'running').sort((a, b) => a.startedAt - b.startedAt);
    while (this.runs.size > KEEP_RUNS && done.length) this.runs.delete(done.shift().id);
  }
}
