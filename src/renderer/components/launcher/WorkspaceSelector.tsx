/**
 * WorkspaceSelector - Dropdown workspace selector for Launcher brand section.
 *
 * Layout (post-PRD-0.2.7 polish):
 *   ┌─ Agent 工作区 ──────────────────┐  ← header
 *   │ ⚡ mino       [默认]               │  ← default workspace, pinned first
 *   │   ~/Documents/.../mino             │
 *   │ 📦 zao_translate          [设为默认]│  ← hover-only button on right
 *   │   ~/Documents/.../zao_translate    │
 *   │ ...                                 │
 *   ├─────────────────────────────────────┤
 *   │ ➕ 选择文件夹...                    │
 *   └─────────────────────────────────────┘
 *
 * Sort: default first → others by lastOpened desc. List shows ALL projects
 * (no count cap) so it visually mirrors the right-side workspace grid.
 *
 * "设为默认" semantics: clicking it writes `defaultWorkspacePath` via the
 * existing config service (same code path Settings → 通用设置 → 默认工作区
 * uses), the list re-orders so the new default lands on top, and the
 * dropdown stays open — the user can compare/keep browsing right after.
 * Clicking the row body (anywhere except the button) selects + closes,
 * unchanged from prior behavior.
 */

import { ChevronUp, Plus, Star } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { Popover } from '@/components/ui/Popover';
import { type Project } from '@/config/types';
import { getFolderName } from '@/types/tab';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import WorkspaceIcon from './WorkspaceIcon';

interface WorkspaceSelectorProps {
    projects: Project[];
    selectedProject: Project | null;
    defaultWorkspacePath?: string;
    onSelect: (project: Project) => void;
    onAddFolder: () => void;
    /** Promote a project to default workspace. When omitted (e.g. caller has no
     *  config write access), the hover-only "设为默认" button is hidden. */
    onSetDefault?: (project: Project) => void;
}

export default function WorkspaceSelector({
    projects,
    selectedProject,
    defaultWorkspacePath,
    onSelect,
    onAddFolder,
    onSetDefault,
}: WorkspaceSelectorProps) {
    const [isOpen, setIsOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);

    const handleSelect = useCallback((project: Project) => {
        onSelect(project);
        setIsOpen(false);
    }, [onSelect]);

    // Single sorted list: default first, others by lastOpened desc. Memoized
    // to avoid re-sorting on every render — list size scales with project
    // count which is small but the sort runs on every dropdown open otherwise.
    const orderedProjects = useMemo(() => {
        const sorted = [...projects].sort((a, b) => {
            const aIsDefault = a.path === defaultWorkspacePath;
            const bIsDefault = b.path === defaultWorkspacePath;
            if (aIsDefault && !bIsDefault) return -1;
            if (!aIsDefault && bIsDefault) return 1;
            const aTime = a.lastOpened ? new Date(a.lastOpened).getTime() : 0;
            const bTime = b.lastOpened ? new Date(b.lastOpened).getTime() : 0;
            return bTime - aTime;
        });
        return sorted;
    }, [projects, defaultWorkspacePath]);

    if (projects.length === 0) {
        return (
            <button
                onClick={onAddFolder}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--accent)]"
            >
                <Plus className="h-3.5 w-3.5" />
                <span>选择工作区</span>
            </button>
        );
    }

    return (
        <>
            <button
                ref={triggerRef}
                onClick={() => setIsOpen(!isOpen)}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            >
                <WorkspaceIcon icon={selectedProject?.icon} size={16} />
                <span className="max-w-[120px] truncate">
                    {selectedProject ? (selectedProject.displayName || getFolderName(selectedProject.path)) : '选择工作区'}
                </span>
                <ChevronUp className={`h-3 w-3 shrink-0 transition-transform ${isOpen ? '' : 'rotate-180'}`} />
            </button>
            <Popover
                open={isOpen}
                onClose={() => setIsOpen(false)}
                anchorRef={triggerRef}
                placement="top-start"
                offset={6}
                className="w-72 rounded-xl bg-[var(--paper)]"
            >
                {/* Header — fixed at the top above the scroll region. */}
                <div className="border-b border-[var(--line)] px-3 py-2 text-[12px] font-semibold text-[var(--ink-muted)]">
                    Agent 工作区
                </div>
                {/* Scroll region — see CustomSelect.tsx pit-of-failure note:
                 *  Popover's DEFAULT_CHROME ships `overflow-hidden` for
                 *  rounded-corner clipping; nested div is the correct way to
                 *  add scroll without fighting Tailwind's class order. */}
                <div className="max-h-72 overflow-y-auto py-1">
                    {orderedProjects.map(project => {
                        const isDefault = project.path === defaultWorkspacePath;
                        const isSelected = selectedProject?.id === project.id;
                        return (
                            <WorkspaceRow
                                key={project.id}
                                project={project}
                                isDefault={isDefault}
                                isSelected={isSelected}
                                onSelect={handleSelect}
                                // Hide the "设为默认" button on the row that
                                // already IS the default — it would be a no-op
                                // (user clarification 2026-05-02 option a).
                                onSetDefault={!isDefault && onSetDefault ? onSetDefault : undefined}
                            />
                        );
                    })}
                </div>

                {/* Divider + add folder — outside the scroll region so it stays
                 *  pinned to the bottom even with many projects. */}
                <div className="border-t border-[var(--line)]">
                    <button
                        onClick={() => {
                            setIsOpen(false);
                            onAddFolder();
                        }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        <span>选择文件夹...</span>
                    </button>
                </div>
            </Popover>
        </>
    );
}

