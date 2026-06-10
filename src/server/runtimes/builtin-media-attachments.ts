/**
 * builtin-media-attachments — turn builtin in-process MCP media-tool output
 * (edge-tts audio / gemini-image image) into first-class `ToolAttachment[]`,
 * on the same pipeline as the Codex external runtime.
 *
 * PRD 0.2.30 (§3.1) + 0.2.31 cleanup. Parsing of the tool result text now lives
 * in the shared, single-source parser `@/shared/builtinMediaResult` (consumed by
 * both this server module and the renderer cards). This module owns only the
 * IO half: reading the generated file and saving a trusted-root copy.
 *
 * Why base64-copy into the trusted root (not a zero-copy externalPath ref):
 *  - the attachment endpoint resolves trusted-root files by path concat, so
 *    sidecar restart needs no `rebuildAttachmentRegistryFromBlocks`;
 *  - self-contained + GC-aligned; sidesteps the external-path allow-list (which
 *    doesn't cover arbitrary workspaces).
 * The original generated path is preserved on the attachment as `sourcePath`
 * (shown in the tool card + targeted by the "open path" menu).
 *
 * Failure is per-file graceful (log + skip): the tool card still shows the path.
 *
 * Security: the source path comes from OUR builtin tool's output (not model-
 * controlled), but is still validated defensively — absolute, under a known
 * generated dir, `lstat` rejects symlink leaf, regular file, size-capped before
 * the read (so a pathological file never gets fully loaded + base64-expanded).
 */

import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { saveToolAttachment } from './tool-attachments';
import { parseBuiltinMediaToolResult } from '../../shared/builtinMediaResult';
import { MAX_TOOL_ATTACHMENT_BYTES, type ToolAttachment } from '../../shared/types/tool-attachment';
import type { ExtractedToolResultAttachment } from '../utils/tool-result-attachments';

/** generated dir segment names (`~/.myagents/<name>` or `<ws>/myagents_files/<name>`). */
const GENERATED_DIR_NAMES = ['generated_audio', 'generated_images', 'generated'];

export interface BuiltinAttachmentCtxBase {
  sessionId: string;
  /** path-namespace turn segment; only needs to be unique — we use toolUseId. */
  toolUseId: string;
}

/** Defensive: the path must sit under a known generated dir segment. */
function isUnderKnownGeneratedDir(absPath: string): boolean {
  const norm = path.normalize(absPath);
  return GENERATED_DIR_NAMES.some(name => norm.includes(`${path.sep}${name}${path.sep}`));
}

/**
 * Read builtin media files and save trusted-root copies as `ToolAttachment[]`.
 * Per-file failures are swallowed (log + skip); non-media tools return `[]`.
 */
export async function buildBuiltinMediaAttachments(
  toolName: string,
  contentStr: string,
  ctxBase: BuiltinAttachmentCtxBase,
): Promise<ToolAttachment[]> {
  const specs = parseBuiltinMediaToolResult(toolName, contentStr);
  if (specs.length === 0) return [];

  const out: ToolAttachment[] = [];
  for (const spec of specs) {
    try {
      if (!path.isAbsolute(spec.filePath)) {
        console.warn(`[builtin-media] non-absolute path, skip: ${spec.filePath}`);
        continue;
      }
      if (!isUnderKnownGeneratedDir(spec.filePath)) {
        console.warn(`[builtin-media] path not under a known generated dir, skip: ${spec.filePath}`);
        continue;
      }
      const st = await lstat(spec.filePath);
      if (st.isSymbolicLink() || !st.isFile()) {
        console.warn(`[builtin-media] not a regular file (symlink?), skip: ${spec.filePath}`);
        continue;
      }
      // Size gate BEFORE readFile: saveToolAttachment enforces the 25MB cap, but
      // only after the whole file is read + base64-expanded (~1.33x), peaking at
      // ~2.3x in memory. We already have `st` — reject up front.
      if (st.size > MAX_TOOL_ATTACHMENT_BYTES) {
        console.warn(`[builtin-media] file exceeds ${MAX_TOOL_ATTACHMENT_BYTES} bytes (${st.size}), skip: ${spec.filePath}`);
        continue;
      }
      const bytes = await readFile(spec.filePath);
      const attachment = await saveToolAttachment(
        { kind: 'base64', data: bytes.toString('base64') },
        {
          sessionId: ctxBase.sessionId,
          turnId: ctxBase.toolUseId,
          toolUseId: ctxBase.toolUseId,
          mimeType: spec.mimeType,
          kind: spec.kind,
          caption: spec.caption,
          producedBy: spec.producedBy,
        },
      );
      // Preserve the original generated path so the card + "open path" menu agree.
      out.push({ ...attachment, sourcePath: spec.filePath });
    } catch (err) {
      console.warn(
        `[builtin-media] failed to build attachment for ${toolName}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return out;
}

/**
 * #293 — save image sources EXTRACTED from tool_result content blocks (the
 * generic MCP/SDK shapes: base64 ImageContent, data URLs, file refs, remote
 * urls) as first-class `ToolAttachment[]`.
 *
 * Counterpart of `buildBuiltinMediaAttachments` (which parses file PATHS out
 * of result TEXT for the two builtin generator tools); this one consumes the
 * pre-extracted block sources from `extractToolResultRenderParts`. Both feed
 * the same `saveToolAttachment` trust layer:
 *   - base64   → trusted-root file write (validateTrustedAttachmentRoot)
 *   - external → positive allow-list + canonicalized symlink check
 *   - url      → https-only SSRF-guarded download
 *
 * Per-item failures are swallowed (log + skip) — one bad block must not sink
 * the sibling images or the tool result itself.
 */
export async function saveExtractedToolResultAttachments(
  extracted: ExtractedToolResultAttachment[],
  toolName: string,
  ctxBase: BuiltinAttachmentCtxBase,
): Promise<ToolAttachment[]> {
  if (extracted.length === 0) return [];
  const out: ToolAttachment[] = [];
  for (const item of extracted) {
    try {
      const attachment = await saveToolAttachment(item.source, {
        sessionId: ctxBase.sessionId,
        turnId: ctxBase.toolUseId,
        toolUseId: ctxBase.toolUseId,
        mimeType: item.mimeType,
        kind: item.kind,
        producedBy: toolName,
      });
      out.push(attachment);
    } catch (err) {
      console.warn(
        `[builtin-media] failed to save extracted ${item.kind} from ${toolName}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return out;
}
