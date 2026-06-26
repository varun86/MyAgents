import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CLAUDE_TRANSCRIPT_CLEANUP_PERIOD_DAYS,
  DEFAULT_CONFIG,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  MANAGED_CODEX_PROVIDER,
  MANAGED_CODEX_REQUIRED_RUNTIME,
  PRESET_PROVIDERS,
  applyManagedCodexProviderReadiness,
  getManagedCodexProviderReadiness,
  isManagedCodexRequiredRuntimeInstalled,
  isManagedCodexSubscriptionAuthValid,
  normalizeChatQueueResponseMode,
  normalizeClaudeTranscriptCleanupPeriodDays,
  normalizeProviderOrder,
  splitProviderModelInput,
  withManagedCodexProviderCatalog,
} from './config-types';

// normalizeProviderOrder reconciles a persisted provider order against the set
// of providers that actually exist now: honor the saved order, drop stale/
// unknown ids, dedupe, then append any known providers the order didn't mention
// (newly added). Drift here scrambles or drops providers from the picker.
describe('normalizeProviderOrder', () => {
  it('honors the saved order, then appends known providers missing from it', () => {
    expect(normalizeProviderOrder(['a', 'b', 'c'], ['c', 'a'])).toEqual(['c', 'a', 'b']);
  });

  it('drops ids in the order that are no longer known', () => {
    expect(normalizeProviderOrder(['a', 'b'], ['stale', 'a'])).toEqual(['a', 'b']);
  });

  it('dedupes repeated ids in the saved order', () => {
    expect(normalizeProviderOrder(['a', 'b'], ['a', 'a', 'b', 'b'])).toEqual(['a', 'b']);
  });

  it('falls back to the known order when no saved order is given', () => {
    expect(normalizeProviderOrder(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(normalizeProviderOrder(['a', 'b'], [])).toEqual(['a', 'b']);
  });

  it('returns empty for no known providers', () => {
    expect(normalizeProviderOrder([], ['a', 'b'])).toEqual([]);
  });
});

describe('splitProviderModelInput', () => {
  it('preserves a single model id when no comma separator is present', () => {
    expect(splitProviderModelInput(' sensenova-6.7-flash-lite ')).toEqual(['sensenova-6.7-flash-lite']);
  });

  it('splits ASCII and Chinese comma-separated model ids and trims whitespace', () => {
    expect(splitProviderModelInput('m1, m2， m3')).toEqual(['m1', 'm2', 'm3']);
  });

  it('drops empty segments created by extra separators', () => {
    expect(splitProviderModelInput(' m1, ,，m2，')).toEqual(['m1', 'm2']);
  });
});

describe('normalizeClaudeTranscriptCleanupPeriodDays', () => {
  it('uses a one-year default for missing or invalid values', () => {
    expect(DEFAULT_CONFIG.claudeTranscriptCleanupPeriodDays).toBe(DEFAULT_CLAUDE_TRANSCRIPT_CLEANUP_PERIOD_DAYS);
    expect(DEFAULT_CLAUDE_TRANSCRIPT_CLEANUP_PERIOD_DAYS).toBe(365);
    expect(normalizeClaudeTranscriptCleanupPeriodDays(undefined)).toBe(365);
    expect(normalizeClaudeTranscriptCleanupPeriodDays(Number.NaN)).toBe(365);
    expect(normalizeClaudeTranscriptCleanupPeriodDays('bad')).toBe(365);
  });

  it('passes a positive integer day count to the SDK settings layer', () => {
    expect(normalizeClaudeTranscriptCleanupPeriodDays(30)).toBe(30);
    expect(normalizeClaudeTranscriptCleanupPeriodDays('180')).toBe(180);
    expect(normalizeClaudeTranscriptCleanupPeriodDays(30.9)).toBe(30);
    expect(normalizeClaudeTranscriptCleanupPeriodDays(0)).toBe(1);
    expect(normalizeClaudeTranscriptCleanupPeriodDays(-12)).toBe(1);
  });
});

describe('normalizeChatQueueResponseMode', () => {
  it('defaults to realtime and accepts only the turn override', () => {
    expect(DEFAULT_CONFIG.chatQueueResponseMode).toBe('realtime');
    expect(normalizeChatQueueResponseMode(undefined)).toBe('realtime');
    expect(normalizeChatQueueResponseMode('realtime')).toBe('realtime');
    expect(normalizeChatQueueResponseMode('turn')).toBe('turn');
    expect(normalizeChatQueueResponseMode('invalid')).toBe('realtime');
  });
});

describe('Zhipu preset models', () => {
  it('ships GLM-5.2 in both Coding Plan and API presets with official 1M window metadata', () => {
    for (const providerId of ['zhipu', 'zhipu-ai']) {
      const provider = PRESET_PROVIDERS.find(p => p.id === providerId);
      const model = provider?.models.find(m => m.model === 'glm-5.2');

      expect(model).toMatchObject({
        modelName: 'GLM 5.2',
        modelSeries: 'zhipu',
        contextLength: 1_000_000,
        maxOutputTokens: 131_072,
        inputModalities: ['text'],
      });
      expect(provider?.modelAliases).toEqual({
        opus: 'glm-5.2',
        sonnet: 'glm-5.1',
        haiku: 'glm-5.1',
      });
    }
  });
});

describe('desktop pet defaults', () => {
  it('keeps hover peek enabled for existing desktop pet behavior', () => {
    expect(DEFAULT_CONFIG.floatingBallHoverPeekEnabled).toBe(true);
  });
});

describe('CLI tool registry defaults', () => {
  it('keeps the experimental registry off by default', () => {
    expect(DEFAULT_CONFIG.cliToolRegistryEnabled).toBe(false);
  });
});

describe('Managed Codex provider readiness', () => {
  it('keeps the provider out of the catalogue while the developer gate is off', () => {
    expect(withManagedCodexProviderCatalog([MANAGED_CODEX_PROVIDER], {
      managedCodexProviderDevGate: false,
    }).some(provider => provider.id === CODEX_SUBSCRIPTION_PROVIDER_ID)).toBe(false);
  });

  it('shows the provider card behind the developer gate but keeps it unselectable until ready', () => {
    const catalog = withManagedCodexProviderCatalog([], {
      managedCodexProviderDevGate: true,
    });
    const providers = applyManagedCodexProviderReadiness(catalog, {
      managedCodexProviderDevGate: true,
      managedCodexProviderEnabled: true,
    });

    expect(catalog.map(provider => provider.id)).toEqual([CODEX_SUBSCRIPTION_PROVIDER_ID]);
    expect(providers[0].enabled).toBe(false);
    expect(getManagedCodexProviderReadiness({
      managedCodexProviderDevGate: true,
      managedCodexProviderEnabled: true,
    }).reason).toBe('runtime-not-installed');
  });

  it('requires exact runtime version, subscription auth, and user enablement', () => {
    const runtime = {
      status: 'installed' as const,
      installedVersion: MANAGED_CODEX_REQUIRED_RUNTIME.version,
      requiredVersion: MANAGED_CODEX_REQUIRED_RUNTIME.version,
    };
    const auth = {
      status: 'valid' as const,
      authMethod: 'chatgpt' as const,
    };

    expect(isManagedCodexRequiredRuntimeInstalled(runtime)).toBe(true);
    expect(isManagedCodexSubscriptionAuthValid(auth)).toBe(true);
    expect(getManagedCodexProviderReadiness({
      managedCodexProviderDevGate: true,
      managedCodexProviderEnabled: true,
      managedCodexRuntimeInstall: runtime,
      managedCodexAuth: auth,
    })).toMatchObject({
      visible: true,
      selectable: true,
      reason: 'ready',
    });
  });

  it('does not treat Codex API-key auth as subscription readiness', () => {
    expect(isManagedCodexSubscriptionAuthValid({
      status: 'valid',
      authMethod: 'api-key',
    })).toBe(false);
  });

  it('preserves explicit provider disablement even after readiness succeeds', () => {
    const providers = applyManagedCodexProviderReadiness([
      { ...MANAGED_CODEX_PROVIDER, enabled: false },
    ], {
      managedCodexProviderDevGate: true,
      managedCodexProviderEnabled: true,
      managedCodexRuntimeInstall: {
        status: 'installed',
        installedVersion: MANAGED_CODEX_REQUIRED_RUNTIME.version,
      },
      managedCodexAuth: {
        status: 'valid',
        authMethod: 'chatgpt',
      },
    });

    expect(providers[0].enabled).toBe(false);
  });
});
