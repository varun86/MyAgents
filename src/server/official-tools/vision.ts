import { randomUUID } from 'crypto';
import { basename, extname, isAbsolute, relative, resolve } from 'path';
import { lstatSync, readFileSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';

import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  ALLOWED_IMAGE_MIME_TYPES,
  USER_IMAGE_ATTACHMENT_MAX_BYTES,
} from '../../shared/fileTypes';
import { IMAGE_UNDERSTANDING_TOOL_ID } from '../../shared/official-tools';
import { isProviderEnabled } from '../../shared/config-types';
import { isRuntimeBackedProvider } from '../../shared/providerExecution';
import {
  buildClaudeSessionEnv,
  resolveClaudeCodeCli,
  startOneShotBridge,
  type ProviderEnv,
} from '../agent-session';
import {
  findEffectiveProvider,
  getAllEffectiveProviders,
  getEffectiveOfficialToolIdsForSession,
  loadConfig,
  resolveProviderEnv,
  type AdminAppConfig,
} from '../utils/admin-config';
import { processImage } from '../utils/imageResize';
import { applyContextWindowSuffix } from '../utils/model-capabilities';
import type { ResolvedImagePayload } from '../runtimes/types';
import type { SessionMetadata } from '../types/session';

const DEFAULT_VISION_PROMPT = [
  'Analyze the provided image(s) for another AI agent that may not be able to see images.',
  'Return a faithful, task-useful description. Include visible text/OCR, UI layout, key objects, charts/tables, relationships, notable colors/states, and any ambiguities.',
  'If multiple images are provided, describe each image separately and then summarize cross-image relationships when relevant.',
].join(' ');

const SYSTEM_PROMPT = [
  'You are MyAgents Vision Helper.',
  'Your job is to inspect the provided images and produce precise textual observations for another AI agent.',
  'Do not invent details. If something is unclear, say so.',
].join('\n');

const MAX_IMAGES = 6;
const TIMEOUT_MS = 120_000;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export interface VisionModelOption {
  providerId: string;
  providerName: string;
  model: string;
  modelName: string;
}

export interface VisionAnalyzeInput {
  workspacePath?: string | null;
  sessionMeta?: SessionMetadata | null;
  images: string[];
  prompt?: string;
}

export interface VisionAnalyzeResult {
  toolId: typeof IMAGE_UNDERSTANDING_TOOL_ID;
  providerId: string;
  model: string;
  prompt: string;
  images: Array<{
    input: string;
    resolvedPath: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
  text: string;
}

class VisionToolError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'VisionToolError';
  }
}

export function getVisionToolReadme(): string {
  return `myagents vision — official image-understanding helper

Usage:
  myagents vision analyze --image <path> [--image <path> ...] [--prompt "..."] [--json]
  myagents vision analyze --image @myagents_files/screenshot.png --prompt "Read the error message"
  myagents vision readme

The tool only accepts local image paths inside the current MyAgents workspace.
Use @myagents_files/... paths when the conversation shows attached images as
workspace references. URLs are not supported.`;
}

export function listVisionModelOptions(config: AdminAppConfig = loadConfig()): VisionModelOption[] {
  const options: VisionModelOption[] = [];
  for (const provider of getVisionProviders(config)) {
    const providerId = String(provider.id);
    const providerName = typeof provider.name === 'string' ? provider.name : providerId;
    const models = Array.isArray(provider.models) ? provider.models : [];
    for (const entry of models) {
      if (!entry || typeof entry !== 'object') continue;
      const model = (entry as Record<string, unknown>).model;
      const modalities = (entry as Record<string, unknown>).inputModalities;
      if (typeof model !== 'string' || !Array.isArray(modalities) || !modalities.includes('image')) continue;
      const modelName = (entry as Record<string, unknown>).modelName;
      options.push({
        providerId,
        providerName,
        model,
        modelName: typeof modelName === 'string' && modelName.trim() ? modelName : model,
      });
    }
  }
  return options;
}

