import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { HeartbeatConfig, ActiveHoursConfig } from '../../../../shared/types/im';
import { DEFAULT_HEARTBEAT_ACTIVE_HOURS, DEFAULT_HEARTBEAT_CONFIG } from '../../../../shared/types/im';
import { retainFocusOnMouseDown } from '@/utils/focusRetention';
import {
    HEARTBEAT_INTERVAL_MAX,
    HEARTBEAT_INTERVAL_MIN,
    commitHeartbeatIntervalDraft,
    isHeartbeatIntervalCustom,
    resolveHeartbeatIntervalInputValue,
} from './heartbeatIntervalInput';

const FilePreviewModal = lazy(() => import('../../FilePreviewModal'));

const INTERVAL_PRESETS = [
    { value: 5 },
    { value: 15 },
    { value: 30 },
    { value: 60 },
    { value: 240 },
];

const INTERVAL_PRESET_VALUES = INTERVAL_PRESETS.map(p => p.value);

const COMMON_TIMEZONES = [
    { label: 'Asia/Shanghai (UTC+8)', value: 'Asia/Shanghai' },
    { label: 'Asia/Tokyo (UTC+9)', value: 'Asia/Tokyo' },
    { label: 'America/New_York (UTC-5)', value: 'America/New_York' },
    { label: 'America/Los_Angeles (UTC-8)', value: 'America/Los_Angeles' },
    { label: 'Europe/London (UTC+0)', value: 'Europe/London' },
    { label: 'Europe/Berlin (UTC+1)', value: 'Europe/Berlin' },
    { label: 'UTC', value: 'UTC' },
];

