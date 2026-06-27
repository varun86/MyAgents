import { describe, expect, it } from 'vitest';

import { MANAGED_CODEX_PROVIDER, type Provider } from '@/config/types';
import {
  projectCronExecutionOverrides,
  resolveCronProviderEnvForExecution,
  resolveCronProviderIntentForExecution,
} from './cronExecutionProjection';

function apiProvider(id: string): Pick<Provider, 'id' | 'execution'> {
  return { id };
}

describe('cron execution projection', () => {
  it('projects Codex subscription provider to managed runtime execution fields', () => {
    expect(projectCronExecutionOverrides({
      providers: [MANAGED_CODEX_PROVIDER],
      runtime: 'builtin',
      providerId: 'codex-sub',
      model: 'gpt-5.5-codex',
      runtimeConfig: { envPolicy: { proxy: 'terminal' } },
    })).toEqual({
      runtime: 'codex',
      providerId: undefined,
      model: undefined,
      providerEnv: undefined,
      providerIntent: undefined,
      runtimeConfig: {
        source: 'managed-provider',
        model: 'gpt-5.5-codex',
        envPolicy: { proxy: 'terminal' },
      },
    });
  });

  it('keeps ordinary provider cron tasks on the live-resolve provider path', () => {
    expect(projectCronExecutionOverrides({
      providers: [apiProvider('openrouter')],
      runtime: 'builtin',
      providerId: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      providerEnv: { apiKey: 'redacted' },
    })).toEqual({
      runtime: 'builtin',
      providerId: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      providerEnv: undefined,
      providerIntent: undefined,
      runtimeConfig: undefined,
    });
  });

  it('does not mark external runtime cron tasks as subscription fallback', () => {
    expect(resolveCronProviderIntentForExecution({
      runtime: 'codex',
      providerId: undefined,
      providerEnv: undefined,
    })).toBeUndefined();
  });

  it('clears provider env snapshots for external runtime cron execution', () => {
    const providerEnv = { providerId: 'openrouter', apiKey: 'redacted' };

    expect(resolveCronProviderEnvForExecution({
      runtime: 'codex',
      providerId: undefined,
      providerEnv,
    })).toBeUndefined();
    expect(projectCronExecutionOverrides({
      providers: [apiProvider('openrouter')],
      runtime: 'codex',
      providerId: undefined,
      model: 'gpt-5.5',
      providerEnv,
    })).toEqual({
      runtime: 'codex',
      providerId: undefined,
      model: 'gpt-5.5',
      providerEnv: undefined,
      providerIntent: undefined,
      runtimeConfig: undefined,
    });
  });

  it('keeps legacy builtin no-provider cron fallback as subscription', () => {
    expect(resolveCronProviderIntentForExecution({
      runtime: 'builtin',
      providerId: undefined,
      providerEnv: undefined,
    })).toBe('subscription');
  });
});
