import type { BackgroundAgentPermissionMode, ProxySettings } from '../../shared/config-types';
import type { RuntimeConfig, RuntimeSource } from '../../shared/types/runtime';
import type { RuntimeType } from '../../shared/types/runtime';
import type { McpServerDefinition } from '../../shared/config-types';
import type { EnqueueResult, PermissionMode, ProviderEnv, QueueCancelResult } from '../agent-session';
import type { InteractionScenario } from '../system-prompt';
import type { SessionSource, TurnAnalyticsSource } from '../types/session';
import type { SessionMessage } from '../types/session';
import type { ExternalRuntimeConfigPatch, ImagePayload } from '../runtimes/types';
import type { ExternalConfigSource } from '../runtimes/external-session';
import type { InboxTurnMeta } from '../inbox/types';
import type { ProviderRoute } from '../../shared/providerRoute';
import type { RuntimeBackedProviderIdentity } from '../../shared/providerExecution';
import type { OfficialToolId } from '../../shared/official-tools';
import type { RegisteredAgentSessionOrigin, SessionOrigin } from '../../shared/session-origin';
import type { SessionCompletionTerminal } from '../../shared/sessionCompletion';
import type {
  DispatchGuard,
  TurnIdentity,
  TurnOwner,
  TurnTerminalObserver,
} from '../session-core/turn-queue';

export type SessionEngineKind = 'builtin' | 'external';

export type RuntimeConfigPatch = ExternalRuntimeConfigPatch;

export type { PermissionMode, ProviderEnv } from '../agent-session';

export type DesktopMessageRequest = {
  text: string;
  images?: ImagePayload[];
  permissionMode?: PermissionMode;
  backgroundAgentPermissionMode?: BackgroundAgentPermissionMode;
  model?: string;
  providerRoute?: ProviderRoute;
  providerEnv?: ProviderEnv | 'subscription';
  reasoningEffort?: string;
  sessionId: string;
  workspacePath: string;
  scenario: Extract<InteractionScenario, { type: 'desktop' }>;
  analyticsSource?: TurnAnalyticsSource;
  analyticsOrigin?: SessionOrigin;
  birthOrigin?: SessionOrigin;
  turnBoundaryOnly?: boolean;
  /** Internal queue identity supplied by a domain owner such as Goal. */
  queueId?: string;
  turnOwner?: TurnOwner;
  onTerminal?: TurnTerminalObserver;
  beforeDispatch?: DispatchGuard;
};

export type DesktopAdmissionResult = {
  success: boolean;
  queued?: boolean;
  queueId?: string;
  isInFlight?: boolean;
  deliveryMode?: EnqueueResult['deliveryMode'];
  canCancel?: boolean;
  canForceExecute?: boolean;
  error?: string;
  status?: number;
  /** Internal dispatch acknowledgement; HTTP serializers must not expose it. */
  dispatchAcceptance?: Promise<{ accepted: boolean; error?: string }>;
};

export type ImMessageRequest = {
  message: string;
  images?: ImagePayload[];
  requestId: string;
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  permissionMode?: string;
  model?: string;
  providerRoute?: ProviderRoute;
  providerEnv?: ProviderEnv | 'subscription';
  reasoningEffort?: string;
  runtimeConfig?: RuntimeConfig | null;
  metadataBirthPending?: boolean;
  metadata?: { source: SessionSource; sourceId?: string; senderName?: string };
  analyticsOrigin?: SessionOrigin;
  turnBoundaryOnly?: boolean;
  queueId?: string;
  turnOwner?: TurnOwner;
  onTerminal?: TurnTerminalObserver;
  beforeDispatch?: DispatchGuard;
};

export type ImAdmissionResult = {
  success: boolean;
  queued?: boolean;
  error?: string;
  status?: number;
  dispatchAcceptance?: Promise<{ accepted: boolean; error?: string }>;
};

export type ImCancelResult = {
  aborted: boolean;
  mode: 'running' | 'queued' | 'unknown';
};

export type InboxMessageRequest = {
  text: string;
  sessionId: string;
  workspacePath: string;
  scenario?: InteractionScenario;
  inboxMeta?: InboxTurnMeta;
  allowLazySessionMaterialization?: boolean;
  analyticsOrigin?: SessionOrigin;
  birthOrigin?: SessionOrigin;
};

export type BackgroundMessageRequest = {
  text: string;
  images?: ImagePayload[];
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  permissionMode?: string;
  model?: string;
  providerRoute?: ProviderRoute;
  providerEnv?: ProviderEnv | 'subscription';
  reasoningEffort?: string;
  metadata?: { source: SessionSource; sourceId?: string; senderName?: string };
  analyticsOrigin?: SessionOrigin;
  turnBoundaryOnly?: boolean;
  queueId?: string;
  turnOwner?: TurnOwner;
  onTerminal?: TurnTerminalObserver;
  beforeDispatch?: DispatchGuard;
};

