/**
 * Pure guard for session-scoped SSE snapshots.
 *
 * A Tab can switch from session A to a pending session B while A's SSE
 * connection is still draining cached/live events. Snapshot-style events must
 * only update state when they came through the SSE connection currently bound
 * to this tab's session. Payload session ids add a second check once the
 * frontend has a concrete non-pending session id.
 */
export function shouldAcceptSessionScopedSseSnapshot(p: {
    connectedSessionId: string | null;
    currentSessionId: string | null;
    payloadSessionId?: string | null;
    isCurrentSessionPending: boolean;
}): boolean {
    if (p.connectedSessionId !== p.currentSessionId) {
        return false;
    }

    if (
        p.payloadSessionId &&
        p.currentSessionId &&
        !p.isCurrentSessionPending &&
        p.payloadSessionId !== p.currentSessionId
    ) {
        return false;
    }

    return true;
}
