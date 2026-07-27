// Agent config service — CRUD helpers, migration from ImBotConfigs
import type { AppConfig, McpServerDefinition, Project, WorkspaceTemplate, WorkspaceTemplateAgentDefaults } from '../types';
import { getEffectiveModelAliases, isProjectArchived, PRESET_TEMPLATES } from '../types';
import type { AgentConfig, ChannelConfig, ChannelOverrides } from '../../../shared/types/agent';
import type { ImBotConfig } from '../../../shared/types/im';
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../../shared/config-types';
import {
  createRuntimeBackedProviderIdentity,
  runtimeBackedProviderPermissionMode,
  runtimeConfigForRuntimeBackedProvider,
} from '../../../shared/providerExecution';
import type { RuntimeConfig, RuntimeType } from '../../../shared/types/runtime';
import {
  atomicModifyConfig,
  loadAppConfig,
  notifyConfigChanged,
  type ConfigChangeNotification,
} from './appConfigService';
import { loadProjects, patchProject } from './projectService';
import { withAgentConfigIntentLock } from './configStore';
import { getAllMcpServersFromConfig } from './mcpService';
import { normalizeWorkspacePathIdentity, workspacePathsEqual } from '../../../shared/workspacePath';

// ============= Query Helpers =============

export function getAgentById(config: AppConfig, agentId: string): AgentConfig | undefined {
  return config.agents?.find(a => a.id === agentId);
}

export function getChannelById(agent: AgentConfig, channelId: string): ChannelConfig | undefined {
  return agent.channels?.find(c => c.id === channelId);
}

export type OpenClawPluginConfigMutation =
  | { type: 'set'; key: string; value: unknown }
  | { type: 'delete'; key: string };

export function applyOpenClawPluginConfigMutation(
  current: Record<string, unknown> | undefined,
  mutation: OpenClawPluginConfigMutation,
): Record<string, unknown> {
  const next = { ...(current ?? {}) };
  if (mutation.type === 'set') next[mutation.key] = mutation.value;
  else delete next[mutation.key];
  return next;
}

/**
 * Whether a channel has the credentials its runtime needs to start — mirrors the
 * per-type requirements ChannelWizard enforces at creation. Single source of truth
 * for "can this channel be enabled", shared by the detail-view toggle (specific
 * toast) and `startAndEnableAgentChannel` (hard guard). Refusing to enable a
 * credential-less channel prevents persisting `enabled=true` for something
 * `auto_start_all_enabled_agent_channels` would then fail to launch on every boot.
 */
export function channelHasCredentials(ch: ChannelConfig): boolean {
  if (ch.type === 'feishu') return Boolean(ch.feishuAppId && ch.feishuAppSecret);
  if (ch.type === 'dingtalk') return Boolean(ch.dingtalkClientId && ch.dingtalkClientSecret);
  if (ch.type.startsWith('openclaw:')) return Boolean(ch.openclawPluginId);
  return Boolean(ch.botToken);
}

export function getAgentByWorkspacePath(config: AppConfig, workspacePath: string): AgentConfig | undefined {
  // Canonical identity (#320): Agent.workspacePath and the queried path can
  // diverge in separator/case form across stores — match the same way Rust does.
  return config.agents?.find(a => workspacePathsEqual(a.workspacePath, workspacePath));
}

async function findArchivedProjectForAgent(
  agent: Pick<AgentConfig, 'id' | 'workspacePath'>,
): Promise<Project | undefined> {
  const projects = await loadProjects();
  return projects.find(project =>
    isProjectArchived(project)
    && (
      project.agentId === agent.id
      || workspacePathsEqual(project.path, agent.workspacePath)
    ),
  );
}

export async function assertAgentWorkspaceNotArchived(
  agent: Pick<AgentConfig, 'id' | 'workspacePath'>,
): Promise<void> {
  const archivedProject = await findArchivedProjectForAgent(agent);
  if (!archivedProject) return;
  const name = archivedProject.displayName || archivedProject.name || archivedProject.path;
  throw new Error(`Agent workspace "${name}" is archived. Unarchive it before enabling proactive Agent channels.`);
}

// ============= Agent Creation Helpers =============

export interface BuildAgentForProjectOptions {
  agentId?: string;
  defaultPermissionMode?: string;
  agentDefaults?: WorkspaceTemplateAgentDefaults;
  templates?: readonly WorkspaceTemplate[];
}

function cloneHeartbeatConfig(defaults: WorkspaceTemplateAgentDefaults['heartbeat']) {
  if (!defaults) return undefined;
  return {
    ...defaults,
    activeHours: defaults.activeHours ? { ...defaults.activeHours } : undefined,
  };
}

function cloneMemoryAutoUpdateConfig(defaults: WorkspaceTemplateAgentDefaults['memoryAutoUpdate']) {
  if (!defaults) return undefined;
  return { ...defaults };
}

function cloneMemoryEvolutionConfig(defaults: WorkspaceTemplateAgentDefaults['memoryEvolution']) {
  if (!defaults) return undefined;
  return { ...defaults };
}

export function resolveAgentDefaultsForProject(
  project: Project,
  templates: readonly WorkspaceTemplate[] = PRESET_TEMPLATES,
): WorkspaceTemplateAgentDefaults | undefined {
  if (project.templateSource !== 'builtin' || !project.templateId) return undefined;
  return templates.find(t => t.isBuiltin && t.id === project.templateId)?.agentDefaults;
}

export function buildAgentForProject(
  project: Project,
  options: BuildAgentForProjectOptions = {},
): AgentConfig {
  const agentDefaults = options.agentDefaults ?? resolveAgentDefaultsForProject(project, options.templates);
  return {
    id: options.agentId ?? crypto.randomUUID(),
    name: project.displayName || project.name,
    icon: project.icon,
    workspacePath: project.path,
    enabled: agentDefaults?.enabled ?? false,
    channels: [],
    providerId: project.providerId ?? undefined,
    model: project.model ?? undefined,
    permissionMode: project.permissionMode || options.defaultPermissionMode || 'plan',
    mcpEnabledServers: project.mcpEnabledServers,
    heartbeat: cloneHeartbeatConfig(agentDefaults?.heartbeat),
    memoryAutoUpdate: cloneMemoryAutoUpdateConfig(agentDefaults?.memoryAutoUpdate),
    memoryEvolution: cloneMemoryEvolutionConfig(agentDefaults?.memoryEvolution),
  };
}

// ============= Migration: ImBotConfigs → Agents =============

