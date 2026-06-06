/**
 * Frontend helper for resolving ToolAttachment refPath to an absolute URL.
 *
 * PRD 0.2.15 §4.8 — replaces ad-hoc `readLocalFileAsBlobUrl(savedPath, ...)`
 * usage that mis-fits the new endpoint shape and bypasses attachment-aware
 * permission checks.
 *
 * Browser dev fetches `/api/attachment/tool/<sid>/<tid>/<file>` through the
 * Vite proxy. Tauri uses `myagents://tool-attachment/...` so WebKit/WebView2
 * stay inside the configured `img-src` protocol allow-list.
 */

import { useEffect, useState } from 'react';
import { isTauriEnvironment } from '@/utils/browserMock';
import type { ToolAttachment } from '../../shared/types/tool-attachment';

const TOOL_ATTACHMENT_API_PREFIX = '/api/attachment/tool/';
const TOOL_ATTACHMENT_PROTOCOL_PREFIX = 'myagents://tool-attachment/';

export function resolveTauriToolAttachmentUrl(refPath: string): string | null {
  if (!refPath.startsWith(TOOL_ATTACHMENT_API_PREFIX)) return null;
  return `${TOOL_ATTACHMENT_PROTOCOL_PREFIX}${refPath.slice(TOOL_ATTACHMENT_API_PREFIX.length)}`;
}

/**
 * Resolve a refPath to a fetchable URL for the current session.
 *
 * - Tauri: myagents://tool-attachment/<sid>/<tid>/<file>
 * - Browser dev: relative refPath (vite proxy handles it)
 *
 * Returns null while resolving (caller shows a loading skeleton).
 */
export async function resolveToolAttachmentUrl(
  attachment: ToolAttachment,
  _sessionId: string | null,
): Promise<string | null> {
  // Placeholder still pending — caller renders skeleton.
  if (attachment.pendingId && !attachment.refPath) return null;
  // Error sentinel.
  if (attachment.refPath.startsWith('error://')) return attachment.refPath;

  if (!isTauriEnvironment()) {
    // Browser dev: vite proxies /api/* to the sidecar by default; refPath is
    // already in /api/attachment/tool/... form.
    return attachment.refPath;
  }

  const protocolUrl = resolveTauriToolAttachmentUrl(attachment.refPath);
  if (protocolUrl) return protocolUrl;

  return null;
}

/**
 * React hook variant: resolves an attachment URL for use in <img src=…>.
 * Returns:
 *   - { state: 'loading' } while port lookup is in flight
 *   - { state: 'ready', url } when resolved
 *   - { state: 'pending' } when the attachment is a placeholder (async save in flight)
 *   - { state: 'error', reason } when refPath is an error sentinel
 */
export type AttachmentUrlState =
  | { state: 'loading' }
  | { state: 'ready'; url: string }
  | { state: 'pending' }
  | { state: 'error'; reason: string };

function computeSyncState(attachment: ToolAttachment): AttachmentUrlState | null {
  if (attachment.pendingId && !attachment.refPath) return { state: 'pending' };
  if (attachment.refPath.startsWith('error://')) {
    return { state: 'error', reason: attachment.refPath.slice('error://'.length) };
  }
  return null;
}

interface ResolverEntry {
  refPath: string;
  sessionId: string | null;
  url: string | null;
}

export function useAttachmentUrl(
  attachment: ToolAttachment,
  sessionId: string | null,
): AttachmentUrlState {
  const syncState = computeSyncState(attachment);

  // Derived-state-from-props pattern (React docs): reset resolvedUrl during
  // render when the input attachment changes — avoids the
  // react-hooks/set-state-in-effect lint hit for "manually re-syncing state".
  const [entry, setEntry] = useState<ResolverEntry>({ refPath: attachment.refPath, sessionId, url: null });
  if (entry.refPath !== attachment.refPath || entry.sessionId !== sessionId) {
    setEntry({ refPath: attachment.refPath, sessionId, url: null });
  }

  useEffect(() => {
    if (syncState !== null) return;
    let cancelled = false;
    void resolveToolAttachmentUrl(attachment, sessionId).then(url => {
      if (cancelled) return;
      setEntry(prev =>
        prev.refPath === attachment.refPath && prev.sessionId === sessionId
          ? { ...prev, url }
          : prev,
      );
    });
    return () => { cancelled = true; };
  }, [attachment, sessionId, syncState]);

  if (syncState !== null) return syncState;
  if (entry.refPath !== attachment.refPath || entry.url === null) {
    return { state: 'loading' };
  }
  return { state: 'ready', url: entry.url };
}
