import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    useExternal: false,
    externalActive: false,
    externalBusy: false,
    externalProcessAlive: false,
    builtinTurnIdentity: null as { queueId: string; owner: { kind: 'goal' | 'task'; id: string } } | null,
    builtinDispatchedQueueId: null as string | null,
    externalTurnIdentity: null as { queueId: string; owner: { kind: 'goal' | 'task'; id: string } } | null,
    externalCurrentQueueId: null as string | null,
    pendingExternalAsk: false,
  };

  return {
    state,
    broadcast: vi.fn(),
    applyMcpOverrideAndAwaitReady: vi.fn(async () => undefined),
    cancelBuiltinImRequest: vi.fn(async () => ({ aborted: false, mode: 'unknown' as const })),
    cancelQueueItem: vi.fn<() => Promise<
      | { status: 'cancelled'; cancelledText: string }
      | { status: 'not_found' | 'not_cancelled' | 'unavailable' | 'error' }
    >>(async () => ({ status: 'not_found' as const })),
    cancelQueuedTurnsByOwner: vi.fn(async () => 0),
    enqueueUserMessage: vi.fn<(...args: unknown[]) => Promise<{
      queued: boolean;
      queueId?: string;
      isInFlight?: boolean;
      deliveryMode?: 'queue' | 'realtime' | 'turn';
      error?: string;
      dispatchAcceptance?: Promise<{ accepted: boolean; error?: string }>;
    }>>(async (...args: unknown[]) => {
      const options = args[11] as {
        queueId?: string;
        beforeUserPersistence?: () => Promise<{ accepted: boolean; error?: string }>;
        beforeDispatch?: () => Promise<{
          accepted: boolean;
          error?: string;
          validateAtCommit?: () => { accepted: boolean; error?: string };
        }>;
        onTerminal?: (outcome: {
          status: 'complete' | 'stopped';
          assistantMessagePresent: boolean;
          text: string;
          error?: string;
        }) => void;
      } | undefined;
      const persistenceAcceptance = await options?.beforeUserPersistence?.();
      if (persistenceAcceptance && !persistenceAcceptance.accepted) {
        return {
          queued: false,
          queueId: options?.queueId ?? 'q1',
          error: persistenceAcceptance.error,
        };
      }
      const dispatchAcceptance: Promise<{ accepted: boolean; error?: string }> = options?.beforeDispatch
        ? options.beforeDispatch().then(result => (
          result.accepted && result.validateAtCommit
            ? result.validateAtCommit()
            : result
        ))
        : Promise.resolve({ accepted: true });
      queueMicrotask(() => {
        void (async () => {
          const acceptance = await dispatchAcceptance;
          if (acceptance && !acceptance.accepted) {
            options?.onTerminal?.({
              status: 'stopped',
              assistantMessagePresent: false,
              text: '',
              error: acceptance.error,
            });
            return;
          }
          options?.onTerminal?.({
            status: 'complete',
            assistantMessagePresent: true,
            text: 'builtin answer',
          });
        })();
      });
      return {
        queued: true,
        queueId: options?.queueId ?? 'q1',
        isInFlight: false,
        deliveryMode: 'queue' as const,
        dispatchAcceptance,
      };
    }),
    forceExecuteQueueItem: vi.fn(async () => true),
    getAndClearLastAgentError: vi.fn<() => string | null>(() => null),
    getCurrentTurnIdentity: vi.fn(() => state.builtinTurnIdentity),
    getDispatchedTurnIdentity: vi.fn(() => (
      state.builtinDispatchedQueueId
        ? { queueId: state.builtinDispatchedQueueId }
        : state.builtinTurnIdentity
    )),
    getAgentState: vi.fn<() => Record<string, unknown>>(() => ({ sessionState: 'idle', agentDir: '/workspace' })),
    getBuiltinLiveSessionSnapshot: vi.fn<() => Record<string, unknown> | null>(() => null),
    getAgents: vi.fn(() => ({ helper: { name: 'helper' } })),
    getLastBuiltinAssistantText: vi.fn(() => 'builtin latest'),
    getMcpServers: vi.fn(() => [{ id: 'fs' }]),
    getMessages: vi.fn<() => Array<{ id: string; role: 'user' | 'assistant'; content: string | unknown[]; timestamp: string }>>(() => []),
    getPendingInteractiveRequests: vi.fn<() => Array<{ type: string; data: unknown }>>(() => []),
    getQueueStatus: vi.fn(() => [{ id: 'q1', messagePreview: 'hello' }]),
    getSessionId: vi.fn(() => 'builtin-session'),
    getSessionModel: vi.fn(() => 'claude-sonnet'),
    getSessionPermissionMode: vi.fn(() => 'auto'),
    getSessionEnabledOfficialToolIds: vi.fn(() => ['image-understanding']),
    getSessionProviderEnv: vi.fn(() => undefined),
    getSessionProviderId: vi.fn(() => 'sensenova'),
    getSessionReasoningEffort: vi.fn(() => 'default'),
    getStreamingAssistantId: vi.fn<() => string | null>(() => null),
    getSystemInitInfo: vi.fn<() => unknown>(() => null),
    handleAskUserQuestionResponse: vi.fn(() => true),
    handlePermissionResponse: vi.fn(() => true),
    interruptCurrentResponse: vi.fn(async () => false),
    isSessionBusy: vi.fn(() => false),
    forkSession: vi.fn(async () => ({ success: true, newSessionId: 'forked' })),
    freezeCurrentSessionMetadataForImDetach: vi.fn(async () => ({ success: true, sessionId: 'old-im-session' })),
    materializeCurrentSessionMetadataForPublishedReset: vi.fn(async () => undefined),
    materializePendingDesktopSession: vi.fn(async () => ({ success: true, sessionId: 'builtin-session' })),
    resetSession: vi.fn(async () => undefined),
    rewindSession: vi.fn(async () => ({ success: true, content: 'rewound' })),
    setAgents: vi.fn(),
    setBackgroundAgentPermissionMode: vi.fn(),
    setInteractionScenario: vi.fn(),
    setMcpServers: vi.fn(),
    setSessionModel: vi.fn(),
    setSessionPermissionMode: vi.fn(),
    setSessionEnabledOfficialToolIds: vi.fn(),
    setSessionProviderEnv: vi.fn(),
    setSessionReasoningEffort: vi.fn(),
    stripPlaywrightResults: vi.fn((message: string) => message),
    switchToSession: vi.fn(async () => true),
    waitForSessionIdle: vi.fn(async () => true),
    awaitExternalSessionStarting: vi.fn(async () => undefined),
    cancelExternalImRequest: vi.fn(async () => ({ aborted: false, mode: 'unknown' as const })),
    cancelExternalQueueItem: vi.fn<(queueId: string) => {
      cancelledText: string;
      promotion?: { settled: Promise<{ status: 'not-dispatched' | 'dispatched' | 'terminated' | 'termination-unconfirmed' }> };
    } | null>(() => null),
    cancelExternalQueuedTurnsByOwner: vi.fn<() => {
      count: number;
      promotion?: { settled: Promise<{ status: 'not-dispatched' | 'dispatched' | 'terminated' | 'termination-unconfirmed' }> };
    }>(() => ({ count: 0 })),
    clearExternalTurnBinding: vi.fn((queueId: string) => {
      if (state.externalCurrentQueueId === queueId) state.externalCurrentQueueId = null;
    }),
    didLastTurnSucceed: vi.fn(() => true),
    enqueueExternalSendForDesktop: vi.fn(() => ({
      queued: true,
      queueId: 'xq1',
      dispatch: Promise.resolve({ queued: true }),
    })),
    enqueueExternalSendForIm: vi.fn<(...args: unknown[]) => {
      queued: boolean;
      queueId?: string;
      dispatch: Promise<{
        queued: boolean;
        error?: string;
        terminationUnconfirmed?: boolean;
      }>;
    }>(() => ({
      queued: true,
      dispatch: Promise.resolve({ queued: true }),
    })),
    forceExecuteExternalQueueItem: vi.fn(async () => true),
    getActiveRuntimeSource: vi.fn<() => 'system-cli' | 'managed-provider'>(() => 'system-cli'),
    getActiveRuntimeType: vi.fn(() => 'codex'),
    getCurrentBoundSessionId: vi.fn<() => string | null>(() => null),
    getExternalLiveAssistantMessage: vi.fn<() => { id: string; role: 'user' | 'assistant'; content: string; timestamp: string } | null>(() => null),
    getExternalLiveSessionSnapshot: vi.fn<(targetSessionId: string) => Record<string, unknown> | null>(() => null),
    getExternalCurrentTurnIdentity: vi.fn(() => state.externalTurnIdentity),
    getExternalQueueStatus: vi.fn(() => [{ id: 'xq1', messagePreview: 'hello' }]),
    getExternalPendingInteractiveRequests: vi.fn(() => []),
    getExternalSessionId: vi.fn(() => 'external-session'),
    getExternalSessionModel: vi.fn(() => 'gpt-5'),
    getExternalSessionPermissionMode: vi.fn(() => 'no-restrictions'),
    getExternalSessionReasoningEffort: vi.fn(() => 'medium'),
    getExternalSessionState: vi.fn(() => 'idle'),
    getExternalSessionWorkspacePath: vi.fn(() => '/workspace'),
    getExternalSystemInitPayload: vi.fn(() => null),
    getLastExternalAssistantText: vi.fn(() => 'external answer'),
    hasExternalRuntimeProcess: vi.fn(() => state.externalProcessAlive || state.externalActive),
    hasPendingExternalAskUserQuestion: vi.fn((requestId: string) => Boolean(requestId) && state.pendingExternalAsk),
    isExternalSessionActive: vi.fn(() => state.externalActive),
    isExternalSessionBusy: vi.fn(() => state.externalBusy),
    isExternalSessionStateRestoredFor: vi.fn(() => true),
    isExternalTurnCurrent: vi.fn((queueId: string) => state.externalCurrentQueueId === queueId),
    popLastUserMessageForRetry: vi.fn(async () => ({ success: true, content: 'retry' })),
    prewarmExternalSession: vi.fn(async () => ({ prewarmed: true })),
    respondExternalAskUserQuestion: vi.fn(async () => true),
    respondExternalPermission: vi.fn(async () => true),
    restoreExternalSessionState: vi.fn(),
    sendExternalMessage: vi.fn<(...args: unknown[]) => Promise<{
      queued: boolean;
      error?: string;
      terminationUnconfirmed?: boolean;
    }>>(async (...args: unknown[]) => {
      const context = args[4] as {
        queueId?: string;
        turnOwner?: { kind: 'goal' | 'task'; id: string };
        onTerminal?: (outcome: { status: 'complete'; assistantMessagePresent: boolean; text: string }) => void;
      } | undefined;
      state.externalCurrentQueueId = context?.queueId ?? null;
      state.externalTurnIdentity = context?.queueId && context.turnOwner
        ? { queueId: context.queueId, owner: context.turnOwner }
        : null;
      queueMicrotask(() => {
        context?.onTerminal?.({
          status: 'complete',
          assistantMessagePresent: true,
          text: 'external answer',
        });
        state.externalCurrentQueueId = null;
        state.externalTurnIdentity = null;
      });
      return { queued: true };
    }),
    setExternalModel: vi.fn(async () => ({ success: true })),
    setExternalPermissionMode: vi.fn(async () => ({ success: true })),
    setExternalReasoningEffort: vi.fn(async () => ({ success: true })),
    shouldUseExternalRuntime: vi.fn(() => state.useExternal),
    stopExternalSession: vi.fn(async () => true),
    handleExternalOfficialToolIdsChange: vi.fn(async () => ({ success: true })),
    updateExternalRuntimeConfig: vi.fn(async () => ({ success: true })),
    waitForExternalSessionIdle: vi.fn(async () => true),
    waitExternalTurnFinalization: vi.fn(async () => true),
    getSessionData: vi.fn((sessionId: string) => ({
      id: sessionId,
      agentDir: '/workspace',
      title: 'Test',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '2026-01-01T00:00:00.000Z',
      enabledOfficialToolIds: ['image-understanding'],
      messages: [],
    })),
    updateSessionMetadata: vi.fn(async (sessionId: string, updates: Record<string, unknown>) => ({
      id: sessionId,
      agentDir: '/workspace',
      title: 'Test',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '2026-01-01T00:00:00.000Z',
      ...updates,
      messages: [],
    })),
    getEffectiveOfficialToolIdsForSession: vi.fn((_workspacePath: string, sessionMeta?: { enabledOfficialToolIds?: string[] } | null, overrideIds?: readonly string[] | null) => (
      overrideIds !== null && overrideIds !== undefined
        ? [...overrideIds]
        : (sessionMeta?.enabledOfficialToolIds ? [...sessionMeta.enabledOfficialToolIds] : [])
    )),
    materializeProviderRouteEnv: vi.fn<() => unknown>(() => undefined),
    managementApi: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(
      async () => ({ ok: true }),
    ),
    resolveSubscriptionAuthKind: vi.fn((providerId: string) => (
      providerId === 'xai-sub' ? 'host-managed-oauth' : 'sdk-native'
    )),
    loadConfig: vi.fn(() => ({ chatQueueResponseMode: 'realtime' })),
    resolveWorkspaceConfig: vi.fn(() => ({ mcpServers: [{ id: 'snapshot-mcp' }] })),
  };
});