let _agentMigrationDone = false;

/**
 * Migrate legacy imBotConfigs[] to agents[].
 * Trigger: imBotConfigs has entries AND agents is empty/absent.
 * Groups bots by defaultWorkspacePath → same workspace bots become channels of one agent.
 */
export function migrateImBotConfigsToAgents(config: AppConfig, projects: Project[]): AppConfig {
  if (_agentMigrationDone) return config;

  const bots = config.imBotConfigs;
  if (!bots || bots.length === 0) return config;
  if (config.agents && config.agents.length > 0) return config;

  _agentMigrationDone = true;
  console.log(`[agentConfigService] Migrating ${bots.length} ImBotConfig(s) to Agent architecture`);

  // Group bots by canonical workspace identity, but keep the primary bot's raw
  // path as the persisted Agent.workspacePath. The identity must collapse
  // Windows slash/case variants; persisted paths should remain user-native.
  const groups = new Map<string, ImBotConfig[]>();
  for (const bot of bots) {
    const key = bot.defaultWorkspacePath
      ? normalizeWorkspacePathIdentity(bot.defaultWorkspacePath)
      : '__default__';
    const group = groups.get(key) || [];
    group.push(bot);
    groups.set(key, group);
  }

  const agents: AgentConfig[] = [];

  for (const [workspaceKey, groupBots] of groups) {
    const primary = groupBots[0];
    const agentId = crypto.randomUUID();
    const resolvedPath = workspaceKey === '__default__' ? '' : (primary.defaultWorkspacePath ?? '');

    // Build channels from each bot
    const channels: ChannelConfig[] = groupBots.map(bot => {
      // Detect overrides: if bot's AI config differs from primary, store in overrides
      const overrides: ChannelOverrides = {};
      let hasOverrides = false;

      if (bot.providerId !== primary.providerId && bot.providerId !== undefined) {
        overrides.providerId = bot.providerId;
        hasOverrides = true;
      }
      if (bot.providerEnvJson !== primary.providerEnvJson && bot.providerEnvJson !== undefined) {
        overrides.providerEnvJson = bot.providerEnvJson;
        hasOverrides = true;
      }
      if (bot.model !== primary.model && bot.model !== undefined) {
        overrides.model = bot.model;
        hasOverrides = true;
      }
      if (bot.permissionMode !== primary.permissionMode) {
        overrides.permissionMode = bot.permissionMode;
        hasOverrides = true;
      }
      if (bot.groupToolsDeny && bot.groupToolsDeny.length > 0) {
        overrides.toolsDeny = bot.groupToolsDeny;
        hasOverrides = true;
      }

      return {
        id: bot.id, // Reuse bot ID as channel ID for continuity
        type: bot.platform,
        name: bot.name,
        enabled: bot.enabled,
        botToken: bot.botToken || undefined,
        telegramUseDraft: bot.telegramUseDraft,
        feishuAppId: bot.feishuAppId,
        feishuAppSecret: bot.feishuAppSecret,
        dingtalkClientId: bot.dingtalkClientId,
        dingtalkClientSecret: bot.dingtalkClientSecret,
        dingtalkUseAiCard: bot.dingtalkUseAiCard,
        dingtalkCardTemplateId: bot.dingtalkCardTemplateId,
        openclawPluginId: bot.openclawPluginId,
        openclawNpmSpec: bot.openclawNpmSpec,
        openclawPluginConfig: bot.openclawPluginConfig,
        openclawManifest: bot.openclawManifest,
        allowedUsers: bot.allowedUsers,
        groupPermissions: bot.groupPermissions,
        groupActivation: bot.groupActivation,
        overrides: hasOverrides ? overrides : undefined,
        setupCompleted: bot.setupCompleted,
      } satisfies ChannelConfig;
    });

    const agent: AgentConfig = {
      id: agentId,
      name: primary.name || `Agent (${resolvedPath.split(/[\\/]/).filter(Boolean).pop() || 'default'})`,
      enabled: groupBots.some(b => b.enabled),
      workspacePath: resolvedPath,
      providerId: primary.providerId,
      model: primary.model,
      providerEnvJson: primary.providerEnvJson,
      permissionMode: primary.permissionMode,
      mcpEnabledServers: primary.mcpEnabledServers,
      heartbeat: primary.heartbeat,
      channels,
      setupCompleted: primary.setupCompleted,
    };

    agents.push(agent);

    // Mark corresponding project as agent
    const project = resolvedPath
      ? projects.find(p => workspacePathsEqual(p.path, resolvedPath))
      : undefined;
    if (project) {
      project.isAgent = true;
      project.agentId = agentId;
    }
  }

  config.agents = agents;
  // Keep imBotConfigs as empty array to prevent re-migration
  config.imBotConfigs = [];

  console.log(`[agentConfigService] Migration complete: ${agents.length} agent(s) with ${bots.length} channel(s) total`);
  return config;
}

// ============= BasicAgent Auto-Creation (v0.1.49) =============

/**
 * Ensure every Project has a linked AgentConfig (basicAgent).
 * Runs at startup after migrateImBotConfigsToAgents().
 *
 * - Projects without agentId → create basicAgent with AI fields copied from Project
 * - Projects with agentId but orphaned (agent deleted) → recreate basicAgent
 * - Projects already linked to a valid agent → skip
 *
 * Returns { changed } so caller can decide whether to persist.
 */
export function ensureAllProjectsHaveAgent(
  config: AppConfig,
  projects: Project[],
  defaultPermissionMode?: string,
): { changed: boolean } {
  const agents = config.agents ?? [];
  const agentMap = new Map(agents.map(a => [a.id, a]));
  let changed = false;
  let createdCount = 0;

  for (const project of projects) {
    // Skip if already linked to a valid agent
    if (project.agentId && agentMap.has(project.agentId)) {
      continue;
    }

    // Also check by workspacePath (agent exists but project.agentId is stale/missing)
    const existingByPath = agents.find(a => workspacePathsEqual(a.workspacePath, project.path));
    if (existingByPath) {
      // Fix orphaned reference
      project.agentId = existingByPath.id;
      if (existingByPath.enabled) {
        project.isAgent = true;
      }
      changed = true;
      continue;
    }

    // Create basicAgent — AI fields from Project (fallback to defaults)
    const basicAgent = buildAgentForProject(project, { defaultPermissionMode });

    agents.push(basicAgent);
    agentMap.set(basicAgent.id, basicAgent);
    project.agentId = basicAgent.id;
    if (basicAgent.enabled) {
      project.isAgent = true;
    }
    changed = true;
    createdCount++;
  }

  if (changed) {
    config.agents = agents;
    console.log(`[agentConfigService] ensureAllProjectsHaveAgent: created ${createdCount} basicAgent(s), total agents: ${agents.length}`);
  }

  return { changed };
}

