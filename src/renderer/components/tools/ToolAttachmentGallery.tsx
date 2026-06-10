/**
 * ToolAttachmentGallery — uniform renderer for all rich-media tool attachments.
 *
 * PRD 0.2.15 §4.8. Two mount points, split by `attachment.presentation` (#293):
 *  - ARTIFACT media (default) — mounted by Message.tsx in the message flow
 *    (after each BlockGroup): deliverables (Codex image_generation, MCP
 *    gemini-image, builtin edge-tts, …) render as standalone, always-visible
 *    in-flow cards with zero per-tool code (PRD 0.2.30 moved them out of the
 *    folded tool window where they were buried).
 *  - PROCESS media — mounted by ProcessRow.tsx INSIDE the expanded tool body:
 *    Playwright / computer-use screenshots are the AI's working captures, not
 *    deliverables, so they deliberately stay behind the fold (collapsed row
 *    shows an image-count badge).
 *
 * Kind dispatch is intentionally small; new kinds slot into the switch.
 */

import ToolImageAttachment from './ToolImageAttachment';
import ToolAudioAttachment from './ToolAudioAttachment';
import type { ToolAttachment } from '../../../shared/types/tool-attachment';

interface Props {
  attachments: ToolAttachment[];
}

export default function ToolAttachmentGallery({ attachments }: Props) {
  if (!attachments?.length) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {attachments.map((a, idx) => {
        const key = a.pendingId || a.refPath || `att-${idx}`;
        switch (a.kind) {
          case 'image':
            return <ToolImageAttachment key={key} attachment={a} />;
          // PRD 0.2.30 — audio renders a card-style player in the conversation flow.
          case 'audio':
            return <ToolAudioAttachment key={key} attachment={a} />;
          // PRD 0.2.15 leaves pdf/file as placeholders for a later phase.
          // Until then they render as a minimal file card so the user still
          // sees that *something* was produced.
          default:
            return (
              <div
                key={key}
                className="rounded border border-[var(--line)] bg-[var(--paper-inset)]/30 px-3 py-2 text-xs text-[var(--ink-secondary)]"
              >
                <div className="font-medium">{a.mimeType}</div>
                {a.caption ? <div className="mt-1 line-clamp-2 text-[var(--ink-muted)]">{a.caption}</div> : null}
              </div>
            );
        }
      })}
    </div>
  );
}