export type InjectedTurnRequest = {
  prompt: string;
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  metadataBirthPending?: boolean;
  permissionMode?: string;
  model?: string;
  reasoningEffort?: string;
  providerEnv?: ProviderEnv | 'subscription';
  providerRoute?: ProviderRoute;
  runtimeConfig?: RuntimeConfig | null;
  metadata?: { source: SessionSource; sourceId?: string; senderName?: string };
  analyticsOrigin?: SessionOrigin;
  timeoutMs: number;
  pollMs?: number;
  queueId?: string;
  turnOwner?: TurnOwner;
  onTerminal?: TurnTerminalObserver;
  /** Final authority check at the runtime promotion boundary. */
  beforeDispatch?: DispatchGuard;
};

export type InjectedTurnResult = {
  success: boolean;
  enqueued?: boolean;
  /** The turn may still be alive and must remain addressable by its exact queue identity. */
  terminationUnconfirmed?: boolean;
  assistantMessagePresent?: boolean;
  text?: string;
  error?: string;
  status?: number;
};

export type QueueStatusItem = { id: string; messagePreview: string };

export type SessionEngineRuntimeIdentity = {
  kind: SessionEngineKind;
  runtime: RuntimeType;
  runtimeSource?: RuntimeSource;
  sessionId: string;
  boundSessionId?: string;
};

export type SessionEngineLiveState = {
  sessionState: string;
  isBusy: boolean;
};

export type SessionEngineLatestResult = {
  sessionId: string;
  latestResult: string;
};

export type SessionEnginePendingInteractiveRequest = {
  type: string;
  data: unknown;
};

export type CapabilityOperationAttachment = {
  id: string;
  name: string;
  size?: number;
  mimeType: string;
  path?: string;
  savedPath?: string;
  relativePath?: string;
  previewUrl?: string;
  isImage?: boolean;
};

export type SessionEngineReplayMessage = Omit<SessionMessage, 'content' | 'attachments'> & {
  content: string | unknown[];
  attachments?: CapabilityOperationAttachment[];
};

export type SessionEngineStreamReplaySnapshot = {
  initState: Record<string, unknown>;
  replayMessages: SessionEngineReplayMessage[];
  systemInitPayload?: unknown;
  pendingInteractiveRequests: SessionEnginePendingInteractiveRequest[];
};

export type SessionEngineConfigSnapshot = {
  success: true;
  runtime: RuntimeType;
  runtimeSource?: RuntimeSource;
  model: string | null;
  mcpServerIds: string[] | null;
  agentNames: string[] | null;
  enabledOfficialToolIds: OfficialToolId[] | null;
  permissionMode: string | null;
  providerId: string | null;
  providerRoute?: ProviderRoute | null;
  providerExecutionIdentity?: RuntimeBackedProviderIdentity | null;
  reasoningEffort: string | null;
};

export type SessionEngineCurrentContext = {
  runtime: RuntimeType;
  sessionId: string | null;
  workspacePath: string | null;
  sessionMeta?: import('../types/session').SessionMetadata | null;
};

export type SessionEngineHeldImConfigSnapshot = {
  model?: string;
  permissionMode?: string;
  providerEnv?: ProviderEnv;
  reasoningEffort?: string;
};

export type SessionEngineSnapshotMaterializePatch = {
  model?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: string | null;
  mcpEnabledServers?: string[] | null;
  enabledPluginIds?: string[] | null;
  enabledOfficialToolIds?: OfficialToolId[] | null;
  providerId?: string | null;
  providerRoute?: ProviderRoute | null;
  providerExecutionIdentity?: RuntimeBackedProviderIdentity | null;
  providerEnvJson?: string | null;
};

export type SessionEngineMaterializePendingResult = {
  success: boolean;
  sessionId?: string;
  metadata?: unknown;
  error?: string;
  status?: number;
};

export type SessionEngineLiveOverlay = {
  isActive: boolean;
  runtime?: RuntimeType;
  snapshotRevision?: number;
  liveStreamingMessage?: SessionMessage | null;
  liveSessionState?: string;
  inMemoryMessages?: SessionMessage[];
  pendingInteractiveRequests?: SessionEnginePendingInteractiveRequest[];
};

export type CapabilityOperationResult = {
  success: boolean;
  error?: string;
  status?: number;
  content?: string;
  attachments?: CapabilityOperationAttachment[];
  newSessionId?: string;
  agentDir?: string;
  title?: string;
  sessionId?: string;
  text?: string;
  images?: ImagePayload[];
};