// ============= Persistence Helpers =============

/**
 * Save agents to disk (atomic read-modify-write).
 */
export async function persistAgents(agents: AgentConfig[]): Promise<void> {
  await atomicModifyConfig(config => ({
    ...config,
    agents,
  }));
}

function parseAgentMcpServersJson(raw: string | undefined): McpServerDefinition[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPromotableRemoteMcpDefinition);
  } catch {
    return [];
  }
}

function isPromotableRemoteMcpDefinition(server: unknown): server is McpServerDefinition {
  if (!server || typeof server !== 'object' || Array.isArray(server)) return false;
  const candidate = server as { id?: unknown; name?: unknown; type?: unknown; url?: unknown };
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && (candidate.type === 'http' || candidate.type === 'sse')
    && typeof candidate.url === 'string'
    && candidate.url.length > 0;
}

/**
 * Agent MCP selection has two layers:
 * - AppConfig.mcpServers / mcpEnabledServers are the global catalogue + safety gate.
 * - AgentConfig.mcpEnabledServers is the per-Agent subset.
 *
 * Older UI flows could leave HTTP/SSE definitions only in agent.mcpServersJson.
 * When the Agent subset is saved again, heal that legacy shape by promoting
 * selected custom definitions into the global catalogue and global enabled list
 * before rebuilding the runtime mcpServersJson payload. Known-but-globally
 * disabled servers stay disabled; the global enabled list remains the safety
 * gate outside the legacy-heal path.
 */
export function resolveAgentMcpSelectionForConfig(
  config: AppConfig,
  agent: AgentConfig | undefined,
  enabledServerIds: readonly string[],
): { config: AppConfig; mcpServersJson?: string } {
  const requestedIds = [...new Set(enabledServerIds.filter(Boolean))];
  if (requestedIds.length === 0) {
    return { config, mcpServersJson: undefined };
  }

  const requested = new Set(requestedIds);
  let nextConfig = config;
  let knownIds = new Set(getAllMcpServersFromConfig(nextConfig).map(server => server.id));
  const legacyDefinitions = parseAgentMcpServersJson(agent?.mcpServersJson)
    .filter(server => requested.has(server.id) && !server.isBuiltin && !knownIds.has(server.id));

  if (legacyDefinitions.length > 0) {
    const customServers = [...(Array.isArray(nextConfig.mcpServers) ? nextConfig.mcpServers : [])];
    for (const server of legacyDefinitions) {
      const normalized: McpServerDefinition = { ...server, isBuiltin: false };
      const existingIndex = customServers.findIndex(s => s.id === normalized.id);
      if (existingIndex >= 0) {
        customServers[existingIndex] = normalized;
      } else {
        customServers.push(normalized);
      }
    }
    nextConfig = { ...nextConfig, mcpServers: customServers };
    knownIds = new Set(getAllMcpServersFromConfig(nextConfig).map(server => server.id));
  }

  const globalEnabled = new Set(Array.isArray(nextConfig.mcpEnabledServers) ? nextConfig.mcpEnabledServers : []);
  let enabledChanged = false;
  for (const server of legacyDefinitions) {
    if (!globalEnabled.has(server.id)) {
      globalEnabled.add(server.id);
      enabledChanged = true;
    }
  }
  if (enabledChanged) {
    nextConfig = { ...nextConfig, mcpEnabledServers: Array.from(globalEnabled) };
  }

  const allServers = getAllMcpServersFromConfig(nextConfig);
  const enabledDefs = allServers.filter(server => globalEnabled.has(server.id) && requested.has(server.id));
  return {
    config: nextConfig,
    mcpServersJson: enabledDefs.length > 0 ? JSON.stringify(enabledDefs) : undefined,
  };
}

export function resolveAgentRuntimeMcpServersJson(
  allServers: readonly McpServerDefinition[],
  globalEnabledServerIds: readonly string[],
  agentEnabledServerIds: readonly string[] | undefined,
): string | null {
  const globalEnabled = new Set(globalEnabledServerIds);
  const agentEnabled = new Set(agentEnabledServerIds ?? []);
  const enabledMcpDefs = allServers.filter(
    server => globalEnabled.has(server.id) && agentEnabled.has(server.id),
  );
  return enabledMcpDefs.length > 0 ? JSON.stringify(enabledMcpDefs) : null;
}

const PROJECT_MIRRORED_AGENT_FIELDS = new Set<keyof Omit<AgentConfig, 'id'>>([
  'providerId',
  'model',
  'permissionMode',
  'mcpEnabledServers',
  'enabledPluginIds',
  'enabledOfficialToolIds',
]);

function touchesProjectMirroredAgentField(patch: Partial<Omit<AgentConfig, 'id'>>): boolean {
  return Object.keys(patch).some(key => PROJECT_MIRRORED_AGENT_FIELDS.has(key as keyof Omit<AgentConfig, 'id'>));
}

function projectMirrorPatchFromAgentPatch(
  patch: Partial<Omit<AgentConfig, 'id'>>,
): Partial<Omit<Project, 'id'>> {
  const projectPatch: Partial<Omit<Project, 'id'>> = {};
  const source = patch as Partial<Record<keyof Omit<AgentConfig, 'id'>, unknown>>;
  const target = projectPatch as Partial<Record<keyof Omit<Project, 'id'>, unknown>>;
  for (const key of PROJECT_MIRRORED_AGENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      target[key as keyof Omit<Project, 'id'>] = source[key];
    }
  }
  return projectPatch;
}

interface AgentConfigDiskPatchResult {
  previous?: AgentConfig;
  updated?: AgentConfig;
  configChanged: boolean;
  effectivePatch: Partial<Omit<AgentConfig, 'id'>>;
  resolvedMcpJson?: string;
}

