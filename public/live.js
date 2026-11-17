// Live data source: SSE from the local server + JSON API.
export function liveSource() {
  const token = document.querySelector('meta[name="ao-token"]')?.content || '';
  let es = null;
  return {
    mode: 'live',
    connect(h) {
      es = new EventSource(`/events?token=${encodeURIComponent(token)}`);
      es.addEventListener('state', (e) => h.state(JSON.parse(e.data)));
      es.addEventListener('session', (e) => h.session(JSON.parse(e.data)));
      es.addEventListener('counters', (e) => h.counters(JSON.parse(e.data)));
      es.addEventListener('approvals', (e) => h.approvals(JSON.parse(e.data)));
      es.addEventListener('tasks', (e) => h.tasks(JSON.parse(e.data)));
      es.addEventListener('org', (e) => h.org(JSON.parse(e.data)));
      es.addEventListener('teams', (e) => h.teams(JSON.parse(e.data)));
      es.onopen = () => h.status('live');
      es.onerror = () => h.status('reconnecting');
    },
    async detail(id) {
      const r = await fetch(`/api/session/${encodeURIComponent(id)}`, { cache: 'no-store' });
      return r.ok ? r.json() : null;
    },
    async decide(id, decision) {
      const r = await fetch(`/api/approvals/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AO-Token': token },
        body: JSON.stringify({ decision }),
      });
      return r.ok;
    },
    /** body: { sessionId } or { projectKey }, plus { prompt, mode }. Resolves { task } or { error }. */
    async startTask(body) {
      try {
        const r = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AO-Token': token },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        return r.ok ? { task: j.task } : { error: j.error || `Request failed (${r.status})` };
      } catch {
        return { error: 'Could not reach the local server.' };
      }
    },
    /** Branches of a floor's git repo: { isRepo, current, branches: [{ name, robots, working, needs, checkedOut }] }. */
    async branches(projectKey) {
      try {
        const r = await fetch(`/api/branches?key=${encodeURIComponent(projectKey)}`, { cache: 'no-store' });
        return r.ok ? r.json() : { isRepo: false, branches: [] };
      } catch { return { isRepo: false, branches: [] }; }
    },
    async stopTask(id) {
      const r = await fetch(`/api/tasks/${encodeURIComponent(id)}/stop`, { method: 'POST', headers: { 'X-AO-Token': token } });
      return r.ok;
    },
    /** The floors of a building, floor 1 first: [{ id?, name, role }]. Resolves { ok } or { error }. */
    async setDepartments(projectKey, departments) { return post('/api/org', { op: 'departments', projectKey, departments }); },
    /** Moves a robot to another department (it takes the lift). */
    async assign(projectKey, sessionId, dept) { return post('/api/org', { op: 'assign', projectKey, sessionId, dept }); },
    /** { projectKey, goal, mode, departments, start, maxTurns } → { run } or { error } */
    async startTeam(body) { return post('/api/teams', body); },
    async stopTeam(id) { const r = await post(`/api/teams/${encodeURIComponent(id)}/stop`, {}); return !r.error; },
  };

  async function post(url, body) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AO-Token': token }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      return r.ok ? j : { error: j.error || `Request failed (${r.status})` };
    } catch {
      return { error: 'Could not reach the local server.' };
    }
  }
}
