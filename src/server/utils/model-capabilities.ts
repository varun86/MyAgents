/**
 * Model capability lookup — read-side for CLAUDE_CODE_AUTO_COMPACT_WINDOW injection.
 *
 * Problem: Claude Agent SDK's autoCompact threshold derives from
 * `getContextWindowForModel(model)` which only recognizes Claude-family models
 * natively; everything else falls back to MODEL_CONTEXT_WINDOW_DEFAULT = 200_000.
 * For third-party providers with smaller windows (e.g. DeepSeek V3 = 128K),
 * the threshold sits above the upstream limit → upstream returns a raw 400
 * "context_length_exceeded" before SDK fires compaction.
 *
 * Fix: inject env `CLAUDE_CODE_AUTO_COMPACT_WINDOW=<N>` so SDK caps its
 * effective window estimate via `Math.min(contextWindow, N)` (autoCompact.ts:40-46).
 *
 * Data sources (in **disk-first override order** — first wins):
 *   1. `~/.myagents/providers/*.json` — user-defined custom providers.
 *   2. `~/.myagents/config.json::presetCustomModels[providerId][]` — models
 *      discovered/added by the user via the UI on preset providers.
 *   3. `PRESET_PROVIDERS` (bundled in `renderer/config/types.ts`) — fallback.
 *
 * Rationale for the order: it mirrors the `findProvider`-style disk-first
 * precedence elsewhere in admin-config. If a user pins a corrected
 * `contextLength` for `deepseek-chat` in their own providers file (e.g.
 * because a proxy in front enforces a tighter cap), their value must win
 * over the preset default — otherwise their override is silently ignored.
 *
 * Design:
 *   - Flat Map<modelId, capability>. First-wins across sources.
 *   - Rebuilt every call. Called at session-env build boundaries (Tab /
 *     CronTask / Agent / BackgroundCompletion session spawn, pre-warm,
 *     provider-verify, title-gen). Each call: ≤1 `readdirSync` + bounded
 *     `readFileSync` (capped at 256 files / 1 MB each) + one `config.json`
 *     read. Cache is deliberately skipped so mid-session provider edits take
 *     effect without an invalidate-hook.
 *   - Returns undefined if the model isn't in any registry — callers MUST
 *     treat undefined as "leave SDK's built-in default alone".
 *
 * Scope:
 *   - Covers the builtin Claude Agent SDK path in `agent-session.ts`. External
 *     runtimes (Claude Code CLI / Codex / Gemini — `src/server/runtimes/`)
 *     spawn via their own env-build (`runtimes/env-utils.ts`) and currently
 *     do NOT receive `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. That's acceptable
 *     for V1 because Codex/Gemini manage compaction differently and the CC
 *     CLI's `-p` mode respawns per turn. See runtimes/claude-code.ts if the
 *     coverage gap needs closing.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import { getHomeDirOrNull } from './platform';
import { stripBom } from '../../shared/utils';
// PRESET_PROVIDERS now lives in src/shared/config-types (moved from
// renderer/config/types in v0.2.9 to satisfy the dependency-cruiser
// `sidecar-no-import-renderer` boundary rule). The historical concern
// — that the source file might pull React / renderer-only deps into
// the Sidecar bundle — is moot now that the file lives in shared/
// where it has zero transitive deps by construction.
import { PRESET_PROVIDERS } from '../../shared/config-types';

export interface ModelCapability {
  contextLength?: number;
  maxOutputTokens?: number;
  /**
   * Input modalities the model accepts. Currently consumed by the
   * attachment-filter path in agent-session.ts (only the 'image' value is
   * acted on this release). Stored as the full list (`text`, `image`,
   * `video`, `audio`) so the same data drives the future video/audio
   * filters and the modality badges in the model picker without re-research.
   */
  inputModalities?: string[];
  source: 'preset' | 'custom' | 'discovered';
}

/** Modality kinds we recognize. Mirrors OpenAI / OpenRouter convention. */
export type ModalityKind = 'text' | 'image' | 'video' | 'audio';

// Safety caps for malicious / runaway inputs. A rogue ~/.myagents/providers/
// directory with thousands of files would otherwise freeze the event loop
// on every session-env build.
const MAX_PROVIDER_FILES = 256;
const MAX_PROVIDER_FILE_BYTES = 1 * 1024 * 1024;      // 1 MB
const MAX_CONFIG_FILE_BYTES = 10 * 1024 * 1024;       // 10 MB
// Values above this are almost certainly bogus. Largest known public model is
// ~10M context (Gemini 2M, Llama 3.1 10M); 20M is generous headroom.
const MAX_PLAUSIBLE_TOKENS = 20_000_000;

