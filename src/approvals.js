// Pending PermissionRequest approvals, answered from the browser.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

export class Approvals extends EventEmitter {
  constructor() {
    super();
    this.items = new Map(); // id -> { item, resolve, timer }
  }

  list() {
    return [...this.items.values()].map((e) => e.item).sort((a, b) => a.ts - b.ts);
  }

  pendingFor(sessionId) {
    for (const { item } of this.items.values()) if (item.sessionId === sessionId) return true;
    return false;
  }

  /** Adds an approval and returns a promise for 'allow' | 'deny' | null (timeout / cancelled). */
  add(fields, waitMs) {
    const id = crypto.randomUUID();
    const item = { id, ts: Date.now(), expiresAt: Date.now() + waitMs, ...fields };
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    const timer = setTimeout(() => this._finish(id, null, 'timeout'), waitMs);
    this.items.set(id, { item, resolve, timer });
    this.emit('change', { type: 'added', item });
    return { item, promise };
  }

  decide(id, decision) {
    if (decision !== 'allow' && decision !== 'deny') return false;
    return this._finish(id, decision, decision);
  }

  cancel(id, reason = 'cancelled') {
    return this._finish(id, null, reason);
  }

  /** Cancel approvals for a session (and optionally one subagent): the terminal moved on. */
  cancelFor(sessionId, agentId = undefined, reason = 'answered elsewhere') {
    for (const { item } of [...this.items.values()]) {
      if (item.sessionId !== sessionId) continue;
      if (agentId !== undefined && (item.agentId || null) !== (agentId || null)) continue;
      this._finish(item.id, null, reason);
    }
  }

  _finish(id, decision, reason) {
    const e = this.items.get(id);
    if (!e) return false;
    clearTimeout(e.timer);
    this.items.delete(id);
    e.resolve(decision);
    this.emit('change', { type: 'resolved', id, reason, decision });
    return true;
  }
}
