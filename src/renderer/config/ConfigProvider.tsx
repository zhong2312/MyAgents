// ConfigProvider — single source of truth for app config state
// Dual Context pattern: data (changes often) vs actions (stable references)
import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
    type AppConfig,
    DEFAULT_CONFIG,
    type ModelEntity,
    type Project,
    type WorkspaceTemplateAgentDefaults,
    type WorkspaceTemplateSource,
    type ModelAliases,
    type Provider,
    type ProviderVerifyStatus,
    type ManagedCodexAuthState,
    type ManagedCodexRuntimeInstallState,
    type ProxySettings,
    PRESET_PROVIDERS,
    PROXY_DEFAULTS,
    MANAGED_CODEX_REQUIRED_RUNTIME,
    applyManagedCodexProviderReadiness,
    applyProviderEnablementAndOrder,
    getManagedCodexProviderReadiness,
    shouldAutoUpdateManagedCodexRuntime,
    withManagedCodexProviderCatalog,
} from './types';
import type { RuntimeModelInfo } from '../../shared/types/runtime';
import type { AgentConfig } from '../../shared/types/agent';
import { apiGetJson } from '@/api/apiFetch';
import {
    loadAppConfig,
    atomicModifyConfig,
    ensureBundledWorkspace,
    ensureManagedCodexProviderDevGateDefault,
    mergePresetCustomModels,
} from './services/appConfigService';
import {
    getAllProviders,
    loadApiKeys as loadApiKeysService,
    saveApiKey as saveApiKeyService,
    deleteApiKey as deleteApiKeyService,
    loadProviderVerifyStatus as loadProviderVerifyStatusService,
    saveProviderVerifyStatus as saveProviderVerifyStatusService,
    saveCustomProvider as saveCustomProviderService,
    deleteCustomProvider as deleteCustomProviderService,
    rebuildAndPersistAvailableProviders,
} from './services/providerService';
import {
    loadProjects,
    saveProjects,
    addProject as addProjectService,
    updateProject as updateProjectService,
    patchProject as patchProjectService,
    removeOrHideProject as removeOrHideProjectService,
    touchProject as touchProjectService,
} from './services/projectService';
import {
    addAgentConfig,
    buildAgentForProject,
    configureMemoryAutoUpdateTaskForAgent,
    configureMemoryEvolutionTasksForAgent,
    ensureAllProjectsHaveAgent,
    migrateImBotConfigsToAgents,
    persistAgents,
} from './services/agentConfigService';
import { isTauriEnvironment } from '@/utils/browserMock';
import { listenWithCleanup } from '@/utils/tauriListen';
import { workspacePathsEqual } from '../../shared/workspacePath';
import { normalizeUiLanguage, type SupportedLocale, type UiLanguage } from '../../shared/i18n';
import { removeProviderFromProxySettingsScope } from '../../shared/proxyScope';

interface ManagedCodexStatusResult {
    runtimeInstall: ManagedCodexRuntimeInstallState;
    auth: ManagedCodexAuthState;
}

// Main-window process scope: an App launch may make at most one background
// update attempt even if React remounts ConfigProvider. A real App relaunch
// reloads this module and re-arms the attempt. The in-flight request lives at
// the same scope so startup and Settings keep one download owner across remounts.
let managedCodexStartupUpdateEvaluated = false;
let managedCodexRuntimeUpdateRequest: Promise<ManagedCodexStatusResult> | null = null;

/**
 * Normalize agents loaded from disk: ensure every agent has a `channels` array.
 * External tools (e.g., AI bots editing config.json) may produce agents without
 * the `channels` field, which would crash downstream iteration.
 * Returns true if any agent was repaired (caller should persist).
 */
function normalizeAgents(config: AppConfig): boolean {
    if (!config.agents) return false;
    let repaired = false;
    for (const agent of config.agents) {
        if (!Array.isArray(agent.channels)) {
            agent.channels = [];
            repaired = true;
        }
    }
    return repaired;
}

/**
 * Migrate old hardcoded openclawEnabledToolGroups to the full set.
 * Before v0.1.56, ChannelWizard wrote a fixed subset ['doc','chat','wiki_drive','bitable']
 * which silently hid calendar/task/sheet/search/common/im tools.
 * Expand to all known groups so everything is enabled.
 */
const LEGACY_TOOL_GROUPS = new Set(['doc', 'chat', 'wiki_drive', 'bitable']);
// Exclude sensitive groups (im, perm) from auto-migration — keep them opt-in
const ALL_KNOWN_TOOL_GROUPS = ['doc', 'chat', 'wiki_drive', 'bitable', 'calendar', 'task', 'sheet', 'search', 'common'];
function migrateToolGroups(config: AppConfig): boolean {
    if (!config.agents) return false;
    let changed = false;
    for (const agent of config.agents) {
        for (const ch of (agent.channels ?? [])) {
            const groups = ch.openclawEnabledToolGroups;
            if (!groups || groups.length === 0) continue;
            // Only expand if it's the exact old default (user didn't customize)
            if (groups.length === LEGACY_TOOL_GROUPS.size && groups.every(g => LEGACY_TOOL_GROUPS.has(g))) {
                ch.openclawEnabledToolGroups = [...ALL_KNOWN_TOOL_GROUPS];
                changed = true;
            }
        }
    }
    if (changed) {
        console.log('[ConfigProvider] Migrated legacy openclawEnabledToolGroups → all groups enabled');
    }
    return changed;
}

