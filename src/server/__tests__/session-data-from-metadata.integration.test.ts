import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type SessionStoreModule = typeof import('../SessionStore');

let home: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let store: SessionStoreModule;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'myagents-session-data-from-metadata-'));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  vi.resetModules();
  store = await import('../SessionStore');
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(home, { recursive: true, force: true });
});

describe('SessionStore bulk-read path', () => {
  it('assembles SessionData from caller-owned metadata without rereading the index', async () => {
    const metadata = await store.createSession('/tmp/usage-stats-workspace');
    const message = {
      id: 'message-1',
      role: 'user' as const,
      content: 'usage stats',
      timestamp: '2026-07-17T00:00:00.000Z',
    };
    const snapshot = await store.loadSessionTranscript(metadata.id);
    expect((await store.appendSessionMessages(metadata.id, snapshot.cursor, [message])).ok).toBe(true);

    const sessionsPath = join(home, '.myagents', 'sessions.json');
    const persistedIndex = readFileSync(sessionsPath, 'utf-8');
    writeFileSync(sessionsPath, '[]', 'utf-8');

    expect(store.getSessionData(metadata.id)).toBeNull();
    expect(store.getSessionDataFromMetadata(metadata)).toMatchObject({
      id: metadata.id,
      messages: [message],
    });

    writeFileSync(sessionsPath, persistedIndex, 'utf-8');
  });
});
