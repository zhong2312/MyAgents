/**
 * SessionMenuButton — the "⋯" overflow menu for the current chat session.
 *
 * Always visible (as long as a session id exists) so the menu surface is a
 * stable affordance, replacing the conditional handover button shipped in the
 * earlier PRD 0.2.14 cut. All single-session actions previously scattered
 * across the SessionHistoryDropdown row hover state are gathered here:
 *
 *   重命名 / 收藏 / 导出 md / 查看消耗统计 / 在聊天机器人继续此对话 › / ─── / 删除
 *
 * The "在聊天机器人继续此对话" submenu replaces the standalone HandoverPopover and
 * branches on whether the session is currently channel-bound:
 *
 *   - unbound        → list available channels; pick one → handover
 *   - already bound  → "已绑定 X·Y" header + other channels (switch) + 新会话
 *
 * Persistent-owner protection is shown as a hint; Rust remains the live
 * deletion authority after confirmation, so stale UI state never blocks it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    BarChart2,
    Check,
    ChevronRight,
    Copy,
    Download,
    Gauge,
    Loader2,
    MessageSquare,
    MoreHorizontal,
    Pencil,
    Star,
    Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { updateSession, type SessionMetadata } from '@/api/sessionClient';
import { handoverSessionToChannel } from '@/api/sessionHandoverClient';
import { useSessionDeletion } from '@/context/SessionDeletionContext';
import { exportSessionAsMarkdown } from '@/utils/sessionExport';
import { copyPlainText } from '@/utils/clipboard';
import type { ChannelSurface } from '@/hooks/useSessionSurfaces';

import ConfirmDialog from './ConfirmDialog';
import SessionStatsModal from './SessionStatsModal';
import Tip from './Tip';
import { useToast } from './Toast';
import { MenuItem } from './ui/MenuItem';
import { Popover } from './ui/Popover';

export interface BotChannelCandidate {
    agentId: string;
    agentName: string;
    channelId: string;
    channelType: string;
    channelName: string;
    /** Localized platform label, e.g. `飞书` */
    platformLabel: string;
    /** Exact peer chat target. Empty when the channel has no known peer session yet. */
    sessionKey?: string;
    sessionId?: string;
    sourceType?: 'private' | 'group';
    sourceId?: string;
    sourceDisplayName?: string;
    disabledReason?: string;
}

export interface SessionMenuButtonProps {
    sessionId: string;
    sessionTitle: string;
    workspacePath: string;
    /** Current binding (null = pure desktop session) */
    boundChannel: ChannelSurface | null;
    /** All online channels for this workspace's Agent — drives the bot submenu. */
    availableChannels: BotChannelCandidate[];
    /** Snapshot hint that a non-Tab owner currently protects this Session. */
    deleteProtected: boolean;
    /** Current favorite state from sessionMeta. */
    favorite: boolean;
    /** False when the title editor isn't mounted (placeholder titles like
     *  "New Tab" / "New Chat") — disables the 重命名 row to avoid a silent
     *  no-op on a click that promised to open the editor. */
    canRename: boolean;
    /** Open the inline title editor — sourced from a SessionTitleEditor ref. */
    onOpenRename: () => void;
    /**
     * Send the SDK `/context` slash command on behalf of the user so the
     * `/context` output (real token-window distribution) lands in the chat
     * stream. Only wired by the caller when the active runtime is `builtin`
     * — external runtimes (Claude Code CLI / Codex / Gemini) don't share
     * this command surface, so the menu item should hide entirely there.
     * The menu omits the row when this prop is undefined.
     */
    onShowContext?: () => void;
    /** Caller persists the change and updates sessionMeta optimistically. */
    onFavoriteChanged?: (next: boolean, updated: SessionMetadata | null) => void;
}

