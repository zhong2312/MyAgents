/**
 * SessionStatsModal - Detailed session statistics modal
 */
import { BarChart2, Clock, Loader2, MessageSquare, UserRound, Wrench, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useCloseLayer } from '@/hooks/useCloseLayer';

import { getSessionStats, type SessionDetailedStats } from '@/api/sessionClient';
import { formatTokens, formatDuration } from '@/utils/formatTokens';
import OverlayBackdrop from '@/components/OverlayBackdrop';

interface SessionStatsModalProps {
    sessionId: string;
    sessionTitle: string;
    onClose: () => void;
}

export default function SessionStatsModal({
    sessionId,
    sessionTitle,
    onClose,
}: SessionStatsModalProps) {
    const { t } = useTranslation('chat');
    // Cmd+W dismissal: z-[200]
    useCloseLayer(() => { onClose(); return true; }, 200);

    const [stats, setStats] = useState<SessionDetailedStats | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const loadStats = async () => {
            try {
                const data = await getSessionStats(sessionId);
                if (cancelled) return;
                if (data) {
                    setStats(data);
                } else {
                    setError(t('shell.stats.errors.unavailable'));
                }
            } catch {
                if (!cancelled) {
                    setError(t('shell.stats.errors.loadFailed'));
                }
            } finally {
                if (!cancelled) {
                    setIsLoading(false);
                }
            }
        };
        loadStats();
        return () => {
            cancelled = true;
        };
    }, [sessionId, t]);

    const totalTokens =
        (stats?.summary.totalInputTokens ?? 0) + (stats?.summary.totalOutputTokens ?? 0);

    return (
        <OverlayBackdrop onClose={onClose} className="z-[200]" style={{ padding: '4vh 4vw' }}>
            <div
                className="glass-panel flex max-h-full w-full max-w-2xl select-text flex-col overflow-hidden"
            >
                {/* Header */}
                <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-muted)]">
                            <BarChart2 className="h-4 w-4 text-[var(--accent)]" />
                        </div>
                        <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-[var(--ink)]">
                                {t('shell.stats.title')}
                            </div>
                            <div className="truncate text-xs text-[var(--ink-muted)]">
                                {sessionTitle}
                            </div>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-5">
                    {isLoading ? (
                        <div className="flex h-32 items-center justify-center gap-2 text-[var(--ink-muted)]">
                            <Loader2 className="h-5 w-5 animate-spin" />
                            <span className="text-sm">{t('shell.stats.loading')}</span>
                        </div>
                    ) : error ? (
                        <div className="flex h-32 items-center justify-center text-[var(--error)]">
                            {error}
                        </div>
                    ) : stats ? (
                        <div className="space-y-6">
                            {/* Summary Cards */}
                            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                                <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-4">
                                    <div className="flex items-center gap-2 text-[var(--ink-muted)]">
                                        <MessageSquare className="h-4 w-4" />
                                        <span className="text-xs">{t('shell.stats.summary.turns')}</span>
                                    </div>
                                    <div className="mt-2 text-2xl font-semibold text-[var(--ink)]">
                                        {stats.summary.turnCount}
                                    </div>
                                </div>
                                <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-4">
                                    <div className="flex items-center gap-2 text-[var(--ink-muted)]">
                                        <UserRound className="h-4 w-4" />
                                        <span className="text-xs">{t('shell.stats.summary.humanQueries')}</span>
                                    </div>
                                    <div className="mt-2 text-2xl font-semibold text-[var(--ink)]">
                                        {stats.summary.humanQueryCount}
                                    </div>
                                </div>
                                <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-4">
                                    <div className="flex items-center gap-2 text-[var(--ink-muted)]">
                                        <BarChart2 className="h-4 w-4" />
                                        <span className="text-xs">{t('shell.stats.summary.totalTokens')}</span>
                                    </div>
                                    <div className="mt-2 text-2xl font-semibold text-[var(--ink)]">
                                        {formatTokens(totalTokens)}
                                    </div>
                                    <div className="mt-1 text-xs text-[var(--ink-muted)]">
                                        {t('shell.stats.summary.inputOutput', {
                                            input: formatTokens(stats.summary.totalInputTokens),
                                            output: formatTokens(stats.summary.totalOutputTokens),
                                        })}
                                    </div>
                                </div>
                                <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-4">
                                    <div className="flex items-center gap-2 text-[var(--ink-muted)]">
                                        <Clock className="h-4 w-4" />
                                        <span className="text-xs">{t('shell.stats.summary.inputCache')}</span>
                                    </div>
                                    <div className="mt-2 text-2xl font-semibold text-[var(--ink)]">
                                        {formatTokens((stats.summary.totalCacheReadTokens ?? 0) + (stats.summary.totalCacheCreationTokens ?? 0))}
                                    </div>
                                    <div className="mt-1 text-xs text-[var(--ink-muted)]">
                                        {t('shell.stats.summary.inputCacheTokens')}
                                    </div>
                                </div>
                            </div>

                            {/* By Model Table */}
                            {Object.keys(stats.byModel).length > 0 && (
                                <div>
                                    <h3 className="mb-3 text-sm font-semibold text-[var(--ink)]">
                                        {t('shell.stats.byModel.title')}
                                    </h3>
                                    <div className="overflow-hidden rounded-lg border border-[var(--line)]">
                                        <table className="w-full text-sm">
                                            <thead className="bg-[var(--paper-elevated)]">
                                                <tr>
                                                    <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ink-muted)]">
                                                        {t('shell.stats.byModel.model')}
                                                    </th>
                                                    <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                                        {t('shell.stats.common.input')}
                                                    </th>
                                                    <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                                        {t('shell.stats.common.output')}
                                                    </th>
                                                    <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                                        {t('shell.stats.common.inputCache')}
                                                    </th>
                                                    <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                                        {t('shell.stats.byModel.count')}
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-[var(--line)]">
                                                {Object.entries(stats.byModel).map(
                                                    ([key, data]) => (
                                                        <tr key={key}>
                                                            <td className="px-4 py-2 text-[var(--ink)]">
                                                                <div>{data.model ?? key}</div>
                                                                {data.providerId && (
                                                                    <div className="mt-0.5 text-xs text-[var(--ink-muted)]">
                                                                        {data.providerId}
                                                                    </div>
                                                                )}
                                                            </td>
                                                            <td className="px-4 py-2 text-right text-[var(--ink-muted)]">
                                                                {formatTokens(data.inputTokens)}
                                                            </td>
                                                            <td className="px-4 py-2 text-right text-[var(--ink-muted)]">
                                                                {formatTokens(data.outputTokens)}
                                                            </td>
                                                            <td className="px-4 py-2 text-right text-[var(--ink-muted)]">
                                                                {formatTokens((data.cacheReadTokens ?? 0) + (data.cacheCreationTokens ?? 0))}
                                                            </td>
                                                            <td className="px-4 py-2 text-right text-[var(--ink-muted)]">
                                                                {data.count}
                                                            </td>
                                                        </tr>
                                                    )
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            )}

                            {/* Turn Details Table */}
                            {stats.details.length > 0 && (
                                <div>
                                    <h3 className="mb-3 text-sm font-semibold text-[var(--ink)]">
                                        {t('shell.stats.turnDetails.title')}
                                    </h3>
                                    <div className="overflow-hidden rounded-lg border border-[var(--line)]">
                                        <div className="max-h-64 overflow-y-auto">
                                            <table className="w-full text-sm">
                                                <thead className="sticky top-0 bg-[var(--paper-elevated)]">
                                                    <tr>
                                                        <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ink-muted)]">
                                                            {t('shell.stats.turnDetails.trigger')}
                                                        </th>
                                                        <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                                            {t('shell.stats.common.input')}
                                                        </th>
                                                        <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                                            {t('shell.stats.common.output')}
                                                        </th>
                                                        <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                                            {t('shell.stats.common.inputCache')}
                                                        </th>
                                                        <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                                            <Wrench className="inline h-3 w-3" />
                                                        </th>
                                                        <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                                            <Clock className="inline h-3 w-3" />
                                                        </th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-[var(--line)]">
                                                    {stats.details.map((detail, index) => (
                                                        <tr key={index}>
                                                            <td
                                                                className="max-w-[200px] truncate px-4 py-2 text-[var(--ink)]"
                                                                title={detail.turnTrigger}
                                                            >
                                                                {detail.turnTrigger || '-'}
                                                            </td>
                                                            <td className="px-4 py-2 text-right text-[var(--ink-muted)]">
                                                                {formatTokens(detail.inputTokens)}
                                                            </td>
                                                            <td className="px-4 py-2 text-right text-[var(--ink-muted)]">
                                                                {formatTokens(detail.outputTokens)}
                                                            </td>
                                                            <td className="px-4 py-2 text-right text-[var(--ink-muted)]">
                                                                {formatTokens((detail.cacheReadTokens ?? 0) + (detail.cacheCreationTokens ?? 0))}
                                                            </td>
                                                            <td className="px-4 py-2 text-right text-[var(--ink-muted)]">
                                                                {detail.toolCount ?? '-'}
                                                            </td>
                                                            <td className="px-4 py-2 text-right text-[var(--ink-muted)]">
                                                                {detail.durationMs
                                                                    ? formatDuration(detail.durationMs)
                                                                    : '-'}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Empty state */}
                            {stats.details.length === 0 && (
                                <div className="py-8 text-center text-sm text-[var(--ink-muted)]">
                                    {t('shell.stats.empty')}
                                </div>
                            )}
                        </div>
                    ) : null}
                </div>

                {/* Footer */}
                <div className="flex flex-shrink-0 justify-end border-t border-[var(--line)] px-5 py-3">
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-md border border-[var(--line-strong)] bg-[var(--button-secondary-bg)] px-4 py-2 text-sm font-medium text-[var(--ink)] hover:bg-[var(--button-secondary-bg-hover)]"
                    >
                        {t('shell.common.close')}
                    </button>
                </div>
            </div>
        </OverlayBackdrop>
    );
}
