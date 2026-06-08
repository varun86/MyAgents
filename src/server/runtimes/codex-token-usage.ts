/**
 * Codex `thread/tokenUsage/updated` 解析 —— 纯函数核心（PRD 0.2.32）。
 *
 * 抽出来单独可测，因为 Codex 的 token schema 随版本漂移，是本特性最易回归的点。
 * 字段名以 `codex app-server generate-ts`（v0.136.0）产物为准：
 *   ThreadTokenUsage    = { total, last: TokenUsageBreakdown, modelContextWindow: number | null }
 *   TokenUsageBreakdown = { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens }
 */

export interface CodexTokenUsageBreakdown {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface CodexThreadTokenUsage {
  total?: CodexTokenUsageBreakdown;
  last?: CodexTokenUsageBreakdown;
  modelContextWindow?: number | null;
}

export interface MappedCodexUsage {
  /** 累计 input —— external watchdog 的 context-budget 超时估算依赖它（保持原语义）。 */
  runningTotalInputTokens: number;
  runningTotalOutputTokens: number;
  /**
   * 当前 context 占用 = 最近一次调用的 input。Codex 是 OpenAI 系：`inputTokens` **已含**
   * `cachedInputTokens`，不再相加（否则双算）。无 `last` 时 undefined（让下游回落）。
   * **不是** `total`（累计值，用作占用会随轮次无限增长）。
   */
  contextOccupiedTokens: number | undefined;
  /** runtime 自报的 context 窗口；缺省/非数字 → null（下游回落 registry/200K）。 */
  runtimeContextWindow: number | null;
}

/** 解析 Codex tokenUsage payload。`total` 缺失（异常 payload）→ null。 */
export function mapCodexTokenUsage(
  usage: CodexThreadTokenUsage | undefined | null,
): MappedCodexUsage | null {
  if (!usage?.total) return null;
  const lastInput = usage.last?.inputTokens;
  return {
    runningTotalInputTokens: usage.total.inputTokens ?? 0,
    runningTotalOutputTokens: usage.total.outputTokens ?? 0,
    contextOccupiedTokens: typeof lastInput === 'number' && lastInput > 0 ? lastInput : undefined,
    runtimeContextWindow: typeof usage.modelContextWindow === 'number' ? usage.modelContextWindow : null,
  };
}
