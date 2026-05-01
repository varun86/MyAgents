// LauncherInputContextRow — small chip row below the launcher input.
// PRD 0.2.7 D7 / Phase F: hosts "Agent 工作区" + (when the multiAgentRuntime
// gate is on) "Runtime", in the same screen slot the thought-mode `RecentThoughtsRow`
// uses (`absolute left-0 right-0 top-full mt-3`). Removing those two controls
// from the input toolbar de-clutters the launcher input and surfaces both at
// the same hierarchy level as the launcher's primary affordance.
//
// Rendering pattern: re-uses the existing `WorkspaceSelector` and
// `RuntimeSelector` components rather than re-implementing their dropdowns,
// so the launcher and chat-tab paths stay coherent. The layout wrapper keeps
// the chips left-aligned and inheriting the brand-section padding.

import { memo } from 'react';

import RuntimeSelector from '@/components/RuntimeSelector';
import type { Project } from '@/config/types';
import type { RuntimeType, RuntimeDetections } from '../../../shared/types/runtime';

import WorkspaceSelector from './WorkspaceSelector';

interface LauncherInputContextRowProps {
  // Workspace
  projects: Project[];
  selectedProject: Project | null;
  defaultWorkspacePath?: string;
  onSelectWorkspace: (project: Project) => void;
  onAddFolder: () => void;

  // Runtime (only rendered when multiAgentRuntime gate is on AND callers
  // supply onRuntimeChange — keeps the chip out of the row entirely if the
  // experimental feature is off).
  showRuntime: boolean;
  runtime?: RuntimeType;
  runtimeDetections?: RuntimeDetections;
  onRuntimeChange?: (runtime: RuntimeType) => void;
}

export default memo(function LauncherInputContextRow({
  projects,
  selectedProject,
  defaultWorkspacePath,
  onSelectWorkspace,
  onAddFolder,
  showRuntime,
  runtime,
  runtimeDetections,
  onRuntimeChange,
}: LauncherInputContextRowProps) {
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-[var(--ink-muted)]">
      <span className="font-medium text-[var(--ink-muted)]">Agent 工作区</span>
      <WorkspaceSelector
        projects={projects}
        selectedProject={selectedProject}
        defaultWorkspacePath={defaultWorkspacePath}
        onSelect={onSelectWorkspace}
        onAddFolder={onAddFolder}
      />
      {showRuntime && runtime && runtimeDetections && onRuntimeChange && (
        <>
          <span className="ml-2 font-medium text-[var(--ink-muted)]">Runtime</span>
          <RuntimeSelector
            value={runtime}
            detections={runtimeDetections}
            onChange={onRuntimeChange}
            variant="toolbar"
          />
        </>
      )}
    </div>
  );
});