async function persistAgentConfigPatch(
  agentId: string,
  patch: Partial<Omit<AgentConfig, 'id'>>,
  notification: ConfigChangeNotification = 'immediate',
): Promise<AgentConfigDiskPatchResult> {
  if (patch.enabled === true) {
    const currentConfig = await loadAppConfig();
    const currentAgent = getAgentById(currentConfig, agentId);
    if (currentAgent) {
      await assertAgentWorkspaceNotArchived(currentAgent);
    }
  }

  let previous: AgentConfig | undefined;
  let updated: AgentConfig | undefined;
  let configChanged = false;

  // If mcpEnabledServers changed, resolve mcpServersJson inside the config
  // transaction so the Agent subset, global MCP registry, and runtime payload
  // are all derived from the same disk-latest config.
  let resolvedMcpJson: string | undefined;

  // If providerId changed but providerEnvJson was NOT explicitly provided,
  // auto-resolve from provider registry + stored API keys.
  // This is the "pit of success" pattern: callers only need to set providerId,
  // credentials are resolved centrally so IM Bot / CronTask always get correct provider env.
  let resolvedProviderEnvJson: string | undefined | null;
  let shouldUpdateProviderEnv = false;
  if ('providerId' in patch && !('providerEnvJson' in patch)) {
    shouldUpdateProviderEnv = true;
    try {
      const { getAllProviders, loadApiKeys } = await import('./providerService');
      const [allProviders, apiKeys] = await Promise.all([getAllProviders(), loadApiKeys()]);
      const provider = allProviders.find(p => p.id === patch.providerId);
      if (provider && provider.type !== 'subscription') {
        // Load config to get user's providerModelAliases overrides
        const latestConfig = await loadAppConfig();
        const aliases = getEffectiveModelAliases(provider, latestConfig.providerModelAliases);
        resolvedProviderEnvJson = JSON.stringify({
          providerId: provider.id,
          baseUrl: provider.config.baseUrl,
          apiKey: apiKeys[provider.id],
          authType: provider.authType,
          apiProtocol: provider.apiProtocol,
          maxOutputTokens: provider.maxOutputTokens,
          maxOutputTokensParamName: provider.maxOutputTokensParamName,
          upstreamFormat: provider.upstreamFormat,
          ...(aliases ? { modelAliases: aliases } : {}),
        });
      } else {
        // Subscription provider (e.g. Anthropic) or unknown — clear providerEnvJson
        resolvedProviderEnvJson = undefined;
      }
    } catch (e) {
      console.warn('[agentConfigService] Failed to resolve provider env:', e);
      shouldUpdateProviderEnv = false;
    }
  }

  await atomicModifyConfig(config => {
    let nextConfig = config;
    let agents = [...(nextConfig.agents || [])];
    const idx = agents.findIndex(a => a.id === agentId);
    if (idx < 0) return nextConfig;
    if ('mcpEnabledServers' in patch) {
      const mcpResolution = resolveAgentMcpSelectionForConfig(
        nextConfig,
        agents[idx],
        patch.mcpEnabledServers ?? [],
      );
      nextConfig = mcpResolution.config;
      resolvedMcpJson = mcpResolution.mcpServersJson;
      agents = [...(nextConfig.agents || [])];
    }
    previous = agents[idx];
    agents[idx] = {
      ...agents[idx],
      ...patch,
      id: agentId,
      // Persist resolved MCP JSON alongside mcpEnabledServers
      ...(resolvedMcpJson !== undefined || 'mcpEnabledServers' in patch
        ? { mcpServersJson: resolvedMcpJson }
        : {}),
      // Persist resolved provider env alongside providerId
      ...(shouldUpdateProviderEnv
        ? { providerEnvJson: resolvedProviderEnvJson ?? undefined }
        : {}),
    };
    updated = agents[idx];
    const next = {
      ...nextConfig,
      agents,
    };
    configChanged = JSON.stringify(next) !== JSON.stringify(config);
    return next;
  }, { notification });

  const effectivePatch = shouldUpdateProviderEnv
    ? { ...patch, providerEnvJson: resolvedProviderEnvJson ?? undefined }
    : patch;
  return { previous, updated, configChanged, effectivePatch, resolvedMcpJson };
}

function restoreAgentFieldsIfUnchanged(
  current: AgentConfig,
  previous: AgentConfig,
  committed: AgentConfig,
): { agent: AgentConfig; complete: boolean } {
  const restored = { ...current } as Record<string, unknown>;
  let complete = true;
  const keys = new Set([...Object.keys(previous), ...Object.keys(committed)]);
  for (const key of keys) {
    const previousValue = (previous as unknown as Record<string, unknown>)[key];
    const committedValue = (committed as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(previousValue) === JSON.stringify(committedValue)) continue;
    if (JSON.stringify(restored[key]) !== JSON.stringify(committedValue)) {
      complete = false;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(previous, key)) restored[key] = previousValue;
    else delete restored[key];
  }
  return { agent: restored as unknown as AgentConfig, complete };
}

async function projectLiveAgentConfigPatch(
  agentId: string,
  patch: Partial<Omit<AgentConfig, 'id'>>,
  result: AgentConfigDiskPatchResult,
  options: { memoryAutoUpdateReconcileFailure?: 'defer' | 'throw' },
): Promise<void> {
  if (result.updated) {
    // Live projection deliberately happens after every disk-intent lock has
    // been released. Runtime rotation/network waits are not persistence work.
    await syncAgentRuntime(agentId, result.effectivePatch, result.resolvedMcpJson);
    if ('memoryAutoUpdate' in patch) {
      try {
        await configureMemoryAutoUpdateTaskForAgent(result.updated);
      } catch (error) {
        if (options.memoryAutoUpdateReconcileFailure === 'throw') {
          throw error;
        }
        // Composite operations such as enabling an Agent already committed
        // their primary disk intent. Startup reconciliation converges the
        // managed Task without turning that primary operation into a failure.
        console.warn('[agentConfigService] Memory auto-update Task reconciliation deferred:', error);
      }
    }
  }
}

interface AgentProjectMirrorTarget {
  projectId: string;
  projectPatch: Partial<Omit<Project, 'id'>>;
}

