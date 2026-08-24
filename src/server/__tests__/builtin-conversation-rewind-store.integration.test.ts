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
  testHome = mkdtempSync(join(tmpdir(), 'myagents-builtin-rewind-store-'));
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
    { id: 'user-1', role: 'user', content: 'one', timestamp: '2026-08-14T00:00:00.000Z' },
    { id: 'assistant-1', role: 'assistant', content: 'first', timestamp: '2026-08-14T00:00:01.000Z' },
    { id: 'user-2', role: 'user', content: 'two', timestamp: '2026-08-14T00:00:02.000Z' },
    { id: 'assistant-2', role: 'assistant', content: 'second', timestamp: '2026-08-14T00:00:03.000Z' },
  ];
}

async function createBuiltinSession(sourceSdkSessionId = '11111111-1111-4111-8111-111111111111') {
  return store.createSession('/tmp/builtin-workspace', {
    runtime: 'builtin',
    sdkSessionId: sourceSdkSessionId,
    unifiedSession: false,
    forkFrom: { sourceSessionId: 'fork-source' },
    runtimeUsageTotals: { inputTokens: 20, outputTokens: 10 },
    lastContextUsage: {
      contextTokens: 20,
      contextWindow: 1000,
      usedPercent: 2,
      source: 'builtin',
      windowSource: 'runtime',
    },
  });
}

async function seedTranscript(sessionId: string, messages: SessionMessage[]) {
  const snapshot = await store.loadSessionTranscript(sessionId);
  const result = await store.appendSessionMessages(sessionId, snapshot.cursor, messages);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.cursor;
}

function writeIntent(sessionId: string, intent: PendingConversationMutation): void {
  const path = join(testHome, '.myagents', 'sessions.json');
  const sessions = JSON.parse(readFileSync(path, 'utf-8')) as SessionMetadata[];
  const index = sessions.findIndex(session => session.id === sessionId);
  sessions[index] = { ...sessions[index], pendingConversationMutation: intent };
  writeFileSync(path, JSON.stringify(sessions, null, 2), 'utf-8');
}

describe('builtin conversation rewind SessionStore transaction', () => {
  it('keeps Product Session identity while replacing only the SDK binding', async () => {
    const sourceSdkSessionId = '11111111-1111-4111-8111-111111111111';
    const replacementSdkSessionId = '22222222-2222-4222-8222-222222222222';
    const session = await createBuiltinSession(sourceSdkSessionId);
    const source = transcript();
    const cursor = await seedTranscript(session.id, source);

    const result = await store.commitBuiltinConversationRewind({
      sessionId: session.id,
      cursor,
      sourceSdkSessionId,
      replacementSdkSessionId,
      targetMessageId: 'user-2',
      targetMessageCount: 2,
    });

    expect(result).toMatchObject({ success: true, cursor: { persistedMessageCount: 2 } });
    const persisted = store.getSessionData(session.id);
    expect(persisted).toMatchObject({
      id: session.id,
      sdkSessionId: replacementSdkSessionId,
      unifiedSession: false,
      messages: source.slice(0, 2),
    });
    expect(persisted?.forkFrom).toBeUndefined();
    expect(persisted?.pendingConversationMutation).toBeUndefined();
    expect(persisted?.runtimeUsageTotals).toBeUndefined();
    expect(persisted?.lastContextUsage).toBeUndefined();
  });

  it('recovers both crash windows without inventing another SDK identity', async () => {
    const sourceSdkSessionId = '33333333-3333-4333-8333-333333333333';
    const replacementSdkSessionId = '44444444-4444-4444-8444-444444444444';
    const intent: PendingConversationMutation = {
      schemaVersion: 1,
      kind: 'builtin-rewind',
      sourceSdkSessionId,
      replacementSdkSessionId,
      sourceMessageCount: 4,
      targetMessageCount: 2,
    };

    const sourceIntact = await createBuiltinSession(sourceSdkSessionId);
    await seedTranscript(sourceIntact.id, transcript());
    writeIntent(sourceIntact.id, intent);
    await expect(store.resolvePendingConversationMutation(sourceIntact.id))
      .resolves.toMatchObject({ success: true, metadata: { sdkSessionId: sourceSdkSessionId } });
    expect(store.getSessionMetadata(sourceIntact.id)?.pendingConversationMutation).toBeUndefined();

    const targetCommitted = await createBuiltinSession(sourceSdkSessionId);
    await seedTranscript(targetCommitted.id, transcript().slice(0, 2));
    writeIntent(targetCommitted.id, intent);
    await expect(store.resolvePendingConversationMutation(targetCommitted.id))
      .resolves.toMatchObject({ success: true, metadata: { sdkSessionId: replacementSdkSessionId } });
    expect(store.getSessionMetadata(targetCommitted.id)?.pendingConversationMutation).toBeUndefined();
  });

  it('fails closed for stale cursors and inconsistent recovery evidence', async () => {
    const sourceSdkSessionId = '55555555-5555-4555-8555-555555555555';
    const replacementSdkSessionId = '66666666-6666-4666-8666-666666666666';
    const session = await createBuiltinSession(sourceSdkSessionId);
    const source = transcript();
    const staleCursor = await seedTranscript(session.id, source);
    await store.appendSessionMessages(session.id, staleCursor, [
      { id: 'user-3', role: 'user', content: 'changed', timestamp: '2026-08-14T00:00:04.000Z' },
    ]);

    await expect(store.commitBuiltinConversationRewind({
      sessionId: session.id,
      cursor: staleCursor,
      sourceSdkSessionId,
      replacementSdkSessionId,
      targetMessageId: 'user-2',
      targetMessageCount: 2,
    })).resolves.toMatchObject({
      success: false,
      reason: 'precondition_failed',
      error: expect.stringContaining('stale-cursor'),
    });
    expect(store.getSessionMetadata(session.id)?.sdkSessionId).toBe(sourceSdkSessionId);

    const inconsistent = await createBuiltinSession(sourceSdkSessionId);
    await seedTranscript(inconsistent.id, source.slice(0, 3));
    const intent: PendingConversationMutation = {
      schemaVersion: 1,
      kind: 'builtin-rewind',
      sourceSdkSessionId,
      replacementSdkSessionId,
      sourceMessageCount: 4,
      targetMessageCount: 2,
    };
    writeIntent(inconsistent.id, intent);
    await expect(store.resolvePendingConversationMutation(inconsistent.id)).resolves.toMatchObject({
      success: false,
      reason: 'storage_consistency_error',
    });
    expect(store.getSessionMetadata(inconsistent.id)?.pendingConversationMutation).toEqual(intent);

    const bindingChanged = await createBuiltinSession('77777777-7777-4777-8777-777777777777');
    await seedTranscript(bindingChanged.id, source);
    writeIntent(bindingChanged.id, intent);
    await expect(store.resolvePendingConversationMutation(bindingChanged.id)).resolves.toMatchObject({
      success: false,
      reason: 'storage_consistency_error',
      error: 'Conversation mutation source binding mismatch',
    });
    expect(store.getSessionMetadata(bindingChanged.id)?.pendingConversationMutation).toEqual(intent);
  });
});
