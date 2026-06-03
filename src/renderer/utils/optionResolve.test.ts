import { describe, expect, it } from 'vitest';

import {
  isExistingSessionSwitch,
  isPinnedProviderUnavailable,
  isResetSessionBirth,
  resolveBuiltinPermissionMode,
  resolveLauncherProvider,
  shouldDegradedLoad,
  shouldResetModelOnProviderChange,
} from './optionResolve';

describe('isPinnedProviderUnavailable (#300)', () => {
  const base = {
    isOwnedSession: true,
    isExternalRuntime: false,
    selectedProviderId: 'skywork-ai',
    resolvedProviderId: 'deepseek', // resolveProvider fell back to first-available
    providersLoaded: true,
  };

  it('flags the bug: owned session pinned skywork-ai but resolver fell back to deepseek', () => {
    expect(isPinnedProviderUnavailable(base)).toBe(true);
  });

  it('is false when the resolved provider matches the pinned one (available)', () => {
    expect(isPinnedProviderUnavailable({ ...base, resolvedProviderId: 'skywork-ai' })).toBe(false);
  });

  it('does NOT false-positive while config is still loading (no providers yet)', () => {
    // providers empty + nothing resolved would otherwise look like a fallback.
    expect(
      isPinnedProviderUnavailable({ ...base, providersLoaded: false, resolvedProviderId: undefined }),
    ).toBe(false);
  });

  it('does not apply to fresh/unlocked tabs — they keep the first-available fallback', () => {
    expect(isPinnedProviderUnavailable({ ...base, isOwnedSession: false })).toBe(false);
  });

  it('does not apply to external runtimes (no providerId to pin)', () => {
    expect(isPinnedProviderUnavailable({ ...base, isExternalRuntime: true })).toBe(false);
  });

  it('is false when the session pinned no provider', () => {
    expect(
      isPinnedProviderUnavailable({ ...base, selectedProviderId: undefined, resolvedProviderId: 'deepseek' }),
    ).toBe(false);
  });

  it('treats "nothing resolved" (no provider available at all) as unavailable for a pinned owned session', () => {
    expect(isPinnedProviderUnavailable({ ...base, resolvedProviderId: undefined })).toBe(true);
  });
});

describe('shouldResetModelOnProviderChange (#300)', () => {
  it('does NOT reset a still-valid pinned model (the availability-flip regression)', () => {
    // unavailable→available flip re-resolves currentProvider to the pinned skywork
    // provider; skywork-ai/skyclaw-v1 IS in its list → must not be stomped.
    expect(
      shouldResetModelOnProviderChange({
        providerType: 'thirdParty',
        providerModels: ['skywork-ai/skyclaw-v1', 'skywork-ai/skyclaw-mini'],
        selectedModel: 'skywork-ai/skyclaw-v1',
      }),
    ).toBe(false);
  });

  it('resets when the selected model is genuinely absent from the provider', () => {
    expect(
      shouldResetModelOnProviderChange({
        providerType: 'thirdParty',
        providerModels: ['deepseek-v4-pro', 'deepseek-v4-flash'],
        selectedModel: 'skywork-ai/skyclaw-v1', // not a deepseek model
      }),
    ).toBe(true);
  });

  it('never resets for subscription providers (cannot validate)', () => {
    expect(
      shouldResetModelOnProviderChange({
        providerType: 'subscription',
        providerModels: undefined,
        selectedModel: 'claude-sonnet-4-6',
      }),
    ).toBe(false);
  });

  it('never resets when the provider has no known model list', () => {
    expect(
      shouldResetModelOnProviderChange({ providerType: 'thirdParty', providerModels: [], selectedModel: 'x' }),
    ).toBe(false);
    expect(
      shouldResetModelOnProviderChange({ providerType: 'thirdParty', providerModels: undefined, selectedModel: 'x' }),
    ).toBe(false);
  });

  it('does not reset when no model is selected yet', () => {
    expect(
      shouldResetModelOnProviderChange({
        providerType: 'thirdParty',
        providerModels: ['a', 'b'],
        selectedModel: undefined,
      }),
    ).toBe(false);
  });
});

describe('resolveBuiltinPermissionMode (#244)', () => {
  it('falls back to the agent config before the project sync runs (the bug)', () => {
    // Fresh tab: state still holds the mount-time 'auto' default, config has
    // just loaded with fullAgency. Must NOT ship 'auto'.
    expect(
      resolveBuiltinPermissionMode({
        projectSynced: false,
        statePermissionMode: 'auto',
        agentPermissionMode: 'fullAgency',
        projectPermissionMode: 'plan',
        defaultPermissionMode: 'auto',
      }),
    ).toBe('fullAgency');
  });

  it('prefers project, then global default, when agent has none', () => {
    expect(
      resolveBuiltinPermissionMode({
        projectSynced: false,
        statePermissionMode: 'auto',
        agentPermissionMode: undefined,
        projectPermissionMode: 'plan',
      }),
    ).toBe('plan');
    expect(
      resolveBuiltinPermissionMode({
        projectSynced: false,
        statePermissionMode: 'auto',
        defaultPermissionMode: 'fullAgency',
      }),
    ).toBe('fullAgency');
  });

  it('trusts state once synced (covers user toggle + session snapshot)', () => {
    expect(
      resolveBuiltinPermissionMode({
        projectSynced: true,
        statePermissionMode: 'plan',
        agentPermissionMode: 'fullAgency',
      }),
    ).toBe('plan');
  });

  it('falls back to state when nothing is configured', () => {
    expect(
      resolveBuiltinPermissionMode({ projectSynced: false, statePermissionMode: 'auto' }),
    ).toBe('auto');
  });
});

