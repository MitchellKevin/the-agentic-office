#!/usr/bin/env node
// Agent Office hook. Claude Code runs this for each registered hook event and pipes
// the event JSON to stdin. We forward it to the local Agent Office server.
//
// - Never blocks Claude Code: if the server is down we exit 0 immediately, silently.
// - PermissionRequest: if a browser tab is open, wait (up to ~45s) for Allow/Deny and
//   print the decision. Otherwise print nothing so the normal terminal prompt appears.
// - SessionStart: print the note about the project's files, if the server has one.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function port() {
  if (process.env.AGENT_OFFICE_PORT) return Number(process.env.AGENT_OFFICE_PORT);
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json'), 'utf8'));
    return cfg.port || 4317;
  } catch { return 4317; }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function post(body, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: port(), path: '/hook', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Host: `127.0.0.1:${port()}` },
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (out += c));
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

const raw = await readStdin();
let evt = null;
try { evt = JSON.parse(raw); } catch { process.exit(0); }
if (!evt || typeof evt !== 'object') process.exit(0);

if (evt.hook_event_name === 'PermissionRequest') {
  const res = await post(raw, 50_000);
  const decision = res?.decision;
  if (decision === 'allow') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }));
  } else if (decision === 'deny') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from Agent Office' } } }));
  }
  process.exit(0);
}

// SessionStart: the server may answer with a note about the building's project files, which
// Claude Code adds to the session's context.
if (evt.hook_event_name === 'SessionStart') {
  const res = await post(raw, 3000);
  if (typeof res?.context === 'string' && res.context) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: res.context } }));
  }
  process.exit(0);
}

await post(raw, 1000);
process.exit(0);
