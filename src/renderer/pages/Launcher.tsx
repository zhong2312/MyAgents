/**
 * Launcher - Main entry page for MyAgents
 * Two-column layout: Brand section (left 60%) + Workspaces (right 40%)
 * Responsive: stacks vertically below 640px
 */

import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';

import { perfMark } from '@/utils/perfMark';
import { RENDERER_PERF_PHASE } from '../../shared/perfTrace';
import { open } from '@tauri-apps/plugin-dialog';

import { track } from '@/analytics';
import type { EntryIntent, HistoryEntrySource, Surface } from '@/analytics';
import { type ImageAttachment } from '@/components/SimpleChatInput';
import { projectTaskExecutionOverrides } from '@/utils/taskProviderProjection';
import { coerceRuntimeBirthPermissionMode } from '../../shared/runtimeBirthFields';
import { useToast } from '@/components/Toast';
import { UnifiedLogsPanel } from '@/components/UnifiedLogsPanel';
import PathInputDialog from '@/components/PathInputDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
// P1: click-opened overlays — lazy so their subtrees (which transitively pull
// Markdown → mermaid/katex/syntax-highlighter) leave the eager entry chunk.
const HistorySearchOverlayContent = lazy(() => import('@/components/HistorySearchOverlayContent'));
import { BrandSection, LauncherRightRail, TemplateLibraryDialog, WorkspaceEditDialog } from '@/components/launcher';
import type { WorkbenchCreateAction } from '@/components/launcher/AddWorkspaceMenu';
const WorkspaceConfigPanel = lazy(() => import('@/components/WorkspaceConfigPanel'));
import { useConfig } from '@/hooks/useConfig';
import { useTaskCenterData } from '@/hooks/useTaskCenterData';
import { CODEX_SUBSCRIPTION_PROVIDER_ID, type Project, type PermissionMode, type McpServerDefinition, type WorkspaceTemplate, isProviderEnabled, isProjectActiveForUser, isProjectArchived, isProjectVisibleToUser, isSystemPresetProject } from '@/config/types';
import { CUSTOM_EVENTS } from '../../shared/constants';
import { normalizeWorkspacePathIdentity, workspacePathsEqual } from '../../shared/workspacePath';
import {
    getAllMcpServers,
    getEnabledMcpServerIds,
    isProviderAvailable,
    resolveProvider,
    pairBuiltinSelection,
} from '@/config/configService';
import { patchAgentConfig, patchAgentProjectConfig, getAgentById, disableAgentAndStopChannels, enableAgentAndStartChannels } from '@/config/services/agentConfigService';
import { archiveProject, unarchiveProject } from '@/config/services/projectService';
import { persistInputOptionChange } from '@/api/persistInputOption';
import { createCronTask, startCronTask } from '@/api/cronTaskClient';
import type { RuntimeType, RuntimeModelInfo, RuntimePermissionMode, RuntimeDetections, RuntimeConfig } from '../../shared/types/runtime';
import { CC_MODELS, CC_PERMISSION_MODES, CODEX_PERMISSION_MODES, GEMINI_PERMISSION_MODES, buildRuntimeChangePatch } from '../../shared/types/runtime';
import {
    isRuntimeBackedProvider,
    toProviderExecutionIntent,
} from '../../shared/providerExecution';
import {
    IMAGE_UNDERSTANDING_TOOL_ID,
    OFFICIAL_TOOLS,
    isImageUnderstandingToolConfigured,
    normalizeOfficialToolIds,
    type OfficialToolId,
} from '../../shared/official-tools';
import { apiGetJson } from '@/api/apiFetch';
import { isBrowserDevMode, pickFolderForDialog } from '@/utils/browserMock';
import { resolveLauncherProvider } from '@/utils/optionResolve';
import { useAgentStatuses } from '@/hooks/useAgentStatuses';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import type { SessionMetadata } from '@/api/sessionClient';
import type { InitialMessage, LaunchSessionBirthHint } from '@/types/tab';
import { workbenchRegistry } from '@/workbench-registry';
import type { WorkbenchProjectCreateRequest } from '@/workbench-sdk';

interface LauncherProps {
    onLaunchProject: (
        project: Project,
        sessionId?: string,
        initialMessage?: InitialMessage,
        analyticsContext?: { surface?: Surface; entryIntent?: EntryIntent; historyEntrySource?: HistoryEntrySource },
        sessionBirthHint?: LaunchSessionBirthHint,
    ) => void;
    isStarting?: boolean;
    startError?: string | null;
    isActive: boolean;
    attachmentSessionId?: string | null;
    sessionNotificationBadgeCounts?: ReadonlyMap<string, number>;
}

