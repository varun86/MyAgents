/**
 * GlobalPluginsPanel — Settings page section for Claude Plugin management.
 *
 * PRD 0.2.17. Responsibilities:
 *   - List installed plugins with enabled/disabled toggle
 *   - Install from URL / GitHub shorthand / file:// local path
 *   - View per-plugin detail (manifest + component inventory)
 *   - Uninstall (with confirmation)
 *
 * Refresh strategy:
 *   - Settings is rendered OUTSIDE TabProvider (App.tsx routes settings
 *     before TabProvider mounts), so the per-Tab SSE bridge cannot deliver
 *     events here. Every user action therefore calls loadList() directly
 *     to refresh state — correct under all conditions including zero Chat
 *     tabs open and CLI-driven changes (handled by manual refresh).
 *   - The `myagents:plugins-changed` CustomEvent is still subscribed as a
 *     best-effort signal: if a Chat tab IS open and bridges the SSE event,
 *     we pick up that signal too. Belt and suspenders.
 *
 * Network calls go through the global API helpers (apiGetJson / apiPostJson),
 * not the Tab-scoped ones — plugin config is global, not per-Tab.
 */

import {
  Plus,
  Loader2,
  AlertTriangle,
  Trash2,
  FolderOpen,
  ChevronLeft,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import type {
  PluginListItem,
  PluginInstallProgressEvent,
  PluginComponentInventory,
} from '../../shared/types/plugin';

type ViewState =
  | { type: 'list' }
  | { type: 'detail'; id: string };

interface ListResponse {
  success: boolean;
  plugins?: PluginListItem[];
  error?: string;
}

interface DetailResponse {
  success: boolean;
  plugin?: PluginListItem;
  error?: string;
}

interface InstallResponse {
  success: boolean;
  entry?: PluginListItem;
  installId?: string;
  error?: string;
}

interface ActionResponse {
  success: boolean;
  error?: string;
}

export default function GlobalPluginsPanel({
  onDetailChange,
}: {
  onDetailChange?: (inDetail: boolean) => void;
}) {
  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; }, [toast]);

  const [viewState, setViewState] = useState<ViewState>({ type: 'list' });
  const onDetailChangeRef = useRef(onDetailChange);
  useEffect(() => { onDetailChangeRef.current = onDetailChange; }, [onDetailChange]);
  useEffect(() => {
    onDetailChangeRef.current?.(viewState.type !== 'list');
  }, [viewState.type]);

  const [loading, setLoading] = useState(true);
  const [plugins, setPlugins] = useState<PluginListItem[]>([]);
  const [detail, setDetail] = useState<PluginListItem | null>(null);

  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  // ----- list load --------------------------------------------------------
  const loadList = useCallback(async () => {
    try {
      const resp = await apiGetJson<ListResponse>('/api/cc-plugin/list');
      if (!isMountedRef.current) return;
      if (resp.success && Array.isArray(resp.plugins)) {
        setPlugins(resp.plugins);
      } else if (!resp.success) {
        toastRef.current.error(resp.error || '加载插件列表失败');
      }
    } catch (err) {
      console.error('[GlobalPluginsPanel] loadList failed:', err);
      if (isMountedRef.current) toastRef.current.error('加载插件列表失败');
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // Refresh on plugins:changed
  useEffect(() => {
    const onChanged = () => { loadList(); };
    window.addEventListener('myagents:plugins-changed', onChanged);
    return () => window.removeEventListener('myagents:plugins-changed', onChanged);
  }, [loadList]);

  // ----- detail load -------------------------------------------------------
  useEffect(() => {
    if (viewState.type !== 'detail') {
      setDetail(null);
      return;
    }
    const id = viewState.id;
    (async () => {
      try {
        const resp = await apiGetJson<DetailResponse>(
          `/api/cc-plugin/detail?id=${encodeURIComponent(id)}`,
        );
        if (!isMountedRef.current) return;
        if (resp.success && resp.plugin) {
          setDetail(resp.plugin);
        } else {
          toastRef.current.error(resp.error || '加载插件详情失败');
          setViewState({ type: 'list' });
        }
      } catch (err) {
        console.error('[GlobalPluginsPanel] loadDetail failed:', err);
        if (isMountedRef.current) toastRef.current.error('加载插件详情失败');
      }
    })();
  }, [viewState]);

  // ----- actions -----------------------------------------------------------
  const toggleEnabled = useCallback(async (item: PluginListItem) => {
    // Optimistic update so the switch responds immediately.
    setPlugins(prev =>
      prev.map(p => (p.id === item.id ? { ...p, enabled: !item.enabled } : p)),
    );
    try {
      const resp = await apiPostJson<ActionResponse>('/api/cc-plugin/toggle', {
        id: item.id,
        enabled: !item.enabled,
      });
      if (!resp.success) {
        toastRef.current.error(resp.error || '切换失败');
        loadList(); // resync — optimistic state was wrong
        return;
      }
      toastRef.current.success(item.enabled ? `已禁用 ${item.name}` : `已启用 ${item.name}`);
    } catch (err) {
      console.error('[GlobalPluginsPanel] toggle failed:', err);
      toastRef.current.error('切换失败');
      loadList();
    }
  }, [loadList]);

  const [confirmRemove, setConfirmRemove] = useState<PluginListItem | null>(null);
  const handleUninstall = useCallback(async () => {
    if (!confirmRemove) return;
    const item = confirmRemove;
    setConfirmRemove(null);
    try {
      const resp = await apiPostJson<ActionResponse & { removed?: PluginListItem; warning?: string }>(
        '/api/cc-plugin/uninstall',
        { id: item.id },
      );
      if (!resp.success) {
        toastRef.current.error(resp.error || '卸载失败');
        return;
      }
      if (resp.warning) {
        // Surface cleanup-failure warnings to the user (Fix #14: previously
        // swallowed → permanent TARGET_EXISTS on next install). Toast type
        // 'warning' isn't in the current Toast surface; use success+message.
        toastRef.current.success(`已卸载 ${item.name}（⚠ ${resp.warning}）`);
      } else {
        toastRef.current.success(`已卸载 ${item.name}`);
      }
      if (viewState.type === 'detail' && viewState.id === item.id) {
        setViewState({ type: 'list' });
      }
      // Settings is outside TabProvider — SSE bridge can't reach us.
      // Refresh directly so the uninstalled plugin disappears from the list.
      loadList();
    } catch (err) {
      console.error('[GlobalPluginsPanel] uninstall failed:', err);
      toastRef.current.error('卸载失败');
    }
  }, [confirmRemove, viewState, loadList]);

  // ----- install dialog ----------------------------------------------------
  const [showInstall, setShowInstall] = useState(false);

  // ----- render ------------------------------------------------------------
  if (viewState.type === 'detail' && detail) {
    return (
      <PluginDetailView
        plugin={detail}
        onBack={() => setViewState({ type: 'list' })}
        onToggle={() => toggleEnabled(detail)}
        onUninstall={() => setConfirmRemove(detail)}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-[var(--ink)]">插件 Plugins</h2>
          <p className="mt-1 text-sm text-[var(--ink-muted)]">
            Claude 插件 (skills + agents + hooks + MCP) — 来自 GitHub 或本地目录
          </p>
          <p className="mt-1 text-xs text-[var(--ink-muted)]">
            ⓘ 仅作用于 MyAgents 自带 Runtime。如果工作区切换到 Claude Code / Codex / Gemini 等外部 Runtime，请在该 CLI 内用 <code className="font-mono text-[11px]">/plugin</code> 管理插件。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowInstall(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          安装插件
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-[var(--ink-muted)]">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="ml-2 text-sm">加载中…</span>
        </div>
      ) : plugins.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border)] py-16 text-center text-sm text-[var(--ink-muted)]">
          尚未安装任何插件。点右上角「安装插件」从 GitHub 或本地路径添加。
        </div>
      ) : (
        <ul className="space-y-2">
          {plugins.map(item => (
            <PluginCard
              key={item.id}
              item={item}
              onOpen={() => setViewState({ type: 'detail', id: item.id })}
              onToggle={() => toggleEnabled(item)}
            />
          ))}
        </ul>
      )}

      {showInstall && (
        <PluginInstallDialog
          onClose={() => setShowInstall(false)}
          onInstalled={() => {
            setShowInstall(false);
            // Settings is outside TabProvider — SSE bridge can't reach us.
            // Refresh directly so the new plugin shows up immediately.
            loadList();
          }}
        />
      )}

      {confirmRemove && (
        <ConfirmDialog
          title={`卸载 ${confirmRemove.name}?`}
          message="将删除插件目录并从启用列表移除。数据目录（${CLAUDE_PLUGIN_DATA}）默认保留。"
          confirmText="卸载"
          confirmVariant="danger"
          onConfirm={handleUninstall}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Plugin Card
// ============================================================================

function PluginCard({
  item,
  onOpen,
  onToggle,
}: {
  item: PluginListItem;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const isBad = item.status !== 'ok';
  return (
    <li
      className={`group rounded-lg border ${
        isBad ? 'border-amber-400/50 bg-amber-500/5' : 'border-[var(--border)]'
      } px-4 py-3 hover:bg-[var(--hover-bg)] cursor-pointer transition-colors`}
      onClick={onOpen}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {isBad && <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />}
            <h3 className="truncate text-base font-medium text-[var(--ink)]">
              {item.name}
            </h3>
            {item.version && (
              <span className="shrink-0 text-xs text-[var(--ink-muted)]">
                v{item.version}
              </span>
            )}
          </div>
          {item.description && (
            <p className="mt-0.5 line-clamp-1 text-sm text-[var(--ink-muted)]">
              {item.description}
            </p>
          )}
          {item.warning && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
              ⚠ {item.warning}
            </p>
          )}
        </div>
        <div className="shrink-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            disabled={isBad}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              item.enabled
                ? 'bg-[var(--accent)]'
                : 'bg-[var(--border)]'
            } ${isBad ? 'opacity-50 cursor-not-allowed' : ''}`}
            title={item.enabled ? '禁用插件' : '启用插件'}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                item.enabled ? 'translate-x-5' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>
    </li>
  );
}

// ============================================================================
// Detail View
// ============================================================================

function PluginDetailView({
  plugin,
  onBack,
  onToggle,
  onUninstall,
}: {
  plugin: PluginListItem;
  onBack: () => void;
  onToggle: () => void;
  onUninstall: () => void;
}) {
  const components = plugin.components;
  const openInFinder = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('cmd_open_path_external', { path: plugin.installPath });
    } catch (err) {
      console.warn('[GlobalPluginsPanel] open in finder failed:', err);
    }
  }, [plugin.installPath]);

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-sm text-[var(--ink-muted)] hover:text-[var(--ink)]"
      >
        <ChevronLeft className="h-4 w-4" />
        返回列表
      </button>

      <div>
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-[var(--ink)]">{plugin.name}</h2>
          {plugin.version && (
            <span className="text-sm text-[var(--ink-muted)]">v{plugin.version}</span>
          )}
        </div>
        {plugin.description && (
          <p className="mt-2 text-sm text-[var(--ink-muted)]">{plugin.description}</p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onToggle}
          disabled={plugin.status !== 'ok'}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50"
        >
          {plugin.enabled ? '禁用' : '启用'}
        </button>
        <button
          type="button"
          onClick={openInFinder}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--hover-bg)]"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          打开目录
        </button>
        <button
          type="button"
          onClick={onUninstall}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-400/40 px-3 py-1.5 text-sm text-red-600 hover:bg-red-500/10 dark:text-red-400"
        >
          <Trash2 className="h-3.5 w-3.5" />
          卸载
        </button>
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-[var(--ink)]">元数据</h3>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <MetaRow label="作者" value={plugin.author} />
          <MetaRow label="License" value={plugin.license} />
          <MetaRow label="主页" value={plugin.homepage} link />
          <MetaRow label="仓库" value={plugin.repository} link />
          <MetaRow label="来源" value={plugin.sourceUrl} />
          <MetaRow label="安装路径" value={plugin.installPath} mono />
          <MetaRow label="安装时间" value={new Date(plugin.installedAt).toLocaleString()} />
        </dl>
      </section>

      {components && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-[var(--ink)]">组件清单</h3>
          <ComponentInventoryGrid inv={components} />
        </section>
      )}
    </div>
  );
}

/** http(s)-only allow-list mirroring server-side `isSafeWebUrl`. Defense in
 *  depth — server already drops dangerous schemes from the manifest, but
 *  legacy AppConfig entries written before this fix could still contain
 *  attacker-controlled values. */
function isSafeWebUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function MetaRow({
  label,
  value,
  link,
  mono,
}: {
  label: string;
  value?: string;
  link?: boolean;
  mono?: boolean;
}) {
  if (!value) return null;
  const renderAsLink = link && isSafeWebUrl(value);
  return (
    <>
      <dt className="text-[var(--ink-muted)]">{label}</dt>
      <dd className={`break-all ${mono ? 'font-mono text-xs' : ''}`}>
        {renderAsLink ? (
          <a
            href={value}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--accent)] hover:underline"
          >
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </>
  );
}

function ComponentInventoryGrid({ inv }: { inv: PluginComponentInventory }) {
  const blocks: Array<[string, string[] | number | boolean]> = [
    ['Skills', inv.skills],
    ['Commands', inv.commands],
    ['Agents', inv.agents],
    ['MCP servers', inv.mcpServers],
    ['LSP servers', inv.lspServers],
    ['Monitors', inv.monitors],
  ];
  return (
    <div className="grid grid-cols-2 gap-3">
      {blocks.map(([label, value]) => (
        <ComponentBlock key={label} label={label} value={value} />
      ))}
      <div className="rounded-lg border border-[var(--border)] px-3 py-2">
        <div className="text-xs text-[var(--ink-muted)]">Hooks</div>
        <div className="mt-1 text-sm">{inv.hooks} 个事件处理器</div>
      </div>
      <div className="rounded-lg border border-[var(--border)] px-3 py-2">
        <div className="text-xs text-[var(--ink-muted)]">Bin</div>
        <div className="mt-1 text-sm">{inv.hasBin ? '✓ 有可执行文件' : '— 无'}</div>
      </div>
    </div>
  );
}

function ComponentBlock({
  label,
  value,
}: {
  label: string;
  value: string[] | number | boolean;
}) {
  const items = Array.isArray(value) ? value : [];
  const count = items.length;
  return (
    <div className="rounded-lg border border-[var(--border)] px-3 py-2">
      <div className="text-xs text-[var(--ink-muted)]">{label}</div>
      <div className="mt-1 text-sm">
        {count === 0 ? <span className="text-[var(--ink-muted)]">— 无</span> : `${count} 个`}
      </div>
      {count > 0 && (
        <div className="mt-1 line-clamp-2 text-xs text-[var(--ink-muted)]">
          {items.join(', ')}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Install Dialog
// ============================================================================

type InstallPhase = PluginInstallProgressEvent['phase'];

function PluginInstallDialog({
  onClose,
  onInstalled,
}: {
  onClose: () => void;
  onInstalled: () => void;
}) {
  const toast = useToast();
  const toastRef = useRef(toast);
  // React 19's react-hooks/refs rule disallows assigning refs during render;
  // sync via useEffect instead (no observable behaviour change — toast is a
  // stable callback object across renders in practice).
  useEffect(() => { toastRef.current = toast; }, [toast]);

  const [sourceUrl, setSourceUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const installIdRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<InstallPhase | null>(null);
  const [phaseMsg, setPhaseMsg] = useState('');

  // Cmd+W close — without this hook, Cmd+W skips the dialog and closes the
  // Tab (CLAUDE.md "新增 overlay / 可关闭面板不调 useCloseLayer" red-line).
  // Suppress closure while an install is in flight so user can't accidentally
  // background a 60s download.
  useCloseLayer(() => {
    if (submitting) return false;
    onClose();
    return true;
  }, 50);

  useEffect(() => {
    const onProgress = (evt: Event) => {
      const detail = (evt as CustomEvent<PluginInstallProgressEvent>).detail;
      if (!detail || !installIdRef.current || detail.installId !== installIdRef.current) {
        return;
      }
      setPhase(detail.phase);
      setPhaseMsg(detail.message || detail.error || '');
    };
    window.addEventListener('myagents:plugin-install-progress', onProgress);
    return () => window.removeEventListener('myagents:plugin-install-progress', onProgress);
  }, []);

  const handleInstall = useCallback(async () => {
    if (!sourceUrl.trim()) {
      toastRef.current.error('请填写来源地址');
      return;
    }
    setSubmitting(true);
    setPhase('fetching');
    const installId = crypto.randomUUID();
    installIdRef.current = installId;
    try {
      const resp = await apiPostJson<InstallResponse>('/api/cc-plugin/install', {
        sourceUrl: sourceUrl.trim(),
        installId,
      });
      if (!resp.success) {
        toastRef.current.error(resp.error || '安装失败');
        setSubmitting(false);
        setPhase('failed');
        return;
      }
      toastRef.current.success(`已安装 ${resp.entry?.name ?? ''}`);
      onInstalled();
    } catch (err) {
      console.error('[PluginInstallDialog] install failed:', err);
      toastRef.current.error(err instanceof Error ? err.message : '安装失败');
      setSubmitting(false);
      setPhase('failed');
    }
  }, [sourceUrl, onInstalled]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-xl bg-[var(--surface)] p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-[var(--ink)]">安装插件</h2>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">
          支持：GitHub 仓库（<code className="text-xs">owner/repo</code> 或完整 URL）、直链 zip、<code className="text-xs">file:///</code> 本地目录
        </p>

        <label className="mt-4 block">
          <span className="text-sm text-[var(--ink-muted)]">来源地址</span>
          <input
            type="text"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            disabled={submitting}
            placeholder="anthropics/example-plugin 或 https://github.com/... 或 file:///..."
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
            autoFocus
          />
        </label>

        <div className="mt-4 rounded-lg border border-amber-400/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-500">
          ⚠ 插件以你的用户权限运行任意代码 / 启动 MCP 进程 / 触发 hook 脚本。仅安装可信来源。
        </div>

        {phase && (
          <div className="mt-4 rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              {phase !== 'done' && phase !== 'failed' && <Loader2 className="h-3 w-3 animate-spin" />}
              <span className="font-medium text-[var(--ink)]">{phaseLabel(phase)}</span>
            </div>
            {phaseMsg && <div className="mt-1 break-all text-[var(--ink-muted)]">{phaseMsg}</div>}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleInstall}
            disabled={submitting || !sourceUrl.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            开始安装
          </button>
        </div>
      </div>
    </div>
  );
}

function phaseLabel(phase: InstallPhase): string {
  switch (phase) {
    case 'fetching': return '抓取中…';
    case 'extracting': return '解压中…';
    case 'validating': return '校验中…';
    case 'writing': return '写入磁盘…';
    case 'done': return '✓ 安装完成';
    case 'failed': return '✗ 安装失败';
    default: return phase;
  }
}