async function persistAgentProjectIntent(
  agentId: string,
  agentPatch: Partial<Omit<AgentConfig, 'id'>>,
  resolveTarget: () => Promise<AgentProjectMirrorTarget | undefined>,
  options: { memoryAutoUpdateReconcileFailure?: 'defer' | 'throw' },
  notificationSource: 'patchAgentConfig' | 'patchAgentProjectConfig',
): Promise<AgentConfig | undefined> {
  let result: AgentConfigDiskPatchResult | undefined;
  let projectCommitted = false;
  try {
    await withAgentConfigIntentLock(async () => {
      const target = await resolveTarget();
      result = await persistAgentConfigPatch(
        agentId,
        agentPatch,
        target ? 'deferred' : 'immediate',
      );
      if (!result.updated || !target) return;
      try {
        const updatedProject = await patchProject(target.projectId, target.projectPatch);
        if (!updatedProject) throw new Error(`Project '${target.projectId}' not found`);
        projectCommitted = true;
      } catch (error) {
        let rolledBack = false;
        if (result.previous) {
          try {
            await atomicModifyConfig(config => {
              const agents = [...(config.agents ?? [])];
              const index = agents.findIndex(agent => agent.id === agentId);
              if (index < 0) return config;
              const restored = restoreAgentFieldsIfUnchanged(
                agents[index],
                result!.previous!,
                result!.updated!,
              );
              agents[index] = restored.agent;
              rolledBack = restored.complete;
              return { ...config, agents };
            }, { notification: 'deferred' });
          } catch (rollbackError) {
            const reason = error instanceof Error ? error.message : String(error);
            const rollbackReason = rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError);
            throw new Error(
              `Project mirror save failed (${reason}) and Agent rollback also failed (${rollbackReason})`,
            );
          }
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(rolledBack
          ? `Agent configuration was not changed because its Project mirror could not be saved: ${reason}`
          : `Project mirror save failed after Agent configuration changed: ${reason}`);
      }
    });
  } catch (error) {
    if (result?.configChanged) notifyConfigChanged(notificationSource);
    throw error;
  }

  if (!result?.updated) return undefined;
  if (projectCommitted) {
    // Project has no renderer notification of its own. Publish only after
    // both disk authorities have reached their final state.
    notifyConfigChanged(notificationSource);
  }
  await projectLiveAgentConfigPatch(agentId, agentPatch, result, options);
  return result.updated;
}

/**
 * Patch a single Agent record. Fields mirrored by Project compatibility state
 * automatically participate in the shared intent lock, so direct renderer
 * callers cannot interleave with a CLI Agent+Project commit. Live runtime
 * projection always runs after the disk lock is released.
 */
export async function patchAgentConfig(
  agentId: string,
  patch: Partial<Omit<AgentConfig, 'id'>>,
  options: { memoryAutoUpdateReconcileFailure?: 'defer' | 'throw' } = {},
): Promise<AgentConfig | undefined> {
  if (!touchesProjectMirroredAgentField(patch)) {
    const result = await persistAgentConfigPatch(agentId, patch);
    await projectLiveAgentConfigPatch(agentId, patch, result, options);
    return result.updated;
  }

  return persistAgentProjectIntent(
    agentId,
    patch,
    async () => {
      // Resolve the association only after joining the cross-process intent
      // lock. Caller-held React state is a replica and may already be stale.
      const [config, projects] = await Promise.all([loadAppConfig(), loadProjects()]);
      const agent = getAgentById(config, agentId);
      if (!agent) return undefined;
      const project = projects.find(candidate => candidate.agentId === agentId)
        ?? projects.find(candidate => (
          !candidate.agentId && workspacePathsEqual(candidate.path, agent.workspacePath)
        ));
      if (!project) return undefined;
      return {
        projectId: project.id,
        projectPatch: projectMirrorPatchFromAgentPatch(patch),
      };
    },
    options,
    'patchAgentConfig',
  );
}

/**
 * Commit one renderer-owned Agent default together with its Project mirror.
 * Both disk writes finish under the shared intent lock; hot reload happens
 * only after release. A failed Project write conditionally restores the exact
 * Agent record this intent replaced.
 */
export async function patchAgentProjectConfig(
  agentId: string,
  agentPatch: Partial<Omit<AgentConfig, 'id'>>,
  projectId: string,
  projectPatch: Partial<Omit<Project, 'id'>>,
  options: { memoryAutoUpdateReconcileFailure?: 'defer' | 'throw' } = {},
): Promise<AgentConfig | undefined> {
  return persistAgentProjectIntent(
    agentId,
    agentPatch,
    async () => ({ projectId, projectPatch }),
    options,
    'patchAgentProjectConfig',
  );
}

async function modifyAgentChannelConfig(
  agentId: string,
  channelId: string,
  modify: (channel: ChannelConfig) => ChannelConfig,
): Promise<ChannelConfig> {
  let updatedChannel: ChannelConfig | undefined;
  let authoritativeChannels: ChannelConfig[] | undefined;
  await atomicModifyConfig(config => {
    const agents = [...(config.agents ?? [])];
    const agentIndex = agents.findIndex(agent => agent.id === agentId);
    if (agentIndex < 0) return config;

    const channels = [...(agents[agentIndex].channels ?? [])];
    const channelIndex = channels.findIndex(channel => channel.id === channelId);
    if (channelIndex < 0) return config;

    updatedChannel = modify(channels[channelIndex]);
    channels[channelIndex] = updatedChannel;
    authoritativeChannels = channels;
    agents[agentIndex] = { ...agents[agentIndex], channels };
    return { ...config, agents };
  });

  if (!updatedChannel || !authoritativeChannels) {
    throw new Error(`Agent channel not found: agentId=${agentId} channelId=${channelId}`);
  }
  await syncAgentRuntime(agentId, { channels: authoritativeChannels });
  return updatedChannel;
}

/** Patch one channel against the disk-latest Agent instead of replacing a renderer snapshot of channels[]. */
export function patchAgentChannelConfig(
  agentId: string,
  channelId: string,
  patch: Partial<ChannelConfig>,
): Promise<ChannelConfig> {
  return modifyAgentChannelConfig(agentId, channelId, channel => ({ ...channel, ...patch }));
}

export async function removeAgentChannelConfig(agentId: string, channelId: string): Promise<void> {
  let authoritativeChannels: ChannelConfig[] | undefined;
  await atomicModifyConfig(config => {
    const agents = [...(config.agents ?? [])];
    const agentIndex = agents.findIndex(agent => agent.id === agentId);
    if (agentIndex < 0) return config;
    const channels = (agents[agentIndex].channels ?? []).filter(channel => channel.id !== channelId);
    if (channels.length === (agents[agentIndex].channels ?? []).length) return config;
    authoritativeChannels = channels;
    agents[agentIndex] = { ...agents[agentIndex], channels };
    return { ...config, agents };
  });
  if (authoritativeChannels) await syncAgentRuntime(agentId, { channels: authoritativeChannels });
}

/**
 * Mutate one OpenClaw plugin config field against the disk-latest channel.
 * The field operation, rather than a renderer-owned full snapshot, is the
 * persistence contract so an editor remount cannot overwrite another pending
 * field save with stale config.
 */
