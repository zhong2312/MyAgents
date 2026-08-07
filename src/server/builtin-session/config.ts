import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { BackgroundAgentPermissionMode, McpServerDefinition } from '../../shared/config-types';
import type { OfficialToolId } from '../../shared/official-tools';
import {
  canResumeAcrossProviderBoundary,
  type ProviderHistoryEnv,
} from '../../shared/providerHistory';
import { DEFAULT_BACKGROUND_AGENT_PERMISSION_MODE } from '../utils/background-agent-permission';
import { modelAliasEnvChangesForModel } from '../utils/model-aliases';
import { decideMcpSync } from '../session-core/mcp-sync-policy';
import {
  shouldApplySnapshotConfigUpdate,
  type RuntimeConfigPolicySource,
  type SnapshotConfigField,
} from '../session-core/runtime-config-policy';
import type { ProviderEnv } from '../provider-types';
import type { BuiltinConfigSnapshot, BuiltinRestartReason, PermissionMode } from './types';

const pendingConfigRestart = new Set<BuiltinRestartReason>();
let currentMcpServers: McpServerDefinition[] | null = null;
let frozenSdkMcpFingerprint = '';
let currentEnabledPluginIds: string[] | null = null;
let currentEnabledOfficialToolIds: OfficialToolId[] | null = null;
let currentAgentDefinitions: Record<string, AgentDefinition> | null = null;
let currentPermissionMode: PermissionMode = 'auto';
let prePlanPermissionMode: PermissionMode | null = null;
let currentBackgroundAgentPermissionMode: BackgroundAgentPermissionMode = DEFAULT_BACKGROUND_AGENT_PERMISSION_MODE;
let currentModel: string | undefined = undefined;
let currentReasoningEffort: string | undefined = undefined;
let currentProviderEnv: ProviderEnv | undefined = undefined;
let currentWorkbenchSystemPrompt: string | undefined = undefined;
let pendingProviderHistoryBoundaryReset = false;

export const configState = {
  get currentMcpServers(): McpServerDefinition[] | null {
    return currentMcpServers;
  },
  set currentMcpServers(servers: McpServerDefinition[] | null) {
    currentMcpServers = servers;
  },
  get frozenSdkMcpFingerprint(): string {
    return frozenSdkMcpFingerprint;
  },
  set frozenSdkMcpFingerprint(fingerprint: string) {
    frozenSdkMcpFingerprint = fingerprint;
  },
  get currentEnabledPluginIds(): string[] | null {
    return currentEnabledPluginIds;
  },
  set currentEnabledPluginIds(ids: string[] | null) {
    currentEnabledPluginIds = ids;
  },
  get currentEnabledOfficialToolIds(): OfficialToolId[] | null {
    return currentEnabledOfficialToolIds;
  },
  set currentEnabledOfficialToolIds(ids: OfficialToolId[] | null) {
    currentEnabledOfficialToolIds = ids;
  },
  get currentAgentDefinitions(): Record<string, AgentDefinition> | null {
    return currentAgentDefinitions;
  },
  set currentAgentDefinitions(agents: Record<string, AgentDefinition> | null) {
    currentAgentDefinitions = agents;
  },
  get currentPermissionMode(): PermissionMode {
    return currentPermissionMode;
  },
  set currentPermissionMode(mode: PermissionMode) {
    currentPermissionMode = mode;
  },
  get prePlanPermissionMode(): PermissionMode | null {
    return prePlanPermissionMode;
  },
  set prePlanPermissionMode(mode: PermissionMode | null) {
    prePlanPermissionMode = mode;
  },
  get currentBackgroundAgentPermissionMode(): BackgroundAgentPermissionMode {
    return currentBackgroundAgentPermissionMode;
  },
  set currentBackgroundAgentPermissionMode(mode: BackgroundAgentPermissionMode) {
    currentBackgroundAgentPermissionMode = mode;
  },
  get currentModel(): string | undefined {
    return currentModel;
  },
  set currentModel(model: string | undefined) {
    currentModel = model;
  },
  get currentReasoningEffort(): string | undefined {
    return currentReasoningEffort;
  },
  set currentReasoningEffort(value: string | undefined) {
    currentReasoningEffort = value;
  },
  get currentProviderEnv(): ProviderEnv | undefined {
    return currentProviderEnv;
  },
  set currentProviderEnv(providerEnv: ProviderEnv | undefined) {
    currentProviderEnv = providerEnv;
  },
  get currentWorkbenchSystemPrompt(): string | undefined {
    return currentWorkbenchSystemPrompt;
  },
  set currentWorkbenchSystemPrompt(prompt: string | undefined) {
    currentWorkbenchSystemPrompt = prompt;
  },
  get pendingProviderHistoryBoundaryReset(): boolean {
    return pendingProviderHistoryBoundaryReset;
  },
  set pendingProviderHistoryBoundaryReset(value: boolean) {
    pendingProviderHistoryBoundaryReset = value;
  },
};

