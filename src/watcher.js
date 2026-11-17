// Watches the projects dir. fs.watch (recursive) gives fast updates; a light poll
// of recently-active files plus a periodic rescan covers missed events.
import fs from 'node:fs';
import path from 'node:path';

export function startWatcher(store, { pollMs = 2000, rescanMs = 10_000 } = {}) {
  const dir = store.dir;
  let watcher = null;
  const pending = new Map();

  const queue = (file) => {
    if (pending.has(file)) return;
    pending.set(file, setTimeout(() => {
      pending.delete(file);
      store.onFileEvent(file).catch((e) => console.error('[agent-office] read error', file, e.message));
    }, 60));
  };

  const tryWatch = () => {
    if (watcher || !fs.existsSync(dir)) return;
    try {
      watcher = fs.watch(dir, { recursive: true, persistent: true }, (_evt, filename) => {
        if (!filename) return;
        const f = path.join(dir, filename.toString());
        if (f.endsWith('.jsonl') || f.endsWith('.meta.json')) queue(f);
      });
      watcher.on('error', () => { try { watcher.close(); } catch {} watcher = null; });
    } catch (e) {
      console.warn('[agent-office] fs.watch unavailable, polling only:', e.message);
    }
  };
  tryWatch();

  const poll = setInterval(async () => {
    for (const rec of store.hotFiles()) {
      try {
        const st = await fs.promises.stat(rec.file);
        if (st.size !== rec.tail.offset) queue(rec.file);
      } catch {}
    }
  }, pollMs);
  const rescan = setInterval(() => {
    tryWatch();
    if (fs.existsSync(dir)) store.scan().catch(() => {});
  }, rescanMs);
  poll.unref(); rescan.unref();

  return { close() { clearInterval(poll); clearInterval(rescan); watcher?.close(); } };
}
