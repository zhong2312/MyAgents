// WorkspaceBasicsSection — workspace name, icon, model, permission, MCP tools
// AI config (model/provider/permission/mcp) reads from AgentConfig (source of truth).
// Metadata (name/icon) writes to both Project and AgentConfig.

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { useConfig } from '@/hooks/useConfig';
import { useAvailableProviders } from '@/hooks/useAvailableProviders';
import { getAllMcpServers, getEnabledMcpServerIds } from '@/config/configService';
import { patchAgentConfig, patchAgentProjectConfig } from '@/config/services/agentConfigService';
import { isProviderAvailable } from '@/config/services/providerService';
import { CUSTOM_EVENTS } from '@/../shared/constants';
import { PERMISSION_MODES, type Project, type McpServerDefinition } from '@/config/types';
import type { AgentConfig } from '../../../shared/types/agent';
import { reasoningEffortChoices, REASONING_EFFORT_DESCRIPTIONS } from '@/../shared/reasoningEffort';
import { ALL_WORKSPACE_ICON_IDS, DEFAULT_WORKSPACE_ICON } from '@/assets/workspace-icons';
import WorkspaceIcon from '../launcher/WorkspaceIcon';
import RuntimeSelector from '../RuntimeSelector';
import { PermissionModeIcon, PermissionModeMenuContent, type PermissionModeMenuItem } from '../PermissionModeMenu';
import { Popover } from '../ui/Popover';
import type { RuntimeType, RuntimeDetections, RuntimeConfig } from '../../../shared/types/runtime';
import { buildRuntimeChangePatch } from '../../../shared/types/runtime';
import { agentDefaultsForRuntimeBackedProvider, agentUsesManagedCodexProvider, toProviderExecutionIntent } from '../../../shared/providerExecution';
import { invoke } from '@tauri-apps/api/core';
import { useToast } from '@/components/Toast';

interface WorkspaceBasicsSectionProps {
  project: Project | undefined;
  agent: AgentConfig | undefined;
  agentDir: string;
}

function permissionText(mode: string | null | undefined, t: TFunction<'settings'>): PermissionModeMenuItem {
  const value = mode === 'fullAgency' || mode === 'auto' || mode === 'plan' ? mode : 'plan';
  const icon = PERMISSION_MODES.find(item => item.value === value)?.icon;
  return {
    value,
    icon,
    label: t(`agentSettings.permission.${value}`),
    description: t(`agentSettings.permission.${value}Description`),
  };
}

