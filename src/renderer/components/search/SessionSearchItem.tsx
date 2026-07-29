/**
 * SessionSearchItem - Component for rendering a single session search result.
 * Shows the session title on the first line and a snippet of the matching content on the second line.
 */

import { memo } from 'react';
import { Clock, BarChart2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SessionSearchHit } from '@/api/searchClient';
import type { SessionMetadata } from '@/api/sessionClient';
import type { Project } from '@/config/types';
import WorkspaceIcon from '@/components/launcher/WorkspaceIcon';
import SearchHighlight from './SearchHighlight';
import { getFolderName, formatTime } from '@/utils/taskCenterUtils';

interface SessionSearchItemProps {
    hit: SessionSearchHit;
    session?: SessionMetadata; // The full session metadata if available
    project?: Project;
    deleteProtected: boolean;
    onClick: () => void;
    onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
    onShowStats: (e: React.MouseEvent) => void;
    onDelete: (e: React.MouseEvent) => void;
}

export default memo(function SessionSearchItem({
    hit,
    session,
    project,
    deleteProtected,
    onClick,
    onContextMenu,
    onShowStats,
    onDelete,
}: SessionSearchItemProps) {
    const { t } = useTranslation('app');
    // If we don't have project info, fallback to showing just the agentDir
    const projectName = project ? getFolderName(project.path) : getFolderName(hit.agentDir);
    const displayLastActiveAt = session?.lastActiveAt ?? hit.lastActiveAt;
    const turnCountStr = hit.turnCount !== null && hit.turnCount > 0
        ? t('historyOverlay.turnCount', { count: hit.turnCount })
        : '';

    return (
        <div
            role="button"
            onClick={onClick}
            onMouseDown={(event) => {
                if (event.button === 2) event.preventDefault();
            }}
            onContextMenu={onContextMenu}
            className="group relative flex w-full cursor-pointer select-none items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-all hover:bg-[var(--hover-bg)]"
            data-history-search-session-row
        >
            {/* Left column: Time — fixed width so content column is consistently left-aligned */}
            <div className="mt-1 flex w-16 shrink-0 items-center gap-1 whitespace-nowrap text-xs text-[var(--ink-muted)]/50">
                <Clock className="h-2.5 w-2.5" />
                <span>{formatTime(displayLastActiveAt)}</span>
            </div>

            {/* Middle column: Title + Snippet */}
            <div className="flex-1 min-w-0">
                {/* First row: Title */}
                <div className="flex items-center text-sm text-[var(--ink-secondary)] transition-colors group-hover:text-[var(--ink)]">
                    <SearchHighlight
                        text={hit.title}
                        highlights={hit.titleHighlights}
                        className="truncate flex-1 min-w-0"
                    />
                    {turnCountStr && (
                        <span className="ml-1.5 shrink-0 text-xs text-[var(--ink-muted)]/40">
                            {turnCountStr}
                        </span>
                    )}
                </div>

                {/* Second row: Content Snippet (Only show if there's a snippet and it's a content match) */}
                {hit.snippet && hit.matchType === 'content' && (
                    <div className="mt-0.5 text-xs text-[var(--ink-muted)] leading-relaxed">
                        <SearchHighlight
                            text={hit.snippet}
                            highlights={hit.snippetHighlights}
                            className="line-clamp-2"
                        />
                    </div>
                )}
            </div>

            {/* Right column: Workspace Icon + Hover Actions */}
            <div className="relative flex shrink-0 items-start justify-end w-[100px] h-full mt-0.5">
                {/* Default state: Workspace Info */}
                <div className="flex items-center gap-1.5 text-xs text-[var(--ink-muted)]/45 transition-opacity group-hover:opacity-0">
                    {project && <WorkspaceIcon icon={project.icon} size={14} />}
                    <span className="truncate max-w-[80px]">
                        {projectName}
                    </span>
                </div>

                {/* Hover state: Actions (Absolute positioned over the workspace info) */}
                <div className="pointer-events-none absolute right-0 top-[-2px] flex items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                    <div className="h-full w-10 bg-gradient-to-r from-[var(--paper-inset-a0)] to-[var(--paper-inset)]" />
                    <div className="flex items-center gap-1 bg-[var(--paper-inset)] pl-1">
                        <button
                            onClick={onShowStats}
                            title={t('historyOverlay.viewStats')}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
                        >
                            <BarChart2 className="h-3.5 w-3.5" />
                        </button>
                        <button
                            onClick={onDelete}
                            title={deleteProtected ? t('historyOverlay.deleteBlocked') : t('historyOverlay.delete')}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
});
