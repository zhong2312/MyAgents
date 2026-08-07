import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { BarChart2, Clock, Download, Eye, EyeOff, Loader2, MoreHorizontal, SquareArrowOutUpRight, Star, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getSessions, updateSession, type SessionMetadata } from '@/api/sessionClient';
import { useSessionDeletion } from '@/context/SessionDeletionContext';
import { exportSessionAsMarkdown } from '@/utils/sessionExport';
import { CUSTOM_EVENTS } from '../../shared/constants';
import { getWorkspaceCronTasks, getBackgroundSessions } from '@/api/cronTaskClient';
import type { CronTask } from '@/types/cronTask';
import { formatTokens } from '@/utils/formatTokens';
import { formatTime } from '@/utils/taskCenterUtils';
import { isTauriEnvironment } from '@/utils/browserMock';
import { listenWithCleanup } from '@/utils/tauriListen';
import type { AgentStatusMap } from '@/hooks/useAgentStatuses';
import { computeSessionTagsMap, resolveFloatingBallBoundSession } from '@/hooks/taskCenterStore';
import { loadAppConfig } from '@/config/configService';
import { getSessionDisplayText } from '@/utils/sessionDisplay';
import type { SessionTag } from '@/hooks/useTaskCenterData';
import { currentSupportedLocale } from '@/i18n/format';
import { isAutomationHistoryOrigin, isSystemMaintenanceSession } from '../../shared/session-origin';

import ConfirmDialog from './ConfirmDialog';
import SessionStatsModal from './SessionStatsModal';
import SessionTagBadge from './SessionTagBadge';
import Tip from './Tip';
import { useToast } from './Toast';
import { MenuItem } from './ui/MenuItem';
import { Popover } from './ui/Popover';
import UnreadNotificationIndicator from './UnreadNotificationIndicator';

interface SessionHistoryDropdownProps {
    agentDir: string;
    currentSessionId: string | null;
    onSelectSession: (sessionId: string, title: string) => void;
    /**
     * Explicit per-row new-tab action. The Chat surface routes both selection
     * actions through the same App navigation owner.
     */
    onOpenInNewTab?: (sessionId: string, title: string) => void;
    isOpen: boolean;
    onClose: () => void;
    /** Trigger button ref — anchors the dropdown via the Popover primitive. */
    triggerRef: React.RefObject<HTMLElement | null>;
    sessionNotificationBadgeCounts?: ReadonlyMap<string, number>;
}

// Track fetch state: null = not fetched, empty array = fetched but empty
type FetchState = SessionMetadata[] | null;
type CronTaskFetchState = CronTask[] | null;
const EMPTY_SESSION_NOTIFICATION_BADGE_COUNTS = new Map<string, number>();
const SHOW_AUTOMATION_HISTORY_STORAGE_KEY = 'myagents.chat.showAutomationHistorySessions';

