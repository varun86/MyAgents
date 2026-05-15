/**
 * RuntimeDiagnosticsBanner — surface Codex (and future Claude Code / Gemini)
 * self-reported diagnostics in the chat header (issue #194).
 *
 * Renders nothing for builtin runtime, or when diagnostics is null (haven't
 * arrived yet). Otherwise:
 *
 *   - Computes a small set of "problems worth flagging" (auth failure, apps
 *     not accessible, MCP servers in failed state, RPC call errors).
 *   - Renders a compact one-line banner showing problem count + severity color.
 *   - Click to expand: shows a full breakdown (auth method, enabled features,
 *     MCP servers, apps, effective env) in a details panel.
 *
 * Design intent: zero noise when everything is healthy. The banner only draws
 * attention when there's something for the user to act on (the original
 * artifact-tool failure scenario).
 */

import { AlertTriangle, ChevronDown, ChevronRight, Info, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import type {
  RuntimeDiagnostics,
  RuntimeDiagnosticsCallStatus,
} from '../../shared/types/runtime';

interface RuntimeDiagnosticsBannerProps {
  diagnostics: RuntimeDiagnostics | null;
  /** Compact: per-session dismissal. Reappears on next session. */
  onDismiss?: () => void;
}

interface BannerSummary {
  severity: 'error' | 'warn' | 'info' | 'ok';
  problems: string[];
}

function statusError(s: RuntimeDiagnosticsCallStatus | undefined): string | null {
  if (s && typeof s === 'object' && 'error' in s) return String(s.error);
  return null;
}

function computeSummary(d: RuntimeDiagnostics): BannerSummary {
  const problems: string[] = [];

  // Auth
  if (d.auth?.requiresLogin) problems.push('需要登录 Codex');
  const authErr = statusError(d.status.auth);
  if (authErr) problems.push(`auth 查询失败：${authErr.slice(0, 60)}`);

  // Apps — the core signal for issue #194
  const appsErr = statusError(d.status.apps);
  if (appsErr) problems.push(`app 列表失败：${appsErr.slice(0, 60)}`);
  if (d.apps) {
    const inaccessible = d.apps.filter(a => a.isEnabled && !a.isAccessible);
    if (inaccessible.length > 0) {
      problems.push(`${inaccessible.length} 个 app 已启用但不可达：${inaccessible.map(a => a.id).slice(0, 3).join(', ')}${inaccessible.length > 3 ? '…' : ''}`);
    }
  }

  // MCP servers
  const mcpErr = statusError(d.status.mcpServers);
  if (mcpErr) problems.push(`MCP 状态查询失败：${mcpErr.slice(0, 60)}`);
  if (d.mcpServers) {
    const failed = d.mcpServers.filter(s => s.state === 'failed');
    if (failed.length > 0) {
      problems.push(`MCP server 失败：${failed.map(s => s.name).slice(0, 3).join(', ')}`);
    }
  }

  // Features query
  const featErr = statusError(d.status.features);
  if (featErr) problems.push(`feature flag 查询失败：${featErr.slice(0, 60)}`);

  // Severity: any auth/app failure → warn; otherwise info if any problem.
  let severity: BannerSummary['severity'] = 'ok';
  if (problems.length > 0) {
    const hasError = authErr || appsErr || (d.apps?.some(a => a.isEnabled && !a.isAccessible));
    severity = hasError ? 'warn' : 'info';
  }

  return { severity, problems };
}

function renderStatusLabel(s: RuntimeDiagnosticsCallStatus | undefined): string {
  if (s === 'ok') return 'ok';
  if (s === 'unsupported') return '不支持';
  if (s && typeof s === 'object' && 'error' in s) return `失败：${String(s.error).slice(0, 100)}`;
  return '未报告';
}

export default function RuntimeDiagnosticsBanner({
  diagnostics,
  onDismiss,
}: RuntimeDiagnosticsBannerProps) {
  const [expanded, setExpanded] = useState(false);

  const summary = useMemo(() => (diagnostics ? computeSummary(diagnostics) : null), [diagnostics]);

  if (!diagnostics || !summary) return null;
  // Healthy runtimes don't need a banner — the diagnose CLI is still available
  // for users who want to look anyway. Only render when there's an actionable
  // signal to surface.
  if (summary.severity === 'ok') return null;

  const isWarn = summary.severity === 'warn';
  const Icon = isWarn ? AlertTriangle : Info;
  const colorClasses = isWarn
    ? 'bg-[var(--warning-bg)] text-[var(--ink)]'
    : 'bg-[var(--paper-inset)] text-[var(--ink-muted)]';
  const iconColor = isWarn ? 'text-[var(--warning)]' : 'text-[var(--ink-muted)]';

  return (
    <div className={`relative z-10 flex-shrink-0 border-b border-[var(--line)] ${colorClasses} px-4 py-2 text-[11px]`}>
      <div className="mx-auto flex max-w-3xl items-start gap-2">
        <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${iconColor}`} />
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="flex items-center gap-1 font-semibold hover:underline focus:outline-none"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {`${diagnostics.runtime} runtime 自诊断：${summary.problems.length} 项需关注`}
          </button>
          {!expanded && summary.problems[0] && (
            <span className="ml-2 text-[var(--ink-muted)]">{summary.problems[0]}</span>
          )}
          {expanded && (
            <div className="mt-2 space-y-3">
              {/* Problems */}
              <div>
                <div className="font-semibold mb-1">问题</div>
                <ul className="list-disc pl-4 space-y-0.5">
                  {summary.problems.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              </div>

              {/* Auth */}
              <div>
                <div className="font-semibold">认证 [{renderStatusLabel(diagnostics.status.auth)}]</div>
                {diagnostics.auth && (
                  <div className="text-[var(--ink-muted)]">
                    method: {diagnostics.auth.authMethod ?? '(null)'}
                    {diagnostics.auth.requiresLogin && ' • 需登录'}
                  </div>
                )}
              </div>

              {/* Features (only enabled or user-toggled, capped at 12) */}
              <div>
                <div className="font-semibold">Feature flags [{renderStatusLabel(diagnostics.status.features)}]</div>
                {diagnostics.features && diagnostics.features.length > 0 && (
                  <div className="text-[var(--ink-muted)] flex flex-wrap gap-x-2 gap-y-0.5">
                    {diagnostics.features.slice(0, 12).map(f => (
                      <span key={f.name} className={f.enabled ? '' : 'opacity-60 line-through'}>
                        {f.name}
                      </span>
                    ))}
                    {diagnostics.features.length > 12 && <span>(+{diagnostics.features.length - 12})</span>}
                  </div>
                )}
              </div>

              {/* MCP servers */}
              <div>
                <div className="font-semibold">MCP servers [{renderStatusLabel(diagnostics.status.mcpServers)}]</div>
                {diagnostics.mcpServers && diagnostics.mcpServers.length > 0 && (
                  <ul className="list-disc pl-4 space-y-0.5 text-[var(--ink-muted)]">
                    {diagnostics.mcpServers.map(s => (
                      <li key={s.name}>
                        {s.name} • tools={s.toolCount} resources={s.resourceCount ?? 0}
                        {s.authStatus ? ` • auth=${s.authStatus}` : ''}
                        {s.state ? ` • state=${s.state}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Apps — the core signal for issue #194 */}
              <div>
                <div className="font-semibold">Apps [{renderStatusLabel(diagnostics.status.apps)}]</div>
                {diagnostics.apps && diagnostics.apps.length > 0 && (
                  <ul className="list-disc pl-4 space-y-0.5 text-[var(--ink-muted)]">
                    {diagnostics.apps.map(a => (
                      <li
                        key={a.id}
                        className={a.isEnabled && !a.isAccessible ? 'text-[var(--warning)]' : ''}
                      >
                        {a.isEnabled ? '✅ ' : '⚪ '}
                        {a.isAccessible ? '可访问 ' : '不可访问 '}
                        {a.id}
                        {a.needsAuth ? ' • needs-auth' : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Effective env */}
              <div>
                <div className="font-semibold">Effective env</div>
                <div className="text-[var(--ink-muted)] font-mono text-[10px] leading-tight">
                  <div>cwd: {diagnostics.effectiveEnv.cwd}</div>
                  <div>HTTP_PROXY:  {diagnostics.effectiveEnv.proxy?.http ?? '(unset)'}</div>
                  <div>HTTPS_PROXY: {diagnostics.effectiveEnv.proxy?.https ?? '(unset)'}</div>
                  <div>NO_PROXY:    {diagnostics.effectiveEnv.proxy?.no ?? '(unset)'}</div>
                  <div>proxyPolicy: {diagnostics.effectiveEnv.proxyPolicy ?? 'myagents'}</div>
                  <div>
                    MYAGENTS_PROXY_INJECTED: {diagnostics.effectiveEnv.myagentsProxyInjected ? 'yes' : 'no'}
                  </div>
                  <div>
                    secrets: openai={diagnostics.effectiveEnv.hasOpenaiApiKey ? '✓' : '✗'} •
                    anthropic={diagnostics.effectiveEnv.hasAnthropicApiKey ? '✓' : '✗'} •
                    codex-home={diagnostics.effectiveEnv.hasCodexHome ? '✓' : '✗'}
                  </div>
                </div>
              </div>

              <div className="text-[10px] text-[var(--ink-muted)] italic">
                诊断快照：{diagnostics.timestamp}。命令行同步信息：
                <code className="ml-1">myagents diagnose runtime {diagnostics.runtime}</code>
              </div>
            </div>
          )}
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="关闭"
            className="flex-shrink-0 rounded p-0.5 text-[var(--ink-muted)] hover:bg-[var(--paper-hover)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
