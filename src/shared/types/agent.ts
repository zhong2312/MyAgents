// Agent architecture types (v0.1.41)
// Agent = upgraded workspace with pluggable I/O channels

import type {
  ImPlatform,
  HeartbeatConfig,
  MemoryAutoUpdateConfig,
  MemoryEvolutionConfig,
  GroupPermission,
  GroupActivation,
} from './im';
import {
  getDefaultRuntimePermissionMode,
  getMaxPermissionForRuntime,
  normalizeRuntime,
  projectPermissionModeForRuntime,
  type RuntimeType,
  type RuntimeConfig,
} from './runtime';
import {
  agentUsesManagedCodexProvider,
  managedCodexRuntimePermissionToProviderPermission,
} from '../providerExecution';
import type { OfficialToolId } from '../official-tools';
import type { ProjectCapabilitySelectionV1 } from '../projectCapabilities';

/**
 * Channel type — reuses ImPlatform, not redefined
 */
export type ChannelType = ImPlatform;

/**
 * Last active channel tracking for heartbeat/cron routing
 */
export interface LastActiveChannel {
  channelId: string;
  sessionKey: string;
  lastActiveAt: string; // ISO timestamp
}

/**
 * Private-only heartbeat/cron target tracking.
 * LastActiveChannel may point at a group; heartbeat delivery never should.
 */
export interface LastActivePrivateTarget {
  channelId: string;
  sessionKey: string;
  lastActiveAt: string; // ISO timestamp
}

/**
 * Channel-level config overrides (empty = inherit from Agent)
 */
export interface ChannelOverrides {
  providerId?: string;
  providerEnvJson?: string;
  model?: string;
  runtime?: RuntimeType;
  runtimeConfig?: RuntimeConfig;
  permissionMode?: string;
  toolsDeny?: string[];
}

/**
 * Channel configuration — a single I/O endpoint within an Agent
 */
export interface ChannelConfig {
  // Identity
  id: string;
  type: ChannelType;
  name?: string;           // Defaults to platform display name
  enabled: boolean;

  // Platform credentials (vary by type)
  botToken?: string;
  telegramUseDraft?: boolean;

  feishuAppId?: string;
  feishuAppSecret?: string;

  dingtalkClientId?: string;
  dingtalkClientSecret?: string;
  dingtalkUseAiCard?: boolean;
  dingtalkCardTemplateId?: string;

  // OpenClaw Plugin
  openclawPluginId?: string;
  openclawNpmSpec?: string;
  openclawPluginConfig?: Record<string, unknown>;
  openclawManifest?: Record<string, string>;
  /** Enabled tool groups for OpenClaw plugins with tools (e.g. feishu) */
  openclawEnabledToolGroups?: string[];

  // User management
  allowedUsers?: string[];

  // Group chat
  groupPermissions?: GroupPermission[];
  groupActivation?: GroupActivation;

  // Optional overrides (empty/undefined = inherit from Agent)
  overrides?: ChannelOverrides;

  // Runtime
  setupCompleted?: boolean;
}

/**
 * Agent configuration — an upgraded workspace with AI config and channels
 */
export interface AgentConfig {
  // Identity
  id: string;
  name: string;
  icon?: string;           // Phosphor icon ID or emoji
  enabled: boolean;

  // AI Configuration (defaults for all channels)
  providerId?: string;
  model?: string;
  providerEnvJson?: string;
  permissionMode: string;  // 'plan' | 'auto' | 'fullAgency'
  /** #324 — builtin-runtime reasoning effort default ('default' | level; see
   *  shared/reasoningEffort.ts). External runtimes use runtimeConfig.reasoningEffort. */
  reasoningEffort?: string;
  mcpEnabledServers?: string[];
  /** Resolved MCP server definitions JSON (persisted for auto-start, rebuilt on manual start) */
  mcpServersJson?: string;
  /** PRD 0.2.17 — Claude plugins enabled for this Agent (subset of globally
   *  visible plugins; gated by AppConfig.enabledPlugins). Sessions started from
   *  this Agent inherit this list as their initial selection; per-Tab UI can
   *  override transiently. Mirrors mcpEnabledServers semantics exactly. */
  enabledPluginIds?: string[];
  /** MyAgents official CLI tools enabled for this Agent. Separate from MCP/plugin ids. */
  enabledOfficialToolIds?: OfficialToolId[];
  /** Per-project Skill/Command disabled overrides. The owning Project selects
   * this Agent by stable `agentId`; workspace files never mirror the value. */
  capabilitySelection?: ProjectCapabilitySelectionV1;