export interface SessionEngine {
  kind: SessionEngineKind;
  isBusy(): boolean;
  getRuntimeIdentity(): SessionEngineRuntimeIdentity;
  getLiveSessionState(): SessionEngineLiveState;
  getLatestAssistantResult(): SessionEngineLatestResult;
  getStreamReplaySnapshot(): SessionEngineStreamReplaySnapshot;
  getSessionConfigSnapshot(): SessionEngineConfigSnapshot;
  getCurrentSessionContext(): SessionEngineCurrentContext;
  getSessionOrigin(sessionId: string): SessionOrigin | undefined;
  ensureRegisteredAgentSessionOrigin(
    sessionId: string,
    expected: RegisteredAgentSessionOrigin,
  ): Promise<{ success: boolean; metadataExists?: boolean; adoptedLegacyOrigin?: boolean; error?: string }>;
  getCurrentTurnIdentity(): TurnIdentity | null;
  getSessionCompletionTerminal(): SessionCompletionTerminal | null;
  hasQueuedTurnOwnedBy(owner: TurnOwner): boolean;
  getHeldImConfigSnapshot(): SessionEngineHeldImConfigSnapshot;
  getLiveSessionOverlay(sessionId: string): SessionEngineLiveOverlay;
  sendDesktopMessage(request: DesktopMessageRequest): Promise<DesktopAdmissionResult>;
  enqueueImMessage(request: ImMessageRequest): Promise<ImAdmissionResult>;
  cancelImRequest(requestId: string, reason?: string): Promise<ImCancelResult>;
  enqueueBackgroundMessage(request: BackgroundMessageRequest): Promise<ImAdmissionResult>;
  enqueueInboxMessage(request: InboxMessageRequest): Promise<{ queued: boolean; error?: string }>;
  ensureGoalSessionConfig(): Promise<{ success: boolean; error?: string }>;
  runInjectedTurn(request: InjectedTurnRequest): Promise<InjectedTurnResult>;
  stopTurn(options?: { preserveQueue?: boolean }): Promise<{ success: boolean; alreadyStopped?: boolean; error?: string }>;
  stopOwnedTurn(owner: TurnOwner): Promise<{ success: boolean; alreadyStopped?: boolean; error?: string }>;
  cancelQueuedMessage(queueId: string): Promise<QueueCancelResult>;
  forceQueuedMessage(queueId: string): Promise<boolean>;
  getQueueStatus(): QueueStatusItem[];
  waitIdle(timeoutMs: number, pollMs?: number): Promise<boolean>;
  updateModel(model: string, opts?: { imConfigSync?: boolean }): Promise<{ success: boolean; error?: string }>;
  updatePermissionMode(mode: string): Promise<{ success: boolean; error?: string }>;
  updateReasoningEffort(effort: string): Promise<{ success: boolean; error?: string }>;
  updateOfficialToolIds(ids: OfficialToolId[] | null): Promise<{ success: boolean; error?: string; skipped?: string }>;
  updateProxyConfig(proxySettings: ProxySettings | null): Promise<{ success: boolean; error?: string; skipped?: string }>;
  materializePendingDesktopSession(request: {
    workspacePath: string;
    phase?: 'prepare' | 'commit' | 'rollback';
    preparedSessionId?: string;
    snapshotPatch?: SessionEngineSnapshotMaterializePatch;
    origin?: SessionOrigin;
  }): Promise<SessionEngineMaterializePendingResult>;
  freezeCurrentSessionForImDetach(options?: {
    metadataBirthPending?: boolean;
    metadataIndexed?: boolean;
  }): Promise<{
    success: boolean;
    sessionId?: string;
    metadata?: unknown;
    error?: string;
  }>;
  updateRuntimeConfig(
    patch: RuntimeConfigPatch,
    options?: { source?: ExternalConfigSource },
  ): Promise<{ success: boolean; error?: string; skipped?: string }>;
  prewarm(options: {
    sessionId: string;
    workspacePath: string;
    model?: string;
    permissionMode?: string;
  }): Promise<Record<string, unknown>>;
  restoreInitialSession(sessionId: string, workspacePath: string): boolean;
  respondPermission(
    requestId: string,
    decision: 'deny' | 'allow_once' | 'always_allow',
    reason?: string,
  ): Promise<boolean>;
  respondAskUserQuestion(requestId: string, answers: Record<string, string> | null): Promise<boolean>;
  rewindToUserMessage(userMessageId: string): Promise<CapabilityOperationResult>;
  retryLastExternalUserMessage(userMessageId: string): Promise<CapabilityOperationResult>;
  forkAtAssistantMessage(messageId: string): Promise<CapabilityOperationResult>;
  updateProviderEnv(providerEnv: ProviderEnv | undefined): Promise<{ success: boolean; skipped?: string; error?: string }>;
  updateMcpServers(servers: McpServerDefinition[]): Promise<{ success: boolean; servers?: string[]; skipped?: string; error?: string }>;
  updateAgents(agents: Record<string, unknown>): Promise<{ success: boolean; skipped?: string; error?: string }>;
  updateDesktopInteractionScenario(
    scenario: Extract<InteractionScenario, { type: 'desktop' }>,
  ): Promise<{ success: boolean; skipped?: string; error?: string }>;
  switchToExistingSession(
    sessionId: string,
    workspacePath: string,
    getSessionMetadata: (sessionId: string) => { runtime?: RuntimeType; runtimeSource?: RuntimeSource } | null | undefined,
  ): Promise<{ success: boolean; sessionId?: string; error?: string; status?: number }>;
  resetForNewDesktopSession(workspacePath: string): Promise<{ success: boolean; sessionId?: string; error?: string }>;
  resetForNewImSession(
    workspacePath: string,
    options?: { metadataBirthPending?: boolean; metadataIndexed?: boolean },
  ): Promise<{ success: boolean; sessionId?: string; error?: string }>;
}
