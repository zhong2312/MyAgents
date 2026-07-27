/**
 * UsageStatsPanel - Global token usage statistics panel for Settings page
 */
import { ArrowDownLeft, ArrowUpRight, BarChart2, Database, Loader2, MessageSquare, UserRound } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getGlobalStats, type GlobalStats } from '@/api/sessionClient';
import { getAllProviders } from '@/config/services/providerService';
import { formatTokens } from '@/utils/formatTokens';

type TimeRange = '7d' | '30d' | '60d';

const TIME_RANGES: TimeRange[] = ['7d', '30d', '60d'];

type ProviderDisplayInfo = {
    vendor: string;
    name: string;
};

type LoadedStats = {
    range: TimeRange;
    data: GlobalStats;
};

type LoadError = 'no-data' | 'request';

export default function UsageStatsPanel() {
    const { t } = useTranslation('app');
    const [loadedStats, setLoadedStats] = useState<LoadedStats | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState<LoadError | null>(null);
    const [range, setRange] = useState<TimeRange>('30d');
    const [providerInfoMap, setProviderInfoMap] = useState<Record<string, ProviderDisplayInfo>>({});

    useEffect(() => {
        let cancelled = false;

        const loadProviders = async () => {
            try {
                const providers = await getAllProviders();
                if (cancelled) return;

                const mapping: Record<string, ProviderDisplayInfo> = {};
                for (const provider of providers) {
                    mapping[provider.id] = {
                        vendor: provider.vendor,
                        name: provider.name,
                    };
                }
                setProviderInfoMap(mapping);
            } catch {
                // Provider metadata only enriches labels. Usage data remains
                // useful with its persisted providerId when config loading fails.
            }
        };
        loadProviders();
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        let cancelled = false;
        setIsLoading(true);
        setLoadError(null);

        const loadStats = async () => {
            try {
                const data = await getGlobalStats(range);
                if (cancelled) return;

                if (data) {
                    setLoadedStats({ range, data });
                } else {
                    setLoadError('no-data');
                }
            } catch {
                if (!cancelled) {
                    setLoadError('request');
                }
            } finally {
                if (!cancelled) {
                    setIsLoading(false);
                }
            }
        };
        loadStats();
        return () => { cancelled = true; };
    }, [range]);

    const stats = loadedStats?.data ?? null;
    const totalTokens = (stats?.summary.totalInputTokens ?? 0) + (stats?.summary.totalOutputTokens ?? 0);
    const errorMessage = loadError === 'no-data'
        ? t('usageStats.loadDataFailed')
        : loadError === 'request'
            ? t('usageStats.loadFailed')
            : null;

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold text-[var(--ink)]">{t('usageStats.title')}</h2>
                    <p className="mt-1 text-sm text-[var(--ink-muted)]">{t('usageStats.description')}</p>
                </div>
                <div className="flex items-center gap-2">
                    {isLoading && stats && (
                        <span className="flex items-center gap-1.5 text-xs text-[var(--ink-muted)]" role="status">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {t('usageStats.loading')}
                        </span>
                    )}
                    <div className="flex gap-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-1">
                        {TIME_RANGES.map((r) => (
                            <button
                                key={r}
                                onClick={() => setRange(r)}
                                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                                    range === r
                                        ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                }`}
                            >
                                {t(`usageStats.ranges.${r}`)}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {isLoading && !stats ? (
                <div className="flex h-48 items-center justify-center gap-2 text-[var(--ink-muted)]" role="status">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <span className="text-sm">{t('usageStats.loading')}</span>
                </div>
            ) : errorMessage ? (
                <div className="flex h-48 items-center justify-center text-[var(--error)]">
                    {errorMessage}
                </div>
            ) : stats ? (
                <>
                    {/* Summary Cards */}
                    <SummaryCards stats={stats} totalTokens={totalTokens} />

                    {/* Daily Trend Chart */}
                    <DailyTrendChart daily={stats.daily} totalTokens={totalTokens} />

                    {/* Model Distribution Table */}
                    <ModelTable
                        key={loadedStats?.range}
                        byModel={stats.byModel}
                        totalTokens={totalTokens}
                        providerInfoMap={providerInfoMap}
                    />
                </>
            ) : null}
        </div>
    );
}

// ============= Summary Cards =============

function SummaryCards({ stats, totalTokens }: { stats: GlobalStats; totalTokens: number }) {
    const { t } = useTranslation('app');
    const cards = [
        {
            label: t('usageStats.summary.totalTokens'),
            value: formatTokens(totalTokens),
            icon: BarChart2,
        },
        {
            label: t('usageStats.summary.inputTokens'),
            value: formatTokens(stats.summary.totalInputTokens),
            icon: ArrowUpRight,
        },
        {
            label: t('usageStats.summary.outputTokens'),
            value: formatTokens(stats.summary.totalOutputTokens),
            icon: ArrowDownLeft,
        },
        {
            label: t('usageStats.summary.cacheInput'),
            value: formatTokens(stats.summary.totalCacheReadTokens + stats.summary.totalCacheCreationTokens),
            icon: Database,
        },
        {
            label: t('usageStats.summary.turnCount'),
            value: String(stats.summary.turnCount),
            icon: MessageSquare,
        },
        {
            label: t('usageStats.summary.humanQueryCount'),
            value: String(stats.summary.humanQueryCount),
            icon: UserRound,
        },
    ];

    return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {cards.map((card) => (
                <div
                    key={card.label}
                    className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-4"
                >
                    <div className="flex items-center gap-2 text-[var(--ink-muted)]">
                        <card.icon className="h-4 w-4" />
                        <span className="text-xs">{card.label}</span>
                    </div>
                    <div className="mt-2 text-2xl font-semibold text-[var(--ink)]">
                        {card.value}
                    </div>
                </div>
            ))}
        </div>
    );
}

// ============= Daily Trend Chart =============

interface TooltipState {
    x: number;
    y: number;
    containerWidth: number;
    date: string;
    inputTokens: number;
    outputTokens: number;
    turnCount: number;
    humanQueryCount: number;
}

function DailyTrendChart({ daily, totalTokens }: { daily: GlobalStats['daily']; totalTokens: number }) {
    const { t } = useTranslation('app');
    const containerRef = useRef<HTMLDivElement>(null);
    const [tooltip, setTooltip] = useState<TooltipState | null>(null);
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

    const handleMouseLeave = useCallback(() => {
        setTooltip(null);
        setHoveredIndex(null);
    }, []);

    const handleBarHover = useCallback((e: React.MouseEvent<SVGRectElement>, index: number, day: GlobalStats['daily'][number]) => {
        const containerEl = containerRef.current;
        if (!containerEl) return;
        const rect = containerEl.getBoundingClientRect();
        setTooltip({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top - 10,
            containerWidth: containerEl.clientWidth,
            date: day.date,
            inputTokens: day.inputTokens,
            outputTokens: day.outputTokens,
            turnCount: day.turnCount,
            humanQueryCount: day.humanQueryCount,
        });
        setHoveredIndex(index);
    }, []);

    if (daily.length === 0) {
        return (
            <div>
                <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-[var(--ink)]">{t('usageStats.dailyTrend')}</h3>
                </div>
                <div className="flex h-48 items-center justify-center rounded-lg border border-[var(--line)] text-sm text-[var(--ink-muted)]">
                    {t('usageStats.empty')}
                </div>
            </div>
        );
    }

    const maxTotal = Math.max(...daily.map(d => d.inputTokens + d.outputTokens), 1);

    const chartHeight = 200;
    const chartPaddingTop = 16;
    const chartPaddingX = 12;

    // Use a fixed viewBox width; bars scale proportionally with xMidYMax meet
    const svgWidth = 800;
    const dayCount = daily.length;
    const barGap = Math.max(2, Math.min(8, (svgWidth - chartPaddingX * 2) / dayCount * 0.15));
    const barWidth = Math.max(4, ((svgWidth - chartPaddingX * 2) - (dayCount - 1) * barGap) / dayCount);

    // X-axis label rotation — degrades gracefully when bars get tight:
    //   • barSlot ≥ 26 (~7-day range): horizontal, anchor middle
    //   • 16 ≤ barSlot < 26 (~30-day range): tilt -45°, anchor end
    //   • barSlot < 16 (~60-day range): vertical -90°, anchor end
    // Bottom padding grows with rotation so rotated labels don't get clipped.
    const barSlot = barWidth + barGap;
    const labelAngle = barSlot >= 26 ? 0 : barSlot >= 16 ? -45 : -90;
    const chartPaddingBottom = labelAngle === 0 ? 28 : labelAngle === -45 ? 44 : 56;
    const barAreaHeight = chartHeight - chartPaddingTop - chartPaddingBottom;

    return (
        <div>
            <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[var(--ink)]">{t('usageStats.dailyTrend')}</h3>
                <span className="text-xs text-[var(--ink-muted)]">
                    {t('usageStats.totalConsumption', { tokens: formatTokens(totalTokens) })}
                </span>
            </div>
            <div
                ref={containerRef}
                className="relative rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-4"
                onMouseLeave={handleMouseLeave}
            >
                <svg
                    width="100%"
                    height={chartHeight}
                    viewBox={`0 0 ${svgWidth} ${chartHeight}`}
                    preserveAspectRatio="xMidYMax meet"
                    className="w-full"
                >
                    {daily.map((day, i) => {
                        const x = chartPaddingX + i * (barWidth + barGap);
                        const total = day.inputTokens + day.outputTokens;
                        const totalH = Math.max((total / maxTotal) * barAreaHeight, 2);
                        const inputH = total > 0 ? (day.inputTokens / total) * totalH : totalH / 2;
                        const outputH = totalH - inputH;
                        const barY = chartPaddingTop + barAreaHeight - totalH;
                        const isHovered = hoveredIndex === i;
                        const dateLabel = day.date.slice(5); // "MM-DD"

                        return (
                            <g key={day.date}>
                                {/* Hover hitbox */}
                                <rect
                                    x={x}
                                    y={chartPaddingTop}
                                    width={barWidth}
                                    height={barAreaHeight}
                                    fill="transparent"
                                    onMouseMove={(e) => handleBarHover(e, i, day)}
                                    style={{ cursor: 'pointer' }}
                                />
                                {/* Input (bottom) */}
                                <rect
                                    x={x}
                                    y={barY + outputH}
                                    width={barWidth}
                                    height={inputH}
                                    rx={0}
                                    fill={isHovered ? 'var(--accent)' : 'var(--accent-warm-muted)'}
                                    pointerEvents="none"
                                    style={{ transition: 'fill 0.15s' }}
                                />
                                {/* Output (top) */}
                                <rect
                                    x={x}
                                    y={barY}
                                    width={barWidth}
                                    height={outputH}
                                    rx={barWidth > 4 ? 3 : 1}
                                    fill={isHovered ? 'var(--accent)' : 'var(--accent)'}
                                    opacity={isHovered ? 0.7 : 0.4}
                                    pointerEvents="none"
                                    style={{ transition: 'opacity 0.15s' }}
                                />
                                {/* X-axis label — rotates when bars get crowded.
                                    Pivot is the bar's bottom-center; with `textAnchor="end"`
                                    the rotated label hangs down-left from that point, which
                                    reads naturally for both -45° tilt and -90° vertical. */}
                                <text
                                    x={x + barWidth / 2}
                                    y={chartHeight - 6}
                                    textAnchor={labelAngle === 0 ? 'middle' : 'end'}
                                    transform={labelAngle ? `rotate(${labelAngle} ${x + barWidth / 2} ${chartHeight - 6})` : undefined}
                                    fill="var(--ink-muted)"
                                    fontSize="9"
                                    fontFamily="inherit"
                                    pointerEvents="none"
                                >
                                    {dateLabel}
                                </text>
                            </g>
                        );
                    })}
                </svg>

                {/* Tooltip */}
                {tooltip && (
                    <div
                        className="pointer-events-none absolute z-10 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 shadow-lg"
                        style={{
                            left: Math.min(tooltip.x, (tooltip.containerWidth || 300) - 180),
                            top: Math.max(tooltip.y - 70, 4),
                        }}
                    >
                        <div className="text-xs font-medium text-[var(--ink)]">{tooltip.date}</div>
                        <div className="mt-1 space-y-0.5 text-xs text-[var(--ink-muted)]">
                            <div>{t('usageStats.tooltip.input', { tokens: formatTokens(tooltip.inputTokens) })}</div>
                            <div>{t('usageStats.tooltip.output', { tokens: formatTokens(tooltip.outputTokens) })}</div>
                            <div>{t('usageStats.tooltip.turns', { count: tooltip.turnCount })}</div>
                            <div>{t('usageStats.tooltip.humanQueries', { count: tooltip.humanQueryCount })}</div>
                        </div>
                    </div>
                )}

                {/* Legend */}
                <div className="mt-2 flex items-center justify-center gap-4 text-xs text-[var(--ink-muted)]">
                    <div className="flex items-center gap-1.5">
                        <div className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: 'var(--accent-warm-muted)' }} />
                        <span>{t('usageStats.legend.input')}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <div className="h-2.5 w-2.5 rounded-sm opacity-40" style={{ backgroundColor: 'var(--accent)' }} />
                        <span>{t('usageStats.legend.output')}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ============= Model Distribution Table =============

const ALL_VENDOR = '__all__';
const OTHER_VENDOR = '__other__';

function ModelTable({ byModel, totalTokens, providerInfoMap }: {
    byModel: GlobalStats['byModel'];
    totalTokens: number;
    providerInfoMap: Record<string, ProviderDisplayInfo>;
}) {
    const { t } = useTranslation('app');
    const [selectedVendor, setSelectedVendor] = useState(ALL_VENDOR);

    const models = Object.entries(byModel);

    if (models.length === 0) {
        return null;
    }

    // Sort by total tokens descending
    models.sort((a, b) => {
        const totalA = a[1].inputTokens + a[1].outputTokens;
        const totalB = b[1].inputTokens + b[1].outputTokens;
        return totalB - totalA;
    });

    // Derive vendor list from models that have data
    const vendorSet = new Set<string>();
    let hasOther = false;
    for (const [, data] of models) {
        const vendor = data.providerId ? providerInfoMap[data.providerId]?.vendor : undefined;
        if (vendor) {
            vendorSet.add(vendor);
        } else {
            hasOther = true;
        }
    }
    const vendors = [ALL_VENDOR, ...Array.from(vendorSet).sort()];
    if (hasOther) vendors.push(OTHER_VENDOR);

    // Filter models by selected vendor
    const filteredModels = selectedVendor === ALL_VENDOR
        ? models
        : models.filter(([, data]) => {
            const vendor = data.providerId ? providerInfoMap[data.providerId]?.vendor : undefined;
            if (selectedVendor === OTHER_VENDOR) return !vendor;
            return vendor === selectedVendor;
        });

    // Compute filtered total
    const filteredTotal = filteredModels.reduce(
        (sum, [, data]) => sum + data.inputTokens + data.outputTokens, 0,
    );

    return (
        <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
                <h3 className="mr-1 text-sm font-semibold text-[var(--ink)]">{t('usageStats.modelDistribution')}</h3>
                {vendors.length > 2 && (
                    <div className="flex gap-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-1">
                        {vendors.map((v) => (
                            <button
                                key={v}
                                onClick={() => setSelectedVendor(v)}
                                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                                    selectedVendor === v
                                        ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                }`}
                            >
                                {v === ALL_VENDOR ? t('usageStats.vendors.all') : v === OTHER_VENDOR ? t('usageStats.vendors.other') : v}
                            </button>
                        ))}
                    </div>
                )}
                <span className="ml-auto text-xs text-[var(--ink-muted)]">
                    {t('usageStats.totalConsumption', { tokens: formatTokens(selectedVendor === ALL_VENDOR ? totalTokens : filteredTotal) })}
                </span>
            </div>
            <div className="overflow-x-auto rounded-lg border border-[var(--line)]">
                <table className="w-full text-sm">
                    <thead className="bg-[var(--paper-elevated)]">
                        <tr>
                            <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ink-muted)]">
                                {t('usageStats.table.model')}
                            </th>
                            <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                {t('usageStats.table.totalTokens')}
                            </th>
                            <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                {t('usageStats.table.input')}
                            </th>
                            <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                {t('usageStats.table.output')}
                            </th>
                            <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                {t('usageStats.table.cacheInput')}
                            </th>
                            <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                {t('usageStats.table.count')}
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--line)]">
                        {filteredModels.map(([key, data]) => {
                            const providerInfo = data.providerId ? providerInfoMap[data.providerId] : undefined;
                            const providerLabel = providerInfo?.name ?? data.providerId;
                            return (
                            <tr key={key}>
                                <td className="px-4 py-2 text-[var(--ink)]">
                                    <div>{data.model ?? key}</div>
                                    {providerLabel && (
                                        <div className="mt-0.5 text-xs text-[var(--ink-muted)]">
                                            {providerLabel}
                                        </div>
                                    )}
                                </td>
                                <td className="px-4 py-2 text-right font-medium text-[var(--ink)]">
                                    {formatTokens(data.inputTokens + data.outputTokens)}
                                </td>
                                <td className="px-4 py-2 text-right text-[var(--ink-muted)]">
                                    {formatTokens(data.inputTokens)}
                                </td>
                                <td className="px-4 py-2 text-right text-[var(--ink-muted)]">
                                    {formatTokens(data.outputTokens)}
                                </td>
                                <td className="px-4 py-2 text-right text-[var(--ink-muted)]">
                                    {formatTokens(data.cacheReadTokens + data.cacheCreationTokens)}
                                </td>
                                <td className="px-4 py-2 text-right text-[var(--ink-muted)]">
                                    {data.count}
                                </td>
                            </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
