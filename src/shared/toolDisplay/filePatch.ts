export type FileChangeKind =
  | string
  | {
      type?: string | null;
      move_path?: string | null;
    }
  | null
  | undefined;

export interface FileChangeLike {
  path?: string;
  kind?: FileChangeKind;
  diff?: string;
}

export interface FileChangeDiffStats {
  added: number;
  removed: number;
}

export interface FileChangeSummary extends FileChangeDiffStats {
  files: number;
}

export type ToolInputRecord = Record<string, unknown>;
export type FilePatchViewKind = 'old-new' | 'content' | 'unified-diff';
export type FilePatchSource = 'builtin' | 'codex' | 'external' | 'unknown';

export interface FilePatchChangeDescriptor extends FileChangeDiffStats {
  kind: string;
  path?: string;
  movePath?: string;
  view: {
    kind: FilePatchViewKind;
  };
}

export interface FilePatchDisplayDescriptor {
  kind: 'file_patch';
  version: 1;
  source: FilePatchSource;
  status?: string;
  replaceAll?: boolean;
  summary: FileChangeSummary;
  changes: FilePatchChangeDescriptor[];
}

export interface FilePatchOldNewView {
  kind: 'old-new';
  oldText: string;
  newText: string;
}

export interface FilePatchContentView {
  kind: 'content';
  content: string;
}

export interface FilePatchUnifiedDiffView {
  kind: 'unified-diff';
  diff: string;
}

export type FilePatchMaterializedView =
  | FilePatchOldNewView
  | FilePatchContentView
  | FilePatchUnifiedDiffView;

export interface FilePatchChange extends FileChangeDiffStats {
  kind: string;
  path?: string;
  movePath?: string;
  view: FilePatchMaterializedView;
}

export interface FilePatchDisplay {
  kind: 'file_patch';
  version: 1;
  source: FilePatchSource;
  status?: string;
  replaceAll?: boolean;
  summary: FileChangeSummary;
  changes: FilePatchChange[];
}

export type ToolDisplayPayload = FilePatchDisplayDescriptor;

export interface FilePatchToolLike {
  name?: string;
  input?: unknown;
  inputJson?: string;
  parsedInput?: unknown;
  result?: string;
  isError?: boolean;
  resultMeta?: {
    status?: unknown;
  } | null;
  display?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasInputFields(input: ToolInputRecord): boolean {
  return Object.keys(input).length > 0;
}

export function isToolInputRecord(value: unknown): value is ToolInputRecord {
  return isRecord(value);
}

function pushInputCandidate(candidates: ToolInputRecord[], seen: Set<ToolInputRecord>, value: unknown): void {
  if (!isToolInputRecord(value) || !hasInputFields(value) || seen.has(value)) return;
  seen.add(value);
  candidates.push(value);
}

export function resolveToolInputRecords(tool: FilePatchToolLike): ToolInputRecord[] {
  const candidates: ToolInputRecord[] = [];
  const seen = new Set<ToolInputRecord>();
  pushInputCandidate(candidates, seen, tool.parsedInput);
  if (typeof tool.inputJson === 'string') {
    const raw = tool.inputJson.trim();
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        pushInputCandidate(candidates, seen, parsed);
      } catch {
        // Keep falling through to the raw input object.
      }
    }
  }
  pushInputCandidate(candidates, seen, tool.input);
  return candidates;
}

export function resolveToolInputRecord(tool: FilePatchToolLike): ToolInputRecord | null {
  return resolveToolInputRecords(tool)[0] ?? null;
}

