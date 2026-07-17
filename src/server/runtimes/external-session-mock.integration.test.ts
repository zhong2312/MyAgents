import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeType } from '../../shared/types/runtime';
import type { DesktopMessageRequest } from '../session-engine/types';
import type {
  AgentRuntime,
  RuntimeProcess,
  SessionStartOptions,
  UnifiedEventCallback,
} from './types';

const broadcastEvents: Array<{ event: string; data: unknown }> = [];

type TurnScript =
  | {
    kind: 'success';
    text: string;
    includeTool?: boolean;
    completeDelayMs?: number;
    usage?: { inputTokens: number; outputTokens: number };
  }
  | {
    kind: 'failure';
    error: string;
    status?: 'failed' | 'interrupted';
    completeDelayMs?: number;
    usage?: { inputTokens: number; outputTokens: number };
  }
  | { kind: 'permission'; requestId: string; textAfterAllow: string; failDelivery?: boolean };

class FakeRuntimeProcess implements RuntimeProcess {
  readonly pid = 4242;
  exited = false;

  async writeLine(): Promise<void> {
    return undefined;
  }

  kill(): void {
    this.exited = true;
  }

  async waitForExit(): Promise<number> {
    this.exited = true;
    return 0;
  }
}

class FakeRuntime implements AgentRuntime {
  readonly type: RuntimeType = 'codex';
  readonly sentMessages: string[] = [];
  readonly startSessionInitialMessages: Array<string | undefined> = [];
  readonly steeredMessages: Array<{ message: string; clientUserMessageId?: string }> = [];
  readonly permissionResponses: Array<{ requestId: string; decision: string; reason?: string }> = [];
  steerMessage?: AgentRuntime['steerMessage'];
  private callback: UnifiedEventCallback | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private startGate: Promise<void> | null = null;
  private releaseStartGate: (() => void) | null = null;
  private rejectedSendGate: Promise<void> | null = null;
  private releaseRejectedSendGate: (() => void) | null = null;
  private stopGate: Promise<void> | null = null;
  private releaseStopGate: (() => void) | null = null;
  private stopAwaitingRelease = false;
  private readonly deferStopBeforeResult: boolean;
  private rejectDispatchAck: boolean;
  private rejectStop: boolean;
  private readonly rejectConfig: boolean;
  private readonly emitInterruptedOnStop: boolean;
  private readonly emitSessionCompleteOnStop: boolean;

  constructor(private readonly scripts: TurnScript[], options: {
    realtimeSteering?: boolean;
    rejectSteer?: boolean;
    deferStart?: boolean;
    rejectDispatchAck?: boolean;
    rejectStop?: boolean;
    rejectConfig?: boolean;
    emitInterruptedOnStop?: boolean;
    emitSessionCompleteOnStop?: boolean;
    deferRejectedSend?: boolean;
    deferStopAfterSessionComplete?: boolean;
    deferStopBeforeResult?: boolean;
  } = {}) {
    this.rejectDispatchAck = options.rejectDispatchAck === true;
    this.rejectStop = options.rejectStop === true;
    this.rejectConfig = options.rejectConfig === true;
    this.emitInterruptedOnStop = options.emitInterruptedOnStop === true;
    this.emitSessionCompleteOnStop = options.emitSessionCompleteOnStop === true;
    this.deferStopBeforeResult = options.deferStopBeforeResult === true;
    if (options.deferRejectedSend) {
      this.rejectedSendGate = new Promise<void>((resolve) => {
        this.releaseRejectedSendGate = resolve;
      });
      this.rejectDispatchAck = true;
    }
    if (options.deferStopAfterSessionComplete || options.deferStopBeforeResult) {
      this.stopGate = new Promise<void>((resolve) => {
        this.releaseStopGate = resolve;
      });
    }
    if (options.realtimeSteering) {
      this.steerMessage = async (_process, message, _images, steerOptions) => {
        this.steeredMessages.push({ message, clientUserMessageId: steerOptions?.clientUserMessageId });
        if (options.rejectSteer) {
          throw new Error('fake steer rejected');
        }
      };
    }
    if (options.deferStart) this.deferNextStart();
  }

  deferNextStart(): void {
    this.startGate = new Promise<void>((resolve) => {
      this.releaseStartGate = resolve;
    });
  }

  releaseStart(): void {
    this.releaseStartGate?.();
    this.releaseStartGate = null;
  }

  releaseRejectedSend(): void {
    this.releaseRejectedSendGate?.();
    this.releaseRejectedSendGate = null;
  }

  isStopAwaitingRelease(): boolean {
    return this.stopAwaitingRelease;
  }

  releaseStop(): void {
    this.releaseStopGate?.();
    this.releaseStopGate = null;
  }

  allowStop(): void {
    this.rejectStop = false;
  }

  emitUserMessageAccepted(clientUserMessageId?: string): void {
    this.emit({ kind: 'user_message_accepted', clientUserMessageId });
  }

  emitForTest(event: Parameters<UnifiedEventCallback>[0]): void {
    this.emit(event);
  }

  async detect() {
    return { installed: true, version: 'fake-runtime' };
  }

  async queryModels() {
    return [];
  }

  getPermissionModes() {
    return [];
  }

  getConfigCapabilities() {
    const mode = this.rejectConfig ? 'live_session_rpc' as const : 'next_turn_state' as const;
    return { model: mode, permissionMode: mode, reasoningEffort: mode };
  }

  async startSession(options: SessionStartOptions, onEvent: UnifiedEventCallback): Promise<RuntimeProcess> {
    this.startSessionInitialMessages.push(options.initialMessage);
    const gate = this.startGate;
    if (gate) {
      await gate;
      if (this.startGate === gate) this.startGate = null;
    }
    this.callback = onEvent;
    const process = new FakeRuntimeProcess();
    this.defer(() => {
      this.emit({ kind: 'session_init', sessionId: 'fake-thread-1', model: options.model ?? 'fake-model', tools: ['FakeTool'] });
      if (options.initialMessage) this.playTurn(options.initialMessage);
    });
    return process;
  }

  async sendMessage(_process: RuntimeProcess, message: string): Promise<void> {
    if (this.rejectDispatchAck) {
      this.sentMessages.push(message);
      if (this.rejectedSendGate) await this.rejectedSendGate;
      throw new Error('fake dispatch acknowledgement lost');
    }
    this.playTurn(message);
  }

  async setModel(): Promise<void> {
    if (this.rejectConfig) throw new Error('fake config apply failed');
  }

  async respondPermission(
    _process: RuntimeProcess,
    requestId: string,
    decision: 'deny' | 'allow_once' | 'always_allow',
    reason?: string,
  ): Promise<void> {
    this.permissionResponses.push({ requestId, decision, reason });
    const script = this.scripts[0];
    if (script?.kind === 'permission' && script.failDelivery) {
      throw new Error('permission delivery failed');
    }
    const next = this.scripts.shift();
    if (!next || next.kind !== 'permission') {
      throw new Error(`unexpected permission response for ${requestId}`);
    }
    this.defer(() => this.emitSuccessfulTurn(next.textAfterAllow, false));
  }

  async stopSession(process: RuntimeProcess): Promise<void> {
    if (this.stopGate && this.deferStopBeforeResult) {
      this.stopAwaitingRelease = true;
      await this.stopGate;
      this.stopAwaitingRelease = false;
    }
    if (this.rejectStop) throw new Error('fake stop did not terminate process');
    if (this.emitInterruptedOnStop) {
      this.emit({ kind: 'turn_complete', status: 'interrupted', result: 'interrupted by stop' });
    }
    if (this.emitSessionCompleteOnStop) {
      this.emit({ kind: 'session_complete', subtype: 'error', result: 'interrupted by stop' });
    }
    if (this.stopGate && !this.deferStopBeforeResult) {
      this.stopAwaitingRelease = true;
      await this.stopGate;
      this.stopAwaitingRelease = false;
    }
    process.kill();
  }

  clearTimers(): void {
    this.releaseStart();
    this.releaseRejectedSend();
    this.releaseStop();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private playTurn(message: string): void {
    this.sentMessages.push(message);
    const script = this.scripts.shift() ?? { kind: 'success', text: `echo:${message}` };
    this.defer(() => {
      if (script.kind === 'success') {
        this.emitSuccessfulTurn(
          script.text,
          Boolean(script.includeTool),
          script.completeDelayMs,
          script.usage,
        );
        return;
      }
      if (script.kind === 'failure') {
        this.defer(() => {
          if (script.usage) {
            this.emit({ kind: 'usage', ...script.usage, semantics: 'delta' });
          }
          this.emit({
            kind: 'turn_complete',
            status: script.status ?? 'failed',
            error: script.error,
          });
        }, script.completeDelayMs);
        return;
      }
      this.scripts.unshift(script);
      this.emit({
        kind: 'permission_request',
        requestId: script.requestId,
        toolName: 'Edit',
        toolUseId: 'tool-permission',
        input: { file: 'notes.md' },
        suggestions: [{ toolName: 'Edit' }],
      });
    });
  }

  private emitSuccessfulTurn(
    text: string,
    includeTool: boolean,
    completeDelayMs = 0,
    usage?: { inputTokens: number; outputTokens: number },
  ): void {
    this.emit({ kind: 'text_delta', text });
    if (includeTool) {
      this.emit({
        kind: 'tool_use_start',
        toolUseId: 'tool-1',
        toolName: 'FakeTool',
        input: { value: 1 },
      });
      this.emit({ kind: 'tool_use_stop', toolUseId: 'tool-1' });
      this.emit({ kind: 'tool_result', toolUseId: 'tool-1', content: 'tool ok' });
    }
    this.emit({ kind: 'text_stop' });
    if (usage) {
      this.emit({ kind: 'usage', ...usage, semantics: 'delta' });
    }
    this.defer(() => {
      this.emit({ kind: 'turn_complete', status: 'success', result: text });
    }, completeDelayMs);
  }

  private emit(event: Parameters<UnifiedEventCallback>[0]): void {
    if (!this.callback) throw new Error('fake runtime callback not installed');
    this.callback(event);
  }

  private defer(fn: () => void, delayMs = 0): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, delayMs);
    this.timers.add(timer);
  }
}