/** Coerce a JSON-ish numeric field to a finite positive integer, or null. */
function coercePositiveFinite(v: unknown): number | undefined {
  // LiteLLM and some discovery APIs return numbers as strings; accept both.
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_PLAUSIBLE_TOKENS) return undefined;
  return Math.floor(n);
}

/** Coerce a JSON-ish input_modalities array to a string[] of known kinds.
 *  - Non-array → undefined (treated as "no info" → optimistic default-allow)
 *  - Empty array → undefined (same: no info; users meaning "nothing accepted"
 *    should write `['text']` explicitly, since text-only IS the meaningful
 *    minimum and matches how every other source represents it)
 *  - Lowercased + dedup'd; non-string / oversize items dropped silently
 *    (defends against accidental Infinity / very long fragments in custom JSON) */
function coerceModalities(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item === 'string' && item.length > 0 && item.length <= 16) {
      seen.add(item.toLowerCase());
    }
  }
  return seen.size > 0 ? [...seen] : undefined;
}

/** Best-effort extract {contextLength, maxOutputTokens, inputModalities} from a JSON-ish model entry. */
function readCapability(entry: unknown, source: ModelCapability['source']): ModelCapability | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const ctx = coercePositiveFinite(e.contextLength);
  const out = coercePositiveFinite(e.maxOutputTokens);
  const mods = coerceModalities(e.inputModalities);
  if (!ctx && !out && !mods) return null;
  return { contextLength: ctx, maxOutputTokens: out, inputModalities: mods, source };
}

function ingestProviderList(
  providers: unknown,
  map: Map<string, ModelCapability>,
  source: ModelCapability['source'],
): void {
  if (!Array.isArray(providers)) return;
  for (const p of providers) {
    if (!p || typeof p !== 'object') continue;
    const models = (p as Record<string, unknown>).models;
    if (!Array.isArray(models)) continue;
    for (const m of models) {
      if (!m || typeof m !== 'object') continue;
      const mid = (m as Record<string, unknown>).model;
      if (typeof mid !== 'string' || !mid) continue;
      // First-wins. Load order (disk-first) determines priority; see module
      // header for the rationale.
      if (map.has(mid)) continue;
      const cap = readCapability(m, source);
      if (cap) map.set(mid, cap);
    }
  }
}

function loadCustomProvidersFromDisk(home: string): Array<Record<string, unknown>> {
  const dir = resolve(home, '.myagents', 'providers');
  if (!existsSync(dir)) return [];
  const out: Array<Record<string, unknown>> = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch (err) {
    console.warn('[model-caps] readdir failed for ~/.myagents/providers/:', (err as Error)?.message ?? err);
    return [];
  }
  if (files.length > MAX_PROVIDER_FILES) {
    console.warn(`[model-caps] ~/.myagents/providers/ has ${files.length} files; processing first ${MAX_PROVIDER_FILES}`);
    files = files.slice(0, MAX_PROVIDER_FILES);
  }
  for (const f of files) {
    const filePath = resolve(dir, f);
    try {
      const stat = statSync(filePath);
      if (stat.size > MAX_PROVIDER_FILE_BYTES) {
        console.warn(`[model-caps] skip oversize provider file ${f} (${stat.size} bytes > ${MAX_PROVIDER_FILE_BYTES})`);
        continue;
      }
      const raw = readFileSync(filePath, 'utf-8');
      const p = JSON.parse(stripBom(raw)) as Record<string, unknown>;
      if (p && typeof p === 'object' && typeof p.id === 'string') out.push(p);
    } catch (err) {
      console.warn(`[model-caps] skip malformed provider file ${f}:`, (err as Error)?.message ?? err);
    }
  }
  return out;
}

function loadPresetCustomModels(home: string): Record<string, unknown> | null {
  const configPath = resolve(home, '.myagents', 'config.json');
  if (!existsSync(configPath)) return null;
  try {
    const stat = statSync(configPath);
    if (stat.size > MAX_CONFIG_FILE_BYTES) {
      console.warn(`[model-caps] skip oversize config.json (${stat.size} bytes > ${MAX_CONFIG_FILE_BYTES})`);
      return null;
    }
    const raw = readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(stripBom(raw)) as { presetCustomModels?: Record<string, unknown> };
    return cfg.presetCustomModels ?? null;
  } catch (err) {
    console.warn('[model-caps] failed to read ~/.myagents/config.json:', (err as Error)?.message ?? err);
    return null;
  }
}

