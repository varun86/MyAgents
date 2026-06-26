import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MANAGED_CODEX_REQUIRED_RUNTIME } from '../../shared/config-types';
import {
  getManagedCodexHome,
  resolveCodexCommandContext,
} from './codex-command-context';

function platformKey(): string | null {
  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') return 'darwin-arm64';
    if (process.arch === 'x64') return 'darwin-x64';
  }
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64';
  return null;
}

describe('codex command context', () => {
  let tempHome: string | null = null;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
  });

  it('keeps system-cli on PATH resolution semantics', () => {
    const context = resolveCodexCommandContext({ source: 'system-cli' });
    expect(context.source).toBe('system-cli');
    expect(context.codexHome).toBeUndefined();
    expect(context.commandPath).toBeTruthy();
  });

  it('uses managed runtime path and isolated CODEX_HOME for managed-provider', () => {
    const platform = platformKey();
    if (!platform) {
      expect(() => resolveCodexCommandContext({ source: 'managed-provider' }))
        .toThrow(/not supported/i);
      return;
    }

    tempHome = mkdtempSync(join(tmpdir(), 'myagents-managed-codex-'));
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);
    vi.stubEnv('OPENAI_API_KEY', 'must-not-leak');
    vi.stubEnv('CODEX_ACCESS_TOKEN', 'must-not-leak');
    vi.stubEnv('CODEX_HOME', '/tmp/user-codex-home');

    const installDir = join(
      tempHome,
      '.myagents',
      'runtimes',
      'codex',
      MANAGED_CODEX_REQUIRED_RUNTIME.version,
      platform,
    );
    mkdirSync(installDir, { recursive: true });
    const binary = join(installDir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    writeFileSync(binary, '');

    const context = resolveCodexCommandContext({ source: 'managed-provider' });

    expect(context.source).toBe('managed-provider');
    expect(context.commandPath).toBe(binary);
    expect(context.codexHome).toBe(getManagedCodexHome());
    expect(context.env.CODEX_HOME).toBe(getManagedCodexHome());
    expect(context.env.OPENAI_API_KEY).toBeUndefined();
    expect(context.env.CODEX_ACCESS_TOKEN).toBeUndefined();
  });

  it('prefers executableRelativePath from managed installed metadata', () => {
    const platform = platformKey();
    if (!platform) return;

    tempHome = mkdtempSync(join(tmpdir(), 'myagents-managed-codex-'));
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);

    const root = join(tempHome, '.myagents', 'runtimes', 'codex');
    const installDir = join(root, MANAGED_CODEX_REQUIRED_RUNTIME.version, platform);
    const nestedDir = join(installDir, 'package', 'bin');
    mkdirSync(nestedDir, { recursive: true });
    const binary = join(nestedDir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    writeFileSync(binary, '');
    writeFileSync(join(root, 'installed.json'), JSON.stringify({
      version: MANAGED_CODEX_REQUIRED_RUNTIME.version,
      platform,
      executableRelativePath: process.platform === 'win32' ? 'package/bin/codex.exe' : 'package/bin/codex',
    }));

    const context = resolveCodexCommandContext({ source: 'managed-provider' });

    expect(context.commandPath).toBe(binary);
  });
});
