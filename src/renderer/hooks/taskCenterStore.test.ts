import { describe, expect, it } from 'vitest';

import {
    filterTombstoned,
    sortSessionsByLastActive,
    computeCronBotInfoMap,
    computeSessionTagsMap,
    getSnapshot,
    __resetTaskCenterStoreForTest,
} from './taskCenterStore';
import type { SessionMetadata } from '@/api/sessionClient';
import type { CronTask } from '@/types/cronTask';
import type { AgentConfig } from '../../shared/types/agent';
import type { AgentStatusMap } from '@/hooks/useAgentStatuses';

const sess = (id: string, lastActiveAt: string): SessionMetadata =>
    ({ id, lastActiveAt } as unknown as SessionMetadata);

describe('filterTombstoned', () => {
    it('returns the same array reference when there are no tombstones', () => {
        const data = [sess('a', 'x')];
        expect(filterTombstoned(data, new Set())).toBe(data);
    });
    it('drops tombstoned ids', () => {
        const data = [sess('a', 'x'), sess('b', 'y')];
        expect(filterTombstoned(data, new Set(['a'])).map((s) => s.id)).toEqual(['b']);
    });
});

describe('sortSessionsByLastActive', () => {
    it('sorts desc by lastActiveAt without mutating the input', () => {
        const data = [sess('old', '2020-01-01T00:00:00Z'), sess('new', '2026-01-01T00:00:00Z')];
        expect(sortSessionsByLastActive(data).map((s) => s.id)).toEqual(['new', 'old']);
        expect(data.map((s) => s.id)).toEqual(['old', 'new']); // input untouched
    });
});

describe('computeCronBotInfoMap', () => {
    it('maps channel id → {name, platform}, falling back to agent name', () => {
        const agents = [{
            name: 'Agent A',
            channels: [{ id: 'c1', name: '', type: 'telegram' }, { id: 'c2', name: 'Named', type: 'feishu' }],
        }] as unknown as AgentConfig[];
        const m = computeCronBotInfoMap(agents);
        expect(m.get('c1')).toEqual({ name: 'Agent A', platform: 'telegram' });
        expect(m.get('c2')).toEqual({ name: 'Named', platform: 'feishu' });
    });
});

describe('computeSessionTagsMap', () => {
    const noStatuses = {} as AgentStatusMap;
    it('running scheduled cron → cron tag; one-shot (at) → background tag; idle → no tag', () => {
        const sessions = [sess('s-cron', 'x'), sess('s-at', 'y'), sess('s-none', 'z')];
        const crons = [
            { status: 'running', sessionId: 's-cron', schedule: { kind: 'every' } },
            { status: 'running', sessionId: 's-at', schedule: { kind: 'at' } },
            { status: 'idle', sessionId: 's-none', schedule: { kind: 'every' } },
        ] as unknown as CronTask[];
        const m = computeSessionTagsMap(sessions, crons, [], noStatuses);
        expect(m.get('s-cron')).toEqual([{ type: 'cron' }]);
        expect(m.get('s-at')).toEqual([{ type: 'background' }]);
        expect(m.has('s-none')).toBe(false);
    });
    it('tags explicit background session ids', () => {
        const m = computeSessionTagsMap([sess('bg', 'x')], [], ['bg'], noStatuses);
        expect(m.get('bg')).toEqual([{ type: 'background' }]);
    });
    it('prefers internalSessionId over sessionId for cron mapping', () => {
        const crons = [{ status: 'running', sessionId: 'outer', internalSessionId: 'internal', schedule: { kind: 'every' } }] as unknown as CronTask[];
        const m = computeSessionTagsMap([sess('internal', 'x')], crons, [], noStatuses);
        expect(m.get('internal')).toEqual([{ type: 'cron' }]);
    });
});

describe('store snapshot', () => {
    it('getSnapshot returns a stable reference (required by useSyncExternalStore)', () => {
        __resetTaskCenterStoreForTest();
        const a = getSnapshot();
        const b = getSnapshot();
        expect(a).toBe(b);
        expect(a.isLoading).toBe(true);
        expect(a.sessions).toEqual([]);
        expect(a.sessionTagsMap.size).toBe(0);
    });
});