export function scheduleDeferredRestart(reason: BuiltinRestartReason): void {
  pendingConfigRestart.add(reason);
}

export function hasDeferredRestart(): boolean {
  return pendingConfigRestart.size > 0;
}

export function drainDeferredRestart(): string {
  if (pendingConfigRestart.size === 0) return '';
  const reasons = [...pendingConfigRestart].join(',');
  pendingConfigRestart.clear();
  return reasons;
}

export function clearDeferredRestart(): void {
  pendingConfigRestart.clear();
}

export function shouldApplyConfigUpdate(params: {
  field: SnapshotConfigField;
  source: RuntimeConfigPolicySource;
  isSnapshotted: boolean;
}): boolean {
  return shouldApplySnapshotConfigUpdate(params);
}

export function getCurrentMcpServers(): readonly McpServerDefinition[] | null {
  return currentMcpServers;
}

export function setCurrentMcpServers(servers: McpServerDefinition[] | null): void {
  currentMcpServers = servers;
}

export function applyMcpServersUpdate(
  servers: McpServerDefinition[],
  params: {
    hasQuerySession: boolean;
  },
): ReturnType<typeof decideMcpSync> & { applied: boolean } {
  const decision = decideMcpSync({
    previousServers: currentMcpServers ?? [],
    nextServers: servers,
    hasQuerySession: params.hasQuerySession,
  });
  currentMcpServers = servers;
  return { ...decision, applied: true };
}

export function getFrozenSdkMcpFingerprint(): string {
  return frozenSdkMcpFingerprint;
}

export function setFrozenSdkMcpFingerprint(fingerprint: string): void {
  frozenSdkMcpFingerprint = fingerprint;
}

export function getSessionEnabledPluginIds(): readonly string[] | null {
  return currentEnabledPluginIds;
}

export function setSessionEnabledPluginIds(ids: string[] | null): void {
  currentEnabledPluginIds = ids === null ? null : [...ids];
}

export function getSessionEnabledOfficialToolIds(): readonly OfficialToolId[] | null {
  return currentEnabledOfficialToolIds;
}

export function setSessionEnabledOfficialToolIds(ids: readonly OfficialToolId[] | null): void {
  currentEnabledOfficialToolIds = ids === null ? null : [...ids];
}

export function getCurrentAgentDefinitions(): Record<string, AgentDefinition> | null {
  return currentAgentDefinitions;
}

export function setCurrentAgentDefinitions(agents: Record<string, AgentDefinition> | null): void {
  currentAgentDefinitions = agents;
}

export function agentDefinitionsFingerprint(agents: Record<string, AgentDefinition> | null): string {
  if (!agents) return '';
  return JSON.stringify(
    Object.keys(agents)
      .sort()
      .map(name => {
        const agent = agents[name];
        return {
          name,
          description: agent.description,
          prompt: agent.prompt,
          tools: agent.tools,
          disallowedTools: agent.disallowedTools,
          model: agent.model,
          skills: agent.skills,
          maxTurns: agent.maxTurns,
        };
      }),
  );
}

export function applyAgentDefinitionsUpdate(
  agents: Record<string, AgentDefinition>,
  params: {
    hasQuerySession: boolean;
    isSnapshotted: boolean;
  },
): { changed: boolean; shouldRestart: boolean; applied: boolean; reason: 'unchanged' | 'no-active-session' | 'snapshot-authoritative' | 'fingerprint-changed' } {
  const changed = agentDefinitionsFingerprint(currentAgentDefinitions) !== agentDefinitionsFingerprint(agents);
  if (!changed) return { changed: false, shouldRestart: false, applied: true, reason: 'unchanged' };
  if (!params.hasQuerySession) {
    currentAgentDefinitions = agents;
    return { changed: true, shouldRestart: false, applied: true, reason: 'no-active-session' };
  }
  if (params.isSnapshotted) return { changed: true, shouldRestart: false, applied: false, reason: 'snapshot-authoritative' };
  currentAgentDefinitions = agents;
  return { changed: true, shouldRestart: true, applied: true, reason: 'fingerprint-changed' };
}

export function getPermissionMode(): PermissionMode {
  return currentPermissionMode;
}

