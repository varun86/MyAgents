import { Check, Loader2 } from 'lucide-react';

export interface ChecklistItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Stable identity (task id) — keys by it when present so reorder/delete don't
   *  reuse the wrong row; falls back to index for the legacy TodoWrite snapshot. */
  key?: string;
}

interface TodoChecklistProps {
  items: ChecklistItem[];
}

/**
 * Shared checklist presentation for task/todo lists. Used by both the legacy
 * `TodoWriteTool` (full-snapshot replay of old sessions) and the new
 * `TaskTodoTool` (TaskList snapshot) so the two render identically.
 */
export default function TodoChecklist({ items }: TodoChecklistProps) {
  const completedCount = items.filter((t) => t.status === 'completed').length;
  const totalCount = items.length;

  return (
    <div className="flex flex-col gap-3">
      {/* Summary Header */}
      <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
        <span className="font-medium tabular-nums">
          {completedCount}/{totalCount} 已完成
        </span>
      </div>

      {/* Items with checkbox style */}
      <div className="space-y-1">
        {items.map((todo, index) => {
          const isCompleted = todo.status === 'completed';
          const isInProgress = todo.status === 'in_progress';

          return (
            <div
              key={todo.key ?? index}
              className={`flex items-start gap-3 rounded-lg px-3 py-2 transition-colors ${isInProgress
                  ? 'bg-[var(--accent)]/10'
                  : 'hover:bg-[var(--paper-inset)]'
                }`}
            >
              {/* Checkbox */}
              <div className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border-2 transition-colors ${isCompleted
                  ? 'border-[var(--success)] bg-[var(--success)] text-white'
                  : isInProgress
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                    : 'border-[var(--line)]'
                }`}>
                {isCompleted ? (
                  <Check className="size-3.5" strokeWidth={3} />
                ) : isInProgress ? (
                  <Loader2 className="size-3 animate-spin text-[var(--accent)]" />
                ) : null}
              </div>

              {/* Content */}
              <span
                className={`flex-1 text-sm leading-relaxed select-text ${isCompleted
                    ? 'text-[var(--ink-muted)] line-through'
                    : isInProgress
                      ? 'text-[var(--accent)] font-medium'
                      : 'text-[var(--ink-secondary)]'
                  }`}
              >
                {todo.content}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
