// Session Inbox drain handler — POST /api/inbox/drain (PRD 0.2.18).
//
// 由 Rust 端 `cmd_inbox_deliver` 在 push pending_inbox_messages 后调用,把同样
// 的 message payload 直接 POST 过来。Drain handler 取出 messages → 包裹
// `<inbox-message>` (kind=Request) 或 `<inbox-reply>` (kind=Reply) 前缀
// → 调用 enqueueUserMessage / sendExternalMessage 注入。
//
// 关键设计:
//   - Request 类型携带 replyBack 标记;target turn-end 时根据这个标记决定是否
//     反向推 reply(逻辑在 agent-session.ts result handler / external-session.ts
//     persistTurnResult hook 中)。
//   - Reply 类型的 replyBack 恒为 false——避免 reply 的 reply 形成无限往返。
//   - 注入时 sanitize fromLabel(集中点),避免 prompt injection
//     (`</inbox-message>` 闭合标签注入等)。

import { neutralizeInboxStructuralTags, sanitizeInboxLabel } from './sanitize-label';
import { buildInReplyToSnippet } from './types';
import type { PendingInboxMessage, DrainResponse, InboxTurnMeta } from './types';

/// 构造 <inbox-message> 包裹 (Request 模式)
function buildInboxMessagePrompt(msg: PendingInboxMessage): string {
  const label = sanitizeInboxLabel(msg.fromLabel);
  const replyBackAttr = msg.replyBack ? 'true' : 'false';
  const safeBody = neutralizeInboxStructuralTags(msg.text);
  return `<inbox-message from="${label}" reply_back="${replyBackAttr}">\n${safeBody}\n</inbox-message>`;
}

/// 构造 <inbox-reply> 包裹 (Reply 模式)
function buildInboxReplyPrompt(msg: PendingInboxMessage): string {
  const label = sanitizeInboxLabel(msg.fromLabel);
  const inReplyTo = msg.inReplyTo
    ? ` in_reply_to="${sanitizeInboxLabel(buildInReplyToSnippet(msg.inReplyTo))}"`
    : '';
  // Future: if msg carries an error flag (currently embedded in text by reply-deliver),
  // wrap with error="true" — for now, reply-deliver embeds [ERROR] prefix in text.
  const safeBody = neutralizeInboxStructuralTags(msg.text);
  return `<inbox-reply from="${label}"${inReplyTo}>\n${safeBody}\n</inbox-reply>`;
}

/// Build per-turn InboxTurnMeta to bind on the dequeued message. Only present
/// for Request kind with replyBack=true — Reply kind never triggers further reply.
function buildTurnMeta(msg: PendingInboxMessage): InboxTurnMeta | undefined {
  if (msg.kind === 'reply') return undefined;
  if (!msg.replyBack) return undefined;
  return {
    fromSessionId: msg.fromSessionId,
    fromLabel: msg.fromLabel,
    replyBack: true,
    originalMessageId: msg.messageId,
    originalSnippet: buildInReplyToSnippet(msg.text),
  };
}

/// Function signature for the message injector. Different runtimes provide
/// different implementations — agent-session for builtin SDK, external-session
/// for CC CLI / Codex / Gemini. The wrapper passes inboxMeta along for turn-end
/// reply binding.
export type InboxInjector = (
  text: string,
  inboxMeta?: InboxTurnMeta,
) => Promise<{ queued: boolean; error?: string }>;

/// Drain handler entry — processes a batch of messages, returns aggregated response.
///
/// Currently messages always arrive in batches of size 1 from Rust (one POST
/// per cmd_inbox_deliver call), but the interface supports N for future batching.
export async function handleInboxDrain(
  messages: PendingInboxMessage[],
  injector: InboxInjector,
): Promise<DrainResponse> {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { accepted: false, reason: 'empty message batch' };
  }

  let acceptedAny = false;
  const rejectReasons: string[] = [];

  for (const msg of messages) {
    const isReply = msg.kind === 'reply';
    const prompt = isReply ? buildInboxReplyPrompt(msg) : buildInboxMessagePrompt(msg);
    const meta = buildTurnMeta(msg);

    try {
      const result = await injector(prompt, meta);
      // PRD 0.2.18 cross-review fix (Codex):
      // enqueueUserMessage's `queued` flag is "queued behind other turns" not
      // "accepted vs rejected". On the idle direct-send path it returns
      // `{ queued: false }` (NO error) — that's a SUCCESS. The actual
      // failure signal is `error` (e.g. "Queue full (max 10)" / runtime errors).
      // Treating queued:false as rejection caused every idle delivery to fail
      // → CLI exit non-zero → caller AI retries duplicate prompts.
      if (!result.error) {
        acceptedAny = true;
        console.log(
          `[inbox/drain] accepted ${msg.kind} from=${msg.fromSessionId} msg_id=${msg.messageId} (queued=${result.queued})` +
            (meta ? ` (reply_back=true, will push reply on turn-end)` : ''),
        );
      } else {
        const reason = result.error;
        rejectReasons.push(`${msg.messageId}: ${reason}`);
        console.warn(`[inbox/drain] rejected msg_id=${msg.messageId}: ${reason}`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      rejectReasons.push(`${msg.messageId}: ${reason}`);
      console.error(`[inbox/drain] inject failed for ${msg.messageId}:`, err);
    }
  }

  if (acceptedAny) {
    // At least one queued — treat batch as accepted; per-message rejects are logged.
    return { accepted: true };
  }
  return { accepted: false, reason: rejectReasons.join('; ') || 'all messages rejected' };
}
