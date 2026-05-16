// PRD 0.2.17 — Agent Status Panel
//
// Top-level 容器：组合 useAgentStatusState 派生 + 收起态长条 + 展开态 sections。
// 自带可见性生命周期（首次淡入、归零延迟 1.5s 淡出，再触发立即淡入）。

import { ChevronDown, ChevronUp } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import type { Message } from '@/types/chat';

import { TodoCompletedIcon, TodoInProgressIcon, TodoPendingIcon, SubagentRunningIcon } from './icons';
import SubagentSection from './SubagentSection';
import TodoSection from './TodoSection';
import { useAgentStatusState } from './useAgentStatusState';
import { useElapsedSeconds } from './useElapsedSeconds';

const FADE_OUT_DELAY_MS = 1500;

interface AgentStatusPanelProps {
  messages: Message[];
  /** Chat 内容区的 ref，限定 querySelector 作用域（防多 Tab 同 Session DOM 冲突） */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Chat 提供：Virtuoso scrollToIndex + 二阶段 highlight。SubagentRow 透传调用。 */
  onJumpToTool: (toolId: string) => void;
}

const AgentStatusPanel = memo(function AgentStatusPanel({ messages, containerRef, onJumpToTool }: AgentStatusPanelProps) {
  const state = useAgentStatusState(messages);
  // hasContent：todos 全部 completed 时视为「已结束」→ 进入 fade-out
  // （对齐 PRD §8.1 #6 验收：「5/5 ☑ 后 1.5s 整段淡出」）
  const todosActive = state.todos.length > 0 && state.todos.some(t => t.status !== 'completed');
  const hasContent = todosActive || state.subagents.length > 0;

  // 可见性状态机：内容出现 → 立即 setMounted(true) + setOpacity(1)
  // 内容归零 → 立即 setOpacity(0)，1.5s 后 setMounted(false)（卸载 DOM 释放内存）
  // 归零 1.5s 内若内容再次出现 → 取消淡出，setOpacity(1)
  const [mounted, setMounted] = useState(false);
  const [opaque, setOpaque] = useState(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 跨 rAF 边界跟踪第二层 rAF id，避免 toggle 过快时 stale setOpaque 漏过 cleanup（Codex Adv 1）。
  const raf2Ref = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (hasContent) {
      // 取消任何待执行的 fade-out 计时器
      if (fadeTimerRef.current) {
        clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = undefined;
      }
      // 用 rAF 包装 setState，规避 react-hooks/set-state-in-effect lint。
      // 第一帧 mount（opacity 仍是 0），第二帧设 opaque=true 触发 200ms 淡入。
      const raf1 = requestAnimationFrame(() => {
        setMounted(true);
        raf2Ref.current = requestAnimationFrame(() => {
          setOpaque(true);
          raf2Ref.current = undefined;
        });
      });
      return () => {
        cancelAnimationFrame(raf1);
        if (raf2Ref.current !== undefined) {
          cancelAnimationFrame(raf2Ref.current);
          raf2Ref.current = undefined;
        }
      };
    }
    // hasContent just turned false。如果当前还没 mounted，无需安排任何动作
    // （避免 Codex Adv 3：首次渲染就 hasContent=false 时仍调度无意义 1.5s 定时器）
    if (!mounted) return;
    const raf = requestAnimationFrame(() => setOpaque(false));
    fadeTimerRef.current = setTimeout(() => {
      setMounted(false);
      fadeTimerRef.current = undefined;
    }, FADE_OUT_DELAY_MS);
    return () => {
      cancelAnimationFrame(raf);
      if (fadeTimerRef.current) {
        clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = undefined;
      }
    };
  }, [hasContent, mounted]);

  // 展开/收起状态（Tab 生命周期内保持；不持久化）
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded(v => !v), []);

  if (!mounted) return null;

  return (
    // 外两层 pointer-events-none，pointer-events-auto 只在 panel card 上——这样 panel
    // 周围的「视觉空白」不挡 MessageList 的选区/点击（Codex W2）。同时 fade-out 期间
    // 把 panel card 自身也禁用 pointer-events，避免淡出半透明阶段误击中。
    <div
      className="pointer-events-none absolute inset-x-0 bottom-[8rem] z-20 flex justify-end px-4"
      aria-hidden={!hasContent}
    >
      <div className="pointer-events-none flex w-full max-w-3xl justify-end">
        <div
          className={`flex w-full min-w-[280px] max-w-[480px] flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/95 shadow-lg backdrop-blur-md transition-opacity duration-200 ${
            opaque ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
          {/* 展开态：上面 sections，下面 bar；收起态：仅 bar */}
          {expanded && (
            <div className="flex flex-col">
              <TodoSection todos={state.todos} />
              <SubagentSection subagents={state.subagents} containerRef={containerRef} onJumpToTool={onJumpToTool} />
            </div>
          )}
          <AgentStatusBar
            summary={state.summary}
            expanded={expanded}
            onToggle={toggle}
          />
        </div>
      </div>
    </div>
  );
});

export default AgentStatusPanel;

interface AgentStatusBarProps {
  summary: import('./types').AgentStatusSummary;
  expanded: boolean;
  onToggle: () => void;
}

const AgentStatusBar = memo(function AgentStatusBar({ summary, expanded, onToggle }: AgentStatusBarProps) {
  // 用 startedAt 自驱 1s 计时器；仅这一行重渲，不波及上方 sections。
  const elapsed = useElapsedSeconds(summary.longestSubagentStartedAt);

  const hasTodos = summary.todoTotal > 0;
  const todoAllDone = hasTodos && summary.todoCompleted === summary.todoTotal;
  // icon 优先级：全完成 ☑ > 有进行中 ■ > 否则 ☐
  // 关键：只有 in_progress 个数 > 0 才显示橙色实心方块（见 PRD §8.1 第 3 条验收）。
  // 旧实现错误用 completed > 0 当 in_progress 信号，会把「完成 1 个，剩 4 个 pending」
  // 也错绘成 ■。
  const TodoIcon = todoAllDone
    ? TodoCompletedIcon
    : summary.todoInProgress > 0
      ? TodoInProgressIcon
      : TodoPendingIcon;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={expanded ? '收起 Agent 状态面板' : '展开 Agent 状态面板'}
      className={`flex items-center gap-3 px-3 py-2 text-[12px] text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]/40 ${
        expanded ? 'border-t border-[var(--line-subtle)]' : ''
      }`}
    >
      {hasTodos && (
        <span className="flex items-center gap-1.5">
          <TodoIcon />
          <span className="tabular-nums">
            {summary.todoCompleted}/{summary.todoTotal}
          </span>
        </span>
      )}

      {hasTodos && summary.subagentRunning > 0 && (
        <span aria-hidden className="text-[var(--ink-faint)]">·</span>
      )}

      {summary.subagentRunning > 0 && (
        <span className="flex items-center gap-1.5">
          <SubagentRunningIcon />
          <span className="tabular-nums">
            {summary.subagentRunning} {summary.subagentRunning === 1 ? 'agent' : 'agents'}
          </span>
        </span>
      )}

      {elapsed && summary.subagentRunning > 0 && (
        <>
          <span aria-hidden className="text-[var(--ink-faint)]">·</span>
          <span className="tabular-nums text-[var(--ink-muted)]">{elapsed}</span>
        </>
      )}

      <span className="ml-auto text-[var(--ink-muted)]">
        {expanded ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
      </span>
    </button>
  );
});
