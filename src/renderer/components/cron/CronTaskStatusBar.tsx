// Cron Task Status Bar - non-blocking composer status for armed/running/stopped cron tasks.
import { useEffect, useMemo, useState } from 'react';
import { Settings2, Square, Timer, X } from 'lucide-react';

import { formatCronInterval, type CronSchedule } from '@/types/cronTask';

type CronTaskStatusBarMode = 'draft' | 'running' | 'executing' | 'stopped';

interface CronTaskStatusBarProps {
  mode?: CronTaskStatusBarMode;
  intervalMinutes: number;
  schedule?: CronSchedule | null;
  executionCount?: number;
  maxExecutions?: number;
  nextExecutionAt?: string | null;
  executionNumber?: number;
  onSettings?: () => void;
  onCancel?: () => void;
  onStop?: () => void;
  onDismissStopped?: () => void;
}

function formatStatusBarSchedule(schedule: CronSchedule | null | undefined, intervalMinutes: number): string {
  if (schedule) {
    switch (schedule.kind) {
      case 'at':
        return `${new Date(schedule.at).toLocaleString('zh-CN')} 执行一次`;
      case 'every':
        return `每 ${formatCronInterval(schedule.minutes)} 执行一次`;
      case 'cron':
        return `Cron: ${schedule.expr}`;
      case 'loop':
        return 'Ralph Loop 无限循环';
    }
  }
  return `每 ${formatCronInterval(intervalMinutes)} 执行一次`;
}

function formatExecutionCount(executionCount = 0, maxExecutions?: number): string {
  if (maxExecutions && maxExecutions > 0) {
    return `已执行 ${executionCount}/${maxExecutions} 次`;
  }
  return `已执行 ${executionCount} 次`;
}

function formatCountdown(nextExecutionAt: string | null | undefined, now: number): string | null {
  if (!nextExecutionAt) return null;
  const target = new Date(nextExecutionAt).getTime();
  if (!Number.isFinite(target)) return null;
  const remainingMs = target - now;
  if (remainingMs <= 0) return '等待触发';

  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `下次 ${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `下次 ${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export default function CronTaskStatusBar({
  mode = 'draft',
  intervalMinutes,
  schedule,
  executionCount = 0,
  maxExecutions,
  nextExecutionAt,
  executionNumber,
  onSettings,
  onCancel,
  onStop,
  onDismissStopped,
}: CronTaskStatusBarProps) {
  const [now, setNow] = useState(() => Date.now());
  const isActive = mode === 'running' || mode === 'executing';

  useEffect(() => {
    if (!isActive || !nextExecutionAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive, nextExecutionAt]);

  const countdown = useMemo(
    () => mode === 'running' ? formatCountdown(nextExecutionAt, now) : null,
    [mode, nextExecutionAt, now],
  );

  const title = mode === 'draft'
    ? '定时模式'
    : mode === 'stopped'
      ? '定时任务已停止'
      : schedule?.kind === 'loop'
        ? (mode === 'executing' ? '心跳循环执行中' : '心跳循环进行中')
        : (mode === 'executing' ? '定时任务执行中' : '定时任务运行中');

  const detail = mode === 'stopped'
    ? '点击关闭可恢复任务内容到输入框'
    : [
        formatStatusBarSchedule(schedule, intervalMinutes),
        mode === 'executing'
          ? `第 ${executionNumber ?? executionCount + 1} 轮执行中`
          : countdown,
        isActive ? formatExecutionCount(executionCount, maxExecutions) : null,
      ].filter(Boolean).join(' · ');

  return (
    <div
      className="flex items-center justify-between gap-3 rounded-t-lg border border-b-0 border-[var(--heartbeat-border)] px-3 py-2"
      style={{ backgroundColor: 'color-mix(in srgb, var(--paper) 92%, var(--heartbeat))' }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="relative shrink-0">
          <Timer className={`h-4 w-4 text-[var(--heartbeat)] ${mode === 'stopped' ? 'opacity-60' : ''}`} />
          {mode === 'executing' && (
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--heartbeat)] opacity-40" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--heartbeat)]" />
            </span>
          )}
        </span>
        <span className="shrink-0 text-sm font-medium text-[var(--heartbeat)]">
          {title}
        </span>
        <span className="min-w-0 truncate text-sm text-[var(--ink-muted)]">
          {detail}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {mode === 'draft' && onSettings && (
          <button
            type="button"
            onClick={onSettings}
            className="rounded-md p-1.5 text-[var(--ink-muted)] transition hover:bg-[var(--heartbeat-bg)] hover:text-[var(--heartbeat)]"
            title="修改设置"
          >
            <Settings2 className="h-4 w-4" />
          </button>
        )}
        {mode === 'draft' && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md p-1.5 text-[var(--ink-muted)] transition hover:bg-[var(--heartbeat-bg)] hover:text-[var(--heartbeat)]"
            title="取消定时"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {isActive && onStop && (
          <button
            type="button"
            onClick={onStop}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[var(--heartbeat)] transition hover:bg-[var(--heartbeat-bg)]"
            title="停止定时任务"
          >
            <Square className="h-3.5 w-3.5" />
            停止
          </button>
        )}
        {mode === 'stopped' && onDismissStopped && (
          <button
            type="button"
            onClick={onDismissStopped}
            className="rounded-md p-1.5 text-[var(--ink-muted)] transition hover:bg-[var(--heartbeat-bg)] hover:text-[var(--heartbeat)]"
            title="关闭并恢复任务内容到输入框"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