export async function analyzeImages(input: VisionAnalyzeInput): Promise<VisionAnalyzeResult> {
  const config = loadConfig();
  const workspacePath = input.workspacePath?.trim();
  if (!workspacePath) {
    throw new VisionToolError('No current workspace is available for image path resolution.', 400);
  }
  const enabledIds = getEffectiveOfficialToolIdsForSession(
    workspacePath,
    input.sessionMeta,
    undefined,
    config,
  );
  if (!enabledIds.includes(IMAGE_UNDERSTANDING_TOOL_ID)) {
    throw new VisionToolError('Image understanding is not enabled for this session.', 403);
  }

  const settings = config.officialToolSettings?.imageUnderstanding;
  const providerId = settings?.providerId?.trim();
  const model = settings?.model?.trim();
  if (!providerId || !model) {
    throw new VisionToolError('Image understanding model is not configured.', 409);
  }

  const provider = findEffectiveProvider(providerId, config);
  if (!provider || !isProviderEnabled(provider)) {
    throw new VisionToolError(`Configured vision provider '${providerId}' is unavailable.`, 409);
  }
  if (isRuntimeBackedProvider(provider)) {
    throw new VisionToolError(`Provider '${providerId}' is runtime-backed and cannot drive the vision helper.`, 409);
  }
  const modelEntry = findProviderModel(provider, model);
  if (!modelEntry || !modelEntry.inputModalities?.includes('image')) {
    throw new VisionToolError(`Model '${model}' is not registered as image-capable for provider '${providerId}'.`, 409);
  }

  const images = resolveVisionImages(input.images, workspacePath);
  const prompt = normalizePrompt(input.prompt);
  const providerEnv = materializeVisionProviderEnv(providerId, model, config);
  const deadlineMs = Date.now() + TIMEOUT_MS;

  const text = await runVisionQuery({
    workspacePath,
    providerId,
    providerEnv,
    model,
    images: images.map(img => img.payload),
    prompt,
    deadlineMs,
  });

  return {
    toolId: IMAGE_UNDERSTANDING_TOOL_ID,
    providerId,
    model,
    prompt,
    images: images.map(({ payload, input: imageInput, resolvedPath }) => ({
      input: imageInput,
      resolvedPath,
      name: payload.name,
      mimeType: payload.mimeType,
      sizeBytes: payload.sizeBytes ?? 0,
    })),
    text,
  };
}

function getVisionProviders(config: AdminAppConfig): Array<Record<string, unknown> & { id: string }> {
  return getAllEffectiveProviders(config)
    .filter(provider => isProviderEnabled(provider) && !isRuntimeBackedProvider(provider));
}

function findProviderModel(
  provider: Record<string, unknown>,
  model: string,
): { model: string; inputModalities?: string[] } | null {
  const models = Array.isArray(provider.models) ? provider.models : [];
  for (const entry of models) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.model !== model) continue;
    const modalities = Array.isArray(record.inputModalities)
      ? record.inputModalities.filter((v): v is string => typeof v === 'string')
      : undefined;
    return { model, inputModalities: modalities };
  }
  return null;
}

function materializeVisionProviderEnv(
  providerId: string,
  model: string,
  config: AdminAppConfig,
): ProviderEnv | undefined {
  const env = resolveProviderEnv(providerId, config);
  const provider = findEffectiveProvider(providerId, config);
  if (provider?.type === 'subscription') {
    return {};
  }
  if (provider?.type === 'api' && !env) {
    throw new VisionToolError(`Provider '${providerId}' needs a valid API key before it can drive image understanding.`, 409);
  }
  return env as ProviderEnv | undefined;
}

function normalizePrompt(prompt: string | undefined): string {
  const trimmed = prompt?.trim();
  return trimmed || DEFAULT_VISION_PROMPT;
}

function remainingMs(deadlineMs: number): number {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    throw new VisionToolError('Image understanding timed out.', 504);
  }
  return remaining;
}

function resolveVisionImages(
  rawImages: string[],
  workspacePath: string,
): Array<{ input: string; resolvedPath: string; payload: ResolvedImagePayload }> {
  if (!Array.isArray(rawImages) || rawImages.length === 0) {
    throw new VisionToolError('At least one --image path is required.', 400);
  }
  if (rawImages.length > MAX_IMAGES) {
    throw new VisionToolError(`At most ${MAX_IMAGES} images can be analyzed at once.`, 400);
  }
  const workspaceReal = realpathSync(workspacePath);
  return rawImages.map(raw => resolveOneVisionImage(raw, workspaceReal));
}

