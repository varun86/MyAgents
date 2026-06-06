import { Loader2 } from 'lucide-react';

/**
 * Unified "AI 启动中" boot overlay — the cheap, paints-instantly loading state
 * shown the moment a chat is entered (Launcher→Chat), so the click gives
 * immediate visible feedback while the heavy work happens behind it.
 *
 * Rendered in TWO phases so it's ONE continuous loading state, never two waits:
 *   1. App's deferred-mount placeholder for a flipping chat tab — BEFORE the heavy
 *      TabProvider+Chat subtree mounts. This is the load-bearing one: paint
 *      profiling showed the heavy synchronous Chat mount + its effects + the
 *      sidecar-boot cascade starve the browser's first paint for ~800ms, so we
 *      paint THIS cheap overlay first (one frame), then mount the heavy subtree.
 *   2. Chat's in-page startup overlay during the sidecar cold boot, AFTER mount.
 *
 * Identical markup in both phases → the placeholder → real-mount handoff is
 * visually seamless: the user sees an immediate loading state that just persists
 * until the session is ready.
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
