import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PendingConversationMutation, SessionMessage, SessionMetadata } from '../types/session';

type SessionStoreModule = typeof import('../SessionStore');

let testHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let store: SessionStoreModule;

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'myagents-codex-rewind-store-'));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  vi.resetModules();
  store = await import('../SessionStore');
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(testHome, { recursive: true, force: true });
});

function transcript(): SessionMessage[] {
  return [
    { id: 'user-1', role: 'user', content: 'one', timestamp: '2026-08-03T00:00:00.000Z' },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'first',
      timestamp: '2026-08-03T00:00:01.000Z',
      runtimeTurnAnchor: { turnId: 'turn-1', rootUserMessageId: 'user-1' },
    },
    { id: 'user-2', role: 'user', content: 'two', timestamp: '2026-08-03T00:00:02.000Z' },
    {
      id: 'assistant-2',
      role: 'assistant',
      content: 'second',
      timestamp: '2026-08-03T00:00:03.000Z',
      runtimeTurnAnchor: { turnId: 'turn-2', rootUserMessageId: 'user-2' },
    },
  ];
}

async function createCodexSession(): Promise<SessionMetadata> {
  return store.createSession('/tmp/codex-workspace', {
    runtime: 'codex',
    runtimeSource: 'system-cli',
    runtimeSessionId: 'source-thread',
    runtimeUsageTotals: { inputTokens: 20, outputTokens: 10 },
    lastContextUsage: {
      contextTokens: 20,
      contextWindow: 1000,
      usedPercent: 2,
      source: 'codex',
      windowSource: 'runtime',
    },
  });
}

async function seedTranscript(sessionId: string, messages: SessionMessage[]): Promise<void> {
  const snapshot = await store.loadSessionTranscript(sessionId);
  const result = await store.appendSessionMessages(sessionId, snapshot.cursor, messages);
  expect(result.ok).toBe(true);
}

function writeIntent(sessionId: string, intent: PendingConversationMutation): void {
  const path = join(testHome, '.myagents', 'sessions.json');
  const sessions = JSON.parse(readFileSync(path, 'utf-8')) as SessionMetadata[];
  const index = sessions.findIndex(session => session.id === sessionId);
  sessions[index] = { ...sessions[index], pendingConversationMutation: intent };
  writeFileSync(path, JSON.stringify(sessions, null, 2), 'utf-8');
}

describe('Codex conversation rewind SessionStore transaction', () => {
  it('commits transcript truncation and native binding replacement together', async () => {
    const session = await createCodexSession();
    const source = transcript();
    await seedTranscript(session.id, source);

    const result = await store.commitCodexConversationRewind({
      sessionId: session.id,
      sourceRuntimeSessionId: 'source-thread',
      replacementRuntimeSessionId: 'replacement-thread',
      sourceMessages: source,
      targetMessages: source.slice(0, 2),
    });

    expect(result.success).toBe(true);
    const persisted = store.getSessionData(session.id);
    expect(persisted).toMatchObject({
      runtimeSessionId: 'replacement-thread',
      messages: source.slice(0, 2),
    });
    expect(persisted?.pendingConversationMutation).toBeUndefined();
    expect(persisted?.runtimeUsageTotals).toBeUndefined();
    expect(persisted?.lastContextUsage).toBeUndefined();
  });

  it('clears an intent against the untouched source transcript', async () => {
    const session = await createCodexSession();
    const source = transcript();
    await seedTranscript(session.id, source);
    writeIntent(session.id, {
      schemaVersion: 1,
      kind: 'codex-rewind',
      sourceRuntimeSessionId: 'source-thread',
      replacementRuntimeSessionId: 'replacement-thread',
      sourceMessageCount: 4,
      targetMessageCount: 2,
    });

    await expect(store.resolvePendingConversationMutation(session.id)).resolves.toMatchObject({ success: true });
    expect(store.getSessionMetadata(session.id)).toMatchObject({ runtimeSessionId: 'source-thread' });
    expect(store.getSessionMetadata(session.id)?.pendingConversationMutation).toBeUndefined();
  });

  it('finishes replacement binding from a target-sized transcript and refuses unknown counts', async () => {
    const completed = await createCodexSession();
    const source = transcript();
    await seedTranscript(completed.id, source.slice(0, 2));
    const intent: PendingConversationMutation = {
      schemaVersion: 1,
      kind: 'codex-rewind',
      sourceRuntimeSessionId: 'source-thread',
      replacementRuntimeSessionId: null,
      sourceMessageCount: 4,
      targetMessageCount: 2,
    };
    writeIntent(completed.id, intent);

    await expect(store.resolvePendingConversationMutation(completed.id)).resolves.toMatchObject({ success: true });
    expect(store.getSessionMetadata(completed.id)?.runtimeSessionId).toBeUndefined();

    const inconsistent = await createCodexSession();
    await seedTranscript(inconsistent.id, source.slice(0, 3));
    writeIntent(inconsistent.id, intent);
    await expect(store.resolvePendingConversationMutation(inconsistent.id)).resolves.toMatchObject({
      success: false,
      reason: 'storage_consistency_error',
    });
    expect(store.getSessionMetadata(inconsistent.id)?.pendingConversationMutation).toEqual(intent);
  });
});
