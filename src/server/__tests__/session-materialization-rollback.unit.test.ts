import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdkMocks = vi.hoisted(() => ({
  query: vi.fn(),
  dispatchedPrompts: [] as unknown[],
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: (...args: Parameters<typeof actual.query>) => sdkMocks.query(...args),
  };
});

vi.mock('../SessionStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../SessionStore')>();
  return {
    ...actual,
    claimPreparedSessionForTurnAdmission: vi.fn(),
    appendSessionMessages: vi.fn(),
    commitBuiltinConversationRewind: vi.fn(),
    deleteSession: vi.fn(async () => ({ deleted: true as const })),
    migratePendingSessionIdentity: vi.fn(),
    resolvePendingConversationMutation: vi.fn(),
    getSessionMetadata: vi.fn(),
    saveSessionMetadata: vi.fn(async () => undefined),
    updateSessionMetadata: vi.fn(),
  };
});

import { appendSessionMessages, claimPreparedSessionForTurnAdmission, commitBuiltinConversationRewind, deleteSession, getSessionMetadata, loadSessionTranscript, migratePendingSessionIdentity, resolvePendingConversationMutation, saveSessionMetadata, updateSessionMetadata, type TranscriptWriteCursor } from '../SessionStore';
import { loadTranscriptFromSessionMessages } from '../builtin-session/transcript-persistence';
import { NO_CHANNEL_DELIVERY } from '../session-core/channel-delivery';
import { setQuerySession, setQuerySessionWithAuthority } from '../builtin-session/lifecycle';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import {
  resetProductSessionMaterializationState as resetSessionMaterializationState,
  setPendingProductSessionMaterialization as setPendingDesktopMaterialization,
} from '../session-engine/product-session-binding';
import { claimPreparedMaterializationForTurnAdmission, enqueueUserMessage, ensureSessionMetadataForSdkSystemInit, getSessionId, initializeAgent, materializePendingDesktopSession, rewindSession, waitForSessionIdle } from '../agent-session';
import type { SessionMetadata } from '../types/session';

const mockedDeleteSession = vi.mocked(deleteSession);
const mockedClaimPreparedSessionForTurnAdmission = vi.mocked(claimPreparedSessionForTurnAdmission);
const mockedAppendSessionMessages = vi.mocked(appendSessionMessages);
const mockedCommitBuiltinConversationRewind = vi.mocked(commitBuiltinConversationRewind);
const mockedGetSessionMetadata = vi.mocked(getSessionMetadata);
const mockedMigratePendingSessionIdentity = vi.mocked(migratePendingSessionIdentity);
const mockedResolvePendingConversationMutation = vi.mocked(resolvePendingConversationMutation);
const mockedSaveSessionMetadata = vi.mocked(saveSessionMetadata);
const mockedUpdateSessionMetadata = vi.mocked(updateSessionMetadata);

