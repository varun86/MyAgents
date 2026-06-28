// StatusHistoryList — renders a Task's statusHistory with pagination (PRD §7.3.1).
//
// v0.1.69 review: the preview overlay was rendering the full 50-item
// list by default which drowned out everything else. `defaultCollapsed`
// starts with just the 3 most recent rows visible and a "查看全部 (N)"
// expand button — inline timeline for scanning, full list on demand.
// Once expanded, the usual pagination (`PAGE_SIZE` at a time) takes over.

import { useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Download } from 'lucide-react';
import type { StatusTransition, Task, TaskStatus } from '@/../shared/types/task';
import { isSupportedLocale } from '@/../shared/i18n';

const PAGE_SIZE = 50;
const COLLAPSED_PREVIEW = 3;

interface Props {
  task: Task;
  /** Start with only the 3 most recent rows visible. Click "查看全部"
   *  to expand to the normal paginated list. */
  defaultCollapsed?: boolean;
}

export function StatusHistoryList({ task, defaultCollapsed = false }: Props) {
  const { t } = useTranslation('task');
  const history = task.statusHistory;
  const [expanded, setExpanded] = useState(!defaultCollapsed);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Newest first for UI; statusHistory is stored append-only, oldest first.
  const ordered = useMemo(() => [...history].reverse(), [history]);
  const effectiveCount = expanded ? visibleCount : COLLAPSED_PREVIEW;
  const shown = ordered.slice(0, effectiveCount);
  const hasMore = expanded && ordered.length > visibleCount;
  const hiddenInCollapsed = !expanded && ordered.length > COLLAPSED_PREVIEW;

  if (history.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-[var(--ink-muted)]">
        {t('history.empty')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-[var(--ink)]">
          {t('history.title', { count: history.length })}
        </div>
        {/* Export button is only useful in the fully expanded view;
            hiding it in collapsed mode keeps the row tidy. */}
        {expanded && (
          <button
            type="button"
            onClick={() => downloadAsJson(task)}
            className="flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-1 text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            title={t('history.downloadTitle')}
          >
            <Download className="h-3 w-3" />
            {t('history.exportJson')}
          </button>
        )}
      </div>
      <ol className="relative flex flex-col gap-0 before:absolute before:left-[7px] before:top-1 before:bottom-1 before:w-px before:bg-[var(--line)]">
        {shown.map((t, i) => (
          <TransitionRow key={`${t.at}-${i}`} t={t} />
        ))}
      </ol>
      {hiddenInCollapsed && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex items-center gap-1 self-center rounded-[var(--radius-md)] px-3 py-1 text-xs text-[var(--accent-warm)] transition-colors hover:bg-[var(--accent-warm-subtle)]"
        >
          <ChevronRight className="h-3 w-3" />
          {t('history.viewAll', { count: ordered.length })}
        </button>
      )}
      {hasMore && (
        <button
          type="button"
          onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
          className="self-center rounded-[var(--radius-md)] px-3 py-1 text-xs text-[var(--accent-warm)] transition-colors hover:bg-[var(--accent-warm-subtle)]"
        >
          {t('history.loadMore', { count: ordered.length - visibleCount })}
        </button>
      )}
    </div>
  );
}

function TransitionRow({ t }: { t: StatusTransition }) {
  const { t: translate, i18n } = useTranslation('task');
  const locale = isSupportedLocale(i18n.language) ? i18n.language : 'zh-CN';
  const from = t.from ? statusLabel(t.from, translate) : '—';
  const to = statusLabel(t.to, translate);
  // Self-loop transitions (from === to) are audit-only entries — e.g.
  // crash recovery of a recurring task where the status didn't actually
  // change but we wanted to record the event. Render them as a single
  // status pill (no arrow) so they read as "an event happened at this
  // status" rather than a confusing "running → running".
  const selfLoop = t.from !== null && t.from === t.to;
  return (
    <li className="relative flex gap-3 py-1.5 pl-5">
      <span
        className="absolute left-1 top-2.5 inline-block h-2 w-2 rounded-full bg-[var(--accent-warm)]"
        aria-hidden
      />
      <div className="flex-1 text-xs">
        <div className="flex items-center gap-1.5 text-[var(--ink)]">
          {selfLoop ? (
            <span className="font-medium">{to}</span>
          ) : (
            <>
              <span className="text-[var(--ink-muted)]">{from}</span>
              <span className="text-[var(--ink-muted)]">→</span>
              <span className="font-medium">{to}</span>
            </>
          )}
          <span className="text-xs text-[var(--ink-muted)]/70">
            · {actorLabel(t.actor)}
            {t.source && ` · ${t.source}`}
          </span>
        </div>
        {t.message && (
          <div className="mt-0.5 text-xs text-[var(--ink-muted)]">
            {t.message}
          </div>
        )}
      </div>
      <span className="shrink-0 text-xs tabular-nums text-[var(--ink-muted)]/60">
        {new Date(t.at).toLocaleString(locale)}
      </span>
    </li>
  );
}

function statusLabel(status: TaskStatus, t: TFunction<'task'>): string {
  return t(`badges.status.${status}`, { defaultValue: t('history.unknownStatus') });
}

function actorLabel(a: StatusTransition['actor']): string {
  return a === 'user' ? 'user' : a === 'agent' ? 'agent' : 'system';
}

function downloadAsJson(task: Task) {
  const payload = {
    taskId: task.id,
    name: task.name,
    exportedAt: new Date().toISOString(),
    statusHistory: task.statusHistory,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${task.id}-history.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default StatusHistoryList;
