import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  engine: {
    getStreamReplaySnapshot: vi.fn(() => ({
      sessionId: 'session-live',
      initState: { sessionState: 'idle' },
      replayMessages: [
        { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00.000Z' },
      ],
      liveStreamingMessage: {
        id: 'live-1',
        role: 'assistant',
        content: 'partial answer',
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      systemInitPayload: { info: { model: 'claude' } },
      pendingInteractiveRequests: [
        { type: 'chat:permission-request', data: { requestId: 'perm-1' } },
      ],
    })),
  },
}));

vi.mock('../session-engine', () => ({
  getSessionEngine: () => mocks.engine,
}));

import { handleChatStreamRoute } from './chat-stream';

describe('handleChatStreamRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the active engine replay snapshot over SSE in legacy event order', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sent: Array<{ event: string; data: unknown }> = [];
    const response = new Response('stream');
    const createSseClient = vi.fn(() => ({
      client: {
        send(event: string, data: unknown) {
          sent.push({ event, data });
        },
      },
      response,
    }));

    const result = await handleChatStreamRoute(
      '/chat/stream',
      new Request('http://local/chat/stream'),
      {
        createSseClient,
        getLogLines: () => ['log-1'],
      },
    );

    expect(result).toBe(response);
    expect(mocks.engine.getStreamReplaySnapshot.mock.invocationCallOrder[0])
      .toBeLessThan(createSseClient.mock.invocationCallOrder[0]);
    expect(sent).toEqual([
      {
        event: 'chat:init',
        data: {
          sessionState: 'idle',
          sessionId: 'session-live',
          liveStreamingMessage: {
            id: 'live-1',
            role: 'assistant',
            content: 'partial answer',
            timestamp: '2026-01-01T00:00:01.000Z',
          },
        },
      },
      {
        event: 'chat:message-replay',
        data: {
          message: { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00.000Z' },
          replayKind: 'cold-history',
          sessionId: 'session-live',
        },
      },
      { event: 'chat:logs', data: { lines: ['log-1'] } },
      { event: 'chat:system-init', data: { info: { model: 'claude' } } },
      { event: 'chat:permission-request', data: { requestId: 'perm-1' } },
    ]);
    expect(log).toHaveBeenCalledWith(
      '[sse] chat:message-replay -> messageId=m1 replayKind=cold-history role=user sessionScope=present',
    );
    expect(log.mock.calls.flat().join(' ')).not.toContain('session-live');
    expect(log.mock.calls.flat().join(' ')).not.toContain('hello');
  });

  it('ignores non-stream paths', async () => {
    await expect(handleChatStreamRoute(
      '/chat/send',
      new Request('http://local/chat/send'),
      {
        createSseClient: () => ({ client: { send: vi.fn() }, response: new Response() }),
        getLogLines: () => [],
      },
    )).resolves.toBeNull();
  });
});
