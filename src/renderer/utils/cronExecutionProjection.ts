import type { Provider } from '@/config/types';
import type { RuntimeConfig, RuntimeType } from '@/../shared/types/runtime';
import {
  projectTaskExecutionOverrides,
  type TaskExecutionOverrideProjection,
} from '@/utils/taskProviderProjection';

export type CronProviderIntent = 'followAgent' | 'subscription' | 'explicit';

export interface CronExecutionProjectionInput {
  providers: readonly Pick<Provider, 'id' | 'execution'>[];
  runtime?: RuntimeType;
  providerId?: string;
  model?: string;
  runtimeConfig?: RuntimeConfig;
  providerEnv?: unknown;
  providerIntent?: CronProviderIntent;
}

export interface CronExecutionProjection extends TaskExecutionOverrideProjection {
  providerEnv?: unknown;
  providerIntent?: CronProviderIntent;
}

export function resolveCronProviderIntentForExecution(args: {
  runtime?: RuntimeType;
  providerId?: string;
  providerEnv?: unknown;
  providerIntent?: CronProviderIntent;
}): CronProviderIntent | undefined {
  if (args.providerIntent) return args.providerIntent;
  if (args.providerId) return undefined;
  if (args.providerEnv) return 'explicit';
  if (args.runtime && args.runtime !== 'builtin') return undefined;
  return 'subscription';
}

export function resolveCronProviderEnvForExecution<TProviderEnv>(args: {
  runtime?: RuntimeType;
  providerId?: string;
  providerEnv?: TProviderEnv;
}): TProviderEnv | undefined {
  const runsExternalRuntime = args.runtime !== undefined && args.runtime !== 'builtin';
  return args.providerId || runsExternalRuntime ? undefined : args.providerEnv;
}

export function projectCronExecutionOverrides(
  input: CronExecutionProjectionInput,
): CronExecutionProjection {
  const execution = projectTaskExecutionOverrides(input);
  const providerEnv = resolveCronProviderEnvForExecution({
    runtime: execution.runtime,
    providerId: execution.providerId,
    providerEnv: input.providerEnv,
  });
  return {
    ...execution,
    providerEnv,
    providerIntent: resolveCronProviderIntentForExecution({
      runtime: execution.runtime,
      providerId: execution.providerId,
      providerEnv,
      providerIntent: input.providerIntent,
    }),
  };
}
