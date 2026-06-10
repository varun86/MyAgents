import { ChevronRight, FolderOpen } from "lucide-react";
import { memo } from "react";

import type { StickyAncestor } from "./treeTypes";

interface WorkspaceTreeStickyAncestorsProps {
  ancestors: StickyAncestor[];
  rowHeight: number;
  /** Chevron click → collapse that folder. */
  onClosePath: (path: string) => void;
  /** Row click → jump to (select + scroll to) that folder, VS Code style. */
  onJumpToPath: (path: string) => void;
  /** Right-click → the folder's own context menu. Pre-fix the right-click
   *  fell through to the tree container, which treated it as "empty area"
   *  and opened the ROOT menu — so 「新建笔记」 on what the user perceived
   *  as a folder created the note at the workspace root. */
  onPathContextMenu: (path: string, event: React.MouseEvent) => void;
}

export const WorkspaceTreeStickyAncestors = memo(
  function WorkspaceTreeStickyAncestors({
    ancestors,
    rowHeight,
    onClosePath,
    onJumpToPath,
    onPathContextMenu,
  }: WorkspaceTreeStickyAncestorsProps) {
    if (ancestors.length === 0) {
      return null;
    }

    return (
      <div className="absolute left-0 right-0 top-0 z-10 border-b border-[var(--line-subtle)] bg-[var(--paper-elevated)] shadow-xs">
        {ancestors.map((ancestor) => (
          <div
            key={ancestor.path}
            role="button"
            tabIndex={0}
            className="flex w-full cursor-pointer items-center gap-2 px-3 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            style={{
              height: rowHeight,
              paddingLeft: `${12 + ancestor.depth * 16}px`,
            }}
            onClick={() => onJumpToPath(ancestor.path)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onJumpToPath(ancestor.path);
              }
            }}
            onContextMenu={(e) => onPathContextMenu(ancestor.path, e)}
          >
            <button
              type="button"
              title="收起文件夹"
              className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              onClick={(e) => {
                e.stopPropagation();
                onClosePath(ancestor.path);
              }}
            >
              <ChevronRight className="h-3 w-3 rotate-90 transition-transform" />
            </button>
            <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent-warm)]/70" />
            <span className="min-w-0 flex-1 truncate text-left">
              {ancestor.name}
            </span>
          </div>
        ))}
      </div>
    );
  },
);
