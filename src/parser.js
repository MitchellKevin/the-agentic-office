// Pure transcript parser: feed it JSONL objects one at a time with applyLine().
// No filesystem access here, so it is easy to unit-test.
import { priceFor, usageTokens, costOf, contextWindowFor } from './pricing.js';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const MAX_CONVO = 1500;          // conversation items kept per session
const MAX_TEXT = 6000;           // chars kept per conversation item
const MAX_PREVIEW = 400;         // chars kept per tool input / result preview

export function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

export function createSession({ id, file = null, projectDir = null, parentId = null, agentId = null, meta = null } = {}) {
  return {
    id,
    file,
    projectDir,
    parentId,              // set for subagents
    agentId,
    meta,                  // subagent .meta.json contents
    cwd: null,
    gitBranch: null,
    version: null,
    entrypoint: null,
    aiTitle: null,
    summary: null,
    firstPrompt: null,
    lastPrompt: null,
    models: new Map(),     // model -> count of messages
    model: null,
    seen: new Set(),       // line uuids already applied
    messages: new Map(),   // message.id -> { model, tokens, cost, day }
    tokens: emptyTokens(),
    cost: 0,
    unpriced: false,
    byDay: new Map(),      // 'YYYY-MM-DD' -> { tokens, cost }
    byModel: new Map(),    // model -> { tokens, cost }
    steps: [],
    stepsById: new Map(),
    openSteps: new Set(),  // step ids without a result
    subagentCalls: new Map(), // tool_use id -> { subagentType, description, background, ts }
    convo: [],
    startedAt: null,
    lastActivity: null,    // ms: last user/assistant line
    lastEvent: null,       // { kind, ts, stopReason }
    lastContext: null,     // { tokens, model, ts }
    maxContext: 0,
    costState: null,       // Claude Code's own 'cost-state' line, if any
    parseErrors: 0,
    lines: 0,
  };
}

// ---------- helpers ----------

export function basename(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || String(p);
}

function trunc(s, n) {
  if (s == null) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function firstLine(s) {
  return String(s || '').split('\n').find((l) => l.trim()) || '';
}

function toMs(ts) {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

export function localDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function preview(v, depth = 0) {
  if (v == null) return v;
  if (typeof v === 'string') return trunc(v, MAX_PREVIEW);
  if (typeof v !== 'object') return v;
  if (depth > 2) return Array.isArray(v) ? `[${v.length} items]` : '{…}';
  if (Array.isArray(v)) return v.slice(0, 10).map((x) => preview(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v).slice(0, 20)) out[k] = preview(val, depth + 1);
  return out;
}

function resultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && c.type === 'text' ? c.text : c && c.type === 'image' ? '[image]' : ''))
      .join('\n');
  }
  return '';
}

/** Short human label for a tool call, e.g. "Edit server.js". */
export function stepLabel(name, input = {}) {
  input = input || {};
  switch (name) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'Read':
      return `${name} ${basename(input.file_path)}`.trim();
    case 'NotebookEdit':
      return `NotebookEdit ${basename(input.notebook_path)}`.trim();
    case 'Bash':
      return `Bash ${trunc(firstLine(input.command), 48)}`.trim();
    case 'Grep':
      return `Grep "${trunc(input.pattern, 32)}"`;
    case 'Glob':
      return `Glob ${trunc(input.pattern, 40)}`;
    case 'WebFetch': {
      try { return `WebFetch ${new URL(input.url).host}`; } catch { return 'WebFetch'; }
    }
    case 'WebSearch':
      return `WebSearch "${trunc(input.query, 32)}"`;
    case 'Agent':
    case 'Task':
      return `${input.subagent_type || 'agent'}: ${trunc(input.description || '', 40)}`;
    case 'TodoWrite':
      return 'Updating todos';
    case 'AskUserQuestion':
      return 'Asking you a question';
    case 'ExitPlanMode':
      return 'Plan ready for review';
    case 'Skill':
      return `Skill ${input.skill || ''}`.trim();
    default:
      if (name && name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__');
        return `${server}: ${tool || ''}`.trim();
      }
      return name || 'tool';
  }
}

// Text from a user message that is not something the human actually typed.
function isSyntheticPrompt(text) {
  const t = text.trimStart();
  return (
    t.startsWith('<') ||                       // <command-name>, <local-command-stdout>, <system-reminder>, <bash-input>…
    t.startsWith('[Request interrupted') ||
    t.startsWith('Caveat:') ||
    t.startsWith('This session is being continued from a previous conversation')
  );
}

function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : c.type === 'document' ? '[document]' : ''))
    .filter(Boolean)
    .join('\n');
}

function pushConvo(s, item) {
  s.convo.push(item);
  if (s.convo.length > MAX_CONVO) s.convo.splice(0, s.convo.length - MAX_CONVO);
}

function addTokens(target, t, sign = 1) {
  for (const k of Object.keys(t)) target[k] = (target[k] || 0) + sign * t[k];
}