interface Harness {
  home: string;
  runtime: FakeRuntime;
  engine: Awaited<ReturnType<typeof import('../session-engine').getSessionEngine>>;
  externalSession: typeof import('./external-session');
  sessionStore: typeof import('../SessionStore');
  messagePersistStarted: () => boolean;
  releaseMessagePersist: () => void;
}

let activeHarness: Harness | null = null;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousRuntime: string | undefined;

async function createHarness(
  scripts: TurnScript[],
  options: {
    realtimeSteering?: boolean;
    rejectSteer?: boolean;
    deferStart?: boolean;
    unconfirmedDispatchStop?: boolean;
    unconfirmedStop?: boolean;
    rejectConfig?: boolean;
    emitInterruptedOnStop?: boolean;
    emitSessionCompleteOnStop?: boolean;
    deferRejectedSend?: boolean;
    deferStopAfterSessionComplete?: boolean;
    deferStopBeforeResult?: boolean;
    deferMessagePersist?: boolean;
    rejectMessagePersist?: boolean;
    config?: Record<string, unknown>;
  } = {},
): Promise<Harness> {
  vi.resetModules();
  const home = mkdtempSync(join(tmpdir(), 'myagents-external-mock-'));
  mkdirSync(join(home, '.myagents'), { recursive: true });
  if (options.config) {
    writeFileSync(join(home, '.myagents', 'config.json'), JSON.stringify(options.config));
  }
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousRuntime = process.env.MYAGENTS_RUNTIME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.MYAGENTS_RUNTIME = 'codex';

  let messagePersistStarted = false;
  let releaseMessagePersist: () => void = () => undefined;
  if (options.deferMessagePersist || options.rejectMessagePersist) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    releaseMessagePersist = release;
    vi.doMock('./external-session/transcript-persistence', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./external-session/transcript-persistence')>();
      return {
        ...actual,
        persistExternalUserMessageAppend: async (
          ...args: Parameters<typeof actual.persistExternalUserMessageAppend>
        ) => {
          messagePersistStarted = true;
          if (options.deferMessagePersist) await gate;
          if (options.rejectMessagePersist) throw new Error('fake user persist failed');
          return actual.persistExternalUserMessageAppend(...args);
        },
      };
    });
  }

  const runtime = new FakeRuntime(scripts, {
    realtimeSteering: options.realtimeSteering,
    rejectSteer: options.rejectSteer,
    deferStart: options.deferStart,
    rejectDispatchAck: options.unconfirmedDispatchStop,
    rejectStop: options.unconfirmedDispatchStop || options.unconfirmedStop,
    rejectConfig: options.rejectConfig,
    emitInterruptedOnStop: options.emitInterruptedOnStop,
    emitSessionCompleteOnStop: options.emitSessionCompleteOnStop,
    deferRejectedSend: options.deferRejectedSend,
    deferStopAfterSessionComplete: options.deferStopAfterSessionComplete,
    deferStopBeforeResult: options.deferStopBeforeResult,
  });
  if (options.unconfirmedDispatchStop || options.unconfirmedStop) {
    vi.doMock('./utils/kill-with-escalation', () => ({
      killWithEscalation: vi.fn(async () => ({
        exited: false,
        signalUsed: 'hard' as const,
        orphanRisk: true,
        elapsedMs: 0,
      })),
    }));
  }
  vi.doMock('./factory', () => ({
    getCurrentRuntimeSource: () => 'system-cli',
    getCurrentRuntimeType: () => 'codex',
    getExternalRuntime: () => runtime,
    isExternalRuntime: (type: RuntimeType | undefined) => Boolean(type && type !== 'builtin'),
    isRuntimeSupported: () => true,
  }));
  vi.doMock('../sse', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../sse')>();
    return {
      ...actual,
      broadcast: (event: string, data: unknown) => {
        broadcastEvents.push({ event, data });
      },
      broadcastLive: (
        event: string,
        data: unknown,
        scope: { nextRevision: () => number },
      ) => {
        scope.nextRevision();
        broadcastEvents.push({ event, data });
      },
    };
  });

  const [{ getSessionEngine }, externalSession, sessionStore] = await Promise.all([
    import('../session-engine'),
    import('./external-session'),
    import('../SessionStore'),
  ]);
  externalSession.__resetExternalSessionForTests();
  activeHarness = {
    home,
    runtime,
    engine: getSessionEngine(),
    externalSession,
    sessionStore,
    messagePersistStarted: () => messagePersistStarted,
    releaseMessagePersist,
  };
  return activeHarness;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function restoreEnv(): void {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousRuntime === undefined) delete process.env.MYAGENTS_RUNTIME;
  else process.env.MYAGENTS_RUNTIME = previousRuntime;
  broadcastEvents.length = 0;
}

afterEach(async () => {
  const harness = activeHarness;
  activeHarness = null;
  if (harness) {
    harness.runtime.clearTimers();
    try {
      await harness.externalSession.stopExternalSession();
    } catch {
      // Test cleanup should not mask the assertion failure.
    }
    harness.externalSession.__resetExternalSessionForTests();
    rmSync(harness.home, { recursive: true, force: true });
  }
  restoreEnv();
  vi.doUnmock('./factory');
  vi.doUnmock('../sse');
  vi.doUnmock('./utils/kill-with-escalation');
  vi.doUnmock('./external-session/transcript-persistence');
});

function desktopRequest(sessionId: string, workspacePath: string, text: string): DesktopMessageRequest {
  return {
    text,
    images: [],
    permissionMode: 'fullAgency',
    model: 'gpt-5-codex',
    reasoningEffort: 'medium',
    sessionId,
    workspacePath,
    scenario: { type: 'desktop' } as const,
    analyticsSource: 'desktop' as const,
  };
}