vi.mock('../agent-session', () => ({
  applyMcpOverrideAndAwaitReady: mocks.applyMcpOverrideAndAwaitReady,
  cancelImRequest: mocks.cancelBuiltinImRequest,
  cancelQueueItem: mocks.cancelQueueItem,
  cancelQueuedTurnsByOwner: mocks.cancelQueuedTurnsByOwner,
  enqueueUserMessage: mocks.enqueueUserMessage,
  forceExecuteQueueItem: mocks.forceExecuteQueueItem,
  getAndClearLastAgentError: mocks.getAndClearLastAgentError,
  getCurrentTurnIdentity: mocks.getCurrentTurnIdentity,
  getDispatchedTurnIdentity: mocks.getDispatchedTurnIdentity,
  getAgentState: mocks.getAgentState,
  getBuiltinLiveSessionSnapshot: mocks.getBuiltinLiveSessionSnapshot,
  getAgents: mocks.getAgents,
  getLastBuiltinAssistantText: mocks.getLastBuiltinAssistantText,
  getMcpServers: mocks.getMcpServers,
  getMessages: mocks.getMessages,
  getPendingInteractiveRequests: mocks.getPendingInteractiveRequests,
  getQueueStatus: mocks.getQueueStatus,
  getSessionId: mocks.getSessionId,
  getSessionModel: mocks.getSessionModel,
  getSessionPermissionMode: mocks.getSessionPermissionMode,
  getSessionEnabledOfficialToolIds: mocks.getSessionEnabledOfficialToolIds,
  getSessionProviderEnv: mocks.getSessionProviderEnv,
  getSessionProviderId: mocks.getSessionProviderId,
  getSessionReasoningEffort: mocks.getSessionReasoningEffort,
  getStreamingAssistantId: mocks.getStreamingAssistantId,
  getSystemInitInfo: mocks.getSystemInitInfo,
  handleAskUserQuestionResponse: mocks.handleAskUserQuestionResponse,
  handlePermissionResponse: mocks.handlePermissionResponse,
  interruptCurrentResponse: mocks.interruptCurrentResponse,
  isSessionBusy: mocks.isSessionBusy,
  forkSession: mocks.forkSession,
  freezeCurrentSessionMetadataForImDetach: mocks.freezeCurrentSessionMetadataForImDetach,
  materializeCurrentSessionMetadataForPublishedReset: mocks.materializeCurrentSessionMetadataForPublishedReset,
  materializePendingDesktopSession: mocks.materializePendingDesktopSession,
  resetSession: mocks.resetSession,
  rewindSession: mocks.rewindSession,
  setAgents: mocks.setAgents,
  setBackgroundAgentPermissionMode: mocks.setBackgroundAgentPermissionMode,
  setInteractionScenario: mocks.setInteractionScenario,
  setMcpServers: mocks.setMcpServers,
  setSessionModel: mocks.setSessionModel,
  setSessionPermissionMode: mocks.setSessionPermissionMode,
  setSessionEnabledOfficialToolIds: mocks.setSessionEnabledOfficialToolIds,
  setSessionProviderEnv: mocks.setSessionProviderEnv,
  setSessionReasoningEffort: mocks.setSessionReasoningEffort,
  stripPlaywrightResults: mocks.stripPlaywrightResults,
  switchToSession: mocks.switchToSession,
  waitForSessionIdle: mocks.waitForSessionIdle,
}));

vi.mock('../runtimes/external-session', () => ({
  awaitExternalSessionStarting: mocks.awaitExternalSessionStarting,
  cancelExternalImRequest: mocks.cancelExternalImRequest,
  cancelExternalQueueItem: mocks.cancelExternalQueueItem,
  cancelExternalQueuedTurnsByOwner: mocks.cancelExternalQueuedTurnsByOwner,
  clearExternalTurnBinding: mocks.clearExternalTurnBinding,
  didLastTurnSucceed: mocks.didLastTurnSucceed,
  enqueueExternalSendForDesktop: mocks.enqueueExternalSendForDesktop,
  enqueueExternalSendForIm: mocks.enqueueExternalSendForIm,
  forceExecuteExternalQueueItem: mocks.forceExecuteExternalQueueItem,
  getActiveRuntimeSource: mocks.getActiveRuntimeSource,
  getActiveRuntimeType: mocks.getActiveRuntimeType,
  getCurrentBoundSessionId: mocks.getCurrentBoundSessionId,
  getExternalCurrentTurnIdentity: mocks.getExternalCurrentTurnIdentity,
  getExternalLiveAssistantMessage: mocks.getExternalLiveAssistantMessage,
  getExternalLiveSessionSnapshot: mocks.getExternalLiveSessionSnapshot,
  getExternalPendingInteractiveRequests: mocks.getExternalPendingInteractiveRequests,
  getExternalQueueStatus: mocks.getExternalQueueStatus,
  getExternalSessionId: mocks.getExternalSessionId,
  getExternalSessionModel: mocks.getExternalSessionModel,
  getExternalSessionPermissionMode: mocks.getExternalSessionPermissionMode,
  getExternalSessionReasoningEffort: mocks.getExternalSessionReasoningEffort,
  getExternalSessionState: mocks.getExternalSessionState,
  getExternalSessionWorkspacePath: mocks.getExternalSessionWorkspacePath,
  getExternalSystemInitPayload: mocks.getExternalSystemInitPayload,
  getLastExternalAssistantText: mocks.getLastExternalAssistantText,
  handleExternalOfficialToolIdsChange: mocks.handleExternalOfficialToolIdsChange,
  hasExternalRuntimeProcess: mocks.hasExternalRuntimeProcess,
  hasPendingExternalAskUserQuestion: mocks.hasPendingExternalAskUserQuestion,
  isExternalSessionActive: mocks.isExternalSessionActive,
  isExternalSessionBusy: mocks.isExternalSessionBusy,
  isExternalSessionStateRestoredFor: mocks.isExternalSessionStateRestoredFor,
  isExternalTurnCurrent: mocks.isExternalTurnCurrent,
  popLastUserMessageForRetry: mocks.popLastUserMessageForRetry,
  prewarmExternalSession: mocks.prewarmExternalSession,
  respondExternalAskUserQuestion: mocks.respondExternalAskUserQuestion,
  respondExternalPermission: mocks.respondExternalPermission,
  restoreExternalSessionState: mocks.restoreExternalSessionState,
  sendExternalMessage: mocks.sendExternalMessage,
  setExternalModel: mocks.setExternalModel,
  setExternalPermissionMode: mocks.setExternalPermissionMode,
  setExternalReasoningEffort: mocks.setExternalReasoningEffort,
  shouldUseExternalRuntime: mocks.shouldUseExternalRuntime,
  stopExternalSession: mocks.stopExternalSession,
  updateExternalRuntimeConfig: mocks.updateExternalRuntimeConfig,
  waitForExternalSessionIdle: mocks.waitForExternalSessionIdle,
  waitExternalTurnFinalization: mocks.waitExternalTurnFinalization,
}));

