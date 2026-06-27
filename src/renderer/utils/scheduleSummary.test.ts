import { describe, expect, it } from 'vitest';

import type { Task } from '../../shared/types/task';
import { summarizeSchedule } from './scheduleSummary';

function task(partial: Partial<Task>): Task {
  return {
    id: 'task-1',
    name: 'Demo',
    executor: 'agent',
    workspaceId: 'workspace-1',
    executionMode: 'once',
    dispatchOrigin: 'direct',
    status: 'todo',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    statusHistory: [],
    ...partial,
  } as Task;
}

describe('summarizeSchedule i18n', () => {
  it('formats interval schedules in English when locale is explicit', async () => {
    await expect(
      summarizeSchedule(task({ executionMode: 'recurring', intervalMinutes: 120 }), null, 'en-US'),
    ).resolves.toMatchObject({
      mode: 'recurring',
      title: 'Every 2 hours',
    });
  });

  it('keeps the default Chinese copy for existing callers', async () => {
    await expect(
      summarizeSchedule(task({ executionMode: 'recurring', intervalMinutes: 120 })),
    ).resolves.toMatchObject({
      mode: 'recurring',
      title: '每 2 小时',
    });
  });
});
