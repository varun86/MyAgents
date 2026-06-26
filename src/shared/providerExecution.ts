import type { Provider, ProviderExecution } from './config-types';
import { CODEX_SUBSCRIPTION_PROVIDER_ID, SUBSCRIPTION_PROVIDER_ID } from './config-types';
import {
  canResumeAcrossProviderBoundary,
  getProviderHistoryIdentity,
  type ProviderHistoryEnv,
  type ProviderHistoryPolicy,
} from './providerHistory';
import {
  createConcreteProviderRoute,
  type ProviderRoute,
} from './providerRoute';
import type { RuntimeConfig } from './types/runtime';

export type RuntimeBackedProviderIdentity = {
  kind: 'runtime-backed-provider';
  providerId: typeof CODEX_SUBSCRIPTION_PROVIDER_ID;
  runtime: 'codex';
  runtimeSource: 'managed-provider';
  model: string;
};

export type ProviderExecutionIntent =
  | { kind: 'builtin-provider'; route: ProviderRoute }
  | RuntimeBackedProviderIdentity;

export type ProviderExecutionHistoryFamily =
  | 'builtin:anthropic'
  | `builtin:third-party:${'anthropic' | 'openai'}`
  | `builtin:isolated:${string}`
  | `runtime-backed:${typeof CODEX_SUBSCRIPTION_PROVIDER_ID}`;

type ProviderExecutionShape = Pick<Provider, 'id' | 'execution'>;

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function isRuntimeBackedProvider(
  provider: ProviderExecutionShape | null | undefined,
): boolean {
  return provider?.execution?.kind === 'runtime-backed'
    || provider?.id === CODEX_SUBSCRIPTION_PROVIDER_ID;
}

export function isRuntimeBackedProviderId(
  providerId: string | null | undefined,
): providerId is typeof CODEX_SUBSCRIPTION_PROVIDER_ID {
  return providerId === CODEX_SUBSCRIPTION_PROVIDER_ID;
}

export function isBuiltinExecutionProvider(
  provider: ProviderExecutionShape | null | undefined,
): boolean {
  return Boolean(provider) && !isRuntimeBackedProvider(provider);
}

export function assertBuiltinExecutionProvider(
  provider: ProviderExecutionShape,
): void {
  if (!isBuiltinExecutionProvider(provider)) {
    throw new Error(`Provider ${provider.id} is runtime-backed and cannot be materialized as ProviderEnv`);
  }
}

function assertManagedCodexExecution(provider: ProviderExecutionShape): asserts provider is ProviderExecutionShape & {
  execution: Extract<ProviderExecution, { kind: 'runtime-backed' }>;
} {
  if (
    provider.id !== CODEX_SUBSCRIPTION_PROVIDER_ID
    || provider.execution?.kind !== 'runtime-backed'
    || provider.execution.runtime !== 'codex'
    || provider.execution.source !== 'managed-provider'
  ) {
    throw new Error(`Unsupported runtime-backed provider: ${provider.id}`);
  }
}

export function createRuntimeBackedProviderIdentity(args: {
  providerId: typeof CODEX_SUBSCRIPTION_PROVIDER_ID;
  model: string;
}): RuntimeBackedProviderIdentity {
  const model = nonEmpty(args.model);
  if (!model) {
    throw new Error('Runtime-backed provider identity requires a model');
  }
  return {
    kind: 'runtime-backed-provider',
    providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
    runtime: 'codex',
    runtimeSource: 'managed-provider',
    model,
  };
}

export function runtimeConfigForRuntimeBackedProvider(
  identity: RuntimeBackedProviderIdentity,
  current?: RuntimeConfig,
): RuntimeConfig {
  return {
    ...(current ?? {}),
    source: identity.runtimeSource,
    model: identity.model,
  };
}

export function toProviderExecutionIntent(
  provider: Pick<Provider, 'id' | 'execution'>,
  model: string,
): ProviderExecutionIntent {
  if (isRuntimeBackedProvider(provider)) {
    assertManagedCodexExecution(provider);
    return createRuntimeBackedProviderIdentity({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      model,
    });
  }

  assertBuiltinExecutionProvider(provider);
  return {
    kind: 'builtin-provider',
    route: createConcreteProviderRoute(provider.id, model),
  };
}

export function providerExecutionIntentProviderId(
  intent: ProviderExecutionIntent | null | undefined,
): string | undefined {
  if (!intent) return undefined;
  if (intent.kind === 'runtime-backed-provider') return intent.providerId;
  return intent.route.kind === 'provider' || intent.route.kind === 'subscription'
    ? intent.route.providerId
    : undefined;
}

function builtinFamilyFromHistory(
  providerEnv: ProviderHistoryEnv | undefined,
  policy: ProviderHistoryPolicy | undefined,
): ProviderExecutionHistoryFamily {
  const identity = getProviderHistoryIdentity(providerEnv, policy);
  if (identity === 'anthropic') return 'builtin:anthropic';
  if (identity === 'third-party:anthropic') return 'builtin:third-party:anthropic';
  if (identity === 'third-party:openai') return 'builtin:third-party:openai';
  if (identity.startsWith('isolated:')) {
    return `builtin:${identity}` as `builtin:isolated:${string}`;
  }
  return `builtin:isolated:${identity}`;
}

export function getProviderExecutionHistoryFamily(args: {
  intent?: ProviderExecutionIntent;
  providerHistoryEnv?: ProviderHistoryEnv;
  policy?: ProviderHistoryPolicy;
}): ProviderExecutionHistoryFamily {
  if (args.intent?.kind === 'runtime-backed-provider') {
    return `runtime-backed:${args.intent.providerId}`;
  }
  return builtinFamilyFromHistory(args.providerHistoryEnv, args.policy);
}

export function canReuseSessionAcrossProviderExecutionBoundary(args: {
  currentIntent?: ProviderExecutionIntent;
  nextIntent?: ProviderExecutionIntent;
  currentProviderEnv?: ProviderHistoryEnv;
  nextProviderEnv?: ProviderHistoryEnv;
  legacyCurrentProviderUnknown?: boolean;
  policy?: ProviderHistoryPolicy;
}): boolean {
  const currentIntent = args.currentIntent;
  const nextIntent = args.nextIntent;
  const currentIsRuntimeBacked = currentIntent?.kind === 'runtime-backed-provider';
  const nextIsRuntimeBacked = nextIntent?.kind === 'runtime-backed-provider';

  if (currentIsRuntimeBacked || nextIsRuntimeBacked) {
    if (!currentIsRuntimeBacked || !nextIsRuntimeBacked) return false;
    return currentIntent.providerId === nextIntent.providerId
      && currentIntent.runtime === nextIntent.runtime
      && currentIntent.runtimeSource === nextIntent.runtimeSource;
  }

  if (args.legacyCurrentProviderUnknown && !args.currentProviderEnv) {
    return true;
  }

  return canResumeAcrossProviderBoundary(
    args.currentProviderEnv,
    args.nextProviderEnv,
    args.policy,
  );
}

export function isAnthropicSubscriptionProviderIntent(
  intent: ProviderExecutionIntent | null | undefined,
): boolean {
  return intent?.kind === 'builtin-provider'
    && intent.route.kind === 'subscription'
    && intent.route.providerId === SUBSCRIPTION_PROVIDER_ID;
}
