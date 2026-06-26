import { describe, expect, it } from 'vitest';

import type { Provider } from './config-types';
import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  MANAGED_CODEX_PROVIDER,
  SUBSCRIPTION_PROVIDER_ID,
} from './config-types';
import {
  assertBuiltinExecutionProvider,
  canReuseSessionAcrossProviderExecutionBoundary,
  getProviderExecutionHistoryFamily,
  isAnthropicSubscriptionProviderIntent,
  isRuntimeBackedProvider,
  toProviderExecutionIntent,
} from './providerExecution';

function apiProvider(id: string, model = 'model'): Provider {
  return {
    id,
    name: id,
    vendor: id,
    cloudProvider: id,
    type: 'api',
    primaryModel: model,
    isBuiltin: true,
    config: {},
    models: [{ model, modelName: model, modelSeries: model }],
  };
}

describe('provider execution identity', () => {
  it('materializes API providers as builtin provider routes', () => {
    expect(toProviderExecutionIntent(apiProvider('deepseek', 'deepseek-v4'), 'deepseek-v4')).toEqual({
      kind: 'builtin-provider',
      route: { kind: 'provider', providerId: 'deepseek', model: 'deepseek-v4' },
    });
  });

  it('materializes Managed Codex as a runtime-backed provider identity', () => {
    expect(toProviderExecutionIntent(MANAGED_CODEX_PROVIDER, 'gpt-5.4-codex')).toEqual({
      kind: 'runtime-backed-provider',
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      model: 'gpt-5.4-codex',
    });
  });

  it('does not let runtime-backed providers enter builtin ProviderEnv paths', () => {
    expect(isRuntimeBackedProvider(MANAGED_CODEX_PROVIDER)).toBe(true);
    expect(() => assertBuiltinExecutionProvider(MANAGED_CODEX_PROVIDER)).toThrow(/runtime-backed/);
  });

  it('keeps Anthropic subscription as a builtin subscription provider intent', () => {
    const intent = toProviderExecutionIntent({
      id: SUBSCRIPTION_PROVIDER_ID,
    }, 'claude-sonnet-4-6');

    expect(isAnthropicSubscriptionProviderIntent(intent)).toBe(true);
    expect(intent).toEqual({
      kind: 'builtin-provider',
      route: {
        kind: 'subscription',
        providerId: SUBSCRIPTION_PROVIDER_ID,
        model: 'claude-sonnet-4-6',
      },
    });
  });

  it('blocks transcript reuse when entering or leaving Managed Codex', () => {
    const builtin = toProviderExecutionIntent(apiProvider('deepseek', 'deepseek-v4'), 'deepseek-v4');
    const codex = toProviderExecutionIntent(MANAGED_CODEX_PROVIDER, 'gpt-5.4-codex');

    expect(canReuseSessionAcrossProviderExecutionBoundary({
      currentIntent: builtin,
      nextIntent: codex,
      currentProviderEnv: {
        providerId: 'deepseek',
        model: 'deepseek-v4',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiProtocol: 'anthropic',
      },
    })).toBe(false);

    expect(canReuseSessionAcrossProviderExecutionBoundary({
      currentIntent: codex,
      nextIntent: builtin,
      nextProviderEnv: {
        providerId: 'deepseek',
        model: 'deepseek-v4',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiProtocol: 'anthropic',
      },
    })).toBe(false);
  });

  it('allows Managed Codex to change between its own models inside the same session family', () => {
    const currentIntent = toProviderExecutionIntent(MANAGED_CODEX_PROVIDER, 'gpt-5.4-codex');
    const nextIntent = toProviderExecutionIntent(MANAGED_CODEX_PROVIDER, 'gpt-5.5-codex');

    expect(canReuseSessionAcrossProviderExecutionBoundary({
      currentIntent,
      nextIntent,
    })).toBe(true);
  });

  it('keeps builtin provider reuse delegated to provider history policy', () => {
    const currentIntent = toProviderExecutionIntent(apiProvider('deepseek', 'deepseek-v4'), 'deepseek-v4');
    const nextIntent = toProviderExecutionIntent(apiProvider('zhipu', 'glm-4.6'), 'glm-4.6');

    expect(canReuseSessionAcrossProviderExecutionBoundary({
      currentIntent,
      nextIntent,
      currentProviderEnv: {
        providerId: 'deepseek',
        model: 'deepseek-v4',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiProtocol: 'anthropic',
      },
      nextProviderEnv: {
        providerId: 'zhipu',
        model: 'glm-4.6',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        apiProtocol: 'anthropic',
      },
    })).toBe(true);
  });

  it('exposes stable history families for diagnostics and future callers', () => {
    const codex = toProviderExecutionIntent(MANAGED_CODEX_PROVIDER, 'gpt-5.4-codex');

    expect(getProviderExecutionHistoryFamily({ intent: codex })).toBe('runtime-backed:codex-sub');
    expect(getProviderExecutionHistoryFamily({ providerHistoryEnv: undefined })).toBe('builtin:anthropic');
    expect(getProviderExecutionHistoryFamily({
      providerHistoryEnv: {
        providerId: 'deepseek',
        model: 'deepseek-v4',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiProtocol: 'anthropic',
      },
    })).toBe('builtin:third-party:anthropic');
  });
});
