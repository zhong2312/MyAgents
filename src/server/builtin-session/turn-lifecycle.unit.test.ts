import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendMessage, resetTranscriptForTest, transcriptState } from './transcript';
import {
  accumulateCurrentTurnUsage,
  markCurrentTurnHasOutput,
  peekPendingOutputOwner,
  popPendingOutputOwner,
  pushPendingOutputOwner,
  resetTurnForTest,
  setCurrentTurnCompactResult,
  setCurrentTurnSourceItem,
  setCurrentTurnStartTime,
  setCurrentTurnToolCount,
  setSawCompactBoundary,
  waitForCurrentTurnTerminalObserver,
} from './turn';
import {
  resetQueueForTest,
  setForceSurfaceInFlightId,
  setInFlightQueueItem,
  setInterruptingInFlightQueueId,
} from './queue';
import {
  createBuiltinTurnLifecycle,
  type BuiltinSdkResultMessage,
  type BuiltinTurnLifecycleDeps,
} from './turn-lifecycle';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeResult(overrides: Record<string, unknown> = {}): BuiltinSdkResultMessage {
  return ({
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 5,
    is_error: false,
    num_turns: 1,
    result: '',
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    terminal_reason: 'completed',
    uuid: '00000000-0000-4000-8000-000000000001',
    session_id: 'session-1',
    ...overrides,
  } as unknown) as BuiltinSdkResultMessage;
}

function makeDeps(overrides: Partial<BuiltinTurnLifecycleDeps> = {}) {
  const broadcasts: Array<{ event: string; data: unknown }> = [];
  const broadcast = vi.fn((event: string, data: unknown) => broadcasts.push({ event, data }));
  const deps: BuiltinTurnLifecycleDeps = {
    getSessionId: () => 'session-1',
    getWorkspacePath: () => '/tmp/workspace',
    getCurrentScenario: () => ({ type: 'desktop' }),
    getProviderEnv: () => undefined,
    getCurrentModel: () => 'claude-test',
    getIsInterruptingResponse: () => false,
    setStreamingMessage: vi.fn(),
    resetInFlightToolCount: vi.fn(),
    resetWatchdogFired: vi.fn(),
    claimPostInterruptResultTerminal: vi.fn(),
    terminalEventAppliesToCurrentInFlight: () => true,
    dropInFlightQueueItem: vi.fn(() => null),
    preserveInFlightAfterTerminalBoundary: vi.fn(),
    surfaceInFlightQueueItem: vi.fn(async () => undefined),
    schedulePostTerminalQueueDrain: vi.fn(),
    endTurnAbort: vi.fn(),
    abortTurnAbort: vi.fn(),
    clearAmbientTurnId: vi.fn(),
    completeCurrentImRequest: vi.fn(),
    cancelCurrentImRequest: vi.fn(),
    failCurrentImRequest: vi.fn(),
    clearMirrorState: vi.fn(),
    clearStreamTurnMaps: vi.fn(),
    clearCronTaskContext: vi.fn(),
    hasQueuedOrInFlightWork: () => false,
    setSessionState: vi.fn(),
    persistTranscript: vi.fn(async () => undefined),
    snapshotTrace: () => null,
    emitTrace: vi.fn(),
    emitFirstDeltaTrace: vi.fn(),
    clearTrace: vi.fn(),
    nowMs: () => 100,
    elapsedMs: () => 1,
    broadcast,
    broadcastBuiltinContextUsage: vi.fn(async () => undefined),
    getCurrentTransientProviderRetryAttempt: () => 0,
    scheduleTransientProviderRetry: vi.fn(() => false),
    retractTransientProviderTextOutput: vi.fn(),
    clearApiRetryStatus: vi.fn(),
    trackServer: vi.fn(),
    firePostTurnTitleHook: vi.fn(),
    appendTextChunk: vi.fn(() => true),
    localizeImError: (error) => `localized:${error}`,
    setLastAgentError: vi.fn(),
    buildTurnProviderAnalytics: () => ({
      provider_name: null,
      api_protocol: null,
      provider_base_url: null,
      provider_api_protocol: null,
    }),
    probeForkPersistenceIfReady: vi.fn(),
    recoverInvalidResumeAnchorError: vi.fn(() => false),
    handleTerminalRecovery: vi.fn(),
    applyDeferredRestartIfNeeded: vi.fn(),
    ...overrides,
  };
  return { deps, broadcasts };
}