async function reconcileMemoryEvolutionTasks(
    agents: readonly AgentConfig[] | undefined,
    projects: readonly Project[],
): Promise<void> {
    if (!isTauriEnvironment()) return;
    if (!agents?.length) return;

    for (const agent of agents) {
        if (!agent.memoryEvolution) continue;
        const project = projects.find(p =>
            p.agentId === agent.id || workspacePathsEqual(p.path, agent.workspacePath),
        );
        if (!project) continue;
        try {
            await configureMemoryEvolutionTasksForAgent(
                agent,
                project.id,
                agent.memoryEvolution.enabled,
            );
        } catch (err) {
            console.warn(
                `[ConfigProvider] Memory evolution task reconcile failed for agent ${agent.id}:`,
                err,
            );
        }
    }
}

async function reconcileMemoryAutoUpdateTasks(
    agents: readonly AgentConfig[] | undefined,
): Promise<void> {
    if (!isTauriEnvironment()) return;
    if (!agents?.length) return;

    for (const agent of agents) {
        if (!agent.memoryAutoUpdate) continue;
        try {
            await configureMemoryAutoUpdateTaskForAgent(agent);
        } catch (err) {
            console.warn(
                `[ConfigProvider] Memory auto-update task reconcile failed for agent ${agent.id}:`,
                err,
            );
        }
    }
}

// ============= Context Types =============

export interface ConfigDataValue {
    config: AppConfig;
    projects: Project[];
    providers: Provider[];
    apiKeys: Record<string, string>;
    providerVerifyStatus: Record<string, ProviderVerifyStatus>;
    isLoading: boolean;
    error: string | null;
    managedCodexRuntimeUpdateInFlight: boolean;
}

export interface ConfigActionsValue {
    updateConfig: (updates: Partial<AppConfig>) => Promise<void>;
    /** Merge-aware proxy update — see ConfigProvider for the lost-update rationale (#230). */
    patchProxySettings: (partial: Partial<ProxySettings>) => Promise<void>;
    refreshConfig: () => Promise<void>;
    reload: () => Promise<void>;
    refreshProviderData: () => Promise<void>;
    requestManagedCodexRuntimeUpdate: () => Promise<void>;
    // Projects
    addProject: (path: string, options?: AddProjectOptions) => Promise<Project>;
    updateProject: (project: Project) => Promise<void>;
    patchProject: (projectId: string, updates: Partial<Omit<Project, 'id'>>) => Promise<void>;
    removeProject: (projectId: string) => Promise<void>;
    touchProject: (projectId: string) => Promise<void>;
    // Providers
    addCustomProvider: (provider: Provider) => Promise<void>;
    updateCustomProvider: (provider: Provider) => Promise<void>;
    deleteCustomProvider: (providerId: string) => Promise<void>;
    refreshProviders: () => Promise<void>;
    // Preset custom models
    savePresetCustomModels: (providerId: string, models: ModelEntity[]) => Promise<void>;
    removePresetCustomModel: (providerId: string, modelId: string) => Promise<void>;
    // Provider primary model override
    savePrimaryModel: (providerId: string, modelId: string) => Promise<void>;
    // Provider model aliases (SDK sub-agent model mapping)
    saveProviderModelAliases: (providerId: string, aliases: ModelAliases) => Promise<void>;
    // API Keys
    saveApiKey: (providerId: string, apiKey: string) => Promise<void>;
    deleteApiKey: (providerId: string) => Promise<void>;
    // Verify status
    saveProviderVerifyStatus: (
        providerId: string,
        status: 'valid' | 'invalid',
        accountEmail?: string,
        metadata?: Pick<ProviderVerifyStatus, 'invalidReason' | 'error'>,
    ) => Promise<void>;
}

export interface AddProjectOptions {
    icon?: string;
    displayName?: string;
    templateId?: string;
    templateSource?: WorkspaceTemplateSource;
    agentDefaults?: WorkspaceTemplateAgentDefaults;
    workbenchId?: string;
    workbenchRoute?: string;
}

// ============= Contexts =============

export const ConfigDataContext = createContext<ConfigDataValue | null>(null);
export const ConfigActionsContext = createContext<ConfigActionsValue | null>(null);

// ============= Provider Component =============

