import { describe, expect, it } from 'vitest';
import { diagnoseSdkSubprocessFailure } from './sdk-subprocess-diagnostics';

describe('diagnoseSdkSubprocessFailure', () => {
  it('exit code 1 WITH bash-missing evidence → confident Git for Windows guidance', () => {
    const diagnostic = diagnoseSdkSubprocessFailure({
      platform: 'win32',
      errorMessage: 'Claude Code process exited with code 1',
      stderr: ["'bash' is not recognized as an internal or external command"],
    });

    expect(diagnostic?.kind).toBe('windows-git-bash-missing');
    expect(diagnostic?.userMessage).toContain('Git for Windows');
    // The original error must survive — the diagnostic REPLACES userFacingError
    // at the consumer, so without this the only real clue lives in the log.
    expect(diagnostic?.userMessage).toContain('exited with code 1');
  });

  it('cross-review 0.2.32: bare exit code 1 (no bash evidence) is AMBIGUOUS — Git is a hint, not a verdict', () => {
    // exit 1 on Windows also covers CLI fatals, AV interference, broken config…
    // A user who HAS Git installed must not be steered into a dead end.
    const diagnostic = diagnoseSdkSubprocessFailure({
      platform: 'win32',
      errorMessage: 'Claude Code process exited with code 1',
    });

    expect(diagnostic?.kind).toBe('windows-subprocess-exit-1');
    expect(diagnostic?.userMessage).toContain('Git'); // still the most common cause — keep the hint
    expect(diagnostic?.userMessage).toMatch(/常见原因|可能/); // …but hedged
    expect(diagnostic?.userMessage).toContain('exited with code 1'); // original error preserved
  });

  it('cross-review 0.2.32: native-crash evidence beats the exit-1 branch (Bun crash exiting 1 is not a Git problem)', () => {
    const diagnostic = diagnoseSdkSubprocessFailure({
      platform: 'win32',
      errorMessage: 'Claude Code process exited with code 1',
      stderr: ['oh no: Bun has crashed. This indicates a bug in Bun, not your code.'],
    });

    expect(diagnostic?.kind).toBe('windows-native-bun-crash');
  });

  it('maps unsigned STATUS_STACK_BUFFER_OVERRUN to SDK native Bun crash guidance', () => {
    const diagnostic = diagnoseSdkSubprocessFailure({
      platform: 'win32',
      errorMessage: 'Claude Code process exited with code 3221226505',
    });

    expect(diagnostic?.kind).toBe('windows-native-bun-crash');
    expect(diagnostic?.exitCodeHex).toBe('0xC0000409');
    expect(diagnostic?.userMessage).toBe('Claude Agent SDK 启动失败（exit code 3221226505 / 0xC0000409），请检查运行环境。');
    expect(diagnostic?.imMessage).toBe(diagnostic?.userMessage);
  });

  it('maps signed Windows native crash exit codes', () => {
    const diagnostic = diagnoseSdkSubprocessFailure({
      platform: 'win32',
      errorMessage: 'Claude Code process exited with code -1073740791',
    });

    expect(diagnostic?.exitCode).toBe(3221226505);
    expect(diagnostic?.exitCodeHex).toBe('0xC0000409');
  });

  it('uses Bun stderr as crash evidence when the exit message has no code', () => {
    const diagnostic = diagnoseSdkSubprocessFailure({
      platform: 'win32',
      errorMessage: 'Claude Code process terminated',
      stderr: [
        'panic(main thread): Illegal instruction at address 0x7FF6D5DAEF90',
        'oh no: Bun has crashed. This indicates a bug in Bun, not your code.',
      ],
    });

    expect(diagnostic?.kind).toBe('windows-native-bun-crash');
    expect(diagnostic?.exitCode).toBeUndefined();
  });

  it('does not classify non-Windows failures', () => {
    expect(diagnoseSdkSubprocessFailure({
      platform: 'darwin',
      errorMessage: 'Claude Code process exited with code 3221226505',
    })).toBeNull();
  });
});
