// Side panel (session details) and approvals drawer.
import { $, esc, fmtTokens, fmtCost, fmtDur, relTime, STATUS_LABEL, store } from './util.js';
import { taskStrip } from './tasks.js';

export class Panel {
  constructor(source, { onOpenSession, onClose, onGiveTask, getConfig, onSent, getDepartments, onMove } = {}) {
    this.source = source;
    this.onOpenSession = onOpenSession || (() => {});
    this.onClose = onClose || (() => {});
    this.onGiveTask = onGiveTask || (() => {});
    this.getConfig = getConfig || (() => ({}));
    this.onSent = onSent || (() => {});
    this.getDepartments = getDepartments || (() => []);
    this.onMove = onMove || (() => {});
    this.dept = $('#pDept');
    this.dept.addEventListener('change', () => {
      const s = this.data?.summary;
      if (s && !this.data.isSubagent && this.dept.value && this.dept.value !== s.dept) this.onMove(s, this.dept.value);
    });
    this.tasks = [];
    this.drafts = new Map();   // session id -> unsent text
    this.pending = null;       // { id, text, ts } message sent, not in the transcript yet
    this.initComposer();
    $('#pTask').addEventListener('click', () => { if (this.id && !this.data?.isSubagent) this.onGiveTask(this.id); });
    $('#pTaskStrip').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-stop-task]');
      if (!b) return;
      this.stopping = b.dataset.stopTask;
      b.disabled = true; b.textContent = 'Stopping…';
      await this.source.stopTask(b.dataset.stopTask);
    });
    this.el = $('#panel');
    this.body = $('#pBody');
    this.tab = 'steps';
    this.id = null;
    this.data = null;
    this.expanded = new Set();
    this.loading = false;
    this.pendingRefresh = false;
    $('#pClose').addEventListener('click', () => this.close());
    for (const b of this.el.querySelectorAll('[role="tab"]')) {
      b.addEventListener('click', () => { this.tab = b.dataset.tab; this.render(true); });
    }
    this.body.addEventListener('click', (e) => this.onClick(e));
    setInterval(() => { if (this.id && this.data?.summary?.status === 'working') this.refresh(); else if (this.id) this.renderHeader(); }, 2000);
  }

  get openId() { return this.id; }

  // ---------- composer (Conversation tab) ----------
  initComposer() {
    this.cForm = $('#pCompose');
    this.cText = $('#pComposeText');
    this.cSend = $('#pComposeSend');
    this.cMode = $('#pComposeMode');
    this.cNote = $('#pComposeNote');
    this.cMode.value = store.get('taskMode', 'acceptEdits');
    const grow = () => { this.cText.style.height = 'auto'; this.cText.style.height = Math.min(180, this.cText.scrollHeight) + 'px'; };
    this.cText.addEventListener('input', () => {
      grow();
      if (this.id) this.drafts.set(this.id, this.cText.value);
      if (this.cNote.classList.contains('bad')) this.cNote.hidden = true;
    });
    this.cText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.sendMessage(); }
    });
    this.cMode.addEventListener('change', () => store.set('taskMode', this.cMode.value));
    this.cForm.addEventListener('submit', (e) => { e.preventDefault(); this.sendMessage(); });
    this.grow = grow;
  }

  /** Why the robot can't take a message right now, or null when it can. */
  composerBlock() {
    const d = this.data;
    const cfg = this.getConfig().tasks || {};
    if (cfg.enabled === false) return 'Tasks are turned off in config.json (tasks.enabled).';
    if (cfg.available === false) return 'Claude Code CLI not found. Set tasks.claudePath in config.json, then restart Agent Office.';
    if (!d?.summary?.cwd && !d?.summary?.project) return 'This robot has no known folder yet.';
    const running = this.tasks.find((t) => t.sessionId === this.id && t.status === 'running');
    const st = d?.summary?.status;
    if (running || st === 'working') return 'Working on it… you can send the next message when it is your turn.';
    if (st === 'needs_you') return 'Waiting on you: answer its question or approval first.';
    return null;
  }

  renderComposer() {
    const d = this.data;
    const show = this.tab === 'conversation' && d && !d.isSubagent;
    this.cForm.hidden = !show;
    if (!show) return;
    const block = this.composerBlock();
    const sending = !!this.sendingFor && this.sendingFor === this.id;
    this.cText.disabled = sending;
    this.cSend.disabled = !!block || sending;
    if (block) { this.cNote.textContent = block; this.cNote.className = 'composer-note'; this.cNote.hidden = false; }
    else if (!this.cNote.classList.contains('bad')) this.cNote.hidden = true;
    const s = d.summary;
    $('#pComposeWhere').innerHTML = s.branch ? `<span title="${esc(s.worktree || s.cwd || '')}">⎇ ${esc(s.branch)}${s.worktree ? ' · worktree' : ''}</span>` : '';
    this.cText.placeholder = block ? 'Write your next message…' : 'Give this robot a task…';
  }

  async sendMessage() {
    const text = this.cText.value.trim();
    if (!text || !this.id || this.data?.isSubagent) return;
    const block = this.composerBlock();
    if (block) { this.cNote.textContent = block; this.cNote.className = 'composer-note'; this.cNote.hidden = false; return; }
    const id = this.id;
    this.sendingFor = id;
    this.renderComposer();
    const r = await this.source.startTask({ sessionId: id, prompt: text, mode: this.cMode.value });
    this.sendingFor = null;
    if (r.error) {
      this.cNote.textContent = r.error;
      this.cNote.className = 'composer-note bad';
      this.cNote.hidden = false;
      this.renderComposer();
      return;
    }
    store.set('taskMode', this.cMode.value);
    this.drafts.delete(id);
    if (this.id === id) {
      this.cText.value = '';
      this.grow();
      this.pending = { id, text, ts: Date.now() };
      this.cNote.hidden = true;
      this.render();
      this.body.scrollTop = this.body.scrollHeight;
    }
    this.onSent(r.task);
    this.cText.focus();
  }

  async open(id) {
    if (this.id !== id) {
      if (this.id) this.drafts.set(this.id, this.cText.value);
      this.cText.value = this.drafts.get(id) || '';
      this.grow?.();
      this.cNote.hidden = true;
      this.expanded.clear(); this.data = null; this.body.innerHTML = '<div class="empty-tab">Loading…</div>';
    }
    this.id = id;
    this.el.hidden = false;
    await this.refresh(true);
  }

  close() {
    this.id = null; this.data = null; this.el.hidden = true;
    this.onClose();
  }

  async refresh(scrollTop = false) {
    if (!this.id) return;
    if (this.loading) { this.pendingRefresh = true; return; }
    this.loading = true;
    try {
      const id = this.id;
      const d = await this.source.detail(id);
      if (id !== this.id) return;
      if (!d) { this.body.innerHTML = '<div class="empty-tab">This session is no longer available.</div>'; return; }
      this.data = d;
      this.render(scrollTop);
    } catch {
      // keep last data
    } finally {
      this.loading = false;
      if (this.pendingRefresh) { this.pendingRefresh = false; this.refresh(); }
    }
  }

  renderHeader() {
    const d = this.data; if (!d) return;
    const s = d.summary;
    const st = s.status;
    const pill = $('#pStatus');
    pill.className = `status-pill st-${st}`;
    pill.textContent = (STATUS_LABEL[st] || st) + (s.reason && st !== 'working' ? ` · ${s.reason}` : '');
    $('#pTitle').textContent = d.isSubagent ? `${s.type}: ${s.description}` : s.title;
    const bits = [];
    if (d.isSubagent) bits.push('<span>intern (subagent)</span>', `<a href="#" data-open="${esc(d.parentId)}">open parent</a>`);
    if (s.project) bits.push(`<span>${esc(s.project)}</span>`);
    if (s.branch) bits.push(`<span class="sensitive" title="${esc(s.worktree ? `Worktree: ${s.worktree}` : s.cwd || '')}">⎇ ${esc(s.branch)}${s.worktree ? ' · worktree' : ''}</span>`);
    if (s.model) bits.push(`<span>${esc(s.model)}</span>`);
    bits.push(`<span>active ${relTime(s.lastActivity)}</span>`);
    if (s.hooks) bits.push('<span title="Receiving hook events">hooks ✓</span>');
    $('#pMeta').innerHTML = bits.join('');
    $('#pMeta').querySelector('[data-open]')?.addEventListener('click', (e) => { e.preventDefault(); this.onOpenSession(d.parentId); });
    $('#pTask').hidden = d.isSubagent;
    this.renderDept();
    this.renderTask();
    this.renderComposer();
    for (const b of this.el.querySelectorAll('[role="tab"]')) {
      b.setAttribute('aria-selected', String(b.dataset.tab === this.tab));
      const n = { steps: d.steps.length, files: d.files.length, approvals: d.approvals.length }[b.dataset.tab];
      const label = b.textContent.replace(/\s*\d+$/, '');
      b.innerHTML = esc(label) + (n ? `<span class="count">${n}</span>` : '');
    }
  }

  setTasks(list) { this.tasks = list; if (this.data) { this.renderTask(); this.renderComposer(); } }

  /** Which department the robot works in; changing it sends the robot up (or down) in the lift. */
  renderDept() {
    const d = this.data;
    const wrap = $('#pDeptWrap');
    const s = d?.summary;
    const deps = s && !d.isSubagent && s.projectKey ? this.getDepartments(s.projectKey) : [];
    wrap.hidden = !deps.length;
    if (!deps.length) return;
    const html = deps.slice().reverse().map((x, i) => `<option value="${esc(x.id)}">${deps.length - i} · ${esc(x.name)}</option>`).join('');
    if (this.dept.dataset.html !== html) { this.dept.innerHTML = html; this.dept.dataset.html = html; }
    if (document.activeElement !== this.dept) this.dept.value = deps.some((x) => x.id === s.dept) ? s.dept : deps[0].id;
  }

  renderTask() {
    const id = this.data?.isSubagent ? null : this.id;
    const task = id ? this.tasks.filter((t) => t.sessionId === id).at(-1) : null;
    const html = taskStrip(task);
    const el = $('#pTaskStrip');
    if (el.dataset.html === html) return;
    el.innerHTML = html;
    el.dataset.html = html;
    if (task && this.stopping === task.id) {
      const b = el.querySelector('[data-stop-task]');
      if (b) { b.disabled = true; b.textContent = 'Stopping…'; }
    }
  }

  render(scrollTop = false) {
    const d = this.data; if (!d) return;
    this.renderHeader();
    const prevScroll = this.body.scrollTop;
    const atBottom = this.body.scrollTop + this.body.clientHeight >= this.body.scrollHeight - 30;
    const html = {
      steps: () => this.steps(d),
      conversation: () => this.conversation(d),
      files: () => this.files(d),
      tokens: () => this.tokens(d),
      approvals: () => this.approvals(d),
    }[this.tab]();
    this.body.innerHTML = html;
    if (this.tab === 'conversation' && (scrollTop || atBottom)) this.body.scrollTop = this.body.scrollHeight;
    else if (scrollTop) this.body.scrollTop = 0;
    else this.body.scrollTop = prevScroll;
  }

  steps(d) {
    if (!d.steps.length) return '<div class="empty-tab">No tool calls yet.</div>';
    const max = Math.max(1000, ...d.steps.map((s) => s.durationMs || 0));
    const rows = d.steps.slice(-400).reverse().map((s) => {
      const pct = Math.max(2, Math.min(100, ((s.durationMs || 0) / max) * 100));
      const open = this.expanded.has(s.id);
      const chips = [
        s.status === 'error' ? '<span class="chip red">error</span>' : '',
        s.status === 'denied' ? '<span class="chip red">denied</span>' : '',
        s.status === 'interrupted' ? '<span class="chip">interrupted</span>' : '',
        s.background ? '<span class="chip">background</span>' : '',
        s.subagent ? `<span class="chip link" data-open="${esc(s.subagent)}">open intern →</span>` : '',
      ].join('');
      const detail = open ? `<div class="step-detail sensitive">${esc(JSON.stringify(s.input, null, 2))}${s.result ? '\n\n→ ' + esc(s.result) : ''}</div>` : '';
      return `<div class="step ${s.status}" data-step="${esc(s.id)}">
        <div class="step-row"><span class="sdot"></span><span class="step-label sensitive" title="${esc(s.label)}">${esc(s.label)}</span><span class="step-dur">${s.status === 'open' ? 'running ' : ''}${fmtDur(s.durationMs)}</span></div>
        <div class="step-bar"><i style="width:${pct}%"></i></div>
        ${chips ? `<div style="margin:4px 0 0 12px">${chips}</div>` : ''}
        ${detail}
      </div>`;
    }).join('');
    const subs = d.subagents?.length ? `<div class="section-title">Interns (${d.subagents.length})</div>` + d.subagents.map((i) =>
      `<div class="step" data-open="${esc(i.id)}"><div class="step-row"><span class="sdot" style="background:var(--${i.status === 'working' ? 'working' : i.status === 'needs_you' ? 'needs' : 'idle'})"></span><span class="step-label">${esc(i.type)}: <span class="sensitive">${esc(i.description)}</span></span><span class="step-dur">${esc(STATUS_LABEL[i.status] || i.status)}</span></div></div>`).join('') : '';
    const note = d.steps.length > 400 ? `<p class="note">Showing the latest 400 of ${d.steps.length} steps.</p>` : '';
    return subs + `<div class="section-title">Steps · newest first</div>` + rows + note;
  }

  conversation(d) {
    // A message you just sent shows straight away; it disappears once the transcript has it.
    let pendingHtml = '';
    const p = this.pending;
    if (p && p.id === this.id) {
      const landed = d.conversation.some((m) => m.role === 'user' && m.kind === 'prompt' && (m.ts ?? 0) >= p.ts - 5000 && m.text.trim().startsWith(p.text.slice(0, 40)));
      if (landed || Date.now() - p.ts > 5 * 60_000) this.pending = null;
      else pendingHtml = `<div class="msg user pending"><div class="who">You · sending…</div><div class="bubble sensitive">${esc(p.text)}</div></div>`;
    }
    if (!d.conversation.length) return pendingHtml || '<div class="empty-tab">No messages yet. Write the first task below.</div>';
    let thinkingRun = 0;
    const out = [];
    for (const m of d.conversation) {
      if (m.kind === 'thinking') { thinkingRun++; continue; }
      if (thinkingRun) { out.push(`<div class="msg thinking">thought for a moment</div>`); thinkingRun = 0; }
      if (m.kind === 'tool') out.push(`<div class="msg tool sensitive">⚙ ${esc(m.text)}</div>`);
      else if (m.kind === 'interrupt') out.push(`<div class="msg system">— interrupted —</div>`);
      else if (m.kind === 'command') out.push(`<div class="msg system">${esc(m.text)}</div>`);
      else if (m.role === 'user') out.push(`<div class="msg user"><div class="who">${m.kind === 'prompt' ? 'You' : 'System'} · ${relTime(m.ts)}</div><div class="bubble sensitive">${esc(m.text)}</div></div>`);
      else out.push(`<div class="msg ${m.kind === 'error' ? 'error' : 'assistant'}"><div class="who">Claude</div><div class="bubble sensitive">${esc(m.text)}</div></div>`);
    }
    if (thinkingRun) out.push(`<div class="msg thinking">thinking…</div>`);
    return out.join('') + pendingHtml;
  }

  files(d) {
    if (!d.files.length) return '<div class="empty-tab">No files changed.</div>';
    const cwd = d.summary.cwd ? d.summary.cwd.replace(/\/$/, '') + '/' : null;
    return `<div class="section-title">${d.files.length} file${d.files.length === 1 ? '' : 's'} changed</div>` + d.files.map((f) => {
      const p = cwd && f.path.startsWith(cwd) ? f.path.slice(cwd.length) : f.path;
      return `<div class="file"><span class="path sensitive">${esc(p)}</span><span class="n">${f.count}× ${esc(f.tools.join(', '))}</span></div>`;
    }).join('') + '<p class="note">Edit, Write, MultiEdit and NotebookEdit calls that were not denied or failed.</p>';
  }

  tokens(d) {
    const t = d.tokens;
    const ctx = t.context;
    const pct = Math.round((ctx.pct || 0) * 100);
    const cls = pct > 85 ? 'hot' : pct > 60 ? 'warn' : '';
    const rows = [
      ['Input', t.input], ['Output', t.output], ['Cache read', t.cacheRead],
      ['Cache write (5 min)', t.cacheWrite5m], ['Cache write (1 hour)', t.cacheWrite1h],
    ].map(([k, v]) => `<tr><td>${k}</td><td>${(v || 0).toLocaleString()}</td></tr>`).join('');
    const byModel = (t.byModel || []).filter((m) => m.total > 0).map((m) => `<tr><td>${esc(m.model)}</td><td>${fmtTokens(m.total)} · ${fmtCost(m.cost)}</td></tr>`).join('');
    const cc = d.costState?.totalCostUSD != null ? `<tr><td>Claude Code reported</td><td>${fmtCost(d.costState.totalCostUSD)}</td></tr>` : '';
    return `
      <div class="section-title">Context window</div>
      <div class="meter ${cls}"><i style="width:${Math.min(100, pct)}%"></i></div>
      <div class="note" style="margin-top:0">${fmtTokens(ctx.used)} of ${fmtTokens(ctx.window)} used on the last turn (${pct}%)</div>
      <div class="section-title">Tokens</div>
      <table class="kv">${rows}<tr class="total"><td>Total</td><td>${(t.total || 0).toLocaleString()}</td></tr></table>
      <div class="section-title">Cost</div>
      <table class="kv"><tr class="total"><td>Estimated</td><td>${fmtCost(t.cost)} est.</td></tr>${cc}</table>
      ${byModel ? `<div class="section-title">By model</div><table class="kv">${byModel}</table>` : ''}
      <p class="note">Estimate from the pricing table in config.json. Streamed messages are deduplicated by message id. ${t.unpriced ? '<b>Some models were not in the pricing table and use fallback prices.</b>' : ''}${d.isSubagent ? '' : ' Interns are counted separately.'}</p>`;
  }

  approvals(d) {
    if (!d.approvals.length) return `<div class="empty-tab">No pending approvals.${d.summary.hooks ? '' : '<br><br>Approvals need the optional hooks: run <code>npm run setup-hooks</code>.'}</div>`;
    return d.approvals.map(approvalCard).join('');
  }

  onClick(e) {
    const open = e.target.closest('[data-open]');
    if (open) { e.preventDefault(); this.onOpenSession(open.dataset.open); return; }
    const dec = e.target.closest('[data-decide]');
    if (dec) { decide(this.source, dec); return; }
    const step = e.target.closest('[data-step]');
    if (step) {
      const id = step.dataset.step;
      this.expanded.has(id) ? this.expanded.delete(id) : this.expanded.add(id);
      this.render();
    }
  }
}

