/**
 * Pure logic for the per-model settings editor (#325) — extracted from
 * ModelManagementPanel so parsing / save-shape decisions are unit-testable.
 *
 * Editable fields and WHY only these (consumption-chain audit, 2026-06-10):
 *  - `contextLength`     feeds CLAUDE_CODE_AUTO_COMPACT_WINDOW, the [1m] SDK
 *                        suffix and the context-usage ring denominator.
 *  - `inputModalities`   feeds sidecar attachment stripping + the renderer's
 *                        image-attach gating (modelSupportsModality).
 *  - `modelName`         display name everywhere (manual adds default to id).
 * Model-level `maxOutputTokens` is deliberately EXCLUDED: the registry stores
 * it but nothing consumes it — the effective knob is provider-level
 * `ProviderEnv.maxOutputTokens` (wire request param), configured on the
 * provider. Surfacing a dead model-level field would be a lying knob.
 */

/** Modality kinds offered in the editor. `text` is default-checked; the user
 *  picks the rest. At least one must remain selected (validated by caller via
 *  `isModalitySelectionValid`). */
export const EDITABLE_MODALITIES = ['text', 'image', 'video', 'audio'] as const;
export type EditableModality = (typeof EDITABLE_MODALITIES)[number];

export const MODALITY_LABELS: Record<EditableModality, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
};

/** Upper sanity bound for a context window. MUST match the sidecar registry's
 *  `MAX_PLAUSIBLE_TOKENS` (src/server/utils/model-capabilities.ts) — the
 *  registry silently drops values above its cap, so accepting a larger number
 *  here would save a value the runtime then ignores (codex review). */
const MAX_CONTEXT_WINDOW = 20_000_000;

/**
 * Parse the context-window input. Accepts:
 *   ''        → null   (clear the override — fall back to registry/default)
 *   '128000'  → 128000
 *   '128k'    → 128_000      (case-insensitive, decimal allowed: '1.5k' → 1500)
 *   '1m'      → 1_000_000
 * Returns 'invalid' for anything that doesn't resolve to a positive integer
 * within (0, 100M].
 */
export function parseContextWindowInput(raw: string): number | null | 'invalid' {
  const input = raw.trim();
  if (input === '') return null;
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(input);
  if (!match) return 'invalid';
  const base = Number(match[1]);
  const multiplier = match[2] ? (match[2].toLowerCase() === 'k' ? 1_000 : 1_000_000) : 1;
  const value = base * multiplier;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_CONTEXT_WINDOW) return 'invalid';
  return value;
}

/** At least one modality must be selected. */
export function isModalitySelectionValid(selected: readonly string[]): boolean {
  return selected.length > 0;
}

/** Initial toggle state for the editor: previously stored modalities, or the
 *  default "text checked" when the model has none recorded. */
export function initialModalitySelection(prev: readonly string[] | undefined): EditableModality[] {
  if (prev && prev.length > 0) {
    return EDITABLE_MODALITIES.filter((m) => prev.includes(m));
  }
  return ['text'];
}

/**
 * Decide what to persist for `inputModalities`.
 *
 * Pit-of-success: an UNSET `inputModalities` means "optimistic default-allow"
 * (both sidecar `modelSupportsModality` and the renderer mirror treat unknown
 * as allow-all). If the user opens the editor but never touches the toggles,
 * saving must NOT silently narrow an unset model down to `['text']` — keep it
 * unset. Once the user touches the toggles (or the model already had an
 * explicit list), persist the explicit selection.
 */
export function resolveModalitiesToSave(
  touched: boolean,
  prev: readonly string[] | undefined,
  selected: readonly EditableModality[],
): string[] | undefined {
  if (!touched && (!prev || prev.length === 0)) return undefined;
  return [...selected];
}