// ─────────────────────────────────────────────────────────────────────────────

interface WorkspaceRowProps {
    project: Project;
    isDefault: boolean;
    isSelected: boolean;
    onSelect: (p: Project) => void;
    /** Undefined = no button (hidden). Provided = button is hover-rendered. */
    onSetDefault?: (p: Project) => void;
}

/** Single row: icon + name (+ default tag) + path; hover shows
 *  "设为默认" button on the right at a fixed slot.
 *
 *  Structure: outer wrapper is `position: relative` + `group`. The row body
 *  is a real `<button>` (full-width, holds icon/name/path so keyboard +
 *  click + screen reader all work). The "设为默认" button is a SIBLING
 *  positioned absolutely on the right — siblings, not nested, since
 *  `<button>` inside `<button>` is invalid HTML. The sibling button's
 *  click handler calls `stopPropagation` so the row's onClick doesn't
 *  also fire, which is what keeps the dropdown open while changing
 *  default. */
function WorkspaceRow({
    project,
    isDefault,
    isSelected,
    onSelect,
    onSetDefault,
}: WorkspaceRowProps) {
    return (
        <div
            // `group` is the hover/focus anchor — only used for the action
            // button's reveal. The row body has its own `hover:bg-*` because
            // it's the parent <button>'s normal :hover state; using `group`
            // here would be redundant.
            className="group relative"
        >
            <button
                type="button"
                onClick={() => onSelect(project)}
                className={`flex w-full items-start gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                    isSelected
                        ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                        : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
                }`}
            >
                <WorkspaceIcon icon={project.icon} size={16} />
                {/* `min-w-0` on the outer flex item AND on the inner name
                 *  flex row — without it on the inner row, flex's default
                 *  `min-width: auto` (= content width) prevents the name
                 *  span's `truncate` from working, and a long displayName
                 *  pushes the [默认] tag out of view (Codex review caught). */}
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate font-medium">
                            {project.displayName || getFolderName(project.path)}
                        </span>
                        {isDefault && (
                            <span className="shrink-0 rounded-full bg-[var(--accent)]/12 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)]">
                                默认
                            </span>
                        )}
                    </div>
                    <div className="truncate text-[11px] text-[var(--ink-muted)]">
                        {shortenPathForDisplay(project.path)}
                    </div>
                </div>
                {/* Right-side spacer so name/path don't extend under where the
                 *  hover button overlays. Width matches the action button's
                 *  approximate footprint (px-2 + icon + label ≈ 70-80px); a
                 *  fixed 76px keeps row layout stable whether or not the
                 *  action button is rendered, so default and non-default rows
                 *  align horizontally. */}
                <span aria-hidden className="w-[76px] shrink-0" />
            </button>
            {/* "设为默认" — absolute-positioned sibling button (NOT nested
             *  inside the row button — `<button>` inside `<button>` is
             *  invalid HTML). Hidden by default, revealed on group-hover OR
             *  keyboard focus.
             *
             *  CRITICAL pointer-events note: `opacity-0` does NOT disable
             *  pointer events. Without `pointer-events-none`, the invisible
             *  button still captures clicks in its absolute slot — a user
             *  clicking the visually blank 76px right area would silently
             *  trigger "set as default" instead of selecting the row (Codex
             *  caught this). `group-hover:pointer-events-auto` re-enables
             *  interaction once the button is visible, which is also the
             *  only state in which the user could intend to click it.
             *
             *  Keyboard a11y: `group-focus-within:opacity-100` +
             *  `focus-visible:opacity-100` reveals the button when it
             *  receives keyboard focus — without this, a tab user would
             *  trigger an unseen control. */}
            {onSetDefault && (
                <button
                    type="button"
                    onClick={(e) => {
                        // Sibling, not ancestor, so the row's onClick won't
                        // see this click anyway. stopPropagation is belt-and-
                        // suspenders against future restructuring (e.g. if
                        // the wrapper picks up an onClick handler).
                        e.stopPropagation();
                        onSetDefault(project);
                    }}
                    className="absolute right-2 top-1/2 inline-flex -translate-y-1/2 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-[var(--ink-muted)] opacity-0 pointer-events-none transition-opacity hover:bg-[var(--paper-inset)] hover:text-[var(--accent)] focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
                    aria-label={`设为默认工作区：${project.displayName || getFolderName(project.path)}`}
                    title="设为默认工作区"
                >
                    <Star className="h-3 w-3" />
                    设为默认
                </button>
            )}
        </div>
    );
}
