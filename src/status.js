// Status heuristics. Pure functions over a parsed session (+ optional hook state).
//   working    – the agent is doing something
//   needs_you  – blocked on you (permission prompt, question, plan approval)
//   your_turn  – finished a turn; waiting for your next prompt
//   idle       – nothing happened for a while
//   ended      – SessionEnd hook received
import { currentStep } from './parser.js';

const DONE_STOPS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);

export function transcriptStatus(s, now, cfg) {
  const idleMs = (cfg.idleMinutes ?? 30) * 60_000;
  const guessMs = (cfg.permissionGuessSeconds ?? 8) * 1000;
  const quick = new Set(cfg.quickTools || []);
  const ask = new Set(cfg.askTools || ['AskUserQuestion', 'ExitPlanMode']);

  if (s.lastActivity == null) return { status: 'idle', reason: 'no activity yet' };
  if (now - s.lastActivity > idleMs) return { status: 'idle', reason: 'no activity for a while' };

  const step = currentStep(s);
  for (const id of s.openSteps) {
    const st = s.stepsById.get(id);
    if (!st) continue;
    if (ask.has(st.tool)) {
      return { status: 'needs_you', reason: st.tool === 'ExitPlanMode' ? 'plan approval' : 'question for you', step: st };
    }
  }
  for (const id of s.openSteps) {
    const st = s.stepsById.get(id);
    if (st && quick.has(st.tool) && st.start != null && now - st.start > guessMs) {
      return { status: 'needs_you', reason: 'probably waiting for permission', step: st, guessed: true };
    }
  }
  if (step) return { status: 'working', reason: 'running a tool', step };

  const ev = s.lastEvent;
  if (!ev) return { status: 'your_turn', reason: 'ready' };
  switch (ev.kind) {
    case 'user_prompt':
      return { status: 'working', reason: 'thinking' };
    case 'tool_result':
      return { status: 'working', reason: 'thinking' };
    case 'interrupt':
      return { status: 'your_turn', reason: 'interrupted' };
    case 'assistant':
      if (ev.synthetic) return { status: 'your_turn', reason: 'stopped (API error)' };
      if (ev.stopReason == null || ev.stopReason === 'tool_use' || ev.stopReason === 'pause_turn') {
        return { status: 'working', reason: 'thinking' };
      }
      if (DONE_STOPS.has(ev.stopReason)) return { status: 'your_turn', reason: 'finished a turn' };
      return { status: 'your_turn', reason: ev.stopReason };
    default:
      return { status: 'your_turn', reason: 'ready' };
  }
}

// Map a hook event to a status. Returns null when the event says nothing about status.
export function hookStatus(evt, cfg) {
  const ask = new Set(cfg.askTools || ['AskUserQuestion', 'ExitPlanMode']);
  switch (evt.hook_event_name) {
    case 'SessionStart':
      return { status: 'your_turn', reason: 'session started' };
    case 'UserPromptSubmit':
      return { status: 'working', reason: 'thinking' };
    case 'PreToolUse':
      if (ask.has(evt.tool_name)) {
        return { status: 'needs_you', reason: evt.tool_name === 'ExitPlanMode' ? 'plan approval' : 'question for you', tool: evt.tool_name };
      }
      return { status: 'working', reason: 'running a tool', tool: evt.tool_name };
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { status: 'working', reason: 'thinking' };
    case 'PermissionRequest':
      return { status: 'needs_you', reason: 'permission request', tool: evt.tool_name };
    case 'Notification': {
      const t = evt.notification_type || '';
      const msg = evt.message || '';
      if (t === 'permission_prompt' || t === 'elicitation_dialog' || /permission/i.test(msg)) {
        return { status: 'needs_you', reason: 'permission request' };
      }
      if (t === 'idle_prompt' || /waiting for your input/i.test(msg)) {
        return { status: 'your_turn', reason: 'waiting for your input' };
      }
      return null;
    }
    case 'Stop':
      return { status: 'your_turn', reason: 'finished a turn' };
    case 'SessionEnd':
      return { status: 'ended', reason: evt.reason || 'session ended' };
    default:
      return null;
  }
}

// Combine transcript heuristics with the freshest hook event.
//   hook = { ts, status, reason, tool } | null
//   pendingApproval = true when an approval for this session is waiting in the UI
export function combinedStatus(s, hook, now, cfg, pendingApproval = false) {
  const t = transcriptStatus(s, now, cfg);
  if (pendingApproval) return { ...t, status: 'needs_you', reason: 'approval waiting', source: 'hook' };
  if (!hook) return { ...t, source: 'transcript' };
  if (hook.status === 'ended') return { ...t, status: 'ended', reason: hook.reason, source: 'hook' };

  const idleMs = (cfg.idleMinutes ?? 30) * 60_000;
  const last = Math.max(hook.ts, s.lastActivity ?? 0);
  if (now - last > idleMs) return { ...t, status: 'idle', reason: 'no activity for a while', source: 'transcript' };

  // The hook wins while it is at least as fresh as the transcript (with a little
  // slack: transcripts are flushed slightly after hooks fire).
  if (hook.ts + 1500 >= (s.lastActivity ?? 0)) {
    // Exception: transcript shows a question / plan the hook stream missed.
    if (t.status === 'needs_you' && !t.guessed) return { ...t, source: 'transcript' };
    return { ...t, status: hook.status, reason: hook.reason, source: 'hook' };
  }
  return { ...t, source: 'transcript' };
}
