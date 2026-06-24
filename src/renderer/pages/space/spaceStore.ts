import {
  spaceCloseOwnIssue,
  spaceCommentIssue,
  spaceCreateIssue,
  spaceDispatchIssue,
  spaceGetIssue,
  spaceGetOfficial,
  spaceGetSession,
  spaceGetSkill,
  spaceGetSkillFile,
  spaceInstallSkill,
  spaceListIssues,
  spaceListLocalAgents,
  spaceListSkills,
  spaceLogout,
  spaceProcessDispatchesOnce,
  spaceRegisterAgent,
  spaceSetIssueStatus,
  spaceUploadIssueAttachments,
  spaceUploadSkillZip,
  type LocalRegisteredAgent,
  type SpaceAttachment,
  type SpaceIssue,
  type SpaceIssueDetail,
  type SpaceSession,
  type SpaceSkill,
  type SpaceSkillDetail,
  type SpaceTag,
} from '@/api/spaceCloud';
import type { IssueQueryParams } from './spaceHelpers';
import { buildIssueQueryKey } from './spaceHelpers';

export const SPACE_VISIBLE_REFRESH_TTL_MS = 30_000;

type BootState = 'idle' | 'loading' | 'ready' | 'signedOut' | 'error';

export interface SpaceIssueListState {
  items: SpaceIssue[];
  hasMore: boolean;
  nextCursor?: string | null;
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

export interface SpaceIssueDetailState {
  detail: SpaceIssueDetail | null;
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

interface SpaceSkillsState {
  items: SpaceSkill[];
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

export interface SpaceSkillDetailState {
  detail: SpaceSkillDetail | null;
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

export interface SpaceSkillFileState {
  text: string;
  binary?: boolean;
  mimeType?: string;
  sizeBytes?: number;
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

interface SpaceAgentsState {
  items: LocalRegisteredAgent[];
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

interface StoreState {
  boot: BootState;
  session: SpaceSession | null;
  tags: SpaceTag[];
  bootError: string | null;
  bootLastFetchedAt: number;
  issuesByKey: Record<string, SpaceIssueListState>;
  issueDetails: Record<string, SpaceIssueDetailState>;
  skills: SpaceSkillsState;
  skillDetails: Record<string, SpaceSkillDetailState>;
  skillFiles: Record<string, SpaceSkillFileState>;
  localAgents: SpaceAgentsState;
}

export interface SpaceDataSnapshot extends StoreState {
  actions: SpaceActions;
}

interface RefreshOptions {
  force?: boolean;
  silent?: boolean;
  maxAgeMs?: number;
}

export interface SpaceActions {
  ensureBootstrapped: (options?: RefreshOptions) => Promise<void>;
  refreshIssues: (params: IssueQueryParams, options?: RefreshOptions) => Promise<void>;
  refreshIssueDetail: (issueId: string, options?: RefreshOptions) => Promise<void>;
  refreshSkills: (options?: RefreshOptions) => Promise<void>;
  refreshSkillDetail: (skillId: string, options?: RefreshOptions) => Promise<void>;
  refreshSkillFile: (skillId: string, path: string, options?: RefreshOptions) => Promise<void>;
  refreshLocalAgents: (options?: RefreshOptions) => Promise<void>;
  createIssue: (input: { title: string; body: string; tags: string[] }) => Promise<SpaceIssue>;
  uploadIssueAttachments: (issueId: string, filePaths: string[]) => Promise<SpaceAttachment[]>;
  commentIssue: (issueId: string, body: string) => Promise<void>;
  setIssueStatus: (issueId: string, status: string) => Promise<void>;
  closeOwnIssue: (issueId: string) => Promise<void>;
  dispatchIssue: (issueId: string, registeredAgentId: string) => Promise<void>;
  processDispatchesOnce: () => Promise<{ processed: number; delivered: number; errors: string[] }>;
  uploadSkillZip: (input: { filePath: string; name?: string; description?: string; skillId?: string }) => Promise<SpaceSkill>;
  installSkill: (input: { skillId: string; skillName: string; target: 'global' | 'project'; workspacePath?: string }) => Promise<{ installedName: string; installedPath: string; target: string; renamed: boolean }>;
  registerAgent: (input: { displayName: string; workspaceId: string; workspacePath: string; workspaceLabel?: string; goalMd: string }) => Promise<LocalRegisteredAgent>;
  logout: () => Promise<void>;
}

const EMPTY_ISSUE_LIST: SpaceIssueListState = {
  items: [],
  hasMore: false,
  nextCursor: null,
  lastFetchedAt: 0,
  isLoading: false,
  error: null,
};

const initialState = (): StoreState => ({
  boot: 'idle',
  session: null,
  tags: [],
  bootError: null,
  bootLastFetchedAt: 0,
  issuesByKey: {},
  issueDetails: {},
  skills: {
    items: [],
    lastFetchedAt: 0,
    isLoading: false,
    error: null,
  },
  skillDetails: {},
  skillFiles: {},
  localAgents: {
    items: [],
    lastFetchedAt: 0,
    isLoading: false,
    error: null,
  },
});

let state: StoreState = initialState();
const listeners = new Set<() => void>();
let snapshot!: SpaceDataSnapshot;
let bootPromise: Promise<void> | null = null;
let seq = 0;
const latestSeqByKey = new Map<string, number>();
const inFlightRequests = new Map<string, Promise<void>>();

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildSnapshot(): SpaceDataSnapshot {
  return { ...state, actions };
}

function emit(): void {
  snapshot = buildSnapshot();
  for (const listener of listeners) listener();
}

function setState(patch: Partial<StoreState>): void {
  state = { ...state, ...patch };
  emit();
}

function startRequest(key: string): number {
  const next = ++seq;
  latestSeqByKey.set(key, next);
  return next;
}

function isLatest(key: string, requestSeq: number): boolean {
  return latestSeqByKey.get(key) === requestSeq;
}

function isFresh(lastFetchedAt: number, maxAgeMs?: number): boolean {
  return Boolean(maxAgeMs && lastFetchedAt > 0 && Date.now() - lastFetchedAt < maxAgeMs);
}

function ensureReady(): boolean {
  return state.boot === 'ready' && Boolean(state.session);
}

function runRequest(key: string, force: boolean | undefined, task: () => Promise<void>): Promise<void> {
  if (!force) {
    const existing = inFlightRequests.get(key);
    if (existing) return existing;
  }
  const promise = task().finally(() => {
    if (inFlightRequests.get(key) === promise) {
      inFlightRequests.delete(key);
    }
  });
  inFlightRequests.set(key, promise);
  return promise;
}

function normalizeIssueQueryParams(params: IssueQueryParams): IssueQueryParams {
  return {
    q: params.q?.trim() || undefined,
    tag: params.tag?.trim() || undefined,
    status: params.status?.trim() || undefined,
    cursor: params.cursor?.trim() || undefined,
    limit: params.limit ?? 50,
  };
}

function issueMatchesListKey(issue: SpaceIssue, key: string): boolean {
  const params = new URLSearchParams(key);
  const cursor = params.get('cursor')?.trim();
  if (cursor) return false;

  const status = params.get('status')?.trim();
  if (status && issue.status !== status) return false;

  const tag = params.get('tag')?.trim().toLowerCase();
  if (tag && !issue.tags?.some((item) => item.name.toLowerCase() === tag)) return false;

  const q = params.get('q')?.trim().toLowerCase();
  if (q && !issue.title.toLowerCase().includes(q)) return false;

  return true;
}

export function getIssueListState(params: IssueQueryParams): SpaceIssueListState {
  return state.issuesByKey[buildIssueQueryKey(params)] ?? EMPTY_ISSUE_LIST;
}

function patchIssueInLists(issue: SpaceIssue): void {
  const issuesByKey = Object.fromEntries(
    Object.entries(state.issuesByKey).map(([key, slice]) => {
      const items = slice.items.flatMap((item) => {
        if (item.id !== issue.id) return [item];
        const next = { ...item, ...issue };
        return issueMatchesListKey(next, key) ? [next] : [];
      });
      const hasIssue = items.some((item) => item.id === issue.id);
      return [
        key,
        {
        ...slice,
          items: !hasIssue && issueMatchesListKey(issue, key) ? [issue, ...items] : items,
        },
      ];
    }),
  );
  const existingDetail = state.issueDetails[issue.id];
  const issueDetails = existingDetail?.detail
    ? {
        ...state.issueDetails,
        [issue.id]: {
          ...existingDetail,
          detail: { ...existingDetail.detail, issue: { ...existingDetail.detail.issue, ...issue } },
        },
      }
    : state.issueDetails;
  setState({ issuesByKey, issueDetails });
}

function prependIssueToLists(issue: SpaceIssue): void {
  const issuesByKey = Object.fromEntries(
    Object.entries(state.issuesByKey).map(([key, slice]) => {
      if (!issueMatchesListKey(issue, key)) return [key, slice];
      const withoutDuplicate = slice.items.filter((item) => item.id !== issue.id);
      return [key, { ...slice, items: [issue, ...withoutDuplicate] }];
    }),
  );
  setState({ issuesByKey });
}

function patchIssueDetail(issueId: string, patch: (detail: SpaceIssueDetail) => SpaceIssueDetail): void {
  const current = state.issueDetails[issueId];
  if (!current?.detail) return;
  setState({
    issueDetails: {
      ...state.issueDetails,
      [issueId]: { ...current, detail: patch(current.detail) },
    },
  });
}

function skillFileKey(skillId: string, path: string): string {
  return `${skillId}\n${path}`;
}

export const actions: SpaceActions = {
  ensureBootstrapped: async (options: RefreshOptions = {}) => {
    if (
      !options.force
      && (state.boot === 'ready' || state.boot === 'signedOut')
      && (!options.maxAgeMs || isFresh(state.bootLastFetchedAt, options.maxAgeMs))
    ) {
      return;
    }
    if (bootPromise && !options.force) return bootPromise;
    if (!options.silent) setState({ boot: 'loading', bootError: null });
    const requestSeq = startRequest('boot');
    bootPromise = (async () => {
      try {
        const session = await spaceGetSession();
        if (!isLatest('boot', requestSeq)) return;
        if (!session) {
          setState({
            ...initialState(),
            boot: 'signedOut',
            bootLastFetchedAt: Date.now(),
          });
          return;
        }
        const official = await spaceGetOfficial();
        if (!isLatest('boot', requestSeq)) return;
        setState({
          boot: 'ready',
          session,
          tags: official.tags,
          bootError: null,
          bootLastFetchedAt: Date.now(),
        });
      } catch (error) {
        if (!isLatest('boot', requestSeq)) return;
        if (options.silent && (state.boot === 'ready' || state.boot === 'signedOut')) {
          setState({ bootError: errMessage(error) });
          return;
        }
        setState({
          boot: 'error',
          bootError: errMessage(error),
        });
      } finally {
        if (isLatest('boot', requestSeq)) bootPromise = null;
      }
    })();
    return bootPromise;
  },

  refreshIssues: async (params: IssueQueryParams, options: RefreshOptions = {}) => {
    if (!ensureReady()) return;
    const normalizedParams = normalizeIssueQueryParams(params);
    const key = buildIssueQueryKey(normalizedParams);
    const current = state.issuesByKey[key] ?? EMPTY_ISSUE_LIST;
    if (!options.force && isFresh(current.lastFetchedAt, options.maxAgeMs)) return;
    const requestKey = `issues:${key}`;
    return runRequest(requestKey, options.force, async () => {
      const requestSeq = startRequest(requestKey);
      setState({
        issuesByKey: {
          ...state.issuesByKey,
          [key]: { ...current, isLoading: true, error: options.silent ? current.error : null },
        },
      });
      try {
        const result = await spaceListIssues(normalizedParams);
        if (!isLatest(requestKey, requestSeq)) return;
        setState({
          issuesByKey: {
            ...state.issuesByKey,
            [key]: {
              items: result.items,
              hasMore: result.hasMore,
              nextCursor: result.nextCursor,
              lastFetchedAt: Date.now(),
              isLoading: false,
              error: null,
            },
          },
        });
      } catch (error) {
        if (!isLatest(requestKey, requestSeq)) return;
        const latest = state.issuesByKey[key] ?? current;
        setState({
          issuesByKey: {
            ...state.issuesByKey,
            [key]: { ...latest, isLoading: false, error: errMessage(error) },
          },
        });
        throw error;
      }
    });
  },

  refreshIssueDetail: async (issueId: string, options: RefreshOptions = {}) => {
    if (!ensureReady() || !issueId) return;
    const current = state.issueDetails[issueId] ?? { detail: null, lastFetchedAt: 0, isLoading: false, error: null };
    if (!options.force && isFresh(current.lastFetchedAt, options.maxAgeMs)) return;
    const requestKey = `issue:${issueId}`;
    return runRequest(requestKey, options.force, async () => {
      const requestSeq = startRequest(requestKey);
      setState({
        issueDetails: {
          ...state.issueDetails,
          [issueId]: { ...current, isLoading: true, error: options.silent ? current.error : null },
        },
      });
      try {
        const detail = await spaceGetIssue(issueId);
        if (!isLatest(requestKey, requestSeq)) return;
        setState({
          issueDetails: {
            ...state.issueDetails,
            [issueId]: { detail, lastFetchedAt: Date.now(), isLoading: false, error: null },
          },
        });
        patchIssueInLists(detail.issue);
      } catch (error) {
        if (!isLatest(requestKey, requestSeq)) return;
        const latest = state.issueDetails[issueId] ?? current;
        setState({
          issueDetails: {
            ...state.issueDetails,
            [issueId]: { ...latest, isLoading: false, error: errMessage(error) },
          },
        });
        throw error;
      }
    });
  },

  refreshSkills: async (options: RefreshOptions = {}) => {
    if (!ensureReady()) return;
    if (!options.force && isFresh(state.skills.lastFetchedAt, options.maxAgeMs)) return;
    return runRequest('skills', options.force, async () => {
      const requestSeq = startRequest('skills');
      setState({ skills: { ...state.skills, isLoading: true, error: options.silent ? state.skills.error : null } });
      try {
        const result = await spaceListSkills();
        if (!isLatest('skills', requestSeq)) return;
        setState({
          skills: {
            items: result.items,
            lastFetchedAt: Date.now(),
            isLoading: false,
            error: null,
          },
        });
      } catch (error) {
        if (!isLatest('skills', requestSeq)) return;
        setState({ skills: { ...state.skills, isLoading: false, error: errMessage(error) } });
        throw error;
      }
    });
  },

  refreshSkillDetail: async (skillId: string, options: RefreshOptions = {}) => {
    if (!ensureReady() || !skillId) return;
    const current = state.skillDetails[skillId] ?? { detail: null, lastFetchedAt: 0, isLoading: false, error: null };
    if (!options.force && isFresh(current.lastFetchedAt, options.maxAgeMs)) return;
    const requestKey = `skill:${skillId}`;
    return runRequest(requestKey, options.force, async () => {
      const requestSeq = startRequest(requestKey);
      setState({ skillDetails: { ...state.skillDetails, [skillId]: { ...current, isLoading: true, error: options.silent ? current.error : null } } });
      try {
        const detail = await spaceGetSkill(skillId);
        if (!isLatest(requestKey, requestSeq)) return;
        setState({
          skillDetails: {
            ...state.skillDetails,
            [skillId]: { detail, lastFetchedAt: Date.now(), isLoading: false, error: null },
          },
        });
      } catch (error) {
        if (!isLatest(requestKey, requestSeq)) return;
        setState({
          skillDetails: {
            ...state.skillDetails,
            [skillId]: { ...current, isLoading: false, error: errMessage(error) },
          },
        });
        throw error;
      }
    });
  },

  refreshSkillFile: async (skillId: string, path: string, options: RefreshOptions = {}) => {
    if (!ensureReady() || !skillId || !path) return;
    const key = skillFileKey(skillId, path);
    const current = state.skillFiles[key] ?? { text: '', lastFetchedAt: 0, isLoading: false, error: null };
    if (!options.force && isFresh(current.lastFetchedAt, options.maxAgeMs)) return;
    const requestKey = `skill-file:${key}`;
    return runRequest(requestKey, options.force, async () => {
      const requestSeq = startRequest(requestKey);
      setState({ skillFiles: { ...state.skillFiles, [key]: { ...current, isLoading: true, error: options.silent ? current.error : null } } });
      try {
        const result = await spaceGetSkillFile(skillId, path);
        if (!isLatest(requestKey, requestSeq)) return;
        setState({
          skillFiles: {
            ...state.skillFiles,
            [key]: {
              text: result.binary ? `Binary file · ${result.mimeType ?? 'unknown'} · ${formatBytesForStore(result.sizeBytes)}` : result.text ?? '',
              binary: result.binary,
              mimeType: result.mimeType,
              sizeBytes: result.sizeBytes,
              lastFetchedAt: Date.now(),
              isLoading: false,
              error: null,
            },
          },
        });
      } catch (error) {
        if (!isLatest(requestKey, requestSeq)) return;
        setState({ skillFiles: { ...state.skillFiles, [key]: { ...current, isLoading: false, error: errMessage(error) } } });
        throw error;
      }
    });
  },

  refreshLocalAgents: async (options: RefreshOptions = {}) => {
    if (!ensureReady()) return;
    if (!options.force && isFresh(state.localAgents.lastFetchedAt, options.maxAgeMs)) return;
    return runRequest('agents', options.force, async () => {
      const requestSeq = startRequest('agents');
      setState({ localAgents: { ...state.localAgents, isLoading: true, error: options.silent ? state.localAgents.error : null } });
      try {
        const items = await spaceListLocalAgents();
        if (!isLatest('agents', requestSeq)) return;
        setState({
          localAgents: {
            items,
            lastFetchedAt: Date.now(),
            isLoading: false,
            error: null,
          },
        });
      } catch (error) {
        if (!isLatest('agents', requestSeq)) return;
        setState({ localAgents: { ...state.localAgents, isLoading: false, error: errMessage(error) } });
        throw error;
      }
    });
  },

  createIssue: async (input) => {
    const result = await spaceCreateIssue(input);
    prependIssueToLists(result.issue);
    return result.issue;
  },

  uploadIssueAttachments: async (issueId, filePaths) => {
    const result = await spaceUploadIssueAttachments({ issueId, filePaths });
    patchIssueDetail(issueId, (detail) => ({
      ...detail,
      attachments: [...detail.attachments, ...result.attachments],
      issue: {
        ...detail.issue,
        attachmentCount: (detail.issue.attachmentCount ?? detail.attachments.length) + result.attachments.length,
      },
    }));
    const currentIssue = state.issueDetails[issueId]?.detail?.issue;
    if (currentIssue) patchIssueInLists(currentIssue);
    return result.attachments;
  },

  commentIssue: async (issueId, body) => {
    const result = await spaceCommentIssue(issueId, body);
    patchIssueDetail(issueId, (detail) => ({
      ...detail,
      comments: {
        ...detail.comments,
        items: [...detail.comments.items, result.comment],
      },
      issue: {
        ...detail.issue,
        commentCount: (detail.issue.commentCount ?? detail.comments.items.length) + 1,
      },
    }));
    const currentIssue = state.issueDetails[issueId]?.detail?.issue;
    if (currentIssue) patchIssueInLists(currentIssue);
  },

  setIssueStatus: async (issueId, status) => {
    const result = await spaceSetIssueStatus(issueId, status);
    const current = state.issueDetails[issueId]?.detail?.issue ?? findIssueInLists(issueId);
    if (current) patchIssueInLists({ ...current, status: result.status, updatedAt: result.updatedAt });
  },

  closeOwnIssue: async (issueId) => {
    const result = await spaceCloseOwnIssue(issueId);
    const current = state.issueDetails[issueId]?.detail?.issue ?? findIssueInLists(issueId);
    if (current) patchIssueInLists({ ...current, status: result.status, updatedAt: result.updatedAt });
  },

  dispatchIssue: async (issueId, registeredAgentId) => {
    await spaceDispatchIssue(issueId, registeredAgentId);
    const current = state.issueDetails[issueId]?.detail?.issue ?? findIssueInLists(issueId);
    if (current) patchIssueInLists({ ...current, status: 'in_progress' });
  },

  processDispatchesOnce: () => spaceProcessDispatchesOnce(),

  uploadSkillZip: async (input) => {
    const result = await spaceUploadSkillZip(input);
    setState({
      skills: {
        ...state.skills,
        items: [result.skill, ...state.skills.items.filter((skill) => skill.id !== result.skill.id)],
      },
    });
    return result.skill;
  },

  installSkill: (input) => spaceInstallSkill(input),

  registerAgent: async (input) => {
    const agent = await spaceRegisterAgent(input);
    setState({
      localAgents: {
        ...state.localAgents,
        items: [agent, ...state.localAgents.items.filter((item) => item.id !== agent.id)],
      },
    });
    return agent;
  },

  logout: async () => {
    await spaceLogout();
    setState({ ...initialState(), boot: 'signedOut' });
  },
};

function findIssueInLists(issueId: string): SpaceIssue | null {
  for (const list of Object.values(state.issuesByKey)) {
    const found = list.items.find((issue) => issue.id === issueId);
    if (found) return found;
  }
  return null;
}

function formatBytesForStore(value?: number | null): string {
  if (!value || value <= 0) return '0 KB';
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

snapshot = buildSnapshot();

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (state.boot === 'idle') {
    void actions.ensureBootstrapped();
  }
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): SpaceDataSnapshot {
  return snapshot;
}

export function getSkillFileState(skillId: string, path: string): SpaceSkillFileState | null {
  return state.skillFiles[skillFileKey(skillId, path)] ?? null;
}

export function __resetSpaceStoreForTest(): void {
  state = initialState();
  listeners.clear();
  bootPromise = null;
  seq = 0;
  latestSeqByKey.clear();
  inFlightRequests.clear();
  snapshot = buildSnapshot();
}

export function __setSpaceStoreStateForTest(patch: Partial<StoreState>): void {
  setState(patch);
}