export default function HeartbeatConfigCard({
    heartbeat,
    onChange,
    flat,
    workspacePath,
}: {
    heartbeat: HeartbeatConfig | undefined;
    onChange: (config: HeartbeatConfig | undefined) => void;
    /** When true, renders without card border/bg — parent handles container styling */
    flat?: boolean;
    /** Workspace path — used to open HEARTBEAT.md in built-in preview/editor */
    workspacePath?: string;
}) {
    const { t } = useTranslation('settings');
    const config = useMemo(
        () => heartbeat ?? DEFAULT_HEARTBEAT_CONFIG,
        [heartbeat],
    );

    const [tzOpen, setTzOpen] = useState(false);
    const [moreSettingsOpen, setMoreSettingsOpen] = useState(false);

    const update = useCallback(
        (patch: Partial<HeartbeatConfig>) => {
            onChange({ ...config, ...patch });
        },
        [config, onChange],
    );

    const toggleEnabled = useCallback(() => {
        if (!heartbeat) {
            // First enable: create with defaults, including active hours on by default
            onChange({
                ...DEFAULT_HEARTBEAT_CONFIG,
                enabled: true,
                activeHours: { ...DEFAULT_HEARTBEAT_ACTIVE_HOURS },
            });
        } else {
            update({ enabled: !config.enabled });
        }
    }, [heartbeat, config.enabled, onChange, update]);

    const toggleActiveHours = useCallback(() => {
        if (config.activeHours) {
            update({ activeHours: undefined });
        } else {
            update({
                activeHours: { ...DEFAULT_HEARTBEAT_ACTIVE_HOURS },
            });
        }
    }, [config.activeHours, update]);

    const updateActiveHours = useCallback(
        (patch: Partial<ActiveHoursConfig>) => {
            if (!config.activeHours) return;
            update({ activeHours: { ...config.activeHours, ...patch } });
        },
        [config.activeHours, update],
    );

    const [previewFile, setPreviewFile] = useState<{ name: string; content: string; size: number; path: string } | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);

    const handleOpenHeartbeatFile = useCallback(async () => {
        if (!workspacePath) return;
        setPreviewLoading(true);
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const sep = workspacePath.includes('\\') ? '\\' : '/';
            const filePath = `${workspacePath}${sep}HEARTBEAT.md`;
            // Use Rust command to bypass Tauri fs scope (which only covers ~/.myagents)
            const content: string = await invoke('cmd_read_workspace_file', { path: filePath }) ?? '';
            setPreviewFile({ name: 'HEARTBEAT.md', content, size: new TextEncoder().encode(content).length, path: filePath });
        } catch (e) {
            console.warn('[HeartbeatConfigCard] Failed to open HEARTBEAT.md:', e);
        } finally {
            setPreviewLoading(false);
        }
    }, [workspacePath]);

    // Direct file save via Rust command — bypasses Tauri fs scope (which only covers ~/.myagents)
    const handleDirectSave = useCallback(async (content: string) => {
        if (!previewFile) return;
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('cmd_write_workspace_file', { path: previewFile.path, content });
    }, [previewFile]);

    // Reveal file in system file manager via Tauri shell
    const handleRevealFile = useCallback(async () => {
        if (!previewFile) return;
        const parentDir = previewFile.path.substring(0, previewFile.path.lastIndexOf('/'))
            || previewFile.path.substring(0, previewFile.path.lastIndexOf('\\'));
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(parentDir);
    }, [previewFile]);

    // Local draft for the custom-interval input. `null` = not editing → display
    // derives from the persisted value. While editing, the draft owns the
    // displayed text so partial digits (e.g. "1" on the way to "10", "5" on the
    // way to "50") don't get swallowed by the clamp or collapsed into a preset
    // match. See issue #310 and ./heartbeatIntervalInput.ts.
    const [customDraft, setCustomDraft] = useState<string | null>(null);
    const isCustomInterval = isHeartbeatIntervalCustom(
        config.intervalMinutes,
        INTERVAL_PRESET_VALUES,
    );
    const customInputValue = resolveHeartbeatIntervalInputValue(
        customDraft,
        config.intervalMinutes,
        INTERVAL_PRESET_VALUES,
    );

    const handleCustomFocus = useCallback(() => {
        setCustomDraft(prev =>
            prev ?? (isCustomInterval ? String(config.intervalMinutes) : ''),
        );
    }, [isCustomInterval, config.intervalMinutes]);

    const handleCustomChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        setCustomDraft(e.target.value);
    }, []);

    const handleCustomBlur = useCallback(() => {
        if (customDraft === null) return;
        const result = commitHeartbeatIntervalDraft(customDraft);
        if (result.kind === 'commit' && result.value !== config.intervalMinutes) {
            update({ intervalMinutes: result.value });
        }
        setCustomDraft(null);
    }, [customDraft, config.intervalMinutes, update]);

    const handleCustomKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
    }, []);

    const selectPreset = useCallback(
        (value: number) => {
            setCustomDraft(null);
            update({ intervalMinutes: value });
        },
        [update],
    );

    const selectedTz = COMMON_TIMEZONES.find(tz => tz.value === config.activeHours?.timezone);
    const formatPreset = useCallback((minutes: number) => {
        if (minutes >= 60 && minutes % 60 === 0) {
            return t('agentSettings.heartbeat.intervalHours', { count: minutes / 60 });
        }
        return t('agentSettings.heartbeat.intervalMinutes', { count: minutes });
    }, [t]);

    return (
        <>
        <div className={flat ? '' : 'rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5'}>
            {/* Header with toggle */}
            <div className={`flex items-center justify-between${config.enabled ? ' mb-4' : ''}`}>
                <div>
                    <h3 className="text-base font-medium text-[var(--ink)]">{t('agentSettings.heartbeat.title')}</h3>
                    <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                        {t('agentSettings.heartbeat.descriptionPrefix')}{' '}
                        {workspacePath ? (
                            <button
                                type="button"
                                onClick={handleOpenHeartbeatFile}
                                className="rounded bg-[var(--paper-inset)] px-1 py-0.5 text-[var(--accent)] hover:underline cursor-pointer"
                            >
                                HEARTBEAT.md
                            </button>
                        ) : (
                            <code className="rounded bg-[var(--paper-inset)] px-1 py-0.5 text-[var(--accent)]">HEARTBEAT.md</code>
                        )}
                        {' '}{t('agentSettings.heartbeat.descriptionMiddle')}{' '}
                        {workspacePath ? (
                            <button
                                type="button"
                                onClick={handleOpenHeartbeatFile}
                                className="rounded bg-[var(--paper-inset)] px-1 py-0.5 text-[var(--accent)] hover:underline cursor-pointer"
                            >
                                HEARTBEAT.md
                            </button>
                        ) : (
                            <code className="rounded bg-[var(--paper-inset)] px-1 py-0.5 text-[var(--accent)]">HEARTBEAT.md</code>
                        )}
                        {' '}{t('agentSettings.heartbeat.descriptionSuffix')}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={toggleEnabled}
                    className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                        config.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                    }`}
                >
                    <span
                        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                            config.enabled ? 'translate-x-5' : 'translate-x-0'
                        }`}
                    />
                </button>
            </div>

            {config.enabled && (
                <div>
                    <button
                        type="button"
                        aria-expanded={moreSettingsOpen}
                        onClick={() => setMoreSettingsOpen(open => !open)}
                        className="flex items-center gap-2 text-sm font-medium text-[var(--ink)] transition-colors hover:text-[var(--accent)]"
                    >
                        <ChevronDown className={`h-4 w-4 transition-transform ${moreSettingsOpen ? '' : '-rotate-90'}`} />
                        {t('agentSettings.common.moreSettings')}
                    </button>

                    {moreSettingsOpen && (
                        <div className="mt-4 space-y-4">
                            {/* Interval */}
                            <div>
                                <p className="mb-2 text-sm font-medium text-[var(--ink)]">{t('agentSettings.heartbeat.interval')}</p>
                                <div className="flex flex-wrap gap-2">
                                    {INTERVAL_PRESETS.map(preset => (
                                        <button
                                            key={preset.value}
                                            type="button"
                                            // Retain focus on the custom <input> when a
                                            // preset is left-clicked: preventing the
                                            // mousedown's default focus transfer means
                                            // the input never blurs mid-click, so its
                                            // blur-commit can't race the preset write
                                            // (no draft is committed then immediately
                                            // overwritten). retainFocusOnMouseDown is
                                            // left-button only, so the typed draft is
                                            // never silently lost: a left-button
                                            // drag-off keeps focus (draft survives,
                                            // commits on the eventual blur); a
                                            // right-click is not prevented, so the input
                                            // blurs and commits the draft normally. See
                                            // issue #310.
                                            onMouseDown={retainFocusOnMouseDown}
                                            onClick={() => selectPreset(preset.value)}
                                            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                                                config.intervalMinutes === preset.value
                                                    ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                                                    : 'bg-[var(--paper-inset)] text-[var(--ink-secondary)] hover:bg-[var(--ink-faint)]'
                                            }`}
                                        >
                                            {formatPreset(preset.value)}
                                        </button>
                                    ))}
                                    {/* Custom interval input */}
                                    <div className="flex items-center gap-1">
                                        <input
                                            type="number"
                                            min={HEARTBEAT_INTERVAL_MIN}
                                            max={HEARTBEAT_INTERVAL_MAX}
                                            value={customInputValue}
                                            placeholder={t('agentSettings.heartbeat.custom')}
                                            onFocus={handleCustomFocus}
                                            onChange={handleCustomChange}
                                            onBlur={handleCustomBlur}
                                            onKeyDown={handleCustomKeyDown}
                                            className={`w-20 rounded-lg border px-2 py-1.5 text-xs ${
                                                isCustomInterval
                                                    ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                                                    : 'border-[var(--line)] bg-[var(--paper)]'
                                            } text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]`}
                                        />
                                        <span className="text-xs text-[var(--ink-muted)]">{t('agentSettings.heartbeat.minutes')}</span>
                                    </div>
                                </div>
                            </div>

                            {/* Active hours */}
                            <div>
                                <div className="mb-2 flex items-center justify-between">
                                    <div>
                                        <p className="text-sm font-medium text-[var(--ink)]">{t('agentSettings.heartbeat.activeHours')}</p>
                                        <p className="text-xs text-[var(--ink-muted)]">
                                            {t('agentSettings.heartbeat.activeHoursDescription')}
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={toggleActiveHours}
                                        className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                                            config.activeHours ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                                        }`}
                                    >
                                        <span
                                            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                                                config.activeHours ? 'translate-x-5' : 'translate-x-0'
                                            }`}
                                        />
                                    </button>
                                </div>

                                {config.activeHours && (
                                    <div className="mt-2 flex flex-wrap items-center gap-2">
                                        <input
                                            type="time"
                                            value={config.activeHours.start}
                                            onChange={e => updateActiveHours({ start: e.target.value })}
                                            className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                                        />
                                        <span className="text-xs text-[var(--ink-muted)]">{t('agentSettings.heartbeat.to')}</span>
                                        <input
                                            type="time"
                                            value={config.activeHours.end}
                                            onChange={e => updateActiveHours({ end: e.target.value })}
                                            className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                                        />
                                        {/* Custom timezone dropdown */}
                                        <div className="relative">
                                            <button
                                                type="button"
                                                onClick={() => setTzOpen(!tzOpen)}
                                                className="flex items-center gap-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)] hover:border-[var(--line-strong)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                                            >
                                                <span>{selectedTz?.label || config.activeHours.timezone}</span>
                                                <ChevronDown className="h-3 w-3 text-[var(--ink-subtle)]" />
                                            </button>
                                            {tzOpen && (
                                                <>
                                                    <div className="fixed inset-0 z-40" onMouseDown={(e) => { if (e.target === e.currentTarget) setTzOpen(false); }} />
                                                    <div className="absolute left-0 top-8 z-50 w-56 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-1 shadow-lg">
                                                        {COMMON_TIMEZONES.map(tz => (
                                                            <button
                                                                key={tz.value}
                                                                type="button"
                                                                onClick={() => {
                                                                    updateActiveHours({ timezone: tz.value });
                                                                    setTzOpen(false);
                                                                }}
                                                                className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                                                                    config.activeHours?.timezone === tz.value
                                                                        ? 'bg-[var(--accent-warm-muted)] text-[var(--accent)]'
                                                                        : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
                                                                }`}
                                                            >
                                                                {tz.label}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
        {previewFile && (
            <Suspense fallback={null}>
                <FilePreviewModal
                    name={previewFile.name}
                    content={previewFile.content}
                    size={previewFile.size}
                    path={previewFile.path}
                    isLoading={previewLoading}
                    onClose={() => setPreviewFile(null)}
                    onSave={handleDirectSave}
                    onRevealFile={handleRevealFile}
                />
            </Suspense>
        )}
        </>
    );
}
