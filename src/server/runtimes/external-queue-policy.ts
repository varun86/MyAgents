/**
 * Pure policy for the external-runtime mid-turn message queue.
 *
 * External runtimes (Codex / Claude Code CLI / Gemini CLI) are TURN-LEVEL: each
 * `sendMessage` starts a NEW turn (Codex `turn/start`); there is no mid-tool-call
 * injection like the builtin SDK's `queued_command`. So a message typed while a turn is
 * running must NOT be sent immediately (that surfaces an out-of-order bubble + silently
 * runs after the turn). Instead it's held in a MyAgents-side queue (a pill) and, at turn
 * end, surfaced as a bubble + sent — mirroring the builtin SDK's queue model. Force-send
 * interrupts the current turn (turn/interrupt) so the same turn-end drain runs it now.
 *
 * Functional Core / Imperative Shell: these are the two decisions; the shell in
 * external-session.ts owns the queue array + broadcasts.
 */
export type ExternalQueueState = 'idle' | 'running' | 'error';

/**
 * Should a desktop send be DEFERRED into the queue instead of sent immediately?
 * Defer when a turn is running, OR items are already queued (preserve FIFO so a later
 * send can't jump ahead of an earlier still-pending one).
 */
export function shouldQueueExternalSend(state: ExternalQueueState, queueLength: number): boolean {
  return state === 'running' || queueLength > 0;
}

/**
 * May the queue be drained NOW (surface + send exactly one item)? Only when the session is
 * idle (a turn just ended / was interrupted) and something is queued. Guards against
 * draining mid-turn or on a spurious idle with an empty queue.
 */
export function canDrainExternalQueue(state: ExternalQueueState, queueLength: number): boolean {
  return state === 'idle' && queueLength > 0;
}