vi.mock('../utils/admin-config', () => ({
  getEffectiveOfficialToolIdsForSession: mocks.getEffectiveOfficialToolIdsForSession,
  loadConfig: mocks.loadConfig,
  materializeProviderRouteEnv: mocks.materializeProviderRouteEnv,
  resolveSubscriptionAuthKind: mocks.resolveSubscriptionAuthKind,
  resolveWorkspaceConfig: mocks.resolveWorkspaceConfig,
}));

vi.mock('../utils/management-api-client', () => ({
  managementApi: mocks.managementApi,
}));

vi.mock('../SessionStore', () => ({
  getSessionData: mocks.getSessionData,
  updateSessionMetadata: mocks.updateSessionMetadata,
}));

vi.mock('../sse', () => ({
  broadcast: mocks.broadcast,
}));

import {
  getAskUserQuestionResponseEngine,
  getPermissionResponseEngine,
  getSessionEngine,
  stopActiveTurn,
  stopOwnedTurn,
  stopOwnedTurnByQueueId,
} from './selector';
import type { InjectedTurnRequest } from './types';

const desktopScenario = { type: 'desktop' } as const;

type TestInjectedTurnRequest = Omit<InjectedTurnRequest, 'assistantChannelDelivery'>
  & Partial<Pick<InjectedTurnRequest, 'assistantChannelDelivery'>>;

function runInjectedTurn(request: TestInjectedTurnRequest) {
  return getSessionEngine().runInjectedTurn({
    assistantChannelDelivery: 'none',
    ...request,
  });
}