describe('turn-lifecycle owner', () => {
  beforeEach(() => {
    resetTranscriptForTest();
    resetTurnForTest();
    resetQueueForTest();
  });

  it('broadcasts successful result, persists, then fires title hook after persist settles', async () => {
    const persist = deferred();
    const { deps, broadcasts } = makeDeps({
      persistTranscript: vi.fn(() => persist.promise),
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    appendMessage({
      id: '1',
      role: 'assistant',
      content: 'hello',
      timestamp: '2026-06-21T00:00:00.000Z',
    });
    markCurrentTurnHasOutput();
    setCurrentTurnStartTime(90);
    const onTerminal = vi.fn();
    setCurrentTurnSourceItem({
      id: 'goal-turn',
      message: { role: 'user', content: 'run' },
      messageText: 'run',
      wasQueued: false,
      resolve: vi.fn(),
      turnOwner: { kind: 'goal', id: 'goal-1' },
      onTerminal,
      activityFacts: {
        origin: { kind: 'desktop', surface: 'launcher_input' },
        inputText: 'run',
      },
    });
    accumulateCurrentTurnUsage({ inputTokens: 100, outputTokens: 20 });

    lifecycle.handleSdkResult(makeResult({
      result: 'hello',
      usage: {
        input_tokens: 12,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2,
      },
    }));

    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-complete');
    expect(transcriptState.messages[0]).toMatchObject({
      usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 2 },
    });
    expect(onTerminal).not.toHaveBeenCalled();
    expect(deps.firePostTurnTitleHook).not.toHaveBeenCalled();
    expect(deps.setSessionState).not.toHaveBeenCalled();
    expect(deps.persistTranscript).toHaveBeenCalledWith(undefined, expect.any(String));

    persist.resolve();
    await persist.promise;
    await lifecycle.getLastTurnEndPersist();
    await waitForCurrentTurnTerminalObserver();

    expect(broadcasts.map(item => item.event)).toContain('chat:message-complete');
    expect(broadcasts.find(item => item.event === 'chat:message-complete')?.data).toMatchObject({
      completionTerminal: {
        sessionId: 'session-1',
        workspacePath: '/tmp/workspace',
        turnId: 'goal-turn',
        turnOwner: { kind: 'goal', id: 'goal-1' },
        origin: { kind: 'desktop', surface: 'launcher_input' },
        status: 'complete',
      },
    });
    const completeCall = vi.mocked(deps.broadcast).mock.calls.findIndex(([event]) => event === 'chat:message-complete');
    expect(vi.mocked(deps.broadcast).mock.invocationCallOrder[completeCall]).toBeLessThan(
      vi.mocked(deps.setSessionState).mock.invocationCallOrder[0],
    );
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'complete',
      usage: { inputTokens: 12, outputTokens: 5 },
    }));
    expect(deps.firePostTurnTitleHook).toHaveBeenCalledWith(
      'session-1',
      'builtin',
      'claude-test',
      undefined,
    );
  });

  it('routes empty successful result to message-error instead of message-complete', () => {
    const { deps, broadcasts } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);

    lifecycle.handleSdkResult(makeResult());

    expect(broadcasts.map(item => item.event)).toContain('chat:message-error');
    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-complete');
    expect(deps.failCurrentImRequest).toHaveBeenCalledWith({
      finalPayloads: [{ text: expect.stringContaining('AI 未返回任何内容'), isError: true }],
    });
    expect(transcriptState.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('AI 未返回任何内容'),
    });
  });

  it('suppresses IM error forwarding for aborted SDK diagnostic results', async () => {
    const { deps } = makeDeps({
      getIsInterruptingResponse: () => true,
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    pushPendingOutputOwner('queue-1', 'req-1');

    lifecycle.handleSdkResult(makeResult({
      subtype: 'error_during_execution',
      is_error: true,
      result: '[ede_diagnostic] result_type=user abort',
      terminal_reason: 'aborted_streaming',
      errors: ['internal abort'],
    }));
    await lifecycle.getLastTurnEndPersist();

    expect(deps.failCurrentImRequest).not.toHaveBeenCalled();
    expect(deps.cancelCurrentImRequest).toHaveBeenCalledWith({
      finalPayloads: [{ text: '🛑 已取消' }],
    });
    expect(deps.completeCurrentImRequest).not.toHaveBeenCalled();
    expect(deps.claimPostInterruptResultTerminal).toHaveBeenCalledOnce();
  });

  it.each([
    { label: 'successful', result: makeResult({ result: 'fallback answer' }) },
    {
      label: 'error',
      result: makeResult({
        subtype: 'error_during_execution',
        is_error: true,
        result: 'provider error',
      }),
    },
  ])('consumes one non-IM output owner for a $label no-output result', async ({ result }) => {
    const completeCurrentImRequest = vi.fn(() => {
      popPendingOutputOwner();
    });
    const { deps } = makeDeps({ completeCurrentImRequest });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    pushPendingOutputOwner('desktop-a', null);
    pushPendingOutputOwner('queue-b', 'request-b');

    lifecycle.handleSdkResult(result);
    await lifecycle.getLastTurnEndPersist();

    expect(completeCurrentImRequest).toHaveBeenCalledOnce();
    expect(peekPendingOutputOwner()).toEqual({ queueId: 'queue-b', requestId: 'request-b' });
  });

  it('lets a graceful interrupt result claim exactly one IM terminal owner', async () => {
    const persist = deferred();
    const cancelCurrentImRequest = vi.fn(() => {
      popPendingOutputOwner();
    });
    const { deps, broadcasts } = makeDeps({
      getIsInterruptingResponse: () => true,
      persistTranscript: vi.fn(() => persist.promise),
      cancelCurrentImRequest,
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    pushPendingOutputOwner('queue-a', 'request-a');
    pushPendingOutputOwner('queue-b', 'request-b');
    markCurrentTurnHasOutput();

    lifecycle.handleSdkResult(makeResult({
      terminal_reason: 'aborted_streaming',
      result: 'partial answer',
    }));

    expect(cancelCurrentImRequest).toHaveBeenCalledOnce();
    expect(deps.completeCurrentImRequest).not.toHaveBeenCalled();
    expect(deps.claimPostInterruptResultTerminal).toHaveBeenCalledOnce();
    expect(peekPendingOutputOwner()).toEqual({ queueId: 'queue-b', requestId: 'request-b' });

    persist.resolve();
    await lifecycle.getLastTurnEndPersist();

    expect(cancelCurrentImRequest).toHaveBeenCalledOnce();
    expect(peekPendingOutputOwner()).toEqual({ queueId: 'queue-b', requestId: 'request-b' });
    expect(broadcasts.map(item => item.event)).toContain('chat:message-stopped');
    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-complete');
  });

  it('recovers SDK missing resume anchor result errors without surfacing a user error', () => {
    const { deps, broadcasts } = makeDeps({
      recoverInvalidResumeAnchorError: vi.fn(() => true),
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);

    lifecycle.handleSdkResult(makeResult({
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Claude Code returned an error result: No message found with message.uuid of: 75c9051f-a071-4243-bc25-92cfc396e2db',
      terminal_reason: 'error',
    }));

    expect(deps.recoverInvalidResumeAnchorError).toHaveBeenCalledWith(
      'Claude Code returned an error result: No message found with message.uuid of: 75c9051f-a071-4243-bc25-92cfc396e2db',
    );
    expect(broadcasts.map(item => item.event)).not.toContain('chat:agent-error');
    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-error');
    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-complete');
    expect(deps.persistTranscript).not.toHaveBeenCalled();
    expect(deps.abortTurnAbort).toHaveBeenCalledWith('session-1', 'error');
  });

  it('does not notify the queue turn for recoverable resume anchor errors', () => {
    const { deps } = makeDeps({
      recoverInvalidResumeAnchorError: vi.fn(() => true),
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    const onTerminal = vi.fn();
    setCurrentTurnSourceItem({
      id: 'queue-replay',
      message: { role: 'user', content: 'retry' },
      messageText: 'retry',
      wasQueued: false,
      resolve: vi.fn(),
      onTerminal,
    });

    lifecycle.handleSdkResult(makeResult({
      subtype: 'error_during_execution',
      is_error: true,
      result: 'No message found with message.uuid of: 75c9051f-a071-4243-bc25-92cfc396e2db',
      terminal_reason: 'error',
    }));

    expect(onTerminal).not.toHaveBeenCalled();
  });

  it('does not title a completed turn when turn-end persistence fails', async () => {
    const { deps, broadcasts } = makeDeps({
      persistTranscript: vi.fn(async () => {
        throw new Error('durable write failed');
      }),
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    appendMessage({
      id: '1',
      role: 'assistant',
      content: 'hello',
      timestamp: '2026-06-21T00:00:00.000Z',
    });
    markCurrentTurnHasOutput();

    lifecycle.handleSdkResult(makeResult({ result: 'hello' }));

    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-complete');
    await expect(lifecycle.getLastTurnEndPersist()).rejects.toThrow('durable write failed');
    await Promise.resolve();
    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-complete');
    expect(deps.firePostTurnTitleHook).not.toHaveBeenCalled();
    expect(deps.emitTrace).toHaveBeenCalledWith(
      'persist_done',
      expect.objectContaining({ status: 'error' }),
      null,
    );
  });

  it('treats compact control turns as successful even when the SDK result has no visible text', async () => {
    const { deps, broadcasts } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);
    setCurrentTurnCompactResult('success');
    setSawCompactBoundary(true);

    lifecycle.handleSdkResult(makeResult());
    await lifecycle.getLastTurnEndPersist();

    expect(broadcasts.map(item => item.event)).toContain('chat:message-complete');
    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-error');
    expect(deps.failCurrentImRequest).not.toHaveBeenCalled();
  });

  it('auto-retries success-shaped transient provider text instead of completing the turn', () => {
    const { deps, broadcasts } = makeDeps({
      scheduleTransientProviderRetry: vi.fn(() => true),
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);

    lifecycle.handleSdkResult(makeResult({
      result: '[Error]: Concurrency limit exceeded for account, please retry later',
    }));

    expect(deps.retractTransientProviderTextOutput).toHaveBeenCalledWith(
      '[Error]: Concurrency limit exceeded for account, please retry later',
    );
    expect(deps.scheduleTransientProviderRetry).toHaveBeenCalledWith(expect.objectContaining({
      retry: true,
      attempt: 1,
      maxRetries: 3,
      delayMs: 15_000,
      error: expect.objectContaining({ kind: 'concurrency_limit' }),
    }));
    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-complete');
    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-error');
    expect(deps.persistTranscript).not.toHaveBeenCalled();
  });

  it('does not auto-retry transient provider text after tool side effects', () => {
    const { deps, broadcasts } = makeDeps({
      scheduleTransientProviderRetry: vi.fn(() => true),
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    setCurrentTurnToolCount(1);

    lifecycle.handleSdkResult(makeResult({
      result: '[Error]: Concurrency limit exceeded for account, please retry later',
    }));

    expect(deps.scheduleTransientProviderRetry).not.toHaveBeenCalled();
    expect(deps.retractTransientProviderTextOutput).toHaveBeenCalledWith(
      '[Error]: Concurrency limit exceeded for account, please retry later',
    );
    expect(broadcasts.map(item => item.event)).toContain('chat:message-error');
    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-complete');
    expect(deps.setLastAgentError).toHaveBeenCalledWith(expect.stringContaining('无法安全自动重试'));
  });

  it('surfaces a clear terminal error after transient provider text retries are exhausted', () => {
    const { deps, broadcasts } = makeDeps({
      getCurrentTransientProviderRetryAttempt: () => 3,
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);

    lifecycle.handleSdkResult(makeResult({
      result: '[Error]: Concurrency limit exceeded for account, please retry later',
    }));

    expect(deps.retractTransientProviderTextOutput).toHaveBeenCalled();
    expect(deps.scheduleTransientProviderRetry).not.toHaveBeenCalled();
    expect(broadcasts.map(item => item.event)).toContain('chat:message-error');
    expect(broadcasts.map(item => item.event)).not.toContain('chat:message-complete');
    expect(deps.setLastAgentError).toHaveBeenCalledWith(expect.stringContaining('已自动重试 3 次仍失败'));
    expect(transcriptState.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('Error: 上游模型服务达到账号并发限制'),
    });
  });

  it('finalizes stopped turns with queue cleanup, IM completion, and persistence', async () => {
    const { deps } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);
    const onTerminal = vi.fn();
    setCurrentTurnSourceItem({
      id: 'goal-turn',
      message: { role: 'user', content: 'run' },
      messageText: 'run',
      wasQueued: false,
      resolve: vi.fn(),
      onTerminal,
      activityFacts: {
        origin: { kind: 'desktop', surface: 'launcher_input' },
        inputText: 'run',
      },
    });
    accumulateCurrentTurnUsage({ inputTokens: 120, outputTokens: 30 });
    accumulateCurrentTurnUsage({ inputTokens: 80, outputTokens: 20 });

    lifecycle.stopTurn();

    await waitForCurrentTurnTerminalObserver();
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'stopped',
      usage: { inputTokens: 200, outputTokens: 50 },
    }));
    expect(deps.schedulePostTerminalQueueDrain).toHaveBeenCalledWith('stopped');
    expect(deps.endTurnAbort).toHaveBeenCalledWith('session-1');
    expect(deps.completeCurrentImRequest).not.toHaveBeenCalled();
    expect(deps.cancelCurrentImRequest).toHaveBeenCalledWith({
      finalPayloads: [{ text: '🛑 已取消' }],
    });
    expect(deps.persistTranscript).toHaveBeenCalledTimes(1);
    expect(deps.persistTranscript).toHaveBeenCalledWith(undefined, expect.any(String));
  });

  it('persists unexpected errors and commits terminal metadata for expected terminations', async () => {
    const { deps } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);

    lifecycle.failTurn('boom');
    await waitForCurrentTurnTerminalObserver();
    expect(deps.schedulePostTerminalQueueDrain).toHaveBeenCalledWith('error');
    expect(deps.abortTurnAbort).toHaveBeenCalledWith('session-1', 'error');
    expect(deps.failCurrentImRequest).toHaveBeenCalledWith({
      finalPayloads: [{ text: 'localized:boom', isError: true }],
    });
    expect(deps.persistTranscript).toHaveBeenCalledTimes(1);
    expect(transcriptState.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Error: boom',
    });

    resetTranscriptForTest();
    vi.mocked(deps.persistTranscript).mockClear();
    lifecycle.failTurn('AbortError: interrupted');
    await waitForCurrentTurnTerminalObserver();
    expect(deps.persistTranscript).toHaveBeenCalledWith(undefined, undefined);
    expect(transcriptState.messages).toEqual([]);
  });

  it('drains deferred restart ownership after accepted setup fails before SDK dispatch', async () => {
    const { deps } = makeDeps();
    const lifecycle = createBuiltinTurnLifecycle(deps);

    lifecycle.failAdmittedTurnSetup('metadata setup failed');

    await waitForCurrentTurnTerminalObserver();
    expect(deps.schedulePostTerminalQueueDrain).toHaveBeenCalledWith('error');
    expect(deps.applyDeferredRestartIfNeeded).toHaveBeenCalledOnce();
  });

  it('surfaces forced in-flight items but preserves natural completions for SDK replay', () => {
    const { deps } = makeDeps({
      getIsInterruptingResponse: () => true,
    });
    const lifecycle = createBuiltinTurnLifecycle(deps);
    setInFlightQueueItem('queued-1', { messageText: 'run now' });
    setForceSurfaceInFlightId('queued-1');
    setInterruptingInFlightQueueId('queued-1');
    appendMessage({ id: '1', role: 'assistant', content: 'done', timestamp: 't1' });
    markCurrentTurnHasOutput();

    lifecycle.handleSdkResult(makeResult({ result: 'done' }));

    expect(deps.claimPostInterruptResultTerminal).toHaveBeenCalledOnce();
    expect(deps.surfaceInFlightQueueItem).toHaveBeenCalledWith(
      'queued-1',
      { messageText: 'run now' },
      expect.objectContaining({ reason: 'force-send #289' }),
    );
    expect(deps.dropInFlightQueueItem).not.toHaveBeenCalled();

    resetTranscriptForTest();
    resetTurnForTest();
    resetQueueForTest();
    vi.clearAllMocks();
    const natural = makeDeps();
    const naturalLifecycle = createBuiltinTurnLifecycle(natural.deps);
    setInFlightQueueItem('queued-2', { messageText: 'wait for replay' });
    appendMessage({ id: '1', role: 'assistant', content: 'done', timestamp: 't1' });
    markCurrentTurnHasOutput();

    naturalLifecycle.handleSdkResult(makeResult({ result: 'done' }));

    expect(natural.deps.preserveInFlightAfterTerminalBoundary).toHaveBeenCalledWith('natural result');
    expect(natural.deps.surfaceInFlightQueueItem).not.toHaveBeenCalled();
    expect(natural.deps.dropInFlightQueueItem).not.toHaveBeenCalled();
  });
});
