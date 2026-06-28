import { describe, expect, it } from 'vitest';

// The publish helper lives under scripts/ because it is an operator entrypoint,
// but its Windows process-spawn behavior is part of the managed runtime contract.
import {
  formatCommandFailure,
  resolveSpawnInvocation,
} from '../../../scripts/package-managed-codex-spawn.js';

describe('managed Codex package command spawning', () => {
  it('runs npm through npm-cli.js on Windows instead of spawning the shim', () => {
    const invocation = resolveSpawnInvocation('npm', ['view', '@openai/codex@0.142.2-win32-x64'], {
      platform: 'win32',
      nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe',
      fileExists: (path: string) => path.endsWith('\\node_modules\\npm\\bin\\npm-cli.js'),
    });

    expect(invocation.command).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(invocation.args[0]).toBe('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js');
    expect(invocation.args.slice(1)).toEqual(['view', '@openai/codex@0.142.2-win32-x64']);
    expect(invocation.displayCommand).toBe('npm');
    expect(invocation.displayArgs).toEqual(['view', '@openai/codex@0.142.2-win32-x64']);
  });

  it('runs npx through npx-cli.js on Windows instead of spawning the shim', () => {
    const invocation = resolveSpawnInvocation('npx', ['tauri', 'signer'], {
      platform: 'win32',
      nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe',
      fileExists: (path: string) => path.endsWith('\\node_modules\\npm\\bin\\npx-cli.js'),
    });

    expect(invocation.command).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(invocation.args[0]).toBe('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js');
    expect(invocation.args.slice(1)).toEqual(['tauri', 'signer']);
    expect(invocation.displayCommand).toBe('npx');
  });

  it('keeps spawn errors visible while redacting sensitive args', () => {
    const message = formatCommandFailure('npm', ['view', '--token=secret-value'], {
      error: new Error('spawnSync npm ENOENT'),
      stdout: '',
      stderr: '',
    });

    expect(message).toContain('Command failed: npm view <redacted>');
    expect(message).toContain('spawnSync npm ENOENT');
    expect(message).not.toContain('secret-value');
  });
});