/**
 * Mtime-keyed cache for `buildRegistry()`.
 *
 * Hot-path callers — every `enqueueUserMessage`, every pre-warm, every model
 * switch, every provider-verify — used to pay an unbounded sync `readdirSync`
 * + N×`readFileSync` (capped at 256 files / 1 MB each) + a `config.json`
 * read. On a busy IM bot this stalls the event loop 50–500ms per turn and
 * undoes the v0.2.0 cold-start work.
 *
 * The cache is invalidated by stat-checking just two paths:
 *   - `~/.myagents/providers/`  (mtime changes when a file is created /
 *     deleted / replaced via tmp+rename — the canonical edit pattern)
 *   - `~/.myagents/config.json` (mtime changes on `presetCustomModels` edits)
 *
 * A miss costs 2 `statSync`s + 1 Map alloc; a hit costs 2 `statSync`s. Mid-
 * session edits propagate by the next call after the file system records the
 * change, preserving the "no invalidate hook required" guarantee from the
 * original design comment.
 */
interface RegistryCacheEntry {
  map: Map<string, ModelCapability>;
  providersDirMtimeMs: number;     // -1 when dir absent
  configMtimeMs: number;           // -1 when file absent
  homeAtBuild: string | null;      // re-keyed on home change (test isolation)
}
let registryCache: RegistryCacheEntry | null = null;

function statMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1; // missing dir/file is a valid state — cache it as such.
  }
}

function buildRegistry(): Map<string, ModelCapability> {
  const home = getHomeDirOrNull();

  const providersDir = home ? resolve(home, '.myagents', 'providers') : '';
  const configPath = home ? resolve(home, '.myagents', 'config.json') : '';
  const providersDirMtimeMs = providersDir ? statMtimeMs(providersDir) : -1;
  const configMtimeMs = configPath ? statMtimeMs(configPath) : -1;

  if (
    registryCache &&
    registryCache.homeAtBuild === home &&
    registryCache.providersDirMtimeMs === providersDirMtimeMs &&
    registryCache.configMtimeMs === configMtimeMs
  ) {
    return registryCache.map;
  }

  const map = new Map<string, ModelCapability>();

  // 1) Custom providers from ~/.myagents/providers/*.json — disk-first override.
  if (home) {
    ingestProviderList(loadCustomProvidersFromDisk(home), map, 'custom');
  }

  // 2) Discovered models stored on preset providers (config.presetCustomModels).
  //    Shape: { [providerId]: ModelEntity[] }. Populated by the "Discover
  //    models" flow in ModelManagementPanel.tsx.
  if (home) {
    const pcm = loadPresetCustomModels(home);
    if (pcm && typeof pcm === 'object') {
      for (const models of Object.values(pcm)) {
        if (!Array.isArray(models)) continue;
        for (const m of models) {
          if (!m || typeof m !== 'object') continue;
          const mid = (m as Record<string, unknown>).model;
          if (typeof mid !== 'string' || !mid) continue;
          if (map.has(mid)) continue;
          const cap = readCapability(m, 'discovered');
          if (cap) map.set(mid, cap);
        }
      }
    }
  }

  // 3) Bundled PRESET_PROVIDERS — fallback when neither user override nor
  //    discovery has filled the same modelId.
  ingestProviderList(PRESET_PROVIDERS, map, 'preset');

  registryCache = { map, providersDirMtimeMs, configMtimeMs, homeAtBuild: home };
  return map;
}

/**
 * Test-only: drop the cached registry. Real callers don't need to invoke this
 * — the mtime check inside `buildRegistry` picks up provider edits naturally.
 */
export function __resetModelCapabilityCacheForTests(): void {
  registryCache = null;
}

/**
 * Look up the context window for a model.
 * Returns undefined if the model isn't registered OR has no contextLength —
 * callers MUST treat undefined as "don't touch the env var" so SDK's
 * MODEL_CONTEXT_WINDOW_DEFAULT (200_000) remains in effect.
 */
export function lookupModelContextLength(modelId: string | undefined | null): number | undefined {
  if (!modelId) return undefined;
  return buildRegistry().get(modelId)?.contextLength;
}

/** Full capability record (contextLength + maxOutputTokens + inputModalities). */
export function lookupModelCapability(modelId: string | undefined | null): ModelCapability | undefined {
  if (!modelId) return undefined;
  return buildRegistry().get(modelId);
}

/**
 * Whether the model accepts a given input modality.
 *
 * Returns `true` for unknown / unregistered models — the optimistic default
 * preserves behavior for user-defined custom providers and brand-new models
 * that haven't propagated to any data source yet, per product requirement
 * "未知和自定义的就是默认支持" (default-allow). Only an explicit registry
 * entry whose `inputModalities` lacks the kind returns `false`.
 *
 * `text` is always permitted regardless of registry contents (a model with
 * no listed modalities at all wouldn't be usable).
 */
export function modelSupportsModality(
  modelId: string | undefined | null,
  kind: ModalityKind,
): boolean {
  if (kind === 'text') return true;
  const cap = lookupModelCapability(modelId);
  if (!cap || !cap.inputModalities) return true; // unknown → optimistic
  return cap.inputModalities.includes(kind);
}
