import type { RuntimeType } from '../../shared/types/runtime';

export function projectInputChromeRuntime(args: {
  currentRuntime: RuntimeType;
  managedProviderRuntimeActive: boolean;
}): RuntimeType {
  return args.managedProviderRuntimeActive ? 'builtin' : args.currentRuntime;
}

export function shouldUseExternalRuntimeInputControls(args: {
  currentRuntime: RuntimeType;
  managedProviderRuntimeActive: boolean;
}): boolean {
  return args.currentRuntime !== 'builtin' && !args.managedProviderRuntimeActive;
}