function bucket(map, key) {
  let b = map.get(key);
  if (!b) map.set(key, (b = { tokens: emptyTokens(), cost: 0 }));
  return b;
}

function touch(s, ms) {
  if (ms == null) return;
  if (s.startedAt == null || ms < s.startedAt) s.startedAt = ms;
  if (s.lastActivity == null || ms > s.lastActivity) s.lastActivity = ms;
}

function closeOpenSteps(s, ms, status) {
  for (const id of s.openSteps) {
    const st = s.stepsById.get(id);
    if (!st) continue;
    st.end = ms;
    st.status = status;
    st.durationMs = ms != null && st.start != null ? Math.max(0, ms - st.start) : null;
  }
  s.openSteps.clear();
}

// ---------- main entry ----------

export function applyLine(s, obj, cfg) {
  if (!obj || typeof obj !== 'object') return false;
  s.lines++;
  if (obj.uuid) {
    if (s.seen.has(obj.uuid)) return false;
    s.seen.add(obj.uuid);
  }
  if (obj.cwd && !s.cwd) s.cwd = obj.cwd;
  if (obj.gitBranch) s.gitBranch = obj.gitBranch;
  if (obj.version) s.version = obj.version;
  if (obj.entrypoint) s.entrypoint = obj.entrypoint;
  if (obj.agentId && !s.agentId && s.parentId) s.agentId = obj.agentId;

  switch (obj.type) {
    case 'ai-title':
      if (obj.aiTitle) s.aiTitle = obj.aiTitle;
      return true;
    case 'summary':
      if (obj.summary) s.summary = obj.summary;
      return true;
    case 'last-prompt':
      if (obj.lastPrompt) s.lastPrompt = obj.lastPrompt;
      return true;
    case 'cost-state':
      s.costState = {
        totalCostUSD: obj.totalCostUSD ?? null,
        linesAdded: obj.totalLinesAdded ?? null,
        linesRemoved: obj.totalLinesRemoved ?? null,
      };
      return true;
    case 'user':
      applyUser(s, obj);
      return true;
    case 'assistant':
      applyAssistant(s, obj, cfg);
      return true;
    default:
      return false; // attachment, queue-operation, file-history-*, system, …
  }
}