export function patchAgentChannelOpenClawConfig(
  agentId: string,
  channelId: string,
  mutation: OpenClawPluginConfigMutation,
): Promise<ChannelConfig> {
  return modifyAgentChannelConfig(agentId, channelId, channel => ({
    ...channel,
    openclawPluginConfig: applyOpenClawPluginConfigMutation(
      channel.openclawPluginConfig,
      mutation,
    ),
  }));
}

export async function disableAgentAndStopChannels(agent: AgentConfig): Promise<number> {
  let stoppedCount = 0;
  const { isTauriEnvironment } = await import('@/utils/browserMock');
  if (isTauriEnvironment()) {
    const { invoke } = await import('@tauri-apps/api/core');
    for (const ch of (agent.channels ?? [])) {
      try {
        await invoke('cmd_stop_agent_channel', { agentId: agent.id, channelId: ch.id });
        stoppedCount++;
      } catch {
        // Channel may already be stopped; persisting enabled=false below is the durable intent.
      }
    }
  }
  await patchAgentConfig(agent.id, { enabled: false });
  return stoppedCount;
}

export async function enableAgentAndStartChannels(
  agentId: string,
  patch: Partial<Omit<AgentConfig, 'id'>> = {},
): Promise<number> {
  await patchAgentConfig(agentId, { ...patch, enabled: true });

  const { isTauriEnvironment } = await import('@/utils/browserMock');
  if (!isTauriEnvironment()) return 0;

  const latestConfig = await loadAppConfig();
  const latestAgent = getAgentById(latestConfig, agentId);
  if (!latestAgent) return 0;

  const startable = (latestAgent.channels ?? []).filter(ch => ch.enabled && ch.setupCompleted);
  let startedCount = 0;
  for (const ch of startable) {
    try {
      await invokeStartAgentChannel(latestAgent, ch);
      startedCount++;
    } catch (e) {
      console.warn(`[agentConfigService] Auto-start channel ${ch.id} failed:`, e);
    }
  }
  return startedCount;
}

/**
 * Sync runtime-sensitive fields to running agent instance via Tauri command.
 * Only sends fields that are present in the patch (i.e. actually changed).
 */
async function syncAgentRuntime(
  agentId: string,
  patch: Partial<Omit<AgentConfig, 'id'>>,
  preResolvedMcpJson?: string,
): Promise<void> {
  const { isTauriEnvironment } = await import('@/utils/browserMock');
  if (!isTauriEnvironment()) return;

  // Build a runtime patch with only the fields that changed
  const runtimePatch: Record<string, unknown> = {};
  let hasRuntimeChanges = false;

  if ('model' in patch) {
    runtimePatch.model = patch.model ?? null;
    hasRuntimeChanges = true;
  }
  if ('providerEnvJson' in patch) {
    runtimePatch.providerEnvJson = patch.providerEnvJson ?? null;
    hasRuntimeChanges = true;
  }
  if ('providerId' in patch) {
    runtimePatch.providerId = patch.providerId ?? null;
    hasRuntimeChanges = true;
  }
  if ('permissionMode' in patch) {
    runtimePatch.permissionMode = patch.permissionMode ?? null;
    hasRuntimeChanges = true;
  }
  if ('runtime' in patch) {
    runtimePatch.runtime = patch.runtime ?? null;
    hasRuntimeChanges = true;
  }
  if ('runtimeConfig' in patch) {
    runtimePatch.runtimeConfig = patch.runtimeConfig ?? null;
    hasRuntimeChanges = true;
  }
  if ('heartbeat' in patch) {
    runtimePatch.heartbeatConfigJson = patch.heartbeat ? JSON.stringify(patch.heartbeat) : null;
    hasRuntimeChanges = true;
  }
  if ('memoryAutoUpdate' in patch) {
    runtimePatch.memoryAutoUpdateConfigJson = patch.memoryAutoUpdate ? JSON.stringify(patch.memoryAutoUpdate) : null;
    hasRuntimeChanges = true;
  }
  if ('memoryEvolution' in patch) {
    runtimePatch.memoryEvolutionConfigJson = patch.memoryEvolution ? JSON.stringify(patch.memoryEvolution) : null;
    hasRuntimeChanges = true;
  }

  // mcpEnabledServers changed → use pre-resolved JSON (already persisted to disk atomically)
  if ('mcpEnabledServers' in patch) {
    runtimePatch.mcpServersJson = preResolvedMcpJson ?? null;
    hasRuntimeChanges = true;
  }
  // channels changed → forward to Rust for per-channel hot-reload (groupActivation etc.)
  if ('channels' in patch && patch.channels) {
    runtimePatch.channels = patch.channels;
    hasRuntimeChanges = true;
  }

  if (!hasRuntimeChanges) return;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('cmd_update_agent_config', { agentId, patch: runtimePatch });
  } catch (e) {
    // Agent may not be running — that's fine, config is already persisted to disk
    console.debug('[agentConfigService] Runtime sync skipped (agent not running?):', e);
  }
}

/**
 * Add a new agent config to disk.
 */
export async function addAgentConfig(agent: AgentConfig): Promise<void> {
  await atomicModifyConfig(config => {
    const agents = [...(config.agents || []), agent];
    return {
      ...config,
      agents,
    };
  });
  if (agent.memoryAutoUpdate?.enabled) {
    try {
      await configureMemoryAutoUpdateTaskForAgent(agent);
    } catch (error) {
      // Agent creation is already durable. Startup reconciliation owns
      // convergence; throwing here would make callers create a duplicate Agent.
      console.warn('[agentConfigService] Memory auto-update task provisioning deferred:', error);
    }
  }
}

export async function configureMemoryAutoUpdateTaskForAgent(
  agent: AgentConfig,
): Promise<void> {
  const { isTauriEnvironment } = await import('@/utils/browserMock');
  if (!isTauriEnvironment()) return;

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('cmd_configure_memory_auto_update_task', {
    request: {
      agentId: agent.id,
      workspacePath: agent.workspacePath,
      memoryAutoUpdate: agent.memoryAutoUpdate,
      heartbeat: agent.heartbeat,
    },
  });
}

