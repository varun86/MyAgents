export interface EmptySuccessfulSdkResultInput {
  isError?: boolean;
  result?: string | null;
  terminalReason?: string | null;
  hasVisibleOutput: boolean;
  toolCount: number;
  outputTokens?: number | null;
}

export function isEmptySuccessfulSdkResult(input: EmptySuccessfulSdkResultInput): boolean {
  return input.isError !== true
    && input.terminalReason === 'completed'
    && !input.hasVisibleOutput
    && input.toolCount === 0
    && (input.result ?? '').trim() === ''
    && (input.outputTokens ?? 0) === 0;
}

export interface RecoveredAssistantMessageErrorInput {
  hadAssistantMessageError: boolean;
  isError?: boolean;
  terminalReason?: string | null;
  emptySuccessfulResult: boolean;
}

export function isRecoveredAssistantMessageError(input: RecoveredAssistantMessageErrorInput): boolean {
  return input.hadAssistantMessageError
    && input.isError !== true
    && input.terminalReason === 'completed'
    && !input.emptySuccessfulResult;
}

/**
 * #331 — pick which message a completed turn's usage belongs to.
 *
 * The turn's usage (input/output/cache, tool count, duration) is a property of
 * the assistant response that just finished, NOT of "whatever element happens to
 * be last in `messages[]` when persistence runs". Persistence used the latter
 * (`absoluteIndex === messages.length - 1 && role === 'assistant'`), which loses
 * the usage whenever something is appended after the assistant before the
 * fire-and-forget turn-end persist executes — a queued user message surfaced at
 * turn end, or the next turn's messages pushed while the persist waits on the
 * file lock. Because the JSONL writer is append-only and session stats are summed
 * incrementally at append time, a usage-less append is permanent → the stats
 * panel shows 0 tokens (issue #331).
 *
 * This returns the index of the trailing assistant message within the
 * not-yet-persisted range `[fromIndex, messages.length)`, but only if that
 * assistant has NOT already been stamped (`usage === undefined`); otherwise -1.
 *
 * Two guards, both required:
 *  - `fromIndex` (the persist cursor) keeps us from re-selecting a prior turn's
 *    ALREADY-PERSISTED assistant.
 *  - the `usage === undefined` check keeps us from re-stamping a prior turn's
 *    STAMPED-BUT-NOT-YET-PERSISTED assistant. The cursor alone is insufficient:
 *    the turn-end persist is fire-and-forget and can sit blocked on the file lock
 *    while the next turn runs, so `fromIndex` may still sit behind an
 *    already-stamped assistant. If that next turn completes producing no new
 *    assistant of its own (empty / error / aborted result), the trailing
 *    assistant in range is the prior turn's — and overwriting its usage with this
 *    turn's (often empty) usage is exactly the corruption we must avoid. A
 *    stamped trailing assistant ⇒ this turn produced no assistant ⇒ return -1.
 *    (Cross-review by Codex caught this race.)
 */
export function findTurnUsageStampIndex(
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; usage?: unknown }>,
  fromIndex: number,
): number {
  for (let i = messages.length - 1; i >= Math.max(0, fromIndex); i--) {
    if (messages[i].role === 'assistant') {
      return messages[i].usage === undefined ? i : -1;
    }
  }
  return -1;
}