export default function SessionMenuButton({
    sessionId,
    sessionTitle,
    workspacePath,
    boundChannel,
    availableChannels,
    deleteProtected,
    favorite,
    canRename,
    onOpenRename,
    onShowContext,
    onFavoriteChanged,
}: SessionMenuButtonProps) {
    const { t } = useTranslation('chat');
    const toast = useToast();
    const deleteSession = useSessionDeletion();
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const botMenuItemRef = useRef<HTMLButtonElement | null>(null);
    const [open, setOpen] = useState(false);
    const [submenuOpen, setSubmenuOpen] = useState(false);
    // Snapshot the session id+title at modal-open time so the stats view
    // doesn't silently switch to a different session if the parent tab
    // rotates `sessionId` (e.g. a "+新对话" elsewhere) while the modal is up.
    // Same defensive snapshot as SessionHistoryDropdown's `statsSession`.
    const [statsTarget, setStatsTarget] = useState<{ id: string; title: string } | null>(null);
    const [pendingDelete, setPendingDelete] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [favoriteInFlight, setFavoriteInFlight] = useState(false);
    const [handoverPendingTargetKey, setHandoverPendingTargetKey] = useState<string | null>(null);
    const [sessionIdCopied, setSessionIdCopied] = useState(false);
    const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        return () => {
            if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
        };
    }, []);

    const closeAll = useCallback(() => {
        setOpen(false);
        setSubmenuOpen(false);
    }, []);

    // ─── Actions ──────────────────────────────────────────────────────────

    const handleRename = useCallback(() => {
        closeAll();
        // Defer to next tick so the popover unmounts (and releases focus
        // to body) before we focus the title input — otherwise the
        // popover's outside-click cleanup races with the input's auto-select.
        setTimeout(onOpenRename, 0);
    }, [closeAll, onOpenRename]);

    const handleCopySessionId = useCallback(async () => {
        const text = `SessionID: ${sessionId}`;
        try {
            await copyPlainText(text);
            setSessionIdCopied(true);
            if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
            copyResetTimerRef.current = setTimeout(() => setSessionIdCopied(false), 1600);
            toast.success(t('shell.sessionMenu.toasts.copySessionIdSuccess'));
        } catch (err) {
            console.error('[SessionMenuButton] copy session id failed:', err);
            toast.error(t('shell.sessionMenu.toasts.copyFailed'));
        }
    }, [sessionId, toast, t]);

    const handleToggleFavorite = useCallback(async () => {
        if (favoriteInFlight) return;
        setFavoriteInFlight(true);
        const next = !favorite;
        try {
            const updated = await updateSession(sessionId, { favorite: next });
            if (updated) {
                onFavoriteChanged?.(next, updated);
                toast.success(next
                    ? t('shell.sessionMenu.toasts.favoriteAdded')
                    : t('shell.sessionMenu.toasts.favoriteRemoved'));
            } else {
                toast.error(t('shell.sessionMenu.toasts.favoriteFailed'));
            }
        } catch (err) {
            console.error('[SessionMenuButton] toggle favorite failed:', err);
            toast.error(t('shell.sessionMenu.toasts.favoriteFailed'));
        } finally {
            setFavoriteInFlight(false);
            closeAll();
        }
    }, [favoriteInFlight, favorite, sessionId, onFavoriteChanged, toast, closeAll, t]);

    const handleExport = useCallback(async () => {
        if (exporting) return;
        setExporting(true);
        try {
            const result = await exportSessionAsMarkdown(sessionId);
            if (result.ok) toast.success(result.message);
            else toast.error(result.message);
        } finally {
            setExporting(false);
            closeAll();
        }
    }, [exporting, sessionId, toast, closeAll]);

    const handleShowStats = useCallback(() => {
        setStatsTarget({ id: sessionId, title: sessionTitle || t('shell.currentChatFallback') });
        closeAll();
    }, [sessionId, sessionTitle, closeAll, t]);

    const handleShowContext = useCallback(() => {
        if (!onShowContext) return;
        closeAll();
        onShowContext();
    }, [onShowContext, closeAll]);

    const handleDeleteClick = useCallback(() => {
        closeAll();
        setPendingDelete(true);
    }, [closeAll]);

    const handleConfirmDelete = useCallback(async () => {
        setPendingDelete(false);
        try {
            const result = await deleteSession(sessionId);
            if (result.deleted) {
                toast.success(t('shell.sessionMenu.toasts.deleted'));
            } else if (result.reason === 'in-use') {
                toast.warning(t('shell.sessionMenu.deleteBlockedByOwner'));
            } else if (result.reason === 'transition-in-progress') {
                toast.warning(t('shell.sessionMenu.deleteTransitionInProgress'));
            } else if (result.reason === 'activity-unavailable') {
                toast.warning(t('shell.sessionMenu.deleteActivityUnavailable'));
            } else {
                toast.error(t('shell.sessionMenu.toasts.deleteFailed'));
            }
        } catch (err) {
            console.error('[SessionMenuButton] delete failed:', err);
            toast.error(t('shell.sessionMenu.toasts.deleteFailed'));
        }
    }, [deleteSession, sessionId, toast, t]);

    // ─── Bot submenu ──────────────────────────────────────────────────────

    const handleHandover = useCallback(async (candidate: BotChannelCandidate) => {
        if (handoverPendingTargetKey) return;
        if (!candidate.sessionKey || candidate.disabledReason) return;
        setHandoverPendingTargetKey(candidate.sessionKey);
        try {
            const res = await handoverSessionToChannel({
                sessionId,
                agentId: candidate.agentId,
                channelId: candidate.channelId,
                sessionKey: candidate.sessionKey,
                workspacePath,
            });
            if (res.ok) {
                if (res.notified) {
                    toast.success(t('shell.sessionMenu.toasts.handoverSuccess', {
                        target: `${candidate.platformLabel} · ${candidate.channelName}`,
                    }));
                } else {
                    // Step 7 (adapter.send_message) failed but the binding
                    // is in place. Surface the partial failure instead of
                    // silently treating it as full success — the user needs
                    // to know the IM end didn't get notified so they can
                    // ping the channel manually if needed. v0.2.14 dogfood
                    // showed silent-fail leading to "did this work?" UX.
                    toast.error(t('shell.sessionMenu.toasts.handoverNotifyFailed', {
                        target: `${candidate.platformLabel} · ${candidate.channelName}`,
                    }));
                }
                closeAll();
            } else {
                toast.error(t('shell.sessionMenu.toasts.handoverFailed'));
            }
        } catch (err) {
            console.error('[SessionMenuButton] handover failed:', err);
            toast.error(t('shell.sessionMenu.toasts.handoverFailedWithError', {
                error: err instanceof Error ? err.message : String(err),
            }));
        } finally {
            setHandoverPendingTargetKey(null);
        }
    }, [handoverPendingTargetKey, sessionId, workspacePath, toast, closeAll, t]);

    // Show the bot menu item when we either have channels to bind to OR the
    // session is already bound — otherwise a session bound to a transiently
    // offline channel loses the entire submenu (including "新会话") while the
    // bot is reconnecting, leaving the user no way to act on the binding.
    const showBotItem = !!boundChannel || availableChannels.length > 0;
    const otherChannels = boundChannel
        ? availableChannels.filter((c) => c.sessionKey !== boundChannel.sessionKey)
        : availableChannels;

    return (
        <>
            <Tip label={t('shell.sessionMenu.trigger')} position="bottom" disabled={open}>
                <button
                    ref={triggerRef}
                    type="button"
                    aria-label={t('shell.sessionMenu.trigger')}
                    aria-expanded={open}
                    aria-haspopup="menu"
                    onClick={() => setOpen((prev) => !prev)}
                    className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                        open
                            ? 'bg-[var(--paper-inset)] text-[var(--ink)]'
                            : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                    }`}
                >
                    <MoreHorizontal className="h-4 w-4" />
                </button>
            </Tip>

            <Popover
                open={open}
                onClose={closeAll}
                anchorRef={triggerRef}
                placement="bottom-start"
                offset={6}
                className="w-56 py-1"
            >
                <div className="border-b border-[var(--line-subtle)] px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2 text-xs">
                        <span className="shrink-0 text-[var(--ink-muted)]">SessionID:</span>
                        <span
                            className="min-w-0 flex-1 truncate font-mono text-[var(--ink)]"
                            title={sessionId}
                        >
                            {sessionId}
                        </span>
                        <button
                            type="button"
                            onClick={() => { void handleCopySessionId(); }}
                            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-[var(--accent)] transition-colors hover:bg-[var(--accent-warm-subtle)]"
                            aria-label={t('shell.sessionMenu.copySessionIdAria')}
                        >
                            {sessionIdCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                            <span>{sessionIdCopied ? t('shell.sessionMenu.copied') : t('shell.sessionMenu.copy')}</span>
                        </button>
                    </div>
                </div>
                <MenuItem
                    icon={<Pencil className="h-3.5 w-3.5" />}
                    label={t('shell.sessionMenu.rename')}
                    onClick={canRename ? handleRename : undefined}
                    disabled={!canRename}
                    title={canRename ? undefined : t('shell.sessionMenu.renameDisabledTitle')}
                />
                <MenuItem
                    icon={<Star className="h-3.5 w-3.5" fill={favorite ? 'currentColor' : 'none'} />}
                    label={favorite ? t('shell.sessionMenu.unfavorite') : t('shell.sessionMenu.favorite')}
                    onClick={() => { void handleToggleFavorite(); }}
                    disabled={favoriteInFlight}
                />
                <MenuItem
                    icon={exporting
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Download className="h-3.5 w-3.5" />}
                    label={t('shell.sessionMenu.exportMarkdown')}
                    onClick={() => { void handleExport(); }}
                    disabled={exporting}
                />
                <MenuItem
                    icon={<BarChart2 className="h-3.5 w-3.5" />}
                    label={t('shell.sessionMenu.tokenStats')}
                    onClick={handleShowStats}
                />
                {onShowContext && (
                    <MenuItem
                        icon={<Gauge className="h-3.5 w-3.5" />}
                        label={t('shell.sessionMenu.contextUsage')}
                        onClick={handleShowContext}
                    />
                )}
                {showBotItem && (
                    <MenuItem
                        ref={botMenuItemRef}
                        icon={<MessageSquare className="h-3.5 w-3.5" />}
                        label={t('shell.sessionMenu.continueInBot')}
                        trailing={(
                            <ChevronRight
                                className="h-4 w-4 shrink-0 text-[var(--ink-muted)]"
                                data-session-menu-submenu-chevron
                            />
                        )}
                        onClick={() => setSubmenuOpen((prev) => !prev)}
                        active={submenuOpen}
                    />
                )}
                <div className="my-1 border-t border-[var(--line-subtle)]" />
                {/* The snapshot only explains why deletion may be refused.
                 * The click still reaches the lock-held Rust authority after
                 * confirmation, so a stale projection cannot block deletion. */}
                <MenuItem
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                    label={t('shell.sessionMenu.delete')}
                    onClick={handleDeleteClick}
                    title={deleteProtected ? t('shell.sessionMenu.deleteBlockedByOwner') : undefined}
                    tone="danger"
                />
            </Popover>

            {/* Bot submenu — anchored to the menu item so it floats to the side. */}
            {showBotItem && (
                <Popover
                    open={open && submenuOpen}
                    onClose={() => setSubmenuOpen(false)}
                    anchorRef={botMenuItemRef}
                    placement="right-start"
                    offset={6}
                    className="w-64 py-1"
                    zIndex={261}
                >
                    {boundChannel ? (
                        <>
                            {/* Bound row mirrors the candidate-row layout
                             *  (`<platform> · <bot>`) with a trailing
                             *  "已绑定" tag instead of a click target — same
                             *  visual rhythm as the unselected options, just
                             *  in the selected state. */}
                            <div
                                aria-disabled
                                className="flex w-full cursor-default items-center gap-2 px-3 py-2 text-left text-sm"
                            >
                                <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--success)]" />
                                <span className="shrink-0 font-medium text-[var(--ink)]">{boundChannel.platformLabel}</span>
                                <span className="shrink-0 text-[var(--ink-subtle)]">·</span>
                                <span className="min-w-0 flex-1 truncate text-[var(--ink-muted)]">
                                    {boundChannel.channelName}
                                    {boundChannel.sourceDisplayName
                                        ? ` · ${formatSourceLabel(boundChannel.sourceType, {
                                            privateLabel: t('shell.sessionMenu.source.private'),
                                            groupLabel: t('shell.sessionMenu.source.group'),
                                        })} ${boundChannel.sourceDisplayName}`
                                        : ''}
                                </span>
                                <span className="shrink-0 rounded-sm bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]">
                                    {t('shell.sessionMenu.bound')}
                                </span>
                            </div>
                            {otherChannels.length > 0 && (
                                <>
                                    <div className="my-1 border-t border-[var(--line-subtle)]" />
                                    <div className="px-3 py-1 text-xs uppercase tracking-wide text-[var(--ink-subtle)]">
                                        {t('shell.sessionMenu.switchToOther')}
                                    </div>
                                    {otherChannels.map((c) => (
                                        <ChannelMenuItem
                                            key={c.sessionKey || c.channelId}
                                            candidate={c}
                                            pending={handoverPendingTargetKey === c.sessionKey}
                                            disabled={handoverPendingTargetKey !== null}
                                            privateLabel={t('shell.sessionMenu.source.private')}
                                            groupLabel={t('shell.sessionMenu.source.group')}
                                            unknownChatLabel={t('shell.sessionMenu.source.unknownChat')}
                                            onClick={() => { void handleHandover(c); }}
                                        />
                                    ))}
                                </>
                            )}
                        </>
                    ) : (
                        availableChannels.map((c) => (
                            <ChannelMenuItem
                                key={c.sessionKey || c.channelId}
                                candidate={c}
                                pending={handoverPendingTargetKey === c.sessionKey}
                                disabled={handoverPendingTargetKey !== null}
                                privateLabel={t('shell.sessionMenu.source.private')}
                                groupLabel={t('shell.sessionMenu.source.group')}
                                unknownChatLabel={t('shell.sessionMenu.source.unknownChat')}
                                onClick={() => { void handleHandover(c); }}
                            />
                        ))
                    )}
                </Popover>
            )}

            {/* Stats modal — portal to document.body to escape the chat header's
             *  z-10 stacking context, otherwise the side workspace panel
             *  (rendered as a sibling of the chat content) paints over the
             *  fixed-position OverlayBackdrop. Same fix SessionHistoryDropdown
             *  applies for the same reason. */}
            {statsTarget && createPortal(
                <SessionStatsModal
                    sessionId={statsTarget.id}
                    sessionTitle={statsTarget.title}
                    onClose={() => setStatsTarget(null)}
                />,
                document.body,
            )}

            {/* Delete confirm */}
            {pendingDelete && (
                <ConfirmDialog
                    title={t('shell.sessionMenu.deleteDialog.title')}
                    message={t('shell.sessionMenu.deleteDialog.message', {
                        title: sessionTitle || t('shell.currentChatFallback'),
                    })}
                    confirmText={t('shell.sessionMenu.deleteDialog.confirm')}
                    confirmVariant="danger"
                    onConfirm={handleConfirmDelete}
                    onCancel={() => setPendingDelete(false)}
                />
            )}
        </>
    );
}

// ============================================================================
// Internal building blocks
// ============================================================================

interface ChannelMenuItemProps {
    candidate: BotChannelCandidate;
    pending: boolean;
    disabled: boolean;
    privateLabel: string;
    groupLabel: string;
    unknownChatLabel: string;
    onClick: () => void;
}

function ChannelMenuItem({
    candidate,
    pending,
    disabled,
    privateLabel,
    groupLabel,
    unknownChatLabel,
    onClick,
}: ChannelMenuItemProps) {
    const effectivelyDisabled = disabled || !!candidate.disabledReason || !candidate.sessionKey;
    const sourceLabel = candidate.disabledReason
        ? candidate.disabledReason
        : `${formatSourceLabel(candidate.sourceType, { privateLabel, groupLabel })} · ${candidate.sourceDisplayName || candidate.sourceId || unknownChatLabel}`;

    return (
        <button
            type="button"
            disabled={effectivelyDisabled}
            onClick={onClick}
            className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
        >
            <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--success)]" />
            <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                    <span className="shrink-0 font-medium text-[var(--ink)]">{candidate.platformLabel}</span>
                    <span className="shrink-0 text-[var(--ink-subtle)]">·</span>
                    <span className="min-w-0 truncate text-[var(--ink-muted)]">
                        {candidate.channelName}
                    </span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-[var(--ink-subtle)]">
                    {sourceLabel}
                </span>
            </span>
            {pending && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--ink-muted)]" />}
        </button>
    );
}

function formatSourceLabel(
    sourceType: 'private' | 'group' | undefined,
    labels: { privateLabel: string; groupLabel: string },
): string {
    return sourceType === 'group' ? labels.groupLabel : labels.privateLabel;
}
