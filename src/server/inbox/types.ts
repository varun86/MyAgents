// Session Inbox types (PRD 0.2.18) — TS mirror of Rust `crate::inbox::types`.
//
// Field names use camelCase here (Rust struct uses snake_case but serde
// `rename_all = "camelCase"` exposes camelCase on the wire — see
// `src-tauri/src/inbox/types.rs`).

/// Inbox message kind — request (initial dispatch) or reply (turn-end pushback)
export type InboxMessageKind = 'request' | 'reply';

/// Pending inbox message — body shape for POST /api/inbox/deliver +
/// POST /api/inbox/drain. Stays in sync with Rust `PendingInboxMessage`.
export interface PendingInboxMessage {
  messageId: string;
  fromSessionId: string;
  fromLabel: string;
  toSessionId: string;
  /** Prompt text — naming matches Rust `text` field (transport-level neutral) */
  text: string;
  replyBack: boolean;
  timestampMs?: number;
  kind?: InboxMessageKind;
  inReplyTo?: string | null;
}

/// Per-turn inbox metadata carried alongside a session message. Bound at the
/// moment the message is dequeued (generator yield) and read at turn-end to
/// decide whether to push a reply back.
///
/// Critical: this is **per-turn**, not session-level singleton — bind on
/// dequeue, read at result handler, never mutate during the turn.
export interface InboxTurnMeta {
  /** Caller session id (used as target for reply) */
  fromSessionId: string;
  /** Caller label (forwarded to AI in `<inbox-reply from="...">` ) */
  fromLabel: string;
  /** Whether caller expects a reply pushback */
  replyBack: boolean;
  /** Original message id (used as `in_reply_to` correlation in reply) */
  originalMessageId: string;
  /** Original request snippet (前 40 字) for `in_reply_to` attribute */
  originalSnippet: string;
}

/// `POST /api/inbox/drain` response shape — informs Rust whether the sidecar
/// accepted the messages or rejected them (e.g. external runtime busy).
export interface DrainResponse {
  accepted: boolean;
  /** Reason when accepted=false (e.g. 'external_busy', 'session_aborted') */
  reason?: string;
}

/// Outcome enum returned by Rust `/api/inbox/deliver` (matches Rust DeliverOutcome)
export type DeliverOutcome =
  | { status: 'delivered'; message_id: string }
  | { status: 'session_not_found' }
  | { status: 'delivery_failed'; reason: string }
  | { status: 'rejected'; reason: string };

/// Snippet for in_reply_to — limit to 40 chars, preserves user-readable hint
export const IN_REPLY_TO_SNIPPET_LENGTH = 40;

export function buildInReplyToSnippet(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= IN_REPLY_TO_SNIPPET_LENGTH) return trimmed;
  return trimmed.slice(0, IN_REPLY_TO_SNIPPET_LENGTH) + '...';
}
