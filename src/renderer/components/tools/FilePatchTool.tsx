import type { ToolUseSimple } from '@/types/chat';

import type { FilePatchChange, FilePatchDisplay } from '../../../shared/toolDisplay/filePatch';
import { resolveFilePatchDisplay } from '../../../shared/toolDisplay/filePatch';
import { ExpandableContainer, ExpandableResult, FilePath, ToolHeader } from './utils';

interface FilePatchToolProps {
  tool: ToolUseSimple;
  display?: FilePatchDisplay | null;
}

export default function FilePatchTool({ tool, display: providedDisplay }: FilePatchToolProps) {
  const display = providedDisplay ?? resolveFilePatchDisplay(tool);

  if (!display) {
    return (
      <div className="space-y-2">
        <div className="my-0.5">
          <ToolHeader tool={tool} toolName={tool.name} />
        </div>
        {tool.result ? (
          <ExpandableResult
            content={tool.result}
            className="rounded bg-[var(--paper-inset)]/50 px-2 py-1 break-words text-[var(--ink-secondary)]"
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <FilePatchHeaderPaths display={display} />
        <FilePatchSummary display={display} />
        <FilePatchStatusBadge status={display.status} />
        {display.replaceAll && (
          <span className="rounded border border-[var(--warning)]/30 bg-[var(--warning-bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--warning)]">
            replace all
          </span>
        )}
      </div>

      <FilePatchBody tool={tool} display={display} />
    </div>
  );
}

function FilePatchHeaderPaths({ display }: { display: FilePatchDisplay }) {
  const changes = display.changes;
  if (changes.length === 1) {
    return <FilePatchPath change={changes[0]} />;
  }

  return (
    <>
      {changes.map((change, index) => (
        <FilePatchPath key={`${change.kind}:${change.path ?? ''}:${change.movePath ?? ''}:${index}`} change={change} />
      ))}
      <span className="text-xs text-[var(--ink-muted)]">{changes.length} files</span>
    </>
  );
}

export function FilePatchSummary({ display }: { display: FilePatchDisplay }) {
  const { added, removed } = display.summary;
  const showRemoved =
    removed > 0 ||
    display.changes.some((change) => change.kind !== 'add' || change.removed > 0 || change.view.kind === 'old-new');

  if (!showRemoved) {
    return (
      <span className="text-xs font-mono whitespace-nowrap text-[var(--success)]">
        +{added}
      </span>
    );
  }

  return (
    <span className="text-xs font-mono whitespace-nowrap">
      <span className="text-[var(--success)]">+{added}</span>
      {' '}
      <span className="text-[var(--error)]">-{removed}</span>
    </span>
  );
}

function FilePatchStatusBadge({ status }: { status?: string }) {
  if (!status || status === 'completed') return null;
  const isErrorStatus = status === 'failed' || status === 'declined';
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-xs ${
      isErrorStatus
        ? 'border-[var(--error)]/30 bg-[var(--error-bg)] text-[var(--error)]'
        : 'border-[var(--warning)]/30 bg-[var(--warning-bg)] text-[var(--warning)]'
    }`}
    >
      {status}
    </span>
  );
}

function FilePatchBody({ tool, display }: { tool: ToolUseSimple; display: FilePatchDisplay }) {
  const hasRenderableChange = display.changes.some((change) => (
    change.view.kind === 'old-new' ||
    change.view.kind === 'content' ||
    (change.view.kind === 'unified-diff' && change.view.diff.length > 0)
  ));

  if (!hasRenderableChange) {
    return tool.result ? (
      <ExpandableResult
        content={tool.result}
        className="rounded bg-[var(--paper-inset)]/50 px-2 py-1 break-words text-[var(--ink-secondary)]"
      />
    ) : null;
  }

  return (
    <ExpandableContainer fade="paper-elevated">
      <div className="space-y-2">
        {display.changes.map((change, index) => (
          <FilePatchChangeView
            key={`${change.kind}:${change.path ?? ''}:${change.movePath ?? ''}:${index}`}
            change={change}
            showHeader={display.changes.length > 1 || change.view.kind === 'unified-diff'}
          />
        ))}
      </div>
    </ExpandableContainer>
  );
}

function FilePatchChangeView({ change, showHeader }: { change: FilePatchChange; showHeader: boolean }) {
  if (change.view.kind === 'old-new') {
    return (
      <div className="space-y-1.5">
        <pre className="overflow-x-auto rounded bg-[var(--error-bg)] px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-[var(--error)] select-text">
          {change.view.oldText}
        </pre>
        <pre className="overflow-x-auto rounded bg-[var(--success-bg)] px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-[var(--success)] select-text">
          {change.view.newText}
        </pre>
      </div>
    );
  }

  if (change.view.kind === 'content') {
    return (
      <pre className="overflow-x-auto rounded bg-[var(--paper-inset)]/50 px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-[var(--ink-secondary)] select-text">
        {change.view.content}
      </pre>
    );
  }

  if (!change.view.diff) return null;
  return (
    <div className="overflow-hidden rounded border border-[var(--line-subtle)] bg-[var(--paper-inset)]/35">
      {showHeader && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--line-subtle)] px-2 py-1 text-sm">
          <span className="font-mono text-xs text-[var(--ink-muted)]">{change.kind}</span>
          <FilePatchPath change={change} />
          <span className="font-mono text-xs whitespace-nowrap">
            <span className="text-[var(--success)]">+{change.added}</span>
            {' '}
            <span className="text-[var(--error)]">-{change.removed}</span>
          </span>
        </div>
      )}
      <pre className="overflow-x-auto px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-[var(--ink-secondary)] select-text">
        {change.view.diff}
      </pre>
    </div>
  );
}

function FilePatchPath({ change }: { change: Pick<FilePatchChange, 'path' | 'movePath'> }) {
  return (
    <>
      <FilePath path={change.path} />
      {change.movePath && (
        <>
          <span className="font-mono text-xs text-[var(--ink-muted)]">-&gt;</span>
          <FilePath path={change.movePath} />
        </>
      )}
    </>
  );
}