describe('external SessionEngine with fake runtime', () => {
  it('spills oversized completed tool input before top-level and nested result events', async () => {
    const harness = await createHarness([]);
    const sessionId = 'session-tool-input-spill';
    const workspacePath = join(harness.home, 'workspace');
    await harness.externalSession.prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
    });
    broadcastEvents.length = 0;

    const finalInput = {
      file_path: '/tmp/large.ts',
      changes: [{
        path: '/tmp/large.ts',
        kind: { type: 'add' },
        diff: 'x'.repeat(220 * 1024),
      }],
    };
    const nestedResult = `add: /tmp/large.ts\n${'x'.repeat(300 * 1024)}`;
    harness.runtime.emitForTest({
      kind: 'tool_use_start',
      toolUseId: 'top-large',
      toolName: 'Edit',
      input: { file_path: '/tmp/large.ts' },
    });
    harness.runtime.emitForTest({ kind: 'tool_use_stop', toolUseId: 'top-large', input: finalInput });
    harness.runtime.emitForTest({ kind: 'tool_result', toolUseId: 'top-large', content: 'top ok' });

    harness.runtime.emitForTest({
      kind: 'tool_use_start',
      toolUseId: 'nested-large',
      toolName: 'Edit',
      input: { file_path: '/tmp/large.ts' },
      subAgent: { parentToolUseId: 'parent-tool' },
    });
    harness.runtime.emitForTest({ kind: 'tool_use_stop', toolUseId: 'nested-large', input: finalInput });
    harness.runtime.emitForTest({ kind: 'tool_result', toolUseId: 'nested-large', content: nestedResult });

    await waitFor(
      () => broadcastEvents.some((item) => item.event === 'chat:tool-result-start')
        && broadcastEvents.some((item) => item.event === 'chat:subagent-tool-result-complete'),
      'spilled tool input transports',
    );

    const topStopIndex = broadcastEvents.findIndex((item) => (
      item.event === 'chat:content-block-stop'
      && (item.data as { toolId?: string }).toolId === 'top-large'
    ));
    const topResultIndex = broadcastEvents.findIndex((item) => item.event === 'chat:tool-result-start');
    const nestedStopIndex = broadcastEvents.findIndex((item) => (
      item.event === 'chat:subagent-tool-use'
      && (item.data as { finalInput?: boolean }).finalInput === true
    ));
    const nestedResultIndex = broadcastEvents.findIndex(
      (item) => item.event === 'chat:subagent-tool-result-complete',
    );
    expect(topStopIndex).toBeGreaterThanOrEqual(0);
    expect(nestedStopIndex).toBeGreaterThanOrEqual(0);
    expect(topStopIndex).toBeLessThan(topResultIndex);
    expect(nestedStopIndex).toBeLessThan(nestedResultIndex);

    const nestedResultPayload = broadcastEvents[nestedResultIndex].data as {
      content?: string;
      metadata?: { largeValueRef?: { id?: string; sizeBytes?: number } };
    };
    expect(nestedResultPayload.content?.length).toBeLessThanOrEqual(8 * 1024);
    expect(nestedResultPayload.metadata?.largeValueRef).toMatchObject({
      sizeBytes: Buffer.byteLength(nestedResult, 'utf-8'),
    });
    expect(readFileSync(join(
      harness.home,
      '.myagents',
      'refs',
      nestedResultPayload.metadata?.largeValueRef?.id ?? '',
    ), 'utf-8')).toBe(nestedResult);

    for (const index of [topStopIndex, nestedStopIndex]) {
      const payload = broadcastEvents[index].data as {
        input?: unknown;
        inputRef?: { kind?: string; id?: string; preview?: string };
      };
      expect(payload.input).toBeUndefined();
      expect(payload.inputRef).toMatchObject({ kind: 'ref', preview: '' });
      expect(JSON.stringify(payload).length).toBeLessThan(16 * 1024);
      const refId = payload.inputRef?.id;
      expect(refId).toMatch(/^[a-f0-9]{8}$/);
      expect(JSON.parse(readFileSync(join(harness.home, '.myagents', 'refs', refId!), 'utf-8')))
        .toEqual(finalInput);
    }
  });

  it('advances durable activity at external admission and terminal finalization', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'meaningful result', completeDelayMs: 60 },
    ]);
    const sessionId = 'session-activity-lifecycle';
    const workspacePath = join(harness.home, 'workspace');

    await harness.engine.sendDesktopMessage(
      desktopRequest(sessionId, workspacePath, 'meaningful work'),
    );
    await waitFor(() => harness.runtime.sentMessages.includes('meaningful work'), 'activity admission');
    const admittedAt = harness.sessionStore.getSessionMetadata(sessionId)?.lastActiveAt;
    expect(admittedAt).toBeDefined();

    await expect(harness.engine.waitIdle(2_000, 10)).resolves.toBe(true);
    const terminalAt = harness.sessionStore.getSessionMetadata(sessionId)?.lastActiveAt;
    expect(new Date(terminalAt ?? 0).getTime()).toBeGreaterThanOrEqual(
      new Date(admittedAt ?? 0).getTime(),
    );
  });

  it('does not advance activity when active-runtime config rejects before transport', async () => {
    const harness = await createHarness([], { rejectConfig: true });
    const sessionId = 'session-config-reject-activity';
    const workspacePath = join(harness.home, 'workspace');

    await harness.externalSession.prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario: { type: 'desktop' },
      model: 'gpt-5-codex',
      permissionMode: 'fullAgency',
    });

    const request = desktopRequest(sessionId, workspacePath, 'must not dispatch');
    request.model = 'gpt-5-codex-next';
    const result = await harness.engine.sendDesktopMessage(request);

    expect(result).toMatchObject({ success: true, queued: true });
    await expect(result.dispatchAcceptance).resolves.toEqual({
      accepted: false,
      error: expect.stringContaining('fake config apply failed'),
    });
    expect(harness.runtime.sentMessages).toEqual([]);
    expect(harness.sessionStore.getSessionData(sessionId)?.messages ?? []).toEqual([]);
  });

  it('settles an admitted fresh turn when its user transcript persist fails', async () => {
    const harness = await createHarness([], { rejectMessagePersist: true });
    const sessionId = 'session-fresh-persist-failure';
    const workspacePath = join(harness.home, 'workspace');
    const owner = { kind: 'goal' as const, id: 'goal-fresh-persist-failure' };
    const onTerminal = vi.fn();

    const result = await harness.engine.sendDesktopMessage({
      ...desktopRequest(sessionId, workspacePath, 'must persist before transport'),
      queueId: 'queue-fresh-persist-failure',
      turnOwner: owner,
      onTerminal,
    });

    await expect(result.dispatchAcceptance).resolves.toEqual({
      accepted: false,
      error: expect.stringContaining('fake user persist failed'),
    });
    await waitFor(() => onTerminal.mock.calls.length === 1, 'failed terminal observer');
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      error: 'fake user persist failed',
    }));
    expect(harness.runtime.startSessionInitialMessages).toEqual([]);
    expect(harness.runtime.sentMessages).toEqual([]);
    expect(harness.externalSession.getExternalCurrentTurnIdentity()).toBeNull();
  });

  it('keeps maintenance-only external turns out of session recency', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'MEMORY_UPDATE_OK' },
    ]);
    const sessionId = 'session-maintenance-recency';
    const workspacePath = join(harness.home, 'workspace');
    const originalLastActiveAt = '2026-01-01T00:00:00.000Z';
    await harness.sessionStore.saveSessionMetadata({
      id: sessionId,
      agentDir: workspacePath,
      title: 'Memory maintenance',
      createdAt: originalLastActiveAt,
      lastActiveAt: originalLastActiveAt,
      unifiedSession: true,
      runtime: 'codex',
      systemMaintenanceKind: 'memory_gardener',
      origin: { kind: 'automation', surface: 'cron' },
    });

    await harness.engine.sendDesktopMessage(desktopRequest(
      sessionId,
      workspacePath,
      '<system-reminder><MEMORY_UPDATE>maintain</MEMORY_UPDATE></system-reminder>',
    ));
    await expect(harness.engine.waitIdle(2_000, 10)).resolves.toBe(true);

    expect(harness.sessionStore.getSessionMetadata(sessionId)?.lastActiveAt).toBe(originalLastActiveAt);
  });

  it('treats an idle pre-warmed persistent process as turn-idle', async () => {
    const harness = await createHarness([]);
    const sessionId = 'session-prewarm-idle';
    const workspacePath = join(harness.home, 'workspace');

    await expect(harness.externalSession.prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
    })).resolves.toEqual({ prewarmed: true });

    await expect(harness.engine.waitIdle(100, 10)).resolves.toBe(true);
    expect(harness.engine.isBusy()).toBe(false);
    expect(harness.engine.getLiveSessionState()).toMatchObject({
      sessionState: 'idle',
      isBusy: false,
    });
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(true);
    expect(harness.externalSession.getExternalSessionState()).toBe('idle');
  });

  it('rejects a stale Goal turn after pre-warm without surfacing or persisting it', async () => {
    const harness = await createHarness([]);
    const sessionId = 'session-prewarm-stale-goal';
    const workspacePath = join(harness.home, 'workspace');
    const prompt = 'stale automatic Goal turn';
    const beforeDispatch = vi.fn(async () => ({
      accepted: false,
      code: 'terminal',
      error: 'Goal is no longer active',
    }));

    await harness.externalSession.prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
    });
    broadcastEvents.length = 0;

    const result = await harness.engine.runInjectedTurn({
      prompt,
      sessionId,
      workspacePath,
      scenario: { type: 'cron', taskId: 'goal-stale', intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 500,
      pollMs: 10,
      beforeDispatch,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: false,
      error: 'Goal is no longer active',
    });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(harness.runtime.sentMessages).toEqual([]);
    expect(broadcastEvents.some((item) => (
      item.event === 'chat:message-replay'
        && (item.data as { message?: { content?: string } }).message?.content === prompt
    ))).toBe(false);
    expect(harness.sessionStore.getSessionData(sessionId)?.messages ?? []).toEqual([]);
    expect(harness.externalSession.getExternalSessionState()).toBe('idle');
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(true);
  });

  it('keeps an idle pre-warmed process alive when official tool sync is unchanged', async () => {
    const harness = await createHarness([]);
    const sessionId = 'session-prewarm-official-tools-noop';
    const workspacePath = join(harness.home, 'workspace');

    await harness.externalSession.prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
    });
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(true);

    await expect(harness.engine.updateOfficialToolIds([])).resolves.toEqual({
      success: true,
      skipped: 'unchanged',
    });
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(true);
    expect(harness.runtime.startSessionInitialMessages).toHaveLength(1);
  });

  it('invalidates an idle process exactly when effective official tools change', async () => {
    const harness = await createHarness([], {
      config: {
        enabledOfficialToolIds: ['image-understanding'],
        officialToolSettings: {
          imageUnderstanding: { providerId: 'anthropic-api', model: 'claude-fable-5' },
        },
        providerApiKeys: { 'anthropic-api': 'test-key' },
      },
    });
    const sessionId = 'session-prewarm-official-tools-change';
    const workspacePath = join(harness.home, 'workspace');

    await harness.externalSession.prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
    });
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(true);

    await expect(harness.engine.updateOfficialToolIds(['image-understanding'])).resolves.toEqual({
      success: true,
    });
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(false);
  });

  it('never reuses an idle stale official-tool process when termination is unconfirmed', async () => {
    const harness = await createHarness([], {
      unconfirmedStop: true,
      config: {
        enabledOfficialToolIds: ['image-understanding'],
        officialToolSettings: {
          imageUnderstanding: { providerId: 'anthropic-api', model: 'claude-fable-5' },
        },
        providerApiKeys: { 'anthropic-api': 'test-key' },
      },
    });
    const sessionId = 'session-idle-unconfirmed-official-tools-change';
    const workspacePath = join(harness.home, 'workspace');

    await harness.externalSession.prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
    });

    await expect(harness.engine.updateOfficialToolIds(['image-understanding'])).resolves.toEqual({
      success: false,
      error: expect.stringContaining('official-tools'),
    });
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(true);

    const desktop = await harness.engine.sendDesktopMessage(
      desktopRequest(sessionId, workspacePath, 'desktop must not reach stale process'),
    );
    expect(desktop).toMatchObject({ success: true, queued: true });
    await expect(desktop.dispatchAcceptance).resolves.toEqual({
      accepted: false,
      error: expect.stringContaining('stale external runtime was not reused'),
    });

    await expect(harness.engine.enqueueImMessage({
      message: 'im must not reach stale process',
      requestId: 'req-idle-stale-runtime',
      sessionId,
      workspacePath,
      scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
      permissionMode: 'fullAgency',
      model: 'gpt-5-codex',
      reasoningEffort: 'medium',
    })).resolves.toEqual({
      success: false,
      status: 503,
      error: expect.stringContaining('stale external runtime was not reused'),
    });
    expect(harness.runtime.sentMessages).toEqual([]);

    harness.runtime.allowStop();
    await expect(harness.externalSession.stopExternalSession()).resolves.toBe(true);
  });

  it('blocks concurrent desktop and IM sends behind idle official-tool invalidation', async () => {
    const harness = await createHarness([], {
      unconfirmedStop: true,
      deferStopBeforeResult: true,
      config: {
        enabledOfficialToolIds: ['image-understanding'],
        officialToolSettings: {
          imageUnderstanding: { providerId: 'anthropic-api', model: 'claude-fable-5' },
        },
        providerApiKeys: { 'anthropic-api': 'test-key' },
      },
    });
    const sessionId = 'session-concurrent-idle-official-tools-change';
    const workspacePath = join(harness.home, 'workspace');

    await harness.externalSession.prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
    });

    const update = harness.engine.updateOfficialToolIds(['image-understanding']);
    await waitFor(
      () => harness.runtime.isStopAwaitingRelease(),
      'idle official-tool invalidation stop',
    );

    const desktop = await harness.engine.sendDesktopMessage(
      desktopRequest(sessionId, workspacePath, 'concurrent desktop must wait'),
    );
    let desktopSettled = false;
    const desktopAcceptance = desktop.dispatchAcceptance!.then((result) => {
      desktopSettled = true;
      return result;
    });
    let imSettled = false;
    const imAdmission = harness.engine.enqueueImMessage({
      message: 'concurrent im must wait',
      requestId: 'req-concurrent-idle-stale-runtime',
      sessionId,
      workspacePath,
      scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
      permissionMode: 'fullAgency',
      model: 'gpt-5-codex',
      reasoningEffort: 'medium',
    }).then((result) => {
      imSettled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(desktopSettled).toBe(false);
    expect(imSettled).toBe(false);
    expect(harness.runtime.sentMessages).toEqual([]);

    harness.runtime.releaseStop();
    await expect(update).resolves.toEqual({
      success: false,
      error: expect.stringContaining('official-tools'),
    });
    await expect(desktopAcceptance).resolves.toEqual({
      accepted: false,
      error: expect.stringContaining('stale external runtime was not reused'),
    });
    await expect(imAdmission).resolves.toEqual({
      success: false,
      status: 503,
      error: expect.stringContaining('stale external runtime was not reused'),
    });
    expect(harness.runtime.sentMessages).toEqual([]);

    harness.runtime.allowStop();
    await expect(harness.externalSession.stopExternalSession()).resolves.toBe(true);
  });

  it('blocks a concurrent send behind idle proxy invalidation', async () => {
    const harness = await createHarness([], {
      unconfirmedStop: true,
      deferStopBeforeResult: true,
    });
    const sessionId = 'session-concurrent-idle-proxy-change';
    const workspacePath = join(harness.home, 'workspace');

    await harness.externalSession.prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
    });

    const update = harness.externalSession.handleExternalProxyConfigChange({
      oldManagedProviderKey: 'managed-proxy-old',
      newManagedProviderKey: 'managed-proxy-new',
      oldProcessEnvKey: 'process-proxy-old',
      newProcessEnvKey: 'process-proxy-new',
    });
    await waitFor(
      () => harness.runtime.isStopAwaitingRelease(),
      'idle proxy invalidation stop',
    );

    const desktop = await harness.engine.sendDesktopMessage(
      desktopRequest(sessionId, workspacePath, 'proxy-stale process must not receive this'),
    );
    let desktopSettled = false;
    const desktopAcceptance = desktop.dispatchAcceptance!.then((result) => {
      desktopSettled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(desktopSettled).toBe(false);
    expect(harness.runtime.sentMessages).toEqual([]);

    harness.runtime.releaseStop();
    await expect(update).resolves.toEqual({
      success: false,
      error: expect.stringContaining('proxy'),
    });
    await expect(desktopAcceptance).resolves.toEqual({
      accepted: false,
      error: expect.stringContaining('stale external runtime was not reused'),
    });
    expect(harness.runtime.sentMessages).toEqual([]);

    harness.runtime.allowStop();
    await expect(harness.externalSession.stopExternalSession()).resolves.toBe(true);
  });

  it('defers a real official tool restart until the active turn completes', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'turn before config restart', completeDelayMs: 80 },
    ], {
      config: {
        enabledOfficialToolIds: ['image-understanding'],
        officialToolSettings: {
          imageUnderstanding: { providerId: 'anthropic-api', model: 'claude-fable-5' },
        },
        providerApiKeys: { 'anthropic-api': 'test-key' },
      },
    });
    const sessionId = 'session-active-official-tools-change';
    const workspacePath = join(harness.home, 'workspace');

    await harness.externalSession.prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
    });
    await harness.engine.sendDesktopMessage(
      desktopRequest(sessionId, workspacePath, 'finish this turn first'),
    );
    await waitFor(
      () => harness.externalSession.getExternalSessionState() === 'running',
      'active external turn',
    );

    await expect(harness.engine.updateOfficialToolIds(['image-understanding'])).resolves.toEqual({
      success: true,
    });
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(true);

    await waitFor(
      () => !harness.externalSession.hasExternalRuntimeProcess(),
      'deferred official tool restart',
    );
    expect(harness.engine.getLatestAssistantResult().latestResult).toBe('turn before config restart');
  });

  it('invalidates official-tool prompt state after a failed turn before draining the queue', async () => {
    const harness = await createHarness([
      { kind: 'failure', error: 'turn failed before config restart', completeDelayMs: 80 },
      { kind: 'success', text: 'queued turn on replacement process' },
    ], {
      config: {
        enabledOfficialToolIds: ['image-understanding'],
        officialToolSettings: {
          imageUnderstanding: { providerId: 'anthropic-api', model: 'claude-fable-5' },
        },
        providerApiKeys: { 'anthropic-api': 'test-key' },
      },
    });
    const sessionId = 'session-failed-official-tools-change';
    const workspacePath = join(harness.home, 'workspace');

    await harness.externalSession.prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
    });
    await harness.engine.sendDesktopMessage(
      desktopRequest(sessionId, workspacePath, 'failing first turn'),
    );
    await waitFor(
      () => harness.externalSession.getExternalSessionState() === 'running',
      'active failing external turn',
    );

    await harness.engine.updateOfficialToolIds(['image-understanding']);
    const queued = await harness.engine.sendDesktopMessage(
      desktopRequest(sessionId, workspacePath, 'queued second turn'),
    );
    expect(queued.queued).toBe(true);

    await expect(queued.dispatchAcceptance).resolves.toEqual({ accepted: true });
    await expect(harness.engine.waitIdle(2_000, 10)).resolves.toBe(true);
    expect(harness.runtime.startSessionInitialMessages).toHaveLength(2);
    expect(harness.runtime.sentMessages).toContain('queued second turn');
    expect(harness.engine.getLatestAssistantResult().latestResult).toBe(
      'queued turn on replacement process',
    );
  });

  it('never reuses an invalid official-tool prompt when process termination is unconfirmed', async () => {
    const harness = await createHarness([
      { kind: 'failure', error: 'turn failed before unconfirmed restart', completeDelayMs: 80 },
    ], {
      unconfirmedStop: true,
      config: {
        enabledOfficialToolIds: ['image-understanding'],
        officialToolSettings: {
          imageUnderstanding: { providerId: 'anthropic-api', model: 'claude-fable-5' },
        },
        providerApiKeys: { 'anthropic-api': 'test-key' },
      },
    });
    const sessionId = 'session-unconfirmed-official-tools-change';
    const workspacePath = join(harness.home, 'workspace');

    await harness.externalSession.prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
    });
    await harness.engine.sendDesktopMessage(
      desktopRequest(sessionId, workspacePath, 'failing turn on old prompt'),
    );
    await waitFor(
      () => harness.externalSession.getExternalSessionState() === 'running',
      'active turn before unconfirmed config restart',
    );

    await harness.engine.updateOfficialToolIds(['image-understanding']);
    await expect(harness.engine.waitIdle(2_000, 10)).resolves.toBe(true);
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(true);

    const later = await harness.engine.sendDesktopMessage(
      desktopRequest(sessionId, workspacePath, 'must not reach stale process'),
    );
    expect(later).toMatchObject({ success: true, queued: true });
    await expect(later.dispatchAcceptance).resolves.toEqual({
      accepted: false,
      error: expect.stringContaining('stale external runtime was not reused'),
    });
    expect(harness.runtime.sentMessages).toEqual(['failing turn on old prompt']);

    harness.runtime.allowStop();
    await expect(harness.externalSession.stopExternalSession()).resolves.toBe(true);
  });

  it('rejects a stale Goal turn before a fresh external process has any side effects', async () => {
    const harness = await createHarness([]);
    const sessionId = 'session-fresh-stale-goal';
    const workspacePath = join(harness.home, 'workspace');
    const prompt = 'stale fresh Goal turn';

    const result = await harness.engine.runInjectedTurn({
      prompt,
      sessionId,
      workspacePath,
      scenario: { type: 'cron', taskId: 'goal-fresh-stale', intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 500,
      pollMs: 10,
      beforeDispatch: async () => ({ accepted: false, code: 'terminal', error: 'Goal is paused' }),
    });

    expect(result).toMatchObject({ success: false, enqueued: false, error: 'Goal is paused' });
    expect(harness.runtime.sentMessages).toEqual([]);
    expect(broadcastEvents.some((item) => (
      item.event === 'chat:message-replay'
        && (item.data as { message?: { content?: string } }).message?.content === prompt
    ))).toBe(false);
    expect(harness.sessionStore.getSessionData(sessionId)).toBeNull();
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(false);
    expect(harness.externalSession.getExternalSessionState()).toBe('idle');
  });

  it('keeps a guarded promotion busy and lets Stop invalidate it before dispatch', async () => {
    const harness = await createHarness([]);
    const sessionId = 'session-promotion-stop';
    const workspacePath = join(harness.home, 'workspace');
    let resolveGuard!: (value: { accepted: true }) => void;
    const guardResult = new Promise<{ accepted: true }>((resolve) => {
      resolveGuard = resolve;
    });
    const beforeDispatch = vi.fn(() => guardResult);

    const run = harness.engine.runInjectedTurn({
      prompt: 'must be canceled before dispatch',
      sessionId,
      workspacePath,
      scenario: { type: 'cron', taskId: 'goal-promotion-stop', intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 500,
      pollMs: 10,
      beforeDispatch,
    });
    await waitFor(() => beforeDispatch.mock.calls.length === 1, 'Goal dispatch guard');

    expect(harness.engine.isBusy()).toBe(true);
    await expect(harness.engine.waitIdle(30, 5)).resolves.toBe(false);
    await expect(harness.engine.stopTurn()).resolves.toEqual({ success: true, alreadyStopped: false });
    resolveGuard({ accepted: true });

    await expect(run).resolves.toMatchObject({ success: false, enqueued: false });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(harness.runtime.sentMessages).toEqual([]);
    expect(harness.sessionStore.getSessionData(sessionId)).toBeNull();
    expect(harness.externalSession.getExternalSessionState()).toBe('idle');
  });

  it('starts a guarded fresh runtime idle so Stop can win during startup', async () => {
    const harness = await createHarness([], { deferStart: true });
    const sessionId = 'session-fresh-start-stop';
    const workspacePath = join(harness.home, 'workspace');
    const beforeDispatch = vi.fn(async () => ({ accepted: true }));

    const run = harness.engine.runInjectedTurn({
      prompt: 'must not enter opaque startSession transport',
      sessionId,
      workspacePath,
      scenario: { type: 'cron', taskId: 'goal-fresh-start-stop', intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 1_000,
      pollMs: 10,
      beforeDispatch,
    });
    await waitFor(
      () => harness.runtime.startSessionInitialMessages.length === 1,
      'guarded idle runtime startup',
    );

    expect(harness.runtime.startSessionInitialMessages).toEqual([undefined]);
    expect(harness.engine.isBusy()).toBe(true);
    const stop = harness.engine.stopTurn();
    harness.runtime.releaseStart();
    await expect(stop).resolves.toEqual({ success: true, alreadyStopped: false });

    await expect(run).resolves.toMatchObject({ success: false, enqueued: false });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(harness.runtime.sentMessages).toEqual([]);
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(false);
    expect(harness.externalSession.getExternalSessionState()).toBe('idle');
  });

  it('transfers a guarded turn to the current owner before admission persistence waits', async () => {
    const harness = await createHarness([], { deferMessagePersist: true });
    const sessionId = 'session-admission-persist-stop';
    const workspacePath = join(harness.home, 'workspace');
    const owner = { kind: 'task' as const, id: 'task-admission-persist-stop' };

    await harness.externalSession.prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
    });
    const run = harness.engine.runInjectedTurn({
      prompt: 'stop while admission persistence is waiting',
      sessionId,
      workspacePath,
      scenario: { type: 'cron', taskId: owner.id, intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 1_000,
      pollMs: 10,
      queueId: 'queue-admission-persist-stop',
      turnOwner: owner,
      beforeDispatch: async () => ({ accepted: true }),
    });
    await waitFor(harness.messagePersistStarted, 'admission persistence');

    expect(harness.externalSession.getExternalCurrentTurnIdentity()).toEqual({
      queueId: 'queue-admission-persist-stop',
      owner,
    });
    await expect(harness.engine.stopOwnedTurn(owner)).resolves.toEqual({
      success: true,
      alreadyStopped: false,
    });
    harness.releaseMessagePersist();

    await expect(run).resolves.toMatchObject({ success: false, enqueued: true });
    expect(harness.runtime.sentMessages).toEqual([]);
    expect(harness.sessionStore.getSessionMetadata(sessionId)?.lastActiveAt).toBeDefined();
    expect(harness.sessionStore.getSessionData(sessionId)?.messages.some(
      (message) => message.role === 'user' && message.content === 'stop while admission persistence is waiting',
    )).toBe(true);
  });

  it('stops an admitted fresh turn while its user transcript persist is waiting', async () => {
    const harness = await createHarness([], { deferMessagePersist: true });
    const sessionId = 'session-fresh-admission-persist-stop';
    const workspacePath = join(harness.home, 'workspace');
    const owner = { kind: 'goal' as const, id: 'goal-fresh-admission-persist-stop' };
    const onTerminal = vi.fn();

    const sent = await harness.engine.sendDesktopMessage({
      ...desktopRequest(sessionId, workspacePath, 'stop before fresh runtime transport'),
      queueId: 'queue-fresh-admission-persist-stop',
      turnOwner: owner,
      onTerminal,
    });
    await waitFor(harness.messagePersistStarted, 'fresh admission persistence');

    const stop = harness.engine.stopOwnedTurn(owner);
    harness.releaseMessagePersist();
    await expect(stop).resolves.toEqual({ success: true, alreadyStopped: false });
    await expect(sent.dispatchAcceptance).resolves.toEqual({ accepted: false });
    await waitFor(() => onTerminal.mock.calls.length === 1, 'fresh stopped terminal observer');

    expect(harness.runtime.startSessionInitialMessages).toEqual([]);
    expect(harness.runtime.sentMessages).toEqual([]);
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'stopped',
      error: 'Execution stopped',
    }));
    expect(harness.externalSession.getExternalSessionState()).toBe('idle');
  });

  it('does not replace Stop with an error when active admission persistence rejects', async () => {
    const harness = await createHarness([], {
      deferMessagePersist: true,
      rejectMessagePersist: true,
      emitSessionCompleteOnStop: true,
      deferStopAfterSessionComplete: true,
    });
    const sessionId = 'session-active-admission-persist-stop-reject';
    const workspacePath = join(harness.home, 'workspace');
    const owner = { kind: 'goal' as const, id: 'goal-active-admission-persist-stop-reject' };
    const onTerminal = vi.fn();

    await harness.externalSession.prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
    });
    const sent = await harness.engine.sendDesktopMessage({
      ...desktopRequest(sessionId, workspacePath, 'stop before rejected persist resumes'),
      queueId: 'queue-active-admission-persist-stop-reject',
      turnOwner: owner,
      onTerminal,
    });
    await waitFor(harness.messagePersistStarted, 'active admission persistence');

    const stop = harness.engine.stopOwnedTurn(owner);
    await waitFor(
      () => harness.runtime.isStopAwaitingRelease(),
      'session_complete during active admission Stop',
    );
    harness.releaseMessagePersist();
    await expect(sent.dispatchAcceptance).resolves.toEqual({ accepted: true });
    expect(harness.externalSession.getExternalSessionState()).not.toBe('error');
    harness.runtime.releaseStop();
    await expect(stop).resolves.toEqual({ success: true, alreadyStopped: false });
    await waitFor(() => onTerminal.mock.calls.length === 1, 'active stopped terminal observer');

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'stopped',
      error: 'Execution stopped',
    }));
    expect(harness.runtime.sentMessages).toEqual([]);
    expect(harness.externalSession.getExternalSessionState()).toBe('idle');
  });

  it('keeps a fresh turn stopped when its transport rejects after process Stop', async () => {
    const harness = await createHarness([], { deferRejectedSend: true });
    const sessionId = 'session-fresh-send-reject-after-stop';
    const workspacePath = join(harness.home, 'workspace');
    const owner = { kind: 'goal' as const, id: 'goal-fresh-send-reject-after-stop' };
    const onTerminal = vi.fn();

    const sent = await harness.engine.sendDesktopMessage({
      ...desktopRequest(sessionId, workspacePath, 'stop while transport ack is pending'),
      queueId: 'queue-fresh-send-reject-after-stop',
      turnOwner: owner,
      onTerminal,
    });
    await waitFor(
      () => harness.runtime.sentMessages.includes('stop while transport ack is pending'),
      'fresh runtime transport acknowledgement',
    );

    await expect(harness.engine.stopOwnedTurn(owner)).resolves.toEqual({
      success: true,
      alreadyStopped: false,
    });
    harness.runtime.releaseRejectedSend();
    await expect(sent.dispatchAcceptance).resolves.toEqual({ accepted: true });
    await waitFor(() => onTerminal.mock.calls.length === 1, 'fresh transport stopped terminal observer');

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'stopped',
      error: 'Execution stopped',
    }));
    expect(harness.externalSession.getExternalSessionState()).toBe('idle');
    expect(broadcastEvents).not.toContainEqual(expect.objectContaining({
      event: 'chat:agent-error',
      data: expect.objectContaining({
        message: expect.stringContaining('fake dispatch acknowledgement lost'),
      }),
    }));
  });

  it('does not confirm Stop when a canceled fresh startup process cannot be terminated', async () => {
    const harness = await createHarness([], {
      deferStart: true,
      unconfirmedDispatchStop: true,
    });
    const sessionId = 'session-fresh-start-stop-unconfirmed';
    const workspacePath = join(harness.home, 'workspace');
    const queueId = 'task-fresh-start-stop-unconfirmed';
    const owner = { kind: 'task' as const, id: 'task-start-stop-unconfirmed' };

    const run = harness.engine.runInjectedTurn({
      prompt: 'must remain addressable until termination is confirmed',
      sessionId,
      workspacePath,
      scenario: { type: 'cron', taskId: owner.id, intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 1_000,
      pollMs: 10,
      queueId,
      turnOwner: owner,
      beforeDispatch: async () => ({ accepted: true }),
    });
    await waitFor(
      () => harness.runtime.startSessionInitialMessages.length === 1,
      'guarded runtime startup before failed Stop',
    );

    const stop = harness.engine.stopTurn();
    harness.runtime.releaseStart();
    await expect(stop).resolves.toEqual({
      success: false,
      error: 'External runtime process did not stop',
    });
    await expect(run).resolves.toMatchObject({
      success: false,
      enqueued: true,
      terminationUnconfirmed: true,
    });
    expect(harness.externalSession.getExternalCurrentTurnIdentity()).toEqual({ queueId, owner });

    harness.runtime.allowStop();
    await expect(harness.engine.stopOwnedTurn(owner)).resolves.toEqual({
      success: true,
      alreadyStopped: false,
    });
    expect(harness.externalSession.getExternalCurrentTurnIdentity()).toBeNull();
  });

  it('preserves and drains later external work when exact Stop cancels guarded startup', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'later turn completed' },
    ], { deferStart: true });
    const sessionId = 'session-exact-stop-preserve-queue';
    const workspacePath = join(harness.home, 'workspace');

    const taskRun = harness.engine.runInjectedTurn({
      prompt: 'task turn canceled during startup',
      sessionId,
      workspacePath,
      scenario: { type: 'cron', taskId: 'task-1', intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 1_000,
      pollMs: 10,
      queueId: 'task-turn-1',
      turnOwner: { kind: 'task', id: 'task-1' },
      beforeDispatch: async () => ({ accepted: true }),
    });
    await waitFor(
      () => harness.runtime.startSessionInitialMessages.length === 1,
      'guarded Task runtime startup',
    );

    const later = await harness.engine.sendDesktopMessage(
      desktopRequest(sessionId, workspacePath, 'later desktop turn'),
    );
    expect(later.queued).toBe(true);
    const stop = harness.engine.stopTurn({ preserveQueue: true });
    harness.runtime.releaseStart();
    await expect(stop).resolves.toEqual({
      success: true,
      alreadyStopped: false,
    });

    await expect(taskRun).resolves.toMatchObject({ success: false, enqueued: false });
    await waitFor(
      () => harness.runtime.sentMessages.includes('later desktop turn'),
      'preserved external queue drain',
    );
    expect(harness.runtime.sentMessages).toEqual(['later desktop turn']);
  });

  it('does not dispatch a pre-warmed Goal turn when Stop wins after guard acceptance', async () => {
    const harness = await createHarness([]);
    const sessionId = 'session-prewarm-accepted-stop';
    const workspacePath = join(harness.home, 'workspace');
    let stopPromise: Promise<unknown> | null = null;
    const beforeDispatch = vi.fn(async () => {
      queueMicrotask(() => {
        stopPromise = harness.engine.stopTurn();
      });
      return { accepted: true };
    });

    await harness.externalSession.prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario: { type: 'desktop' },
    });
    broadcastEvents.length = 0;
    const result = await harness.engine.runInjectedTurn({
      prompt: 'accepted but stopped Goal turn',
      sessionId,
      workspacePath,
      scenario: { type: 'cron', taskId: 'goal-accepted-stop', intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 500,
      pollMs: 10,
      beforeDispatch,
    });
    await stopPromise;

    expect(result).toMatchObject({ success: false, enqueued: false });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(harness.runtime.sentMessages).toEqual([]);
    expect(broadcastEvents.some((item) => (
      item.event === 'chat:message-replay'
        && (item.data as { message?: { content?: string } }).message?.content === 'accepted but stopped Goal turn'
    ))).toBe(false);
    expect(harness.externalSession.getExternalSessionState()).toBe('idle');
  });

  it.each([
    { path: 'fresh start', prewarm: false },
    { path: 'active pre-warmed process', prewarm: true },
  ])('retains exact ownership after a lost dispatch acknowledgement on $path', async ({ prewarm }) => {
    const harness = await createHarness([], { unconfirmedDispatchStop: true });
    const sessionId = `session-dispatch-ambiguous-${prewarm ? 'prewarm' : 'fresh'}`;
    const workspacePath = join(harness.home, 'workspace');
    const queueId = `task-dispatch-ambiguous-${prewarm ? 'prewarm' : 'fresh'}`;
    const owner = { kind: 'task' as const, id: 'task-dispatch-ambiguous' };

    if (prewarm) {
      await harness.externalSession.prewarmExternalSession({
        sessionId,
        workspacePath,
        scenario: { type: 'desktop' },
      });
    }

    const result = await harness.engine.runInjectedTurn({
      prompt: 'possibly consumed task turn',
      sessionId,
      workspacePath,
      scenario: { type: 'cron', taskId: owner.id, intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 1_000,
      pollMs: 10,
      queueId,
      turnOwner: owner,
      beforeDispatch: async () => ({ accepted: true }),
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      terminationUnconfirmed: true,
      status: 503,
    });
    expect(harness.runtime.sentMessages).toEqual(['possibly consumed task turn']);
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(true);
    expect(harness.externalSession.getExternalCurrentTurnIdentity()).toEqual({ queueId, owner });

    harness.runtime.allowStop();
    await expect(harness.engine.stopOwnedTurn(owner)).resolves.toEqual({
      success: true,
      alreadyStopped: false,
    });
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(false);
    expect(harness.externalSession.getExternalCurrentTurnIdentity()).toBeNull();
  });

  it('persists a normal external turn and exposes live overlay plus latest result', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'first fake answer', includeTool: true, completeDelayMs: 40 },
    ]);
    const sessionId = 'session-normal';
    const workspacePath = join(harness.home, 'workspace');

    await harness.engine.sendDesktopMessage(
      desktopRequest(sessionId, workspacePath, 'hello'),
    );
    await waitFor(
      () => harness.engine.getLiveSessionOverlay(sessionId).liveStreamingMessage?.content.includes('first fake answer') ?? false,
      'live assistant overlay',
    );

    const live = harness.engine.getLiveSessionOverlay(sessionId);
    expect(live.isActive).toBe(true);
    expect(live.liveStreamingMessage?.content).toContain('first fake answer');

    await expect(harness.engine.waitIdle(2_000, 10)).resolves.toBe(true);
    expect(harness.engine.getLatestAssistantResult()).toEqual({
      sessionId,
      latestResult: 'first fake answer',
    });
    const completionTerminal = harness.engine.getSessionCompletionTerminal();
    expect(completionTerminal).toMatchObject({
      sessionId,
      workspacePath,
      turnId: expect.any(String),
      origin: { kind: 'desktop', surface: 'unknown' },
      status: 'complete',
    });

    const persisted = harness.sessionStore.getSessionData(sessionId);
    expect(persisted?.messages.some((message) => (
      message.role === 'assistant' && message.content.includes('first fake answer')
    ))).toBe(true);
    expect(persisted?.messages.some((message) => (
      message.role === 'assistant' && message.content.includes('FakeTool')
    ))).toBe(true);
    expect(broadcastEvents).toContainEqual(expect.objectContaining({
      event: 'chat:message-replay',
      data: expect.objectContaining({
        replayKind: 'live-user-echo',
        sessionId,
        message: expect.objectContaining({ role: 'user', content: 'hello' }),
      }),
    }));
    expect(broadcastEvents).toContainEqual(expect.objectContaining({
      event: 'chat:message-complete',
      data: expect.objectContaining({
        completionTerminal: expect.objectContaining({
          sessionId,
          turnId: completionTerminal?.turnId,
          status: 'complete',
        }),
      }),
    }));
  });

  it('materializes a birth-pending Agent Channel session through an injected turn', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'cron relay ready' },
    ]);
    const sessionId = 'session-agent-channel-birth-pending';
    const workspacePath = join(harness.home, 'workspace');

    const result = await harness.engine.runInjectedTurn({
      prompt: 'relay cron completion',
      sessionId,
      workspacePath,
      scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
      metadataBirthPending: true,
      timeoutMs: 2_000,
      pollMs: 10,
    });

    expect(result).toMatchObject({
      success: true,
      enqueued: true,
      text: 'cron relay ready',
    });
    expect(harness.runtime.sentMessages).toEqual(['relay cron completion']);
    expect(harness.sessionStore.getSessionData(sessionId)).toMatchObject({
      id: sessionId,
      agentDir: workspacePath,
    });
  });

  it('keeps missing Agent Channel metadata fail-closed without Router birth authority', async () => {
    const harness = await createHarness([]);
    const sessionId = 'session-agent-channel-without-birth';
    const workspacePath = join(harness.home, 'workspace');

    const result = await harness.engine.runInjectedTurn({
      prompt: 'must not recreate deleted session',
      sessionId,
      workspacePath,
      scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
      timeoutMs: 2_000,
      pollMs: 10,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: false,
      error: expect.stringContaining('Refusing to create missing metadata'),
    });
    expect(harness.runtime.sentMessages).toEqual([]);
    expect(harness.sessionStore.getSessionData(sessionId)).toBeNull();
  });

  it('does not report failed injected turns as successful', async () => {
    const harness = await createHarness([
      { kind: 'failure', error: 'fake turn failed' },
    ]);
    const sessionId = 'session-failure';

    const result = await harness.engine.runInjectedTurn({
      prompt: 'run sync job',
      sessionId,
      workspacePath: join(harness.home, 'workspace'),
      scenario: { type: 'cron', taskId: 'cron-phase9', intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 2_000,
      pollMs: 10,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
    });
    expect(result.error).toContain('fake turn failed');
    expect(harness.engine.getLatestAssistantResult().latestResult).not.toContain('fake turn failed');
  });

  it('forwards external failure metrics to the injected-turn terminal observer', async () => {
    const harness = await createHarness([
      {
        kind: 'failure',
        error: 'measured failure',
        usage: { inputTokens: 450, outputTokens: 30 },
      },
    ]);
    const onTerminal = vi.fn();

    await harness.engine.runInjectedTurn({
      prompt: 'failing measured Goal turn',
      sessionId: 'session-measured-failure',
      workspacePath: join(harness.home, 'workspace'),
      scenario: { type: 'desktop', surface: 'chat' },
      timeoutMs: 2_000,
      pollMs: 10,
      turnOwner: { kind: 'goal', id: 'goal-1' },
      onTerminal,
    });

    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      durationMs: expect.any(Number),
      usage: { inputTokens: 450, outputTokens: 30 },
      error: 'measured failure',
    }));
  });

  it('classifies an interrupted external terminal event as stopped', async () => {
    const harness = await createHarness([
      { kind: 'failure', status: 'interrupted', error: 'runtime interrupted' },
    ]);
    const onTerminal = vi.fn();

    await harness.engine.runInjectedTurn({
      prompt: 'interruptible Goal turn',
      sessionId: 'session-interrupted-goal',
      workspacePath: join(harness.home, 'workspace'),
      scenario: { type: 'desktop', surface: 'chat' },
      timeoutMs: 2_000,
      pollMs: 10,
      turnOwner: { kind: 'goal', id: 'goal-interrupted' },
      onTerminal,
    });

    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'stopped',
      error: 'Execution stopped',
    }));
  });

  it('freezes partial output and usage before an intentional Stop cleanup', async () => {
    const harness = await createHarness([
      {
        kind: 'success',
        text: 'partial answer before stop',
        completeDelayMs: 500,
        usage: { inputTokens: 320, outputTokens: 24 },
      },
    ], { emitInterruptedOnStop: true });
    const sessionId = 'session-stop-snapshot';
    const workspacePath = join(harness.home, 'workspace');
    const owner = { kind: 'goal' as const, id: 'goal-stop-snapshot' };
    const onTerminal = vi.fn();

    const sent = await harness.engine.sendDesktopMessage({
      ...desktopRequest(sessionId, workspacePath, 'start partial turn'),
      queueId: 'queue-stop-snapshot',
      turnOwner: owner,
      onTerminal,
    });
    await expect(sent.dispatchAcceptance).resolves.toEqual({ accepted: true });
    await waitFor(
      () => harness.engine.getLiveSessionOverlay(sessionId).liveStreamingMessage?.content.includes('partial answer') ?? false,
      'partial output before Stop',
    );

    await expect(harness.engine.stopOwnedTurn(owner)).resolves.toEqual({
      success: true,
      alreadyStopped: false,
    });
    await waitFor(() => onTerminal.mock.calls.length === 1, 'stopped terminal observer');

    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'stopped',
      text: 'partial answer before stop',
      usage: { inputTokens: 320, outputTokens: 24 },
    }));
  });

  it('keeps the stopped snapshot when session_complete fires during Stop', async () => {
    const harness = await createHarness([
      {
        kind: 'success',
        text: 'partial answer before session exit',
        completeDelayMs: 500,
        usage: { inputTokens: 420, outputTokens: 34 },
      },
    ], { emitSessionCompleteOnStop: true });
    const sessionId = 'session-stop-session-complete-snapshot';
    const workspacePath = join(harness.home, 'workspace');
    const owner = { kind: 'goal' as const, id: 'goal-stop-session-complete-snapshot' };
    const onTerminal = vi.fn();

    const sent = await harness.engine.sendDesktopMessage({
      ...desktopRequest(sessionId, workspacePath, 'start partial turn'),
      queueId: 'queue-stop-session-complete-snapshot',
      turnOwner: owner,
      onTerminal,
    });
    await expect(sent.dispatchAcceptance).resolves.toEqual({ accepted: true });
    await waitFor(
      () => harness.engine.getLiveSessionOverlay(sessionId).liveStreamingMessage?.content.includes('partial answer') ?? false,
      'partial output before session-complete Stop',
    );

    await expect(harness.engine.stopOwnedTurn(owner)).resolves.toEqual({
      success: true,
      alreadyStopped: false,
    });
    await waitFor(() => onTerminal.mock.calls.length === 1, 'session-complete stopped terminal observer');

    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'stopped',
      text: 'partial answer before session exit',
      usage: { inputTokens: 420, outputTokens: 34 },
    }));
  });

  it('forwards normalized external turn metrics to the injected-turn terminal observer', async () => {
    const harness = await createHarness([
      {
        kind: 'success',
        text: 'measured answer',
        usage: { inputTokens: 900, outputTokens: 120 },
      },
    ]);
    const onTerminal = vi.fn();

    await harness.engine.runInjectedTurn({
      prompt: 'measured Goal turn',
      sessionId: 'session-measured-goal',
      workspacePath: join(harness.home, 'workspace'),
      scenario: { type: 'desktop', surface: 'chat' },
      timeoutMs: 2_000,
      pollMs: 10,
      turnOwner: { kind: 'goal', id: 'goal-1' },
      onTerminal,
    });

    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'complete',
      durationMs: expect.any(Number),
      usage: { inputTokens: 900, outputTokens: 120 },
    }));
  });

  it('queues a second desktop send until the current external turn reaches a boundary', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'first queued answer', completeDelayMs: 80 },
      { kind: 'success', text: 'second queued answer' },
    ]);
    const sessionId = 'session-queue';
    const workspacePath = join(harness.home, 'workspace');

    await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'first'));
    await waitFor(() => harness.runtime.sentMessages.includes('first'), 'first dispatch');
    const second = await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'second'));

    expect(second.queued).toBe(true);
    expect(second.queueId).toBeDefined();
    expect(harness.runtime.sentMessages).toEqual(['first']);
    let dispatchAccepted = false;
    void second.dispatchAcceptance?.then(() => { dispatchAccepted = true; });
    await Promise.resolve();
    expect(dispatchAccepted).toBe(false);

    await waitFor(() => harness.runtime.sentMessages.includes('second'), 'queued second dispatch');
    await expect(second.dispatchAcceptance).resolves.toEqual({ accepted: true });
    await expect(harness.engine.waitIdle(2_000, 10)).resolves.toBe(true);
    expect(harness.runtime.sentMessages).toEqual(['first', 'second']);
    expect(harness.engine.getLatestAssistantResult().latestResult).toBe('second queued answer');
  });

  it('rejects a stale Goal admission at queued promotion without runtime dispatch', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'first answer', completeDelayMs: 80 },
    ]);
    const sessionId = 'session-goal-gate';
    const workspacePath = join(harness.home, 'workspace');

    await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'first'));
    await waitFor(() => harness.runtime.sentMessages.includes('first'), 'first dispatch');
    const second = await harness.engine.sendDesktopMessage({
      ...desktopRequest(sessionId, workspacePath, 'stale Goal turn'),
      beforeDispatch: async () => ({ accepted: false, code: 'terminal', error: 'Goal is terminal' }),
    });

    expect(second.queueId).toBeDefined();
    await expect(second.dispatchAcceptance).resolves.toEqual({
      accepted: false,
      error: 'Goal is terminal',
    });
    expect(harness.runtime.sentMessages).toEqual(['first']);
    expect(broadcastEvents.some((item) => (
      item.event === 'queue:started'
        && (item.data as { userMessage?: { content?: string } }).userMessage?.content === 'stale Goal turn'
    ))).toBe(false);
    expect(harness.sessionStore.getSessionData(sessionId)?.messages.filter(
      (message) => message.role === 'user',
    ).map((message) => message.content)).toEqual(['first']);
  });

  it('cancels a queued Goal promotion when Stop wins after guard acceptance', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'first answer', completeDelayMs: 80 },
    ]);
    const sessionId = 'session-queued-goal-stop';
    const workspacePath = join(harness.home, 'workspace');
    let stopPromise: Promise<unknown> | null = null;
    const beforeDispatch = vi.fn(async () => {
      queueMicrotask(() => {
        stopPromise = harness.engine.stopTurn();
      });
      return { accepted: true };
    });

    await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'first'));
    await waitFor(() => harness.runtime.sentMessages.includes('first'), 'first dispatch');
    const second = await harness.engine.sendDesktopMessage({
      ...desktopRequest(sessionId, workspacePath, 'queued Goal turn'),
      beforeDispatch,
    });

    await expect(second.dispatchAcceptance).resolves.toEqual({ accepted: false });
    await stopPromise;
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(harness.runtime.sentMessages).toEqual(['first']);
    expect(broadcastEvents.some((item) => (
      item.event === 'queue:started'
        && (item.data as { userMessage?: { content?: string } }).userMessage?.content === 'queued Goal turn'
    ))).toBe(false);
    expect(harness.externalSession.getExternalSessionState()).toBe('idle');
  });

  it('steers a second desktop send into the active Codex turn in realtime mode', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'single steered answer', completeDelayMs: 300 },
    ], { realtimeSteering: true });
    const sessionId = 'session-realtime-steer';
    const workspacePath = join(harness.home, 'workspace');

    await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'first'));
    await waitFor(() => harness.runtime.sentMessages.includes('first'), 'first dispatch');
    const firstAdmissionAt = harness.sessionStore.getSessionMetadata(sessionId)?.lastActiveAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'second'));

    expect(second).toMatchObject({
      success: true,
      queued: true,
      isInFlight: true,
      deliveryMode: 'realtime',
    });
    await waitFor(() => harness.runtime.steeredMessages.length === 1, 'realtime steer dispatch');

    expect(harness.runtime.sentMessages).toEqual(['first']);
    expect(harness.runtime.steeredMessages[0]).toMatchObject({ message: 'second' });
    expect(broadcastEvents.find(
      (item) => item.event === 'queue:started'
        && (item.data as { userMessage?: { content?: string } }).userMessage?.content === 'second',
    )).toBeUndefined();

    harness.runtime.emitUserMessageAccepted(harness.runtime.steeredMessages[0].clientUserMessageId);
    await waitFor(
      () => broadcastEvents.some(
        (item) => item.event === 'queue:started'
          && (item.data as { userMessage?: { content?: string } }).userMessage?.content === 'second',
      ),
      'runtime user-message accepted',
    );
    const started = broadcastEvents.find(
      (item) => item.event === 'queue:started'
        && (item.data as { userMessage?: { content?: string } }).userMessage?.content === 'second',
    );
    expect(started?.data).toMatchObject({
      sessionId,
      midTurnBreak: true,
      userMessage: { content: 'second' },
    });
    await waitFor(() => (
      new Date(harness.sessionStore.getSessionMetadata(sessionId)?.lastActiveAt ?? 0).getTime()
        > new Date(firstAdmissionAt ?? 0).getTime()
    ), 'realtime steering activity persist');

    await expect(harness.engine.waitIdle(2_000, 10)).resolves.toBe(true);
    const persisted = harness.sessionStore.getSessionData(sessionId);
    expect(persisted?.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([
      'first',
      'second',
    ]);
    expect(persisted?.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(harness.engine.getLatestAssistantResult().latestResult).toBe('single steered answer');
  });

  it('does not split the active stream when realtime Codex steering is rejected', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'answer after rejected steer', completeDelayMs: 80 },
    ], {
      realtimeSteering: true,
      rejectSteer: true,
    });
    const sessionId = 'session-realtime-steer-rejected';
    const workspacePath = join(harness.home, 'workspace');

    await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'first'));
    await waitFor(() => harness.runtime.sentMessages.includes('first'), 'first dispatch');
    const second = await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'second'));

    expect(second).toMatchObject({
      success: true,
      queued: true,
      isInFlight: true,
      deliveryMode: 'realtime',
    });
    await waitFor(() => harness.runtime.steeredMessages.length === 1, 'rejected realtime steer dispatch');
    expect(harness.runtime.steeredMessages[0]).toMatchObject({ message: 'second' });
    await waitFor(
      () => broadcastEvents.some((item) => item.event === 'chat:agent-error'),
      'rejected realtime steer error broadcast',
    );
    const started = broadcastEvents.find(
      (item) => item.event === 'queue:started'
        && (item.data as { userMessage?: { content?: string } }).userMessage?.content === 'second',
    );
    expect(started).toBeUndefined();
    await waitFor(
      () => broadcastEvents.some(
        (item) => item.event === 'queue:cancelled'
          && (item.data as { queueId?: string }).queueId === second.queueId,
      ),
      'rejected realtime steer queue cancellation',
    );

    await expect(harness.engine.waitIdle(2_000, 10)).resolves.toBe(true);
    const persisted = harness.sessionStore.getSessionData(sessionId);
    expect(persisted?.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([
      'first',
    ]);
    expect(harness.engine.getLatestAssistantResult().latestResult).toBe('answer after rejected steer');
  });

  it('keeps Codex steering-capable runtimes on turn boundaries when configured for turn response', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'first turn-mode answer', completeDelayMs: 80 },
      { kind: 'success', text: 'second turn-mode answer' },
    ], {
      realtimeSteering: true,
      config: { chatQueueResponseMode: 'turn' },
    });
    const sessionId = 'session-turn-mode';
    const workspacePath = join(harness.home, 'workspace');

    await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'first'));
    await waitFor(() => harness.runtime.sentMessages.includes('first'), 'first dispatch');
    const second = await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'second'));

    expect(second).toMatchObject({
      success: true,
      queued: true,
      deliveryMode: 'turn',
    });
    expect(harness.runtime.steeredMessages).toEqual([]);
    expect(harness.runtime.sentMessages).toEqual(['first']);

    await waitFor(() => harness.runtime.sentMessages.includes('second'), 'turn-mode queued dispatch');
    await expect(harness.engine.waitIdle(2_000, 10)).resolves.toBe(true);
    expect(harness.runtime.sentMessages).toEqual(['first', 'second']);
  });

  it('keeps permission pending until runtime delivery succeeds', async () => {
    const harness = await createHarness([
      { kind: 'permission', requestId: 'perm-ok', textAfterAllow: 'permission approved answer' },
    ]);
    const sessionId = 'session-permission';

    await harness.engine.sendDesktopMessage(desktopRequest(sessionId, join(harness.home, 'workspace'), 'needs permission'));
    await waitFor(
      () => harness.engine.getStreamReplaySnapshot().pendingInteractiveRequests.length === 1,
      'permission pending',
    );
    expect(harness.engine.getStreamReplaySnapshot().pendingInteractiveRequests[0]).toMatchObject({
      type: 'permission:request',
      data: { requestId: 'perm-ok' },
    });

    await expect(harness.engine.respondPermission('perm-ok', 'allow_once')).resolves.toBe(true);
    await expect(harness.engine.waitIdle(2_000, 10)).resolves.toBe(true);

    expect(harness.runtime.permissionResponses).toEqual([
      { requestId: 'perm-ok', decision: 'allow_once', reason: undefined },
    ]);
    expect(harness.engine.getStreamReplaySnapshot().pendingInteractiveRequests).toHaveLength(0);
    expect(harness.engine.getLatestAssistantResult().latestResult).toBe('permission approved answer');
  });

  it('preserves permission pending state when runtime delivery fails', async () => {
    const harness = await createHarness([
      {
        kind: 'permission',
        requestId: 'perm-fail',
        textAfterAllow: 'unreachable',
        failDelivery: true,
      },
    ]);

    await harness.engine.sendDesktopMessage(desktopRequest('session-permission-fail', join(harness.home, 'workspace'), 'needs permission'));
    await waitFor(
      () => harness.engine.getStreamReplaySnapshot().pendingInteractiveRequests.length === 1,
      'permission pending before failed delivery',
    );

    await expect(harness.engine.respondPermission('perm-fail', 'always_allow')).rejects.toThrow('permission delivery failed');
    expect(harness.engine.getStreamReplaySnapshot().pendingInteractiveRequests).toHaveLength(1);
  });
});
