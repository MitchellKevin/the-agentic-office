// Departments and team runs in the page: the department editor, the "Start a team" dialog and
// the team feed (who said what to whom).
import { $, esc, relTime, store, departmentsOf } from './util.js';
import { MODE_LABEL } from './tasks.js';

// ---------------------------------------------------------------- department editor
export class DeptDialog {
  /**
   * @param source   live or demo source (setDepartments)
   * @param getState () => { org, project, projectName }
   */
  constructor(source, getState) {
    this.source = source;
    this.getState = getState;
    this.el = $('#deptDlg');
    this.list = $('#dpList');
    this.err = $('#dpError');
    this.rows = [];
    $('#dpClose').addEventListener('click', () => this.close());
    $('#dpCancel').addEventListener('click', () => this.close());
    $('#deptForm').addEventListener('submit', (e) => { e.preventDefault(); this.save(); });
    this.el.addEventListener('click', (e) => { if (e.target === this.el) this.close(); });
    this.list.addEventListener('input', (e) => {
      const row = e.target.closest('[data-i]');
      if (!row) return;
      const r = this.rows[Number(row.dataset.i)];
      if (e.target.matches('.dp-name')) r.name = e.target.value;
      if (e.target.matches('.dp-role')) r.role = e.target.value;
      this.err.hidden = true;
    });
    this.list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const i = Number(b.closest('[data-i]').dataset.i);
      const act = b.dataset.act;
      if (act === 'up' && i < this.rows.length - 1) [this.rows[i], this.rows[i + 1]] = [this.rows[i + 1], this.rows[i]];
      if (act === 'down' && i > 0) [this.rows[i], this.rows[i - 1]] = [this.rows[i - 1], this.rows[i]];
      if (act === 'del') {
        if (this.rows.length === 1) return this.showError('A building needs at least one department.');
        this.rows.splice(i, 1);
      }
      this.render();
    });
    $('#dpPresets').addEventListener('click', (e) => {
      const b = e.target.closest('[data-preset]');
      if (!b) return;
      const presets = this.getState().org?.presets || [];
      const p = presets.find((x) => x.id === b.dataset.preset);
      this.rows.push(p ? { name: p.name, role: p.role } : { name: '', role: '' });
      this.render();
      const inputs = this.list.querySelectorAll('.dp-name');
      // new rows sit on the top floor, which is rendered first
      if (!p) inputs[0]?.focus();
    });
  }

  get isOpen() { return this.el.open; }

  open(projectKey, { add = false } = {}) {
    const st = this.getState();
    if (!projectKey) return;
    this.key = projectKey;
    this.rows = departmentsOf(st.org, projectKey).map((d) => ({ id: d.id, name: d.name, role: d.role || '' }));
    this.err.hidden = true;
    $('#dpWhere').innerHTML = `Floors of <b class="sensitive">${esc(st.projectName || 'this building')}</b>, top floor first. Robots of a department you remove move to the bottom floor.`;
    this.render();
    if (!this.el.open) this.el.showModal();
    if (add) $('#dpPresets button')?.focus();
  }

  close() { if (this.el.open) this.el.close(); }

  render() {
    const n = this.rows.length;
    // top floor first, like the building
    this.list.innerHTML = this.rows.map((r, i) => ({ r, i })).reverse().map(({ r, i }) => `
      <div class="dp-row" data-i="${i}" role="listitem">
        <span class="fnum" title="Floor ${i + 1}">${i + 1}</span>
        <input class="dp-name" type="text" maxlength="40" value="${esc(r.name)}" placeholder="Department name" aria-label="Name of floor ${i + 1}">
        <span class="dp-move">
          <button type="button" class="icon-btn" data-act="up" title="Move up a floor" aria-label="Move up a floor"${i === n - 1 ? ' disabled' : ''}>↑</button>
          <button type="button" class="icon-btn" data-act="down" title="Move down a floor" aria-label="Move down a floor"${i === 0 ? ' disabled' : ''}>↓</button>
          <button type="button" class="icon-btn" data-act="del" title="Remove this department" aria-label="Remove">✕</button>
        </span>
        <textarea class="dp-role" rows="2" maxlength="2000" placeholder="Role: what this department does. Its robots get this with every task." aria-label="Role of ${esc(r.name || 'this department')}">${esc(r.role)}</textarea>
      </div>`).join('');
    const have = new Set(this.rows.map((r) => r.name.trim().toLowerCase()));
    const presets = (this.getState().org?.presets || []).filter((p) => !have.has(p.name.toLowerCase()));
    $('#dpPresets').innerHTML = presets.map((p) => `<button type="button" class="chip-btn" data-preset="${esc(p.id)}" title="${esc(p.role)}">＋ ${esc(p.name)}</button>`).join('')
      + '<button type="button" class="chip-btn" data-preset="">＋ Custom…</button>';
  }

  showError(msg) { this.err.textContent = msg; this.err.hidden = false; }

  async save() {
    const list = this.rows.map((r) => ({ ...(r.id ? { id: r.id } : {}), name: r.name.trim(), role: r.role.trim() }));
    if (list.some((r) => !r.name)) return this.showError('Every department needs a name.');
    $('#dpSave').disabled = true;
    const r = await this.source.setDepartments(this.key, list);
    $('#dpSave').disabled = false;
    if (r.error) return this.showError(r.error);
    this.close();
  }
}

