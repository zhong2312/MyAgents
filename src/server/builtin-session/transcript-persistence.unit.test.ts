import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranscriptWriteCursor } from '../SessionStore';
import type { SessionMessage } from '../types/session';
import {
  appendSessionMessages,
  loadSessionTranscript,
  mutateSessionTranscript,
  updateSessionMetadata,
} from '../SessionStore';
import {
  appendMessage,
  resetTranscriptForTest,
  snapshotTranscript,
  transcriptState,
} from './transcript';
import {
  PLAYWRIGHT_RESULT_SENTINEL,
  applyTranscriptRetractionToPersistence,
  loadTranscriptFromSessionMessages,
  messageWireToSessionMessage,
  persistTranscriptNow,
  saveForkTranscript,
  stampTurnUsageOnPendingAssistant,
  stripPlaywrightResults,
} from './transcript-persistence';
import type { MessageWire } from './types';

vi.mock('../SessionStore', () => ({
  appendSessionMessages: vi.fn(),
  loadSessionTranscript: vi.fn(),
  mutateSessionTranscript: vi.fn(),
  updateSessionMetadata: vi.fn(),
}));

function cursor(persistedMessageCount: number): TranscriptWriteCursor {
  return { persistedMessageCount } as TranscriptWriteCursor;
}

function stored(id: string, role: 'user' | 'assistant' = 'user'): SessionMessage {
  return {
    id,
    role,
    content: id,
    timestamp: '2026-08-05T00:00:00.000Z',
  };
}

