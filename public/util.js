// Small formatting helpers shared by the UI.
export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
  return String(Math.round(n));
}

export function fmtCost(n) {
  n = n || 0;
  if (n > 0 && n < 0.01) return '<$0.01';
  return '$' + (n >= 100 ? n.toFixed(0) : n.toFixed(2));
}

export function fmtDur(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function relTime(ts, now = Date.now()) {
  if (!ts) return '—';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const STATUS_LABEL = {
  working: 'Working', needs_you: 'Needs you', your_turn: 'Your turn', idle: 'Idle', ended: 'Ended', done: 'Done',
};

const FALLBACK_DEPARTMENTS = [{ id: 'general', name: 'General', role: '' }];

/** The departments (floors) of a building, floor 1 first. */
export function departmentsOf(org, projectKey) {
  const own = org?.projects?.[projectKey]?.departments;
  if (own?.length) return own;
  return org?.defaults?.length ? org.defaults : FALLBACK_DEPARTMENTS;
}

export const store = {
  get(k, d) { try { const v = localStorage.getItem('ao:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ao:' + k, JSON.stringify(v)); } catch {} },
};