  // Heartbeat (Agent-level, shared across channels)
  heartbeat?: HeartbeatConfig;

  // Memory Auto-Update (v0.1.43)
  memoryAutoUpdate?: MemoryAutoUpdateConfig;

  // Long-term Memory Evolution (v0.2.49)
  memoryEvolution?: MemoryEvolutionConfig;

  // Channels
  channels: ChannelConfig[];

  // Active message routing
  lastActiveChannel?: LastActiveChannel;
  lastActivePrivateTarget?: LastActivePrivateTarget;

  // Agent Runtime (v0.1.59)
  runtime?: RuntimeType;           // 'builtin' | 'claude-code' | 'codex', defaults to 'builtin'
  runtimeConfig?: RuntimeConfig;   // Runtime-specific model/permission/args

  // Runtime
  setupCompleted?: boolean;
}

function resolveAgentChannelProviderId(agent: AgentConfig, channel: ChannelConfig): string | undefined {
  return channel.overrides?.providerId ?? agent.providerId;
}

export function agentChannelUsesManagedCodexProvider(
  agent: AgentConfig,
  channel: ChannelConfig,
): boolean {
  return agentUsesManagedCodexProvider({
    providerId: resolveAgentChannelProviderId(agent, channel),
    runtime: channel.overrides?.runtime ?? agent.runtime,
    runtimeConfig: channel.overrides?.runtimeConfig ?? agent.runtimeConfig,
  });
}

/**
 * Resolve the runtime that an Agent Channel will execute on. Channel overrides
 * mirror the Rust start path and win over Agent defaults. Runtime-backed
 * providers are projected here so the renderer/shared view matches Rust
 * `ChannelConfigRust::to_im_config`.
 */
export function resolveAgentChannelRuntime(agent: AgentConfig, channel: ChannelConfig): RuntimeType {
  const runtime = normalizeRuntime(channel.overrides?.runtime ?? agent.runtime ?? 'builtin');
  return agentChannelUsesManagedCodexProvider(agent, channel)
    ? 'codex'
    : runtime;
}

export function resolveAgentChannelDefaultPermissionMode(agent: AgentConfig, channel: ChannelConfig): string {
  if (agentChannelUsesManagedCodexProvider(agent, channel)) {
    return 'fullAgency';
  }
  return getMaxPermissionForRuntime(resolveAgentChannelRuntime(agent, channel));
}

/**
 * IM / Agent Channel is an unattended entry point: when the channel itself has
 * no explicit permission override, default to the selected runtime's maximum
 * agency rather than inheriting the desktop Agent permission mode.
 */
export function resolveAgentChannelPermissionMode(agent: AgentConfig, channel: ChannelConfig): string {
  const override = channel.overrides?.permissionMode?.trim();
  if (override) {
    if (agentChannelUsesManagedCodexProvider(agent, channel)) {
      return managedCodexRuntimePermissionToProviderPermission(override) ?? 'auto';
    }
    const runtime = resolveAgentChannelRuntime(agent, channel);
    return projectPermissionModeForRuntime(override, runtime)
      ?? getDefaultRuntimePermissionMode(runtime);
  }
  return resolveAgentChannelDefaultPermissionMode(agent, channel);
}

/**
 * Resolve effective config for a channel by merging Agent defaults with Channel overrides
 */
export function resolveEffectiveConfig(agent: AgentConfig, channel: ChannelConfig) {
  const runtime = resolveAgentChannelRuntime(agent, channel);
  return {
    providerId: channel.overrides?.providerId ?? agent.providerId,
    providerEnvJson: channel.overrides?.providerEnvJson ?? agent.providerEnvJson,
    model: channel.overrides?.model ?? agent.model,
    permissionMode: resolveAgentChannelPermissionMode(agent, channel),
    mcpEnabledServers: agent.mcpEnabledServers,      // Channel cannot override
    enabledPluginIds: agent.enabledPluginIds,        // Channel cannot override (mirrors MCP)
    toolsDeny: channel.overrides?.toolsDeny ?? [],
    heartbeat: agent.heartbeat,                       // Always Agent's
    runtime,
    runtimeConfig: channel.overrides?.runtimeConfig ?? agent.runtimeConfig,
  };
}