export default function WorkspaceBasicsSection({ project, agent, agentDir }: WorkspaceBasicsSectionProps) {
  const { t } = useTranslation('settings');
  const { t: tChat } = useTranslation('chat');
  const { config, providers, apiKeys, providerVerifyStatus, patchProject, refreshConfig } = useConfig();
  // Only credentialed providers — the picker must not expose a provider
  // the user can't actually use, and must match the Chat model switcher's
  // "available" set (see useAvailableProviders for rationale).
  const availableProviders = useAvailableProviders();
  const toast = useToast();
  // Derive canonical name from project — use as initializer key to reset input
  const canonicalName = useMemo(
    () => project?.displayName || project?.name || '',
    [project?.displayName, project?.name],
  );
  const [name, setName] = useState(canonicalName);
  const [openPopup, setOpenPopup] = useState<'icon' | 'model' | 'effort' | 'permission' | 'mcp' | 'plugins' | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerDefinition[]>([]);
  const [globalEnabledMcp, setGlobalEnabledMcp] = useState<string[]>([]);
  const isMountedRef = useRef(true);
  const permissionButtonRef = useRef<HTMLButtonElement>(null);

  // Runtime detection (v0.1.59)
  const [runtimeDetections, setRuntimeDetections] = useState<RuntimeDetections>({
    'builtin': { installed: true },
    'claude-code': { installed: false },
    'codex': { installed: false },
    'gemini': { installed: false },
  });
  // When multiAgentRuntime is off, treat as builtin regardless of agent config (方案 C)
  const agentRuntimeConfig = agent?.runtimeConfig as RuntimeConfig | undefined;
  const usesManagedCodexProvider = agentUsesManagedCodexProvider(agent);
  const currentRuntime: RuntimeType = usesManagedCodexProvider
    ? 'builtin'
    : config.multiAgentRuntime
    ? ((agent?.runtime as RuntimeType) || 'builtin')
    : 'builtin';

  // Sync name when canonical name changes externally
  useEffect(() => {
    setName(canonicalName);
  }, [canonicalName]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Detect installed runtimes (v0.1.59)
  useEffect(() => {
    void (async () => {
      try {
        const detections = await invoke<Record<string, { installed: boolean; version?: string; path?: string }>>('cmd_detect_runtimes');
        if (isMountedRef.current) {
          setRuntimeDetections(detections as RuntimeDetections);
        }
      } catch (err) {
        console.warn('[runtime] Failed to detect runtimes:', err);
      }
    })();
  }, []);

  const handleRuntimeChange = useCallback(async (runtime: RuntimeType) => {
    if (!agent) return;
    try {
      // buildRuntimeChangePatch scrubs cross-runtime non-portable fields
      // (model / permissionMode / additionalArgs) — see its doc in
      // shared/types/runtime.ts. Keep all 4 runtime-change callsites
      // funneling through this single helper.
      await patchAgentConfig(agent.id, buildRuntimeChangePatch(agent.runtimeConfig, runtime));
      refreshConfig();
      const label = runtime === 'claude-code' ? 'Claude Code'
        : runtime === 'codex' ? 'Codex'
        : runtime === 'gemini' ? 'Gemini CLI'
        : 'MyAgents';
      toast.success(t('agentSettings.basics.runtimeChanged', { label }));
    } catch (err) {
      console.error('[runtime] Failed to save runtime:', err);
    }
  }, [agent, refreshConfig, t, toast]);

  // Load globally available MCP servers
  useEffect(() => {
    void (async () => {
      const [servers, enabled] = await Promise.all([
        getAllMcpServers(),
        getEnabledMcpServerIds(),
      ]);
      if (isMountedRef.current) {
        setMcpServers(servers);
        setGlobalEnabledMcp(enabled);
      }
    })();
  }, []);

  const availableMcpServers = mcpServers.filter(s => globalEnabledMcp.includes(s.id));

  // Save workspace metadata (name, icon) to Project + AgentConfig
  const saveProjectMeta = useCallback(async (updates: Partial<Pick<Project, 'displayName' | 'icon'>>) => {
    if (!project) return;
    const agentPatch: Partial<Omit<AgentConfig, 'id'>> = {};
    if (updates.displayName !== undefined) agentPatch.name = updates.displayName || project.name;
    if (updates.icon !== undefined) agentPatch.icon = updates.icon;
    if (agent && Object.keys(agentPatch).length > 0) {
      await patchAgentProjectConfig(agent.id, agentPatch, project.id, updates);
    } else {
      await patchProject(project.id, updates);
    }
    await refreshConfig();
  }, [project, agent, patchProject, refreshConfig]);

  // Save AI config (model, provider, permission, mcp, plugins).
  // AgentConfig is the single source of truth when available; fallback to Project for non-agent workspaces.
  const saveAgentConfig = useCallback(async (updates: Partial<Omit<AgentConfig, 'id'>>) => {
    const projectSync: Partial<Omit<Project, 'id'>> = {};
    if (updates.providerId !== undefined) projectSync.providerId = updates.providerId;
    if (updates.model !== undefined) projectSync.model = updates.model;
    if (updates.permissionMode !== undefined) {
      projectSync.permissionMode = updates.permissionMode as Project['permissionMode'];
    }
    if (updates.mcpEnabledServers !== undefined) projectSync.mcpEnabledServers = updates.mcpEnabledServers;
    if (updates.enabledPluginIds !== undefined) projectSync.enabledPluginIds = updates.enabledPluginIds;
    if (agent && project && Object.keys(projectSync).length > 0) {
      await patchAgentProjectConfig(agent.id, updates, project.id, projectSync);
    } else {
      if (agent) await patchAgentConfig(agent.id, updates);
      if (project && Object.keys(projectSync).length > 0) await patchProject(project.id, projectSync);
    }
    await refreshConfig();
  }, [agent, project, patchProject, refreshConfig]);

  const handleNameBlur = useCallback(() => {
    const trimmed = name.trim();
    const currentName = project?.displayName || project?.name || '';
    if (trimmed && trimmed !== currentName) {
      void saveProjectMeta({ displayName: trimmed });
    }
  }, [name, project, saveProjectMeta]);

  const handleIconSelect = useCallback((iconId: string) => {
    void saveProjectMeta({ icon: iconId || undefined });
    setOpenPopup(null);
  }, [saveProjectMeta]);

  const handleModelSelect = useCallback((providerId: string, model: string) => {
    const provider = availableProviders.find(p => p.id === providerId) ?? providers.find(p => p.id === providerId);
    if (!provider) return;
    const intent = toProviderExecutionIntent(provider, model);
    if (intent.kind === 'runtime-backed-provider') {
      void saveAgentConfig(agentDefaultsForRuntimeBackedProvider(
        intent,
        agent?.runtimeConfig as RuntimeConfig | undefined,
      ));
    } else {
      void saveAgentConfig({
        providerId,
        model,
        ...(usesManagedCodexProvider
          ? buildRuntimeChangePatch(agent?.runtimeConfig as RuntimeConfig | undefined, 'builtin')
          : {}),
      });
    }
    setOpenPopup(null);
  }, [agent?.runtimeConfig, usesManagedCodexProvider, availableProviders, providers, saveAgentConfig]);

  const handlePermissionSelect = useCallback((mode: string) => {
    const provider = usesManagedCodexProvider
      ? (availableProviders.find(p => p.id === agent?.providerId) ?? providers.find(p => p.id === agent?.providerId))
      : undefined;
    const intent = provider && agent?.model
      ? toProviderExecutionIntent(provider, agent.model)
      : undefined;
    void saveAgentConfig(intent?.kind === 'runtime-backed-provider'
      ? agentDefaultsForRuntimeBackedProvider(intent, agentRuntimeConfig, { permissionMode: mode })
      : { permissionMode: mode });
    setOpenPopup(null);
  }, [agent?.model, agent?.providerId, agentRuntimeConfig, availableProviders, providers, saveAgentConfig, usesManagedCodexProvider]);

  // #324 — agent-level 推理强度 default ('default' | level). Builtin only here
  // (external runtimes configure it via the chat toolbar → runtimeConfig).
  const handleEffortSelect = useCallback((effort: string) => {
    void saveAgentConfig({ reasoningEffort: effort });
    setOpenPopup(null);
  }, [saveAgentConfig]);

  const handleMcpToggle = useCallback((serverId: string) => {
    const current = agent?.mcpEnabledServers || [];
    const newEnabled = current.includes(serverId)
      ? current.filter(id => id !== serverId)
      : [...current, serverId];
    void saveAgentConfig({ mcpEnabledServers: newEnabled });
  }, [agent?.mcpEnabledServers, saveAgentConfig]);

  // PRD 0.2.17 — Claude plugin enable list. Same two-layer model as MCP:
  // candidate pool = AppConfig.plugins ∩ enabledPlugins (Layer 1 visibility
  // gate from Settings); per-Agent enable list is the subset chosen here.
  const visiblePlugins = useMemo(
    () => (config.plugins ?? []).filter(p => config.enabledPlugins?.[p.id] === true),
    [config.plugins, config.enabledPlugins],
  );
  const effectiveEnabledPlugins = agent?.enabledPluginIds ?? project?.enabledPluginIds;
  const enabledPluginNames = visiblePlugins
    .filter(p => effectiveEnabledPlugins?.includes(p.id))
    .map(p => p.name);
  const pluginSummary = enabledPluginNames.length === 0
    ? t('agentSettings.basics.noPluginsSummary')
    : enabledPluginNames.length <= 2
      ? enabledPluginNames.join(' / ')
      : `${enabledPluginNames.slice(0, 2).join(' / ')} +${enabledPluginNames.length - 2}`;

  const handlePluginToggle = useCallback((pluginId: string) => {
    const current = agent?.enabledPluginIds ?? project?.enabledPluginIds ?? [];
    const newEnabled = current.includes(pluginId)
      ? current.filter(id => id !== pluginId)
      : [...current, pluginId];
    void saveAgentConfig({ enabledPluginIds: newEnabled });
  }, [agent?.enabledPluginIds, project?.enabledPluginIds, saveAgentConfig]);

  // Derived display values — read from AgentConfig (source of truth), fallback to Project.
  //
  // The summary label shows the PERSISTED provider, not an availability-
  // resolved fallback: if a saved providerId no longer has credentials
  // (e.g. user removed the API key), we still display that name so the
  // closed button matches what's on disk. The picker popup below surfaces
  // only available providers — so the user can see "oh, this is stale"
  // and pick something valid — and we annotate the summary with a small
  // "⚠ 暂不可用" hint when the saved provider fails `isProviderAvailable`.
  // This is cheaper than an automatic rewrite and keeps persistence as
  // the single source of truth for what was actually saved.
  const effectiveProviderId = agent?.providerId ?? project?.providerId;
  const effectiveModel = agent?.model ?? project?.model;
  const selectedProvider = providers.find(p => p.id === effectiveProviderId);
  const isSelectedProviderAvailable = selectedProvider
    ? isProviderAvailable(selectedProvider, apiKeys, providerVerifyStatus)
    : true;
  const modelName = effectiveModel
    ? (selectedProvider?.models?.find(m => m.model === effectiveModel)?.modelName || effectiveModel)
    : (selectedProvider?.primaryModel || t('agentSettings.basics.notSet'));
  const providerName = selectedProvider?.name || t('agentSettings.basics.defaultProvider');

  const openProviderSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
      detail: { section: 'providers' },
    }));
    setOpenPopup(null);
  }, []);

  const effectivePermissionMode = agent?.permissionMode ?? project?.permissionMode;
  const permissionMode = permissionText(effectivePermissionMode, t);

  // #324 — agent-level 推理强度 default (builtin; no project fallback — the
  // agent is the only storage for this field).
  const effectiveReasoningEffort = agent?.reasoningEffort ?? 'default';
  const effectiveReasoningEffortChoices = reasoningEffortChoices(
    'builtin',
    selectedProvider?.apiProtocol,
    selectedProvider?.id,
    effectiveModel ?? undefined,
  );

  const effectiveMcpServers = agent?.mcpEnabledServers ?? project?.mcpEnabledServers;
  const enabledMcpNames = availableMcpServers
    .filter(s => effectiveMcpServers?.includes(s.id))
    .map(s => s.name);
  const mcpSummary = enabledMcpNames.length === 0
    ? t('agentSettings.basics.noToolsSummary')
    : enabledMcpNames.length <= 2
      ? enabledMcpNames.join(' / ')
      : `${enabledMcpNames.slice(0, 2).join(' / ')} +${enabledMcpNames.length - 2}`;

  if (!project) {
    return <p className="text-sm text-[var(--ink-subtle)]">{t('agentSettings.general.missingWorkspace')}</p>;
  }

  return (
    <div className="space-y-3">
      {/* Name + Icon — single row: [label] [icon] [input] */}
      <div className="relative flex items-center gap-3">
        <label className="w-16 shrink-0 text-sm text-[var(--ink-muted)]">{t('agentSettings.basics.name')}</label>
        <button
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors ${
            openPopup === 'icon'
              ? 'border-[var(--accent)] bg-[var(--accent-warm-muted)]'
              : 'border-[var(--line)] hover:border-[var(--line-strong)]'
          }`}
          onClick={() => setOpenPopup(openPopup === 'icon' ? null : 'icon')}
          title={t('agentSettings.basics.chooseIcon')}
        >
          <WorkspaceIcon icon={project.icon || DEFAULT_WORKSPACE_ICON} size={22} />
        </button>
        <input
          className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent)] focus:outline-none"
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={handleNameBlur}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          placeholder={t('agentSettings.basics.workspaceNamePlaceholder')}
        />

        {openPopup === 'icon' && (
          <>
            <div className="fixed inset-0 z-40" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpenPopup(null); }} />
            <div className="absolute left-20 top-10 z-50 max-h-[260px] w-[320px] overflow-y-auto overscroll-contain rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-2 shadow-lg">
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => handleIconSelect('')}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
                    !project.icon ? 'bg-[var(--accent-warm-muted)] ring-1 ring-[var(--accent-warm)]' : 'hover:bg-[var(--hover-bg)]'
                  }`}
                  title={t('agentSettings.basics.defaultIcon')}
                >
                  <WorkspaceIcon icon={DEFAULT_WORKSPACE_ICON} size={20} />
                </button>
                {ALL_WORKSPACE_ICON_IDS
                  .filter(id => id !== 'folder-open' && id !== DEFAULT_WORKSPACE_ICON)
                  .map(iconId => (
                    <button
                      key={iconId}
                      type="button"
                      onClick={() => handleIconSelect(iconId)}
                      className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
                        project.icon === iconId
                          ? 'bg-[var(--accent-warm-muted)] ring-1 ring-[var(--accent-warm)]'
                          : 'hover:bg-[var(--hover-bg)]'
                      }`}
                      title={iconId}
                    >
                      <WorkspaceIcon icon={iconId} size={20} />
                    </button>
                  ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Workspace path — read-only */}
      <div className="flex items-center gap-3">
        <label className="w-16 shrink-0 text-sm text-[var(--ink-muted)]">{t('agentSettings.basics.workspace')}</label>
        <span className="flex-1 truncate rounded-lg px-3 py-1.5 text-sm text-[var(--ink-subtle)]" title={agentDir}>
          {agentDir}
        </span>
      </div>

      {/* Runtime (v0.1.59) — only visible when multi-agent runtime is enabled in developer settings */}
      {config.multiAgentRuntime && (
        <>
          <div className="flex items-center gap-3">
            <label className="w-16 shrink-0 text-sm text-[var(--ink-muted)]">{t('agentSettings.basics.runtime')}</label>
            <div className="flex-1">
              <RuntimeSelector
                value={currentRuntime}
                detections={runtimeDetections}
                onChange={handleRuntimeChange}
                variant="panel"
              />
            </div>
          </div>

          {/* External runtime notice */}
          {currentRuntime !== 'builtin' && (() => {
            const runtimeLabel = currentRuntime === 'claude-code' ? 'Claude Code'
              : currentRuntime === 'codex' ? 'Codex'
              : currentRuntime === 'gemini' ? 'Gemini CLI'
              : currentRuntime;
            return (
              <p className="rounded-lg bg-[var(--accent-warm-subtle)] px-3.5 py-2.5 text-xs leading-relaxed text-[var(--ink-muted)]">
                {t('agentSettings.basics.externalRuntimeNotice', { runtime: runtimeLabel })}
              </p>
            );
          })()}

          {/* Issue #194 — proxy policy for external runtime subprocess.
              Only relevant when the agent runs an external CLI (Codex / CC /
              Gemini), so hidden for builtin. */}
          {currentRuntime !== 'builtin' && agent && (() => {
            // Read current policy; default to 'myagents' for backwards compat.
            // runtimeConfig is on AgentConfig as a free-form record — keep the
            // narrow `as` cast so we don't expand its public schema unnecessarily.
            // Legacy disk values (the removed `'direct'` from 0.2.16 dev) fall
            // through the literal narrowing and read as default `'myagents'`,
            // matching the server-side `resolveAgentEnvPolicy` validator.
            const rc = (agent.runtimeConfig as Record<string, unknown> | undefined) ?? {};
            const rawPolicy = (rc.envPolicy as { proxy?: unknown } | undefined)?.proxy;
            const proxyMode: 'myagents' | 'terminal' =
              rawPolicy === 'terminal' ? 'terminal' : 'myagents';

            const onSelect = (next: 'myagents' | 'terminal') => {
              const prevEnvPolicy = (rc.envPolicy as Record<string, unknown> | undefined) ?? {};
              const nextRc = {
                ...rc,
                envPolicy: { ...prevEnvPolicy, proxy: next },
              };
              void patchAgentConfig(agent.id, { runtimeConfig: nextRc } as Partial<Omit<AgentConfig, 'id'>>);
            };

            const radio = (
              value: 'myagents' | 'terminal',
              label: string,
              hint: string,
            ) => (
              <label
                key={value}
                className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed transition-colors ${
                  proxyMode === value
                    ? 'border-[var(--accent-warm)] bg-[var(--accent-warm-subtle)]'
                    : 'border-[var(--line)] hover:border-[var(--line-strong)]'
                }`}
              >
                <input
                  type="radio"
                  name={`proxy-policy-${agent.id}`}
                  value={value}
                  checked={proxyMode === value}
                  onChange={() => onSelect(value)}
                  className="mt-0.5 shrink-0"
                />
                <div className="min-w-0">
                  <div className="font-medium text-[var(--ink)]">{label}</div>
                  <div className="text-[var(--ink-muted)]">{hint}</div>
                </div>
              </label>
            );

            return (
              <div className="flex items-start gap-3">
                <label className="w-16 shrink-0 pt-2 text-sm text-[var(--ink-muted)]">{t('agentSettings.basics.networkProxy')}</label>
                <div className="flex-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {radio('myagents', t('agentSettings.basics.proxyMyAgents'), t('agentSettings.basics.proxyMyAgentsHint'))}
                  {radio('terminal', t('agentSettings.basics.proxyTerminal'), t('agentSettings.basics.proxyTerminalHint'))}
                </div>
              </div>
            );
          })()}
        </>
      )}

      {/* Model — hidden when external runtime (they manage their own models) */}
      {currentRuntime === 'builtin' && (
      <div className="relative flex items-center gap-3">
        <label className="w-16 shrink-0 text-sm text-[var(--ink-muted)]">{t('agentSettings.basics.model')}</label>
        <button
          className="flex flex-1 items-center justify-between rounded-lg border border-[var(--line)] px-3 py-1.5 text-left text-sm text-[var(--ink)] transition-colors hover:border-[var(--line-strong)]"
          onClick={() => setOpenPopup(openPopup === 'model' ? null : 'model')}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{providerName} / {modelName}</span>
            {!isSelectedProviderAvailable && selectedProvider && (
              // Saved provider lost credentials — warn the user inline so
              // they don't hit a runtime error when a message fires.
              <span
                className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-[var(--warning)]"
                title={t('agentSettings.basics.providerUnavailableTitle')}
              >
                ⚠ {t('agentSettings.basics.unavailable')}
              </span>
            )}
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        </button>

        {openPopup === 'model' && (
          <>
            <div className="fixed inset-0 z-40" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpenPopup(null); }} />
            <div className="absolute left-20 top-0 z-50 max-h-[300px] w-[320px] overflow-y-auto overscroll-contain rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-2 shadow-lg">
              {availableProviders.length === 0 ? (
                <div className="px-3 py-3">
                  <p className="mb-2 text-xs leading-relaxed text-[var(--ink-muted)]">
                    {t('agentSettings.basics.noProviders')}
                  </p>
                  <button
                    type="button"
                    onClick={openProviderSettings}
                    className="text-xs font-medium text-[var(--accent-warm)] hover:underline"
                  >
                    {t('agentSettings.basics.openProviderSettings')}
                  </button>
                </div>
              ) : (
                availableProviders.map(provider => (
                  <div key={provider.id} className="mb-1">
                    <div className="px-2 py-1 text-xs font-medium text-[var(--ink-muted)]">{provider.name}</div>
                    {provider.models?.map(model => (
                      <button
                        key={`${provider.id}:${model.model}`}
                        className={`flex w-full items-center rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
                          effectiveProviderId === provider.id && effectiveModel === model.model
                            ? 'bg-[var(--accent-warm-muted)] text-[var(--accent-warm)]'
                            : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
                        }`}
                        onClick={() => handleModelSelect(provider.id, model.model)}
                      >
                        {model.modelName}
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
      )}

      {/* Permission — hidden when external runtime */}
      {currentRuntime === 'builtin' && (
      <div className="relative flex items-center gap-3">
        <label className="w-16 shrink-0 text-sm text-[var(--ink-muted)]">{t('agentSettings.basics.permission')}</label>
        <button
          ref={permissionButtonRef}
          className="flex flex-1 items-center justify-between rounded-lg border border-[var(--line)] px-3 py-1.5 text-left text-sm text-[var(--ink)] transition-colors hover:border-[var(--line-strong)]"
          onClick={() => setOpenPopup(openPopup === 'permission' ? null : 'permission')}
        >
          <span className="flex items-center gap-1.5">
            <PermissionModeIcon
              value={permissionMode.value}
              fallback={permissionMode.icon}
              className="h-4 w-4 shrink-0"
            />
            {permissionMode.label}
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        </button>

        <Popover
          open={openPopup === 'permission'}
          onClose={() => setOpenPopup(null)}
          anchorRef={permissionButtonRef}
          placement="bottom-start"
          className="composer-toolbar-menu-enter w-72 py-1"
        >
          <PermissionModeMenuContent
            items={PERMISSION_MODES.map(mode => permissionText(mode.value, t))}
            selectedValue={permissionMode.value}
            header={tChat('input.permissionModeHeader')}
            onSelect={handlePermissionSelect}
          />
        </Popover>
      </div>
      )}

      {/* #324 推理强度 — hidden when external runtime (configured via chat toolbar there) */}
      {currentRuntime === 'builtin' && effectiveReasoningEffortChoices !== null && (
      <div className="relative flex items-center gap-3">
        <label className="w-16 shrink-0 text-sm text-[var(--ink-muted)]">{t('agentSettings.basics.reasoningEffort')}</label>
        <button
          className="flex flex-1 items-center justify-between rounded-lg border border-[var(--line)] px-3 py-1.5 text-left text-sm text-[var(--ink)] transition-colors hover:border-[var(--line-strong)]"
          onClick={() => setOpenPopup(openPopup === 'effort' ? null : 'effort')}
        >
          <span>{effectiveReasoningEffort === 'default' ? t('agentSettings.basics.defaultValue') : effectiveReasoningEffort}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        </button>

        {openPopup === 'effort' && (
          <>
            <div className="fixed inset-0 z-40" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpenPopup(null); }} />
            <div className="absolute left-20 top-0 z-50 w-[280px] rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-2 shadow-lg">
              {['default', ...(effectiveReasoningEffortChoices ?? [])].map(level => (
                <button
                  key={level}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition-colors ${
                    effectiveReasoningEffort === level
                      ? 'bg-[var(--accent-warm-muted)] text-[var(--accent-warm)]'
                      : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
                  }`}
                  onClick={() => handleEffortSelect(level)}
                >
                  <span className="text-sm font-medium">{level === 'default' ? t('agentSettings.basics.defaultValue') : level}</span>
                  <span className="text-xs text-[var(--ink-muted)]">
                    {t(`agentSettings.reasoning.descriptions.${level}`, {
                      defaultValue: REASONING_EFFORT_DESCRIPTIONS[level] ?? '',
                    })}
                  </span>
                </button>
              ))}
              <div className="mt-1 whitespace-nowrap border-t border-[var(--line)] px-3 pb-1 pt-2 text-xs text-[var(--ink-muted)]/60">
                {t('agentSettings.basics.reasoningSupportHint')}
              </div>
            </div>
          </>
        )}
      </div>
      )}

      {/* MCP Tools — hidden when external runtime */}
      {currentRuntime === 'builtin' && (
      <div className="relative flex items-center gap-3">
        <label className="w-16 shrink-0 text-sm text-[var(--ink-muted)]">{t('agentSettings.basics.tools')}</label>
        <button
          className="flex flex-1 items-center justify-between rounded-lg border border-[var(--line)] px-3 py-1.5 text-left text-sm text-[var(--ink)] transition-colors hover:border-[var(--line-strong)]"
          onClick={() => setOpenPopup(openPopup === 'mcp' ? null : 'mcp')}
        >
          <span className="truncate">{mcpSummary}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        </button>

        {openPopup === 'mcp' && (
          <>
            <div className="fixed inset-0 z-40" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpenPopup(null); }} />
            <div className="absolute left-20 top-0 z-50 max-h-[300px] w-[320px] overflow-y-auto overscroll-contain rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-2 shadow-lg">
              {availableMcpServers.length === 0 ? (
                <p className="px-3 py-2 text-xs text-[var(--ink-subtle)]">
                  {t('agentSettings.basics.noGlobalTools')}
                </p>
              ) : (
                availableMcpServers.map(server => {
                  const checked = effectiveMcpServers?.includes(server.id) ?? false;
                  return (
                    <label
                      key={server.id}
                      className="flex cursor-pointer items-center gap-3 rounded-lg p-2 transition-colors hover:bg-[var(--hover-bg)]"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => handleMcpToggle(server.id)}
                        className="h-4 w-4 rounded border-[var(--line)]"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-[var(--ink)]">{server.name}</p>
                        {server.description && (
                          <p className="truncate text-xs text-[var(--ink-muted)]">{server.description}</p>
                        )}
                      </div>
                    </label>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
      )}

      {/* Plugins (PRD 0.2.17) — same shape as MCP row above. Hidden when
       *  external runtime (CC/Codex/Gemini manage their own plugins).
       *  Renders nothing when no plugin is globally visible — avoids an
       *  empty "未启用插件" row for users who haven't installed any. */}
      {currentRuntime === 'builtin' && visiblePlugins.length > 0 && (
      <div className="relative flex items-center gap-3">
        <label className="w-16 shrink-0 text-sm text-[var(--ink-muted)]">{t('agentSettings.basics.plugins')}</label>
        <button
          className="flex flex-1 items-center justify-between rounded-lg border border-[var(--line)] px-3 py-1.5 text-left text-sm text-[var(--ink)] transition-colors hover:border-[var(--line-strong)]"
          onClick={() => setOpenPopup(openPopup === 'plugins' ? null : 'plugins')}
        >
          <span className="truncate">{pluginSummary}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        </button>

        {openPopup === 'plugins' && (
          <>
            <div className="fixed inset-0 z-40" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpenPopup(null); }} />
            <div className="absolute left-20 top-0 z-50 max-h-[300px] w-[320px] overflow-y-auto overscroll-contain rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-2 shadow-lg">
              {visiblePlugins.map(plugin => {
                const checked = effectiveEnabledPlugins?.includes(plugin.id) ?? false;
                return (
                  <label
                    key={plugin.id}
                    className="flex cursor-pointer items-center gap-3 rounded-lg p-2 transition-colors hover:bg-[var(--hover-bg)]"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => handlePluginToggle(plugin.id)}
                      className="h-4 w-4 rounded border-[var(--line)]"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-[var(--ink)]">{plugin.name}</p>
                      {plugin.description && (
                        <p className="truncate text-xs text-[var(--ink-muted)]">{plugin.description}</p>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          </>
        )}
      </div>
      )}
    </div>
  );
}
