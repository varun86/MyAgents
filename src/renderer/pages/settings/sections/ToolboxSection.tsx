import { Globe, ImageIcon, Loader2, Plus, Settings2, Wrench } from 'lucide-react';

import { CliToolsSection } from '@/components/CliToolsSection';
import type { McpServerDefinition } from '@/config/types';
import type { OfficialToolDefinition, OfficialToolId } from '@/../shared/official-tools';

interface ToolboxSectionProps {
  cliToolRegistryEnabled?: boolean;
  mcpServers: McpServerDefinition[];
  mcpEnabledIds: string[];
  mcpEnabling: Record<string, boolean>;
  mcpNeedsConfig: Record<string, boolean>;
  officialTools?: readonly OfficialToolDefinition[];
  officialEnabledIds?: OfficialToolId[];
  officialToolEnabling?: Record<string, boolean>;
  officialToolNeedsConfig?: Record<string, boolean>;
  onAddMcp: () => void;
  onEditMcp: (server: McpServerDefinition) => void;
  onEditBuiltinMcp: (server: McpServerDefinition) => void;
  onToggleMcp: (server: McpServerDefinition, enabled: boolean) => void;
  onEditOfficialTool?: (tool: OfficialToolDefinition) => void;
  onToggleOfficialTool?: (tool: OfficialToolDefinition, enabled: boolean) => void;
}

export function ToolboxSection({
  cliToolRegistryEnabled,
  mcpServers,
  mcpEnabledIds,
  mcpEnabling,
  mcpNeedsConfig,
  officialTools = [],
  officialEnabledIds = [],
  officialToolEnabling = {},
  officialToolNeedsConfig = {},
  onAddMcp,
  onEditMcp,
  onEditBuiltinMcp,
  onToggleMcp,
  onEditOfficialTool,
  onToggleOfficialTool,
}: ToolboxSectionProps) {
  const totalTools = mcpServers.length + officialTools.length;
  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <h2 className="mb-7 text-lg font-semibold text-[var(--ink)]">工具箱</h2>

      <div className="flex items-center gap-2.5">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-[var(--ink)]">
          <Wrench className="h-4 w-4 text-[var(--ink-muted)]" />
          工具
          <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
            {totalTools}
          </span>
        </h3>
        <div className="flex-1" />
        <button
          onClick={onAddMcp}
          className="flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
        >
          <Plus className="h-3.5 w-3.5" />
          添加
        </button>
      </div>

      <p className="mb-4 mt-1 text-xs text-[var(--ink-muted)]">
        可在对话中启用的工具；包含 MCP 标准协议工具和 MyAgents 官方 CLI 工具
      </p>

      <div className="grid grid-cols-2 gap-4">
        {officialTools.map((tool) => {
          const isEnabled = officialEnabledIds.includes(tool.id);
          const isEnabling = officialToolEnabling[tool.id] ?? false;
          const needsConfig = officialToolNeedsConfig[tool.id] ?? false;
          return (
            <div
              key={tool.id}
              className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <ImageIcon className="h-4 w-4 shrink-0 text-[var(--accent-warm)]/70" />
                    <h3 className="truncate font-semibold text-[var(--ink)]" title={tool.name}>{tool.name}</h3>
                    <span className="shrink-0 rounded-full border border-[var(--info)]/20 bg-[var(--info-bg)] px-2 py-0.5 text-xs font-medium text-[var(--info)]">
                      预设
                    </span>
                    <span className="shrink-0 rounded-full border border-[var(--line)] bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
                      {tool.badge ?? 'CLI'}
                    </span>
                    {isEnabling && (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--info)]" />
                    )}
                  </div>
                  <p className="mt-1 truncate text-xs text-[var(--ink-muted)]" title={tool.description}>
                    {tool.description}
                  </p>
                  {needsConfig && (
                    <p className="mt-1 text-xs text-[var(--warning)]">
                      需要配置支持图片理解的模型
                    </p>
                  )}
                  <p className="mt-2 truncate font-mono text-xs text-[var(--ink-muted)]" title="myagents vision analyze --image <path>">
                    myagents vision analyze --image &lt;path&gt;
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => onEditOfficialTool?.(tool)}
                    className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    title="设置"
                  >
                    <Settings2 className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => onToggleOfficialTool?.(tool, !isEnabled)}
                    disabled={isEnabling}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                      isEnabling
                        ? 'cursor-wait bg-[var(--info)]/60'
                        : isEnabled
                          ? 'cursor-pointer bg-[var(--accent)]'
                          : 'cursor-pointer bg-[var(--line-strong)]'
                    }`}
                    title={isEnabling ? '启用中...' : isEnabled ? '已启用' : '点击启用'}
                  >
                    <span
                      className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${isEnabled ? 'translate-x-5' : 'translate-x-0'}`}
                    />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {mcpServers.map((server) => {
          const isEnabled = mcpEnabledIds.includes(server.id);
          const isEnabling = mcpEnabling[server.id] ?? false;
          return (
            <div
              key={server.id}
              className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Globe className="h-4 w-4 shrink-0 text-[var(--accent-warm)]/70" />
                    <h3 className="truncate font-semibold text-[var(--ink)]" title={server.name}>{server.name}</h3>
                    {server.isBuiltin && (
                      <span className="shrink-0 rounded-full border border-[var(--info)]/20 bg-[var(--info-bg)] px-2 py-0.5 text-xs font-medium text-[var(--info)]">
                        预设
                      </span>
                    )}
                    {server.isFree && (
                      <span className="shrink-0 rounded-full border border-[var(--success)]/20 bg-[var(--success-bg)] px-2 py-0.5 text-xs font-medium text-[var(--success)]">
                        免费
                      </span>
                    )}
                    {isEnabling && (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--info)]" />
                    )}
                  </div>
                  {server.description && (
                    <p className="mt-1 truncate text-xs text-[var(--ink-muted)]" title={server.description}>
                      {server.description}
                    </p>
                  )}
                  {mcpNeedsConfig[server.id] && (
                    <p className="mt-1 text-xs text-[var(--warning)]">
                      ⚠️ 需要配置 API Key
                    </p>
                  )}
                  {server.command !== '__builtin__' && server.command !== '__bundled_cuse__' && (
                    <p className="mt-2 truncate font-mono text-xs text-[var(--ink-muted)]" title={`${server.command} ${server.args?.join(' ') ?? ''}`}>
                      {server.command} {server.args?.join(' ')}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => server.isBuiltin ? onEditBuiltinMcp(server) : onEditMcp(server)}
                    className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    title="设置"
                  >
                    <Settings2 className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => onToggleMcp(server, !isEnabled)}
                    disabled={isEnabling}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                      isEnabling
                        ? 'cursor-wait bg-[var(--info)]/60'
                        : isEnabled
                          ? 'cursor-pointer bg-[var(--accent)]'
                          : 'cursor-pointer bg-[var(--line-strong)]'
                    }`}
                    title={isEnabling ? '启用中...' : isEnabled ? '已启用' : '点击启用'}
                  >
                    <span
                      className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${isEnabled ? 'translate-x-5' : 'translate-x-0'}`}
                    />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {cliToolRegistryEnabled === true && <CliToolsSection />}
    </div>
  );
}
