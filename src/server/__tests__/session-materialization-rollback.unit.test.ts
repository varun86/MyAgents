import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../SessionStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../SessionStore')>();
  return {
    ...actual,
    deleteSession: vi.fn(async () => true),
    getSessionMetadata: vi.fn(),
    updateSessionMetadata: vi.fn(),
  };
});

import { deleteSession, getSessionMetadata, updateSessionMetadata } from '../SessionStore';
import {
  resetSessionMaterializationState,
  setPendingDesktopMaterialization,
} from '../builtin-session/materialization';
import { initializeAgent, materializePendingDesktopSession } from '../agent-session';

const mockedDeleteSession = vi.mocked(deleteSession);
const mockedGetSessionMetadata = vi.mocked(getSessionMetadata);
const mockedUpdateSessionMetadata = vi.mocked(updateSessionMetadata);

describe('materializePendingDesktopSession rollback guard', () => {
  beforeEach(() => {
    resetSessionMaterializationState();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetSessionMaterializationState();
  });

  it('refuses caller-supplied rollback ids when no pending materialization exists', async () => {
    const result = await materializePendingDesktopSession({
      phase: 'rollback',
      preparedSessionId: 'unrelated-session',
    });

    expect(result).toMatchObject({
      success: false,
      status: 409,
    });
    expect(mockedDeleteSession).not.toHaveBeenCalled();
  });

  it('refuses to delete a target row not owned by the pending transaction', async () => {
    setPendingDesktopMaterialization({
      priorSessionId: 'pending-source',
      targetSessionId: 'prepared-target',
      reusingLiveSdkSession: false,
      snapshotKind: 'owned',
    });
    mockedGetSessionMetadata.mockReturnValue({
      id: 'prepared-target',
      agentDir: '/tmp/workspace',
      title: 'Prepared',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
      materializationState: 'prepared',
      materializationSourceSessionId: 'different-source',
    });

    const result = await materializePendingDesktopSession({
      phase: 'rollback',
      preparedSessionId: 'prepared-target',
    });

    expect(result).toMatchObject({
      success: false,
      status: 409,
    });
    expect(mockedDeleteSession).not.toHaveBeenCalled();
  });

  it('deletes only the prepared row owned by the pending transaction', async () => {
    setPendingDesktopMaterialization({
      priorSessionId: 'pending-source',
      targetSessionId: 'prepared-target',
      reusingLiveSdkSession: false,
      snapshotKind: 'owned',
    });
    mockedGetSessionMetadata.mockReturnValue({
      id: 'prepared-target',
      agentDir: '/tmp/workspace',
      title: 'Prepared',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
      materializationState: 'prepared',
      materializationSourceSessionId: 'pending-source',
    });

    const result = await materializePendingDesktopSession({
      phase: 'rollback',
      preparedSessionId: 'prepared-target',
    });

    expect(result.success).toBe(true);
    expect(mockedDeleteSession).toHaveBeenCalledWith('prepared-target', expect.any(Function));
    const guard = mockedDeleteSession.mock.calls[0][1] as (current: {
      materializationState?: 'prepared';
      materializationSourceSessionId?: string;
    }) => boolean;
    expect(guard({
      materializationState: 'prepared',
      materializationSourceSessionId: 'pending-source',
    })).toBe(true);
    expect(guard({
      materializationState: 'prepared',
      materializationSourceSessionId: 'different-source',
    })).toBe(false);
  });

  it('refuses to patch a prepared row not owned by the pending transaction', async () => {
    await initializeAgent('/tmp/workspace', null, 'pending-source', { preWarmDisabled: true });
    setPendingDesktopMaterialization({
      priorSessionId: 'pending-source',
      targetSessionId: 'prepared-target',
      reusingLiveSdkSession: false,
      snapshotKind: 'owned',
    });
    mockedGetSessionMetadata.mockReturnValue({
      id: 'prepared-target',
      agentDir: '/tmp/workspace',
      title: 'Prepared',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
      materializationState: 'prepared',
      materializationSourceSessionId: 'different-source',
    });

    const result = await materializePendingDesktopSession({
      phase: 'prepare',
      snapshotPatch: { model: 'deepseek-v4-pro' },
    });

    expect(result).toMatchObject({
      success: false,
      status: 409,
    });
    expect(mockedUpdateSessionMetadata).not.toHaveBeenCalled();
  });

  it('patches an existing prepared row through an in-lock ownership guard', async () => {
    await initializeAgent('/tmp/workspace', null, 'pending-source', { preWarmDisabled: true });
    setPendingDesktopMaterialization({
      priorSessionId: 'pending-source',
      targetSessionId: 'prepared-target',
      reusingLiveSdkSession: false,
      snapshotKind: 'owned',
    });
    const preparedMeta = {
      id: 'prepared-target',
      agentDir: '/tmp/workspace',
      title: 'Prepared',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
      materializationState: 'prepared' as const,
      materializationSourceSessionId: 'pending-source',
    };
    mockedGetSessionMetadata.mockReturnValue(preparedMeta);
    mockedUpdateSessionMetadata.mockResolvedValue({
      ...preparedMeta,
      model: 'deepseek-v4-pro',
      configSnapshotAt: '2026-06-23T00:00:00.000Z',
    });

    const result = await materializePendingDesktopSession({
      phase: 'prepare',
      snapshotPatch: { model: 'deepseek-v4-pro' },
    });

    expect(result.success).toBe(true);
    expect(mockedUpdateSessionMetadata).toHaveBeenCalledWith(
      'prepared-target',
      expect.objectContaining({ model: 'deepseek-v4-pro' }),
      expect.any(Function),
    );
    const guard = mockedUpdateSessionMetadata.mock.calls[0][2] as (current: {
      materializationState?: 'prepared';
      materializationSourceSessionId?: string;
    }) => boolean;
    expect(guard({
      materializationState: 'prepared',
      materializationSourceSessionId: 'pending-source',
    })).toBe(true);
    expect(guard({
      materializationState: 'prepared',
      materializationSourceSessionId: 'different-source',
    })).toBe(false);
  });
});
