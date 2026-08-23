/**
 * WorkspaceSelector - Dropdown workspace selector for Launcher brand section.
 *
 * Layout (post-PRD-0.2.7 layout polish):
 *   ┌─ Agent 工作区 ─────────────────────────────────┐
 *   │ [icon] mino [默认]                  [设为默认] │  ← line 1
 *   │        ~/Documents/.../mino                    │  ← line 2 (full width)
 *   │ [icon] zao_translate                [设为默认] │
 *   │        ~/Documents/.../zao_translate           │
 *   └────────────────────────────────────────────────┘
 *
 * Sort: default first → others by lastOpened desc. Single-action
 * `选择文件夹` row was removed — workspace creation lives in Settings now,
 * keeping this dropdown focused on selection.
 *
 * "设为默认" semantics: clicking it writes `defaultWorkspacePath` via the
 * existing config service (same code path Settings → 通用设置 → 默认工作区
 * uses), the list re-orders so the new default lands on top, and the
 * dropdown stays open — the user can compare/keep browsing right after.
 * Clicking the row body (anywhere except the button) selects + closes.
 *
 * Markup uses a `role="button"` div wrapper for the row so the real
 * `<button>` inside ("设为默认") doesn't violate the no-button-in-button
 * HTML rule. Both surfaces remain keyboard-reachable (Tab to row, Space /
 * Enter to select; Shift+Tab to inner button when revealed).
 */

import { ChevronUp, Plus } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Popover } from '@/components/ui/Popover';
import { type Project } from '@/config/types';
import { getFolderName } from '@/types/tab';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import { workspacePathsEqual } from '@/../shared/workspacePath';
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

export function orderWorkspaceSelectorProjects(
    projects: readonly Project[],
    defaultWorkspacePath?: string,
): Project[] {
    return [...projects].sort((a, b) => {
        const aIsDefault = workspacePathsEqual(a.path, defaultWorkspacePath);
        const bIsDefault = workspacePathsEqual(b.path, defaultWorkspacePath);
        if (aIsDefault && !bIsDefault) return -1;
        if (!aIsDefault && bIsDefault) return 1;
        const aTime = a.lastOpened ? new Date(a.lastOpened).getTime() : 0;
        const bTime = b.lastOpened ? new Date(b.lastOpened).getTime() : 0;
        return bTime - aTime;
    });
}

export default function WorkspaceSelector({
    projects,
    selectedProject,
    defaultWorkspacePath,
    onSelect,
    onAddFolder,
    onSetDefault,
}: WorkspaceSelectorProps) {
    const { t } = useTranslation('launcher');
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
        return orderWorkspaceSelectorProjects(projects, defaultWorkspacePath);
    }, [projects, defaultWorkspacePath]);

    if (projects.length === 0) {
        return (
            <button
                onClick={onAddFolder}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--accent)]"
            >
                <Plus className="h-3.5 w-3.5" />
                <span>{t('workspaceSelector.selectWorkspace')}</span>
            </button>
        );
    }

    return (
        <>
            <button
                ref={triggerRef}
                onClick={() => setIsOpen(!isOpen)}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            >
                <WorkspaceIcon icon={selectedProject?.icon} size={16} />
                <span className="max-w-[120px] truncate">
                    {selectedProject ? (selectedProject.displayName || getFolderName(selectedProject.path)) : t('workspaceSelector.selectWorkspace')}
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
                <div className="border-b border-[var(--line)] px-3 py-2 text-xs font-semibold text-[var(--ink-muted)]">
                    {t('workspaceSelector.title')}
                </div>
                {/* Scroll region — see CustomSelect.tsx pit-of-failure note:
                 *  Popover's DEFAULT_CHROME ships `overflow-hidden` for
                 *  rounded-corner clipping; nested div is the correct way to
                 *  add scroll without fighting Tailwind's class order. */}
                <div className="max-h-72 overflow-y-auto py-1">
                    {orderedProjects.map(project => {
                        const isDefault = workspacePathsEqual(project.path, defaultWorkspacePath);
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
    showDefaultBadge?: boolean;
}

/** Single row, two-line layout:
 *
 *    [icon]  name [默认]                          [设为默认]
 *            ~/full/path/here ───────────────────── ends at panel edge
 *
 *  Why the row is a `role="button"` div instead of a real `<button>`:
 *  the right-side "设为默认" trigger MUST stay a real `<button>` for
 *  keyboard a11y, and `<button>` inside `<button>` is invalid HTML.
 *  Wrapping the row as a `role="button"` div with explicit Enter/Space
 *  handling preserves keyboard reachability for both the row body
 *  (select) and the inner trigger ("设为默认") without nesting.
 *
 *  The path on line 2 spans the full inner width (no spacer for the
 *  hover trigger — which now sits on line 1, not in the path slot). */
export function WorkspaceRow({
    project,
    isDefault,
    isSelected,
    onSelect,
    onSetDefault,
    showDefaultBadge = true,
}: WorkspaceRowProps) {
    const { t } = useTranslation('launcher');
    const displayName = project.displayName || getFolderName(project.path);
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={() => onSelect(project)}
            onKeyDown={(e) => {
                // Enter / Space activate the row body. We deliberately don't
                // include the inner trigger — Tab moves into it on its own.
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(project);
                }
            }}
            className={`group flex cursor-pointer items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
                isSelected
                    ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                    : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
            }`}
        >
            <WorkspaceIcon icon={project.icon} size={28} />
            <div className="min-w-0 flex-1">
                {/* Line 1: name + 默认 tag (right-against-name) + flex spacer
                 *  + "设为默认" hover trigger pinned to the right. */}
                <div className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate font-medium">{displayName}</span>
                    {showDefaultBadge && isDefault && (
                        <span className="shrink-0 rounded-full bg-[var(--accent)]/12 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-[var(--accent)]">
                            {t('workspaceSelector.defaultBadge')}
                        </span>
                    )}
                    <div className="flex-1" />
                    {onSetDefault && (
                        <button
                            type="button"
                            onClick={(e) => {
                                // Stop the click from bubbling to the row's
                                // onClick — otherwise selecting "设为默认"
                                // would also select the workspace.
                                e.stopPropagation();
                                onSetDefault(project);
                            }}
                            // `opacity-0` alone leaves the invisible button
                            // capturing clicks; combine with
                            // `pointer-events-none` so the bare row area
                            // doesn't silently trigger this when the button
                            // is hidden (Codex review).
                            className="shrink-0 rounded-md px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)] opacity-0 pointer-events-none transition-opacity hover:bg-[var(--paper-inset)] hover:text-[var(--accent)] focus-visible:opacity-100 focus-visible:pointer-events-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
                            aria-label={t('workspaceSelector.setDefaultAria', { name: displayName })}
                            title={t('workspaceSelector.setDefaultTitle')}
                        >
                            {t('workspaceSelector.setDefault')}
                        </button>
                    )}
                </div>
                {/* Line 2: path. No right-side spacer — the path is allowed
                 *  to truncate at the panel's right edge. */}
                <div className="truncate text-xs text-[var(--ink-muted)]">
                    {shortenPathForDisplay(project.path)}
                </div>
            </div>
        </div>
    );
}