describe('resolveLauncherProvider (#234)', () => {
  it('uses the agent default when it diverges from the stale cache (the bug)', () => {
    // User changed Agent default MiniMax → DeepSeek; launcherLastUsed still
    // remembers MiniMax. Agent default must win, and the stale MiniMax model
    // must be dropped.
    const r = resolveLauncherProvider({
      lastUsedProviderId: 'minimax',
      lastUsedModel: 'MiniMax-M2.7',
      agentProviderId: 'deepseek',
      agentModel: 'deepseek-v4-flash',
    });
    expect(r.providerId).toBe('deepseek');
    expect(r.model).toBe('deepseek-v4-flash');
  });

  it('keeps the cached provider+model when consistent with the agent', () => {
    const r = resolveLauncherProvider({
      lastUsedProviderId: 'deepseek',
      lastUsedModel: 'deepseek-v4-pro',
      agentProviderId: 'deepseek',
      agentModel: 'deepseek-v4-flash',
    });
    expect(r.providerId).toBe('deepseek');
    // user's explicit launcher model choice survives within the same provider
    expect(r.model).toBe('deepseek-v4-pro');
  });

  it('honors the cache when the agent has no explicit provider', () => {
    const r = resolveLauncherProvider({
      lastUsedProviderId: 'minimax',
      lastUsedModel: 'MiniMax-M2.7',
      agentProviderId: undefined,
      workspaceProviderId: 'deepseek',
    });
    expect(r.providerId).toBe('minimax');
    expect(r.model).toBe('MiniMax-M2.7');
  });

  it('falls back agent → workspace → cache → global when no cache match', () => {
    expect(
      resolveLauncherProvider({ agentProviderId: 'openai' }).providerId,
    ).toBe('openai');
    expect(
      resolveLauncherProvider({ workspaceProviderId: 'deepseek' }).providerId,
    ).toBe('deepseek');
    expect(
      resolveLauncherProvider({ defaultProviderId: 'anthropic' }).providerId,
    ).toBe('anthropic');
  });
});

describe('shouldDegradedLoad (#235)', () => {
  const base = {
    mounted: true,
    currentSessionId: 's1',
    target: 's1',
    connectedSseSessionId: null as string | null,
    alreadyLoaded: false,
    prevSessionId: 's0' as string | null | undefined,
    sessionActiveOrStreaming: false,
  };

  it('fires when SSE never attached and the session is unchanged (the bug)', () => {
    expect(shouldDegradedLoad(base)).toBe(true);
  });

  it('does not fire while the session is mid-turn (active/streaming)', () => {
    expect(shouldDegradedLoad({ ...base, sessionActiveOrStreaming: true })).toBe(false);
  });

  it('can fire during an explicit history switch even if the previous session looked active', () => {
    expect(shouldDegradedLoad({
      ...base,
      sessionActiveOrStreaming: true,
      allowWhileActive: true,
    })).toBe(true);
  });

  it('does not fire after unmount', () => {
    expect(shouldDegradedLoad({ ...base, mounted: false })).toBe(false);
  });

  it('does not fire if the user switched sessions while waiting', () => {
    expect(shouldDegradedLoad({ ...base, currentSessionId: 's2' })).toBe(false);
  });

  it('does not fire if SSE attached after all', () => {
    expect(shouldDegradedLoad({ ...base, connectedSseSessionId: 's1' })).toBe(false);
  });

  it('does not fire if the session was already loaded', () => {
    expect(shouldDegradedLoad({ ...base, alreadyLoaded: true, prevSessionId: 's1' })).toBe(false);
  });

  it('still fires if alreadyLoaded but for a different prior session', () => {
    expect(shouldDegradedLoad({ ...base, alreadyLoaded: true, prevSessionId: 's0' })).toBe(true);
  });
});

describe('session-load transition classification (#255)', () => {
  it('recognizes only the exact backend-minted reset session as reset birth', () => {
    expect(isResetSessionBirth({
      resetBirthSessionId: 'new-session',
      sessionId: 'new-session',
    })).toBe(true);

    // Regression: a stale new-session flag must not make a history click look
    // like resetSession's own id upgrade.
    expect(isResetSessionBirth({
      resetBirthSessionId: 'new-session',
      sessionId: 'history-session',
    })).toBe(false);
  });

  it('preserves reset birth after sendMessage clears the stale-event guard', () => {
    const resetBirth = isResetSessionBirth({
      resetBirthSessionId: 'new-session',
      sessionId: 'new-session',
    });
    expect(resetBirth).toBe(true);
    expect(isExistingSessionSwitch({
      sessionChanged: true,
      wasPendingSession: false,
      isPendingSession: false,
      isResetSessionBirth: resetBirth,
    })).toBe(false);
  });

  it('treats persisted real-to-real transitions as existing-session switches', () => {
    expect(isExistingSessionSwitch({
      sessionChanged: true,
      wasPendingSession: false,
      isPendingSession: false,
      isResetSessionBirth: false,
    })).toBe(true);
  });

  it('does not treat pending upgrades or reset births as history switches', () => {
    expect(isExistingSessionSwitch({
      sessionChanged: true,
      wasPendingSession: true,
      isPendingSession: false,
      isResetSessionBirth: false,
    })).toBe(false);

    expect(isExistingSessionSwitch({
      sessionChanged: true,
      wasPendingSession: false,
      isPendingSession: false,
      isResetSessionBirth: true,
    })).toBe(false);
  });
});
