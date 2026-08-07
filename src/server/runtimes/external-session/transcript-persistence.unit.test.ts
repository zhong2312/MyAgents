import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranscriptWriteCursor } from '../../SessionStore';
import {
  appendSessionMessages,
  loadSessionTranscript,
  mutateSessionTranscript,
  updateSessionMetadata,
} from '../../SessionStore';
import type { SessionMessage } from '../../types/session';
import {
  appendAndPersistExternalAssistantTurn,
  clearExternalSessionMessages,
  getExternalSessionMessagesSnapshot,
  getExternalTranscriptSessionId,
  persistExternalForkTranscript,
  persistExternalUserMessageAppend,
  pushExternalSessionMessage,
  removeAndPersistExternalSessionMessage,
  resetExternalTranscriptState,
  setExternalSessionMessages,
  truncateExternalTranscriptForRetry,
} from './transcript-persistence';

vi.mock('../../SessionStore', () => ({
  appendSessionMessages: vi.fn(),
  loadSessionTranscript: vi.fn(),
  mutateSessionTranscript: vi.fn(),
  updateSessionMetadata: vi.fn(),
}));

function cursor(persistedMessageCount: number): TranscriptWriteCursor {
  return { persistedMessageCount } as TranscriptWriteCursor;
}

function message(id: string, role: 'user' | 'assistant' = 'user'): SessionMessage {
  return {
    id,
    role,
    content: id,
    timestamp: '2026-08-05T00:00:00.000Z',
  };
}

describe('external transcript persistence owner', () => {
  beforeEach(() => {
    resetExternalTranscriptState();
    vi.clearAllMocks();
    vi.mocked(loadSessionTranscript).mockResolvedValue({
      messages: [],
      cursor: cursor(0),
      hasMalformedRows: false,
    });
    vi.mocked(appendSessionMessages).mockImplementation(async (_sessionId, current, messages) => ({
      ok: true,
      action: messages.length > 0 ? 'appended' : 'noop',
      count: messages.length,
      totalCount: current.persistedMessageCount + messages.length,
      cursor: cursor(current.persistedMessageCount + messages.length),
    }));
    vi.mocked(mutateSessionTranscript).mockImplementation(async (_sessionId, current) => ({
      ok: true,
      action: 'noop',
      cursor: current,
    }));
    vi.mocked(updateSessionMetadata).mockResolvedValue(null);
  });

  it('tracks transcript Session ownership and cursor together', () => {
    setExternalSessionMessages('session-a', [message('a-1')], cursor(1));
    expect(getExternalTranscriptSessionId()).toBe('session-a');
    expect(getExternalSessionMessagesSnapshot().map(item => item.id)).toEqual(['a-1']);

    clearExternalSessionMessages('session-b');
    expect(getExternalTranscriptSessionId()).toBe('session-b');
    expect(getExternalSessionMessagesSnapshot()).toEqual([]);
  });

  it('passes only rows after the issued cursor to user append', async () => {
    setExternalSessionMessages('session-a', [message('old')], cursor(1));
    pushExternalSessionMessage(message('new'));

    await persistExternalUserMessageAppend('session-a', 'new', 'persist user');

    expect(appendSessionMessages).toHaveBeenCalledWith(
      'session-a',
      expect.objectContaining({ persistedMessageCount: 1 }),
      [expect.objectContaining({ id: 'new' })],
    );
    expect(updateSessionMetadata).toHaveBeenCalledWith('session-a', {
      lastMessagePreview: 'new',
    });
  });

  it('refuses to mix external fork rows into a non-empty target transcript', async () => {
    vi.mocked(loadSessionTranscript).mockResolvedValueOnce({
      messages: [message('conflict')],
      cursor: cursor(1),
      hasMalformedRows: false,
    });

    await expect(persistExternalForkTranscript('fork-session', [message('fork-1')]))
      .rejects.toThrow('non-empty target');
    expect(appendSessionMessages).not.toHaveBeenCalled();
  });

  it('rehydrates a short projection before append instead of shrinking disk', async () => {
    const durable = [message('0'), message('1', 'assistant'), message('2')];
    setExternalSessionMessages('session-a', [message('partial')], cursor(3));
    vi.mocked(loadSessionTranscript).mockResolvedValueOnce({
      messages: durable,
      cursor: cursor(3),
      hasMalformedRows: false,
    });

    await expect(persistExternalUserMessageAppend('session-a', 'partial', 'persist user'))
      .rejects.toThrow('projection invariant failed');

    expect(appendSessionMessages).not.toHaveBeenCalled();
    expect(getExternalSessionMessagesSnapshot()).toEqual(durable);
  });

  it('commits a rejected-message mutation before changing live state', async () => {
    setExternalSessionMessages('session-a', [message('old'), message('rejected')], cursor(2));
    vi.mocked(mutateSessionTranscript).mockImplementationOnce(async () => {
      expect(getExternalSessionMessagesSnapshot().map(item => item.id)).toEqual(['old', 'rejected']);
      return { ok: true, action: 'replaced', cursor: cursor(1) };
    });

    await expect(removeAndPersistExternalSessionMessage(
      'session-a',
      'rejected',
      'rollback failed user',
    )).resolves.toBe(true);
    expect(getExternalSessionMessagesSnapshot().map(item => item.id)).toEqual(['old']);
  });

  it('commits retry truncation before exposing the removed user content', async () => {
    setExternalSessionMessages(
      'session-a',
      [message('old'), message('failed-user'), message('partial-assistant', 'assistant')],
      cursor(3),
    );
    vi.mocked(mutateSessionTranscript).mockResolvedValueOnce({
      ok: true,
      action: 'replaced',
      cursor: cursor(1),
    });

    await expect(truncateExternalTranscriptForRetry('session-a', 'failed-user')).resolves.toEqual({
      success: true,
      content: 'failed-user',
      attachments: undefined,
    });
    expect(mutateSessionTranscript).toHaveBeenCalledWith(
      'session-a',
      expect.objectContaining({ persistedMessageCount: 3 }),
      { kind: 'external-retry', userMessageId: 'failed-user', targetMessageCount: 1 },
    );
    expect(getExternalSessionMessagesSnapshot().map(item => item.id)).toEqual(['old']);
  });

  it('appends one terminal assistant row and persists derived metadata', async () => {
    setExternalSessionMessages('session-a', [message('user-root')], cursor(1));
    const result = await appendAndPersistExternalAssistantTurn({
      sessionId: 'session-a',
      content: JSON.stringify([{ type: 'text', text: 'done' }]),
      usage: null,
      toolCount: 0,
      contextUsage: null,
      runtimeTurnAnchor: { turnId: 'turn-1', rootUserMessageId: 'user-root' },
    });

    expect(result).toMatchObject({ ok: true, appendedAssistant: true, messageCount: 2 });
    expect(appendSessionMessages).toHaveBeenCalledWith(
      'session-a',
      expect.objectContaining({ persistedMessageCount: 1 }),
      [expect.objectContaining({
        role: 'assistant',
        runtimeTurnAnchor: expect.objectContaining({ turnId: 'turn-1' }),
      })],
    );
  });

  it('keeps transcript success when only metadata projection fails', async () => {
    setExternalSessionMessages('session-a', [message('user-root')], cursor(1));
    vi.mocked(updateSessionMetadata).mockRejectedValueOnce(new Error('metadata unavailable'));

    await expect(appendAndPersistExternalAssistantTurn({
      sessionId: 'session-a',
      content: 'done',
      usage: null,
      toolCount: 0,
      contextUsage: null,
    })).resolves.toMatchObject({ ok: true, appendedAssistant: true });
  });
});
