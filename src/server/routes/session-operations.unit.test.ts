import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  engine: {
    resetForNewDesktopSession: vi.fn(async () => ({ success: true, sessionId: 'new-desktop' })),
    rewindToUserMessage: vi.fn<(userMessageId: string) => Promise<Record<string, unknown>>>(
      async () => ({ success: true, content: 'removed' }),
    ),
    retryLastExternalUserMessage: vi.fn<(userMessageId: string) => Promise<Record<string, unknown>>>(
      async () => ({ success: true, content: 'retry text' }),
    ),
    forkAtAssistantMessage: vi.fn<(messageId: string) => Promise<Record<string, unknown>>>(
      async () => ({ success: true, newSessionId: 'forked' }),
    ),
    switchToExistingSession: vi.fn<
      (
        sessionId: string,
        workspacePath: string,
        getMetadata: (sessionId: string) => unknown,
      ) => Promise<{ success: boolean; sessionId: string }>
    >(async () => ({ success: true, sessionId: 'sid-2' })),
    resetForNewImSession: vi.fn(async () => ({ success: true, sessionId: 'im-new' })),
  },
  getSessionMetadata: vi.fn(() => ({ runtime: 'codex' })),
}));

vi.mock('../session-engine', () => ({
  getSessionEngine: () => mocks.engine,
}));

vi.mock('../SessionStore', () => ({
  getSessionMetadata: mocks.getSessionMetadata,
}));

import { handleSessionOperationRoute } from './session-operations';

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe('handleSessionOperationRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.engine.resetForNewDesktopSession.mockResolvedValue({ success: true, sessionId: 'new-desktop' });
    mocks.engine.rewindToUserMessage.mockResolvedValue({ success: true, content: 'removed' });
    mocks.engine.retryLastExternalUserMessage.mockResolvedValue({ success: true, content: 'retry text' });
    mocks.engine.forkAtAssistantMessage.mockResolvedValue({ success: true, newSessionId: 'forked' });
    mocks.engine.switchToExistingSession.mockResolvedValue({ success: true, sessionId: 'sid-2' });
    mocks.engine.resetForNewImSession.mockResolvedValue({ success: true, sessionId: 'im-new' });
    mocks.getSessionMetadata.mockReturnValue({ runtime: 'codex' });
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
    expect(mocks.engine.retryLastExternalUserMessage).toHaveBeenCalledWith('user-2');
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

  it('passes persisted metadata lookup into session switch without route-level runtime branching', async () => {
    mocks.engine.switchToExistingSession.mockImplementationOnce(async (_sessionId, _workspacePath, getMetadata) => {
      expect(getMetadata('sid-2')).toEqual({ runtime: 'codex' });
      return { success: true, sessionId: 'sid-2' };
    });

    const response = await handleSessionOperationRoute(
      '/sessions/switch',
      new Request('http://local/sessions/switch', {
        method: 'POST',
        body: JSON.stringify({ sessionId: 'sid-2' }),
      }),
      { workspacePath: '/workspace' },
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response as Response)).toEqual({ success: true, sessionId: 'sid-2' });
    expect(mocks.engine.switchToExistingSession).toHaveBeenCalledWith(
      'sid-2',
      '/workspace',
      mocks.getSessionMetadata,
    );
  });

  it('resets IM sessions through the active engine', async () => {
    const response = await handleSessionOperationRoute(
      '/api/im/session/new',
      new Request('http://local/api/im/session/new', { method: 'POST' }),
      { workspacePath: '/workspace' },
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response as Response)).toEqual({ sessionId: 'im-new' });
    expect(mocks.engine.resetForNewImSession).toHaveBeenCalledWith('/workspace', {
      metadataBirthPending: false,
    });
  });

  it('passes birth-pending state when resetting IM sessions', async () => {
    const response = await handleSessionOperationRoute(
      '/api/im/session/new',
      new Request('http://local/api/im/session/new', {
        method: 'POST',
        body: JSON.stringify({ metadataBirthPending: true }),
      }),
      { workspacePath: '/workspace' },
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response as Response)).toEqual({ sessionId: 'im-new' });
    expect(mocks.engine.resetForNewImSession).toHaveBeenCalledWith('/workspace', {
      metadataBirthPending: true,
    });
  });

  it('passes explicit unindexed state when resetting IM sessions', async () => {
    const response = await handleSessionOperationRoute(
      '/api/im/session/new',
      new Request('http://local/api/im/session/new', {
        method: 'POST',
        body: JSON.stringify({ metadataBirthPending: false, metadataIndexed: false }),
      }),
      { workspacePath: '/workspace' },
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response as Response)).toEqual({ sessionId: 'im-new' });
    expect(mocks.engine.resetForNewImSession).toHaveBeenCalledWith('/workspace', {
      metadataBirthPending: false,
      metadataIndexed: false,
    });
  });
});
