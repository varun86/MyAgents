export interface EmptySuccessfulSdkResultInput {
  isError?: boolean;
  result?: string | null;
  terminalReason?: string | null;
  hasVisibleOutput: boolean;
  toolCount: number;
  outputTokens?: number | null;
}

export function isEmptySuccessfulSdkResult(input: EmptySuccessfulSdkResultInput): boolean {
  return input.isError !== true
    && input.terminalReason === 'completed'
    && !input.hasVisibleOutput
    && input.toolCount === 0
    && (input.result ?? '').trim() === ''
    && (input.outputTokens ?? 0) === 0;
}

export interface RecoveredAssistantMessageErrorInput {
  hadAssistantMessageError: boolean;
  isError?: boolean;
  terminalReason?: string | null;
  emptySuccessfulResult: boolean;
}

export function isRecoveredAssistantMessageError(input: RecoveredAssistantMessageErrorInput): boolean {
  return input.hadAssistantMessageError
    && input.isError !== true
    && input.terminalReason === 'completed'
    && !input.emptySuccessfulResult;
}