function resolveOneVisionImage(
  rawInput: string,
  workspaceReal: string,
): { input: string; resolvedPath: string; payload: ResolvedImagePayload } {
  const input = rawInput.trim();
  if (!input) throw new VisionToolError('Image path cannot be empty.', 400);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) {
    throw new VisionToolError('Image URLs are not supported. Use a local workspace image path.', 400);
  }

  const withoutAt = input.startsWith('@') ? input.slice(1) : input;
  const candidate = isAbsolute(withoutAt)
    ? withoutAt
    : resolve(workspaceReal, withoutAt);

  let lst;
  try {
    lst = lstatSync(candidate);
  } catch {
    throw new VisionToolError(`Image not found: ${input}`, 404);
  }
  if (lst.isSymbolicLink()) {
    throw new VisionToolError(`Image path must not be a symlink: ${input}`, 400);
  }
  if (!lst.isFile()) {
    throw new VisionToolError(`Image path is not a file: ${input}`, 400);
  }

  const realPath = realpathSync(candidate);
  const rel = relative(workspaceReal, realPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new VisionToolError('Image path must stay inside the current workspace.', 400);
  }

  const stat = statSync(realPath);
  if (stat.size > USER_IMAGE_ATTACHMENT_MAX_BYTES) {
    throw new VisionToolError(`Image '${input}' exceeds 10MB.`, 400);
  }

  const mimeType = mimeFromPath(realPath);
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(mimeType)) {
    throw new VisionToolError(`Unsupported image type for '${input}'.`, 400);
  }

  return {
    input,
    resolvedPath: realPath,
    payload: {
      name: basename(realPath),
      mimeType,
      data: readFileSync(realPath).toString('base64'),
      sizeBytes: stat.size,
    },
  };
}

function mimeFromPath(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

async function runVisionQuery(args: {
  workspacePath: string;
  providerId: string;
  providerEnv?: ProviderEnv;
  model: string;
  images: ResolvedImagePayload[];
  prompt: string;
  deadlineMs: number;
}): Promise<string> {
  const bridge = args.providerEnv?.apiProtocol === 'openai'
    ? startOneShotBridge(args.providerEnv, args.model, `official-vision:${args.providerEnv.baseUrl ?? args.providerId}`)
    : null;
  try {
    return await runVisionQueryInner({ ...args, bridgeToken: bridge?.token });
  } finally {
    bridge?.release();
  }
}

async function runVisionQueryInner(args: {
  workspacePath: string;
  providerEnv?: ProviderEnv;
  model: string;
  images: ResolvedImagePayload[];
  prompt: string;
  deadlineMs: number;
  bridgeToken?: string;
}): Promise<string> {
  const sessionId = randomUUID();
  const env = buildClaudeSessionEnv(args.providerEnv, args.model, {
    bridgeToken: args.bridgeToken,
  });
  const cliPath = resolveClaudeCodeCli();
  const contentBlocks: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string } }
  > = [];

  for (const img of args.images) {
    const tiles = await processImage(img, undefined, remainingMs(args.deadlineMs));
    if (tiles.length > 1) {
      contentBlocks.push({
        type: 'text',
        text: `[The following ${tiles.length} images are consecutive tiles of "${img.name}", in reading order.]`,
      });
    }
    for (const tile of tiles) {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: tile.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: tile.data,
        },
      });
    }
  }
  contentBlocks.push({ type: 'text', text: args.prompt });

  async function* visionPrompt() {
    yield {
      type: 'user' as const,
      message: { role: 'user' as const, content: contentBlocks },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
  }

  const visionQuery = query({
    prompt: visionPrompt(),
    options: {
      maxTurns: 1,
      sessionId,
      cwd: args.workspacePath || resolve(homedir(), '.myagents', 'projects'),
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      pathToClaudeCodeExecutable: cliPath,
      env,
      systemPrompt: SYSTEM_PROMPT,
      includePartialMessages: false,
      persistSession: false,
      mcpServers: {},
      tools: [],
      model: applyContextWindowSuffix(args.model),
    },
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new VisionToolError('Image understanding timed out.', 504)), remainingMs(args.deadlineMs));
  });

  try {
    return await Promise.race([extractVisionText(visionQuery), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    try { visionQuery.return(undefined as never); } catch { /* ignore */ }
  }
}

async function extractVisionText(visionQuery: AsyncIterable<unknown>): Promise<string> {
  let lastText = '';
  for await (const message of visionQuery) {
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (record.type === 'assistant') {
      const text = textFromContent((record.message as { content?: unknown } | undefined)?.content);
      if (text) lastText = text;
    } else if (record.type === 'result') {
      const messages = (record as { messages?: Array<{ role?: string; content?: unknown }> }).messages;
      const assistant = messages?.filter(m => m.role === 'assistant').pop();
      const text = textFromContent(assistant?.content);
      if (text) lastText = text;
    }
  }
  if (!lastText.trim()) throw new VisionToolError('Vision model returned no text.', 502);
  return lastText.trim();
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => {
      if (!block || typeof block !== 'object') return '';
      const text = (block as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function visionErrorResponse(error: unknown): { status: number; error: string } {
  if (error instanceof VisionToolError) {
    return { status: error.status, error: error.message };
  }
  return { status: 500, error: error instanceof Error ? error.message : String(error) };
}