async function disableMemoryAutoUpdateTaskForAgent(
  agent: Pick<AgentConfig, 'id' | 'workspacePath' | 'heartbeat'>,
): Promise<void> {
  const { isTauriEnvironment } = await import('@/utils/browserMock');
  if (!isTauriEnvironment()) return;

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('cmd_configure_memory_auto_update_task', {
    request: {
      agentId: agent.id,
      workspacePath: agent.workspacePath,
      memoryAutoUpdate: undefined,
      heartbeat: agent.heartbeat,
    },
  });
}

export function projectMemoryEvolutionTaskRuntimeForAgent(
  agent: Pick<AgentConfig, 'providerId' | 'model' | 'permissionMode' | 'runtime' | 'runtimeConfig'>,
): { runtime?: RuntimeType; runtimeConfig?: RuntimeConfig } {
  const model = typeof agent.model === 'string' ? agent.model.trim() : '';
  if (agent.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID && model) {
    const identity = createRuntimeBackedProviderIdentity({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      model,
    });
    const runtimeConfig = runtimeConfigForRuntimeBackedProvider(identity, agent.runtimeConfig);
    const permissionMode = agent.runtimeConfig?.permissionMode
      ?? runtimeBackedProviderPermissionMode(identity, agent.permissionMode);
    return {
      runtime: identity.runtime,
      runtimeConfig: {
        ...runtimeConfig,
        ...(permissionMode ? { permissionMode } : {}),
        ...(agent.runtimeConfig?.reasoningEffort ? { reasoningEffort: agent.runtimeConfig.reasoningEffort } : {}),
      },
    };
  }

  return {
    runtime: agent.runtime,
    runtimeConfig: agent.runtimeConfig,
  };
}

export async function configureMemoryEvolutionTasksForAgent(
  agent: AgentConfig,
  workspaceId: string,
  enabled: boolean,
): Promise<void> {
  const { isTauriEnvironment } = await import('@/utils/browserMock');
  if (!isTauriEnvironment()) return;

  const { invoke } = await import('@tauri-apps/api/core');
  const runtimeProjection = projectMemoryEvolutionTaskRuntimeForAgent(agent);
  await invoke('cmd_configure_memory_evolution_tasks', {
    request: {
      agentId: agent.id,
      workspaceId,
      workspacePath: agent.workspacePath,
      runtime: runtimeProjection.runtime,
      runtimeConfig: runtimeProjection.runtimeConfig,
      mcpEnabledServers: agent.mcpEnabledServers,
      memoryAutoUpdate: agent.memoryAutoUpdate,
      heartbeat: agent.heartbeat,
      enabled,
    },
  });
}

/**
 * Remove an agent config from disk.
 */
export async function removeAgentConfig(agentId: string): Promise<void> {
  let removedAgent: AgentConfig | undefined;
  await atomicModifyConfig(config => {
    removedAgent = (config.agents || []).find(a => a.id === agentId);
    const agents = (config.agents || []).filter(a => a.id !== agentId);
    return {
      ...config,
      agents,
    };
  });
  if (removedAgent?.workspacePath) {
    try {
      await disableMemoryAutoUpdateTaskForAgent(removedAgent);
    } catch (error) {
      // Agent removal is already durable. Startup reconciliation removes the
      // now-orphaned managed Task without turning removal into partial failure.
      console.warn('[agentConfigService] Memory auto-update task cleanup deferred:', error);
    }
  }
}

// ============= Runtime Helpers =============

/**
 * Start an agent channel via Tauri command.
 * Resolves MCP server definitions and effective config (agent + channel overrides).
 */
export async function invokeStartAgentChannel(
  agent: AgentConfig,
  channel: ChannelConfig,
): Promise<void> {
  await assertAgentWorkspaceNotArchived(agent);

  const { isTauriEnvironment } = await import('@/utils/browserMock');
  if (!isTauriEnvironment()) return;

  const { invoke } = await import('@tauri-apps/api/core');
  const { getAllMcpServers, getEnabledMcpServerIds } = await import('@/config/configService');
  const { resolveEffectiveConfig } = await import('../../../shared/types/agent');

  // Resolve MCP server definitions
  const allServers = await getAllMcpServers();
  const globalEnabled = await getEnabledMcpServerIds();
  const agentMcpIds = agent.mcpEnabledServers ?? [];
  const mcpServersJson = resolveAgentRuntimeMcpServersJson(allServers, globalEnabled, agentMcpIds);

  // Resolve effective config (agent defaults + channel overrides)
  const effective = resolveEffectiveConfig(agent, channel);

  await invoke('cmd_start_agent_channel', {
    agentId: agent.id,
    channelId: channel.id,
    agentConfig: {
      id: agent.id,
      name: agent.name,
      enabled: agent.enabled,
      workspacePath: agent.workspacePath,
      providerId: effective.providerId,
      model: effective.model,
      providerEnvJson: effective.providerEnvJson,
      permissionMode: effective.permissionMode,
      runtime: effective.runtime,
      runtimeConfig: effective.runtimeConfig,
      mcpEnabledServers: agent.mcpEnabledServers,
      mcpServersJson,
      heartbeat: agent.heartbeat,
      memoryAutoUpdate: agent.memoryAutoUpdate,
      memoryEvolution: agent.memoryEvolution,
      channels: [],
      lastActiveChannel: agent.lastActiveChannel,
      lastActivePrivateTarget: agent.lastActivePrivateTarget,
    },
    channelConfig: {
      id: channel.id,
      type: channel.type,
      name: channel.name,
      enabled: channel.enabled,
      botToken: channel.botToken,
      telegramUseDraft: channel.telegramUseDraft,
      feishuAppId: channel.feishuAppId,
      feishuAppSecret: channel.feishuAppSecret,
      dingtalkClientId: channel.dingtalkClientId,
      dingtalkClientSecret: channel.dingtalkClientSecret,
      dingtalkUseAiCard: channel.dingtalkUseAiCard,
      dingtalkCardTemplateId: channel.dingtalkCardTemplateId,
      openclawPluginId: channel.openclawPluginId,
      openclawNpmSpec: channel.openclawNpmSpec,
      openclawPluginConfig: channel.openclawPluginConfig,
      openclawManifest: channel.openclawManifest,
      openclawEnabledToolGroups: channel.openclawEnabledToolGroups,
      allowedUsers: channel.allowedUsers || [],
      groupPermissions: channel.groupPermissions || [],
      groupActivation: channel.groupActivation,
      overrides: channel.overrides,
      setupCompleted: channel.setupCompleted,
    },
  });
}

