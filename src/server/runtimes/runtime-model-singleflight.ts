import type { RuntimeSource, RuntimeType } from '../../shared/types/runtime';
import { elapsedMs, emitPerfTrace, nowMs } from '../utils/perf-trace';

const inFlightModelQueries = new Map<string, Promise<unknown[]>>();

function modelQueryKey(runtimeType: RuntimeType, runtimeSource?: RuntimeSource): string {
  return `${runtimeType}:${runtimeSource ?? 'system-cli'}`;
}

export async function queryRuntimeModelsSingleFlight(
  runtimeType: RuntimeType,
  queryer: () => Promise<unknown[]>,
  runtimeSource?: RuntimeSource,
): Promise<unknown[]> {
  if (runtimeType === 'builtin') return [];

  const key = modelQueryKey(runtimeType, runtimeSource);
  const existing = inFlightModelQueries.get(key);
  if (existing) {
    emitPerfTrace({
      trace: 'runtime',
      phase: 'model_list_join',
      runtime: runtimeType,
      detail: { source: runtimeSource ?? 'system-cli' },
      status: 'ok',
    });
    return existing;
  }

  const start = nowMs();
  emitPerfTrace({
    trace: 'runtime',
    phase: 'model_list_start',
    runtime: runtimeType,
    detail: { source: runtimeSource ?? 'system-cli' },
  });

  const promise = (async () => {
    try {
      const models = await queryer();
      emitPerfTrace({
        trace: 'runtime',
        phase: 'model_list_done',
        runtime: runtimeType,
        detail: { source: runtimeSource ?? 'system-cli' },
        durationMs: elapsedMs(start),
        count: models.length,
        status: 'ok',
      });
      return models;
    } catch (error) {
      emitPerfTrace({
        trace: 'runtime',
        phase: 'model_list_done',
        runtime: runtimeType,
        detail: { source: runtimeSource ?? 'system-cli' },
        durationMs: elapsedMs(start),
        status: 'error',
      });
      throw error;
    } finally {
      inFlightModelQueries.delete(key);
    }
  })();

  inFlightModelQueries.set(key, promise);
  return promise;
}

export function __resetRuntimeModelSingleFlightForTest(): void {
  inFlightModelQueries.clear();
}