export function approvalCard(a) {
  const left = Math.max(0, a.expiresAt - Date.now());
  const total = Math.max(1, a.expiresAt - a.ts);
  const input = a.input == null ? '' : typeof a.input === 'string' ? a.input : JSON.stringify(a.input, null, 2);
  return `<div class="approval" data-approval="${esc(a.id)}">
    <div class="ap-head"><span>${esc(a.project || '')}${a.agentId ? ' · intern' : ''}</span><span>${Math.ceil(left / 1000)}s left</span></div>
    <div class="ap-tool sensitive">${esc(a.label || a.tool)}</div>
    ${input ? `<pre class="sensitive">${esc(input.length > 2000 ? input.slice(0, 2000) + '…' : input)}</pre>` : ''}
    <div class="ap-actions">
      <button class="btn deny" data-decide="deny" data-id="${esc(a.id)}">Deny</button>
      <button class="btn allow" data-decide="allow" data-id="${esc(a.id)}">Allow</button>
    </div>
    <div class="timer"><i style="width:${(left / total) * 100}%"></i></div>
  </div>`;
}

export async function decide(source, btn) {
  const card = btn.closest('.approval');
  card?.querySelectorAll('button').forEach((b) => (b.disabled = true));
  const ok = await source.decide(btn.dataset.id, btn.dataset.decide);
  if (!ok && card) {
    card.querySelector('.ap-head span:last-child').textContent = 'expired';
  }
}

export class Drawer {
  constructor(source) {
    this.source = source;
    this.el = $('#drawer');
    this.body = $('#dBody');
    this.items = [];
    $('#dClose').addEventListener('click', () => this.toggle(false));
    this.body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-decide]');
      if (b) decide(this.source, b);
      const o = e.target.closest('[data-open]');
      if (o) this.onOpen?.(o.dataset.open);
    });
    setInterval(() => { if (!this.el.hidden && this.items.length) this.render(); }, 1000);
  }
  set(items, hint) {
    this.items = items;
    $('#dHint').innerHTML = hint;
    this.render();
  }
  toggle(on = this.el.hidden) { this.el.hidden = !on; if (on) this.render(); }
  render() {
    this.body.innerHTML = this.items.length ? this.items.map(approvalCard).join('') : '<div class="empty-tab">Nothing waiting for you.</div>';
  }
}
