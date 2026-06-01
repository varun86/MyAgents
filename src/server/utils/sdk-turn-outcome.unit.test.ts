import { describe, expect, it } from 'vitest';

import {
  isEmptySuccessfulSdkResult,
  isRecoveredAssistantMessageError,
} from './sdk-turn-outcome';

describe('isEmptySuccessfulSdkResult', () => {
  it('detects a completed SDK result with no visible output, tools, result text, or output tokens', () => {
    expect(isEmptySuccessfulSdkResult({
      isError: false,
      result: '',
      terminalReason: 'completed',
      hasVisibleOutput: false,
      toolCount: 0,
      outputTokens: 0,
    })).toBe(true);
  });

  it('does not flag successful text output', () => {
    expect(isEmptySuccessfulSdkResult({
      isError: false,
      result: 'hello',
      terminalReason: 'completed',
      hasVisibleOutput: false,
      toolCount: 0,
      outputTokens: 12,
    })).toBe(false);
  });

  it('treats whitespace-only result text as empty', () => {
    expect(isEmptySuccessfulSdkResult({
      isError: false,
      result: '   \n\t',
      terminalReason: 'completed',
      hasVisibleOutput: false,
      toolCount: 0,
      outputTokens: 0,
    })).toBe(true);
  });

  it('does not flag a tool-only turn', () => {
    expect(isEmptySuccessfulSdkResult({
      isError: false,
      result: '',
      terminalReason: 'completed',
      hasVisibleOutput: false,
      toolCount: 1,
      outputTokens: 0,
    })).toBe(false);
  });

  it('does not flag terminal SDK errors', () => {
    expect(isEmptySuccessfulSdkResult({
      isError: true,
      result: '',
      terminalReason: 'completed',
      hasVisibleOutput: false,
      toolCount: 0,
      outputTokens: 0,
    })).toBe(false);
  });

  it('requires the SDK to claim completion', () => {
    expect(isEmptySuccessfulSdkResult({
      isError: false,
      result: '',
      terminalReason: 'model_error',
      hasVisibleOutput: false,
      toolCount: 0,
      outputTokens: 0,
    })).toBe(false);
  });
});

describe('isRecoveredAssistantMessageError', () => {
  it('treats a completed non-error result as recovery from a provisional assistant message error', () => {
    expect(isRecoveredAssistantMessageError({
      hadAssistantMessageError: true,
      isError: false,
      terminalReason: 'completed',
      emptySuccessfulResult: false,
    })).toBe(true);
  });

  it('does not recover terminal result errors', () => {
    expect(isRecoveredAssistantMessageError({
      hadAssistantMessageError: true,
      isError: true,
      terminalReason: 'completed',
      emptySuccessfulResult: false,
    })).toBe(false);
  });

  it('does not recover non-completed terminal reasons', () => {
    expect(isRecoveredAssistantMessageError({
      hadAssistantMessageError: true,
      isError: false,
      terminalReason: 'model_error',
      emptySuccessfulResult: false,
    })).toBe(false);
  });

  it('does not recover an empty successful result', () => {
    expect(isRecoveredAssistantMessageError({
      hadAssistantMessageError: true,
      isError: false,
      terminalReason: 'completed',
      emptySuccessfulResult: true,
    })).toBe(false);
  });
});
