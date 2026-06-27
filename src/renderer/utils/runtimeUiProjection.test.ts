import { describe, expect, it } from 'vitest';

import {
  projectInputChromeRuntime,
  shouldUseExternalRuntimeInputControls,
} from './runtimeUiProjection';

describe('runtime UI projection', () => {
  it('keeps managed Codex execution hidden behind builtin provider chrome', () => {
    expect(projectInputChromeRuntime({
      currentRuntime: 'codex',
      managedProviderRuntimeActive: true,
    })).toBe('builtin');
    expect(shouldUseExternalRuntimeInputControls({
      currentRuntime: 'codex',
      managedProviderRuntimeActive: true,
    })).toBe(false);
  });

  it('keeps user-managed CLI runtimes in external runtime controls', () => {
    expect(projectInputChromeRuntime({
      currentRuntime: 'codex',
      managedProviderRuntimeActive: false,
    })).toBe('codex');
    expect(shouldUseExternalRuntimeInputControls({
      currentRuntime: 'codex',
      managedProviderRuntimeActive: false,
    })).toBe(true);
  });
});
