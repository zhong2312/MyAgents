import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveSessionMessages, updateSessionMetadata } from '../SessionStore';
import type { SessionMessage } from '../types/session';
import {
  appendMessage,
  replacePersistedSessionMessageCache,
  resetTranscriptForTest,
  setLastPersistedIndex,
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
  scheduleTranscriptPersist,
  stampTurnUsageOnPendingAssistant,
  stripPlaywrightResults,
} from './transcript-persistence';
import type { MessageWire } from './types';

vi.mock('../SessionStore', () => ({
  saveSessionMessages: vi.fn(),
  updateSessionMetadata: vi.fn(),
}));

function okSave(count: number) {
  return { ok: true as const, action: 'appended' as const, count, totalCount: count };
}

describe('transcript-persistence owner', () => {
  beforeEach(() => {
    resetTranscriptForTest();
    vi.mocked(saveSessionMessages).mockReset();
    vi.mocked(updateSessionMetadata).mockReset();
    vi.mocked(saveSessionMessages).mockResolvedValue(okSave(1));
    vi.mocked(updateSessionMetadata).mockResolvedValue(null);
  });

  it('strips Playwright tool results without changing non-Playwright tools', () => {
    const stripped = stripPlaywrightResults([
      {
        type: 'tool_use',
        tool: {
          id: 'pw',
          name: 'mcp__playwright__browser_snapshot',
          input: {},
          streamIndex: 1,
          result: 'large dom',
        },
      },
      {
        type: 'tool_use',
        tool: {
          id: 'bash',
          name: 'Bash',
          input: {},
          streamIndex: 2,
          result: 'ok',
        },
      },
    ]);

    expect(stripped[0].type === 'tool_use' && stripped[0].tool?.result).toBe(PLAYWRIGHT_RESULT_SENTINEL);
    expect(stripped[1].type === 'tool_use' && stripped[1].tool?.result).toBe('ok');
  });

  it('maps MessageWire to SessionMessage with assistant usage from the message object', () => {
    const message: MessageWire = {
      id: '2',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      timestamp: '2026-06-21T00:00:00.000Z',
      usage: { inputTokens: 10, outputTokens: 3 },
      toolCount: 1,
      durationMs: 123,
    };

    expect(messageWireToSessionMessage(message)).toMatchObject({
      id: '2',
      role: 'assistant',
      content: JSON.stringify(message.content),
      usage: { inputTokens: 10, outputTokens: 3 },
      toolCount: 1,
      durationMs: 123,
    });
  });

  it('loads stored messages and seeds persistence cursor/cache/uuid state', () => {
    const stored: SessionMessage[] = [
      {
        id: '0',
        role: 'user',
        content: 'hello',
        timestamp: '2026-06-21T00:00:00.000Z',
        sdkUuid: 'u0',
      },
      {
        id: '1',
        role: 'assistant',
        content: JSON.stringify([{ type: 'text', text: 'hi' }]),
        timestamp: '2026-06-21T00:00:01.000Z',
        sdkUuid: 'a1',
      },
    ];

    loadTranscriptFromSessionMessages(stored);
    const snapshot = snapshotTranscript();

    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messageSequence).toBe(2);
    expect(snapshot.lastPersistedIndex).toBe(2);
    expect(snapshot.persistedSessionMessageCache).toEqual(stored);
    expect(snapshot.currentSessionUuids.has('u0')).toBe(true);
    expect(snapshot.currentSessionUuids.has('a1')).toBe(true);
  });

  it('does not refresh session recency when the newly persisted turn is maintenance-only', async () => {
    loadTranscriptFromSessionMessages([
      { id: '0', role: 'user', content: 'old human question', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: '1', role: 'assistant', content: 'old answer', timestamp: '2026-01-01T00:01:00.000Z' },
    ]);
    appendMessage({
      id: '2',
      role: 'user',
      content: '<system-reminder><MEMORY_UPDATE>maintain</MEMORY_UPDATE></system-reminder>',
      timestamp: '2026-01-08T00:00:00.000Z',
    });
    appendMessage({
      id: '3',
      role: 'assistant',
      content: 'MEMORY_UPDATE_OK',
      timestamp: '2026-01-08T00:01:00.000Z',
    });
    vi.mocked(saveSessionMessages).mockResolvedValueOnce(okSave(4));

    await persistTranscriptNow({ sessionId: 'session-1' });

    expect(updateSessionMetadata).toHaveBeenCalledWith('session-1', {
      lastMessagePreview: 'old human question',
    });
  });

  it('updates preview without owning recency when persisting human input', async () => {
    appendMessage({
      id: '0',
      role: 'user',
      content: 'new human question',
      timestamp: '2026-01-08T00:00:00.000Z',
    });

    await persistTranscriptNow({ sessionId: 'session-1' });

    expect(updateSessionMetadata).toHaveBeenCalledWith('session-1', {
      lastMessagePreview: 'new human question',
    });
  });

  it('merges lifecycle activity into the same transcript metadata commit', async () => {
    appendMessage({
      id: '0',
      role: 'user',
      content: 'accepted turn',
      timestamp: '2026-07-14T10:00:00.000Z',
    });
    const activityAt = '2026-07-14T10:00:01.000Z';

    await persistTranscriptNow({ sessionId: 'session-1', lastActiveAt: activityAt });

    expect(updateSessionMetadata).toHaveBeenCalledWith('session-1', {
      lastMessagePreview: 'accepted turn',
      lastActiveAt: activityAt,
    });
  });

  it('keeps a durable transcript successful when its metadata patch fails', async () => {
    appendMessage({
      id: '0',
      role: 'user',
      content: 'guarded turn',
      timestamp: '2026-07-14T10:00:00.000Z',
    });
    vi.mocked(updateSessionMetadata).mockRejectedValueOnce(new Error('metadata unavailable'));

    await expect(persistTranscriptNow({
      sessionId: 'session-1',
      lastActiveAt: '2026-07-14T10:00:01.000Z',
    })).resolves.toBeUndefined();

    expect(saveSessionMessages).toHaveBeenCalledOnce();
    expect(transcriptState.lastPersistedIndex).toBe(1);
  });

  it('lets prepared-session materialization own the metadata commit', async () => {
    appendMessage({
      id: '0',
      role: 'user',
      content: 'first prepared turn',
      timestamp: '2026-07-14T10:00:00.000Z',
    });

    await persistTranscriptNow({
      sessionId: 'session-1',
      lastActiveAt: '2026-07-14T10:00:01.000Z',
      metadataDisposition: 'skip',
    });

    expect(saveSessionMessages).toHaveBeenCalledOnce();
    expect(updateSessionMetadata).not.toHaveBeenCalled();
  });

  it('persists terminal activity without rewriting an unchanged transcript', async () => {
    loadTranscriptFromSessionMessages([
      { id: '0', role: 'user', content: 'already durable', timestamp: '2026-07-14T10:00:00.000Z' },
    ]);
    const terminalAt = '2026-07-14T10:00:02.000Z';

    await persistTranscriptNow({ sessionId: 'session-1', lastActiveAt: terminalAt });

    expect(saveSessionMessages).not.toHaveBeenCalled();
    expect(updateSessionMetadata).toHaveBeenCalledWith('session-1', {
      lastActiveAt: terminalAt,
    });
  });

  it('updates preview without owning recency for attachment-only human input', async () => {
    appendMessage({
      id: '0',
      role: 'user',
      content: '',
      timestamp: '2026-01-08T00:00:00.000Z',
      attachments: [{
        id: 'image-1',
        name: 'image.png',
        size: 1,
        mimeType: 'image/png',
        relativePath: 'image.png',
      }],
    });

    await persistTranscriptNow({ sessionId: 'session-1' });

    expect(updateSessionMetadata).toHaveBeenCalledWith('session-1', {
      lastMessagePreview: undefined,
    });
  });

  it('stamps turn usage onto the trailing unpersisted assistant only once', () => {
    appendMessage({
      id: '0',
      role: 'user',
      content: 'hello',
      timestamp: '2026-06-21T00:00:00.000Z',
    });
    appendMessage({
      id: '1',
      role: 'assistant',
      content: 'hi',
      timestamp: '2026-06-21T00:00:01.000Z',
    });
    setLastPersistedIndex(0);

    stampTurnUsageOnPendingAssistant({
      usage: {
        inputTokens: 4,
        outputTokens: 2,
        cacheReadTokens: 1,
        cacheCreationTokens: 0,
        model: 'claude-test',
      },
      toolCount: 3,
      durationMs: 42,
    });
    stampTurnUsageOnPendingAssistant({
      usage: {
        inputTokens: 99,
        outputTokens: 99,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      toolCount: 99,
    });

    expect(transcriptState.messages[1]).toMatchObject({
      usage: {
        inputTokens: 4,
        outputTokens: 2,
        cacheReadTokens: 1,
        model: 'claude-test',
      },
      toolCount: 3,
      durationMs: 42,
    });
  });

  it('retracts messages and pulls the persistence cursor/cache back in lockstep', () => {
    appendMessage({ id: '0', role: 'user', content: 'u0', timestamp: 't0' });
    appendMessage({ id: '1', role: 'assistant', content: 'a1', timestamp: 't1' });
    appendMessage({ id: '2', role: 'assistant', content: 'a2', timestamp: 't2' });
    const persisted: SessionMessage[] = [
      { id: '0', role: 'user', content: 'u0', timestamp: 't0' },
      { id: '1', role: 'assistant', content: 'a1', timestamp: 't1' },
      { id: '2', role: 'assistant', content: 'a2', timestamp: 't2' },
    ];
    replacePersistedSessionMessageCache(persisted);
    setLastPersistedIndex(3);

    const result = applyTranscriptRetractionToPersistence(new Set(['1']));

    expect(result.removedBelowCursor).toBe(1);
    expect(transcriptState.messages.map(m => m.id)).toEqual(['0', '2']);
    expect(transcriptState.persistedSessionMessageCache.map(m => m.id)).toEqual(['0', '2']);
    expect(transcriptState.lastPersistedIndex).toBe(2);
  });

  it('does not advance cursor/cache when SessionStore refuses a persist', async () => {
    appendMessage({ id: '0', role: 'user', content: 'hello', timestamp: 't0' });
    vi.mocked(saveSessionMessages).mockResolvedValueOnce({
      ok: false,
      reason: 'unindexed-create-refused',
      count: 1,
    });

    await expect(persistTranscriptNow({ sessionId: 'missing-session' })).rejects.toThrow('unindexed-create-refused');

    expect(transcriptState.lastPersistedIndex).toBe(0);
    expect(transcriptState.persistedSessionMessageCache).toEqual([]);
    expect(updateSessionMetadata).not.toHaveBeenCalled();
  });

  it('serializes scheduled persists but lets a later persist recover after an earlier failure', async () => {
    appendMessage({ id: '0', role: 'user', content: 'hello', timestamp: 't0' });
    appendMessage({ id: '1', role: 'assistant', content: 'hi', timestamp: 't1' });
    vi.mocked(saveSessionMessages)
      .mockResolvedValueOnce({ ok: false, reason: 'write-error', count: 1, error: 'disk full' })
      .mockResolvedValueOnce(okSave(2));

    await expect(scheduleTranscriptPersist({
      sessionId: 'session-1',
      getCurrentSessionId: () => 'session-1',
      targetMessageCount: 1,
    })).rejects.toThrow('disk full');
    expect(transcriptState.lastPersistedIndex).toBe(0);

    await scheduleTranscriptPersist({
      sessionId: 'session-1',
      getCurrentSessionId: () => 'session-1',
      targetMessageCount: 2,
    });

    expect(saveSessionMessages).toHaveBeenCalledTimes(2);
    expect(transcriptState.lastPersistedIndex).toBe(2);
    expect(transcriptState.persistedSessionMessageCache.map(m => m.id)).toEqual(['0', '1']);
  });

  it('skips stale scheduled persists without writing or advancing cursor', async () => {
    appendMessage({ id: '0', role: 'user', content: 'hello', timestamp: 't0' });

    await scheduleTranscriptPersist({
      sessionId: 'old-session',
      getCurrentSessionId: () => 'new-session',
    });

    expect(saveSessionMessages).not.toHaveBeenCalled();
    expect(transcriptState.lastPersistedIndex).toBe(0);
    expect(transcriptState.persistedSessionMessageCache).toEqual([]);
  });

  it('centralizes fork transcript writes and surfaces structured SessionStore failures', async () => {
    const forkMessages: SessionMessage[] = [
      { id: '0', role: 'user', content: 'fork me', timestamp: 't0' },
    ];
    vi.mocked(saveSessionMessages).mockResolvedValueOnce({
      ok: false,
      reason: 'shrink-refused',
      count: 1,
      existingCount: 2,
    });

    await expect(saveForkTranscript('fork-session', forkMessages)).rejects.toThrow('shrink-refused');
    expect(saveSessionMessages).toHaveBeenCalledWith('fork-session', forkMessages);
  });
});