export default function SessionHistoryDropdown({
    agentDir,
    currentSessionId,
    onSelectSession,
    onOpenInNewTab,
    isOpen,
    onClose,
    triggerRef,
    sessionNotificationBadgeCounts = EMPTY_SESSION_NOTIFICATION_BADGE_COUNTS,
}: SessionHistoryDropdownProps) {
    const { t } = useTranslation('chat');
    const toast = useToast();
    const deleteSession = useSessionDeletion();
    const locale = currentSupportedLocale();
    const [sessions, setSessions] = useState<FetchState>(null);
    const [cronTasks, setCronTasks] = useState<CronTaskFetchState>(null);
    const [statsSession, setStatsSession] = useState<{ id: string; title: string } | null>(null);
    const [showAutomationSessions, setShowAutomationSessions] = useState(() => {
        if (typeof window === 'undefined') return false;
        return window.localStorage.getItem(SHOW_AUTOMATION_HISTORY_STORAGE_KEY) === 'true';
    });
    // Track pending delete to show confirmation UI
    // Pending delete carries the session title so the confirm dialog can show
    // a recognizable label even after the row scrolls out / the user blurs.
    // Keeping `id` separate from `title` (vs. just `id`) lets us survive the
    // window where `setSessions` mutates the list mid-confirm.
    const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
    // Track delete error for user feedback
    const [deleteError, setDeleteError] = useState<string | null>(null);

    // Per-row "更多" overflow menu: which session's menu is open, and the
    // anchor element it floats from. The anchor is a plain mutable ref (set on
    // click) — the Popover re-binds `anchorRef.current` every render, so the
    // `setMenuSessionId` state flip is what makes it pick up the new element.
    const [menuSessionId, setMenuSessionId] = useState<string | null>(null);
    const menuAnchorRef = useRef<HTMLButtonElement | null>(null);
    const closeMenu = useCallback(() => {
        setMenuSessionId(null);
        menuAnchorRef.current = null;
    }, []);

    const onCloseRef = useRef(onClose);
    const statsSessionRef = useRef(statsSession);
    const sessionsFetchSeqRef = useRef(0);
    const sessionsAppliedSeqRef = useRef(0);

    const applySessionsIfFresh = useCallback((seq: number, data: SessionMetadata[]) => {
        if (seq <= sessionsAppliedSeqRef.current) return;
        sessionsAppliedSeqRef.current = seq;
        setSessions(data);
    }, []);

    const applySessionsErrorIfFresh = useCallback((seq: number) => {
        if (seq <= sessionsAppliedSeqRef.current) return;
        sessionsAppliedSeqRef.current = seq;
        setSessions([]);
    }, []);

    const invalidateSessionsFetches = useCallback(() => {
        const staleSeq = sessionsFetchSeqRef.current + 1;
        sessionsFetchSeqRef.current = staleSeq;
        sessionsAppliedSeqRef.current = Math.max(sessionsAppliedSeqRef.current, staleSeq);
    }, []);

    // Agent statuses for active session tagging
    const [agentStatuses, setAgentStatuses] = useState<AgentStatusMap>({});
    const [backgroundSessionIds, setBackgroundSessionIds] = useState<string[]>([]);
    // 悬浮球渠道当前绑定的 session（gate-aware）——历史列表给它打「悬浮球」标
    const [fbSessionId, setFbSessionId] = useState<string | null>(null);

    // Session tags：复用 taskCenterStore 的纯核心（此前这里手抄了一份同构
    // 实现，悬浮球标签加入时顺手归一——两处漂移正是"加一种标签漏一处"的
    // 温床）。
    const sessionTagsMap = useMemo(() => {
        if (!sessions) return new Map<string, SessionTag[]>();
        return computeSessionTagsMap(sessions, cronTasks ?? [], backgroundSessionIds, agentStatuses, fbSessionId);
    }, [sessions, cronTasks, backgroundSessionIds, agentStatuses, fbSessionId]);

    // Sorted sessions: tagged first, then by lastActiveAt descending within each group
    const sortedSessions = useMemo(() => {
        if (!sessions) return [];
        return sessions.filter((session) => {
            if (isSystemMaintenanceSession(session)) return false;
            return showAutomationSessions || !isAutomationHistoryOrigin(session.origin, {
                cronTaskId: session.cronTaskId,
                source: session.source,
            });
        }).sort((a, b) => {
            const aHasTag = sessionTagsMap.has(a.id);
            const bHasTag = sessionTagsMap.has(b.id);
            if (aHasTag !== bHasTag) return aHasTag ? -1 : 1;
            return new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();
        });
    }, [sessions, sessionTagsMap, showAutomationSessions]);

    useEffect(() => {
        window.localStorage.setItem(
            SHOW_AUTOMATION_HISTORY_STORAGE_KEY,
            showAutomationSessions ? 'true' : 'false',
        );
    }, [showAutomationSessions]);

    // Keep refs updated via effect (not during render)
    useEffect(() => {
        onCloseRef.current = onClose;
        statsSessionRef.current = statsSession;
    }, [onClose, statsSession]);

    // Load sessions and cron tasks when opened
    useEffect(() => {
        if (!isOpen || !agentDir) return;

        let cancelled = false;
        const sessionsFetchSeq = ++sessionsFetchSeqRef.current;

        (async () => {
            // Load sessions, cron tasks, agent statuses, and background sessions in parallel
            const agentStatusPromise = isTauriEnvironment()
                ? import('@tauri-apps/api/core')
                    .then(({ invoke }) => invoke<AgentStatusMap>('cmd_all_agents_status'))
                    .catch(() => ({} as AgentStatusMap))
                : Promise.resolve({} as AgentStatusMap);

            const [sessionsResult, cronTasksResult, agentStatusResult, bgSessionsResult, configResult] = await Promise.allSettled([
                getSessions(agentDir),
                getWorkspaceCronTasks(agentDir),
                agentStatusPromise,
                getBackgroundSessions().catch(() => [] as string[]),
                loadAppConfig(),
            ]);

            if (cancelled) return;

            // Always set sessions if available (primary data). Multiple refresh
            // sources can overlap while the dropdown is open. Newer successes
            // beat older responses, but a newer failed refresh must not suppress
            // an older successful initial load.
            if (sessionsResult.status === 'fulfilled') {
                applySessionsIfFresh(sessionsFetchSeq, sessionsResult.value);
            } else {
                console.error('[SessionHistoryDropdown] Failed to load sessions:', sessionsResult.reason);
                applySessionsErrorIfFresh(sessionsFetchSeq); // Show empty state rather than loading forever
            }

            // Cron tasks are optional enhancement - don't block on failure
            if (cronTasksResult.status === 'fulfilled') {
                setCronTasks(cronTasksResult.value);
            } else {
                console.error('[SessionHistoryDropdown] Failed to load cron tasks:', cronTasksResult.reason);
                setCronTasks([]); // Fall back to no cron task indicators
            }

            // Agent statuses
            if (agentStatusResult.status === 'fulfilled') {
                setAgentStatuses(agentStatusResult.value);
            }

            // Background sessions
            if (bgSessionsResult.status === 'fulfilled') {
                setBackgroundSessionIds(bgSessionsResult.value);
            }

            // Floating ball binding（失败 = 不打标，可选增强）
            if (configResult.status === 'fulfilled') {
                setFbSessionId(resolveFloatingBallBoundSession(configResult.value));
            }
        })();

        return () => {
            cancelled = true;
            invalidateSessionsFetches();
            // Reset state when closing or agentDir changes
            setSessions(null);
            setCronTasks(null);
            setAgentStatuses({});
            setBackgroundSessionIds([]);
            setFbSessionId(null);
            setStatsSession(null);
            setPendingDelete(null);
            setDeleteError(null);
            setMenuSessionId(null);
        };
    }, [isOpen, agentDir, applySessionsIfFresh, applySessionsErrorIfFresh, invalidateSessionsFetches]);

    // Refetch when session title changes (auto-generated or user rename)
    useEffect(() => {
        if (!isOpen || !agentDir) return;
        const handler = () => {
            const sessionsFetchSeq = ++sessionsFetchSeqRef.current;
            getSessions(agentDir)
                .then(data => {
                    applySessionsIfFresh(sessionsFetchSeq, data);
                })
                .catch(() => {});
        };
        window.addEventListener(CUSTOM_EVENTS.SESSION_TITLE_CHANGED, handler);
        return () => window.removeEventListener(CUSTOM_EVENTS.SESSION_TITLE_CHANGED, handler);
    }, [isOpen, agentDir, applySessionsIfFresh]);

    // Real-time tag updates: listen for cron/IM/agent status changes while dropdown is open
    useEffect(() => {
        if (!isOpen || !isTauriEnvironment()) return;
        const ac = new AbortController();

        // Cron task start/stop → refresh row tags.
        const refreshCron = () => {
            getWorkspaceCronTasks(agentDir)
                .then(tasks => { if (!ac.signal.aborted) setCronTasks(tasks); })
                .catch(() => {});
        };
        void listenWithCleanup('cron:task-started', refreshCron, ac.signal);
        void listenWithCleanup('cron:task-stopped', refreshCron, ac.signal);

        // Agent status changes → refresh statuses
        const refreshStatuses = () => {
            import('@tauri-apps/api/core').then(({ invoke }) => {
                invoke<AgentStatusMap>('cmd_all_agents_status')
                    .then(s => { if (!ac.signal.aborted) setAgentStatuses(s); })
                    .catch(() => {});
            }).catch(() => {});
        };
        void listenWithCleanup('agent:status-changed', refreshStatuses, ac.signal);

        // Background completion is the global completion signal for turns that
        // finished after this tab moved away from their sidecar. That turn can
        // update session metadata (title, lastActiveAt, stats) without any
        // tab-scoped SSE consumer, so refresh sessions along with the tag data.
        void listenWithCleanup('session:background-complete', () => {
            getBackgroundSessions()
                .then(ids => { if (!ac.signal.aborted) setBackgroundSessionIds(ids); })
                .catch(() => {});
            const sessionsFetchSeq = ++sessionsFetchSeqRef.current;
            getSessions(agentDir)
                .then(data => {
                    if (!ac.signal.aborted) applySessionsIfFresh(sessionsFetchSeq, data);
                })
                .catch(() => {});
        }, ac.signal);

        return () => ac.abort();
    }, [isOpen, agentDir, applySessionsIfFresh]);

    // Outside-click + Escape dismissal are owned by the Popover primitive.
    // The `handlePopoverClose` wrapper below blocks close propagation while
    // the stats modal is open — otherwise clicks inside the modal would
    // close the dropdown behind it.
    const handlePopoverClose = useCallback(() => {
        if (statsSessionRef.current) return;
        onClose();
    }, [onClose]);

    // Open the session in a NEW tab. Closes the history dropdown afterwards:
    // opening in a new tab switches the active tab, and this dropdown lives in
    // the (now background) source tab — its body-portaled Popover would
    // otherwise linger on screen over the freshly-opened tab.
    const handleOpenInNewTab = (e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        onOpenInNewTab?.(session.id, getSessionDisplayText(session));
        onClose();
    };

    const handleDeleteClick = (session: SessionMetadata) => {
        setDeleteError(null); // Clear any previous error
        // Show centered ConfirmDialog (matches launcher RecentTasks UX). The
        // previous inline ✓ / ✗ overlay was buggy: its wrapper div carried both
        // `pointer-events-none` (the always-on hover-mask base) and
        // `pointer-events-auto` (the pending-delete override), and Tailwind's
        // CSS-source ordering made `none` win regardless of class-string
        // order, so the "确认" button rendered visible but was unclickable.
        // Routing through ConfirmDialog (modal portal, no parent
        // `pointer-events-none`) sidesteps the class-collision and lines this
        // surface up with the launcher's session-delete confirm.
        setPendingDelete({ id: session.id, title: getSessionDisplayText(session) });
    };

    const handleConfirmDelete = async () => {
        if (!pendingDelete) return;
        const sessionId = pendingDelete.id;
        setPendingDelete(null);
        setDeleteError(null);

        try {
            const result = await deleteSession(sessionId);
            if (result.deleted) {
                setSessions((prev) => prev?.filter((s) => s.id !== sessionId) ?? null);
            } else if (result.reason === 'in-use') {
                toast.warning(t('shell.history.deleteBlockedByOwner'));
            } else if (result.reason === 'transition-in-progress') {
                toast.warning(t('shell.history.deleteTransitionInProgress'));
            } else if (result.reason === 'activity-unavailable') {
                toast.warning(t('shell.history.deleteActivityUnavailable'));
            } else {
                setDeleteError(t('shell.history.errors.deleteFailed'));
                console.error(`[SessionHistoryDropdown] Failed to delete session ${sessionId}`);
            }
        } catch (error) {
            setDeleteError(t('shell.history.errors.deleteFailed'));
            console.error(`[SessionHistoryDropdown] Error deleting session ${sessionId}:`, error);
        }
    };

    const handleCancelDelete = () => {
        setPendingDelete(null);
    };

    const handleShowStats = (session: SessionMetadata) => {
        setStatsSession({ id: session.id, title: getSessionDisplayText(session) });
    };

    // Per-session in-flight guard — rapid double-click on the same star
    // would otherwise fire two PATCHes whose responses can arrive out of
    // order, leaving the optimistic UI and the disk disagreeing on the
    // final state (Codex round-4).
    const favoriteInFlightRef = useRef<Set<string>>(new Set());

    const handleToggleFavorite = useCallback(async (session: SessionMetadata) => {
        if (favoriteInFlightRef.current.has(session.id)) return;
        favoriteInFlightRef.current.add(session.id);
        const next = !session.favorite;
        // Optimistic update: flip the in-memory copy first so the star icon
        // reacts instantly. On failure we revert + toast — better than an
        // awaitable click that "feels broken" on slow disk writes.
        setSessions(prev => prev?.map(s => s.id === session.id ? { ...s, favorite: next } : s) ?? prev);
        try {
            const result = await updateSession(session.id, { favorite: next });
            if (!result) {
                // updateSession returns null on caught error; revert + toast
                // (no synthetic throw — it just gets caught by the same
                // handler below for no UX gain, per Codex review).
                setSessions(prev => prev?.map(s => s.id === session.id ? { ...s, favorite: !next } : s) ?? prev);
                toast.error(t('shell.history.errors.favoriteFailed'));
            }
        } catch (err) {
            console.error('[SessionHistoryDropdown] Toggle favorite failed:', err);
            setSessions(prev => prev?.map(s => s.id === session.id ? { ...s, favorite: !next } : s) ?? prev);
            toast.error(t('shell.history.errors.favoriteFailed'));
        } finally {
            favoriteInFlightRef.current.delete(session.id);
        }
    }, [toast, t]);

    // Export session as .md file — logic lives in utils/sessionExport so
    // the in-Chat session menu (SessionMenuButton) can share it verbatim.
    const [exportingId, setExportingId] = useState<string | null>(null);
    const handleExport = useCallback(async (session: SessionMetadata) => {
        setExportingId(session.id);
        try {
            const result = await exportSessionAsMarkdown(session.id);
            if (result.ok) toast.success(result.message);
            else toast.error(result.message);
        } finally {
            setExportingId(null);
        }
    }, [toast]);

    // Derive loading state: open but sessions not yet fetched
    const isLoading = sessions === null;

    // Resolve the session whose "更多" menu is open (find-by-id survives the
    // list mutating under us, e.g. an optimistic favorite toggle).
    const menuSession = menuSessionId ? sessions?.find((s) => s.id === menuSessionId) ?? null : null;

    // If a refetch drops the session whose menu is open, fully close the menu
    // (clear the id + anchor) — otherwise a later refetch that re-adds the id
    // could reopen the menu against a now-detached/stale anchor element.
    useEffect(() => {
        if (menuSessionId && sessions && !sessions.some((s) => s.id === menuSessionId)) {
            closeMenu();
        }
    }, [sessions, menuSessionId, closeMenu]);

    return (
        <>
            <Popover
                open={isOpen}
                onClose={handlePopoverClose}
                anchorRef={triggerRef}
                placement="bottom-end"
                zIndex={50}
                className="w-96 bg-[var(--paper)] shadow-lg"
            >
                {/* Header */}
                <div className="border-b border-[var(--line)] px-4 py-2">
                    <div className="flex items-center justify-between gap-3">
                        <h3 className="text-sm font-semibold text-[var(--ink)]">{t('shell.history.title')}</h3>
                        <Tip
                            label={showAutomationSessions
                                ? t('shell.history.automationVisible')
                                : t('shell.history.automationHidden')}
                            position="bottom"
                        >
                            <button
                                type="button"
                                onClick={() => setShowAutomationSessions(value => !value)}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                                aria-label={showAutomationSessions
                                    ? t('shell.history.automationVisible')
                                    : t('shell.history.automationHidden')}
                            >
                                {showAutomationSessions
                                    ? <Eye className="h-3.5 w-3.5" />
                                    : <EyeOff className="h-3.5 w-3.5" />}
                            </button>
                        </Tip>
                    </div>
                </div>

                {/* Delete error toast */}
                {deleteError && (
                    <div className="border-b border-[var(--error)]/20 bg-[var(--error)]/10 px-4 py-2 text-xs text-[var(--error)]">
                        {deleteError}
                    </div>
                )}

                {/* Session list */}
                <div className="h-80 overflow-y-auto">
                    {isLoading ? (
                        <div className="flex h-full items-center justify-center px-4 text-center text-sm text-[var(--ink-muted)]">
                            {t('shell.history.loading')}
                        </div>
                    ) : sortedSessions.length === 0 ? (
                        <div className="flex h-full items-center justify-center px-4 text-center text-sm text-[var(--ink-muted)]">
                            {t('shell.history.empty')}
                        </div>
                    ) : (
                        sortedSessions.map((session) => {
                            const isCurrent = session.id === currentSessionId;
                            const tags = sessionTagsMap.get(session.id) ?? [];
                            const stats = session.stats;
                            const displayText = getSessionDisplayText(session);
                            const hasStats = stats && (stats.turnCount > 0 || stats.totalInputTokens > 0);
                            const totalTokens = (stats?.totalInputTokens ?? 0) + (stats?.totalOutputTokens ?? 0);
                            const unreadNotificationCount = sessionNotificationBadgeCounts.get(session.id) ?? 0;

                            // Keep this row's toolbar revealed + highlighted while its
                            // "更多" menu is open, even after the pointer leaves the row.
                            const menuOpen = menuSessionId === session.id;
                            return (
                                <div
                                    key={session.id}
                                    className={`group relative cursor-pointer transition-colors ${isCurrent
                                        ? 'bg-[var(--accent)]/10'
                                        : menuOpen
                                            ? 'bg-[var(--hover-bg)]'
                                            : 'hover:bg-[var(--hover-bg)]'
                                        }`}
                                    onClick={() => {
                                        if (!isCurrent) {
                                            onSelectSession(session.id, getSessionDisplayText(session));
                                            onClose();
                                        }
                                    }}
                                >
                                    {/* Row body — content extends to right edge in default state.
                                     *  Action buttons live in the absolute overlay below so they
                                     *  don't reserve layout space when not hovered (用户反馈：
                                     *  默认背景的 item 信息应该一致延伸到右边线). */}
                                    <div className="flex items-start gap-3 px-4 py-3">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2">
                                                {isCurrent && (
                                                    <span className="flex-shrink-0 rounded bg-[var(--accent)]/20 px-1.5 py-0.5 text-xs font-medium text-[var(--accent)]">
                                                        {t('shell.history.current')}
                                                    </span>
                                                )}
                                                {tags.map((tag, i) => (
                                                    <SessionTagBadge key={i} tag={tag} />
                                                ))}
                                                <UnreadNotificationIndicator
                                                    count={unreadNotificationCount}
                                                    label={t('shell.history.unreadNotifications', { count: unreadNotificationCount })}
                                                />
                                                <span className={`truncate text-sm ${isCurrent ? 'font-medium text-[var(--accent)]' : 'text-[var(--ink)]'}`}>
                                                    {displayText}
                                                </span>
                                            </div>
                                            <div className="mt-1 flex items-center gap-2 text-xs text-[var(--ink-muted)]">
                                                <span className="flex items-center gap-1">
                                                    <Clock className="h-3 w-3" />
                                                    {formatTime(session.lastActiveAt, new Date(), locale)}
                                                </span>
                                                {hasStats && (
                                                    <>
                                                        <span>·</span>
                                                        <span>{t('shell.history.turnCount', { count: stats.turnCount })}</span>
                                                        <span>·</span>
                                                        <span>{formatTokens(totalTokens)} tokens</span>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Hover overlay — gradient mask + action toolbar. Only the
                                     *  high-frequency "在新 tab 打开" action stays surfaced; the rest
                                     *  (收藏 / 导出 / 统计 / 删除) collapse behind the "更多" menu so
                                     *  the row toolbar stays calm. The overlay is force-revealed while
                                     *  this row's menu is open so its anchor button doesn't vanish. */}
                                    <div className={`absolute inset-y-0 right-0 flex items-center transition-opacity ${
                                        menuOpen
                                            ? 'pointer-events-auto opacity-100'
                                            : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
                                    }`}>
                                        <div className="h-full w-10 bg-gradient-to-r from-[var(--paper-inset-a0)] to-[var(--paper-inset)]" />
                                        <div className="flex h-full items-center gap-1 bg-[var(--paper-inset)] pr-3">
                                            {onOpenInNewTab && (
                                                <Tip label={t('shell.history.openInNewTab')} position="bottom">
                                                    <button
                                                        type="button"
                                                        aria-label={t('shell.history.openInNewTab')}
                                                        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
                                                        onClick={(e) => handleOpenInNewTab(e, session)}
                                                    >
                                                        <SquareArrowOutUpRight className="h-3.5 w-3.5" />
                                                    </button>
                                                </Tip>
                                            )}
                                            <Tip label={t('shell.history.more')} position="bottom" disabled={menuOpen}>
                                                <button
                                                    type="button"
                                                    aria-label={t('shell.history.moreActions')}
                                                    aria-haspopup="menu"
                                                    aria-expanded={menuOpen}
                                                    className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper)] ${
                                                        menuOpen
                                                            ? 'bg-[var(--paper)] text-[var(--ink)]'
                                                            : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                                    }`}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        menuAnchorRef.current = e.currentTarget;
                                                        setMenuSessionId((prev) => (prev === session.id ? null : session.id));
                                                    }}
                                                >
                                                    <MoreHorizontal className="h-4 w-4" />
                                                </button>
                                            </Tip>
                                        </div>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </Popover>

            {/* Per-row "更多" overflow menu. Anchored to the clicked row's button
             *  via `menuAnchorRef`. Default Popover z-index (260) sits above the
             *  dropdown's own Popover (z-50), and the dropdown's outside-click
             *  guard walks ancestors and bails on higher z-index, so clicking a
             *  menu row never collapses the history dropdown behind it. */}
            <Popover
                open={isOpen && !!menuSession}
                onClose={closeMenu}
                anchorRef={menuAnchorRef}
                placement="bottom-end"
                offset={6}
                className="w-44 py-1"
            >
                {menuSession && (
                    <>
                        <MenuItem
                            icon={<Star className="h-3.5 w-3.5" fill={menuSession.favorite ? 'currentColor' : 'none'} />}
                            label={menuSession.favorite ? t('shell.history.unfavorite') : t('shell.history.favorite')}
                            onClick={() => { closeMenu(); void handleToggleFavorite(menuSession); }}
                        />
                        <MenuItem
                            icon={exportingId === menuSession.id
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : <Download className="h-3.5 w-3.5" />}
                            label={t('shell.history.exportMarkdown')}
                            onClick={() => { closeMenu(); void handleExport(menuSession); }}
                            disabled={exportingId === menuSession.id}
                        />
                        <MenuItem
                            icon={<BarChart2 className="h-3.5 w-3.5" />}
                            label={t('shell.history.viewStats')}
                            onClick={() => { closeMenu(); handleShowStats(menuSession); }}
                        />
                        <div className="my-1 border-t border-[var(--line-subtle)]" />
                        <MenuItem
                            icon={<Trash2 className="h-3.5 w-3.5" />}
                            label={t('shell.history.delete')}
                            onClick={() => { closeMenu(); handleDeleteClick(menuSession); }}
                            tone="danger"
                        />
                    </>
                )}
            </Popover>

            {/* ConfirmDialog self-portals to document.body, so no outer
             *  createPortal wrapper is needed — the dialog already escapes
             *  any ancestor stacking context to beat FloatingPortal z-50. */}
            {pendingDelete && (
                <ConfirmDialog
                    title={t('shell.history.deleteDialog.title')}
                    message={t('shell.history.deleteDialog.message', { title: pendingDelete.title })}
                    confirmText={t('shell.history.deleteDialog.confirm')}
                    confirmVariant="danger"
                    onConfirm={handleConfirmDelete}
                    onCancel={handleCancelDelete}
                />
            )}

            {/* Stats Modal — portal to document root to escape stacking context */}
            {statsSession && createPortal(
                <SessionStatsModal
                    sessionId={statsSession.id}
                    sessionTitle={statsSession.title}
                    onClose={() => setStatsSession(null)}
                />,
                document.body,
            )}
        </>
    );
}