export function getInputStringProp(input: ToolInputRecord | null | undefined, key: string): string | undefined {
  if (!input) return undefined;
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function getBooleanProp(input: ToolInputRecord | null | undefined, key: string): boolean | undefined {
  if (!input) return undefined;
  const value = input[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function coerceFileChanges(value: unknown): FileChangeLike[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => ({
      ...(typeof item.path === 'string' ? { path: item.path } : {}),
      kind: item.kind as FileChangeKind,
      ...(typeof item.diff === 'string' ? { diff: item.diff } : {}),
    }));
}

export function fileChangeKindType(kind: FileChangeKind): string {
  if (typeof kind === 'string' && kind.trim()) return kind;
  if (kind && typeof kind === 'object' && typeof kind.type === 'string' && kind.type.trim()) {
    return kind.type;
  }
  return 'change';
}

export function fileChangeKindLabel(kind: FileChangeKind): string {
  switch (fileChangeKindType(kind)) {
    case 'add':
      return 'add';
    case 'update':
      return 'update';
    case 'delete':
      return 'delete';
    case 'move':
      return 'move';
    default:
      return fileChangeKindType(kind);
  }
}

export function fileChangeMovePath(kind: FileChangeKind): string | null {
  if (kind && typeof kind === 'object' && typeof kind.move_path === 'string' && kind.move_path.trim()) {
    return kind.move_path;
  }
  return null;
}

export function countContentLines(content: string): number {
  if (!content) return 0;
  const parts = content.split('\n');
  return content.endsWith('\n') ? parts.length - 1 : parts.length;
}

function isUnifiedDiffHunkHeader(line: string): boolean {
  return /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line);
}

function countUnifiedDiffLines(diff: string): FileChangeDiffStats {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (isUnifiedDiffHunkHeader(line)) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

export function countFileChangeDiffLines(change: FileChangeLike): FileChangeDiffStats {
  const diff = typeof change.diff === 'string' ? change.diff : '';
  if (!diff) return { added: 0, removed: 0 };

  const kind = fileChangeKindType(change.kind);
  const hasHunk = diff.split('\n').some(isUnifiedDiffHunkHeader);
  if (hasHunk) return countUnifiedDiffLines(diff);

  if (kind === 'add') return { added: countContentLines(diff), removed: 0 };
  if (kind === 'delete') return { added: 0, removed: countContentLines(diff) };
  return countUnifiedDiffLines(diff);
}

export function summarizeFileChanges(changes: readonly FileChangeLike[] | undefined): FileChangeSummary | null {
  if (!changes || changes.length === 0) return null;
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    const stats = countFileChangeDiffLines(change);
    added += stats.added;
    removed += stats.removed;
  }
  return { files: changes.length, added, removed };
}

export function formatFileChangeForResult(change: FileChangeLike): string {
  const label = fileChangeKindLabel(change.kind);
  const path = change.path || '(unknown path)';
  const movePath = fileChangeMovePath(change.kind);
  const pathLabel = movePath ? `${path} -> ${movePath}` : path;
  return change.diff ? `${label}: ${pathLabel}\n${change.diff}` : `${label}: ${pathLabel}`;
}

function resolvePatchStatus(tool: FilePatchToolLike): string | undefined {
  const metaStatus = tool.resultMeta?.status;
  if (typeof metaStatus === 'string' && metaStatus.trim()) return metaStatus;
  const match = typeof tool.result === 'string' ? tool.result.match(/^\[([^\]]+)\]\n/) : null;
  if (match?.[1]) return match[1];
  return tool.isError ? 'failed' : undefined;
}

function summaryFromChangeDescriptors(changes: readonly FilePatchChangeDescriptor[]): FileChangeSummary {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    added += change.added;
    removed += change.removed;
  }
  return { files: changes.length, added, removed };
}

function summaryFromChanges(changes: readonly FilePatchChange[]): FileChangeSummary {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    added += change.added;
    removed += change.removed;
  }
  return { files: changes.length, added, removed };
}

function cleanStatus(status: string | undefined): string | undefined {
  return status && status !== 'completed' ? status : status === 'completed' ? 'completed' : undefined;
}

function descriptorFromCodexChanges(tool: FilePatchToolLike, input: ToolInputRecord): FilePatchDisplayDescriptor | null {
  const changes = coerceFileChanges(input.changes);
  if (changes.length === 0) return null;

  const descriptors = changes.map((change): FilePatchChangeDescriptor => {
    const stats = countFileChangeDiffLines(change);
    const movePath = fileChangeMovePath(change.kind) ?? undefined;
    return {
      kind: fileChangeKindLabel(change.kind),
      ...(change.path ? { path: change.path } : {}),
      ...(movePath ? { movePath } : {}),
      added: stats.added,
      removed: stats.removed,
      view: { kind: 'unified-diff' },
    };
  });

  return {
    kind: 'file_patch',
    version: 1,
    source: 'codex',
    ...(cleanStatus(resolvePatchStatus(tool)) ? { status: cleanStatus(resolvePatchStatus(tool)) } : {}),
    summary: summaryFromChangeDescriptors(descriptors),
    changes: descriptors,
  };
}