/**
 * Stop a running agent channel AND persist `channel.enabled = false` so the
 * channel stays stopped across app restarts (issue #219).
 *
 * Paired with `startAndEnableAgentChannel` — these two are the "user-initiated
 * lifecycle" operations. They MUST be symmetric: start flips enabled to true,
 * stop flips it to false. Otherwise auto_start_all_enabled_agent_channels in
 * the Rust layer re-launches a channel the user explicitly stopped (or worse,
 * leaves a re-enabled channel un-runnable).
 *
 * DO NOT use this for:
 *  - Transient stop+restart (e.g. credential refresh) — call cmd_stop_agent_channel
 *    + invokeStartAgentChannel directly, keep enabled untouched
 *  - Channel deletion — remove from channels[] in a patchAgentConfig call
 *  - Agent-level disable — patch `agent.enabled = false`; the Rust
 *    auto_start_all_enabled_agent_channels gate handles per-channel rollup
 *
 * Implementation notes (review-by-codex v1 → v2):
 *  - Takes IDs (not an `agent` snapshot) so concurrent channel additions /
 *    credential writes / name syncs aren't clobbered by a stale whole-array
 *    patch (codex F1 against the v1 helper).
 *  - Mutates inside `atomicModifyConfig` against the freshest on-disk config,
 *    not the caller's React prop. Throws if the agent or channel disappeared
 *    between click and persist (was a silent no-op in v1).
 *  - Persists BEFORE the runtime stop: if the process crashes between persist
 *    and runtime stop, restart sees enabled=false and won't auto-launch. The
 *    inverse order would silently re-launch a stopped channel on the next boot.
 *  - Runtime stop is best-effort: channel may already be down or sidecar gone;
 *    the persisted enabled=false is what makes the stop survive restarts.
 */
export async function stopAndDisableAgentChannel(
  agentId: string,
  channelId: string,
): Promise<void> {
  const { atomicModifyConfig } = await import('@/config/services/appConfigService');
  await atomicModifyConfig(config => {
    const agents = [...(config.agents ?? [])];
    const aIdx = agents.findIndex(a => a.id === agentId);
    if (aIdx < 0) {
      throw new Error(`stopAndDisableAgentChannel: agent ${agentId} not found in config`);
    }
    const channels = [...(agents[aIdx].channels ?? [])];
    const cIdx = channels.findIndex(c => c.id === channelId);
    if (cIdx < 0) {
      throw new Error(`stopAndDisableAgentChannel: channel ${channelId} not found in agent ${agentId}`);
    }
    if (channels[cIdx].enabled === false) {
      // Already disabled (e.g. re-click after a failed runtime stop). atomicModifyConfig
      // short-circuits the disk write when before === after — idempotent by design.
      return config;
    }
    channels[cIdx] = { ...channels[cIdx], enabled: false };
    agents[aIdx] = { ...agents[aIdx], channels };
    return { ...config, agents };
  });
  const { isTauriEnvironment } = await import('@/utils/browserMock');
  if (isTauriEnvironment()) {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      await invoke('cmd_stop_agent_channel', { agentId, channelId });
    } catch (e) {
      // Channel may already be stopped or sidecar lost. Persistence above already
      // landed, so the next restart respects the user's intent.
      console.warn('[agentConfigService] cmd_stop_agent_channel failed (enabled=false already persisted):', e);
    }
  }
}

/**
 * Symmetric counterpart to `stopAndDisableAgentChannel`: persist
 * `channel.enabled = true` against the latest on-disk config, then start the
 * runtime instance using a fresh snapshot.
 *
 * Why both helpers exist (v2 of #219): the channel-list UI greys out the
 * start button when `channel.enabled` is false. Before this helper, list-view's
 * "start" only invoked the runtime; if the user had previously disabled the
 * channel, the button was greyed and they couldn't restart from the list at
 * all — forced to navigate to the channel detail view. With this helper +
 * removing the disabled gate, both list and detail can fully re-enable.
 *
 * Returns the fresh `(agent, channel)` snapshot that was actually written, so
 * the caller doesn't depend on a separate read-back race.
 */
export async function startAndEnableAgentChannel(
  agentId: string,
  channelId: string,
): Promise<void> {
  const currentConfig = await loadAppConfig();
  const currentAgent = getAgentById(currentConfig, agentId);
  if (currentAgent) {
    await assertAgentWorkspaceNotArchived(currentAgent);
  }

  const { atomicModifyConfig } = await import('@/config/services/appConfigService');
  const updatedConfig = await atomicModifyConfig(config => {
    const agents = [...(config.agents ?? [])];
    const aIdx = agents.findIndex(a => a.id === agentId);
    if (aIdx < 0) {
      throw new Error(`startAndEnableAgentChannel: agent ${agentId} not found in config`);
    }
    const channels = [...(agents[aIdx].channels ?? [])];
    const cIdx = channels.findIndex(c => c.id === channelId);
    if (cIdx < 0) {
      throw new Error(`startAndEnableAgentChannel: channel ${channelId} not found in agent ${agentId}`);
    }
    if (channels[cIdx].enabled === true) {
      // Already enabled — atomicModifyConfig will skip the write.
      return config;
    }
    // Refuse to enable a credential-less channel: persisting enabled=true here
    // would make auto_start_all_enabled_agent_channels retry an unstartable
    // channel on every boot. The detail-view path checks this first (and shows a
    // specific toast); this guard also covers the list-view start button, which
    // has no precheck (issue #219 review).
    if (!channelHasCredentials(channels[cIdx])) {
      throw new Error(`startAndEnableAgentChannel: channel ${channelId} is missing required credentials`);
    }
    channels[cIdx] = { ...channels[cIdx], enabled: true };
    agents[aIdx] = { ...agents[aIdx], channels };
    return { ...config, agents };
  });
  // Re-read the freshly-written snapshot for invokeStartAgentChannel. Reading
  // from updatedConfig (return value of atomicModifyConfig) instead of looking
  // up again on disk keeps the start-time view consistent with what we just
  // persisted — even if another writer lands between persist and start.
  const freshAgent = updatedConfig.agents?.find(a => a.id === agentId);
  const freshChannel = freshAgent?.channels?.find(c => c.id === channelId);
  if (!freshAgent || !freshChannel) {
    // Shouldn't happen — modifier above throws on missing — but guard explicitly
    // so the runtime invoke doesn't get garbage.
    throw new Error(`startAndEnableAgentChannel: post-persist read of ${agentId}/${channelId} returned nothing`);
  }
  await invokeStartAgentChannel(freshAgent, freshChannel);
}