function applyUser(s, obj) {
  const ms = toMs(obj.timestamp);
  const content = obj.message?.content;

  // Tool results.
  if (Array.isArray(content) && content.some((c) => c && c.type === 'tool_result')) {
    touch(s, ms);
    for (const c of content) {
      if (!c || c.type !== 'tool_result') continue;
      const st = s.stepsById.get(c.tool_use_id);
      if (!st) continue;
      const denied = obj.permissionDecision?.decision === 'reject' ||
        (c.is_error && /doesn't want to proceed|was rejected|denied/i.test(resultText(c.content)));
      st.end = ms;
      st.durationMs = ms != null && st.start != null ? Math.max(0, ms - st.start) : null;
      st.status = denied ? 'denied' : c.is_error ? 'error' : 'ok';
      st.resultPreview = trunc(resultText(c.content), MAX_PREVIEW);
      s.openSteps.delete(st.id);
    }
    s.lastEvent = { kind: 'tool_result', ts: ms };
    return;
  }

  if (obj.isMeta) return;
  const text = userText(content);
  if (!text) return;

  if (text.trimStart().startsWith('[Request interrupted')) {
    touch(s, ms);
    closeOpenSteps(s, ms, 'interrupted');
    s.lastEvent = { kind: 'interrupt', ts: ms };
    pushConvo(s, { role: 'system', kind: 'interrupt', text: 'Interrupted by user', ts: ms });
    return;
  }

  const t = text.trimStart();
  // Local slash-command output and caveats never start a model turn.
  if (/^<(local-command-|command-|bash-(stdout|stderr))/.test(t) || t.startsWith('Caveat:')) {
    if (t.startsWith('<command-name>')) {
      const name = (t.match(/<command-name>([^<]*)<\/command-name>/) || [])[1];
      if (name) pushConvo(s, { role: 'user', kind: 'command', text: name, ts: ms });
    }
    return;
  }

  touch(s, ms);
  const synthetic = isSyntheticPrompt(text) || obj.isCompactSummary;
  if (!synthetic && !s.firstPrompt) s.firstPrompt = trunc(firstLine(text), 200);
  if (!synthetic) s.lastPrompt = trunc(text, 300);
  s.lastEvent = { kind: 'user_prompt', ts: ms };
  pushConvo(s, { role: 'user', kind: synthetic ? 'system-text' : 'prompt', text: trunc(text, MAX_TEXT), ts: ms });
}

function applyAssistant(s, obj, cfg) {
  const ms = toMs(obj.timestamp);
  const msg = obj.message || {};
  const model = msg.model;
  const synthetic = model === '<synthetic>';
  touch(s, ms);

  if (model && !synthetic) {
    s.model = model;
    s.models.set(model, (s.models.get(model) || 0) + 1);
  }

  // Usage: streamed messages repeat the same message.id on several lines;
  // the last line for an id carries the final numbers, so replace, don't add.
  if (msg.usage && !synthetic && cfg) {
    const key = msg.id || obj.uuid;
    const tokens = usageTokens(msg.usage);
    const price = priceFor(model, cfg);
    const cost = costOf(tokens, price);
    const prev = s.messages.get(key);
    const day = prev ? prev.day : localDay(ms ?? Date.now());
    if (prev) {
      addTokens(s.tokens, prev.tokens, -1);
      s.cost -= prev.cost;
      const b = bucket(s.byDay, prev.day); addTokens(b.tokens, prev.tokens, -1); b.cost -= prev.cost;
      const bm = bucket(s.byModel, prev.model); addTokens(bm.tokens, prev.tokens, -1); bm.cost -= prev.cost;
    }
    s.messages.set(key, { model, tokens, cost, day });
    addTokens(s.tokens, tokens);
    s.cost += cost;
    const b = bucket(s.byDay, day); addTokens(b.tokens, tokens); b.cost += cost;
    const bm = bucket(s.byModel, model); addTokens(bm.tokens, tokens); bm.cost += cost;
    if (price.unpriced) s.unpriced = true;

    if (!obj.isSidechain || s.parentId) {
      const ctx = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
      s.lastContext = { tokens: ctx, model, ts: ms };
      if (ctx > s.maxContext) s.maxContext = ctx;
    }
  }

  const blocks = Array.isArray(msg.content) ? msg.content : [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'text' && b.text) {
      pushConvo(s, { role: 'assistant', kind: synthetic ? 'error' : 'text', text: trunc(b.text, MAX_TEXT), ts: ms });
    } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
      const last = s.convo[s.convo.length - 1];
      if (b.thinking) pushConvo(s, { role: 'assistant', kind: 'thinking', text: trunc(b.thinking, MAX_TEXT), ts: ms });
      else if (!last || last.kind !== 'thinking') pushConvo(s, { role: 'assistant', kind: 'thinking', text: '', ts: ms });
    } else if (b.type === 'tool_use' && b.id && !s.stepsById.has(b.id)) {
      const input = b.input || {};
      const step = {
        id: b.id,
        tool: b.name,
        label: stepLabel(b.name, input),
        input: preview(input),
        start: ms,
        end: null,
        durationMs: null,
        status: 'open',
        resultPreview: null,
        background: !!input.run_in_background,
      };
      s.steps.push(step);
      s.stepsById.set(b.id, step);
      s.openSteps.add(b.id);
      pushConvo(s, { role: 'assistant', kind: 'tool', text: step.label, tool: b.name, stepId: b.id, ts: ms });

      if (AGENT_TOOLS.has(b.name)) {
        s.subagentCalls.set(b.id, {
          toolUseId: b.id,
          subagentType: input.subagent_type || 'general-purpose',
          description: input.description || '',
          background: !!input.run_in_background,
          ts: ms,
        });
      }
    }
  }

  s.lastEvent = { kind: 'assistant', ts: ms, stopReason: msg.stop_reason ?? null, synthetic };
}

// ---------- derived views ----------

export function sessionTitle(s) {
  if (s.parentId && s.meta?.description) return s.meta.description;
  return s.aiTitle || s.summary || s.firstPrompt || (s.parentId ? 'Subagent' : 'New session');
}

export function projectName(s) {
  if (s.cwd) return basename(s.cwd);
  if (s.projectDir) {
    // "-Users-me-code-my-app" → best effort "my-app" (dashes are ambiguous)
    const parts = s.projectDir.split('-').filter(Boolean);
    return parts[parts.length - 1] || s.projectDir;
  }
  return 'unknown';
}

export function contextInfo(s, cfg) {
  const model = s.lastContext?.model || s.model;
  const used = s.lastContext?.tokens || 0;
  const window = contextWindowFor(model, cfg, s.maxContext);
  return { used, window, pct: window ? used / window : 0 };
}

export function totalTokens(t) {
  return t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
}

export function currentStep(s) {
  let latest = null;
  for (const id of s.openSteps) {
    const st = s.stepsById.get(id);
    if (st && (!latest || (st.start ?? 0) >= (latest.start ?? 0))) latest = st;
  }
  return latest;
}

/** Files touched by Edit/Write/MultiEdit/NotebookEdit calls that were not denied or failed. */
export function filesChanged(s) {
  const map = new Map();
  for (const st of s.steps) {
    if (!FILE_TOOLS.has(st.tool) || st.status === 'denied' || st.status === 'error' || st.status === 'interrupted') continue;
    const p = st.input?.file_path || st.input?.notebook_path;
    if (!p) continue;
    const f = map.get(p) || { path: p, count: 0, tools: [], lastTs: null };
    f.count++;
    if (!f.tools.includes(st.tool)) f.tools.push(st.tool);
    f.lastTs = st.start;
    map.set(p, f);
  }
  return [...map.values()].sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
}
