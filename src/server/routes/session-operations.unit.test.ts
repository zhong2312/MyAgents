import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  engine: {
    resetForNewDesktopSession: vi.fn(async () => ({ success: true, sessionId: 'new-desktop' })),
    compactContext: vi.fn(async () => ({ success: true })),
    rewindToUserMessage: vi.fn<(userMessageId: string) => Promise<Record<string, unknown>>>(
      async () => ({ success: true, content: 'removed' }),
    ),
    forkAtAssistantMessage: vi.fn<(messageId: string) => Promise<Record<string, unknown>>>(
      async () => ({ success: true, newSessionId: 'forked' }),
    ),
    migrateBoundSurfaceSession: vi.fn(async (_workspacePath: string, options: { targetSessionId: string }) => ({
      success: true,
      sessionId: options.targetSessionId,
    })),
  },
  retryLastExternalUserMessageAtSelector: vi.fn<(userMessageId: string) => Promise<Record<string, unknown>>>(
    async () => ({ success: true, content: 'retry text' }),
  ),
}));

vi.mock('../session-engine', () => ({
  getSessionEngine: () => mocks.engine,
  retryLastExternalUserMessageAtSelector: mocks.retryLastExternalUserMessageAtSelector,
}));

import { handleSessionOperationRoute } from './session-operations';

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe('handleSessionOperationRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.engine.resetForNewDesktopSession.mockResolvedValue({ success: true, sessionId: 'new-desktop' });
    mocks.engine.compactContext.mockResolvedValue({ success: true });
    mocks.engine.rewindToUserMessage.mockResolvedValue({ success: true, content: 'removed' });
    mocks.retryLastExternalUserMessageAtSelector.mockResolvedValue({ success: true, content: 'retry text' });
    mocks.engine.forkAtAssistantMessage.mockResolvedValue({ success: true, newSessionId: 'forked' });
    mocks.engine.migrateBoundSurfaceSession.mockImplementation(async (_workspacePath, options) => ({
      success: true,
      sessionId: options.targetSessionId,
    }));
  });

  it('resets desktop sessions through the active engine', async () => {
    const response = await handleSessionOperationRoute(
      '/chat/reset',
      new Request('http://local/chat/reset', { method: 'POST' }),
      { workspacePath: '/workspace' },
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response as Response)).toEqual({ success: true, sessionId: 'new-desktop' });
    expect(mocks.engine.resetForNewDesktopSession).toHaveBeenCalledWith('/workspace');
  });

  it('routes native context compaction through the active SessionEngine', async () => {
    const response = await handleSessionOperationRoute(
      '/api/session/compact',
      new Request('http://local/api/session/compact', { method: 'POST' }),
      { workspacePath: '/workspace' },
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response as Response)).toEqual({ success: true });
    expect(mocks.engine.compactContext).toHaveBeenCalledOnce();
  });

  it('requires a userMessageId before calling rewind', async () => {
    const response = await handleSessionOperationRoute(
      '/chat/rewind',
      new Request('http://local/chat/rewind', { method: 'POST', body: '{}' }),
      { workspacePath: '/workspace' },
    );

    expect(response?.status).toBe(400);
    expect(await readJson(response as Response)).toEqual({ success: false, error: 'Missing userMessageId' });
    expect(mocks.engine.rewindToUserMessage).not.toHaveBeenCalled();
  });

  it('routes rewind, external retry, and fork to active engine operations', async () => {
    mocks.engine.rewindToUserMessage.mockResolvedValueOnce({
      success: true,
      content: 'removed',
      skippedLinks: 2,
      fileRewindStatus: 'partial',
    });
    const rewind = await handleSessionOperationRoute(
      '/chat/rewind',
      new Request('http://local/chat/rewind', {
        method: 'POST',
        body: JSON.stringify({ userMessageId: 'user-1' }),
      }),
      { workspacePath: '/workspace' },
    );
    const retry = await handleSessionOperationRoute(
      '/chat/external-retry',
      new Request('http://local/chat/external-retry', {
        method: 'POST',
        body: JSON.stringify({ userMessageId: 'user-2' }),
      }),
      { workspacePath: '/workspace' },
    );
    const fork = await handleSessionOperationRoute(
      '/sessions/fork',
      new Request('http://local/sessions/fork', {
        method: 'POST',
        body: JSON.stringify({ messageId: 'assistant-1' }),
      }),
      { workspacePath: '/workspace' },
    );

    expect(await readJson(rewind as Response)).toEqual({
      success: true,
      content: 'removed',
      skippedLinks: 2,
      fileRewindStatus: 'partial',
    });
    expect(await readJson(retry as Response)).toEqual({ success: true, content: 'retry text' });
    expect(await readJson(fork as Response)).toEqual({ success: true, newSessionId: 'forked' });
    expect(mocks.engine.rewindToUserMessage).toHaveBeenCalledWith('user-1');
    expect(mocks.retryLastExternalUserMessageAtSelector).toHaveBeenCalledWith('user-2');
    expect(mocks.engine.forkAtAssistantMessage).toHaveBeenCalledWith('assistant-1');
  });

  it('preserves legacy HTTP 200 for domain operation failures without explicit status', async () => {
    mocks.engine.rewindToUserMessage.mockResolvedValueOnce({ success: false, error: 'Message not found' });

    const response = await handleSessionOperationRoute(
      '/chat/rewind',
      new Request('http://local/chat/rewind', {
        method: 'POST',
        body: JSON.stringify({ userMessageId: 'missing' }),
      }),
      { workspacePath: '/workspace' },
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response as Response)).toEqual({ success: false, error: 'Message not found' });
  });

  it('uses explicit engine status for unsupported runtime operation failures', async () => {
    mocks.engine.forkAtAssistantMessage.mockResolvedValueOnce({
      success: false,
      status: 400,
      error: 'Fork is not supported for external runtimes (CC/Codex)',
    });

    const response = await handleSessionOperationRoute(
      '/sessions/fork',
      new Request('http://local/sessions/fork', {
        method: 'POST',
        body: JSON.stringify({ messageId: 'assistant-1' }),
      }),
      { workspacePath: '/workspace' },
    );

    expect(response?.status).toBe(400);
    expect(await readJson(response as Response)).toEqual({
      success: false,
      error: 'Fork is not supported for external runtimes (CC/Codex)',
    });
  });

  it('migrates a bound surface to the Rust-proven target identity', async () => {
    const targetSessionId = '6d57334a-44d8-4fe1-a4f2-cd57fc8beb85';
    const response = await handleSessionOperationRoute(
      '/api/session/surface-migration',
      new Request('http://local/api/session/surface-migration', {
        method: 'POST',
        body: JSON.stringify({ targetSessionId }),
      }),
      { workspacePath: '/workspace' },
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response as Response)).toEqual({ sessionId: targetSessionId });
    expect(mocks.engine.migrateBoundSurfaceSession).toHaveBeenCalledWith('/workspace', {
      targetSessionId,
      metadataBirthPending: false,
    });
  });

  it('passes birth-pending state during bound surface migration', async () => {
    const targetSessionId = 'e8c1e529-8458-4361-a24a-02f5c278203e';
    const response = await handleSessionOperationRoute(
      '/api/session/surface-migration',
      new Request('http://local/api/session/surface-migration', {
        method: 'POST',
        body: JSON.stringify({ targetSessionId, metadataBirthPending: true }),
      }),
      { workspacePath: '/workspace' },
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response as Response)).toEqual({ sessionId: targetSessionId });
    expect(mocks.engine.migrateBoundSurfaceSession).toHaveBeenCalledWith('/workspace', {
      targetSessionId,
      metadataBirthPending: true,
    });
  });

  it('passes explicit unindexed state during bound surface migration', async () => {
    const targetSessionId = 'af131598-00c6-4b7b-b4fb-c039cb0f0496';
    const response = await handleSessionOperationRoute(
      '/api/session/surface-migration',
      new Request('http://local/api/session/surface-migration', {
        method: 'POST',
        body: JSON.stringify({ targetSessionId, metadataBirthPending: false, metadataIndexed: false }),
      }),
      { workspacePath: '/workspace' },
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response as Response)).toEqual({ sessionId: targetSessionId });
    expect(mocks.engine.migrateBoundSurfaceSession).toHaveBeenCalledWith('/workspace', {
      targetSessionId,
      metadataBirthPending: false,
      metadataIndexed: false,
    });
  });

  it('rejects surface migration without a Rust-generated UUID target', async () => {
    const response = await handleSessionOperationRoute(
      '/api/session/surface-migration',
      new Request('http://local/api/session/surface-migration', {
        method: 'POST',
        body: JSON.stringify({ targetSessionId: 'not-a-uuid' }),
      }),
      { workspacePath: '/workspace' },
    );

    expect(response?.status).toBe(400);
    expect(mocks.engine.migrateBoundSurfaceSession).not.toHaveBeenCalled();
  });
});