export default function Launcher({ onLaunchProject, isStarting, startError: _startError, isActive, attachmentSessionId, sessionNotificationBadgeCounts }: LauncherProps) {
    const { t } = useTranslation('launcher');
    const toast = useToast();
    const toastRef = useRef(toast);
    const pinToggleInFlightRef = useRef(new Set<string>());
    const {
        config,
        projects,
        providers,
        isLoading,
        error: _error,
        addProject,
        removeProject,
        patchProject,
        touchProject,
        apiKeys,
        providerVerifyStatus,
        refreshProviderData,
        updateConfig,
        refreshConfig,
    } = useConfig();

    useEffect(() => {
        toastRef.current = toast;
    }, [toast]);

    // Filter out internal projects (e.g. ~/.myagents diagnostic workspace).
    // Archived projects stay user-visible for the right rail restore affordance,
    // but they are excluded from launch selectors and default workspace choice.
    const userVisibleProjects = useMemo(() => projects.filter(isProjectVisibleToUser), [projects]);
    const visibleProjects = useMemo(() => userVisibleProjects.filter(isProjectActiveForUser), [userVisibleProjects]);
    const launcherWorkbenchRegistrations = useMemo(
        () => workbenchRegistry.list()
            .filter(registration => (
                registration.compatibility.compatible
                && registration.definition.launcher
                && registration.ProjectCreator
            ))
            .sort((left, right) => (
                (left.definition.launcher?.order ?? 0) - (right.definition.launcher?.order ?? 0)
                || left.definition.manifest.name.localeCompare(right.definition.manifest.name)
            )),
        [],
    );
    const workbenchCreateActions = useMemo<readonly WorkbenchCreateAction[]>(
        () => launcherWorkbenchRegistrations.map(registration => ({
            id: registration.definition.manifest.id,
            label: registration.definition.launcher?.createLabel ?? registration.definition.manifest.name,
            icon: registration.definition.launcher?.icon,
        })),
        [launcherWorkbenchRegistrations],
    );
    const workbenchTypeLabels = useMemo(
        () => new Map(launcherWorkbenchRegistrations.map(registration => [
            registration.definition.manifest.id,
            registration.definition.launcher?.projectTypeLabel ?? registration.definition.manifest.name,
        ])),
        [launcherWorkbenchRegistrations],
    );

    // Poll agent statuses only when any project has proactive mode
    const hasAnyAgent = useMemo(() => visibleProjects.some(p => p.isAgent), [visibleProjects]);
    const { statuses: agentStatuses } = useAgentStatuses(hasAnyAgent);
    const taskCenterData = useTaskCenterData({ isActive });
    const { initializeProject, openPathExternal } = useWorkspaceFileService(null);

    // Build agent lookup: project path → { agent config, runtime status }
    const agentLookup = useMemo(() => {
        const map = new Map<string, { agent: NonNullable<typeof config.agents>[number]; status?: (typeof agentStatuses)[string] }>();
        if (!config.agents) return map;
        for (const agent of config.agents) {
            // Canonical identity key (#320): agent.workspacePath and project.path
            // can diverge in separator/case form across stores on Windows.
            const key = normalizeWorkspacePathIdentity(agent.workspacePath);
            map.set(key, { agent, status: agentStatuses[agent.id] });
        }
        return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- config.agents is the actual dependency; full config would cause unnecessary recomputes
    }, [config.agents, agentStatuses]);

    const [_addError, setAddError] = useState<string | null>(null);
    const [launchingProjectId, setLaunchingProjectId] = useState<string | null>(null);
    const [showLogs, setShowLogs] = useState(false);
    const [projectToRemove, setProjectToRemove] = useState<Project | null>(null);
    const [showOverlay, setShowOverlay] = useState(false);
    const [showTemplateDialog, setShowTemplateDialog] = useState(false);
    const [activeWorkbenchCreatorId, setActiveWorkbenchCreatorId] = useState<string | null>(null);
    const [editingProject, setEditingProject] = useState<Project | null>(null);
    // Agent overlay — opens WorkspaceConfigPanel for agent settings or upgrade
    const [agentOverlay, setAgentOverlay] = useState<{ workspacePath: string; initialTab: 'agent' } | null>(null);
    const activeWorkbenchCreator = activeWorkbenchCreatorId
        ? workbenchRegistry.get(activeWorkbenchCreatorId)
        : undefined;
    const ActiveProjectCreator = activeWorkbenchCreator?.ProjectCreator;
    const defaultWorkbenchParentPath = useMemo(() => {
        if (typeof window !== 'undefined') {
            const stored = window.localStorage.getItem('myagents:lastNovelProjectDir')
                ?? window.localStorage.getItem('myagents:lastProjectDir');
            if (stored) return stored;
        }
        const latestPath = visibleProjects[0]?.path;
        if (latestPath) {
            const normalized = latestPath.replace(/\\/g, '/');
            const parent = normalized.split('/').slice(0, -1).join('/');
            if (parent) return parent;
        }
        return typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
            ? 'F:\\workspace\\novels'
            : '~/Documents/Novels';
    }, [visibleProjects]);

    // ===== Launcher-specific state for BrandSection =====

    // Fallback chain: defaultWorkspacePath → mino project → first project → null
    const resolveDefaultWorkspace = useCallback((projs: Project[]): Project | null => {
        if (config.defaultWorkspacePath) {
            const def = projs.find(p => workspacePathsEqual(p.path, config.defaultWorkspacePath));
            if (def) return def;
        }
        // Fallback: find mino project by path suffix
        const mino = projs.find(p => p.path.replace(/\\/g, '/').endsWith('/mino'));
        if (mino) return mino;
        return projs[0] ?? null;
    }, [config.defaultWorkspacePath]);

    const [selectedWorkspace, setSelectedWorkspace] = useState<Project | null>(() =>
        resolveDefaultWorkspace(visibleProjects)
    );

    // P0/P4: mark when the Launcher shell first commits, for the new-tab timeline
    // (new_tab_reveal → tab_shell_painted → tab_data_ready).
    useEffect(() => {
        perfMark(RENDERER_PERF_PHASE.tabShellPainted, { surface: 'launcher' });
    }, []);

    // A6 (instant-nav): warm the lazy Chat chunk while the user is on the
    // Launcher — opening a chat IS the Launcher's purpose, so the Launcher→Chat
    // flip should never hit a cold lazy chunk (paper Suspense flash). Only Chat,
    // NOT the whole route graph — a blind preload of every route caused the
    // WKWebView "preloaded but not used" warning storm removed in c465b2a9.
    // Idle-scheduled so it never competes with first paint.
    useEffect(() => {
        if (!isActive) return;
        // Warm the Chat chunk IMMEDIATELY (useEffect is post-paint, so this never
        // blocks the Launcher's first paint). NOT requestIdleCallback: idle keeps
        // losing the race — the Launcher's initial data fetches (task-center 6-way,
        // config) keep the thread busy, and the user clicks a workspace card within
        // ~0.7s, before the ~800ms cold Chat-chunk finishes. Measured: 1st launch
        // flip→Chat-mount ~900ms cold vs ~25ms warm. Starting the fetch the instant
        // the Launcher mounts gives it the most head start. Logs bracket the load so
        // we can see whether it beats the click. Only Chat (not the route graph).
        let cancelled = false;
        console.log('[Launcher] Chat-chunk preload START');
        void import('@/pages/Chat')
            .then(() => { if (!cancelled) console.log('[Launcher] Chat-chunk preload DONE'); })
            .catch(() => { /* non-fatal: the real lazy() retries on open */ });
        return () => { cancelled = true; };
    }, [isActive]);

    // Sync selectedWorkspace when visible projects change (e.g., after first project is added,
    // or after patchProject updates a project's settings from Chat tab)
    useEffect(() => {
        setSelectedWorkspace(prev => {
            if (!prev) return resolveDefaultWorkspace(visibleProjects);
            // Always use the latest project data (not stale prev reference)
            // so that settings changed in Chat via patchProject are reflected
            const updated = visibleProjects.find(p => p.id === prev.id);
            return updated ?? resolveDefaultWorkspace(visibleProjects);
        });
    }, [visibleProjects, resolveDefaultWorkspace]);

    const [launcherPermissionMode, setLauncherPermissionMode] = useState<PermissionMode>(config.defaultPermissionMode);
    const [launcherProviderId, setLauncherProviderId] = useState<string | undefined>();
    const [launcherSelectedModel, setLauncherSelectedModel] = useState<string | undefined>();
    // #324 — 推理强度 setting ('default' | level). Seeded from the agent in the
    // workspace-sync effect below; persisted via persistInputOptionChange.
    const [launcherReasoningEffort, setLauncherReasoningEffort] = useState<string>('default');

    // Runtime state — adapts model/permission selectors when workspace uses external runtime
    const multiAgentRuntimeEnabled = !!config.multiAgentRuntime;

    // PRD 0.2.7 D6 / Phase F: Launcher exposes Runtime selector in the row
    // below the input. We detect once on mount, mirroring Chat.tsx's pattern.
    const [runtimeDetections, setRuntimeDetections] = useState<RuntimeDetections>({
        builtin: { installed: true },
        'claude-code': { installed: false },
        codex: { installed: false },
        gemini: { installed: false },
    });
    useEffect(() => {
        if (!multiAgentRuntimeEnabled) return;
        let cancelled = false;
        import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke<Record<string, { installed: boolean; version?: string; path?: string }>>('cmd_detect_runtimes')
                .then(d => { if (!cancelled) setRuntimeDetections(d as RuntimeDetections); })
                .catch(() => { /* non-fatal */ });
        });
        return () => { cancelled = true; };
    }, [multiAgentRuntimeEnabled]);

    // MCP state
    const [launcherMcpServers, setLauncherMcpServers] = useState<McpServerDefinition[]>([]);
    const [launcherGlobalMcpEnabled, setLauncherGlobalMcpEnabled] = useState<string[]>([]);
    const [launcherWorkspaceMcpEnabled, setLauncherWorkspaceMcpEnabled] = useState<string[]>([]);
    // PRD 0.2.17 — Launcher's per-session plugin selection. Default seeded
    // from launcherLastUsed once config loads (effect below); transient
    // selection is carried into the new Tab via InitialMessage.
    const [launcherEnabledPlugins, setLauncherEnabledPlugins] = useState<string[]>([]);
    const [launcherOfficialToolEnabled, setLauncherOfficialToolEnabled] = useState<OfficialToolId[]>([]);
    const launcherGlobalOfficialToolEnabled = useMemo(
        () => normalizeOfficialToolIds(config.enabledOfficialToolIds ?? []),
        [config.enabledOfficialToolIds],
    );

    // Resolve AgentConfig for selected workspace (source of truth for AI settings)
    const selectedAgent = useMemo(() => {
        if (!selectedWorkspace?.agentId) return undefined;
        return getAgentById(config, selectedWorkspace.agentId);
    }, [selectedWorkspace?.agentId, config]);

    // Ref for runtimeConfig — avoids stale closure in rapid write-back handlers
    const runtimeConfigRef = useRef(selectedAgent?.runtimeConfig);
    runtimeConfigRef.current = selectedAgent?.runtimeConfig;

    // Runtime-aware model/permission lists — adapts input bar for external runtimes
    const selectedAgentRuntimeConfig = selectedAgent?.runtimeConfig as RuntimeConfig | undefined;
    const selectedAgentUsesManagedCodexProvider =
        selectedAgent?.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID
        || selectedAgentRuntimeConfig?.source === 'managed-provider';
    const launcherRuntime: RuntimeType = selectedAgentUsesManagedCodexProvider
        ? 'builtin'
        : multiAgentRuntimeEnabled
        ? ((selectedAgent?.runtime as RuntimeType) || 'builtin') : 'builtin';
    const isExternalRuntime = launcherRuntime !== 'builtin';

    // Codex + Gemini models are dynamic (fetched from the CLI); CC models are static
    const [codexModels, setCodexModels] = useState<RuntimeModelInfo[]>([]);
    const [geminiModels, setGeminiModels] = useState<RuntimeModelInfo[]>([]);
    useEffect(() => {
        if (!multiAgentRuntimeEnabled || launcherRuntime !== 'codex') { setCodexModels([]); return; }
        let cancelled = false;
        apiGetJson<{ models?: RuntimeModelInfo[] }>('/api/runtime/models?type=codex')
            .then(res => { if (!cancelled && res?.models?.length) setCodexModels(res.models); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [multiAgentRuntimeEnabled, launcherRuntime]);
    useEffect(() => {
        if (!multiAgentRuntimeEnabled || launcherRuntime !== 'gemini') { setGeminiModels([]); return; }
        let cancelled = false;
        apiGetJson<{ models?: RuntimeModelInfo[] }>('/api/runtime/models?type=gemini')
            .then(res => { if (!cancelled && res?.models?.length) setGeminiModels(res.models); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [multiAgentRuntimeEnabled, launcherRuntime]);

    const launcherRuntimeModels: RuntimeModelInfo[] | undefined = launcherRuntime === 'claude-code' ? CC_MODELS
        : launcherRuntime === 'codex' ? codexModels
        : launcherRuntime === 'gemini' ? geminiModels : undefined;
    const launcherRuntimePermissionModes: RuntimePermissionMode[] | undefined = launcherRuntime === 'claude-code'
        ? CC_PERMISSION_MODES
        : launcherRuntime === 'codex' ? CODEX_PERMISSION_MODES
        : launcherRuntime === 'gemini' ? GEMINI_PERMISSION_MODES : undefined;

    // Derive provider for launcher — only select providers with valid credentials
    const launcherProvider = useMemo(() => {
        const id = launcherProviderId ?? selectedAgent?.providerId ?? selectedWorkspace?.providerId ?? config.defaultProviderId;
        return resolveProvider(id, providers, apiKeys, providerVerifyStatus);
    }, [launcherProviderId, selectedAgent, selectedWorkspace, config.defaultProviderId, providers, apiKeys, providerVerifyStatus]);
    const imageUnderstandingConfiguredForInput = useMemo(() => {
        if (!isImageUnderstandingToolConfigured(config.officialToolSettings)) return false;
        const selection = config.officialToolSettings?.imageUnderstanding;
        const provider = providers.find(item => item.id === selection?.providerId);
        if (!provider || isRuntimeBackedProvider(provider)) return false;
        if (!isProviderAvailable(provider, apiKeys, providerVerifyStatus)) return false;
        const model = provider.models.find(item => item.model === selection?.model);
        return Array.isArray(model?.inputModalities) && model.inputModalities.includes('image');
    }, [apiKeys, config.officialToolSettings, providerVerifyStatus, providers]);
    const launcherOfficialToolNeedsConfig = useMemo(
        () => ({ [IMAGE_UNDERSTANDING_TOOL_ID]: !imageUnderstandingConfiguredForInput }),
        [imageUnderstandingConfiguredForInput],
    );

    // Load MCP servers when workspace changes
    useEffect(() => {
        const load = async () => {
            try {
                const servers = await getAllMcpServers();
                const enabled = await getEnabledMcpServerIds();
                setLauncherMcpServers(servers);
                setLauncherGlobalMcpEnabled(enabled);
                setLauncherWorkspaceMcpEnabled(selectedAgent?.mcpEnabledServers ?? selectedWorkspace?.mcpEnabledServers ?? []);
            } catch (err) {
                console.warn('[Launcher] Failed to load MCP servers:', err);
            }
        };
        void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedWorkspace?.id]);

    // Refresh MCP local state when tab becomes active (inactive → active transition).
    // Config/projects/providers/apiKeys are shared via ConfigProvider and auto-sync.
    // MCP servers are local state, so we reload them from disk on tab activation.
    const prevIsActiveRef = useRef(isActive);
    useEffect(() => {
        const wasInactive = !prevIsActiveRef.current;
        prevIsActiveRef.current = isActive;
        if (!wasInactive || !isActive) return;

        void (async () => {
            try {
                const servers = await getAllMcpServers();
                const enabled = await getEnabledMcpServerIds();
                setLauncherMcpServers(servers);
                setLauncherGlobalMcpEnabled(enabled);
            } catch (err) {
                console.warn('[Launcher] Failed to reload MCP servers on activation:', err);
            }
        })();
    }, [isActive]);

    // PRD 0.2.17 — Launcher plugin toggle (local state only; persisted via
    // launcherLastUsed at send time and carried to the new Tab via
    // InitialMessage.enabledPluginIds). No disk write here — Launcher
    // has no Agent context to write the per-Agent enable list against.
    const handleLauncherPluginToggle = useCallback((pluginId: string, enabled: boolean) => {
        setLauncherEnabledPlugins(prev =>
            enabled ? [...prev, pluginId] : prev.filter(id => id !== pluginId),
        );
    }, []);

    const handleLauncherOfficialToolToggle = useCallback((toolId: OfficialToolId, enabled: boolean) => {
        setLauncherOfficialToolEnabled(prev => {
            const newEnabled = normalizeOfficialToolIds(
                enabled ? [...prev, toolId] : prev.filter(id => id !== toolId),
            );
            if (selectedWorkspace) {
                void persistInputOptionChange({
                    workspaceId: selectedWorkspace.id,
                    agentId: selectedWorkspace.agentId ?? null,
                    isExternalRuntime,
                    currentRuntimeConfig: runtimeConfigRef.current,
                    currentProviderId: selectedAgent?.providerId ?? selectedWorkspace.providerId,
                    fields: { enabledOfficialToolIds: newEnabled },
                    patchProject,
                    patchAgentConfig,
                    patchAgentProjectConfig,
                });
            }
            return newEnabled;
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-create when workspace ID changes, not on every property change
    }, [selectedWorkspace?.id, patchProject, isExternalRuntime]);

    // Handle workspace MCP toggle — delegates to the shared dual-write helper
    // (PRD 0.2.7) so launcher and chat-tab persist identical fields.
    const handleWorkspaceMcpToggle = useCallback((serverId: string, enabled: boolean) => {
        setLauncherWorkspaceMcpEnabled(prev => {
            const newEnabled = enabled ? [...prev, serverId] : prev.filter(id => id !== serverId);
            if (selectedWorkspace) {
                void persistInputOptionChange({
                    workspaceId: selectedWorkspace.id,
                    agentId: selectedWorkspace.agentId ?? null,
                    isExternalRuntime,
                    currentRuntimeConfig: runtimeConfigRef.current,
                    currentProviderId: selectedAgent?.providerId ?? selectedWorkspace.providerId,
                    fields: { mcpEnabledServers: newEnabled },
                    patchProject,
                    patchAgentConfig,
                    patchAgentProjectConfig,
                    // Launcher has no Sidecar — sidecar push happens after handoff.
                });
            }
            return newEnabled;
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-create when workspace ID changes, not on every property change
    }, [selectedWorkspace?.id, patchProject, isExternalRuntime]);

    // Restore launcherLastUsed settings once config finishes loading from disk.
    // useState initializers run before async config load completes (config = DEFAULT_CONFIG
    // at that point), so we must sync saved values via effect after isLoading becomes false.
    const lastUsedAppliedRef = useRef(false);
    useEffect(() => {
        if (isLoading || lastUsedAppliedRef.current) return;
        lastUsedAppliedRef.current = true;
        const lastUsed = config.launcherLastUsed;
        if (!lastUsed) return;
        if (lastUsed.permissionMode) setLauncherPermissionMode(lastUsed.permissionMode);
        // #234: launcherLastUsed is a global, workspace-agnostic snapshot of the
        // last provider/model the user picked from the launcher. Restoring it
        // verbatim shadows the selected agent's CURRENT default (the launcherProvider
        // memo prefers launcherProviderId), so after the user changes an Agent's
        // provider in Settings (e.g. MiniMax → DeepSeek) the launcher kept opening
        // sessions on the stale provider → request timeouts. Only restore the cached
        // provider/model when it's still consistent with the agent default; otherwise
        // the agent default wins (and the stale model is dropped with it).
        const resolved = resolveLauncherProvider({
            lastUsedProviderId: lastUsed.providerId,
            lastUsedModel: lastUsed.model,
            agentProviderId: selectedAgent?.providerId,
            agentModel: selectedAgent?.model,
            workspaceProviderId: selectedWorkspace?.providerId,
            workspaceModel: selectedWorkspace?.model,
            defaultProviderId: config.defaultProviderId,
        });
        if (resolved.providerId) setLauncherProviderId(resolved.providerId);
        if (resolved.model) setLauncherSelectedModel(resolved.model);
        if (lastUsed.mcpEnabledServers) setLauncherWorkspaceMcpEnabled(lastUsed.mcpEnabledServers);
        if (lastUsed.enabledPluginIds) setLauncherEnabledPlugins(lastUsed.enabledPluginIds);
        if (lastUsed.enabledOfficialToolIds) setLauncherOfficialToolEnabled(normalizeOfficialToolIds(lastUsed.enabledOfficialToolIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time restore; selected agent/workspace read at apply time, intentionally not deps
    }, [isLoading, config.launcherLastUsed]);

    // Extract runtimeConfig primitives for stable useEffect deps (avoid object reference)
    const agentRuntimeModel = (selectedAgent?.runtimeConfig as { model?: string } | undefined)?.model;
    const agentRuntimePermMode = (selectedAgent?.runtimeConfig as { permissionMode?: string } | undefined)?.permissionMode;
    const agentRuntimeReasoningEffort = (selectedAgent?.runtimeConfig as { reasoningEffort?: string } | undefined)?.reasoningEffort;

    // Sync launcher settings from selected workspace's per-project config.
    // Declared AFTER launcherLastUsed effect so project settings take priority on initial load.
    // Priority: project setting > global default (launcherLastUsed is global, not per-workspace)
    // Depends on individual fields (not just .id) so it re-runs when Chat's patchProject updates them.
    // NOTE (#234): when a workspace is selected this effect is the primary author
    // of launcherProviderId (always agent → project default), so it already keeps
    // the launcher current after an agent-provider change. The consistency check
    // in the launcherLastUsed restore effect above is load-bearing for the
    // no-workspace / pre-this-effect window — both must agree; don't "simplify"
    // by deleting one.
    useEffect(() => {
        if (isLoading || !selectedWorkspace) return;
        // For external runtimes, model and permission come from runtimeConfig.
        // Branch on isExternalRuntime alone — empty runtimeConfig is valid (uses runtime defaults).
        if (isExternalRuntime) {
            setLauncherSelectedModel(agentRuntimeModel ?? undefined);
            setLauncherPermissionMode((agentRuntimePermMode as PermissionMode | undefined) ?? config.defaultPermissionMode);
            setLauncherReasoningEffort(agentRuntimeReasoningEffort ?? 'default');
        } else {
            setLauncherPermissionMode((selectedAgent?.permissionMode as PermissionMode | undefined) ?? selectedWorkspace.permissionMode ?? config.defaultPermissionMode);
            setLauncherSelectedModel(selectedAgent?.model ?? selectedWorkspace.model ?? undefined);
            setLauncherReasoningEffort(selectedAgent?.reasoningEffort ?? 'default');
        }
        setLauncherProviderId(selectedAgent?.providerId ?? selectedWorkspace.providerId ?? undefined);
        setLauncherWorkspaceMcpEnabled(selectedAgent?.mcpEnabledServers ?? selectedWorkspace.mcpEnabledServers ?? []);
        setLauncherOfficialToolEnabled(normalizeOfficialToolIds(selectedAgent?.enabledOfficialToolIds ?? selectedWorkspace.enabledOfficialToolIds ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depend on specific agent/project fields, not object ref
    }, [isLoading, selectedWorkspace?.id, selectedAgent?.permissionMode, selectedAgent?.model, selectedAgent?.providerId, selectedAgent?.mcpEnabledServers, selectedAgent?.enabledOfficialToolIds, selectedAgent?.runtime, selectedAgent?.reasoningEffort, agentRuntimeModel, agentRuntimePermMode, agentRuntimeReasoningEffort, selectedWorkspace?.permissionMode, selectedWorkspace?.model, selectedWorkspace?.providerId, selectedWorkspace?.mcpEnabledServers, selectedWorkspace?.enabledOfficialToolIds, config.defaultPermissionMode, multiAgentRuntimeEnabled, isExternalRuntime]);

    // Write-back handlers: persist Launcher setting changes to the selected project

    const handleLauncherPermissionModeChange = useCallback((mode: PermissionMode) => {
        setLauncherPermissionMode(mode);
        if (selectedWorkspace) {
            void persistInputOptionChange({
                workspaceId: selectedWorkspace.id,
                agentId: selectedWorkspace.agentId ?? null,
                isExternalRuntime,
                currentRuntimeConfig: runtimeConfigRef.current,
                currentProviderId: selectedAgent?.providerId ?? selectedWorkspace.providerId,
                fields: { permissionMode: mode },
                patchProject,
                patchAgentConfig,
                patchAgentProjectConfig,
            });
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed deps; runtimeConfigRef is a ref
    }, [selectedWorkspace?.id, patchProject, isExternalRuntime]);

    const handleLauncherModelChange = useCallback((model: string | undefined) => {
        setLauncherSelectedModel(model);
        if (selectedWorkspace) {
            const providerExecutionIntent = !isExternalRuntime && launcherProvider && model
                ? toProviderExecutionIntent(launcherProvider, model)
                : undefined;
            void persistInputOptionChange({
                workspaceId: selectedWorkspace.id,
                agentId: selectedWorkspace.agentId ?? null,
                isExternalRuntime,
                currentRuntimeConfig: runtimeConfigRef.current,
                currentProviderId: selectedAgent?.providerId ?? selectedWorkspace.providerId,
                fields: isExternalRuntime
                    ? { runtimeModel: model ?? null }
                    : providerExecutionIntent?.kind === 'runtime-backed-provider'
                        ? { runtimeBackedProviderSelection: providerExecutionIntent }
                        : { builtinModel: model ?? null },
                patchProject,
                patchAgentConfig,
                patchAgentProjectConfig,
            });
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed deps; runtimeConfigRef is a ref
    }, [selectedWorkspace?.id, patchProject, isExternalRuntime, launcherProvider]);

    // #324 — 推理强度 write-back. Same dual-write shape as model/permission;
    // no live sidecar in launcher, so disk persistence is the whole job (the
    // handed-off Chat tab seeds from the agent and pushes on connect).
    const handleLauncherReasoningEffortChange = useCallback((effort: string) => {
        setLauncherReasoningEffort(effort);
        if (selectedWorkspace) {
            void persistInputOptionChange({
                workspaceId: selectedWorkspace.id,
                agentId: selectedWorkspace.agentId ?? null,
                isExternalRuntime,
                currentRuntimeConfig: runtimeConfigRef.current,
                currentProviderId: selectedAgent?.providerId ?? selectedWorkspace.providerId,
                fields: { reasoningEffort: effort },
                patchProject,
                patchAgentConfig,
                patchAgentProjectConfig,
            });
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed deps; runtimeConfigRef is a ref
    }, [selectedWorkspace?.id, patchProject, isExternalRuntime]);

    // PRD 0.2.7 D6: Runtime change in launcher persists to Agent.runtime so the
    // next Chat session boots in the chosen runtime. No live sidecar to fork —
    // the next handoff creates a fresh sidecar with the persisted runtime.
    const handleLauncherRuntimeChange = useCallback(async (runtime: RuntimeType) => {
        if (!selectedWorkspace?.agentId) {
            toastRef.current.warning(t('toasts.runtimeNeedsAgent'));
            return;
        }
        try {
            // buildRuntimeChangePatch scrubs cross-runtime non-portable fields
            // (model / permissionMode / additionalArgs). All 4 runtime-change
            // callsites funnel through this helper. See doc in
            // shared/types/runtime.ts.
            await patchAgentConfig(
                selectedWorkspace.agentId,
                buildRuntimeChangePatch(selectedAgent?.runtimeConfig, runtime),
            );
        } catch (err) {
            console.error('[Launcher] runtime change failed:', err);
            toastRef.current.error(t('toasts.runtimeSwitchFailed'));
        }
    }, [selectedWorkspace?.agentId, selectedAgent?.runtimeConfig, t]);

    const handleLauncherProviderChange = useCallback((providerId: string | undefined, targetModel?: string) => {
        setLauncherProviderId(providerId);
        const newProvider = providerId ? providers.find(p => p.id === providerId) : undefined;
        const model = targetModel ?? newProvider?.primaryModel;
        if (model) {
            setLauncherSelectedModel(model);
        }
        if (selectedWorkspace) {
            const providerExecutionIntent = newProvider && model
                ? toProviderExecutionIntent(newProvider, model)
                : undefined;
            void persistInputOptionChange({
                workspaceId: selectedWorkspace.id,
                agentId: selectedWorkspace.agentId ?? null,
                isExternalRuntime,
                currentRuntimeConfig: runtimeConfigRef.current,
                currentProviderId: selectedAgent?.providerId ?? selectedWorkspace.providerId,
                fields: {
                    ...(providerExecutionIntent?.kind === 'runtime-backed-provider'
                        ? { runtimeBackedProviderSelection: providerExecutionIntent }
                        : {
                            providerId: providerId ?? undefined,
                            builtinModel: model ?? undefined,
                        }),
                },
                patchProject,
                patchAgentConfig,
                patchAgentProjectConfig,
            });
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-create when workspace ID changes
    }, [selectedWorkspace?.id, patchProject, providers, isExternalRuntime]);

    // Navigate to Settings > Providers page
    const handleGoToSettings = useCallback(() => {
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
            detail: { section: 'providers' },
        }));
    }, []);

    // Promote a project to the global default workspace. Same code path as
    // Settings → 通用设置 → 默认工作区 (`updateConfig({ defaultWorkspacePath })`)
    // — keeps the WorkspaceSelector dropdown in sync with the existing config
    // surface so a change made here shows up in Settings on next open and
    // vice versa. Failure is non-fatal — toast a warning but keep the dropdown
    // usable; the user can retry.
    const handleSetDefault = useCallback(async (project: Project) => {
        try {
            await updateConfig({ defaultWorkspacePath: project.path });
        } catch (err) {
            console.error('[Launcher] failed to set default workspace:', err);
            toastRef.current.warning(t('toasts.setDefaultFailed'));
        }
    }, [t, updateConfig]);

    // Handle send from BrandSection — `cron` is the launcher-staged cron config
    // (PRD 0.2.7 D1); when present, Chat's autoSend dispatches startCronTask
    // instead of sendMessage.
    const handleBrandSend = useCallback(async (
        text: string,
        images?: ImageAttachment[],
        cron?: import('@/types/tab').InitialMessageCron,
    ) => {
        if (!selectedWorkspace) {
            toastRef.current.error(t('toasts.selectWorkspaceFirst'));
            return;
        }

        // PRD 0.2.3 + cross-review: split provider/model by runtime dimension. For builtin,
        // pairBuiltinSelection enforces model ∈ provider.models — closing the
        // "stale agent.model paired with first-available fallback provider" hole when the
        // primary provider's key was deleted between agent setup and send.
        const launcherModelForProvider = launcherSelectedModel ?? launcherProvider?.primaryModel;
        const providerExecutionIntent = (!isExternalRuntime && launcherProvider && launcherModelForProvider)
            ? toProviderExecutionIntent(launcherProvider, launcherModelForProvider)
            : undefined;
        const runtimeBackedProviderIdentity = providerExecutionIntent?.kind === 'runtime-backed-provider'
            ? providerExecutionIntent
            : undefined;
        const builtinSelection = (!isExternalRuntime && launcherProvider && !isRuntimeBackedProvider(launcherProvider))
            ? pairBuiltinSelection(launcherProvider, launcherSelectedModel)
            : undefined;
        const runtimeModel = isExternalRuntime
            ? launcherSelectedModel
            : runtimeBackedProviderIdentity?.model;
        // PRD 0.2.17 — only carry plugins that are still globally visible
        // (Settings 开关 ON) to avoid silently re-enabling hidden plugins
        // when Launcher's last-used list is older than the current visibility
        // state.
        const launcherVisiblePluginIds = new Set(
            (config.plugins ?? [])
                .filter(p => config.enabledPlugins?.[p.id] === true)
                .map(p => p.id),
        );
        const carriedEnabledPlugins = launcherEnabledPlugins.filter(id =>
            launcherVisiblePluginIds.has(id),
        );
        const carriedOfficialTools = launcherOfficialToolEnabled.filter(id =>
            launcherGlobalOfficialToolEnabled.includes(id)
            && (id !== IMAGE_UNDERSTANDING_TOOL_ID || imageUnderstandingConfiguredForInput),
        );

        const initialMessage: InitialMessage = {
            text,
            images,
            permissionMode: launcherPermissionMode,
            mcpEnabledServers: launcherWorkspaceMcpEnabled.filter(id => launcherGlobalMcpEnabled.includes(id)),
            ...(carriedEnabledPlugins.length > 0 ? { enabledPluginIds: carriedEnabledPlugins } : {}),
            enabledOfficialToolIds: carriedOfficialTools,
            ...(builtinSelection ? { builtinSelection } : {}),
            ...(runtimeModel ? { runtimeModel } : {}),
            ...(runtimeBackedProviderIdentity ? { providerExecutionIdentity: runtimeBackedProviderIdentity } : {}),
            // #324 — hand-carry: don't bet the async agent-config write wins
            // the race against the new tab's mount/seed.
            ...(launcherReasoningEffort !== 'default' ? { reasoningEffort: launcherReasoningEffort } : {}),
            ...(cron ? { cron } : {}),
        };

        // Persist launcher settings for next app launch
        updateConfig({
            launcherLastUsed: {
                providerId: launcherProvider?.id,
                model: launcherSelectedModel,
                permissionMode: launcherPermissionMode,
                mcpEnabledServers: launcherWorkspaceMcpEnabled,
                enabledPluginIds: launcherEnabledPlugins,
                enabledOfficialToolIds: launcherOfficialToolEnabled,
            },
        }).catch(err => console.warn('[Launcher] Failed to save launcherLastUsed:', err));

        setLaunchingProjectId(selectedWorkspace.id);
        touchProject(selectedWorkspace.id).catch(() => {});

        // Bug 1 fix — "新开对话" launcher cron should NOT pop a chat tab.
        // The modal's promise to the user: "创建独立定时任务，不占用当前对话".
        // Chat.tsx already has the in-chat equivalent (line ~2056: when
        // `executionTarget === 'new_task'` it creates a standalone task and
        // toasts "定时任务已创建" instead of dispatching as a chat message).
        // Mirror that behavior here so the launcher path honors the same
        // user-visible promise.
        //
        // Path:
        //   1. createCronTask with a freshly-minted standalone session id
        //      (matches `cron-standalone-<uuid>` convention from Chat.tsx)
        //   2. startCronTask (persists running and arms the scheduler)
        //   3. toast + clear loading; stay on launcher
        // Failure → fall through to the regular tab-launch path so the user
        // doesn't lose their input — same recovery contract Chat.tsx
        // autoSend uses.
        if (cron?.taskKind === 'cron' && cron.executionTarget === 'new_task') {
            try {
                const standaloneSessionId = `cron-standalone-${crypto.randomUUID()}`;
                // Send provider identity only. TaskStore never persists
                // credential env; a new execution Session resolves it live.
                //
                // External runtimes don't carry a providerId (they manage
                // their own provider via their CLI). When the runtime is
                // external, providerId is undefined → sidecar follows the
                // agent's runtime resolution.
                const launcherProviderId =
                    !isExternalRuntime && launcherProvider
                        ? launcherProvider.id
                        : undefined;
                const cronExecution = projectTaskExecutionOverrides({
                    providers,
                    runtime: launcherRuntime,
                    providerId: launcherProviderId,
                    model: builtinSelection?.model ?? runtimeModel,
                    runtimeConfig: isExternalRuntime ? runtimeConfigRef.current : undefined,
                });
                const cronPermissionMode = coerceRuntimeBirthPermissionMode(
                    launcherPermissionMode,
                    cronExecution.runtime ?? launcherRuntime,
                );
                const created = await createCronTask({
                    workspacePath: selectedWorkspace.path,
                    sessionId: standaloneSessionId,
                    prompt: text,
                    intervalMinutes: cron.intervalMinutes,
                    endConditions: cron.endConditions,
                    runMode: 'new_session',
                    notifyEnabled: cron.notifyEnabled,
                    schedule: cron.schedule,
                    delivery: cron.delivery,
                    name: cron.name,
                    permissionMode: cronPermissionMode,
                    model: cronExecution.model,
                    providerId: cronExecution.providerId,
                    runtime: cronExecution.runtime,
                    runtimeConfig: cronExecution.runtimeConfig,
                    // A standalone Task has no existing Session, so the
                    // launcher's MCP selection initializes its first Session.
                    mcpEnabledServers: launcherWorkspaceMcpEnabled,
                });
                await startCronTask(created.id);
                track('launcher_cron_create_standalone', {
                    interval_minutes: cron.intervalMinutes,
                    schedule_kind: cron.schedule.kind,
                });
                toastRef.current.success(t('toasts.standaloneCronCreated'));
                setLaunchingProjectId(null);
                return;
            } catch (err) {
                console.error('[Launcher] Failed to create standalone cron task:', err);
                toastRef.current.error(t('toasts.createCronFailed', { message: err instanceof Error ? err.message : String(err) }));
                setLaunchingProjectId(null);
                return;
            }
        }

        onLaunchProject(
            selectedWorkspace,
            undefined,
            initialMessage,
            { surface: 'launcher_input', entryIntent: 'send_message' },
        );
    }, [selectedWorkspace, launcherProvider, launcherPermissionMode,
        launcherSelectedModel, launcherReasoningEffort, launcherWorkspaceMcpEnabled, launcherGlobalMcpEnabled,
        launcherEnabledPlugins, launcherOfficialToolEnabled, launcherGlobalOfficialToolEnabled,
        imageUnderstandingConfiguredForInput, config.plugins, config.enabledPlugins,
        isExternalRuntime, launcherRuntime, providers, t,
        touchProject, onLaunchProject, updateConfig]);

    // Path input dialog state (for browser dev mode)
    const [pathDialogOpen, setPathDialogOpen] = useState(false);
    const [pendingFolderName, setPendingFolderName] = useState('');
    const [pendingDefaultPath, setPendingDefaultPath] = useState('');

    const handleLaunch = useCallback((project: Project, sessionId?: string, historyEntrySource?: HistoryEntrySource) => {
        // Mark the TRUE click moment (before any state set / handler latency) so
        // the unified log shows card_click → launch_start → launch_flip →
        // useCronTask(chat mount) → launch_ensured — i.e. the real click→chat-painted
        // timeline, independent of the chunk cache.
        perfMark('card_click');
        console.log(`[Launcher] CARD CLICK project=${project.id} sessionId=${sessionId ?? 'NEW'}`);
        setLaunchingProjectId(project.id);
        // Update lastOpened timestamp (async, don't block launch)
        touchProject(project.id).catch((err) => {
            console.warn('[Launcher] Failed to update lastOpened:', err);
        });
        if (!sessionId && project.workbenchId) {
            window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_WORKBENCH, {
                detail: {
                    workbenchId: project.workbenchId,
                    workspacePath: project.path,
                    route: project.workbenchRoute,
                    title: project.displayName || project.name,
                },
            }));
            setLaunchingProjectId(null);
            return;
        }
        let sessionBirthHint: LaunchSessionBirthHint | undefined;
        if (
            !sessionId
            && selectedWorkspace
            && workspacePathsEqual(selectedWorkspace.path, project.path)
            && !isExternalRuntime
            && launcherProvider
        ) {
            const model = launcherSelectedModel ?? launcherProvider.primaryModel;
            const intent = model ? toProviderExecutionIntent(launcherProvider, model) : undefined;
            if (intent?.kind === 'runtime-backed-provider') {
                const visiblePluginIds = new Set(
                    (config.plugins ?? [])
                        .filter(p => config.enabledPlugins?.[p.id] === true)
                        .map(p => p.id),
                );
                sessionBirthHint = {
                    providerExecutionIdentity: intent,
                    permissionMode: launcherPermissionMode,
                    reasoningEffort: launcherReasoningEffort,
                    mcpEnabledServers: launcherWorkspaceMcpEnabled.filter(id => launcherGlobalMcpEnabled.includes(id)),
                    enabledPluginIds: launcherEnabledPlugins.filter(id => visiblePluginIds.has(id)),
                    enabledOfficialToolIds: launcherOfficialToolEnabled.filter(id =>
                        launcherGlobalOfficialToolEnabled.includes(id)
                        && (id !== IMAGE_UNDERSTANDING_TOOL_ID || imageUnderstandingConfiguredForInput),
                    ),
                };
            }
        }
        onLaunchProject(
            project,
            sessionId,
            undefined,
            sessionId
                ? { historyEntrySource: historyEntrySource ?? 'launcher_recent' }
                : { surface: 'agent_card', entryIntent: 'open_workspace' },
            sessionBirthHint,
        );
    }, [
        touchProject,
        onLaunchProject,
        selectedWorkspace,
        isExternalRuntime,
        launcherProvider,
        launcherSelectedModel,
        launcherPermissionMode,
        launcherReasoningEffort,
        launcherWorkspaceMcpEnabled,
        launcherGlobalMcpEnabled,
        launcherEnabledPlugins,
        launcherOfficialToolEnabled,
        launcherGlobalOfficialToolEnabled,
        imageUnderstandingConfiguredForInput,
        config.plugins,
        config.enabledPlugins,
    ]);

    const handlePickWorkbenchParent = useCallback(async (): Promise<string | null> => {
        if (isBrowserDevMode()) {
            const folderInfo = await pickFolderForDialog();
            return folderInfo?.defaultPath ?? null;
        }
        const selected = await open({
            directory: true,
            multiple: false,
            title: '选择小说保存位置',
        });
        return typeof selected === 'string' ? selected : null;
    }, []);

    const handleCreateWorkbenchProject = useCallback(async (request: WorkbenchProjectCreateRequest) => {
        if (!activeWorkbenchCreatorId) throw new Error('未选择工作台');
        const registration = workbenchRegistry.get(activeWorkbenchCreatorId);
        if (!registration?.definition.launcher) throw new Error('工作台创建入口不可用');

        const initialized = await initializeProject({
            workspacePath: request.workspacePath,
            initialization: request.initialization,
        });
        let project: Project;
        try {
            project = await addProject(initialized.workspacePath, {
                icon: request.icon,
                displayName: request.displayName,
                workbenchId: registration.definition.manifest.id,
                workbenchRoute: request.route ?? registration.definition.manifest.entry.defaultRoute,
            });
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            throw new Error(`小说目录已创建，但加入 MyAgents 失败：${message}`);
        }
        const normalizedPath = initialized.workspacePath.replace(/\\/g, '/');
        const parentPath = normalizedPath.split('/').slice(0, -1).join('/');
        if (parentPath) window.localStorage.setItem('myagents:lastNovelProjectDir', parentPath);
        setActiveWorkbenchCreatorId(null);
        handleLaunch(project);
    }, [activeWorkbenchCreatorId, addProject, handleLaunch, initializeProject]);

    const handleOpenTask = useCallback((session: SessionMetadata, project: Project, historyEntrySource: HistoryEntrySource = 'launcher_recent') => {
        handleLaunch(project, session.id, historyEntrySource);
    }, [handleLaunch]);

    const [overlayMode, setOverlayMode] = useState<'default' | 'search'>('default');
    const handleOpenOverlay = useCallback((mode: 'default' | 'search' = 'default') => { track('task_center_open', {}); setOverlayMode(mode); setShowOverlay(true); }, []);
    const handleCloseOverlay = useCallback(() => { setShowOverlay(false); setOverlayMode('default'); }, []);

    // Stable callback for overlay session open (avoids inline function in render)
    const handleOverlayOpenTask = useCallback((session: SessionMetadata, project: Project) => {
        handleOpenTask(session, project, 'launcher_overlay');
        handleCloseOverlay();
    }, [handleOpenTask, handleCloseOverlay]);

    const handleAddProject = async () => {
        setAddError(null);
        console.log('[Launcher] handleAddProject called');

        try {
            if (isBrowserDevMode()) {
                const folderInfo = await pickFolderForDialog();
                if (folderInfo) {
                    setPendingFolderName(folderInfo.folderName);
                    setPendingDefaultPath(folderInfo.defaultPath);
                    setPathDialogOpen(true);
                } else {
                    console.log('[Launcher] Folder picker cancelled');
                }
            } else {
                const selected = await open({
                    directory: true,
                    multiple: false,
                    title: t('dialogs.pickProjectFolder'),
                });
                console.log('[Launcher] Dialog result:', selected);

                if (selected && typeof selected === 'string') {
                    console.log('[Launcher] Adding project:', selected);
                    const project = await addProject(selected);
                    console.log('[Launcher] Project added:', project);
                } else {
                    console.log('[Launcher] No folder selected or dialog cancelled');
                }
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error('[Launcher] Failed to add project:', errorMsg);
            setAddError(errorMsg);
            toast.error(t('toasts.addProjectFailed', { message: errorMsg }));
        }
    };

    const handlePathConfirm = async (path: string) => {
        setPathDialogOpen(false);
        console.log('[Launcher] Path confirmed:', path);

        try {
            const project = await addProject(path);
            console.log('[Launcher] Project added:', project);
            // Normalize path separators for cross-platform support
            const normalizedPath = path.replace(/\\/g, '/');
            const parentDir = normalizedPath.split('/').slice(0, -1).join('/');
            if (parentDir) {
                localStorage.setItem('myagents:lastProjectDir', parentDir);
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error('[Launcher] Failed to add project:', errorMsg);
            setAddError(errorMsg);
            toast.error(t('toasts.addProjectFailed', { message: errorMsg }));
        }
    };

    const handlePathCancel = () => {
        setPathDialogOpen(false);
        console.log('[Launcher] Path dialog cancelled');
    };

    const handleRemoveProject = useCallback((project: Project) => {
        setProjectToRemove(project);
    }, []);

    const handleToggleProjectPin = useCallback(async (project: Project) => {
        if (isProjectArchived(project)) return;
        if (pinToggleInFlightRef.current.has(project.id)) return;
        pinToggleInFlightRef.current.add(project.id);
        try {
            const currentProject = projects.find(candidate => candidate.id === project.id) ?? project;
            await patchProject(project.id, {
                pinnedAt: currentProject.pinnedAt ? undefined : new Date().toISOString(),
            });
        } catch (err) {
            console.error('[Launcher] failed to toggle workspace pin:', err);
            toastRef.current.warning(t('toasts.pinFailed'));
        } finally {
            pinToggleInFlightRef.current.delete(project.id);
        }
    }, [patchProject, projects, t]);

    const archiveToggleInFlightRef = useRef(new Set<string>());

    const handleArchiveProject = useCallback(async (project: Project) => {
        if (archiveToggleInFlightRef.current.has(project.id)) return;
        archiveToggleInFlightRef.current.add(project.id);
        try {
            const currentProject = projects.find(candidate => candidate.id === project.id) ?? project;
            const agent = currentProject.agentId ? getAgentById(config, currentProject.agentId) : undefined;
            const wasProactive = agent?.enabled === true;
            const archivedProject = await archiveProject(currentProject.id, { agentEnabledBeforeArchive: wasProactive });
            if (!archivedProject) throw new Error(`Project ${currentProject.id} not found`);
            if (agent && wasProactive) await disableAgentAndStopChannels(agent);
            await refreshConfig();
            toastRef.current.success(t('toasts.workspaceArchived'));
        } catch (err) {
            console.error('[Launcher] failed to archive workspace:', err);
            toastRef.current.warning(t('toasts.archiveFailed'));
        } finally {
            archiveToggleInFlightRef.current.delete(project.id);
        }
    }, [config, projects, refreshConfig, t]);

    const handleUnarchiveProject = useCallback(async (project: Project) => {
        if (archiveToggleInFlightRef.current.has(project.id)) return;
        archiveToggleInFlightRef.current.add(project.id);
        try {
            const currentProject = projects.find(candidate => candidate.id === project.id) ?? project;
            const shouldRestoreAgent = currentProject.archivedAgentEnabledBeforeArchive === true;
            const unarchivedProject = await unarchiveProject(currentProject.id);
            if (!unarchivedProject) throw new Error(`Project ${currentProject.id} not found`);
            if (shouldRestoreAgent && currentProject.agentId) {
                try {
                    await enableAgentAndStartChannels(currentProject.agentId);
                } catch (err) {
                    await archiveProject(currentProject.id, {
                        archivedAtIso: currentProject.archivedAt,
                        agentEnabledBeforeArchive: true,
                    });
                    throw err;
                }
            }
            await refreshConfig();
            toastRef.current.success(t('toasts.workspaceUnarchived'));
        } catch (err) {
            console.error('[Launcher] failed to unarchive workspace:', err);
            toastRef.current.warning(t('toasts.unarchiveFailed'));
        } finally {
            archiveToggleInFlightRef.current.delete(project.id);
        }
    }, [projects, refreshConfig, t]);

    const confirmRemoveProject = async () => {
        if (projectToRemove) {
            await removeProject(projectToRemove.id);
            setProjectToRemove(null);
        }
    };

    const handleCreateFromTemplate = useCallback(async (path: string, template: WorkspaceTemplate, displayName?: string) => {
        await addProject(path, {
            icon: template.icon,
            displayName,
            templateId: template.id,
            templateSource: template.isBuiltin ? 'builtin' : 'user',
            workbenchId: template.workbenchId,
            workbenchRoute: template.workbenchRoute,
            agentDefaults: template.isBuiltin ? template.agentDefaults : undefined,
        });
        track('workspace_create', { source: 'template' });
    }, [addProject]);

    const handleEditProject = useCallback(async (projectId: string, updates: { displayName?: string; icon?: string }) => {
        await patchProject(projectId, updates);
    }, [patchProject]);

    const handleOpenTemplateDialog = useCallback(() => setShowTemplateDialog(true), []);
    const handleCloseTemplateDialog = useCallback(() => setShowTemplateDialog(false), []);
    const handleCloseEditDialog = useCallback(() => setEditingProject(null), []);
    const handleShowLogs = useCallback(() => setShowLogs(true), []);

    // Agent overlay handlers
    const handleAgentSettings = useCallback((project: Project) => {
        setAgentOverlay({ workspacePath: project.path, initialTab: 'agent' });
    }, []);
    const handleOpenProjectFolder = useCallback(async (project: Project) => {
        try {
            await openPathExternal({ fullPath: project.path, workspace: null });
        } catch (err) {
            console.error('[Launcher] Failed to open project folder:', err);
            toastRef.current.error(t('toasts.openFolderFailed'));
        }
    }, [openPathExternal, t]);
    const handleCloseAgentOverlay = useCallback(() => setAgentOverlay(null), []);

    // SystemPromptsPanel "智能生成" → close the overlay and launch the workspace into
    // a Chat tab with `/init` as the initial message. Reuses the same Launcher-wide
    // provider/model/permission selection that the brand-section send uses.
    const handleRequestInitFromAgentOverlay = useCallback(() => {
        if (!agentOverlay) return;
        const project = projects.find(p => workspacePathsEqual(p.path, agentOverlay.workspacePath));
        if (!project) return;
        // Fallback path must respect global enablement — providers[0] can be the
        // first ordered provider which the user disabled in Settings → 启用和排序.
        const effectiveProvider = launcherProvider ?? providers.find(isProviderEnabled);
        if (!effectiveProvider) {
            toastRef.current.error(t('toasts.noProvider'));
            return;
        }
        setAgentOverlay(null);
        // PRD 0.2.3 + cross-review: same builtin/external split as handleBrandSend.
        const initModelForProvider = launcherSelectedModel ?? effectiveProvider.primaryModel;
        const providerExecutionIntent = !isExternalRuntime && initModelForProvider
            ? toProviderExecutionIntent(effectiveProvider, initModelForProvider)
            : undefined;
        const runtimeBackedProviderIdentity = providerExecutionIntent?.kind === 'runtime-backed-provider'
            ? providerExecutionIntent
            : undefined;
        const builtinSelection = !isExternalRuntime && !isRuntimeBackedProvider(effectiveProvider)
            ? pairBuiltinSelection(effectiveProvider, launcherSelectedModel)
            : undefined;
        const runtimeModel = isExternalRuntime ? launcherSelectedModel : runtimeBackedProviderIdentity?.model;
        const initialMessage: InitialMessage = {
            text: '/init',
            permissionMode: launcherPermissionMode,
            ...(builtinSelection ? { builtinSelection } : {}),
            ...(runtimeModel ? { runtimeModel } : {}),
            ...(runtimeBackedProviderIdentity ? { providerExecutionIdentity: runtimeBackedProviderIdentity } : {}),
        };
        onLaunchProject(
            project,
            undefined,
            initialMessage,
            { surface: 'agent_setup', entryIntent: 'workspace_init' },
        );
    }, [agentOverlay, projects, launcherProvider, providers, launcherPermissionMode, launcherSelectedModel, isExternalRuntime, onLaunchProject, t]);

    return (
        <div className="flex h-full flex-col overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
            {/* Path Input Dialog (browser dev mode) */}
            <PathInputDialog
                isOpen={pathDialogOpen}
                folderName={pendingFolderName}
                defaultPath={pendingDefaultPath}
                onConfirm={handlePathConfirm}
                onCancel={handlePathCancel}
            />

            {/* Logs Panel */}
            <UnifiedLogsPanel
                sseLogs={[]}
                isVisible={showLogs}
                onClose={() => setShowLogs(false)}
            />

            {/* Remove Workspace Confirm Dialog */}
            {projectToRemove && (
                <ConfirmDialog
                    title={isSystemPresetProject(projectToRemove) ? t('dialogs.hideDefaultWorkspace') : t('dialogs.removeWorkspace')}
                    message={isSystemPresetProject(projectToRemove)
                        ? t('dialogs.hideWorkspaceMessage', { name: projectToRemove.displayName || projectToRemove.name })
                        : t('dialogs.removeWorkspaceMessage', { name: projectToRemove.name })}
                    confirmText={isSystemPresetProject(projectToRemove) ? t('dialogs.hide') : t('dialogs.remove')}
                    confirmVariant="danger"
                    onConfirm={confirmRemoveProject}
                    onCancel={() => setProjectToRemove(null)}
                />
            )}

            {/* Main Content: Two-column layout */}
            <main className="launcher-layout flex-1 overflow-hidden">
                {/* Left: Brand Section */}
                <section className="launcher-brand relative flex items-center justify-center overflow-hidden">
                    <BrandSection
                        projects={visibleProjects}
                        selectedProject={selectedWorkspace}
                        defaultWorkspacePath={config.defaultWorkspacePath}
                        onSelectWorkspace={setSelectedWorkspace}
                        onAddFolder={handleAddProject}
                        onSetDefaultWorkspace={handleSetDefault}
                        onSend={handleBrandSend}
                        attachmentSessionId={attachmentSessionId}
                        isStarting={launchingProjectId === selectedWorkspace?.id && isStarting}
                        provider={launcherProvider}
                        providers={providers}
                        selectedModel={launcherSelectedModel}
                        onProviderChange={handleLauncherProviderChange}
                        onModelChange={handleLauncherModelChange}
                        reasoningEffort={launcherReasoningEffort}
                        onReasoningEffortChange={handleLauncherReasoningEffortChange}
                        permissionMode={launcherPermissionMode}
                        onPermissionModeChange={handleLauncherPermissionModeChange}
                        apiKeys={apiKeys}
                        providerVerifyStatus={providerVerifyStatus}
                        workspaceMcpEnabled={launcherWorkspaceMcpEnabled}
                        globalMcpEnabled={launcherGlobalMcpEnabled}
                        mcpServers={launcherMcpServers}
                        onWorkspaceMcpToggle={handleWorkspaceMcpToggle}
                        officialTools={OFFICIAL_TOOLS}
                        workspaceOfficialToolEnabled={launcherOfficialToolEnabled}
                        globalOfficialToolEnabled={launcherGlobalOfficialToolEnabled}
                        officialToolNeedsConfig={launcherOfficialToolNeedsConfig}
                        onWorkspaceOfficialToolToggle={handleLauncherOfficialToolToggle}
                        // PRD 0.2.17 — same plugin props as Chat. Source from
                        // AppConfig (Layer 1 visibility gate); Layer 2 is
                        // Launcher's transient selection (handed off to new
                        // Tab via InitialMessage.enabledPluginIds).
                        globallyVisiblePlugins={(config.plugins ?? [])
                            .filter(p => config.enabledPlugins?.[p.id] === true)
                            .map(p => ({ id: p.id, name: p.name, description: p.description }))}
                        workspaceEnabledPlugins={launcherEnabledPlugins}
                        onWorkspacePluginToggle={handleLauncherPluginToggle}
                        onRefreshProviders={refreshProviderData}
                        onGoToSettings={handleGoToSettings}
                        runtime={isExternalRuntime ? launcherRuntime : undefined}
                        runtimeModels={isExternalRuntime ? launcherRuntimeModels : undefined}
                        runtimePermissionModes={isExternalRuntime ? launcherRuntimePermissionModes : undefined}
                        /* PRD 0.2.7 Phase F: runtime selector lives below the input
                         * (LauncherInputContextRow) when the experimental gate is on. */
                        multiAgentRuntimeEnabled={multiAgentRuntimeEnabled}
                        runtimeDetections={runtimeDetections}
                        onRuntimeChange={handleLauncherRuntimeChange}
                        activeRuntime={launcherRuntime}
                        isActive={isActive}
                    />
                </section>

                <LauncherRightRail
                    projects={userVisibleProjects}
                    agentLookup={agentLookup}
                    isProjectsLoading={isLoading}
                    isStarting={isStarting}
                    launchingProjectId={launchingProjectId}
                    showDevTools={config.showDevTools}
                    taskCenterData={taskCenterData}
                    sessionNotificationBadgeCounts={sessionNotificationBadgeCounts}
                    onLaunch={handleLaunch}
                    onOpenTask={handleOpenTask}
                    onOpenOverlay={handleOpenOverlay}
                    onRemoveProject={handleRemoveProject}
                    onArchiveProject={handleArchiveProject}
                    onUnarchiveProject={handleUnarchiveProject}
                    onAgentSettings={handleAgentSettings}
                    onOpenProjectFolder={handleOpenProjectFolder}
                    onToggleProjectPin={handleToggleProjectPin}
                    onAddFolder={handleAddProject}
                    onCreateFromTemplate={handleOpenTemplateDialog}
                    workbenchCreateActions={workbenchCreateActions}
                    workbenchTypeLabels={workbenchTypeLabels}
                    onCreateWorkbench={setActiveWorkbenchCreatorId}
                    onShowLogs={handleShowLogs}
                />
            </main>

            {/* History Search Overlay */}
            {showOverlay && (
                <Suspense fallback={null}>
                    <HistorySearchOverlayContent
                        projects={visibleProjects}
                        onOpenSession={handleOverlayOpenTask}
                        onClose={handleCloseOverlay}
                        taskCenterData={taskCenterData}
                        initialMode={overlayMode}
                    />
                </Suspense>
            )}

            {/* Template Library Dialog */}
            {showTemplateDialog && (
                <TemplateLibraryDialog
                    onCreateWorkspace={handleCreateFromTemplate}
                    onClose={handleCloseTemplateDialog}
                />
            )}

            {ActiveProjectCreator && (
                <Suspense fallback={null}>
                    <ActiveProjectCreator
                        defaultParentPath={defaultWorkbenchParentPath}
                        onPickDirectory={handlePickWorkbenchParent}
                        onCreate={handleCreateWorkbenchProject}
                        onClose={() => setActiveWorkbenchCreatorId(null)}
                    />
                </Suspense>
            )}

            {/* Workspace Edit Dialog */}
            {editingProject && (
                <WorkspaceEditDialog
                    key={editingProject.id}
                    project={editingProject}
                    onSave={handleEditProject}
                    onClose={handleCloseEditDialog}
                />
            )}

            {/* Agent Config Overlay */}
            {agentOverlay && (
                <Suspense fallback={null}>
                    <WorkspaceConfigPanel
                        agentDir={agentOverlay.workspacePath}
                        onClose={handleCloseAgentOverlay}
                        initialTab={agentOverlay.initialTab}
                        onRequestInit={handleRequestInitFromAgentOverlay}
                    />
                </Suspense>
            )}
        </div>
    );
}
