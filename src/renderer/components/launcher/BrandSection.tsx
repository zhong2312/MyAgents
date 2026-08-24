/**
 * BrandSection - Left panel of the Launcher page
 * Layout: Logo+Slogan pinned to upper area, input box anchored to lower area
 * with workspace selector integrated into the input toolbar.
 *
 * Phase 2 (v0.1.69): a 对话 / 想法 ModeSegment sits between the slogan and the
 * input. Switching to 「想法」 repurposes the input as a freeform Thought entry
 * (persisted to ~/.myagents/thoughts/ via `thoughtCreate`), bypassing the full
 * Chat launch flow. Switching back to 「对话」 restores the default behavior.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import DropZoneOverlay from '@/components/DropZoneOverlay';
import SimpleChatInput, { type ImageAttachment, type SimpleChatInputHandle } from '@/components/SimpleChatInput';
import CronTaskSettingsModal, {
    GOAL_SLASH_PRESET,
    type CronInitialConfig,
    type CronSettingsResult,
} from '@/components/cron/CronTaskSettingsModal';
import LauncherInputContextRow from './LauncherInputContextRow';
import type { RuntimeDetections } from '../../../shared/types/runtime';
import ModeSegment, { type InputMode } from '@/components/task-center/ModeSegment';
import RecentThoughtsRow from '@/components/task-center/RecentThoughtsRow';
import { ThoughtInput, type ThoughtInputHandle } from '@/components/task-center/ThoughtInput';
import { useToast } from '@/components/Toast';
import { track } from '@/analytics';
import { thoughtList, taskCenterAvailable } from '@/api/taskCenter';
import { useThoughtTagCandidates } from '@/hooks/useThoughtTagCandidates';
import { useFileDropZone } from '@/hooks/useFileDropZone';
import { useTauriFileDrop } from '@/hooks/useTauriFileDrop';
import { hasOverlayLayer } from '@/utils/closeLayer';
import { shouldShowBuiltinSdkSlashCommands } from '@/utils/runtimeUiProjection';
import { CUSTOM_EVENTS } from '@/../shared/constants';
import { type Project, type Provider, type PermissionMode, type ProviderVerifyStatus } from '@/config/types';
import type { RuntimeType, RuntimeModelInfo, RuntimePermissionMode } from '../../../shared/types/runtime';
import type { Thought } from '../../../shared/types/thought';
import type { OfficialToolDefinition, OfficialToolId } from '../../../shared/official-tools';
import { useResolvedTheme } from '@/theme';

interface BrandSectionProps {
    // Workspace
    projects: Project[];
    selectedProject: Project | null;
    defaultWorkspacePath?: string;
    onSelectWorkspace: (project: Project) => void;
    onAddFolder: () => void;
    /** Promote a project to the global default workspace (writes
     *  `config.defaultWorkspacePath`). Threaded through to the chip row's
     *  WorkspaceSelector so its hover-only "设为默认" button has somewhere
     *  to write. */
    onSetDefaultWorkspace?: (project: Project) => void;
    // Input — `cron` carries the launcher-staged cron config forward so the
    // Launcher → InitialMessage handoff can include it (PRD 0.2.7 Cron handoff).
    onSend: (
        text: string,
        images?: ImageAttachment[],
        cron?: import('@/types/tab').InitialMessageCron,
    ) => void;
    /** Pending session id used for launcher-staged user attachments. */
    attachmentSessionId?: string | null;
    isStarting?: boolean;
    // Provider/Model (pass-through to SimpleChatInput)
    provider?: Provider | null;
    providers?: Provider[];
    selectedModel?: string;
    onProviderChange?: (id: string, targetModel?: string) => void;
    onModelChange?: (id: string) => void;
    /** #324 — 推理强度 (pass-through to SimpleChatInput) */
    reasoningEffort?: string;
    onReasoningEffortChange?: (effort: string) => void;
    permissionMode?: PermissionMode;
    onPermissionModeChange?: (mode: PermissionMode) => void;
    apiKeys?: Record<string, string>;
    providerVerifyStatus?: Record<string, ProviderVerifyStatus>;
    // MCP
    workspaceMcpEnabled?: string[];
    globalMcpEnabled?: string[];
    mcpServers?: Array<{ id: string; name: string; description?: string }>;
    onWorkspaceMcpToggle?: (serverId: string, enabled: boolean) => void;
    officialTools?: readonly OfficialToolDefinition[];
    workspaceOfficialToolEnabled?: OfficialToolId[];
    globalOfficialToolEnabled?: OfficialToolId[];
    officialToolNeedsConfig?: Partial<Record<OfficialToolId, boolean>>;
    onWorkspaceOfficialToolToggle?: (toolId: OfficialToolId, enabled: boolean) => void;
    // PRD 0.2.17 — Claude Plugins (passthrough to SimpleChatInput).
    globallyVisiblePlugins?: Array<{ id: string; name: string; description?: string }>;
    workspaceEnabledPlugins?: string[];
    onWorkspacePluginToggle?: (pluginId: string, enabled: boolean) => void;
    onRefreshProviders?: () => void;
    // Navigation
    onGoToSettings?: () => void;
    // Runtime (external runtimes adapt model/permission selectors)
    runtime?: RuntimeType;
    runtimeModels?: RuntimeModelInfo[];
    runtimePermissionModes?: RuntimePermissionMode[];
    // PRD 0.2.7 Phase F: runtime selector lives in the row below the input
    // (not the toolbar) when `multiAgentRuntime` is on. Caller provides the
    // detection map + onChange just like in chat-tab.
    multiAgentRuntimeEnabled?: boolean;
    runtimeDetections?: RuntimeDetections;
    onRuntimeChange?: (runtime: RuntimeType) => void;
    /** All runtimes (builtin + external) so the row's chip shows the full picture.
     *  Distinct from `runtime` which is the *external* runtime when in external mode. */
    activeRuntime?: RuntimeType;
    /** Only the visible Launcher tab may respond to window-wide Tauri drag events. */
    isActive: boolean;
}

