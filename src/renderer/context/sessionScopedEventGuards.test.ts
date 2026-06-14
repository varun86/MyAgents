import { describe, it, expect } from 'vitest';
import { shouldAcceptSessionScopedSseSnapshot } from './sessionScopedEventGuards';

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
                isCurrentSessionPending: true,
            }),
        ).toBe(true);
    });

    it('rejects payloads for a different concrete session', () => {
        expect(
            shouldAcceptSessionScopedSseSnapshot({
                connectedSessionId: SID_B,
                currentSessionId: SID_B,
                payloadSessionId: SID_A,
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
                isCurrentSessionPending: false,
            }),
        ).toBe(true);
    });
});
