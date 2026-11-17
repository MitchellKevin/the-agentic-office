// "Give a task" dialog: pick a robot (or hire a new one in a department), write the task, pick a mode.
import { $, esc, STATUS_LABEL, store, departmentsOf } from './util.js';

export const MODE_LABEL = { acceptEdits: 'Edit files', plan: 'Plan only', auto: 'Auto' };
const BUSY = new Set(['working', 'needs_you']);
// "Hire a new robot" options carry the building and the department.
const hireValue = (key, dept) => 'n:' + JSON.stringify([key, dept]);
function parseHire(v) {
  try { const [key, dept] = JSON.parse(v.slice(2)); return { key: String(key), dept: dept ? String(dept) : null }; } catch { return { key: v.slice(2), dept: null }; }
}

export class TaskDialog {
  /**
   * @param source   live or demo source (startTask)
   * @param getState () => { sessions: Map, tasks: [], config }
   * @param onStarted (task) => void
   */
  constructor(source, getState, onStarted) {
    this.source = source;
    this.getState = getState;
    this.onStarted = onStarted;
    this.el = $('#taskDlg');
    this.who = $('#tWho');
    this.prompt = $('#tPrompt');
    this.err = $('#tError');
    this.send = $('#tSend');
    this.branchRow = $('#tBranchRow');
    this.branch = $('#tBranch');
    this.newRow = $('#tNewRow');
    this.newName = $('#tNewName');
    this.base = $('#tBase');
    this.branchInfo = null;     // { key, isRepo, current, branches }
    this.wantBranch = null;     // branch to preselect (from the floor menu)
    this.branch.addEventListener('change', () => this.updateBranchHint());
    this.base.addEventListener('change', () => this.updateBranchHint());
    this.newName.addEventListener('input', () => { this.err.hidden = true; this.updateBranchHint(); });
    $('#tClose').addEventListener('click', () => this.close());
    $('#tCancel').addEventListener('click', () => this.close());
    this.who.addEventListener('change', () => this.updateHint());
    this.prompt.addEventListener('input', () => { this.err.hidden = true; store.set('taskDraft', this.prompt.value); });
    this.prompt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.submit(); }
    });
    $('#taskForm').addEventListener('submit', (e) => { e.preventDefault(); this.submit(); });
    // Clicking the backdrop closes it.
    this.el.addEventListener('click', (e) => { if (e.target === this.el) this.close(); });
  }

  get isOpen() { return this.el.open; }

  /** target: { sessionId } | { projectKey, dept?, branch?, newBranch? } | null */
  open(target = null) {
    const { config } = this.getState();
    const t = config.tasks || {};
    this.err.hidden = true;
    this.wantBranch = target?.newBranch ? '__new__' : target?.branch || null;
    this.branchInfo = null;
    this.newName.value = '';
    this.renderWho(target);
    const mode = store.get('taskMode', t.defaultMode || 'acceptEdits');
    for (const r of this.el.querySelectorAll('input[name="mode"]')) r.checked = r.value === mode;
    if (!this.el.querySelector('input[name="mode"]:checked')) this.el.querySelector('input[name="mode"]').checked = true;
    this.prompt.value = store.get('taskDraft', '');
    this.send.disabled = false;
    if (t.enabled === false) this.showError('Tasks are turned off in config.json (tasks.enabled).');
    else if (t.available === false) this.showError('Claude Code CLI not found. Install it, or set tasks.claudePath in config.json, then restart Agent Office.');
    if (!this.el.open) this.el.showModal();
    this.prompt.focus();
  }

  close() { if (this.el.open) this.el.close(); }

  renderWho(target) {
    const { sessions, org } = this.getState();
    const buildings = new Map();
    for (const s of sessions.values()) {
      if (s.hidden && !s.task) continue;
      if (!buildings.has(s.projectKey)) buildings.set(s.projectKey, { key: s.projectKey, name: s.project, cwd: s.cwd, list: [] });
      const b = buildings.get(s.projectKey);
      b.list.push(s);
      if (!b.cwd && s.cwd) b.cwd = s.cwd;
    }
    // The building on show comes first, the rest alphabetically.
    const groups = [...buildings.values()].sort((a, b) => (b.key === target?.projectKey) - (a.key === target?.projectKey) || a.name.localeCompare(b.name));
    if (!groups.length) {
      this.who.innerHTML = '<option value="" disabled selected>No buildings yet: start a Claude Code session first</option>';
      this.updateHint();
      return;
    }
    const deptName = (key, id) => departmentsOf(org, key).find((d) => d.id === id)?.name || '';
    let selected = target?.sessionId ? `s:${target.sessionId}` : target?.projectKey ? hireValue(target.projectKey, target.dept || departmentsOf(org, target.projectKey)[0].id) : null;
    const html = groups.map((b) => {
      const deps = departmentsOf(org, b.key);
      const hires = deps.slice().reverse().map((d) => `<option value="${esc(hireValue(b.key, d.id))}">＋ New robot in ${esc(d.name)}</option>`).join('');
      const robots = b.list.sort((x, y) => (y.lastActivity ?? 0) - (x.lastActivity ?? 0)).map((s) => {
        const busy = BUSY.has(s.status);
        const title = s.title.length > 56 ? s.title.slice(0, 56) + '…' : s.title;
        const dn = deps.length > 1 ? deptName(b.key, s.dept) : '';
        return `<option value="s:${esc(s.id)}"${busy ? ' disabled' : ''}>${esc(title)}${dn ? ` · ${esc(dn)}` : ''} · ${esc(STATUS_LABEL[s.status] || s.status)}${busy ? ' (busy)' : ''}</option>`;
      }).join('');
      return `<optgroup label="${esc(b.name)}">${hires}${robots}</optgroup>`;
    }).join('');
    this.who.innerHTML = html;
    const opt = selected && [...this.who.options].find((o) => o.value === selected);
    if (opt && !opt.disabled) this.who.value = selected;
    else if (opt?.disabled) {
      // Busy robot: preselect hiring a new one in the same department, and say why.
      const s = sessions.get(target.sessionId);
      this.who.value = hireValue(s.projectKey, s.dept || departmentsOf(org, s.projectKey)[0].id);
      this.busyNote = `${s.title} is ${STATUS_LABEL[s.status]?.toLowerCase() || 'busy'}, so this would hire a new robot instead.`;
    } else this.who.selectedIndex = 0;
    this.updateHint();
  }

  updateHint() {
    const { sessions } = this.getState();
    const v = this.who.value || '';
    const hint = $('#tWhoHint');
    let text = '';
    if (v.startsWith('s:')) {
      const s = sessions.get(v.slice(2));
      text = `Continues this robot's conversation in ${s?.cwd || 'its folder'}. If it is still open in a terminal or editor, that window won't show the new messages until you resume it there.`;
    } else if (v.startsWith('n:')) {
      const { key, dept } = parseHire(v);
      const s = [...sessions.values()].filter((x) => x.projectKey === key).sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))[0];
      const d = departmentsOf(this.getState().org, key).find((x) => x.id === dept);
      text = `Starts a new session in ${s?.cwd || 'this building\'s folder'}${d ? `, on the ${d.name} floor` : ''}.${d?.role ? ` It gets the ${d.name} role.` : ''}`;
    }
    if (v.startsWith('s:')) {
      const s = sessions.get(v.slice(2));
      if (s?.branch) text = `On branch ${s.branch}${s.worktree ? ' (its own worktree)' : ''}. ` + text;
    }
    if (this.busyNote) { text = this.busyNote + ' ' + text; this.busyNote = null; }
    hint.textContent = text;
    this.loadBranches();
  }

  /** Branch picker: only when hiring a new robot on a floor that is a git repo. */
  async loadBranches() {
    const v = this.who.value || '';
    if (!v.startsWith('n:') || !this.source.branches) { this.branchRow.hidden = true; return; }
    const { key } = parseHire(v);
    if (this.branchInfo?.key === key) { this.branchRow.hidden = !this.branchInfo.isRepo; return; }
    this.branchRow.hidden = true;
    const info = await this.source.branches(key);
    if ((this.who.value || '') !== v) return; // changed while loading
    this.branchInfo = { key, ...info };
    if (!info.isRepo || !info.branches?.length) { this.branchRow.hidden = true; return; }
    const opt = (b) => {
      const bits = [];
      if (b.robots) bits.push(`${b.robots} robot${b.robots === 1 ? '' : 's'}`);
      if (b.checkedOut === 'main') bits.push('project folder');
      else if (b.checkedOut === 'worktree') bits.push('worktree');
      return `<option value="${esc(b.name)}">${esc(b.name)}${bits.length ? ` · ${esc(bits.join(', '))}` : ''}</option>`;
    };
    // Branches with robots first, then the rest (already sorted by latest commit).
    const withBots = info.branches.filter((b) => b.robots), rest = info.branches.filter((b) => !b.robots);
    this.branch.innerHTML = (withBots.length ? `<optgroup label="With robots">${withBots.map(opt).join('')}</optgroup>` : '')
      + (rest.length ? `<optgroup label="${withBots.length ? 'Other branches' : 'Branches'}">${rest.map(opt).join('')}</optgroup>` : '')
      + '<option value="__new__">＋ New branch…</option>';
    this.base.innerHTML = info.branches.map((b) => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join('');
    this.base.value = info.current || info.branches[0].name;
    const want = this.wantBranch && (this.wantBranch === '__new__' || info.branches.some((b) => b.name === this.wantBranch)) ? this.wantBranch : null;
    this.branch.value = want || info.current || info.branches[0].name;
    this.branchRow.hidden = false;
    this.updateBranchHint();
    if (want === '__new__') this.newName.focus();
  }

  updateBranchHint() {
    const info = this.branchInfo;
    const hint = $('#tBranchHint');
    if (!info?.isRepo) return;
    const root = (this.getState().config.tasks?.worktreeRoot || '~/agent-office-worktrees').replace(/\/$/, '');
    const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'branch';
    const isNew = this.branch.value === '__new__';
    this.newRow.hidden = !isNew;
    if (isNew) {
      const name = this.newName.value.trim();
      hint.textContent = name
        ? `Creates branch ${name} from ${this.base.value} in a new worktree: ${root}/${slug(info.name)}/${slug(name)}`
        : 'Name the new branch. It gets its own worktree folder, so it never touches your project folder.';
      return;
    }
    const b = info.branches.find((x) => x.name === this.branch.value);
    if (!b) { hint.textContent = ''; return; }
    hint.textContent = b.checkedOut === 'main'
      ? 'Works in your project folder: this branch is checked out there.'
      : b.path
        ? `Works in this branch's worktree: ${b.path}`
        : `Creates a worktree for this branch: ${root}/${slug(info.name)}/${slug(b.name)}. Your project folder stays on ${info.current || 'its branch'}.`;
  }

  showError(msg) { this.err.textContent = msg; this.err.hidden = false; }

  async submit() {
    const v = this.who.value || '';
    const prompt = this.prompt.value.trim();
    const mode = this.el.querySelector('input[name="mode"]:checked')?.value || 'acceptEdits';
    if (!v) return this.showError('Pick a robot or a floor.');
    if (!prompt) { this.prompt.focus(); return this.showError('Write a task first.'); }
    const hire = v.startsWith('n:') ? parseHire(v) : null;
    const body = { prompt, mode, ...(hire ? { projectKey: hire.key, dept: hire.dept } : { sessionId: v.slice(2) }) };
    if (v.startsWith('n:') && !this.branchRow.hidden && this.branchInfo?.isRepo) {
      if (this.branch.value === '__new__') {
        const name = this.newName.value.trim();
        if (!name) { this.newName.focus(); return this.showError('Name the new branch.'); }
        body.newBranch = name;
        body.base = this.base.value;
      } else body.branch = this.branch.value;
    }
    this.send.disabled = true;
    const r = await this.source.startTask(body);
    this.send.disabled = false;
    if (r.error) return this.showError(r.error);
    store.set('taskMode', mode);
    store.set('taskDraft', '');
    this.prompt.value = '';
    this.close();
    this.onStarted?.(r.task);
  }
}

/** The strip at the top of the side panel that shows this robot's latest task. */
export function taskStrip(task, now = Date.now()) {
  if (!task) return '';
  const secs = Math.max(0, Math.round(((task.endedAt || now) - task.startedAt) / 1000));
  const dur = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const state = {
    running: `Task running · ${dur}`,
    done: `Task done · ${dur}`,
    failed: 'Task failed',
    stopped: 'Task stopped',
  }[task.status] || task.status;
  return `<div class="task-strip ts-${esc(task.status)}">
    <div class="ts-row"><span class="ts-state">${esc(state)}</span><span class="ts-mode">${esc(MODE_LABEL[task.mode] || task.mode)}</span>${task.branch ? `<span class="ts-mode" title="${esc(task.worktree || task.cwd || '')}">⎇ ${esc(task.branch)}</span>` : ''}
      ${task.status === 'running' ? `<button class="ts-stop" data-stop-task="${esc(task.id)}">Stop</button>` : ''}</div>
    <div class="ts-prompt sensitive">${esc(task.prompt)}</div>
    ${task.status === 'failed' && task.error ? `<pre class="ts-error">${esc(task.error)}</pre>` : ''}
  </div>`;
}