const LAUNCHER_INPUT_DROP_ZONE_ID = 'launcher-input';

export default memo(function BrandSection({
    projects,
    selectedProject,
    defaultWorkspacePath,
    onSelectWorkspace,
    onAddFolder,
    onSetDefaultWorkspace,
    onSend,
    attachmentSessionId,
    isStarting,
    provider,
    providers,
    selectedModel,
    onProviderChange,
    onModelChange,
    reasoningEffort,
    onReasoningEffortChange,
    permissionMode,
    onPermissionModeChange,
    apiKeys,
    providerVerifyStatus,
    workspaceMcpEnabled,
    globalMcpEnabled,
    mcpServers,
    onWorkspaceMcpToggle,
    officialTools,
    workspaceOfficialToolEnabled,
    globalOfficialToolEnabled,
    officialToolNeedsConfig,
    onWorkspaceOfficialToolToggle,
    globallyVisiblePlugins,
    workspaceEnabledPlugins,
    onWorkspacePluginToggle,
    onRefreshProviders,
    onGoToSettings,
    runtime,
    runtimeModels,
    runtimePermissionModes,
    multiAgentRuntimeEnabled,
    runtimeDetections,
    onRuntimeChange,
    activeRuntime,
    isActive,
}: BrandSectionProps) {
    const { t, i18n } = useTranslation('launcher');
    const resolvedTheme = useResolvedTheme();
    const sloganLocale = i18n.resolvedLanguage?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
    const heroBackground = resolvedTheme.hero.background;
    const heroAssetCssUrl = heroBackground.assetUrl ? JSON.stringify(heroBackground.assetUrl) : null;
    const heroStyle = heroBackground.assetUrl ? {
        backgroundImage: heroBackground.mask
            ? `linear-gradient(${heroBackground.mask}, ${heroBackground.mask}), url(${heroAssetCssUrl})`
            : `url(${heroAssetCssUrl})`,
        backgroundPosition: heroBackground.position,
        backgroundSize: heroBackground.size,
        backgroundRepeat: heroBackground.repeat,
    } : undefined;
    const toast = useToast();
    // Project convention: keep `toast` behind a ref so it stays out of
    // useCallback dep arrays and doesn't re-trigger memoization (see
    // specs/tech_docs/react_stability_rules.md). Updated via effect to
    // satisfy the `react-hooks/refs` no-mutate-during-render rule.
    const toastRef = useRef(toast);
    const tRef = useRef(t);
    useEffect(() => {
        toastRef.current = toast;
    }, [toast]);
    useEffect(() => {
        tRef.current = t;
    }, [t]);
    const [mode, setMode] = useState<InputMode>('task');
    // PRD 0.2.7 D1 + C6: cron settings staged in the launcher. The actual
    // `cmd_create_cron_task` does NOT run here — we only collect the params,
    // then carry them forward to Chat via InitialMessage.cron at send time.
    // Keeps "user closed launcher mid-edit → no orphan cron" the default.
    const [showCronSettings, setShowCronSettings] = useState(false);
    const [stagedCron, setStagedCron] = useState<CronSettingsResult | null>(null);
    const [cronOpenPreset, setCronOpenPreset] = useState<CronInitialConfig | null>(null);
    // Bumped after each successful thoughtCreate so the Recent Thoughts strip
    // re-fetches and the just-saved note slides in as the first chip.
    const [thoughtRefreshKey, setThoughtRefreshKey] = useState(0);
    // Gracefully degrade in browser dev mode — ModeSegment is Tauri-only.
    const modeSegmentEnabled = taskCenterAvailable();

    // `runtime` is present for user-managed external CLIs. Managed Codex keeps
    // provider-style input chrome, so its execution Runtime comes from the
    // selected Provider instead. Slash capabilities must follow that execution
    // identity, not the chrome projection.
    const inputExecutionRuntime: RuntimeType = runtime
        ?? (provider?.execution?.kind === 'runtime-backed'
            ? provider.execution.runtime
            : 'builtin');

    // Thought history — fetched once per mount (and after a just-created
    // thought, via the explicit reload below) to feed the `#` autocomplete
    // candidate list. Deliberately independent from `thoughtRefreshKey`:
    // that key is used for the RecentThoughtsRow, and coupling the two
    // would create a state dance (optimistic prepend → refreshKey bump →
    // fetch races prepend → potential "flash and reappear" if a concurrent
    // external change landed between).
    //
    // Skipped entirely in 对话 mode on mount so user's steady state (most
    // sessions) doesn't pay a full `thoughtList()` round-trip for a `#`
    // picker they never open. The moment the user flips to 想法, this
    // effect re-runs and populates the list before they can open the
    // picker.
    const [thoughts, setThoughts] = useState<Thought[]>([]);
    const reloadThoughts = useCallback(async () => {
        try {
            const list = await thoughtList({});
            setThoughts(list);
        } catch (err) {
            // Keep the previous list as a cache; tag candidates stay usable
            // (minus the very latest thought's tags). Non-critical path —
            // don't toast.
            console.warn('[BrandSection] thoughtList failed for tag candidates', err);
        }
    }, []);
    useEffect(() => {
        if (!modeSegmentEnabled) return;
        if (mode !== 'thought') return;
        let cancelled = false;
        void (async () => {
            if (cancelled) return;
            await reloadThoughts();
        })();
        return () => {
            cancelled = true;
        };
    }, [modeSegmentEnabled, mode, reloadThoughts]);

    // Feed the # picker with `projects` (the same data backing the Agent
    // Workspace panel on the right) rather than `config.agents` — the
    // latter skips plain workspaces not yet upgraded to Agents AND leaks
    // internal workspaces like `~/.myagents`, producing a candidate list
    // that didn't match what the user sees on screen.
    const tagCandidates = useThoughtTagCandidates(thoughts, projects);

    // Refs for imperative focus. Both inputs stay mounted (hidden via CSS
    // when the other mode is active) so typed-but-not-yet-sent text
    // survives mode switches — cross-review found the prior conditional
    // render silently dropped drafts. Focus is driven by a mode-effect
    // below (not by the old mount-time one-shot) so the caret follows the
    // visible editor.
    //
    // ModeSegment buttons use `retainFocusOnMouseDown` (see
    // `utils/focusRetention.ts`) so the textarea never loses focus on
    // click in the first place — no rAF, no race with macOS WebKit
    // touchpad-tap synthesis. The effect below handles the programmatic
    // hand-off when a keyboard chord (Tab / Cmd+Shift+T) switches modes.
    const inputRef = useRef<SimpleChatInputHandle>(null);
    const thoughtInputRef = useRef<ThoughtInputHandle>(null);
    const inputDropZoneRef = useRef<HTMLDivElement>(null);
    const canAcceptFileDrop = isActive && mode === 'task';

    const handleDroppedFiles = useCallback((files: File[]) => {
        void inputRef.current?.processDroppedFiles(files);
    }, []);
    const handleDroppedFilePaths = useCallback((paths: string[]) => {
        void inputRef.current?.processDroppedFilePaths?.(paths);
    }, []);
    const {
        isDragActive: isHtmlFileDragActive,
        dragHandlers: htmlFileDragHandlers,
        resetDragState: resetHtmlFileDragState,
    } = useFileDropZone({ onFilesDropped: handleDroppedFiles });
    const {
        isDragging: isNativeFileDragging,
        activeZoneId: nativeDropZoneId,
        registerZone,
        unregisterZone,
    } = useTauriFileDrop({ enabled: canAcceptFileDrop });

    useLayoutEffect(() => {
        registerZone(
            LAUNCHER_INPUT_DROP_ZONE_ID,
            inputDropZoneRef.current,
            handleDroppedFilePaths,
        );
        return () => unregisterZone(LAUNCHER_INPUT_DROP_ZONE_ID);
    }, [handleDroppedFilePaths, registerZone, unregisterZone]);

    useEffect(() => {
        if (canAcceptFileDrop) return;
        resetHtmlFileDragState();
    }, [canAcceptFileDrop, resetHtmlFileDragState]);

    const showInputDropOverlay = canAcceptFileDrop
        && (
            isHtmlFileDragActive
            || (isNativeFileDragging && nativeDropZoneId === LAUNCHER_INPUT_DROP_ZONE_ID)
        );
    // Single helper for BOTH the segment click path (explicit mode) and
    // the keyboard paths (Tab / Cmd+Shift+T toggle). Without this the
    // two call sites diverged on `setMode(next)` vs `setMode((m) => …)`
    // and future work added to one would silently skip the other.
    //
    // `modeRef` mirrors `mode` so we can read the current value outside
    // a setState updater — track() fires once per real switch, even though
    // React strict-mode invokes the updater function twice.
    const modeRef = useRef<InputMode>(mode);
    useEffect(() => {
        modeRef.current = mode;
    }, [mode]);
    const setModeAndFocus = useCallback((next: InputMode | 'toggle') => {
        const prev = modeRef.current;
        const resolved: InputMode =
            next === 'toggle' ? (prev === 'task' ? 'thought' : 'task') : next;
        if (resolved !== prev) {
            track('launcher_mode_switch', {
                to: resolved,
                via: next === 'toggle' ? 'shortcut' : 'click',
            });
        }
        if (next === 'toggle') {
            setMode((m) => (m === 'task' ? 'thought' : 'task'));
        } else {
            setMode(next);
        }
    }, []);

    // Focus handoff — follows the visible input. Fires on mount (initial
    // mode) and every mode change; `retainFocusOnMouseDown` already keeps
    // focus on the correct textarea for mouse-driven ModeSegment clicks,
    // so this effect's job is the keyboard-chord path (Tab / Cmd+Shift+T).
    // Running in an effect keeps it out of the click-handler frame — no
    // touchpad-tap race.
    useEffect(() => {
        if (mode === 'thought') {
            thoughtInputRef.current?.focus();
        } else {
            inputRef.current?.focus();
        }
    }, [mode]);

    // PRD 0.2.7 D3: switching workspaces in the launcher invalidates any
    // workspace-bound draft state — `@myagents_files/...` references point to
    // files in the previous workspace's `myagents_files/`, `images[]`
    // captured via Tauri drag-drop / copyPaths similarly belong to the prior
    // tree, and a staged cron task that referenced those files would now
    // execute against an inconsistent prompt. Strip them silently and surface
    // a toast (text outside references survives, so this is a soft reset).
    // Cross-review (CC) caught the stagedCron-not-cleared subtle UX trap.
    const lastWorkspacePathRef = useRef<string | null>(selectedProject?.path ?? null);
    useEffect(() => {
        const next = selectedProject?.path ?? null;
        if (lastWorkspacePathRef.current === next) return;
        // Skip the first run (initial selection — no draft to clear yet).
        if (lastWorkspacePathRef.current !== null) {
            const result = inputRef.current?.clearWorkspaceBoundDraft();
            const total = (result?.strippedReferences ?? 0) + (result?.clearedImages ?? 0);
            const hadCron = stagedCron !== null;
            if (hadCron) setStagedCron(null);
            if (total > 0 || hadCron) {
                toastRef.current.info(tRef.current('toasts.workspaceAttachmentsCleared'));
            }
        }
        lastWorkspacePathRef.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stagedCron read intentionally; we don't want this effect to re-fire when the user merely stages a new cron, only when workspace changes
    }, [selectedProject?.path]);

    // Dialogue-mode submit is a straight pass-through to the parent's `onSend`.
    // Thought-mode submit is owned entirely by ThoughtInput (below) — it
    // calls `thoughtCreate` itself and fires `handleThoughtCreated`, so
    // this handler never sees thought content anymore.
    const handleSend = useCallback(
        (text: string, images?: ImageAttachment[]) => {
            // Repackage staged cron config into the InitialMessageCron shape so
            // Chat's autoSend can dispatch to startCronTask without poking back
            // into the modal's `CronSettingsResult` schema. Schedule fallback
            // to a fixed-interval shape preserves the modal's plain-interval
            // config (it leaves `schedule` undefined when the user picks the
            // simple cadence dial).
            const cron = stagedCron
                ? {
                      taskKind: stagedCron.taskKind,
                      schedule:
                          stagedCron.schedule ??
                          ({ kind: 'every', minutes: stagedCron.intervalMinutes } as const),
                      runMode: stagedCron.runMode,
                      endConditions: stagedCron.endConditions,
                      notifyEnabled: stagedCron.notifyEnabled,
                      delivery: stagedCron.delivery,
                      name: stagedCron.name,
                      intervalMinutes: stagedCron.intervalMinutes,
                      // Carry executionTarget through to Launcher (which
                      // short-circuits on `new_task` to create a background
                      // task) and to the chat-side cron state (so re-opening
                      // the editor shows the user's actual choice, not the
                      // 'current_session' default).
                      executionTarget: stagedCron.executionTarget,
                  }
                : undefined;
            onSend(text, images, cron);
        },
        [onSend, stagedCron],
    );

    // Cron config for the StatusBar — derived from staged (immutable while
    // dialog is closed). Built per the SimpleChatInput contract: { intervalMinutes, schedule? }.
    const cronStatusBarConfig = useMemo(
        () =>
            stagedCron
                ? {
                      taskKind: stagedCron.taskKind,
                      intervalMinutes: stagedCron.intervalMinutes,
                      schedule: stagedCron.schedule,
                  }
                : null,
        [stagedCron],
    );

    const handleOpenCronSettings = useCallback(() => {
        setCronOpenPreset(null);
        setShowCronSettings(true);
    }, []);

    const handleCloseCronSettings = useCallback(() => {
        setShowCronSettings(false);
        setCronOpenPreset(null);
    }, []);

    const handleConfirmCronSettings = useCallback((config: CronSettingsResult) => {
        setStagedCron(config);
        setShowCronSettings(false);
        setCronOpenPreset(null);
        track('launcher_cron_stage', {
            interval_minutes: config.intervalMinutes,
            run_mode: config.runMode,
            execution_target: config.executionTarget,
        });
    }, []);

    const handleCancelCronDraft = useCallback(() => {
        setStagedCron(null);
    }, []);

    const handleSlashAction = useCallback((name: string) => {
        if (name !== 'goal' && name !== 'loop') return;
        setCronOpenPreset(GOAL_SLASH_PRESET);
        setShowCronSettings(true);
    }, []);

    // Called from ThoughtInput after a successful thoughtCreate. Mirrors the
    // TaskCenter pattern (prepend locally so the tag-candidate count updates
    // immediately) plus the Launcher-specific bits — refresh the Recent
    // Thoughts strip and toast so the user sees visible confirmation on the
    // otherwise mostly-empty launcher canvas.
    //
    // The thoughts list and the refreshKey are intentionally on different
    // rhythms: thoughts is optimistically prepended (authoritative for tag
    // candidates), and refreshKey only drives RecentThoughtsRow's own
    // independent fetch. Previously we bumped both, which meant the tag
    // candidate list would briefly re-fetch and could "undo" a concurrent
    // change made from Task Center.
    const handleThoughtCreated = useCallback((t: Thought) => {
        setThoughts((prev) => [t, ...prev]);
        setThoughtRefreshKey((k) => k + 1);
        toastRef.current.success(tRef.current('toasts.thoughtSaved'));
    }, []);

    const openTaskCenter = useCallback(() => {
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_TASK_CENTER));
    }, []);

    // Scoping ref for the Tab handler below — we only hijack Tab when the
    // focus is inside this Launcher subtree, so Chat tabs / settings /
    // modals keep their native focus navigation.
    const sectionRef = useRef<HTMLElement | null>(null);

    // PRD §4.1.1 hotkeys:
    //   • Cmd/Ctrl+Shift+T toggles mode globally while the Launcher is
    //     mounted — an explicit chord, safe to listen on `window`.
    //   • Plain Tab toggles too, and — crucially — fires even when the
    //     textarea is focused. The tooltip on the ModeSegment buttons
    //     ("按 Tab 切换到「对话」") promises this behaviour; guarding
    //     against editable targets like earlier iterations did made the
    //     tooltip a lie the moment mount-time focus landed the caret in
    //     the textarea. Child components that legitimately need to
    //     consume Tab (SimpleChatInput's slash-menu / file-search
    //     autocomplete) call `event.stopPropagation()` inside their
    //     onKeyDown handlers — React's `stopPropagation` halts the
    //     underlying native bubble, so this window listener truly won't
    //     fire when a child has first claim on the Tab keystroke.
    useEffect(() => {
        if (!modeSegmentEnabled) return;
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'T' || e.key === 't')) {
                e.preventDefault();
                setModeAndFocus('toggle');
                return;
            }
            if (
                e.key !== 'Tab' ||
                e.metaKey ||
                e.ctrlKey ||
                e.altKey ||
                e.shiftKey ||
                hasOverlayLayer()
            ) {
                return;
            }
            const section = sectionRef.current;
            const target = e.target as Node | null;
            const inScope =
                !target || target === document.body || (section?.contains(target) ?? false);
            if (!inScope) return;
            e.preventDefault();
            setModeAndFocus('toggle');
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [modeSegmentEnabled, setModeAndFocus]);

    // Check if any provider is available (has valid subscription or API key configured)
    // Validation status is informational — having a key is enough to be "available"
    const hasAnyProvider = useMemo(() => {
        return providers?.some(p => {
            if (p.type === 'subscription') {
                // Issue #203: a valid SDK verify is sufficient proof —
                // accountEmail is enrichment that may be missing for users
                // who only ran `claude auth login`.
                const v = providerVerifyStatus?.[p.id];
                return v?.status === 'valid';
            }
            return !!apiKeys?.[p.id];
        }) ?? false;
    }, [providers, apiKeys, providerVerifyStatus]);

    const providerSettingsPrompt = !hasAnyProvider ? (
        <p className="text-center text-sm text-[var(--ink-muted)]">
            {t('brand.providerPrompt.prefix')}
            <button
                type="button"
                onClick={() => onGoToSettings?.()}
                className="ml-1 rounded-md px-1 py-0.5 text-[var(--accent-warm)] transition-colors hover:bg-[var(--accent-warm-subtle)] hover:text-[var(--accent-warm-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-warm-muted)]"
            >
                {t('brand.providerPrompt.configure')}
            </button>
        </p>
    ) : null;

    return (
        <section
            ref={sectionRef}
            className="theme-launcher-hero flex flex-1 flex-col items-center px-12"
            style={heroStyle}
            data-theme-hero={resolvedTheme.themeId}
        >
            {/* Upper area: Brand Name + Slogans as ONE visual group.
                `mb-2` tightens the title↔slogan gap so they read as a
                paired brand block rather than two free-floating lines;
                the larger breathing room below that group (on the
                ModeSegment wrapper) separates "who we are" from "what
                you're about to do". */}
            <div className="flex flex-1 flex-col items-center justify-center">
                <h1 className="theme-product-wordmark theme-launcher-hero-title">
                    {resolvedTheme.hero.productName}
                </h1>
                {/* 品牌 slogan 的 15px/17px 是 DESIGN.md §15.2 立档的展示型字号（display 用途），
                    不属于正文 Type Scale；这是全仓唯一豁免点（PRD 0.2.34）。 */}
                <p className="theme-launcher-hero-slogan">
                    {resolvedTheme.hero.slogans[sloganLocale]}
                </p>
            </div>

            {/* Mode declaration: 对话 / 想法 (see DESIGN.md §6.8, PRD §4.1).
                `mt-6 mb-6` opens breathing room above (separating from
                the brand group) and below (separating from the input
                affordance) — deliberately generous so the Launcher
                doesn't feel compressed even with the newly 3-row input.
                No `tabSwitchHint` — the hover tooltip was more noise than
                signal; power users who need the shortcut will discover
                it naturally, casual users shouldn't have a persistent
                tooltip popping every time their cursor brushes past. */}
            {modeSegmentEnabled && (
                // v0.1.69 polish: bottom gap tightened from mb-6 to mb-3 so
                // the toggle reads as an affordance OF the input below, not
                // a free-floating headline. Top gap kept at mt-6 to preserve
                // breathing room from the brand slogan above.
                <div className="mt-6 mb-3">
                    <ModeSegment
                        value={mode}
                        onChange={setModeAndFocus}
                    />
                </div>
            )}

            {/* Lower area: Input box with workspace selector in toolbar.
                When 「想法」 mode is active, a compact Recent Thoughts strip is
                absolute-positioned below the input so it hangs in the existing
                `pb-[12vh]` bottom space without shifting the brand/input
                vertically (PRD §4.2). */}
            <div className="w-full max-w-[640px] pb-[12vh]">
                <div className="relative w-full">
                    {/* Both inputs stay mounted so each mode's draft (text +
                     * caret + images for SimpleChatInput) survives the
                     * switch — conditional render would unmount and drop
                     * them. The inactive one is taken out of layout via
                     * `hidden` (display:none) so only the active mode
                     * contributes to the wrapper height; cards in 对话 vs
                     * 想法 size to their own content independently.
                     */}
                    <div className="grid *:col-start-1 *:row-start-1">
                        <div
                            ref={inputDropZoneRef}
                            className={mode === 'thought' ? 'hidden' : 'relative'}
                            aria-hidden={mode === 'thought'}
                            inert={mode === 'thought'}
                            {...(canAcceptFileDrop ? htmlFileDragHandlers : {})}
                        >
                            <SimpleChatInput
                                ref={inputRef}
                                mode="launcher"
                                active={canAcceptFileDrop}
                                onSend={handleSend}
                                isLoading={!!isStarting}
                                provider={provider}
                                providers={providers}
                                selectedModel={selectedModel}
                                onProviderChange={onProviderChange}
                                onModelChange={onModelChange}
                                reasoningEffort={reasoningEffort}
                                onReasoningEffortChange={onReasoningEffortChange}
                                permissionMode={permissionMode}
                                onPermissionModeChange={onPermissionModeChange}
                                /* PRD 0.2.7: workspace_files invokes need a path; selectedProject
                                 * is the launcher's "current workspace" from WorkspaceSelector. */
                                workspacePath={selectedProject?.path ?? null}
                                sessionId={attachmentSessionId}
                                /* PRD 0.2.7 cron staging — StatusBar shows iff a config is staged. */
                                cronModeEnabled={stagedCron !== null}
                                cronConfig={cronStatusBarConfig}
                                onCronButtonClick={handleOpenCronSettings}
                                onCronSettings={handleOpenCronSettings}
                                onCronCancel={handleCancelCronDraft}
                                onSlashAction={handleSlashAction}
                                showBuiltinSdkSlashCommands={shouldShowBuiltinSdkSlashCommands(inputExecutionRuntime)}
                                apiKeys={apiKeys}
                                providerVerifyStatus={providerVerifyStatus}
                                workspaceMcpEnabled={workspaceMcpEnabled}
                                globalMcpEnabled={globalMcpEnabled}
                                mcpServers={mcpServers}
                                onWorkspaceMcpToggle={onWorkspaceMcpToggle}
                                officialTools={officialTools}
                                workspaceOfficialToolEnabled={workspaceOfficialToolEnabled}
                                globalOfficialToolEnabled={globalOfficialToolEnabled}
                                officialToolNeedsConfig={officialToolNeedsConfig}
                                onWorkspaceOfficialToolToggle={onWorkspaceOfficialToolToggle}
                                globallyVisiblePlugins={globallyVisiblePlugins}
                                workspaceEnabledPlugins={workspaceEnabledPlugins}
                                onWorkspacePluginToggle={onWorkspacePluginToggle}
                                onRefreshProviders={onRefreshProviders}
                                runtime={runtime}
                                runtimeModels={runtimeModels}
                                runtimePermissionModes={runtimePermissionModes}
                                /* PRD 0.2.7 Phase F: workspace + runtime selectors moved out of
                                 * the toolbar to the row below — toolbarPrefix dropped here. */
                            />
                            <DropZoneOverlay isVisible={showInputDropOverlay} />
                        </div>
                        {modeSegmentEnabled && (
                            <div
                                className={mode === 'thought' ? '' : 'hidden'}
                                aria-hidden={mode !== 'thought'}
                                inert={mode !== 'thought'}
                            >
                                <ThoughtInput
                                    ref={thoughtInputRef}
                                    existingTags={tagCandidates}
                                    onCreated={handleThoughtCreated}
                                    variant="launcher"
                                    minLines={3}
                                    maxLines={9}
                                />
                            </div>
                        )}
                    </div>
                    {mode === 'thought' && modeSegmentEnabled && (
                        <div
                            className="launcher-below-input-stack absolute left-0 right-0 top-full mt-3 flex flex-col gap-4"
                        >
                            <RecentThoughtsRow
                                refreshKey={thoughtRefreshKey}
                                onOpenTaskCenter={openTaskCenter}
                            />
                            {providerSettingsPrompt}
                        </div>
                    )}
                    {/* PRD 0.2.7 Phase F: launcher-only chip row that surfaces
                     *  the Agent workspace + Runtime in the same screen slot the
                     *  thought-mode `RecentThoughtsRow` uses. Mutually exclusive
                     *  with that strip — dialogue mode shows this, thought mode
                     *  shows recent thoughts. */}
                    {mode === 'task' && (
                        <div
                            className="launcher-below-input-stack absolute left-0 right-0 top-full mt-2 flex flex-col gap-4"
                        >
                            <div className="w-full">
                                <LauncherInputContextRow
                                    projects={projects}
                                    selectedProject={selectedProject}
                                    defaultWorkspacePath={defaultWorkspacePath}
                                    onSelectWorkspace={onSelectWorkspace}
                                    onAddFolder={onAddFolder}
                                    onSetDefaultWorkspace={onSetDefaultWorkspace}
                                    showRuntime={!!multiAgentRuntimeEnabled}
                                    runtime={activeRuntime}
                                    runtimeDetections={runtimeDetections}
                                    onRuntimeChange={onRuntimeChange}
                                />
                            </div>
                            {providerSettingsPrompt}
                        </div>
                    )}
                </div>
            </div>

            {/* PRD 0.2.7 D1: launcher cron settings modal — confirming stages
             *  the config locally; the actual cron task is created by Chat
             *  after handoff. We pass `workspacePath` so the modal can
             *  populate workspace-relative defaults the same way it does in
             *  the chat tab. */}
            <CronTaskSettingsModal
                isOpen={showCronSettings}
                onClose={handleCloseCronSettings}
                initialPrompt=""
                initialConfig={cronOpenPreset ?? stagedCron ?? undefined}
                workspacePath={selectedProject?.path ?? ''}
                onConfirm={handleConfirmCronSettings}
            />
        </section>
    );
});