function descriptorFromBuiltinEdit(tool: FilePatchToolLike, input: ToolInputRecord): FilePatchDisplayDescriptor | null {
  const oldText = getInputStringProp(input, 'old_string');
  const newText = getInputStringProp(input, 'new_string');
  if (oldText === undefined || newText === undefined) return null;

  const oldValue = oldText ?? '';
  const newValue = newText ?? '';
  const descriptor: FilePatchChangeDescriptor = {
    kind: 'update',
    ...(getInputStringProp(input, 'file_path') ? { path: getInputStringProp(input, 'file_path') } : {}),
    added: countContentLines(newValue),
    removed: countContentLines(oldValue),
    view: { kind: 'old-new' },
  };
  const replaceAll = getBooleanProp(input, 'replace_all');
  return {
    kind: 'file_patch',
    version: 1,
    source: 'builtin',
    ...(cleanStatus(resolvePatchStatus(tool)) ? { status: cleanStatus(resolvePatchStatus(tool)) } : {}),
    ...(replaceAll ? { replaceAll } : {}),
    summary: summaryFromChangeDescriptors([descriptor]),
    changes: [descriptor],
  };
}

function descriptorFromWrite(tool: FilePatchToolLike, input: ToolInputRecord): FilePatchDisplayDescriptor | null {
  const content = getInputStringProp(input, 'content');
  if (content === undefined) return null;

  const descriptor: FilePatchChangeDescriptor = {
    kind: 'add',
    ...(getInputStringProp(input, 'file_path') ? { path: getInputStringProp(input, 'file_path') } : {}),
    added: countContentLines(content),
    removed: 0,
    view: { kind: 'content' },
  };
  return {
    kind: 'file_patch',
    version: 1,
    source: tool.name === 'Write' ? 'builtin' : 'external',
    ...(cleanStatus(resolvePatchStatus(tool)) ? { status: cleanStatus(resolvePatchStatus(tool)) } : {}),
    summary: summaryFromChangeDescriptors([descriptor]),
    changes: [descriptor],
  };
}

function isFilePatchDescriptor(value: unknown): value is FilePatchDisplayDescriptor {
  if (!isRecord(value)) return false;
  return value.kind === 'file_patch' && value.version === 1 && Array.isArray(value.changes);
}

function normalizeDescriptor(value: unknown): FilePatchDisplayDescriptor | null {
  if (!isFilePatchDescriptor(value)) return null;
  const changes: FilePatchChangeDescriptor[] = value.changes
    .filter(isRecord)
    .map((change) => {
      const view = isRecord(change.view) && typeof change.view.kind === 'string'
        ? { kind: change.view.kind as FilePatchViewKind }
        : { kind: 'unified-diff' as const };
      return {
        kind: typeof change.kind === 'string' ? change.kind : 'change',
        ...(typeof change.path === 'string' ? { path: change.path } : {}),
        ...(typeof change.movePath === 'string' ? { movePath: change.movePath } : {}),
        added: typeof change.added === 'number' ? change.added : 0,
        removed: typeof change.removed === 'number' ? change.removed : 0,
        view,
      };
    });
  if (changes.length === 0) return null;
  const source =
    value.source === 'builtin' || value.source === 'codex' || value.source === 'external' || value.source === 'unknown'
      ? value.source
      : 'unknown';
  return {
    kind: 'file_patch',
    version: 1,
    source,
    ...(typeof value.status === 'string' && value.status ? { status: value.status } : {}),
    ...(value.replaceAll === true ? { replaceAll: true } : {}),
    summary: summaryFromChangeDescriptors(changes),
    changes,
  };
}

function buildDescriptorFromInput(tool: FilePatchToolLike, input: ToolInputRecord): FilePatchDisplayDescriptor | null {
  const fromCodex = descriptorFromCodexChanges(tool, input);
  if (fromCodex) return fromCodex;
  if (tool.name === 'Write') {
    const fromWrite = descriptorFromWrite(tool, input);
    if (fromWrite) return fromWrite;
  }
  if (tool.name === 'Edit') {
    const fromEdit = descriptorFromBuiltinEdit(tool, input);
    if (fromEdit) return fromEdit;
  }
  return null;
}

function descriptorScore(descriptor: FilePatchDisplayDescriptor): number {
  return descriptor.summary.added + descriptor.summary.removed;
}

export function buildFilePatchDisplayDescriptor(tool: FilePatchToolLike): FilePatchDisplayDescriptor | null {
  let fallback: FilePatchDisplayDescriptor | null = null;
  for (const input of resolveToolInputRecords(tool)) {
    const descriptor = buildDescriptorFromInput(tool, input);
    if (!descriptor) continue;
    if (descriptorScore(descriptor) > 0) return descriptor;
    fallback ??= descriptor;
  }
  if (fallback) return fallback;
  const existing = normalizeDescriptor(tool.display);
  if (!existing) return null;
  const status = cleanStatus(resolvePatchStatus(tool)) ?? existing.status;
  return {
    ...existing,
    ...(status ? { status } : {}),
  };
}