describe('session-engine selector and adapters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.useExternal = false;
    mocks.state.externalActive = false;
    mocks.state.externalBusy = false;
    mocks.state.externalProcessAlive = false;
    mocks.state.builtinTurnIdentity = null;
    mocks.state.builtinDispatchedQueueId = null;
    mocks.state.externalTurnIdentity = null;
    mocks.state.externalCurrentQueueId = null;
    mocks.state.pendingExternalAsk = false;
    mocks.isExternalSessionStateRestoredFor.mockReturnValue(true);
    mocks.getBuiltinLiveSessionSnapshot.mockReturnValue(null);
    mocks.getExternalLiveSessionSnapshot.mockReturnValue(null);
  });

  it('routes desktop sends through builtin while preserving desktop metadata', async () => {
    const result = await getSessionEngine().sendDesktopMessage({
      text: 'hello',
      images: [],
      permissionMode: 'auto',
      model: 'claude-sonnet',
      providerEnv: undefined,
      reasoningEffort: 'medium',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: desktopScenario,
      analyticsSource: 'floating_ball',
      analyticsOrigin: { kind: 'desktop', surface: 'floating_ball' },
      birthOrigin: { kind: 'desktop', surface: 'launcher_input' },
    });

    expect(result).toMatchObject({
      success: true,
      queued: true,
      queueId: 'q1',
      isInFlight: false,
      deliveryMode: 'queue',
    });
    expect(mocks.setInteractionScenario).toHaveBeenCalledWith(desktopScenario);
    expect(mocks.enqueueUserMessage).toHaveBeenCalledWith(
      'hello',
      [],
      'auto',
      'claude-sonnet',
      undefined,
      'medium',
      { source: 'desktop' },
      undefined,
      undefined,
      'floating_ball',
      { kind: 'desktop', surface: 'floating_ball' },
      {
        fromDesktopChatSend: true,
        sessionBirthOrigin: { kind: 'desktop', surface: 'launcher_input' },
        queueId: undefined,
        turnOwner: undefined,
        beforeDispatch: undefined,
        onTerminal: undefined,
        channelDelivery: {
          user: 'session-binding',
          assistant: 'session-binding',
        },
      },
    );
  });

  it('preserves exact Registered Agent birth origin through builtin and external inbox adapters', async () => {
    const birthOrigin = {
      kind: 'registered-agent',
      surface: 'space_issue_delivery',
      context: { spaceId: 'space_1', registeredAgentId: 'rag_1' },
    } as const;
    const request = {
      text: '<system-reminder>delivery</system-reminder>',
      sessionId: 'delivery-session',
      workspacePath: '/workspace',
      scenario: {
        type: 'registeredAgent',
        platform: 'space',
        spaceId: 'space_1',
        registeredAgentId: 'rag_1',
        sourceType: 'issue-delivery',
      } as const,
      allowLazySessionMaterialization: true,
      analyticsOrigin: birthOrigin,
      birthOrigin,
    };

    await getSessionEngine().enqueueInboxMessage(request);
    expect(mocks.enqueueUserMessage).toHaveBeenLastCalledWith(
      request.text,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      birthOrigin,
      {
        allowLazySessionMaterialization: true,
        sessionBirthOrigin: birthOrigin,
        channelDelivery: {
          user: 'none',
          assistant: 'session-binding',
        },
      },
    );

    mocks.state.useExternal = true;
    await getSessionEngine().enqueueInboxMessage(request);
    expect(mocks.sendExternalMessage).toHaveBeenLastCalledWith(
      request.text,
      undefined,
      undefined,
      undefined,
      expect.objectContaining({
        sessionId: 'delivery-session',
        workspacePath: '/workspace',
        analyticsOrigin: birthOrigin,
        birthOrigin,
        metadataBirthPending: true,
        channelDelivery: {
          user: 'none',
          assistant: 'session-binding',
        },
      }),
    );
  });

  it('materializes Grok subscription routes as managed builtin ProviderEnv', async () => {
    const managedEnv = {
      providerId: 'xai-sub',
      baseUrl: 'https://api.x.ai/v1',
      apiProtocol: 'openai' as const,
      upstreamFormat: 'responses' as const,
      credentialSource: { kind: 'managed-oauth' as const, providerId: 'xai-sub' as const },
    };
    mocks.materializeProviderRouteEnv.mockReturnValueOnce(managedEnv);

    const result = await getSessionEngine().sendDesktopMessage({
      text: 'hello Grok',
      model: 'grok-4.5',
      providerRoute: { kind: 'subscription', providerId: 'xai-sub', model: 'grok-4.5' },
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: desktopScenario,
    });

    expect(result.success).toBe(true);
    expect(mocks.enqueueUserMessage.mock.calls.at(-1)?.[4]).toEqual(managedEnv);
  });

  it('keeps Anthropic subscription routes on the native subscription sentinel', async () => {
    await getSessionEngine().sendDesktopMessage({
      text: 'hello Claude',
      model: 'claude-sonnet-5',
      providerRoute: {
        kind: 'subscription',
        providerId: 'anthropic-sub',
        model: 'claude-sonnet-5',
      },
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: desktopScenario,
    });

    expect(mocks.enqueueUserMessage.mock.calls.at(-1)?.[4]).toBe('subscription');
  });

  it('passes Goal dispatch guards into builtin queue ownership and exposes its acknowledgement', async () => {
    const beforeDispatch = vi.fn(async () => ({ accepted: true }));
    const dispatchAcceptance = Promise.resolve({ accepted: true });
    mocks.enqueueUserMessage.mockResolvedValueOnce({
      queued: true,
      queueId: 'q-goal',
      dispatchAcceptance,
    });

    const result = await getSessionEngine().sendDesktopMessage({
      text: 'guarded Goal turn',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: desktopScenario,
      beforeDispatch,
    });

    expect(mocks.enqueueUserMessage.mock.calls[0]?.[11]).toMatchObject({ beforeDispatch });
    expect(result.dispatchAcceptance).toBe(dispatchAcceptance);
  });

  it('exposes builtin read and config surfaces without route-level helpers', () => {
    mocks.getSessionId.mockReturnValueOnce('builtin-live');
    mocks.getLastBuiltinAssistantText.mockReturnValueOnce('builtin answer');
    mocks.getMessages.mockReturnValueOnce([
      { id: 'u1', role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'saved answer' }], timestamp: '2026-01-01T00:00:01.000Z' },
      { id: 'a-stream', role: 'assistant', content: 'streaming', timestamp: '2026-01-01T00:00:02.000Z' },
    ]);
    mocks.getStreamingAssistantId.mockReturnValueOnce('a-stream');
    mocks.getSystemInitInfo.mockReturnValueOnce({ model: 'claude-sonnet' });
    mocks.getPendingInteractiveRequests.mockReturnValueOnce([{ type: 'chat:permission-request', data: { requestId: 'p1' } }]);

    const engine = getSessionEngine();

    expect(engine.getRuntimeIdentity()).toEqual({
      kind: 'builtin',
      runtime: 'builtin',
      sessionId: 'builtin-live',
    });
    expect(engine.getLatestAssistantResult()).toEqual({
      sessionId: 'builtin-session',
      latestResult: 'builtin answer',
    });
    expect(engine.getStreamReplaySnapshot()).toMatchObject({
      sessionId: 'builtin-session',
      replayMessages: [
        { id: 'u1', content: 'hello' },
        { id: 'a1', content: [{ type: 'text', text: 'saved answer' }] },
      ],
      systemInitPayload: { info: { model: 'claude-sonnet' } },
      pendingInteractiveRequests: [{ type: 'chat:permission-request', data: { requestId: 'p1' } }],
    });
    expect(engine.getSessionConfigSnapshot()).toEqual({
      success: true,
      runtime: 'builtin',
      model: 'claude-sonnet',
      mcpServerIds: ['fs'],
      agentNames: ['helper'],
      enabledOfficialToolIds: ['image-understanding'],
      permissionMode: 'auto',
      providerId: 'sensenova',
      providerRoute: { kind: 'provider', providerId: 'sensenova', model: 'claude-sonnet' },
      reasoningEffort: 'default',
    });
    expect(engine.getHeldImConfigSnapshot()).toEqual({
      model: 'claude-sonnet',
      permissionMode: 'auto',
      providerEnv: undefined,
      reasoningEffort: 'default',
    });

    mocks.getBuiltinLiveSessionSnapshot.mockReturnValueOnce({
      snapshotRevision: 7,
      inMemoryMessages: [{ id: 'u-live', role: 'user', content: 'accepted', timestamp: '2026-01-01T00:00:03.000Z' }],
      liveStreamingMessage: { id: 'a-live', role: 'assistant', content: 'typing', timestamp: '2026-01-01T00:00:04.000Z' },
      liveSessionState: 'running',
      pendingInteractiveRequests: [],
    });
    expect(engine.getLiveSessionOverlay('builtin-session')).toEqual({
      isActive: true,
      runtime: 'builtin',
      snapshotRevision: 7,
      inMemoryMessages: [{
        id: 'u-live',
        role: 'user',
        content: 'accepted',
        timestamp: '2026-01-01T00:00:03.000Z',
      }],
      liveStreamingMessage: { id: 'a-live', role: 'assistant', content: 'typing', timestamp: '2026-01-01T00:00:04.000Z' },
      liveSessionState: 'running',
      pendingInteractiveRequests: [],
    });

    mocks.getBuiltinLiveSessionSnapshot.mockReturnValueOnce({
      snapshotRevision: 8,
      inMemoryMessages: [
        { id: 'a-final', role: 'assistant', content: 'finished', timestamp: '2026-01-01T00:00:05.000Z' },
        { id: 'u-admitted', role: 'user', content: 'waiting for first chunk', timestamp: '2026-01-01T00:00:06.000Z' },
      ],
      liveStreamingMessage: null,
      liveSessionState: 'running',
      pendingInteractiveRequests: [],
    });
    expect(engine.getLiveSessionOverlay('builtin-session')).toMatchObject({
      inMemoryMessages: [
        expect.objectContaining({ id: 'a-final', content: 'finished' }),
        expect.objectContaining({ id: 'u-admitted', content: 'waiting for first chunk' }),
      ],
      liveStreamingMessage: null,
      liveSessionState: 'running',
    });
  });

  it('exposes external read, config, and restore surfaces behind the external adapter', () => {
    mocks.state.useExternal = true;
    mocks.state.externalBusy = true;
    mocks.getCurrentBoundSessionId
      .mockReturnValueOnce('bound-session')
      .mockReturnValueOnce('bound-session');
    mocks.getExternalLiveSessionSnapshot.mockImplementation((targetSessionId: string) => {
      expect(targetSessionId).toBe('bound-session');
      return {
      snapshotRevision: 3,
      inMemoryMessages: [{
        id: 'external-user',
        role: 'user',
        content: 'accepted before reconnect',
        timestamp: '2026-01-01T00:00:00.000Z',
      }],
      liveStreamingMessage: {
        id: 'live',
        role: 'assistant',
        content: 'typing',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      liveSessionState: 'idle',
      pendingInteractiveRequests: [],
      };
    });

    const engine = getSessionEngine();

    expect(engine.isBusy()).toBe(true);
    expect(engine.getLiveSessionState()).toEqual({
      sessionState: 'idle',
      isBusy: true,
    });

    expect(engine.getRuntimeIdentity()).toEqual({
      kind: 'external',
      runtime: 'codex',
      runtimeSource: 'system-cli',
      sessionId: 'external-session',
      boundSessionId: 'bound-session',
    });
    expect(engine.getStreamReplaySnapshot()).toMatchObject({
      sessionId: 'bound-session',
      replayMessages: [{
        id: 'external-user',
        role: 'user',
        content: 'accepted before reconnect',
      }],
      liveStreamingMessage: {
        id: 'live',
        role: 'assistant',
        content: 'typing',
      },
    });
    expect(engine.getSessionConfigSnapshot()).toEqual({
      success: true,
      runtime: 'codex',
      runtimeSource: 'system-cli',
      model: 'gpt-5',
      mcpServerIds: null,
      agentNames: null,
      enabledOfficialToolIds: ['image-understanding'],
      permissionMode: 'no-restrictions',
      providerId: null,
      providerRoute: null,
      providerExecutionIdentity: null,
      reasoningEffort: 'medium',
    });
    expect(engine.getHeldImConfigSnapshot()).toEqual({
      model: 'gpt-5',
      permissionMode: 'no-restrictions',
      reasoningEffort: 'medium',
    });
    expect(engine.getLiveSessionOverlay('bound-session')).toMatchObject({
      isActive: true,
      runtime: 'codex',
      liveStreamingMessage: { id: 'live', content: 'typing' },
      liveSessionState: 'idle',
    });

    expect(engine.restoreInitialSession('sid-restored', '/workspace')).toBe(true);
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith('sid-restored', '/workspace', { type: 'desktop' });
  });

  it('matches external live overlay by current bound session during prewarm/start', () => {
    mocks.state.useExternal = true;
    mocks.getExternalLiveSessionSnapshot.mockReturnValueOnce({
      snapshotRevision: 1,
      inMemoryMessages: [],
      liveStreamingMessage: null,
      liveSessionState: 'idle',
      pendingInteractiveRequests: [],
    });

    expect(getSessionEngine().getLiveSessionOverlay('starting-session')).toMatchObject({
      isActive: true,
      runtime: 'codex',
      liveSessionState: 'idle',
    });
  });

  it('returns external desktop acceptance before dispatch finishes and broadcasts dispatch failures', async () => {
    mocks.state.useExternal = true;
    let resolveDispatch!: (result: { queued: boolean; error?: string }) => void;
    const dispatch = new Promise<{ queued: boolean; error?: string }>((resolve) => {
      resolveDispatch = resolve;
    });
    mocks.enqueueExternalSendForDesktop.mockReturnValueOnce({
      queued: true,
      queueId: 'xq-runtime',
      dispatch,
    });

    const result = await getSessionEngine().sendDesktopMessage({
      text: 'hello external',
      images: [],
      permissionMode: 'auto',
      model: 'gpt-5',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: desktopScenario,
    });

    expect(result).toMatchObject({ success: true, queued: true, queueId: 'xq-runtime' });
    expect(result.dispatchAcceptance).toBeInstanceOf(Promise);
    expect(mocks.enqueueExternalSendForDesktop).toHaveBeenCalledWith(
      'hello external',
      [],
      'auto',
      'gpt-5',
      {
        sessionId: 'sid',
        workspacePath: '/workspace',
        scenario: desktopScenario,
        analyticsSource: undefined,
        analyticsOrigin: undefined,
        birthOrigin: undefined,
        permissionMode: 'auto',
        model: 'gpt-5',
        reasoningEffort: undefined,
        turnBoundaryOnly: undefined,
        queueId: undefined,
        turnOwner: undefined,
        onTerminal: undefined,
        beforeDispatch: undefined,
        channelDelivery: {
          user: 'session-binding',
          assistant: 'session-binding',
        },
      },
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();

    resolveDispatch({ queued: false, error: 'runtime failed' });
    await dispatch;
    await Promise.resolve();

    expect(mocks.broadcast).toHaveBeenCalledWith('chat:agent-error', { message: 'runtime failed' });
  });

  it('exposes external dispatch acceptance without delaying desktop response', async () => {
    mocks.state.useExternal = true;
    let resolveDispatch!: (result: { queued: boolean; error?: string }) => void;
    const dispatch = new Promise<{ queued: boolean; error?: string }>((resolve) => {
      resolveDispatch = resolve;
    });
    mocks.enqueueExternalSendForDesktop.mockReturnValueOnce({
      queued: true,
      queueId: 'xq-goal',
      dispatch,
    });

    const result = await getSessionEngine().sendDesktopMessage({
      text: 'continue Goal',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: desktopScenario,
    });

    expect(result).toMatchObject({ success: true, queued: true, queueId: 'xq-goal' });
    expect(result.dispatchAcceptance).toBeInstanceOf(Promise);

    resolveDispatch({ queued: false, error: 'runtime rejected Goal turn' });
    await expect(result.dispatchAcceptance).resolves.toEqual({
      accepted: false,
      error: 'runtime rejected Goal turn',
    });
    expect(mocks.broadcast).toHaveBeenCalledWith('chat:agent-error', {
      message: 'runtime rejected Goal turn',
    });
  });

  it('keeps stop fallback on builtin when external runtime is selected but inactive', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = false;

    const result = await stopActiveTurn();

    expect(result).toEqual({ success: true, alreadyStopped: true });
    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
    expect(mocks.interruptCurrentResponse).toHaveBeenCalledTimes(1);
  });

  it('reports a failed external process stop instead of clearing it as stopped', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;
    mocks.stopExternalSession.mockResolvedValueOnce(false);

    await expect(stopActiveTurn()).resolves.toEqual({
      success: false,
      error: 'External runtime process did not stop',
    });
    expect(mocks.interruptCurrentResponse).not.toHaveBeenCalled();
  });

  it('persists Goal pause before stopping the active builtin Goal turn', async () => {
    mocks.state.builtinTurnIdentity = {
      queueId: 'goal-turn-1',
      owner: { kind: 'goal', id: 'goal-1' },
    };
    mocks.interruptCurrentResponse.mockResolvedValueOnce(true);

    await expect(stopActiveTurn()).resolves.toEqual({ success: true });

    expect(mocks.managementApi).toHaveBeenCalledWith('/api/goal/turn/pause', 'POST', {
      sessionId: 'builtin-session',
      workspacePath: '/workspace',
      goalId: 'goal-1',
      queueId: 'goal-turn-1',
    });
    expect(mocks.managementApi).toHaveBeenCalledWith('/api/goal/turn/abort', 'POST', {
      sessionId: 'builtin-session',
      workspacePath: '/workspace',
      goalId: 'goal-1',
      queueId: 'goal-turn-1',
    });
    expect(mocks.interruptCurrentResponse).toHaveBeenCalledOnce();
    expect(mocks.managementApi.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.interruptCurrentResponse.mock.invocationCallOrder[0]);
    expect(mocks.interruptCurrentResponse.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.managementApi.mock.invocationCallOrder[1]);
  });

  it('does not stop a Goal turn when its durable pause is rejected', async () => {
    mocks.state.builtinTurnIdentity = {
      queueId: 'goal-turn-1',
      owner: { kind: 'goal', id: 'goal-1' },
    };
    mocks.managementApi.mockResolvedValueOnce({ ok: false, error: 'stale turn' });

    await expect(stopActiveTurn()).resolves.toEqual({
      success: false,
      error: 'stale turn',
    });

    expect(mocks.interruptCurrentResponse).not.toHaveBeenCalled();
  });

  it.each(['complete', 'blocked'] as const)(
    'does not interrupt a Model-winning %s Goal turn',
    async (status) => {
      mocks.state.builtinTurnIdentity = {
        queueId: 'goal-turn-1',
        owner: { kind: 'goal', id: 'goal-1' },
      };
      mocks.managementApi.mockResolvedValueOnce({ ok: true, goal: { status } });

      await expect(stopActiveTurn()).resolves.toEqual({
        success: true,
        alreadyStopped: true,
      });

      expect(mocks.cancelQueueItem).not.toHaveBeenCalled();
      expect(mocks.interruptCurrentResponse).not.toHaveBeenCalled();
      expect(mocks.managementApi).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps paused Goal authority when the exact runtime stop is not confirmed', async () => {
    mocks.state.builtinTurnIdentity = {
      queueId: 'goal-turn-1',
      owner: { kind: 'goal', id: 'goal-1' },
    };
    mocks.interruptCurrentResponse.mockResolvedValueOnce(false);

    await expect(stopActiveTurn()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Exact turn stop was not confirmed'),
    });

    expect(mocks.managementApi).toHaveBeenCalledTimes(1);
    expect(mocks.managementApi).not.toHaveBeenCalledWith(
      '/api/goal/turn/abort',
      expect.anything(),
      expect.anything(),
    );
  });

  it('cancels an external pre-claim Goal promotion without stopping the busy turn ahead of it', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;
    mocks.state.externalTurnIdentity = {
      queueId: 'goal-promotion',
      owner: { kind: 'goal', id: 'goal-1' },
    };
    mocks.cancelExternalQueueItem.mockReturnValueOnce({
      cancelledText: '',
      promotion: { settled: Promise.resolve({ status: 'not-dispatched' }) },
    });

    await expect(stopActiveTurn()).resolves.toEqual({ success: true });

    expect(mocks.cancelExternalQueueItem).toHaveBeenCalledWith('goal-promotion');
    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
    expect(mocks.managementApi).toHaveBeenLastCalledWith('/api/goal/turn/abort', 'POST', {
      sessionId: 'external-session',
      workspacePath: '/workspace',
      goalId: 'goal-1',
      queueId: 'goal-promotion',
    });
  });

  it('keeps a shared pre-warmed process when owner cancellation settles before dispatch', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;
    mocks.state.externalTurnIdentity = {
      queueId: 'goal-prewarm-promotion',
      owner: { kind: 'goal', id: 'goal-1' },
    };
    mocks.cancelExternalQueuedTurnsByOwner.mockReturnValueOnce({
      count: 1,
      promotion: { settled: Promise.resolve({ status: 'not-dispatched' }) },
    });

    await expect(stopOwnedTurn({ kind: 'goal', id: 'goal-1' })).resolves.toEqual({
      success: true,
      alreadyStopped: false,
    });

    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
  });

  it('stops only the exact Goal queue item during objective replacement', async () => {
    mocks.state.builtinTurnIdentity = {
      queueId: 'goal-old-turn',
      owner: { kind: 'goal', id: 'goal-1' },
    };
    mocks.cancelQueueItem.mockResolvedValueOnce({ status: 'not_found' });
    mocks.interruptCurrentResponse.mockResolvedValueOnce(true);

    await expect(stopOwnedTurnByQueueId(
      { kind: 'goal', id: 'goal-1' },
      'goal-old-turn',
    )).resolves.toEqual({ success: true });

    expect(mocks.cancelQueueItem).toHaveBeenCalledWith('goal-old-turn');
    expect(mocks.interruptCurrentResponse).toHaveBeenCalledOnce();
    expect(mocks.cancelQueuedTurnsByOwner).not.toHaveBeenCalled();
  });

  it('does not let a stale Task stop interrupt a newer queue generation', async () => {
    mocks.state.builtinTurnIdentity = {
      queueId: 'task-new-turn',
      owner: { kind: 'task', id: 'task-1' },
    };
    mocks.cancelQueueItem.mockResolvedValueOnce({ status: 'not_found' });

    await expect(stopOwnedTurnByQueueId(
      { kind: 'task', id: 'task-1' },
      'task-old-turn',
    )).resolves.toEqual({ success: true, alreadyStopped: true });

    expect(mocks.cancelQueueItem).toHaveBeenCalledWith('task-old-turn');
    expect(mocks.interruptCurrentResponse).not.toHaveBeenCalled();
    expect(mocks.cancelQueuedTurnsByOwner).not.toHaveBeenCalled();
  });

  it('preserves later external queue work when stopping the exact current Task turn', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;
    mocks.state.externalTurnIdentity = {
      queueId: 'task-current-turn',
      owner: { kind: 'task', id: 'task-1' },
    };
    mocks.cancelExternalQueueItem.mockReturnValueOnce(null);
    mocks.stopExternalSession.mockResolvedValueOnce(true);

    await expect(stopOwnedTurnByQueueId(
      { kind: 'task', id: 'task-1' },
      'task-current-turn',
    )).resolves.toEqual({ success: true, alreadyStopped: false });

    expect(mocks.stopExternalSession).toHaveBeenCalledWith({ preserveQueue: true });
  });

  it.each(['not_cancelled', 'unavailable', 'error'] as const)(
    'does not confirm a queued Task stop when cancellation returns %s',
    async (status) => {
      mocks.state.builtinTurnIdentity = null;
      mocks.cancelQueueItem.mockResolvedValueOnce({ status });

      await expect(stopOwnedTurnByQueueId(
        { kind: 'task', id: 'task-1' },
        'task-in-flight-to-sdk',
      )).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('Exact turn stop was not confirmed'),
      });

      expect(mocks.cancelQueueItem).toHaveBeenCalledWith('task-in-flight-to-sdk');
      expect(mocks.interruptCurrentResponse).not.toHaveBeenCalled();
    },
  );

  it('cancels a queued builtin injected turn when the synchronous wait times out', async () => {
    mocks.enqueueUserMessage.mockResolvedValueOnce({
      queued: true,
      queueId: 'q-timeout',
      isInFlight: false,
      deliveryMode: 'queue',
      dispatchAcceptance: Promise.resolve({ accepted: true }),
    });
    mocks.cancelQueueItem.mockResolvedValueOnce({
      status: 'cancelled',
      cancelledText: 'run cron',
    });
    const result = await runInjectedTurn({
      prompt: 'run cron',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'cron', taskId: 'task-1', intervalMinutes: 15, aiCanExit: false },
      permissionMode: 'fullAgency',
      timeoutMs: 20,
      pollMs: 1,
      queueId: 'q-timeout',
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 408,
      error: 'Execution timed out',
    });
    expect(mocks.cancelQueueItem).toHaveBeenCalledWith('q-timeout');
    expect(mocks.interruptCurrentResponse).not.toHaveBeenCalled();
  });

  it('waits for an in-flight domain claim and durable abort before publishing dispatch-timeout rejection', async () => {
    let releaseClaim!: () => void;
    let releaseAbort!: () => void;
    let markClaimStarted!: () => void;
    let markAbortStarted!: () => void;
    const claimStarted = new Promise<void>((resolve) => { markClaimStarted = resolve; });
    const abortStarted = new Promise<void>((resolve) => { markAbortStarted = resolve; });
    const claim = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const abortAcknowledged = new Promise<void>((resolve) => { releaseAbort = resolve; });
    const domainGuard = Object.assign(
      vi.fn(async () => {
        markClaimStarted();
        await claim;
        return { accepted: true };
      }),
      {
        cancel: vi.fn(async () => {
          await claim;
          markAbortStarted();
          await abortAcknowledged;
        }),
      },
    );
    let runtimeGuard!: {
      cancel?: () => void | Promise<void>;
    };
    mocks.enqueueUserMessage.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[11] as {
        queueId: string;
        beforeDispatch: (() => Promise<{ accepted: boolean }>) & {
          cancel?: () => void | Promise<void>;
        };
      };
      runtimeGuard = options.beforeDispatch;
      return {
        queued: true,
        queueId: options.queueId,
        dispatchAcceptance: options.beforeDispatch(),
      };
    });
    mocks.cancelQueueItem.mockImplementationOnce(async () => {
      await runtimeGuard.cancel?.();
      return {
        status: 'cancelled',
        cancelledText: 'continue goal',
      };
    });

    let resultSettled = false;
    const pendingResult = runInjectedTurn({
      prompt: 'continue goal',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 20,
      queueId: 'goal-claim-timeout',
      beforeDispatch: domainGuard,
    }).then((result) => {
      resultSettled = true;
      return result;
    });

    await claimStarted;
    await vi.waitFor(() => expect(domainGuard.cancel).toHaveBeenCalled());
    expect(resultSettled).toBe(false);

    releaseClaim();
    await abortStarted;
    expect(resultSettled).toBe(false);

    releaseAbort();
    await expect(pendingResult).resolves.toMatchObject({
      success: false,
      enqueued: false,
      status: 408,
      error: 'Builtin injected turn timed out before dispatch',
    });
    expect(domainGuard.cancel).toHaveBeenCalledOnce();
    expect(mocks.cancelQueueItem).toHaveBeenCalledWith('goal-claim-timeout');
  });

  it('interrupts an active builtin injected turn when its deadline expires', async () => {
    mocks.enqueueUserMessage.mockResolvedValueOnce({
      queued: false,
      queueId: 'q-active',
      isInFlight: true,
      deliveryMode: 'realtime',
      dispatchAcceptance: Promise.resolve({ accepted: true }),
    });
    mocks.state.builtinTurnIdentity = {
      queueId: 'q-active',
      owner: { kind: 'goal', id: 'goal-1' },
    };
    mocks.interruptCurrentResponse.mockResolvedValueOnce(true);

    const result = await runInjectedTurn({
      prompt: 'continue goal',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 20,
      pollMs: 1,
      queueId: 'q-active',
      turnOwner: { kind: 'goal', id: 'goal-1' },
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 408,
      error: 'Execution timed out',
    });
    expect(mocks.interruptCurrentResponse).toHaveBeenCalledWith('timeout');
  });

  it('interrupts an ownerless Heartbeat/Memory turn after active admission', async () => {
    mocks.enqueueUserMessage.mockResolvedValueOnce({
      queued: false,
      queueId: 'q-ownerless-active',
      isInFlight: false,
      deliveryMode: 'turn',
      dispatchAcceptance: Promise.resolve({ accepted: true }),
    });
    mocks.state.builtinDispatchedQueueId = 'q-ownerless-active';
    mocks.interruptCurrentResponse.mockResolvedValueOnce(true);

    const result = await runInjectedTurn({
      prompt: 'heartbeat maintenance',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 20,
      pollMs: 1,
      queueId: 'q-ownerless-active',
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 408,
    });
    expect(mocks.interruptCurrentResponse).toHaveBeenCalledWith('timeout');
  });

  it('reports an unconfirmed builtin termination when the exact turn cannot be interrupted', async () => {
    mocks.enqueueUserMessage.mockResolvedValueOnce({
      queued: false,
      queueId: 'q-orphan',
      isInFlight: true,
      deliveryMode: 'realtime',
      dispatchAcceptance: Promise.resolve({ accepted: true }),
    });
    mocks.state.builtinTurnIdentity = {
      queueId: 'q-orphan',
      owner: { kind: 'task', id: 'task-1' },
    };
    mocks.interruptCurrentResponse.mockResolvedValueOnce(false);

    const result = await runInjectedTurn({
      prompt: 'scheduled turn',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 20,
      pollMs: 1,
      queueId: 'q-orphan',
      turnOwner: { kind: 'task', id: 'task-1' },
    });

    expect(result).toMatchObject({
      success: false,
      status: 408,
      terminationUnconfirmed: true,
    });
    expect(mocks.interruptCurrentResponse).toHaveBeenCalledWith('timeout');
  });

  it('does not interrupt an unrelated builtin turn after the injected turn loses the idle race', async () => {
    mocks.enqueueUserMessage.mockResolvedValueOnce({
      queued: false,
      queueId: 'q-finished',
      isInFlight: true,
      deliveryMode: 'realtime',
      dispatchAcceptance: Promise.resolve({ accepted: true }),
    });
    mocks.cancelQueueItem.mockResolvedValueOnce({ status: 'not_found' });

    const result = await runInjectedTurn({
      prompt: 'scheduled turn',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1,
      pollMs: 1,
      queueId: 'q-finished',
    });

    expect(result).toMatchObject({ success: false, status: 408 });
    expect(mocks.cancelQueueItem).toHaveBeenCalledWith('q-finished');
    expect(mocks.interruptCurrentResponse).not.toHaveBeenCalled();
  });

  it('clears stale builtin agent errors before starting an injected turn', async () => {
    mocks.getAndClearLastAgentError.mockReturnValueOnce('stale previous error');

    const result = await runInjectedTurn({
      prompt: 'heartbeat',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({ success: true, text: 'builtin answer' });
    expect(mocks.getAndClearLastAgentError).toHaveBeenCalledTimes(1);
    expect(mocks.getAndClearLastAgentError.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.enqueueUserMessage.mock.invocationCallOrder[0]);
  });

  it('does not install an injected-turn-specific MCP admission gate', async () => {
    const result = await runInjectedTurn({
      prompt: 'heartbeat',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ success: true, enqueued: true });
    expect(mocks.enqueueUserMessage.mock.calls[0]?.[11]).not.toHaveProperty('beforeUserPersistence');
    expect(mocks.enqueueUserMessage.mock.calls[0]?.[11]).toMatchObject({
      beforeDispatch: expect.any(Function),
    });
  });

  it('preserves the domain dispatch guard as the only injected-turn guard', async () => {
    const domainGuard = Object.assign(vi.fn(async () => ({ accepted: true })), {
      cancel: vi.fn(),
    });

    const result = await runInjectedTurn({
      prompt: 'run cron',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'cron', taskId: 'task-1', intervalMinutes: 15, aiCanExit: false },
      permissionMode: 'fullAgency',
      timeoutMs: 1_000,
      beforeDispatch: domainGuard,
    });

    expect(result).toMatchObject({ success: true, enqueued: true });
    expect(mocks.enqueueUserMessage).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueUserMessage.mock.calls[0]?.[11]).not.toHaveProperty('beforeUserPersistence');
    expect(mocks.enqueueUserMessage.mock.calls[0]?.[11]).toEqual(expect.objectContaining({
      beforeDispatch: domainGuard,
    }));
    expect(domainGuard).toHaveBeenCalledOnce();
  });

  it('leaves external injected turns outside the builtin MCP readiness gate', async () => {
    mocks.state.useExternal = true;

    await runInjectedTurn({
      prompt: 'heartbeat',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'no-restrictions',
      timeoutMs: 1_000,
    });

    expect(mocks.enqueueUserMessage).not.toHaveBeenCalled();
    expect(mocks.sendExternalMessage).toHaveBeenCalled();
  });

  it.each([
    { metadataBirthPending: true, expected: true },
    { metadataBirthPending: undefined, expected: false },
  ])(
    'maps builtin injected-turn birth authority to lazy materialization: $expected',
    async ({ metadataBirthPending, expected }) => {
      await runInjectedTurn({
        prompt: 'heartbeat',
        sessionId: 'sid',
        workspacePath: '/workspace',
        scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
        metadataBirthPending,
        permissionMode: 'fullAgency',
        timeoutMs: 1000,
      });

      expect(mocks.enqueueUserMessage.mock.calls[0][11]).toMatchObject({
        allowLazySessionMaterialization: expected,
      });
    },
  );

  it('uses the queue item terminal observer instead of global message history', async () => {
    mocks.enqueueUserMessage.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[11] as {
        queueId: string;
        beforeDispatch?: () => Promise<{
          accepted: boolean;
          validateAtCommit?: () => { accepted: boolean; error?: string };
        }>;
        onTerminal: (outcome: { status: 'complete'; assistantMessagePresent: boolean; text: string }) => void;
      };
      const dispatchAcceptance = options.beforeDispatch
        ? options.beforeDispatch().then(result => (
          result.accepted && result.validateAtCommit ? result.validateAtCommit() : result
        ))
        : Promise.resolve({ accepted: true });
      queueMicrotask(() => {
        void dispatchAcceptance.then(acceptance => {
          if (!acceptance.accepted) return;
          options.onTerminal({
            status: 'complete',
            assistantMessagePresent: true,
            text: '',
          });
        });
      });
      return { queued: true, queueId: options.queueId, dispatchAcceptance };
    });
    const result = await runInjectedTurn({
      prompt: 'memory update',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({
      success: true,
      enqueued: true,
      assistantMessagePresent: true,
      text: '',
    });
    expect(mocks.enqueueUserMessage.mock.calls[0][11]).toMatchObject({
      queueId: expect.any(String),
      onTerminal: expect.any(Function),
    });
  });

  it('forces every synchronous injected turn onto a turn boundary', async () => {
    const result = await runInjectedTurn({
      prompt: 'continue goal',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1000,
      pollMs: 1,
      queueId: 'goal-queue',
      turnOwner: { kind: 'goal', id: 'goal-1' },
    });

    expect(result.success).toBe(true);
    expect(mocks.enqueueUserMessage.mock.calls[0][11]).toMatchObject({
      queueId: 'goal-queue',
      turnOwner: { kind: 'goal', id: 'goal-1' },
      onTerminal: expect.any(Function),
      queueResponseModeOverride: 'turn',
    });
  });

  it('restores Goal MCP from the session snapshot only when the active set is uninitialized', async () => {
    mocks.getMcpServers.mockReturnValueOnce(null as never);

    const result = await getSessionEngine().ensureGoalSessionConfig();

    expect(result).toEqual({ success: true });
    expect(mocks.resolveWorkspaceConfig).toHaveBeenCalledWith(
      '/workspace',
      expect.objectContaining({ id: 'builtin-session' }),
      { includeMcp: true },
    );
    expect(mocks.applyMcpOverrideAndAwaitReady).toHaveBeenCalledWith([{ id: 'snapshot-mcp' }]);
  });

  it('preserves an initialized empty Goal MCP set', async () => {
    mocks.getMcpServers.mockReturnValueOnce([]);

    const result = await getSessionEngine().ensureGoalSessionConfig();

    expect(result).toEqual({ success: true });
    expect(mocks.resolveWorkspaceConfig).not.toHaveBeenCalled();
    expect(mocks.applyMcpOverrideAndAwaitReady).not.toHaveBeenCalled();
  });

  it('propagates a builtin queue item terminal error without reading stale history', async () => {
    mocks.enqueueUserMessage.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[11] as {
        queueId: string;
        beforeDispatch?: () => Promise<{
          accepted: boolean;
          validateAtCommit?: () => { accepted: boolean; error?: string };
        }>;
        onTerminal: (outcome: { status: 'error'; assistantMessagePresent: false; text: string; error: string }) => void;
      };
      const dispatchAcceptance = options.beforeDispatch
        ? options.beforeDispatch().then(result => (
          result.accepted && result.validateAtCommit ? result.validateAtCommit() : result
        ))
        : Promise.resolve({ accepted: true });
      queueMicrotask(() => {
        void dispatchAcceptance.then(acceptance => {
          if (!acceptance.accepted) return;
          options.onTerminal({
            status: 'error',
            assistantMessagePresent: false,
            text: '',
            error: 'turn failed',
          });
        });
      });
      return { queued: true, queueId: options.queueId, dispatchAcceptance };
    });
    const result = await runInjectedTurn({
      prompt: 'memory update',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 503,
      error: 'turn failed',
    });
  });

  it('gates external injected turns on their turn-local outcome', async () => {
    mocks.state.useExternal = true;
    mocks.sendExternalMessage.mockImplementationOnce(async (...args: unknown[]) => {
      const context = args[4] as {
        onTerminal: (outcome: { status: 'error'; assistantMessagePresent: false; text: string; error: string }) => void;
      };
      queueMicrotask(() => context.onTerminal({
        status: 'error',
        assistantMessagePresent: false,
        text: '',
        error: 'target turn failed',
      }));
      return { queued: true };
    });

    const result = await runInjectedTurn({
      prompt: 'update memory',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'no-restrictions',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 503,
      error: 'target turn failed',
    });
    expect(mocks.getLastExternalAssistantText).not.toHaveBeenCalled();
    expect(mocks.didLastTurnSucceed).not.toHaveBeenCalled();
  });

  it('does not attribute a subsequent external global snapshot to the queue turn', async () => {
    mocks.state.useExternal = true;
    mocks.didLastTurnSucceed.mockReturnValueOnce(false);
    mocks.getLastExternalAssistantText.mockReturnValueOnce('later user turn answer');

    const result = await runInjectedTurn({
      prompt: 'update memory',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'no-restrictions',
      timeoutMs: 1000,
      pollMs: 1,
    });

    expect(result).toMatchObject({
      success: true,
      enqueued: true,
      text: 'external answer',
    });
    expect(mocks.didLastTurnSucceed).not.toHaveBeenCalled();
    expect(mocks.getLastExternalAssistantText).not.toHaveBeenCalled();
  });

  it('forwards model sync source options to the external engine', async () => {
    mocks.state.useExternal = true;

    const result = await getSessionEngine().updateModel('channel-model', { imConfigSync: true });

    expect(result).toEqual({ success: true });
    expect(mocks.setExternalModel).toHaveBeenCalledWith('channel-model', { imConfigSync: true });
  });

  it('passes metadataBirthPending into external IM admission', async () => {
    mocks.state.useExternal = true;

    await getSessionEngine().enqueueImMessage({
      message: 'hello from im',
      requestId: 'req-1',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
      metadataBirthPending: true,
    });

    expect(mocks.enqueueExternalSendForIm).toHaveBeenCalledWith(
      'hello from im',
      undefined,
      expect.objectContaining({
        sessionId: 'sid',
        workspacePath: '/workspace',
        requestId: 'req-1',
        metadataBirthPending: true,
        channelDelivery: {
          user: 'none',
          assistant: 'reply-router',
        },
      }),
    );
  });

  it('accepts a busy external IM turn without waiting for its queued dispatch', async () => {
    mocks.state.useExternal = true;
    let resolveDispatch!: (result: { queued: boolean; error?: string }) => void;
    const dispatch = new Promise<{ queued: boolean; error?: string }>((resolve) => {
      resolveDispatch = resolve;
    });
    mocks.enqueueExternalSendForIm.mockReturnValueOnce({
      queued: true,
      queueId: 'xq-im-follow-up',
      dispatch,
    });

    const result = await getSessionEngine().enqueueImMessage({
      message: 'follow-up while running',
      requestId: 'req-follow-up',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
    });

    expect(result).toMatchObject({ success: true, queued: true });
    expect(result.dispatchAcceptance).toBeInstanceOf(Promise);

    let acceptanceSettled = false;
    void result.dispatchAcceptance?.then(() => { acceptanceSettled = true; });
    await Promise.resolve();
    expect(acceptanceSettled).toBe(false);

    resolveDispatch({ queued: true });
    await expect(result.dispatchAcceptance).resolves.toEqual({ accepted: true });
  });

  it.each([
    { metadataBirthPending: true, expected: true },
    { metadataBirthPending: undefined, expected: false },
  ])(
    'maps external injected-turn birth authority to runtime materialization: $expected',
    async ({ metadataBirthPending, expected }) => {
      mocks.state.useExternal = true;

      await runInjectedTurn({
        prompt: 'heartbeat',
        assistantChannelDelivery: 'caller-owned',
        sessionId: 'sid',
        workspacePath: '/workspace',
        scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
        metadataBirthPending,
        permissionMode: 'no-restrictions',
        timeoutMs: 1000,
      });

      expect(mocks.sendExternalMessage).toHaveBeenCalledWith(
        'heartbeat',
        undefined,
        undefined,
        undefined,
        expect.objectContaining({
          sessionId: 'sid',
          workspacePath: '/workspace',
          metadataBirthPending: expected,
          channelDelivery: {
            user: 'none',
            assistant: 'caller-owned',
          },
        }),
      );
    },
  );

  it('updates official tool ids through the builtin engine owner', async () => {
    const result = await getSessionEngine().updateOfficialToolIds(['image-understanding']);

    expect(result).toEqual({ success: true });
    expect(mocks.setSessionEnabledOfficialToolIds).toHaveBeenCalledWith(['image-understanding']);
    expect(mocks.updateSessionMetadata).not.toHaveBeenCalled();
  });

  it('updates official tool ids through the external engine owner', async () => {
    mocks.state.useExternal = true;

    const result = await getSessionEngine().updateOfficialToolIds([]);

    expect(result).toEqual({ success: true });
    expect(mocks.updateSessionMetadata).not.toHaveBeenCalled();
    expect(mocks.handleExternalOfficialToolIdsChange).toHaveBeenCalledWith([]);
  });

  it('stops an idle live external runtime process before committing desktop materialization', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalProcessAlive = true;
    mocks.getExternalSessionId.mockReturnValueOnce('runtime-thread-id');

    const result = await getSessionEngine().materializePendingDesktopSession({
      workspacePath: '/workspace',
      phase: 'commit',
      preparedSessionId: 'builtin-session',
    });

    expect(result).toEqual({ success: true, sessionId: 'builtin-session' });
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.materializePendingDesktopSession.mock.invocationCallOrder[0]);
    expect(mocks.updateSessionMetadata).toHaveBeenCalledWith('builtin-session', { runtimeSessionId: 'runtime-thread-id' });
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith('builtin-session', '/workspace', { type: 'desktop' });
  });

  it('stops the external runtime when an injected turn times out', async () => {
    mocks.state.useExternal = true;
    mocks.sendExternalMessage.mockImplementationOnce(async (...args: unknown[]) => {
      const onDispatchAccepted = args[6] as (() => void) | undefined;
      onDispatchAccepted?.();
      return { queued: true };
    });

    const result = await runInjectedTurn({
      prompt: 'heartbeat',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'no-restrictions',
      timeoutMs: 20,
      pollMs: 1,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 408,
      error: 'Execution timed out',
    });
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.didLastTurnSucceed).not.toHaveBeenCalled();
  });

  it('cancels an external Goal guard without stopping an unrelated turn when setup times out', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;
    mocks.sendExternalMessage.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const beforeDispatch = Object.assign(vi.fn(), { cancel: vi.fn() });

    const result = await runInjectedTurn({
      prompt: 'goal continuation',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: {
        type: 'cron',
        taskId: 'goal-1',
        intervalMinutes: 0,
        aiCanExit: true,
      },
      permissionMode: 'no-restrictions',
      timeoutMs: 1,
      pollMs: 1,
      beforeDispatch,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: false,
      status: 408,
      error: 'External runtime turn timed out before dispatch',
    });
    expect(beforeDispatch.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
  });

  it.each([
    { phase: 'dispatch acceptance', stallSend: true },
    { phase: 'terminal outcome', stallSend: false },
  ])('keeps the exact external Task binding when $phase times out and stop is unconfirmed', async ({ stallSend }) => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;
    mocks.stopExternalSession
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mocks.sendExternalMessage.mockImplementationOnce((...args: unknown[]) => {
      const context = args[4] as {
        queueId: string;
        turnOwner: { kind: 'task'; id: string };
      };
      mocks.state.externalCurrentQueueId = context.queueId;
      mocks.state.externalTurnIdentity = {
        queueId: context.queueId,
        owner: context.turnOwner,
      };
      return stallSend
        ? new Promise(() => undefined)
        : Promise.resolve({ queued: true });
    });

    const result = await runInjectedTurn({
      prompt: 'memory update',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'no-restrictions',
      timeoutMs: 1,
      pollMs: 1,
      queueId: 'task-orphan-turn',
      turnOwner: { kind: 'task', id: 'task-1' },
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 408,
      terminationUnconfirmed: true,
      error: 'External runtime turn timed out and its process did not stop',
    });
    expect(mocks.clearExternalTurnBinding).not.toHaveBeenCalled();

    await expect(stopOwnedTurnByQueueId(
      { kind: 'task', id: 'task-1' },
      'task-orphan-turn',
    )).resolves.toEqual({ success: true, alreadyStopped: false });
    expect(mocks.stopExternalSession).toHaveBeenNthCalledWith(1, { preserveQueue: true });
    expect(mocks.stopExternalSession).toHaveBeenNthCalledWith(2, { preserveQueue: true });
  });

  it('keeps the exact external Task binding when dispatch acknowledgement is lost and stop is unconfirmed', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;
    mocks.sendExternalMessage.mockImplementationOnce(async (...args: unknown[]) => {
      const context = args[4] as {
        queueId: string;
        turnOwner: { kind: 'task'; id: string };
      };
      mocks.state.externalCurrentQueueId = context.queueId;
      mocks.state.externalTurnIdentity = {
        queueId: context.queueId,
        owner: context.turnOwner,
      };
      return {
        queued: false,
        error: 'dispatch acknowledgement lost; process termination unconfirmed',
        terminationUnconfirmed: true,
      };
    });

    const result = await runInjectedTurn({
      prompt: 'task turn',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'no-restrictions',
      timeoutMs: 100,
      pollMs: 1,
      queueId: 'task-dispatch-ambiguous',
      turnOwner: { kind: 'task', id: 'task-1' },
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      terminationUnconfirmed: true,
      status: 503,
    });
    expect(mocks.clearExternalTurnBinding).not.toHaveBeenCalled();

    await expect(stopOwnedTurnByQueueId(
      { kind: 'task', id: 'task-1' },
      'task-dispatch-ambiguous',
    )).resolves.toEqual({ success: true, alreadyStopped: false });
    expect(mocks.stopExternalSession).toHaveBeenCalledWith({ preserveQueue: true });
  });

  it('conservatively accepts an external Goal IM turn whose dispatch may already be running', async () => {
    mocks.state.useExternal = true;
    mocks.enqueueExternalSendForIm.mockReturnValueOnce({
      queued: true,
      dispatch: Promise.resolve({
        queued: false,
        error: 'dispatch acknowledgement lost; process termination unconfirmed',
        terminationUnconfirmed: true,
      }),
    });

    const result = await getSessionEngine().enqueueImMessage({
      message: 'goal user turn',
      requestId: 'req-ambiguous',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
      queueId: 'goal-dispatch-ambiguous',
      turnOwner: { kind: 'goal', id: 'goal-1' },
    });

    expect(result).toEqual({ success: true, queued: true });
    expect(mocks.clearExternalTurnBinding).not.toHaveBeenCalled();
  });

  it('serializes external desktop reset against an in-flight runtime start', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;

    const result = await getSessionEngine().resetForNewDesktopSession('/workspace');

    expect(result).toEqual({ success: true, sessionId: 'builtin-session' });
    expect(mocks.awaitExternalSessionStarting).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.resetSession).toHaveBeenCalledTimes(1);
    expect(mocks.awaitExternalSessionStarting.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.stopExternalSession.mock.invocationCallOrder[0]);
    expect(mocks.stopExternalSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.resetSession.mock.invocationCallOrder[0]);
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith('builtin-session', '/workspace', { type: 'desktop' });
  });

  it('stops an idle live external runtime process before desktop reset mints a new session', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalProcessAlive = true;

    const result = await getSessionEngine().resetForNewDesktopSession('/workspace');

    expect(result).toEqual({ success: true, sessionId: 'builtin-session' });
    expect(mocks.awaitExternalSessionStarting).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.resetSession).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.resetSession.mock.invocationCallOrder[0]);
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith('builtin-session', '/workspace', { type: 'desktop' });
  });

  it('restores external switch when lifecycle is bound but transcript state is not seeded', async () => {
    mocks.state.useExternal = true;
    mocks.getCurrentBoundSessionId.mockReturnValueOnce('target-session');
    mocks.isExternalSessionStateRestoredFor.mockReturnValueOnce(false);

    const result = await getSessionEngine().switchToExistingSession(
      'target-session',
      '/workspace',
      (sessionId) => ({
        id: sessionId,
        agentDir: '/workspace',
        title: 'Target',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:00:00.000Z',
        runtime: 'codex',
      }),
    );

    expect(result).toEqual({ success: true, sessionId: 'target-session' });
    expect(mocks.awaitExternalSessionStarting).toHaveBeenCalledTimes(1);
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith('target-session', '/workspace', { type: 'desktop' });
  });

  it('stops an idle live external runtime process before switching external history sessions', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalProcessAlive = true;

    const result = await getSessionEngine().switchToExistingSession(
      'target-session',
      '/workspace',
      (sessionId) => ({
        id: sessionId,
        agentDir: '/workspace',
        title: 'Target',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:00:00.000Z',
        runtime: 'codex',
      }),
    );

    expect(result).toEqual({ success: true, sessionId: 'target-session' });
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.restoreExternalSessionState.mock.invocationCallOrder[0]);
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith('target-session', '/workspace', { type: 'desktop' });
  });

  it('rejects external history switches across Codex runtime sources', async () => {
    mocks.state.useExternal = true;
    mocks.getActiveRuntimeSource.mockReturnValueOnce('managed-provider');

    const result = await getSessionEngine().switchToExistingSession(
      'system-codex-session',
      '/workspace',
      (sessionId) => ({
        id: sessionId,
        agentDir: '/workspace',
        title: 'System Codex',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:00:00.000Z',
        runtime: 'codex',
        runtimeSource: 'system-cli',
      }),
    );

    expect(result).toMatchObject({
      success: false,
      status: 409,
      error: 'Session runtime source mismatch: persisted=system-cli, current=managed-provider',
    });
    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
    expect(mocks.restoreExternalSessionState).not.toHaveBeenCalled();
  });

  it('does not restore an external switch once an in-flight target start finishes seeded', async () => {
    mocks.state.useExternal = true;
    mocks.getCurrentBoundSessionId.mockReturnValue('target-session');
    mocks.isExternalSessionStateRestoredFor
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const getMetadata = vi.fn();

    const result = await getSessionEngine().switchToExistingSession(
      'target-session',
      '/workspace',
      getMetadata,
    );

    expect(result).toEqual({ success: true, sessionId: 'target-session' });
    expect(mocks.awaitExternalSessionStarting).toHaveBeenCalledTimes(1);
    expect(getMetadata).not.toHaveBeenCalled();
    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
    expect(mocks.restoreExternalSessionState).not.toHaveBeenCalled();
  });

  it('freezes the current builtin IM session before resetting to a new IM session', async () => {
    const result = await getSessionEngine().resetForNewImSession('/workspace');

    expect(result).toEqual({ success: true, sessionId: 'builtin-session' });
    expect(mocks.freezeCurrentSessionMetadataForImDetach).toHaveBeenCalledTimes(1);
    expect(mocks.freezeCurrentSessionMetadataForImDetach).toHaveBeenCalledWith(undefined, {
      allowMissingMetadata: false,
    });
    expect(mocks.resetSession).toHaveBeenCalledTimes(1);
    expect(mocks.materializeCurrentSessionMetadataForPublishedReset).toHaveBeenCalledTimes(1);
    expect(mocks.freezeCurrentSessionMetadataForImDetach.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.resetSession.mock.invocationCallOrder[0]);
    expect(mocks.resetSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.materializeCurrentSessionMetadataForPublishedReset.mock.invocationCallOrder[0]);
  });

  it('freezes the current external IM session with external runtime config before reset', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = true;
    mocks.getActiveRuntimeType.mockReturnValueOnce('codex');
    mocks.getExternalSessionModel.mockReturnValueOnce('gpt-5');
    mocks.getExternalSessionPermissionMode.mockReturnValueOnce('no-restrictions');
    mocks.getExternalSessionReasoningEffort.mockReturnValueOnce('medium');

    const result = await getSessionEngine().resetForNewImSession('/workspace');

    expect(result).toEqual({ success: true, sessionId: 'builtin-session' });
    expect(mocks.awaitExternalSessionStarting).toHaveBeenCalledTimes(1);
    expect(mocks.freezeCurrentSessionMetadataForImDetach).toHaveBeenCalledWith(
      {
        runtime: 'codex',
        runtimeSource: 'system-cli',
        model: 'gpt-5',
        permissionMode: 'no-restrictions',
        reasoningEffort: 'medium',
      },
      {
        allowMissingMetadata: false,
      },
    );
    expect(mocks.freezeCurrentSessionMetadataForImDetach.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.stopExternalSession.mock.invocationCallOrder[0]);
    expect(mocks.stopExternalSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.resetSession.mock.invocationCallOrder[0]);
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith('builtin-session', '/workspace', { type: 'desktop' });
  });

  it('stops an idle live external runtime process before external IM reset', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalProcessAlive = true;

    const result = await getSessionEngine().resetForNewImSession('/workspace');

    expect(result).toEqual({ success: true, sessionId: 'builtin-session' });
    expect(mocks.freezeCurrentSessionMetadataForImDetach).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.stopExternalSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.resetSession.mock.invocationCallOrder[0]);
    expect(mocks.restoreExternalSessionState).toHaveBeenCalledWith('builtin-session', '/workspace', { type: 'desktop' });
  });

  it('freezes the current external IM session through the engine facade', async () => {
    mocks.state.useExternal = true;
    mocks.getActiveRuntimeSource.mockReturnValueOnce('managed-provider');

    const result = await getSessionEngine().freezeCurrentSessionForImDetach({
      metadataBirthPending: true,
    });

    expect(result).toEqual({ success: true, sessionId: 'old-im-session' });
    expect(mocks.freezeCurrentSessionMetadataForImDetach).toHaveBeenCalledWith(
      {
        runtime: 'codex',
        runtimeSource: 'managed-provider',
        model: 'gpt-5',
        permissionMode: 'no-restrictions',
        reasoningEffort: 'medium',
        providerExecutionIdentity: {
          kind: 'runtime-backed-provider',
          providerId: 'codex-sub',
          runtime: 'codex',
          runtimeSource: 'managed-provider',
          model: 'gpt-5',
        },
      },
      {
        allowMissingMetadata: true,
      },
    );
  });

  it('allows freezing explicit unindexed IM sessions with missing metadata', async () => {
    const result = await getSessionEngine().freezeCurrentSessionForImDetach({
      metadataBirthPending: false,
      metadataIndexed: false,
    });

    expect(result).toEqual({ success: true, sessionId: 'old-im-session' });
    expect(mocks.freezeCurrentSessionMetadataForImDetach).toHaveBeenCalledWith(undefined, {
      allowMissingMetadata: true,
    });
  });

  it('routes permission responses by external liveness compatibility', () => {
    mocks.state.useExternal = true;

    mocks.state.externalActive = false;
    expect(getPermissionResponseEngine().kind).toBe('builtin');

    mocks.state.externalActive = true;
    expect(getPermissionResponseEngine().kind).toBe('external');
  });

  it('routes AskUserQuestion responses by pending external request ownership', () => {
    mocks.state.useExternal = true;

    mocks.state.pendingExternalAsk = false;
    expect(getAskUserQuestionResponseEngine('ask-1').kind).toBe('builtin');

    mocks.state.pendingExternalAsk = true;
    expect(getAskUserQuestionResponseEngine('ask-1').kind).toBe('external');
  });
});
