/**
 * useTaskCenterData — thin subscriber over the single app-level task-center
 * store (P2). All ownership (state, fetch lifecycle, listeners, tombstones,
 * derived maps) lives in `taskCenterStore.ts`; this hook just subscribes via
 * `useSyncExternalStore`, so a new Launcher mount reads already-warm data
 * (instant, no spinner, no re-fetch) instead of owning a per-instance fetch.
 *
 * Back-compat: the types/const that other files import from this module
 * (`SessionTag`, `TaskCenterData`, `TASK_CENTER_FRESHNESS_TTL_MS`) are
 * re-exported from the store, so no consumer import paths change.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';

import {
    subscribe,
    getSnapshot,
    refresh,
    TASK_CENTER_FRESHNESS_TTL_MS,
    type TaskCenterData,
} from '@/hooks/taskCenterStore';

export type {
    SessionTag,
    TaskCenterData,
    TaskCenterRefreshScope,
    TaskCenterRefreshOptions,
    TaskCenterActions,
} from '@/hooks/taskCenterStore';
export { TASK_CENTER_FRESHNESS_TTL_MS } from '@/hooks/taskCenterStore';

interface UseTaskCenterDataOptions {
    isActive?: boolean;
}

export function useTaskCenterData({ isActive }: UseTaskCenterDataOptions): TaskCenterData {
    const data = useSyncExternalStore(subscribe, getSnapshot);

    // On an inactive → active transition, kick a throttled silent revalidate so
    // the surface the user just focused is fresh. The store also self-refreshes
    // on Tauri events + every 60s, so this is a top-up, not the primary path.
    // `refresh`/TTL are stable module bindings → deps are just [isActive].
    const prevActiveRef = useRef(isActive);
    useEffect(() => {
        const wasInactive = !prevActiveRef.current;
        prevActiveRef.current = isActive;
        if (wasInactive && isActive) {
            refresh('all', { silent: true, minIntervalMs: TASK_CENTER_FRESHNESS_TTL_MS });
        }
    }, [isActive]);

    return data;
}