// ---------------------------------------------------------------- start a team
export class TeamDialog {
  constructor(source, getState, onStarted) {
    this.source = source;
    this.getState = getState;
    this.onStarted = onStarted;
    this.el = $('#teamDlg');
    this.goal = $('#tmGoal');
    this.err = $('#tmError');
    $('#tmClose').addEventListener('click', () => this.close());
    $('#tmCancel').addEventListener('click', () => this.close());
    $('#teamForm').addEventListener('submit', (e) => { e.preventDefault(); this.submit(); });
    this.el.addEventListener('click', (e) => { if (e.target === this.el) this.close(); });
    this.goal.addEventListener('input', () => { this.err.hidden = true; store.set('teamDraft', this.goal.value); });
    this.goal.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.submit(); } });
    $('#tmDepts').addEventListener('change', (e) => {
      // the department that starts is always in the team
      if (e.target.name === 'tmStart') { const cb = e.target.closest('.tm-dept').querySelector('input[type=checkbox]'); cb.checked = true; }
      if (e.target.type === 'checkbox' && !e.target.checked && e.target.closest('.tm-dept').querySelector('input[type=radio]').checked) {
        const next = [...$('#tmDepts').querySelectorAll('.tm-dept')].find((r) => r.querySelector('input[type=checkbox]').checked);
        if (next) next.querySelector('input[type=radio]').checked = true;
      }
    });
  }

  get isOpen() { return this.el.open; }

  open(projectKey) {
    const st = this.getState();
    if (!projectKey) return;
    this.key = projectKey;
    const cfg = st.config || {};
    this.err.hidden = true;
    const deps = departmentsOf(st.org, projectKey);
    $('#tmWhere').innerHTML = `In <b class="sensitive">${esc(st.projectName || 'this building')}</b>. Every turn is a real Claude Code task in the project folder, so it uses tokens like one.`;
    // top floor first, like the building; the bottom floor starts by default
    $('#tmDepts').innerHTML = deps.map((d, i) => ({ d, i })).reverse().map(({ d, i }) => `
      <div class="tm-dept">
        <label class="tm-pick">
          <input type="checkbox" value="${esc(d.id)}" checked>
          <span class="fnum">${i + 1}</span>
          <span class="tm-name"><b>${esc(d.name)}</b>${d.role ? `<small>${esc(d.role)}</small>` : '<small class="muted">No role yet: add one with ✎ under the floor list.</small>'}</span>
        </label>
        <label class="tm-start"><input type="radio" name="tmStart" value="${esc(d.id)}"${i === 0 ? ' checked' : ''}> starts</label>
      </div>`).join('');
    const mode = store.get('teamMode', cfg.tasks?.defaultMode || 'acceptEdits');
    for (const r of this.el.querySelectorAll('input[name="tmMode"]')) r.checked = r.value === mode;
    const turns = $('#tmTurns');
    turns.max = String(cfg.teams?.maxTurns ?? 30);
    turns.value = String(store.get('teamTurns', cfg.teams?.defaultTurns ?? 8));
    this.goal.value = store.get('teamDraft', '');
    $('#tmSend').disabled = false;
    if (cfg.tasks?.enabled === false) this.showError('Tasks are turned off in config.json (tasks.enabled), so teams are too.');
    else if (cfg.tasks?.available === false) this.showError('Claude Code CLI not found. Install it, or set tasks.claudePath in config.json, then restart Agent Office.');
    if (!this.el.open) this.el.showModal();
    this.goal.focus();
  }

  close() { if (this.el.open) this.el.close(); }

  showError(msg) { this.err.textContent = msg; this.err.hidden = false; }

  async submit() {
    const goal = this.goal.value.trim();
    if (!goal) { this.goal.focus(); return this.showError('Write the team goal first.'); }
    const departments = [...$('#tmDepts').querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
    if (!departments.length) return this.showError('Pick at least one department.');
    const start = $('#tmDepts').querySelector('input[name="tmStart"]:checked')?.value || departments.at(-1);
    const mode = this.el.querySelector('input[name="tmMode"]:checked')?.value || 'acceptEdits';
    const maxTurns = Number($('#tmTurns').value) || 8;
    // keep floor order (bottom first) for the server
    const order = departmentsOf(this.getState().org, this.key).map((d) => d.id).filter((id) => departments.includes(id));
    $('#tmSend').disabled = true;
    const r = await this.source.startTeam({ projectKey: this.key, goal, mode, departments: order, start, maxTurns });
    $('#tmSend').disabled = false;
    if (r.error) return this.showError(r.error);
    store.set('teamMode', mode);
    store.set('teamTurns', maxTurns);
    store.set('teamDraft', '');
    this.goal.value = '';
    this.close();
    this.onStarted?.(r.run);
  }
}