export function setPermissionMode(mode: PermissionMode): void {
  currentPermissionMode = mode;
}

export function getPrePlanPermissionMode(): PermissionMode | null {
  return prePlanPermissionMode;
}

export function setPrePlanPermissionMode(mode: PermissionMode | null): void {
  prePlanPermissionMode = mode;
}

export function setPermissionPlanState(state: {
  permissionMode: PermissionMode;
  prePlanPermissionMode: PermissionMode | null;
}): void {
  currentPermissionMode = state.permissionMode;
  prePlanPermissionMode = state.prePlanPermissionMode;
}

export function getBackgroundAgentPermissionMode(): BackgroundAgentPermissionMode {
  return currentBackgroundAgentPermissionMode;
}

export function setBackgroundAgentPermissionMode(mode: BackgroundAgentPermissionMode): void {
  currentBackgroundAgentPermissionMode = mode;
}

export function getModel(): string | undefined {
  return currentModel;
}

export function setModel(model: string | undefined): void {
  currentModel = model;
}

export function toProviderHistoryEnv(providerEnv: ProviderEnv | undefined, model?: string): ProviderHistoryEnv | undefined {
  if (!providerEnv) return model ? { model } : undefined;
  return {
    providerId: providerEnv.providerId,
    baseUrl: providerEnv.baseUrl,
    apiProtocol: providerEnv.apiProtocol,
    model,
  };
}

export function canResumeAcrossBuiltinProviderHistory(params: {
  currentProviderEnv: ProviderEnv | undefined;
  currentModel: string | undefined;
  nextProviderEnv: ProviderEnv | undefined;
  nextModel: string | undefined;
}): boolean {
  return canResumeAcrossProviderBoundary(
    toProviderHistoryEnv(params.currentProviderEnv, params.currentModel),
    toProviderHistoryEnv(params.nextProviderEnv, params.nextModel),
  );
}

export function applyModelUpdate(
  model: string,
  params: {
    source: RuntimeConfigPolicySource;
    isSnapshotted: boolean;
  },
): {
  applied: boolean;
  changed: boolean;
  reason: 'unchanged' | 'snapshot-authoritative' | 'updated';
  oldModel: string | undefined;
  newModel: string;
  crossesProviderHistoryBoundary: boolean;
  aliasEnvChanged: boolean;
} {
  const oldModel = currentModel;
  if (model === oldModel) {
    return {
      applied: false,
      changed: false,
      reason: 'unchanged',
      oldModel,
      newModel: model,
      crossesProviderHistoryBoundary: false,
      aliasEnvChanged: false,
    };
  }
  if (!shouldApplyConfigUpdate({ field: 'model', source: params.source, isSnapshotted: params.isSnapshotted })) {
    return {
      applied: false,
      changed: true,
      reason: 'snapshot-authoritative',
      oldModel,
      newModel: model,
      crossesProviderHistoryBoundary: false,
      aliasEnvChanged: false,
    };
  }
  const crossesProviderHistoryBoundary = !canResumeAcrossBuiltinProviderHistory({
    currentProviderEnv,
    currentModel: oldModel,
    nextProviderEnv: currentProviderEnv,
    nextModel: model,
  });
  const aliasEnvChanged = modelAliasEnvChangesForModel(currentProviderEnv?.modelAliases, oldModel, model);
  currentModel = model;
  return {
    applied: true,
    changed: true,
    reason: 'updated',
    oldModel,
    newModel: model,
    crossesProviderHistoryBoundary,
    aliasEnvChanged,
  };
}

export function getReasoningEffort(): string | undefined {
  return currentReasoningEffort;
}

export function setReasoningEffort(value: string | undefined): void {
  currentReasoningEffort = value;
}

export function applyReasoningEffortUpdate(value: string | undefined): {
  changed: boolean;
  oldValue: string | undefined;
  newValue: string | undefined;
  providerApiProtocol: ProviderEnv['apiProtocol'] | undefined;
} {
  const oldValue = currentReasoningEffort;
  if (oldValue === value) {
    return {
      changed: false,
      oldValue,
      newValue: value,
      providerApiProtocol: currentProviderEnv?.apiProtocol,
    };
  }
  currentReasoningEffort = value;
  return {
    changed: true,
    oldValue,
    newValue: value,
    providerApiProtocol: currentProviderEnv?.apiProtocol,
  };
}

export function getProviderEnv(): ProviderEnv | undefined {
  return currentProviderEnv;
}

export function setProviderEnv(providerEnv: ProviderEnv | undefined): void {
  currentProviderEnv = providerEnv;
}

