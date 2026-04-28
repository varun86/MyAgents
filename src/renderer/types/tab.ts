// Tab types for multi-tab architecture

import type { ImageAttachment } from '@/components/SimpleChatInput';
import type { PermissionMode } from '@/config/types';

/** Message data passed from Launcher to Chat for auto-send on workspace open.
 *  Security: Only stores providerId, never the API key. Chat builds providerEnv at send time.
 *
 *  Provider/model pairing (PRD 0.2.3):
 *    - builtinSelection: builtin runtime 的 (provider, model) 二元组。类型上强制成对，
 *      消除「传 providerId 不传 model」导致的 env/model 错配（OPEN_AI_DISCUSSION P1）。
 *      只能由 resolveBuiltinSelection helper 构造，不允许手拼。
 *    - runtimeModel: external runtime（CC / Codex / Gemini）的 model；没有 provider 概念。
 *    两者互斥：调用方根据当前 runtime 维度只填其一。 */
export interface InitialMessage {
    text: string;
    images?: ImageAttachment[];
    permissionMode?: PermissionMode;
    mcpEnabledServers?: string[];
    /** Builtin runtime 的 (provider, model) 选择 — 类型上强制成对 */
    builtinSelection?: { providerId: string; model: string };
    /** External runtime 的 model — 没有 provider 概念 */
    runtimeModel?: string;
}

export interface Tab {
    id: string;
    agentDir: string | null;  // null = showing Launcher
    sessionId: string | null; // null = not started
    view: 'launcher' | 'chat' | 'settings' | 'taskcenter';
    title: string;            // Display title for the tab
    isGenerating?: boolean;   // true = AI is outputting, used for close confirmation
    hasUnread?: boolean;      // true = task completed but user hasn't viewed this tab yet
    initialMessage?: InitialMessage;  // Launcher → Chat auto-send message
    // Note: cronTaskId and sidecarPort are no longer stored in Tab.
    // Sidecar lifecycle is now managed by SidecarManager's Owner model.
    // Use getSessionPort(sessionId) to get the port when needed.
    joinedExistingSidecar?: boolean;  // Tab joined an already-running sidecar (e.g. IM Bot session)
}

export interface TabState {
    tabs: Tab[];
    activeTabId: string | null;
}

// Maximum number of tabs allowed
export const MAX_TABS = 10;

// Generate unique tab ID
export function generateTabId(): string {
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Generate session title from first message
export function generateSessionTitle(firstMessage: string): string {
    const maxLength = 20;
    const trimmed = firstMessage.trim();
    if (!trimmed) {
        return 'New Chat';
    }
    if (trimmed.length <= maxLength) {
        return trimmed;
    }
    return trimmed.slice(0, maxLength) + '...';
}

// Get folder name from path (supports both / and \ separators)
export function getFolderName(path: string): string {
    // Normalize path separators and split
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    return parts[parts.length - 1] || path;
}

// Create a new empty tab (shows Launcher)
export function createNewTab(): Tab {
    return {
        id: generateTabId(),
        agentDir: null,
        sessionId: null,
        view: 'launcher',
        title: 'New Tab',
    };
}