// ---------------------------------------------------------------- team feed
const RUN_STATE = { running: 'Working', done: 'Done', failed: 'Failed', stopped: 'Stopped', limit: 'Out of turns' };

export class TeamDrawer {
  constructor(source, { onOpenSession, onStart, onShowFloor } = {}) {
    this.source = source;
    this.el = $('#teamDrawer');
    this.body = $('#tdBody');
    this.runs = [];
    this.key = null;
    this.open = new Set();
    this.onOpenSession = onOpenSession || (() => {});
    $('#tdClose').addEventListener('click', () => this.toggle(false));
    $('#tdStart').addEventListener('click', () => onStart?.());
    this.body.addEventListener('click', async (e) => {
      const stop = e.target.closest('[data-stop-run]');
      if (stop) { stop.disabled = true; stop.textContent = 'Stopping…'; await this.source.stopTeam(stop.dataset.stopRun); return; }
      const fl = e.target.closest('[data-floor]');
      if (fl) { onShowFloor?.(fl.dataset.floor); return; }
      const who = e.target.closest('[data-open]');
      if (who) { this.onOpenSession(who.dataset.open); return; }
      const more = e.target.closest('[data-more]');
      if (more) { const id = more.dataset.more; this.open.has(id) ? this.open.delete(id) : this.open.add(id); this.render(); }
    });
    setInterval(() => { if (!this.el.hidden && this.runs.some((r) => r.status === 'running')) this.render(); }, 5000);
  }

  set(runs, projectKey, projectName) {
    this.runs = runs;
    this.key = projectKey;
    $('#tdProject').textContent = projectName ? `· ${projectName}` : '';
    if (!this.el.hidden) this.render();
  }

  toggle(on = this.el.hidden) {
    this.el.hidden = !on;
    $('#teamBtn').setAttribute('aria-expanded', String(on));
    if (on) this.render();
  }

  render() {
    const runs = this.runs.filter((r) => r.projectKey === this.key).slice().reverse();
    const running = runs.some((r) => r.status === 'running');
    $('#tdStart').disabled = running;
    $('#tdStart').textContent = running ? 'A team is working…' : 'Start a team…';
    if (!runs.length) {
      this.body.innerHTML = '<div class="empty-tab">No team runs in this building yet.<br><br>Give the departments a goal and watch them pass the work along.</div>';
      return;
    }
    this.body.innerHTML = runs.map((r) => this.runCard(r)).join('');
  }

  runCard(r) {
    const dept = (id) => r.departments.find((d) => d.id === id)?.name || id;
    const cur = r.current ? `<span class="muted"> · ${esc(dept(r.current.dept))} is working</span>` : '';
    const msgs = r.messages.slice().reverse().map((m) => {
      const from = m.from ? `<button class="tm-who" data-floor="${esc(m.from.dept)}">${esc(m.from.name)}</button>` : '<span class="tm-who you">You</span>';
      const to = m.to ? `<button class="tm-who" data-floor="${esc(m.to.dept)}">${esc(m.to.name)}</button>` : '<span class="tm-who you">You</span>';
      const openId = m.from?.sessionId || m.to?.sessionId;
      const more = this.open.has(m.id);
      return `<div class="tmsg${m.to ? '' : ' final'}">
        <div class="tm-head">${from}<span class="tm-arrow">→</span>${to}<span class="tm-time">${relTime(m.ts)}</span></div>
        <div class="tm-say sensitive"${openId ? ` data-open="${esc(openId)}" title="Open this robot"` : ''}>${esc(m.say)}</div>
        ${m.text && m.text !== m.say ? `<button class="tm-more" data-more="${esc(m.id)}">${more ? 'Hide' : 'Show'} the full message</button>${more ? `<pre class="tm-text sensitive">${esc(m.text)}</pre>` : ''}` : ''}
      </div>`;
    }).join('');
    return `<div class="run run-${esc(r.status)}">
      <div class="run-head">
        <span class="status-pill st-${r.status === 'running' ? 'working' : r.status === 'failed' ? 'needs_you' : r.status === 'done' ? 'your_turn' : 'idle'}">${esc(RUN_STATE[r.status] || r.status)}</span>
        <span class="muted">turn ${r.turn} of ${r.maxTurns} · ${esc(MODE_LABEL[r.mode] || r.mode)}</span>
        ${r.status === 'running' ? `<button class="ts-stop" data-stop-run="${esc(r.id)}">Stop</button>` : ''}
      </div>
      <div class="run-goal sensitive">${esc(r.goal)}</div>
      <div class="run-meta muted">${relTime(r.startedAt)}${cur}</div>
      ${r.error ? `<pre class="ts-error">${esc(r.error)}</pre>` : ''}
      <div class="tmsgs">${msgs}</div>
    </div>`;
  }
}