export function providerEnvEqual(a: ProviderEnv | undefined, b: ProviderEnv | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.providerId === b.providerId
    && a.baseUrl === b.baseUrl
    && a.apiKey === b.apiKey
    && a.authType === b.authType
    && a.apiProtocol === b.apiProtocol
    && a.maxOutputTokens === b.maxOutputTokens
    && a.maxOutputTokensParamName === b.maxOutputTokensParamName
    && a.upstreamFormat === b.upstreamFormat
    && a.credentialSource?.kind === b.credentialSource?.kind
    && a.credentialSource?.providerId === b.credentialSource?.providerId
    && a.modelAliases?.fable === b.modelAliases?.fable
    && a.modelAliases?.sonnet === b.modelAliases?.sonnet
    && a.modelAliases?.opus === b.modelAliases?.opus
    && a.modelAliases?.haiku === b.modelAliases?.haiku;
}

export function applyProviderEnvUpdate(
  providerEnv: ProviderEnv | undefined,
  params: {
    source: RuntimeConfigPolicySource;
    isSnapshotted: boolean;
  },
): {
  applied: boolean;
  changed: boolean;
  reason: 'unchanged' | 'snapshot-authoritative' | 'updated';
  oldProviderEnv: ProviderEnv | undefined;
  newProviderEnv: ProviderEnv | undefined;
  crossesProviderHistoryBoundary: boolean;
} {
  const oldProviderEnv = currentProviderEnv;
  if (providerEnvEqual(oldProviderEnv, providerEnv)) {
    return {
      applied: false,
      changed: false,
      reason: 'unchanged',
      oldProviderEnv,
      newProviderEnv: providerEnv,
      crossesProviderHistoryBoundary: false,
    };
  }
  if (!shouldApplyConfigUpdate({ field: 'provider', source: params.source, isSnapshotted: params.isSnapshotted })) {
    return {
      applied: false,
      changed: true,
      reason: 'snapshot-authoritative',
      oldProviderEnv,
      newProviderEnv: providerEnv,
      crossesProviderHistoryBoundary: false,
    };
  }
  const crossesProviderHistoryBoundary = !canResumeAcrossBuiltinProviderHistory({
    currentProviderEnv: oldProviderEnv,
    currentModel,
    nextProviderEnv: providerEnv,
    nextModel: currentModel,
  });
  currentProviderEnv = providerEnv;
  return {
    applied: true,
    changed: true,
    reason: 'updated',
    oldProviderEnv,
    newProviderEnv: providerEnv,
    crossesProviderHistoryBoundary,
  };
}

export function hasPendingProviderHistoryBoundaryReset(): boolean {
  return pendingProviderHistoryBoundaryReset;
}

export function setPendingProviderHistoryBoundaryReset(value: boolean): void {
  pendingProviderHistoryBoundaryReset = value;
}

export function consumePendingProviderHistoryBoundaryReset(): boolean {
  const value = pendingProviderHistoryBoundaryReset;
  pendingProviderHistoryBoundaryReset = false;
  return value;
}

export function snapshotConfig(): BuiltinConfigSnapshot {
  return {
    mcpServers: currentMcpServers ? [...currentMcpServers] : null,
    enabledPluginIds: currentEnabledPluginIds ? [...currentEnabledPluginIds] : null,
    enabledOfficialToolIds: currentEnabledOfficialToolIds ? [...currentEnabledOfficialToolIds] : null,
    agentDefinitions: currentAgentDefinitions,
    permissionMode: currentPermissionMode,
    prePlanPermissionMode,
    backgroundAgentPermissionMode: currentBackgroundAgentPermissionMode,
    model: currentModel,
    reasoningEffort: currentReasoningEffort,
    providerEnv: currentProviderEnv,
    pendingProviderHistoryBoundaryReset,
    frozenSdkMcpFingerprint,
    deferredRestartReasons: [...pendingConfigRestart],
  };
}

export function resetConfigForTest(): void {
  pendingConfigRestart.clear();
  currentMcpServers = null;
  frozenSdkMcpFingerprint = '';
  currentEnabledPluginIds = null;
  currentEnabledOfficialToolIds = null;
  currentAgentDefinitions = null;
  currentPermissionMode = 'auto';
  prePlanPermissionMode = null;
  currentBackgroundAgentPermissionMode = DEFAULT_BACKGROUND_AGENT_PERMISSION_MODE;
  currentModel = undefined;
  currentReasoningEffort = undefined;
  currentProviderEnv = undefined;
  pendingProviderHistoryBoundaryReset = false;
}
