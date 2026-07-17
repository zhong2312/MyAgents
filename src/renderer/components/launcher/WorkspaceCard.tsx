/**
 * WorkspaceCard - Compact clickable project card for the launcher
 * Single-click to launch, right-click context menu for pin/edit/remove
 *
 * Proactive Agent cards show compact per-channel status tags beside the title
 */

import { memo, useCallback, useRef, useState } from 'react';
import { Archive, FolderOpen, Loader2, RotateCcw, Trash2, Settings2, HeartPulse, MoreHorizontal, Pin, PinOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { MenuItem } from '@/components/ui/MenuItem';
import { Popover } from '@/components/ui/Popover';
import type { Project } from '@/config/types';
import type { AgentConfig } from '../../../shared/types/agent';
import type { AgentStatusData } from '@/hooks/useAgentStatuses';
import { getFolderName } from '@/types/tab';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import WorkspaceIcon from './WorkspaceIcon';
import { getChannelTypeLabel } from '@/utils/taskCenterUtils';

// ─── Proactive status helpers ─────────────────────────────────────

type ProactiveState = 'basic' | 'pending' | 'active' | 'paused' | 'error';

function deriveState(p: Project, a?: AgentConfig, s?: AgentStatusData): ProactiveState {
    if (!p.isAgent || !a) return 'basic';
    if (!a.enabled) return 'basic';
    if (!(a.channels?.length)) return 'pending';
    if (s) {
        if (s.channels.some(c => c.status === 'online' || c.status === 'connecting')) return 'active';
        if (s.channels.some(c => c.status === 'error')) return 'error';
    }
    return 'paused';
}


// ─── Component ────────────────────────────────────────────────────

interface WorkspaceCardProps {
    project: Project;
    agent?: AgentConfig;
    agentStatus?: AgentStatusData;
    onLaunch: (project: Project) => void;
    onRemove: (project: Project) => void;
    onArchive: (project: Project) => void;
    onUnarchive: (project: Project) => void;
    onAgentSettings: (project: Project) => void;
    onOpenFolder: (project: Project) => void;
    onTogglePin: (project: Project) => void;
    workbenchLabel?: string;
    isLoading?: boolean;
    archived?: boolean;
}

export default memo(function WorkspaceCard({
    project,
    agent,
    agentStatus,
    onLaunch,
    onRemove,
    onArchive,
    onUnarchive,
    onAgentSettings,
    onOpenFolder,
    onTogglePin,
    workbenchLabel,
    isLoading,
    archived = false,
}: WorkspaceCardProps) {
    const { t } = useTranslation('launcher');
    // Context menu state
    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        placement: 'bottom-start' | 'bottom-end';
    } | null>(null);
    const menuAnchorRef = useRef<HTMLSpanElement | null>(null);

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        if (isLoading) return;
        window.getSelection()?.removeAllRanges();
        setContextMenu({ x: e.clientX, y: e.clientY, placement: 'bottom-start' });
    }, [isLoading]);

    const handleMoreClick = useCallback((e: React.MouseEvent<HTMLSpanElement>) => {
        e.stopPropagation();
        if (isLoading) return;
        const rect = e.currentTarget.getBoundingClientRect();
        setContextMenu({
            x: rect.right,
            y: rect.bottom,
            placement: 'bottom-end',
        });
    }, [isLoading]);

    const closeContextMenu = useCallback(() => setContextMenu(null), []);

    const displayName = project.displayName || getFolderName(project.path);
    const state = archived ? 'basic' : deriveState(project, agent, agentStatus);
    const isProactive = state !== 'basic';
    const isPinned = Boolean(project.pinnedAt);
    const channelTags = isProactive && state !== 'pending'
        ? (agent?.channels ?? []).map(ch => {
            const runtime = agentStatus?.channels.find(c => c.channelId === ch.id);
            return {
                id: ch.id,
                label: getChannelTypeLabel(ch.type),
                isOn: runtime?.status === 'online' || runtime?.status === 'connecting',
                isErr: runtime?.status === 'error',
            };
        })
        : [];

    return (
        <>
            <button
                type="button"
                onClick={() => !isLoading && onLaunch(project)}
                onContextMenu={handleContextMenu}
                disabled={isLoading}
                className={`group relative flex w-full items-center gap-3 overflow-hidden rounded-xl bg-[var(--paper-elevated)] px-4 py-3 text-left transition-shadow duration-150 ease-out hover:z-20 hover:shadow-sm focus-visible:z-20 active:scale-[0.98] ${
                    isLoading ? 'pointer-events-none opacity-60' : 'cursor-pointer'
                } ${archived ? 'opacity-75' : ''}`}
            >
                {/* Icon */}
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
                    {isLoading ? (
                        <Loader2 className="h-5 w-5 animate-spin text-[var(--ink-subtle)]" />
                    ) : (
                        <WorkspaceIcon icon={project.icon} size={28} />
                    )}
                </div>

                {/* Text + channel tags */}
                <div className="min-w-0 flex-1">
                    <h3 className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-sm font-medium text-[var(--ink)]">
                        <span className="min-w-0 shrink truncate">{displayName}</span>
                        {archived && (
                            <span className="shrink-0 rounded-[3px] bg-[var(--paper-inset)] px-1.5 py-[1px] text-xs font-medium text-[var(--ink-muted)]">
                                {t('workspaceCard.archivedBadge')}
                            </span>
                        )}
                        {workbenchLabel && (
                            <span className="shrink-0 rounded-[3px] bg-[var(--accent-warm-subtle)] px-1.5 py-[1px] text-xs font-medium text-[var(--accent-warm)]">
                                {workbenchLabel}
                            </span>
                        )}
                        {isProactive && <HeartPulse className="h-3 w-3 shrink-0 text-[var(--heartbeat)]" />}
                        {channelTags.length > 0 && (
                            <span className="workspace-card-channel-tags-fade inline-flex min-w-0 flex-1 overflow-hidden whitespace-nowrap">
                                <span className="inline-flex shrink-0 items-center gap-1">
                                    {channelTags.map(tag => (
                                        <span
                                            key={tag.id}
                                            className={`inline-flex shrink-0 items-center gap-[3px] rounded-[3px] px-1 py-[1px] text-xs leading-[14px] ${
                                                tag.isErr
                                                    ? 'text-[var(--error)]'
                                                    : tag.isOn
                                                        ? 'text-[var(--success)]'
                                                        : 'bg-[var(--paper-inset)] text-[var(--ink-subtle)]'
                                            }`}
                                            style={tag.isErr
                                                ? { backgroundColor: 'color-mix(in srgb, var(--error) 12%, transparent)' }
                                                : tag.isOn
                                                    ? { backgroundColor: 'color-mix(in srgb, var(--success) 12%, transparent)' }
                                                    : undefined
                                            }
                                        >
                                            <span className={`h-[5px] w-[5px] rounded-full ${
                                                tag.isErr
                                                    ? 'bg-[var(--error)]'
                                                    : tag.isOn
                                                        ? 'bg-[var(--success)]'
                                                        : 'bg-[var(--ink-faint)]'
                                            }`} />
                                            {tag.label}
                                        </span>
                                    ))}
                                </span>
                            </span>
                        )}
                    </h3>
                    <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">
                        {shortenPathForDisplay(project.path)}
                    </p>
                </div>

                {/* More shortcut — visible on hover, opens the same menu as right-click */}
                {!isLoading && (
                    <div className="workspace-card-action-overlay pointer-events-none absolute inset-y-0 right-0 z-20 flex w-20 items-center justify-end pr-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <span
                            className="group/btn pointer-events-auto relative z-20 rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                            role="button"
                            tabIndex={-1}
                            aria-label={t('workspaceCard.more')}
                            onClick={handleMoreClick}
                        >
                            <MoreHorizontal className="h-4 w-4" strokeWidth={2.2} />
                        </span>
                    </div>
                )}
            </button>

            {/* Right-click context menu */}
            {contextMenu && (
                <>
                    <span
                        ref={menuAnchorRef}
                        className="fixed h-px w-px"
                        style={{ left: contextMenu.x, top: contextMenu.y }}
                        aria-hidden
                    />
                    <Popover
                        open
                        onClose={closeContextMenu}
                        anchorRef={menuAnchorRef}
                        placement={contextMenu.placement}
                        offset={2}
                        className="w-36 py-1"
                    >
                        {!archived && (
                            <MenuItem
                                icon={isPinned
                                    ? <PinOff className="h-3.5 w-3.5" />
                                    : <Pin className="h-3.5 w-3.5" />}
                                label={isPinned ? t('workspaceCard.unpin') : t('workspaceCard.pin')}
                                onClick={() => {
                                    closeContextMenu();
                                    onTogglePin(project);
                                }}
                            />
                        )}
                        <MenuItem
                            icon={<Settings2 className="h-3.5 w-3.5" />}
                            label={t('workspaceCard.agentSettings')}
                            onClick={() => {
                                closeContextMenu();
                                onAgentSettings(project);
                            }}
                        />
                        <MenuItem
                            icon={archived
                                ? <RotateCcw className="h-3.5 w-3.5" />
                                : <Archive className="h-3.5 w-3.5" />}
                            label={archived ? t('workspaceCard.unarchive') : t('workspaceCard.archive')}
                            onClick={() => {
                                closeContextMenu();
                                if (archived) onUnarchive(project);
                                else onArchive(project);
                            }}
                        />
                        <MenuItem
                            icon={<FolderOpen className="h-3.5 w-3.5" />}
                            label={t('workspaceCard.openFolder')}
                            onClick={() => {
                                closeContextMenu();
                                onOpenFolder(project);
                            }}
                        />
                        <MenuItem
                            icon={<Trash2 className="h-3.5 w-3.5" />}
                            label={t('workspaceCard.remove')}
                            tone="danger"
                            onClick={() => {
                                closeContextMenu();
                                onRemove(project);
                            }}
                        />
                    </Popover>
                </>
            )}
        </>
    );
});