describe('materializePendingDesktopSession rollback guard', () => {
  beforeEach(() => {
    resetSessionMaterializationState();
    vi.clearAllMocks();
    sdkMocks.dispatchedPrompts.length = 0;
    mockedClaimPreparedSessionForTurnAdmission.mockResolvedValue({ status: 'not-found' });
    mockedAppendSessionMessages.mockImplementation(async (_sessionId, cursor, messages) => ({
      ok: true,
      action: messages.length > 0 ? 'appended' : 'noop',
      count: messages.length,
      totalCount: cursor.persistedMessageCount + messages.length,
      cursor: { persistedMessageCount: cursor.persistedMessageCount + messages.length } as TranscriptWriteCursor,
    }));
    mockedCommitBuiltinConversationRewind.mockResolvedValue({
      success: true,
      metadata: {} as SessionMetadata,
      messages: [],
      cursor: { persistedMessageCount: 0 } as TranscriptWriteCursor,
    });
  });

  afterEach(() => {
    resetSessionMaterializationState();
  });

  it('refuses caller-supplied rollback ids when no pending materialization exists', async () => {
    const result = await materializePendingDesktopSession({
      phase: 'rollback',
      preparedSessionId: 'unrelated-session',
    });

    expect(result).toMatchObject({
      success: false,
      status: 409,
    });
    expect(mockedDeleteSession).not.toHaveBeenCalled();
  });

  it('refuses to delete a target row not owned by the pending transaction', async () => {
    setPendingDesktopMaterialization({
      priorSessionId: 'pending-source',
      targetSessionId: 'prepared-target',
      reusingNativeSession: false,
      snapshotKind: 'owned',
    });
    mockedGetSessionMetadata.mockReturnValue({
      id: 'prepared-target',
      agentDir: '/tmp/workspace',
      title: 'Prepared',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
      materializationState: 'prepared',
      materializationSourceSessionId: 'different-source',
    });

    const result = await materializePendingDesktopSession({
      phase: 'rollback',
      preparedSessionId: 'prepared-target',
    });

    expect(result).toMatchObject({
      success: false,
      status: 409,
    });
    expect(mockedDeleteSession).not.toHaveBeenCalled();
  });

  it('deletes only the prepared row owned by the pending transaction', async () => {
    setPendingDesktopMaterialization({
      priorSessionId: 'pending-source',
      targetSessionId: 'prepared-target',
      reusingNativeSession: false,
      snapshotKind: 'owned',
    });
    mockedGetSessionMetadata.mockReturnValue({
      id: 'prepared-target',
      agentDir: '/tmp/workspace',
      title: 'Prepared',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
      materializationState: 'prepared',
      materializationSourceSessionId: 'pending-source',
    });

    const result = await materializePendingDesktopSession({
      phase: 'rollback',
      preparedSessionId: 'prepared-target',
    });

    expect(result.success).toBe(true);
    expect(mockedDeleteSession).toHaveBeenCalledWith('prepared-target', {
      kind: 'prepared-materialization-rollback',
      sourceSessionId: 'pending-source',
    });
  });

  it('claims the prepared target identity rather than the still-active pending identity', async () => {
    await initializeAgent('/tmp/workspace', null, 'pending-source', { preWarmDisabled: true });
    setPendingDesktopMaterialization({
      priorSessionId: 'pending-source',
      targetSessionId: 'prepared-target',
      reusingNativeSession: false,
      snapshotKind: 'owned',
    });
    mockedClaimPreparedSessionForTurnAdmission.mockResolvedValue({
      status: 'claimed',
      metadata: {
        id: 'prepared-target',
        agentDir: '/tmp/workspace',
        title: 'hello',
        createdAt: '2026-06-23T00:00:00.000Z',
        lastActiveAt: '2026-06-23T00:00:00.000Z',
      },
    });

    await expect(claimPreparedMaterializationForTurnAdmission('hello')).resolves.toBe(true);
    expect(mockedClaimPreparedSessionForTurnAdmission).toHaveBeenCalledWith(
      'prepared-target',
      'pending-source',
      expect.objectContaining({ messageText: 'hello', title: 'hello' }),
    );
  });

  it('fails closed when rollback removed a renderer-prepared target before admission', async () => {
    await initializeAgent('/tmp/workspace', null, 'pending-source', { preWarmDisabled: true });
    setPendingDesktopMaterialization({
      priorSessionId: 'pending-source',
      targetSessionId: 'prepared-target',
      reusingNativeSession: false,
      snapshotKind: 'owned',
    });
    mockedClaimPreparedSessionForTurnAdmission.mockResolvedValue({ status: 'not-found' });

    await expect(claimPreparedMaterializationForTurnAdmission('hello')).resolves.toBe(false);
  });

  it('refuses to patch a prepared row not owned by the pending transaction', async () => {
    await initializeAgent('/tmp/workspace', null, 'pending-source', { preWarmDisabled: true });
    setPendingDesktopMaterialization({
      priorSessionId: 'pending-source',
      targetSessionId: 'prepared-target',
      reusingNativeSession: false,
      snapshotKind: 'owned',
    });
    mockedGetSessionMetadata.mockReturnValue({
      id: 'prepared-target',
      agentDir: '/tmp/workspace',
      title: 'Prepared',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
      materializationState: 'prepared',
      materializationSourceSessionId: 'different-source',
    });

    const result = await materializePendingDesktopSession({
      phase: 'prepare',
      snapshotPatch: { model: 'deepseek-v4-pro' },
    });

    expect(result).toMatchObject({
      success: false,
      status: 409,
    });
    expect(mockedUpdateSessionMetadata).not.toHaveBeenCalled();
  });

  it('patches an existing prepared row through an in-lock ownership guard', async () => {
    await initializeAgent('/tmp/workspace', null, 'pending-source', { preWarmDisabled: true });
    setPendingDesktopMaterialization({
      priorSessionId: 'pending-source',
      targetSessionId: 'prepared-target',
      reusingNativeSession: false,
      snapshotKind: 'owned',
    });
    const preparedMeta = {
      id: 'prepared-target',
      agentDir: '/tmp/workspace',
      title: 'Prepared',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
      materializationState: 'prepared' as const,
      materializationSourceSessionId: 'pending-source',
    };
    mockedGetSessionMetadata.mockReturnValue(preparedMeta);
    mockedUpdateSessionMetadata.mockResolvedValue({
      ...preparedMeta,
      model: 'deepseek-v4-pro',
      configSnapshotAt: '2026-06-23T00:00:00.000Z',
    });

    const result = await materializePendingDesktopSession({
      phase: 'prepare',
      snapshotPatch: { model: 'deepseek-v4-pro' },
    });

    expect(result.success).toBe(true);
    expect(mockedUpdateSessionMetadata).toHaveBeenCalledWith(
      'prepared-target',
      expect.objectContaining({ model: 'deepseek-v4-pro' }),
      expect.any(Function),
    );
    const guard = mockedUpdateSessionMetadata.mock.calls[0][2] as (current: {
      materializationState?: 'prepared';
      materializationSourceSessionId?: string;
    }) => boolean;
    expect(guard({
      materializationState: 'prepared',
      materializationSourceSessionId: 'pending-source',
    })).toBe(true);
    expect(guard({
      materializationState: 'prepared',
      materializationSourceSessionId: 'different-source',
    })).toBe(false);
  });

  it('prepares metadata for a lazy non-pending desktop session without showing a snapshot failure', async () => {
    const savedMetadata = new Map<string, SessionMetadata>();
    mockedSaveSessionMetadata.mockImplementation(async (meta) => {
      savedMetadata.set(meta.id, meta);
    });
    mockedGetSessionMetadata.mockImplementation((id) => {
      return savedMetadata.get(id) ?? null;
    });

    await initializeAgent('/tmp/workspace', null, undefined, { preWarmDisabled: true });

    const result = await materializePendingDesktopSession({
      phase: 'prepare',
      snapshotPatch: { model: 'kimi-k2.6' },
    });

    expect(result.success).toBe(true);
    expect(mockedSaveSessionMetadata).toHaveBeenCalledTimes(1);
    expect(result.sessionId).toBe(mockedSaveSessionMetadata.mock.calls[0][0].id);
    expect(result.metadata).toMatchObject({
      model: 'kimi-k2.6',
      materializationState: 'prepared',
    });
    expect(result.metadata?.materializationSourceSessionId).toBeTruthy();
  });

  it('migrates pending builtin SDK system_init metadata to the concrete SDK session id without committing visibility', async () => {
    const savedMetadata = new Map<string, SessionMetadata>();
    const pendingMeta: SessionMetadata = {
      id: 'pending-tab-1',
      agentDir: '/tmp/workspace',
      title: 'New Chat',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
      materializationState: 'prepared',
      materializationSourceSessionId: 'pending-tab-1',
    };
    savedMetadata.set(pendingMeta.id, pendingMeta);
    mockedSaveSessionMetadata.mockImplementation(async (meta) => {
      savedMetadata.set(meta.id, meta);
    });
    mockedGetSessionMetadata.mockImplementation((id) => {
      return savedMetadata.get(id) ?? null;
    });
    mockedMigratePendingSessionIdentity.mockImplementation(async (sourceId, targetId, patch) => {
      const source = savedMetadata.get(sourceId);
      if (!source) return { migrated: false, reason: 'source-not-found' };
      const metadata = { ...source, ...patch, id: targetId };
      savedMetadata.delete(sourceId);
      savedMetadata.set(targetId, metadata);
      return {
        migrated: true,
        metadata,
        transcript: await loadSessionTranscript(targetId),
      };
    });

    await initializeAgent('/tmp/workspace', null, 'pending-tab-1', { preWarmDisabled: true });

    const concreteSessionId = '11111111-2222-4333-8444-555555555555';
    setQuerySessionWithAuthority({} as Query, {
      productSessionId: 'pending-tab-1',
      expectedSdkSessionId: concreteSessionId,
    });
    const canonicalSessionId = await ensureSessionMetadataForSdkSystemInit({
      session_id: concreteSessionId,
      tools: [],
      mcp_servers: [],
      timestamp: '2026-06-23T00:00:00.000Z',
    });

    expect(canonicalSessionId).toBe(concreteSessionId);
    expect(getSessionId()).toBe(concreteSessionId);
    expect(savedMetadata.get(concreteSessionId)).toMatchObject({
      id: concreteSessionId,
      sdkSessionId: concreteSessionId,
      unifiedSession: true,
      materializationState: 'prepared',
      materializationSourceSessionId: 'pending-tab-1',
    });
    expect(savedMetadata.has('pending-tab-1')).toBe(false);
    expect(mockedMigratePendingSessionIdentity).toHaveBeenCalledWith(
      'pending-tab-1',
      concreteSessionId,
      { sdkSessionId: concreteSessionId, unifiedSession: true },
      expect.any(Function),
    );
    expect(mockedDeleteSession).not.toHaveBeenCalled();
  });

  it('refuses SDK system_init for an unindexed concrete existing session', async () => {
    mockedGetSessionMetadata.mockReturnValue(null);

    const concreteSessionId = '22222222-3333-4444-8555-666666666666';
    await initializeAgent('/tmp/workspace', null, concreteSessionId, { preWarmDisabled: true });
    setQuerySessionWithAuthority({} as Query, {
      productSessionId: concreteSessionId,
      expectedSdkSessionId: concreteSessionId,
    });

    await expect(ensureSessionMetadataForSdkSystemInit({
      session_id: concreteSessionId,
      tools: [],
      mcp_servers: [],
      timestamp: '2026-06-23T00:00:00.000Z',
    })).rejects.toThrow('refusing SDK system_init for unindexed existing session');
    expect(mockedSaveSessionMetadata).not.toHaveBeenCalled();
  });

  it('keeps a legacy Product Session id while recording its distinct expected SDK id', async () => {
    const productSessionId = '33333333-3333-4333-8333-333333333333';
    const sdkSessionId = '44444444-4444-4444-8444-444444444444';
    const metadata: SessionMetadata = {
      id: productSessionId,
      sdkSessionId,
      unifiedSession: false,
      runtime: 'builtin',
      agentDir: '/tmp/workspace',
      title: 'Legacy',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
    };
    mockedGetSessionMetadata.mockImplementation(id => id === productSessionId ? metadata : null);
    mockedUpdateSessionMetadata.mockResolvedValue(metadata);
    await initializeAgent('/tmp/workspace', null, productSessionId, { preWarmDisabled: true });
    setQuerySessionWithAuthority({} as Query, { productSessionId, expectedSdkSessionId: sdkSessionId });

    await expect(ensureSessionMetadataForSdkSystemInit({
      session_id: sdkSessionId,
      tools: [],
      mcp_servers: [],
      timestamp: '2026-06-23T00:00:00.000Z',
    })).resolves.toBe(productSessionId);

    expect(getSessionId()).toBe(productSessionId);
    expect(mockedUpdateSessionMetadata).toHaveBeenCalledWith(productSessionId, {
      sdkSessionId,
      unifiedSession: false,
    }, expect.any(Function));
  });

  it('keeps a non-UUID Product Session id when a fresh Query receives its expected SDK id', async () => {
    const productSessionId = 'cron-im-legacy-session';
    const sdkSessionId = '88888888-8888-4888-8888-888888888888';
    const metadata: SessionMetadata = {
      id: productSessionId,
      runtime: 'builtin',
      agentDir: '/tmp/workspace',
      title: 'Legacy cron',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
    };
    mockedGetSessionMetadata.mockImplementation(id => id === productSessionId ? metadata : null);
    mockedUpdateSessionMetadata.mockResolvedValue({
      ...metadata,
      sdkSessionId,
      unifiedSession: false,
    });
    await initializeAgent('/tmp/workspace', null, productSessionId, { preWarmDisabled: true });
    setQuerySessionWithAuthority({} as Query, { productSessionId, expectedSdkSessionId: sdkSessionId });

    await expect(ensureSessionMetadataForSdkSystemInit({
      session_id: sdkSessionId,
      tools: [],
      mcp_servers: [],
      timestamp: '2026-06-23T00:00:00.000Z',
    })).resolves.toBe(productSessionId);

    expect(getSessionId()).toBe(productSessionId);
    expect(mockedUpdateSessionMetadata).toHaveBeenCalledWith(productSessionId, {
      sdkSessionId,
      unifiedSession: false,
    }, expect.any(Function));
  });

  it('rejects a delayed system_init after its Query authority has been replaced', async () => {
    const productSessionId = '99999999-9999-4999-8999-999999999999';
    const oldSdkSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const replacementSdkSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const metadata: SessionMetadata = {
      id: productSessionId,
      runtime: 'builtin',
      agentDir: '/tmp/workspace',
      title: 'Delayed init',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
    };
    mockedGetSessionMetadata.mockImplementation(id => id === productSessionId ? metadata : null);
    await initializeAgent('/tmp/workspace', null, productSessionId, { preWarmDisabled: true });
    setQuerySession(null);
    const oldAuthority = setQuerySessionWithAuthority({} as Query, {
      productSessionId,
      expectedSdkSessionId: oldSdkSessionId,
    });
    setQuerySessionWithAuthority({} as Query, {
      productSessionId,
      expectedSdkSessionId: replacementSdkSessionId,
    });
    vi.clearAllMocks();

    await expect(ensureSessionMetadataForSdkSystemInit({
      session_id: oldSdkSessionId,
      tools: [],
      mcp_servers: [],
      timestamp: '2026-06-23T00:00:00.000Z',
    }, oldAuthority)).rejects.toThrow('revoked or replaced Query');

    expect(getSessionId()).toBe(productSessionId);
    expect(mockedUpdateSessionMetadata).not.toHaveBeenCalled();
    expect(mockedSaveSessionMetadata).not.toHaveBeenCalled();
    expect(mockedMigratePendingSessionIdentity).not.toHaveBeenCalled();
  });

  it('rejects a system_init metadata commit after its Query binding was replaced (#541)', async () => {
    const productSessionId = '12121212-1212-4121-8121-121212121212';
    const staleSdkSessionId = '13131313-1313-4131-8131-131313131313';
    const replacementSdkSessionId = '14141414-1414-4141-8141-141414141414';
    const metadata: SessionMetadata = {
      id: productSessionId,
      runtime: 'builtin',
      sdkSessionId: staleSdkSessionId,
      unifiedSession: false,
      agentDir: '/tmp/workspace',
      title: 'Authority race',
      createdAt: '2026-08-14T00:00:00.000Z',
      lastActiveAt: '2026-08-14T00:00:00.000Z',
    };
    mockedGetSessionMetadata.mockImplementation(id => id === productSessionId ? metadata : null);
    await initializeAgent('/tmp/workspace', null, productSessionId, { preWarmDisabled: true });
    const staleAuthority = setQuerySessionWithAuthority({} as Query, {
      productSessionId,
      expectedSdkSessionId: staleSdkSessionId,
    });
    mockedUpdateSessionMetadata.mockImplementation(async (_id, _updates, precondition) => {
      setQuerySessionWithAuthority({} as Query, {
        productSessionId,
        expectedSdkSessionId: replacementSdkSessionId,
      });
      expect(precondition?.({ ...metadata, sdkSessionId: replacementSdkSessionId })).toBe(false);
      return null;
    });

    await expect(ensureSessionMetadataForSdkSystemInit({
      session_id: staleSdkSessionId,
      tools: [],
      mcp_servers: [],
      timestamp: '2026-08-14T00:00:00.000Z',
    }, staleAuthority)).rejects.toThrow('failed to update session metadata');
  });

  it('rejects system_init whose SDK id does not match the Query launch authority', async () => {
    const productSessionId = '55555555-5555-4555-8555-555555555555';
    const expectedSdkSessionId = '66666666-6666-4666-8666-666666666666';
    const metadata: SessionMetadata = {
      id: productSessionId,
      runtime: 'builtin',
      agentDir: '/tmp/workspace',
      title: 'Identity fence',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
    };
    mockedGetSessionMetadata.mockImplementation(id => id === productSessionId ? metadata : null);
    await initializeAgent('/tmp/workspace', null, productSessionId, { preWarmDisabled: true });
    setQuerySessionWithAuthority({} as Query, { productSessionId, expectedSdkSessionId });

    await expect(ensureSessionMetadataForSdkSystemInit({
      session_id: '77777777-7777-4777-8777-777777777777',
      tools: [],
      mcp_servers: [],
      timestamp: '2026-06-23T00:00:00.000Z',
    })).rejects.toThrow(`expected ${expectedSdkSessionId}`);
    expect(mockedUpdateSessionMetadata).not.toHaveBeenCalled();
  });

  it('rewinds a fresh SDK branch without changing the Product Session identity (#541)', async () => {
    const productSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const replacementSdkSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    let metadata: SessionMetadata = {
      id: productSessionId,
      runtime: 'builtin',
      sdkSessionId: 'abababab-abab-4aba-8aba-abababababab',
      unifiedSession: false,
      agentDir: '/tmp/workspace',
      title: 'Stable Product Session',
      createdAt: '2026-08-14T00:00:00.000Z',
      lastActiveAt: '2026-08-14T00:00:00.000Z',
    };
    mockedGetSessionMetadata.mockImplementation(id => id === productSessionId ? metadata : null);
    await initializeAgent('/tmp/workspace', null, productSessionId, { preWarmDisabled: true });
    setQuerySession(null);
    loadTranscriptFromSessionMessages([
      { id: 'user-1', role: 'user', content: 'retry me', timestamp: '2026-08-14T00:00:00.000Z' },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'old answer',
        timestamp: '2026-08-14T00:00:01.000Z',
        sdkUuid: 'historical-assistant-uuid',
      },
    ], { persistedMessageCount: 2 } as TranscriptWriteCursor);
    vi.clearAllMocks();
    mockedGetSessionMetadata.mockImplementation(id => id === productSessionId ? metadata : null);
    mockedCommitBuiltinConversationRewind.mockImplementation(async () => {
      metadata = { ...metadata, sdkSessionId: replacementSdkSessionId };
      return {
        success: true,
        metadata,
        messages: [],
        cursor: { persistedMessageCount: 0 } as TranscriptWriteCursor,
      };
    });
    sdkMocks.query.mockImplementation((args: { prompt: AsyncIterable<unknown> }) => {
      const prompt = args.prompt[Symbol.asyncIterator]();
      let consumed = false;
      const iterator: AsyncIterableIterator<unknown> = {
        async next() {
          if (!consumed) {
            consumed = true;
            const next = await prompt.next();
            if (!next.done) sdkMocks.dispatchedPrompts.push(next.value);
          }
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      return Object.assign(iterator, {
        initializationResult: vi.fn(async () => ({ commands: [] })),
        interrupt: vi.fn(async () => undefined),
        close: vi.fn(),
        mcpServerStatus: vi.fn(async () => []),
        setModel: vi.fn(async () => undefined),
        setPermissionMode: vi.fn(async () => undefined),
        setMcpServers: vi.fn(async () => undefined),
      });
    });

    await expect(rewindSession('user-1')).resolves.toMatchObject({
      success: true,
      content: 'retry me',
    });

    expect(getSessionId()).toBe(productSessionId);
    expect(mockedCommitBuiltinConversationRewind).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: productSessionId,
      sourceSdkSessionId: 'abababab-abab-4aba-8aba-abababababab',
      targetMessageId: 'user-1',
      targetMessageCount: 0,
    }));
    expect(mockedGetSessionMetadata.mock.calls.every(([id]) => id === productSessionId)).toBe(true);
    mockedUpdateSessionMetadata.mockImplementation(async (_id, updates) => {
      metadata = { ...metadata, ...updates };
      return metadata;
    });
    setQuerySession(null);

    await expect(enqueueUserMessage(
      'retry me',
      [], undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      { channelDelivery: NO_CHANNEL_DELIVERY },
    )).resolves.toMatchObject({ queued: false });

    await vi.waitFor(() => {
      expect(sdkMocks.query).toHaveBeenCalledTimes(1);
      expect(sdkMocks.dispatchedPrompts).toHaveLength(1);
    });
    expect(mockedAppendSessionMessages).toHaveBeenCalledTimes(1);
    expect(mockedAppendSessionMessages).toHaveBeenCalledWith(
      productSessionId,
      expect.objectContaining({ persistedMessageCount: 0 }),
      [expect.objectContaining({ role: 'user', content: 'retry me' })],
    );
    expect(sdkMocks.query.mock.calls[0]?.[0]).toMatchObject({
      options: { sessionId: replacementSdkSessionId },
    });
    expect(sdkMocks.query.mock.calls[0]?.[0]?.options).not.toHaveProperty('resume');
    expect(await waitForSessionIdle(2_000, 10)).toBe(true);
  });

  it('fails closed before send when a builtin rewind intent cannot recover (#541)', async () => {
    const productSessionId = '15151515-1515-4151-8151-151515151515';
    const metadata: SessionMetadata = {
      id: productSessionId,
      runtime: 'builtin',
      unifiedSession: false,
      agentDir: '/tmp/workspace',
      title: 'Pending rewind',
      createdAt: '2026-08-14T00:00:00.000Z',
      lastActiveAt: '2026-08-14T00:00:00.000Z',
    };
    mockedGetSessionMetadata.mockImplementation(id => id === productSessionId ? metadata : null);
    await initializeAgent('/tmp/workspace', null, productSessionId, { preWarmDisabled: true });
    setQuerySession(null);
    const pending: SessionMetadata = {
      ...metadata,
      pendingConversationMutation: {
        schemaVersion: 1,
        kind: 'builtin-rewind',
        sourceSdkSessionId: null,
        replacementSdkSessionId: '16161616-1616-4161-8161-161616161616',
        sourceMessageCount: 2,
        targetMessageCount: 0,
      },
    };
    mockedGetSessionMetadata.mockImplementation(id => id === productSessionId ? pending : null);
    mockedResolvePendingConversationMutation.mockResolvedValue({
      success: false,
      reason: 'storage_consistency_error',
      error: 'Conversation mutation count mismatch',
    });

    await expect(enqueueUserMessage(
      'must not dispatch',
      [], undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      { channelDelivery: NO_CHANNEL_DELIVERY },
    )).rejects.toThrow(
      'pending conversation mutation could not recover',
    );
    expect(mockedAppendSessionMessages).not.toHaveBeenCalled();
  });

  it('recovers a committed builtin rewind intent before deciding SDK resume (#541)', async () => {
    const productSessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const replacementSdkSessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const pending: SessionMetadata = {
      id: productSessionId,
      runtime: 'builtin',
      sdkSessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      unifiedSession: false,
      agentDir: '/tmp/workspace',
      title: 'Recovering session',
      createdAt: '2026-08-14T00:00:00.000Z',
      lastActiveAt: '2026-08-14T00:00:00.000Z',
      pendingConversationMutation: {
        schemaVersion: 1,
        kind: 'builtin-rewind',
        sourceSdkSessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        replacementSdkSessionId,
        sourceMessageCount: 2,
        targetMessageCount: 0,
      },
    };
    const recovered = {
      ...pending,
      sdkSessionId: replacementSdkSessionId,
      pendingConversationMutation: undefined,
    };
    mockedGetSessionMetadata.mockImplementation(id => id === productSessionId ? pending : null);
    mockedResolvePendingConversationMutation.mockResolvedValue({
      success: true,
      metadata: recovered,
      messages: [],
      cursor: { persistedMessageCount: 0 } as TranscriptWriteCursor,
    });

    await initializeAgent('/tmp/workspace', null, productSessionId, { preWarmDisabled: true });

    expect(mockedResolvePendingConversationMutation).toHaveBeenCalledWith(productSessionId);
    expect(getSessionId()).toBe(productSessionId);
  });

  it('commits a prepared row even when the active session id is already the prepared id', async () => {
    await initializeAgent('/tmp/workspace', null, 'prepared-target', { preWarmDisabled: true });
    setPendingDesktopMaterialization({
      priorSessionId: 'pending-source',
      targetSessionId: 'prepared-target',
      reusingNativeSession: true,
      snapshotKind: 'owned',
    });
    const preparedMeta = {
      id: 'prepared-target',
      agentDir: '/tmp/workspace',
      title: 'Prepared',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
      materializationState: 'prepared' as const,
      materializationSourceSessionId: 'pending-source',
    };
    const committedMeta = {
      ...preparedMeta,
      materializationState: undefined,
      materializationSourceSessionId: undefined,
    };
    mockedGetSessionMetadata.mockReturnValue(preparedMeta);
    mockedUpdateSessionMetadata.mockResolvedValue(committedMeta);

    const result = await materializePendingDesktopSession({
      phase: 'commit',
      preparedSessionId: 'prepared-target',
    });

    expect(result).toMatchObject({
      success: true,
      sessionId: 'prepared-target',
      metadata: committedMeta,
    });
    expect(mockedUpdateSessionMetadata).toHaveBeenCalledWith(
      'prepared-target',
      {
        materializationState: undefined,
        materializationSourceSessionId: undefined,
      },
      expect.any(Function),
    );
  });

  it('treats duplicate commit after a completed materialization as idempotent', async () => {
    await initializeAgent('/tmp/workspace', null, 'prepared-target', { preWarmDisabled: true });
    const committedMeta = {
      id: 'prepared-target',
      agentDir: '/tmp/workspace',
      title: 'Prepared',
      createdAt: '2026-06-23T00:00:00.000Z',
      lastActiveAt: '2026-06-23T00:00:00.000Z',
    };
    mockedGetSessionMetadata.mockReturnValue(committedMeta);

    const result = await materializePendingDesktopSession({
      phase: 'commit',
      preparedSessionId: 'prepared-target',
    });

    expect(result).toMatchObject({
      success: true,
      sessionId: 'prepared-target',
      metadata: committedMeta,
    });
    expect(mockedUpdateSessionMetadata).not.toHaveBeenCalled();
  });
});
