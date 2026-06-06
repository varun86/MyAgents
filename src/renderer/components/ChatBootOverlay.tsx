import { Loader2 } from 'lucide-react';

/**
 * Unified "AI 启动中" boot overlay — a frosted-glass loading state shown from the
 * instant the user enters a chat (Launcher→Chat flip) until the session is ready.
 *
 * Rendered in TWO places so the whole entry is ONE continuous loading state, never
 * two separate waits on two surfaces (the bug this fixes):
 *   1. App's Suspense fallback while the lazy Chat chunk resolves (BEFORE Chat
 *      mounts) — replaces the old blank `bg-[var(--paper)]` div, which was the same
 *      colour as the Launcher and so read as "nothing happened" for the ~boot window.
 *   2. Chat's in-page startup overlay during the sidecar cold boot (AFTER mount).
 *
 * Both render identical markup, so the chunk-load → mount handoff is seamless: the
 * user sees an immediate, visible loading state on click that simply persists.
 */
export default function ChatBootOverlay() {
    return (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[var(--paper)]/80 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-3">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
                <p className="text-sm text-[var(--ink-muted)]">AI 启动中</p>
            </div>
        </div>
    );
}
