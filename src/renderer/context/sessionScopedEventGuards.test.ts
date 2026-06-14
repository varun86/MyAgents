import { describe, it, expect } from 'vitest';
import {
    shouldAcceptSessionScopedSseSnapshot,
    shouldPreserveSnapshotOnPendingBirthPropSync,
} from './sessionScopedEventGuards';

const SID_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const SID_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const PENDING_B = 'pending-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

describe('shouldAcceptSessionScopedSseSnapshot', () => {
    it('rejects a stale A snapshot while the tab is switching to pending B', () => {
        expect(
            shouldAcceptSessionScopedSseSnapshot({
                connectedSessionId: SID_A,
                currentSessionId: PENDING_B,
                payloadSessionId: SID_A,
                isConnectedSessionPending: false,
                isCurrentSessionPending: true,
            }),
        ).toBe(false);
    });

    it('accepts a pending-session snapshot from the currently attached pending connection', () => {
        expect(
            shouldAcceptSessionScopedSseSnapshot({
                connectedSessionId: PENDING_B,
                currentSessionId: PENDING_B,
                payloadSessionId: SID_B,
                isConnectedSessionPending: true,
                isCurrentSessionPending: true,
            }),
        ).toBe(true);
    });

    it('accepts a concrete snapshot during pending-session id upgrade', () => {
        expect(
            shouldAcceptSessionScopedSseSnapshot({
                connectedSessionId: PENDING_B,
                currentSessionId: SID_B,
                payloadSessionId: SID_B,
                isConnectedSessionPending: true,
                isCurrentSessionPending: false,
            }),
        ).toBe(true);
    });

    it('rejects a pending-connection upgrade snapshot without matching payload session id', () => {
        expect(
            shouldAcceptSessionScopedSseSnapshot({
                connectedSessionId: PENDING_B,
                currentSessionId: SID_B,
                payloadSessionId: SID_A,
                isConnectedSessionPending: true,
                isCurrentSessionPending: false,
            }),
        ).toBe(false);
    });

    it('rejects payloads for a different concrete session', () => {
        expect(
            shouldAcceptSessionScopedSseSnapshot({
                connectedSessionId: SID_B,
                currentSessionId: SID_B,
                payloadSessionId: SID_A,
                isConnectedSessionPending: false,
                isCurrentSessionPending: false,
            }),
        ).toBe(false);
    });

    it('accepts matching concrete session snapshots', () => {
        expect(
            shouldAcceptSessionScopedSseSnapshot({
                connectedSessionId: SID_B,
                currentSessionId: SID_B,
                payloadSessionId: SID_B,
                isConnectedSessionPending: false,
                isCurrentSessionPending: false,
            }),
        ).toBe(true);
    });
});

describe('shouldPreserveSnapshotOnPendingBirthPropSync', () => {
    it('preserves snapshots when parent prop catches up to an internally adopted birth session', () => {
        expect(
            shouldPreserveSnapshotOnPendingBirthPropSync({
                previousSessionId: PENDING_B,
                nextSessionId: SID_B,
                currentSessionIdBeforeSync: SID_B,
                wasPreviousSessionPending: true,
                isNextSessionPending: false,
            }),
        ).toBe(true);
    });

    it('clears snapshots when an unused pending tab switches to an existing session', () => {
        expect(
            shouldPreserveSnapshotOnPendingBirthPropSync({
                previousSessionId: PENDING_B,
                nextSessionId: SID_B,
                currentSessionIdBeforeSync: PENDING_B,
                wasPreviousSessionPending: true,
                isNextSessionPending: false,
            }),
        ).toBe(false);
    });

    it('clears snapshots on real-to-real session switches', () => {
        expect(
            shouldPreserveSnapshotOnPendingBirthPropSync({
                previousSessionId: SID_A,
                nextSessionId: SID_B,
                currentSessionIdBeforeSync: SID_B,
                wasPreviousSessionPending: false,
                isNextSessionPending: false,
            }),
        ).toBe(false);
    });
});