describe('builtin transcript persistence owner', () => {
  beforeEach(() => {
    resetTranscriptForTest();
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

  it('strips Playwright tool results without changing other tools', () => {
    const result = stripPlaywrightResults([
      { type: 'tool_use', tool: { id: 'pw', name: 'mcp__playwright__browser_snapshot', input: {}, streamIndex: 1, result: 'large' } },
      { type: 'tool_use', tool: { id: 'bash', name: 'Bash', input: {}, streamIndex: 2, result: 'ok' } },
    ]);
    expect(result[0].type === 'tool_use' && result[0].tool?.result).toBe(PLAYWRIGHT_RESULT_SENTINEL);
    expect(result[1].type === 'tool_use' && result[1].tool?.result).toBe('ok');
  });

  it('maps assistant usage onto the durable row', () => {
    const message: MessageWire = {
      id: '2',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      timestamp: '2026-08-05T00:00:00.000Z',
      usage: { inputTokens: 10, outputTokens: 3 },
      toolCount: 1,
      durationMs: 123,
    };
    expect(messageWireToSessionMessage(message)).toMatchObject({
      id: '2',
      usage: { inputTokens: 10, outputTokens: 3 },
      toolCount: 1,
      durationMs: 123,
    });
  });

  it('loads durable messages together with the SessionStore cursor', () => {
    const messages = [
      { ...stored('0'), sdkUuid: 'user-uuid' },
      { ...stored('1', 'assistant'), sdkUuid: 'assistant-uuid' },
    ];
    loadTranscriptFromSessionMessages(messages, cursor(2));

    const snapshot = snapshotTranscript();
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messageSequence).toBe(2);
    expect(snapshot.transcriptCursor?.persistedMessageCount).toBe(2);
    expect(snapshot.currentSessionUuids).toEqual(new Set(['user-uuid', 'assistant-uuid']));
  });

  it('passes only rows after the issued cursor to normal append', async () => {
    loadTranscriptFromSessionMessages([stored('0'), stored('1', 'assistant')], cursor(2));
    appendMessage({ id: '2', role: 'user', content: 'new', timestamp: '2026-08-05T00:00:02.000Z' });

    await persistTranscriptNow({ sessionId: 'session-1' });

    expect(appendSessionMessages).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ persistedMessageCount: 2 }),
      [expect.objectContaining({ id: '2' })],
    );
    expect(transcriptState.transcriptCursor?.persistedMessageCount).toBe(3);
  });

  it('rehydrates a short live projection instead of shrinking the durable transcript (#510)', async () => {
    appendMessage({ id: 'partial-1', role: 'user', content: 'partial', timestamp: 'now' });
    appendMessage({ id: 'partial-2', role: 'assistant', content: 'partial', timestamp: 'now' });
    const durable = Array.from({ length: 22 }, (_, index) => stored(String(index), index % 2 ? 'assistant' : 'user'));
    vi.mocked(loadSessionTranscript).mockResolvedValueOnce({
      messages: durable,
      cursor: cursor(22),
      hasMalformedRows: false,
    });

    await expect(persistTranscriptNow({ sessionId: 'session-1' }))
      .rejects.toThrow('projection invariant failed');

    expect(appendSessionMessages).not.toHaveBeenCalled();
    expect(transcriptState.messages.map(message => message.id)).toEqual(durable.map(message => message.id));
    expect(transcriptState.transcriptCursor?.persistedMessageCount).toBe(22);
  });

  it('invalidates and rehydrates after a stale cursor refusal', async () => {
    loadTranscriptFromSessionMessages([stored('0')], cursor(1));
    appendMessage({ id: '1', role: 'assistant', content: 'new', timestamp: 'now' });
    vi.mocked(appendSessionMessages).mockResolvedValueOnce({
      ok: false,
      reason: 'stale-cursor',
      error: 'changed',
    });
    vi.mocked(loadSessionTranscript).mockResolvedValueOnce({
      messages: [stored('0'), stored('other', 'assistant')],
      cursor: cursor(2),
      hasMalformedRows: false,
    });

    await expect(persistTranscriptNow({ sessionId: 'session-1' })).rejects.toThrow('stale-cursor');
    expect(transcriptState.messages.map(message => message.id)).toEqual(['0', 'other']);
    expect(transcriptState.transcriptCursor?.persistedMessageCount).toBe(2);
  });

  it('commits durable retraction before removing the live row', async () => {
    loadTranscriptFromSessionMessages([stored('0'), stored('1', 'assistant')], cursor(2));
    vi.mocked(mutateSessionTranscript).mockImplementationOnce(async (_sessionId, current) => {
      expect(transcriptState.messages.map(message => message.id)).toEqual(['0', '1']);
      return { ok: true, action: 'replaced', cursor: cursor(current.persistedMessageCount - 1) };
    });

    await applyTranscriptRetractionToPersistence(
      'session-1',
      new Set(['1']),
      { kind: 'sdk-retraction', sdkUuids: ['sdk-1'], streamingTailMessageId: '1' },
    );

    expect(transcriptState.messages.map(message => message.id)).toEqual(['0']);
    expect(transcriptState.transcriptCursor?.persistedMessageCount).toBe(1);
  });

  it('updates activity metadata without issuing a no-op append', async () => {
    loadTranscriptFromSessionMessages([stored('0')], cursor(1));
    await persistTranscriptNow({ sessionId: 'session-1', lastActiveAt: '2026-08-05T01:00:00.000Z' });
    expect(appendSessionMessages).not.toHaveBeenCalled();
    expect(updateSessionMetadata).toHaveBeenCalledWith('session-1', {
      lastActiveAt: '2026-08-05T01:00:00.000Z',
    });
  });

  it('stamps usage only on an unpersisted assistant row', () => {
    loadTranscriptFromSessionMessages([stored('0')], cursor(1));
    appendMessage({ id: '1', role: 'assistant', content: 'done', timestamp: 'now' });
    stampTurnUsageOnPendingAssistant({
      usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
      toolCount: 1,
    });
    expect(transcriptState.messages[1]).toMatchObject({
      usage: { inputTokens: 4, outputTokens: 2 },
      toolCount: 1,
    });
  });

  it('creates fork transcript from the fork Session cursor without touching parent state', async () => {
    const parentCursor = cursor(3);
    transcriptState.transcriptCursor = parentCursor;
    await saveForkTranscript('fork-session', [stored('fork-1')]);
    expect(appendSessionMessages).toHaveBeenCalledWith(
      'fork-session',
      expect.objectContaining({ persistedMessageCount: 0 }),
      [expect.objectContaining({ id: 'fork-1' })],
    );
    expect(transcriptState.transcriptCursor).toBe(parentCursor);
  });

  it('refuses to mix fork rows into a non-empty target transcript', async () => {
    vi.mocked(loadSessionTranscript).mockResolvedValueOnce({
      messages: [stored('conflict')],
      cursor: cursor(1),
      hasMalformedRows: false,
    });

    await expect(saveForkTranscript('fork-session', [stored('fork-1')]))
      .rejects.toThrow('non-empty target');
    expect(appendSessionMessages).not.toHaveBeenCalled();
  });
});
