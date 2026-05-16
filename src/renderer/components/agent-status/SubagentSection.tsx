// PRD 0.2.17 — Agent Status Panel
//
// 展开态的 SUBAGENTS 区：列出活跃 subagent，sync + background 混排，background 加
// [bg] 徽标区分（PRD D10）。点击行 → 对话流滚动到对应 TaskTool 卡片并高亮（PRD D11）。
//
// 跳转交由 Chat 通过 onJumpToTool 注入：Virtuoso scrollToIndex（解决虚拟化卸载）+
// 二阶段 querySelector 高亮，scope 在 chat container ref（解决多 Tab 同 Session DOM
// 冲突）。见 Chat.tsx::handleJumpToTool（cross-review C1/C2 修复）。

import { memo, useCallback } from 'react';

import { formatTokens } from './format';
import { SubagentRunningIcon } from './icons';
import type { SubagentStatus } from './types';
import { useElapsedSeconds } from './useElapsedSeconds';

interface SubagentSectionProps {
  subagents: SubagentStatus[];
  containerRef: React.RefObject<HTMLElement | null>;
  onJumpToTool: (toolId: string) => void;
}

interface SubagentRowProps {
  subagent: SubagentStatus;
  onJumpToTool: (toolId: string) => void;
}

function SubagentRow({ subagent, onJumpToTool }: SubagentRowProps) {
  const elapsed = useElapsedSeconds(subagent.startedAt);
  const totalTokens = subagent.inputTokens + subagent.outputTokens;

  const onClick = useCallback(() => {
    if (!subagent.id) return;
    onJumpToTool(subagent.id);
  }, [subagent.id, onJumpToTool]);

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--paper-inset)]/60"
    >
      <span className="mt-1">
        <SubagentRunningIcon />
      </span>
      <div className="min-w-0 flex-1">
        {/* Line 1: agent type + [bg] badge */}
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-medium text-[var(--ink)] truncate">
            {subagent.agentType}
          </span>
          {subagent.mode === 'background' && (
            <span className="rounded bg-[var(--paper-inset)] px-1 text-[9px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
              bg
            </span>
          )}
        </div>
        {/* Line 2: description (truncate) */}
        {subagent.description && (
          <div
            className="text-[11px] text-[var(--ink-muted)] truncate"
            title={subagent.description}
          >
            {subagent.description}
          </div>
        )}
        {/* Line 3: elapsed · tokens · tools */}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] tabular-nums text-[var(--ink-muted)]">
          {elapsed && <span>{elapsed}</span>}
          {totalTokens > 0 && (
            <>
              <span aria-hidden>·</span>
              <span>{formatTokens(totalTokens)} tokens</span>
            </>
          )}
          {subagent.toolCount > 0 && (
            <>
              <span aria-hidden>·</span>
              <span>{subagent.toolCount} tools</span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

const MemoSubagentRow = memo(SubagentRow);

const SubagentSection = memo(function SubagentSection({ subagents, containerRef: _containerRef, onJumpToTool }: SubagentSectionProps) {
  // containerRef 当前留作前向 API 兼容（onJumpToTool 已内部使用 Chat 持有的 ref），
  // 解构出来防止下游 row 重复签名。下划线前缀显式标记暂不使用——保留是为后续 row 内
  // 直接做轻量 DOM 探测（如自己探测是否已 mounted 以跳过 Virtuoso 滚动）留个口子。
  void _containerRef;
  if (subagents.length === 0) return null;
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between px-3 pb-1 pt-0.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
          SubAgents
        </span>
        <span className="text-[11px] tabular-nums text-[var(--ink-muted)]">
          {subagents.length}
        </span>
      </div>
      <div className="max-h-[200px] overflow-y-auto">
        {subagents.map(s => (
          <MemoSubagentRow key={s.id} subagent={s} onJumpToTool={onJumpToTool} />
        ))}
      </div>
    </div>
  );
});

export default SubagentSection;
