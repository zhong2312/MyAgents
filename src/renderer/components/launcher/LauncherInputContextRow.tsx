// LauncherInputContextRow — small chip row below the launcher input.
// PRD 0.2.7 D7 / Phase F: hosts a workspace chip + (when the multiAgentRuntime
// gate is on) a runtime chip in the same screen slot the thought-mode
// `RecentThoughtsRow` uses (`absolute left-0 right-0 top-full mt-3`). Moving
// these two controls out of the input toolbar de-clutters the launcher input.
//
// Visual: the inner buttons (`WorkspaceSelector`, `RuntimeSelector`) are
// reused as-is — they already carry the chevron / icon / hover-text-color
// styling needed in the chat-tab toolbar. The wrapper shares the launcher's
// elevated input surface and border, while using a much lighter shadow so the
// chips read as subordinate context attached to the composer rather than a
// second floating panel.
// Pre-PRD-0.2.7 polish iteration removed the "Agent 工作区" / "Runtime"
// text labels — the icons + content already convey what each chip is.

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
  /** Promote a project to default workspace via the dropdown's hover-only
   *  "设为默认" button. Threaded straight through to WorkspaceSelector. */
  onSetDefaultWorkspace?: (project: Project) => void;

  // Runtime (only rendered when multiAgentRuntime gate is on AND callers
  // supply onRuntimeChange — keeps the chip out of the row entirely if the
  // experimental feature is off).
  showRuntime: boolean;
  runtime?: RuntimeType;
  runtimeDetections?: RuntimeDetections;
  onRuntimeChange?: (runtime: RuntimeType) => void;
}

// Resting → hover → focus contract: the resting surface matches
// `SimpleChatInput` (`--paper-elevated` + `--line`), hover uses the semantic
// hover tint, and focus/open deepens to `--paper-inset`. The inner buttons
// already paint their own hover background, so force those backgrounds
// transparent and let the wrapper own one continuous material transition.
// `shadow-xs` is deliberate: the large composer keeps `shadow-md`; a small
// context control using the same shadow would create a disproportionate halo.
const CHIP_WRAPPER_CLASS =
  'inline-flex items-center rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xs transition-[background-color,border-color,box-shadow] duration-150 hover:border-[var(--line-strong)] hover:bg-[var(--hover-bg)] hover:shadow-sm focus-within:border-[var(--line-strong)] focus-within:bg-[var(--paper-inset)] focus-within:shadow-sm [&_button:hover]:!bg-transparent';

export default memo(function LauncherInputContextRow({
  projects,
  selectedProject,
  defaultWorkspacePath,
  onSelectWorkspace,
  onAddFolder,
  onSetDefaultWorkspace,
  showRuntime,
  runtime,
  runtimeDetections,
  onRuntimeChange,
}: LauncherInputContextRowProps) {
  return (
    <div className="flex items-center gap-2 pl-3 text-sm text-[var(--ink-muted)]">
      <div className={CHIP_WRAPPER_CLASS}>
        <WorkspaceSelector
          projects={projects}
          selectedProject={selectedProject}
          defaultWorkspacePath={defaultWorkspacePath}
          onSelect={onSelectWorkspace}
          onAddFolder={onAddFolder}
          onSetDefault={onSetDefaultWorkspace}
        />
      </div>
      {showRuntime && runtime && runtimeDetections && onRuntimeChange && (
        <div className={CHIP_WRAPPER_CLASS}>
          <RuntimeSelector
            value={runtime}
            detections={runtimeDetections}
            onChange={onRuntimeChange}
            variant="toolbar"
          />
        </div>
      )}
    </div>
  );
});