function materializeCodexDiff(change: FilePatchChangeDescriptor, index: number, input: ToolInputRecord | null): FilePatchChange | null {
  const fileChanges = coerceFileChanges(input?.changes);
  const raw = fileChanges[index] ?? fileChanges.find((candidate) => {
    const movePath = fileChangeMovePath(candidate.kind) ?? undefined;
    return candidate.path === change.path && movePath === change.movePath;
  });
  const diff = typeof raw?.diff === 'string' ? raw.diff : '';
  const stats = raw ? countFileChangeDiffLines(raw) : { added: change.added, removed: change.removed };
  return {
    kind: change.kind,
    ...(change.path ? { path: change.path } : {}),
    ...(change.movePath ? { movePath: change.movePath } : {}),
    added: stats.added,
    removed: stats.removed,
    view: { kind: 'unified-diff', diff },
  };
}

function materializeOldNew(change: FilePatchChangeDescriptor, input: ToolInputRecord | null): FilePatchChange | null {
  const oldText = getInputStringProp(input, 'old_string');
  const newText = getInputStringProp(input, 'new_string');
  if (oldText === undefined || newText === undefined) return null;
  const oldValue = oldText ?? '';
  const newValue = newText ?? '';
  return {
    kind: change.kind,
    ...(change.path ? { path: change.path } : {}),
    ...(change.movePath ? { movePath: change.movePath } : {}),
    added: countContentLines(newValue),
    removed: countContentLines(oldValue),
    view: { kind: 'old-new', oldText: oldValue, newText: newValue },
  };
}

function materializeContent(change: FilePatchChangeDescriptor, input: ToolInputRecord | null): FilePatchChange | null {
  const content = getInputStringProp(input, 'content');
  if (content === undefined) return null;
  return {
    kind: change.kind,
    ...(change.path ? { path: change.path } : {}),
    ...(change.movePath ? { movePath: change.movePath } : {}),
    added: countContentLines(content),
    removed: 0,
    view: { kind: 'content', content },
  };
}

function materializeChange(change: FilePatchChangeDescriptor, index: number, input: ToolInputRecord | null): FilePatchChange | null {
  switch (change.view.kind) {
    case 'old-new':
      return materializeOldNew(change, input);
    case 'content':
      return materializeContent(change, input);
    case 'unified-diff':
      return materializeCodexDiff(change, index, input);
    default:
      return null;
  }
}

function materializeDisplayDescriptor(descriptor: FilePatchDisplayDescriptor, input: ToolInputRecord | null): FilePatchDisplay | null {
  const changes = descriptor.changes
    .map((change, index) => materializeChange(change, index, input))
    .filter((change): change is FilePatchChange => !!change);
  if (changes.length === 0) return null;
  return {
    kind: 'file_patch',
    version: 1,
    source: descriptor.source,
    ...(descriptor.status ? { status: descriptor.status } : {}),
    ...(descriptor.replaceAll ? { replaceAll: descriptor.replaceAll } : {}),
    summary: summaryFromChanges(changes),
    changes,
  };
}

function materializedBodyScore(display: FilePatchDisplay): number {
  let score = 0;
  for (const change of display.changes) {
    if (change.view.kind === 'old-new') {
      score += change.view.oldText.length + change.view.newText.length;
    } else if (change.view.kind === 'content') {
      score += change.view.content.length;
    } else {
      score += change.view.diff.length;
    }
  }
  return score;
}

export function resolveFilePatchDisplay(tool: FilePatchToolLike): FilePatchDisplay | null {
  const descriptor = normalizeDescriptor(tool.display) ?? buildFilePatchDisplayDescriptor(tool);
  if (!descriptor) return null;
  let fallback: FilePatchDisplay | null = null;
  for (const input of resolveToolInputRecords(tool)) {
    const display = materializeDisplayDescriptor(descriptor, input);
    if (!display) continue;
    if (materializedBodyScore(display) > 0) return display;
    fallback ??= display;
  }
  return fallback ?? materializeDisplayDescriptor(descriptor, null);
}

export function getFilePatchPrimaryPath(display: FilePatchDisplay | FilePatchDisplayDescriptor): string | undefined {
  return display.changes.find((change) => change.path)?.path;
}