export function ConfigProvider({ children }: { children: React.ReactNode }) {
    const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
    const [projects, setProjects] = useState<Project[]>([]);
    const [rawProviders, setRawProviders] = useState<Provider[]>(PRESET_PROVIDERS);
    const [managedCodexRuntimeModels, setManagedCodexRuntimeModels] = useState<RuntimeModelInfo[]>([]);
    const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
    const [providerVerifyStatus, setProviderVerifyStatus] = useState<Record<string, ProviderVerifyStatus>>({});
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [managedCodexRuntimeUpdateInFlight, setManagedCodexRuntimeUpdateInFlight] = useState(
        () => managedCodexRuntimeUpdateRequest !== null,
    );

    // Derived: merge preset custom models + apply user primary model overrides
    const providers = useMemo(() => {
        const catalog = withManagedCodexProviderCatalog(rawProviders, config, managedCodexRuntimeModels);
        const merged = mergePresetCustomModels(catalog, config.presetCustomModels, config.presetRemovedModels);
        const providerOrderSettings = {
            providerOrder: config.providerOrder,
            disabledProviderIds: config.disabledProviderIds,
        };
        const overrides = config.providerPrimaryModels;
        if (!overrides || Object.keys(overrides).length === 0) {
            return applyManagedCodexProviderReadiness(
                applyProviderEnablementAndOrder(merged, providerOrderSettings),
                config,
            );
        }
        // Apply user's primaryModel override directly on the Provider object
        // so ALL consumers see the correct value without needing getEffectivePrimaryModel()
        const withPrimaryOverrides = merged.map(p => {
            const userPrimary = overrides[p.id];
            if (!userPrimary || !p.models?.some(m => m.model === userPrimary)) return p;
            return { ...p, primaryModel: userPrimary };
        });
        return applyManagedCodexProviderReadiness(
            applyProviderEnablementAndOrder(withPrimaryOverrides, providerOrderSettings),
            config,
        );
    }, [
        config,
        rawProviders,
        managedCodexRuntimeModels,
    ]);
    const managedCodexReadiness = useMemo(
        () => getManagedCodexProviderReadiness(config),
        [config],
    );
    const managedCodexShouldAutoUpdate = shouldAutoUpdateManagedCodexRuntime(config);
    const managedCodexModelListKey = useMemo(
        () => [
            managedCodexReadiness.reason,
            config.managedCodexRuntimeInstall?.installedVersion ?? '',
            config.managedCodexRuntimeInstall?.requiredVersion ?? '',
            config.managedCodexAuth?.status ?? '',
            config.managedCodexAuth?.authMethod ?? '',
            config.managedCodexAuth?.verifiedAt ?? '',
        ].join('|'),
        [
            managedCodexReadiness.reason,
            config.managedCodexRuntimeInstall?.installedVersion,
            config.managedCodexRuntimeInstall?.requiredVersion,
            config.managedCodexAuth?.status,
            config.managedCodexAuth?.authMethod,
            config.managedCodexAuth?.verifiedAt,
        ],
    );

    // Mount guard
    const isMountedRef = useRef(true);
    const configRef = useRef<AppConfig>(DEFAULT_CONFIG);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);
    useEffect(() => {
        configRef.current = config;
    }, [config]);

    // ============= Load All Data =============

    const load = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            await ensureBundledWorkspace();
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const results = await Promise.allSettled([
                    invoke('cmd_sync_admin_agent'),
                    invoke('cmd_sync_cli'),
                    // System skills (task-alignment / task-implement) —
                    // independent version gate (SYSTEM_SKILLS_VERSION in
                    // commands.rs). Force-overwrites user copies so the
                    // skill contracts always match the shipped CLI.
                    invoke('cmd_sync_system_skills'),
                ]);
                for (const r of results) {
                    if (r.status === 'rejected') {
                        console.warn('[ConfigProvider] Sync failed:', r.reason);
                    }
                }
            } catch (e) {
                console.warn('[ConfigProvider] Agent/CLI/system-skills sync failed:', e);
            }

            try {
                await ensureManagedCodexProviderDevGateDefault();
            } catch (e) {
                console.warn('[ConfigProvider] Managed Codex provider default migration failed:', e);
            }

            const [rawConfig, loadedProjects, loadedProviders, loadedApiKeys, loadedVerifyStatus] = await Promise.all([
                loadAppConfig(),
                loadProjects(),
                getAllProviders(),
                loadApiKeysService(),
                loadProviderVerifyStatusService(),
            ]);

            // Migrate legacy imBotConfigs → agents (one-time, skipped if already migrated)
            const preMigrationAgentsCount = rawConfig.agents?.length ?? 0;
            const loadedConfig = migrateImBotConfigsToAgents(rawConfig, loadedProjects);
            if ((loadedConfig.agents?.length ?? 0) > preMigrationAgentsCount) {
                // Create timestamped backup before persisting migration
                try {
                    const { getConfigDir, CONFIG_FILE } = await import('./services/configStore');
                    const { copyFile, exists } = await import('@tauri-apps/plugin-fs');
                    const { join } = await import('@tauri-apps/api/path');
                    const dir = await getConfigDir();
                    const configPath = await join(dir, CONFIG_FILE);
                    if (await exists(configPath)) {
                        const ts = new Date().toISOString().replace(/[:.]/g, '-');
                        await copyFile(configPath, await join(dir, `config.json.bak.${ts}`));
                    }
                } catch (e) {
                    console.warn('[ConfigProvider] Migration backup failed:', e);
                }
                // Persist agents + project isAgent/agentId changes
                await persistAgents(loadedConfig.agents!);
                await saveProjects(loadedProjects);
            }

            const hiddenDefaultProject = loadedConfig.defaultWorkspacePath
                ? loadedProjects.find(p => p.hidden === true && workspacePathsEqual(p.path, loadedConfig.defaultWorkspacePath))
                : undefined;
            if (hiddenDefaultProject) {
                loadedConfig.defaultWorkspacePath = undefined;
                await atomicModifyConfig(c => (
                    workspacePathsEqual(c.defaultWorkspacePath, hiddenDefaultProject.path)
                        ? { ...c, defaultWorkspacePath: undefined }
                        : c
                ));
                console.log('[ConfigProvider] Cleared defaultWorkspacePath pointing at hidden workspace');
            }

            // One-time cleanup: remove imBotConfigs entries whose credentials
            // now exist in agents[].channels[] (post-migration duplicates)
            // Re-read from disk in case migration cleared in-memory but didn't persist imBotConfigs
            const diskImBotConfigs = (await loadAppConfig())?.imBotConfigs ?? loadedConfig.imBotConfigs ?? [];
            if (loadedConfig.agents?.length && diskImBotConfigs.length) {
                loadedConfig.imBotConfigs = diskImBotConfigs;
                // Collect all credential fingerprints from agent channels
                const agentCredentials = new Set<string>();
                for (const agent of loadedConfig.agents) {
                    for (const ch of (agent.channels ?? [])) {
                        if (ch.feishuAppId) agentCredentials.add(`feishu:${ch.feishuAppId}`);
                        if (ch.botToken) agentCredentials.add(`botToken:${ch.botToken}`);
                        if (ch.dingtalkClientId) agentCredentials.add(`dingtalk:${ch.dingtalkClientId}`);
                        if (ch.openclawPluginConfig?.appId) agentCredentials.add(`openclaw:${ch.openclawPluginConfig.appId}`);
                    }
                }

                const remaining = loadedConfig.imBotConfigs.filter(bot => {
                    if (bot.feishuAppId && agentCredentials.has(`feishu:${bot.feishuAppId}`)) return false;
                    if (bot.botToken && agentCredentials.has(`botToken:${bot.botToken}`)) return false;
                    if (bot.dingtalkClientId && agentCredentials.has(`dingtalk:${bot.dingtalkClientId}`)) return false;
                    if (bot.openclawPluginConfig?.appId && agentCredentials.has(`openclaw:${bot.openclawPluginConfig.appId}`)) return false;
                    return true;
                });

                const removedCount = loadedConfig.imBotConfigs.length - remaining.length;
                if (removedCount > 0) {
                    console.log(`[ConfigProvider] Cleaning up ${removedCount} legacy imBotConfigs entry(ies) already migrated to agents`);
                    loadedConfig.imBotConfigs = remaining;
                    await atomicModifyConfig(c => ({ ...c, imBotConfigs: remaining }));
                }
            }

            await rebuildAndPersistAvailableProviders();

            // Normalize agents and self-heal corrupted config on disk
            if (normalizeAgents(loadedConfig) && loadedConfig.agents) {
                await persistAgents(loadedConfig.agents);
                console.log('[ConfigProvider] Repaired agents with missing channels — persisted to disk');
            }

            // Migrate old hardcoded tool groups → undefined (= all groups enabled)
            if (migrateToolGroups(loadedConfig) && loadedConfig.agents) {
                await persistAgents(loadedConfig.agents);
            }

            // Ensure every project has a linked AgentConfig (basicAgent).
            // Runs after IM migration + normalize so all existing agents are already in place.
            const basicAgentResult = ensureAllProjectsHaveAgent(loadedConfig, loadedProjects, loadedConfig.defaultPermissionMode);
            if (basicAgentResult.changed) {
                await persistAgents(loadedConfig.agents!);
                await saveProjects(loadedProjects);
                console.log('[ConfigProvider] Created basicAgent(s) for projects without AgentConfig');
            }

            if (!isMountedRef.current) return;
            configRef.current = loadedConfig;
            setConfig(loadedConfig);
            setProjects(loadedProjects);
            setRawProviders(loadedProviders);
            setApiKeys(loadedApiKeys);
            setProviderVerifyStatus(loadedVerifyStatus);
            void reconcileMemoryAutoUpdateTasks(loadedConfig.agents);
            void reconcileMemoryEvolutionTasks(loadedConfig.agents, loadedProjects);
        } catch (err) {
            console.error('Failed to load config:', err);
            if (isMountedRef.current) {
                setError(err instanceof Error ? err.message : 'Failed to load configuration');
            }
        } finally {
            if (isMountedRef.current) {
                setIsLoading(false);
            }
        }
    }, []);

    // Initial load
    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        if (managedCodexReadiness.reason !== 'ready' && managedCodexReadiness.reason !== 'provider-disabled') {
            setManagedCodexRuntimeModels([]);
            return;
        }

        let cancelled = false;
        apiGetJson<{ models?: RuntimeModelInfo[] }>('/api/runtime/models?type=codex&source=managed-provider')
            .then((result) => {
                if (cancelled) return;
                setManagedCodexRuntimeModels(Array.isArray(result.models) ? result.models : []);
            })
            .catch((err) => {
                if (cancelled) return;
                console.warn('[managed-codex] failed to load provider model list', err);
                setManagedCodexRuntimeModels([]);
            });

        return () => { cancelled = true; };
    }, [
        managedCodexReadiness.reason,
        managedCodexModelListKey,
    ]);

    const syncNativeUiLanguageFromConfig = useCallback(async () => {
        if (!isTauriEnvironment()) return;
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('cmd_sync_ui_language_from_config');
        } catch (err) {
            console.warn('[ConfigProvider] Failed to sync native UI language:', err);
        }
    }, []);

    const refreshConfigFromDisk = useCallback(async (
        reason: string,
        options: { syncNativeUiLanguage: boolean },
    ) => {
        try {
            const previousUiLanguage = normalizeUiLanguage(configRef.current.uiLanguage);
            const [latest, latestProjects] = await Promise.all([
                loadAppConfig(),
                loadProjects(),
            ]);
            normalizeAgents(latest);
            const nextUiLanguage = normalizeUiLanguage(latest.uiLanguage);
            if (isMountedRef.current) {
                configRef.current = latest;
                setConfig(latest);
                setProjects(latestProjects);
            }
            if (options.syncNativeUiLanguage && previousUiLanguage !== nextUiLanguage) {
                await syncNativeUiLanguageFromConfig();
            }
        } catch (err) {
            console.error(`[ConfigProvider] Failed to refresh config after ${reason}:`, err);
        }
    }, [syncNativeUiLanguageFromConfig]);

    // ============= Listen for im:bot-config-changed =============

    useEffect(() => {
        if (!isTauriEnvironment()) return;
        const ac = new AbortController();

        const refreshOnConfigEvent = () => {
            if (!isMountedRef.current) return;
            void refreshConfigFromDisk('config-changed', { syncNativeUiLanguage: true });
        };
        const refreshOnUiLanguageEvent = () => {
            if (!isMountedRef.current) return;
            void refreshConfigFromDisk('ui-language-changed', { syncNativeUiLanguage: false });
        };

        void listenWithCleanup<{ botId: string }>('im:bot-config-changed', refreshOnConfigEvent, ac.signal);
        void listenWithCleanup('agent:config-changed', refreshOnConfigEvent, ac.signal);
        // PRD 0.2.35 — the Rust `cmd_set_force_wake_lock` command (called from
        // Settings.tsx OR triggered by the tray CheckMenuItem click) writes
        // disk and emits this event. We re-read disk so the React state
        // matches the durable truth. Without this, a tray-side toggle would
        // leave Settings.tsx stuck on its last-rendered value.
        void listenWithCleanup<boolean>('force-wake-lock-changed', refreshOnConfigEvent, ac.signal);
        void listenWithCleanup<{ uiLanguage: UiLanguage; locale: SupportedLocale }>('ui-language-changed', refreshOnUiLanguageEvent, ac.signal);

        return () => ac.abort();
    }, [refreshConfigFromDisk]);

    // ============= Listen for Admin CLI config changes (via SSE → window event) =============

    useEffect(() => {
        const handler = () => {
            if (!isMountedRef.current) return;
            void refreshConfigFromDisk('admin CLI change', { syncNativeUiLanguage: true });
        };
        window.addEventListener('myagents:config-changed', handler);
        return () => window.removeEventListener('myagents:config-changed', handler);
    }, [refreshConfigFromDisk]);

    // ============= Actions =============

    const updateConfig = useCallback(async (updates: Partial<AppConfig>) => {
        if ('uiLanguage' in updates) {
            const value = normalizeUiLanguage(updates.uiLanguage);
            const { uiLanguage: _, ...rest } = updates;
            if (isTauriEnvironment()) {
                try {
                    const { invoke } = await import('@tauri-apps/api/core');
                    await invoke('cmd_set_ui_language', { value });
                    setConfig(prev => ({ ...prev, uiLanguage: value }));
                } catch (err) {
                    console.error('[ConfigProvider] cmd_set_ui_language failed:', err);
                    throw err;
                }
                if (Object.keys(rest).length === 0) return;
                updates = rest;
            } else {
                updates = { ...rest, uiLanguage: value };
            }
        }
        // PRD 0.2.35 D2 — `forceWakeLock` has OS-level side effects (acquire /
        // drop an IOPMAssertion-class lock, sync the tray CheckMenuItem, emit
        // to all renderers). Going through atomicModifyConfig writes disk
        // *before* Rust toggles the OS lock, opening a window where the
        // disk truth and the live OS state disagree. The Rust command is the
        // single chokepoint that does all four mirrors atomically — route
        // through it for this field; let any other co-updated keys flow
        // through the default path so we don't lose them.
        if ('forceWakeLock' in updates) {
            const value = !!updates.forceWakeLock;
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke('cmd_set_force_wake_lock', { value });
                // Optimistic local mirror: snappy UI; the
                // `force-wake-lock-changed` listener will re-read disk and
                // arrive at the same value (no-op).
                setConfig(prev => ({ ...prev, forceWakeLock: value }));
            } catch (err) {
                console.error('[ConfigProvider] cmd_set_force_wake_lock failed:', err);
                throw err;
            }
            const { forceWakeLock: _, ...rest } = updates;
            if (Object.keys(rest).length === 0) return;
            updates = rest;
        }
        const newConfig = await atomicModifyConfig(c => ({ ...c, ...updates }));
        setConfig(newConfig);
        // No more CONFIG_CHANGED event — all consumers share this Context
    }, []);

    // #230: Merge-aware proxy patch. Callers pass only the field(s) they changed;
    // the merge happens against `c` (the disk-latest config) INSIDE the
    // atomicModifyConfig modifier, under withConfigLock. This is what prevents
    // lost updates when two proxy fields commit back-to-back from the same React
    // render — e.g. editing the host field then clicking the enable toggle in one
    // interaction: the host blur write lands on disk first, and the toggle's read
    // sees it, instead of both spreading a stale render-time `config.proxySettings`
    // base and the last writer clobbering the other's field. The base layering
    // (`enabled:false` → PROXY_DEFAULTS → c.proxySettings → partial) also yields a
    // complete ProxySettings even when proxySettings was previously undefined.
    const patchProxySettings = useCallback(async (partial: Partial<ProxySettings>) => {
        const newConfig = await atomicModifyConfig(c => ({
            ...c,
            proxySettings: {
                enabled: false,
                ...PROXY_DEFAULTS,
                ...c.proxySettings,
                ...partial,
            },
        }));
        setConfig(newConfig);
    }, []);

    const refreshConfig = useCallback(async () => {
        await refreshConfigFromDisk('manual refresh', { syncNativeUiLanguage: true });
    }, [refreshConfigFromDisk]);

    const applyManagedCodexStatus = useCallback((status: ManagedCodexStatusResult) => {
        if (!isMountedRef.current) return;
        setConfig(previous => {
            const next = {
                ...previous,
                managedCodexRuntimeInstall: status.runtimeInstall,
                managedCodexAuth: status.auth,
            };
            configRef.current = next;
            return next;
        });
    }, []);

    const observeManagedCodexRuntimeUpdate = useCallback(async (
        request: Promise<ManagedCodexStatusResult>,
    ): Promise<void> => {
        setManagedCodexRuntimeUpdateInFlight(true);
        try {
            applyManagedCodexStatus(await request);
        } finally {
            // Disk remains authoritative. The command result above keeps the
            // UI coherent even if this follow-up disk read fails.
            await refreshConfig();
            if (isMountedRef.current && managedCodexRuntimeUpdateRequest !== request) {
                setManagedCodexRuntimeUpdateInFlight(false);
            }
        }
    }, [applyManagedCodexStatus, refreshConfig]);

    const requestManagedCodexRuntimeUpdateInternal = useCallback((
        hydrateBeforeDownload: boolean,
    ): Promise<void> => {
        if (!isTauriEnvironment()) {
            return Promise.reject(new Error('Managed Codex runtime updates require the desktop app'));
        }
        let request = managedCodexRuntimeUpdateRequest;
        if (!request) {
            const started = (async (): Promise<ManagedCodexStatusResult> => {
                const { invoke } = await import('@tauri-apps/api/core');
                if (hydrateBeforeDownload) {
                    try {
                        await invoke('cmd_managed_codex_status');
                        await refreshConfig();
                    } catch (err) {
                        console.warn('[managed-codex] startup status refresh failed:', err);
                    }
                }
                return invoke<ManagedCodexStatusResult>('cmd_managed_codex_download');
            })();
            const tracked = started.finally(() => {
                if (managedCodexRuntimeUpdateRequest === tracked) {
                    managedCodexRuntimeUpdateRequest = null;
                }
            });
            managedCodexRuntimeUpdateRequest = tracked;
            request = tracked;
        }
        return observeManagedCodexRuntimeUpdate(request);
    }, [observeManagedCodexRuntimeUpdate, refreshConfig]);

    const requestManagedCodexRuntimeUpdate = useCallback(
        () => requestManagedCodexRuntimeUpdateInternal(false),
        [requestManagedCodexRuntimeUpdateInternal],
    );

    useEffect(() => {
        const activeRequest = managedCodexRuntimeUpdateRequest;
        if (!activeRequest) {
            // A process request may settle between this Provider's render-time
            // state initializer and passive-effect registration after remount.
            setManagedCodexRuntimeUpdateInFlight(false);
            return;
        }
        void observeManagedCodexRuntimeUpdate(activeRequest).catch(() => {});
    }, [observeManagedCodexRuntimeUpdate]);

    useEffect(() => {
        if (!isTauriEnvironment()) return;
        if (isLoading) return;
        if (error) return;
        if (managedCodexStartupUpdateEvaluated) return;
        // This is a startup decision, not a subscription to later config
        // changes. The shared request action below is the single in-process
        // update owner for both startup and Settings-triggered updates.
        managedCodexStartupUpdateEvaluated = true;
        if (!managedCodexShouldAutoUpdate) return;

        // One automatic attempt per App module lifetime. A failed download is
        // persisted as `error`; the next App launch retries, while this launch
        // never loops on config refreshes of the same failure state.
        void (async () => {
            try {
                console.info(
                    `[managed-codex] auto update start runtime=codex runtimeSource=managed-provider requiredVersion=${MANAGED_CODEX_REQUIRED_RUNTIME.version}`,
                );
                // Claim the process-scoped request before the first preflight
                // await so manual update/auth operations observe in-flight now.
                await requestManagedCodexRuntimeUpdateInternal(true);
            } catch (err) {
                console.warn(
                    `[managed-codex] auto update failed runtime=codex runtimeSource=managed-provider requiredVersion=${MANAGED_CODEX_REQUIRED_RUNTIME.version}`,
                    err,
                );
            }
        })();
    }, [
        error,
        isLoading,
        managedCodexShouldAutoUpdate,
        requestManagedCodexRuntimeUpdateInternal,
    ]);

    const refreshProviderData = useCallback(async () => {
        try {
            const [loadedApiKeys, loadedVerifyStatus] = await Promise.all([
                loadApiKeysService(),
                loadProviderVerifyStatusService(),
            ]);
            if (isMountedRef.current) {
                setApiKeys(loadedApiKeys);
                setProviderVerifyStatus(loadedVerifyStatus);
            }
        } catch (err) {
            console.error('[ConfigProvider] Failed to refresh provider data:', err);
        }
    }, []);

    const refreshProviders = useCallback(async () => {
        try {
            const loadedProviders = await getAllProviders();
            if (isMountedRef.current) setRawProviders(loadedProviders);
        } catch (err) {
            console.error('[ConfigProvider] Failed to refresh providers:', err);
        }
    }, []);

    // --- Projects ---

    const addProject = useCallback(async (path: string, options: AddProjectOptions = {}) => {
        let project = await addProjectService(path);

        const metadataPatch: Partial<Omit<Project, 'id'>> = {};
        if (options.icon) metadataPatch.icon = options.icon;
        if (options.displayName) metadataPatch.displayName = options.displayName;
        if (options.templateId) metadataPatch.templateId = options.templateId;
        if (options.templateSource) metadataPatch.templateSource = options.templateSource;
        if (options.workbenchId) metadataPatch.workbenchId = options.workbenchId;
        if (options.workbenchRoute) metadataPatch.workbenchRoute = options.workbenchRoute;
        if (project.hidden) {
            metadataPatch.hidden = false;
            metadataPatch.hiddenAt = undefined;
        }
        if (Object.keys(metadataPatch).length > 0) {
            const updated = await patchProjectService(project.id, metadataPatch);
            if (updated) project = updated;
        }

        // Auto-create basicAgent for new projects (or re-opened projects without agentId)
        if (!project.agentId) {
            const basicAgent = buildAgentForProject(project, {
                defaultPermissionMode: config.defaultPermissionMode,
                agentDefaults: options.agentDefaults,
            });
            await addAgentConfig(basicAgent);
            const updated = await patchProjectService(project.id, {
                agentId: basicAgent.id,
                ...(basicAgent.enabled ? { isAgent: true } : {}),
            });
            project = updated ?? { ...project, agentId: basicAgent.id, ...(basicAgent.enabled ? { isAgent: true } : {}) };
            if (basicAgent.memoryEvolution?.enabled) {
                try {
                    await configureMemoryEvolutionTasksForAgent(basicAgent, project.id, true);
                } catch (err) {
                    console.warn(
                        `[ConfigProvider] Memory evolution task provisioning failed for agent ${basicAgent.id}:`,
                        err,
                    );
                }
            }
            // Update config state so agent is immediately available
            setConfig(prev => ({ ...prev, agents: [...(prev.agents ?? []), basicAgent] }));
        }

        setProjects((prev) => {
            const filtered = prev.filter((p) => p.id !== project.id);
            return [project, ...filtered];
        });
        return project;
    }, [config.defaultPermissionMode]);

    const updateProject = useCallback(async (project: Project) => {
        await updateProjectService(project);
        setProjects((prev) => prev.map((p) => (p.id === project.id ? project : p)));
    }, []);

    const patchProject = useCallback(async (projectId: string, updates: Partial<Omit<Project, 'id'>>) => {
        const updated = await patchProjectService(projectId, updates);
        if (updated) {
            setProjects((prev) => prev.map((p) => (p.id === projectId ? updated : p)));
        }
    }, []);

    const removeProject = useCallback(async (projectId: string) => {
        const result = await removeOrHideProjectService(projectId);
        if (!result) return;

        if (result.action === 'hidden') {
            setProjects((prev) => prev.map((p) => (p.id === projectId ? result.project : p)));
        } else {
            setProjects((prev) => prev.filter((p) => p.id !== projectId));
        }

        const newConfig = await atomicModifyConfig(c => (
            workspacePathsEqual(c.defaultWorkspacePath, result.project.path)
                ? { ...c, defaultWorkspacePath: undefined }
                : c
        ));
        setConfig(newConfig);
    }, []);

    const touchProject = useCallback(async (projectId: string) => {
        const updated = await touchProjectService(projectId);
        if (updated) {
            setProjects((prev) => {
                const filtered = prev.filter((p) => p.id !== projectId);
                return [updated, ...filtered];
            });
        }
    }, []);

    // --- API Keys ---

    const saveApiKey = useCallback(async (providerId: string, apiKey: string) => {
        await saveApiKeyService(providerId, apiKey);
        setApiKeys((prev) => ({ ...prev, [providerId]: apiKey }));
        await rebuildAndPersistAvailableProviders();
    }, []);

    const deleteApiKey = useCallback(async (providerId: string) => {
        await deleteApiKeyService(providerId);
        setApiKeys((prev) => {
            const next = { ...prev };
            delete next[providerId];
            return next;
        });
        setProviderVerifyStatus((prev) => {
            const next = { ...prev };
            delete next[providerId];
            return next;
        });
        await rebuildAndPersistAvailableProviders();
    }, []);

    // --- Verify Status ---

    const saveProviderVerifyStatus = useCallback(async (
        providerId: string,
        status: 'valid' | 'invalid',
        accountEmail?: string,
        metadata?: Pick<ProviderVerifyStatus, 'invalidReason' | 'error'>,
    ) => {
        await saveProviderVerifyStatusService(providerId, status, accountEmail, metadata);
        setProviderVerifyStatus((prev) => ({
            ...prev,
            [providerId]: {
                status,
                verifiedAt: new Date().toISOString(),
                accountEmail,
                ...(metadata?.invalidReason ? { invalidReason: metadata.invalidReason } : {}),
                ...(metadata?.error ? { error: metadata.error } : {}),
            },
        }));
        // Rebuild availableProvidersJson so IM /provider command sees the updated status.
        // Without this, subscription verification changes don't propagate to the on-disk
        // cache until some other action (API key change, provider add) triggers a rebuild.
        await rebuildAndPersistAvailableProviders();
    }, []);

    // --- Custom Providers ---

    const addCustomProvider = useCallback(async (provider: Provider) => {
        await saveCustomProviderService(provider);
        await refreshProviders();
        await rebuildAndPersistAvailableProviders();
    }, [refreshProviders]);

    const updateCustomProvider = useCallback(async (provider: Provider) => {
        await saveCustomProviderService(provider);
        await refreshProviders();
        await rebuildAndPersistAvailableProviders();
    }, [refreshProviders]);

    const deleteCustomProvider = useCallback(async (providerId: string) => {
        await deleteCustomProviderService(providerId);
        await deleteApiKeyService(providerId);
        await refreshProviders();
        setApiKeys((prev) => {
            const next = { ...prev };
            delete next[providerId];
            return next;
        });
        setProviderVerifyStatus((prev) => {
            const next = { ...prev };
            delete next[providerId];
            return next;
        });
        // Scrub the deleted id from enablement/order arrays so they don't grow
        // unbounded across delete-and-re-add cycles (helpers strip unknown ids
        // at read time, but persisted disk state would otherwise accumulate).
        await atomicModifyConfig(c => {
            const providerOrder = c.providerOrder?.filter(id => id !== providerId);
            const disabledProviderIds = c.disabledProviderIds?.filter(id => id !== providerId);
            const proxySettings = removeProviderFromProxySettingsScope(c.proxySettings, providerId);
            return {
                ...c,
                providerOrder: providerOrder && providerOrder.length > 0 ? providerOrder : undefined,
                disabledProviderIds: disabledProviderIds && disabledProviderIds.length > 0 ? disabledProviderIds : undefined,
                ...(proxySettings ? { proxySettings } : {}),
            };
        });
        await rebuildAndPersistAvailableProviders();
    }, [refreshProviders]);

    // --- Preset Custom Models ---

    const savePresetCustomModels = useCallback(async (providerId: string, models: ModelEntity[]) => {
        const newConfig = await atomicModifyConfig(c => {
            const newPresetCustomModels = {
                ...c.presetCustomModels,
                [providerId]: models,
            };
            if (models.length === 0) {
                delete newPresetCustomModels[providerId];
            }
            return { ...c, presetCustomModels: newPresetCustomModels };
        });
        setConfig(newConfig);
        await rebuildAndPersistAvailableProviders();
    }, []);

    const removePresetCustomModel = useCallback(async (providerId: string, modelId: string) => {
        const newConfig = await atomicModifyConfig(c => {
            const currentModels = c.presetCustomModels?.[providerId] ?? [];
            const newModels = currentModels.filter(m => m.model !== modelId);
            const newPresetCustomModels = { ...c.presetCustomModels, [providerId]: newModels };
            if (newModels.length === 0) {
                delete newPresetCustomModels[providerId];
            }
            return { ...c, presetCustomModels: newPresetCustomModels };
        });
        setConfig(newConfig);
    }, []);

    const savePrimaryModel = useCallback(async (providerId: string, modelId: string) => {
        const newConfig = await atomicModifyConfig(c => ({
            ...c,
            providerPrimaryModels: { ...c.providerPrimaryModels, [providerId]: modelId },
        }));
        setConfig(newConfig);
        await rebuildAndPersistAvailableProviders();
    }, []);

    const saveProviderModelAliases = useCallback(async (providerId: string, aliases: ModelAliases) => {
        // Strip empty strings — prevent sending model: "" upstream
        const cleaned: ModelAliases = {};
        if (aliases.fable) cleaned.fable = aliases.fable;
        if (aliases.sonnet) cleaned.sonnet = aliases.sonnet;
        if (aliases.opus) cleaned.opus = aliases.opus;
        if (aliases.haiku) cleaned.haiku = aliases.haiku;
        const newConfig = await atomicModifyConfig(c => {
            const newAliases = { ...c.providerModelAliases, [providerId]: cleaned };
            return { ...c, providerModelAliases: newAliases };
        });
        setConfig(newConfig);
        await rebuildAndPersistAvailableProviders();
    }, []);

    // ============= Memoized Context Values =============

    const data = useMemo<ConfigDataValue>(() => ({
        config,
        projects,
        providers,
        apiKeys,
        providerVerifyStatus,
        isLoading,
        error,
        managedCodexRuntimeUpdateInFlight,
    }), [
        config,
        projects,
        providers,
        apiKeys,
        providerVerifyStatus,
        isLoading,
        error,
        managedCodexRuntimeUpdateInFlight,
    ]);

    const actions = useMemo<ConfigActionsValue>(() => ({
        updateConfig, patchProxySettings, refreshConfig, reload: load, refreshProviderData,
        addProject, updateProject, patchProject, removeProject, touchProject,
        addCustomProvider, updateCustomProvider, deleteCustomProvider, refreshProviders,
        savePresetCustomModels, removePresetCustomModel, savePrimaryModel, saveProviderModelAliases,
        saveApiKey, deleteApiKey,
        saveProviderVerifyStatus,
        requestManagedCodexRuntimeUpdate,
    }), [
        updateConfig, patchProxySettings, refreshConfig, load, refreshProviderData,
        addProject, updateProject, patchProject, removeProject, touchProject,
        addCustomProvider, updateCustomProvider, deleteCustomProvider, refreshProviders,
        savePresetCustomModels, removePresetCustomModel, savePrimaryModel, saveProviderModelAliases,
        saveApiKey, deleteApiKey,
        saveProviderVerifyStatus,
        requestManagedCodexRuntimeUpdate,
    ]);

    return (
        <ConfigActionsContext.Provider value={actions}>
            <ConfigDataContext.Provider value={data}>
                {children}
            </ConfigDataContext.Provider>
        </ConfigActionsContext.Provider>
    );
}
