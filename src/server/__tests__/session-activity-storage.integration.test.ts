import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type SessionStoreModule = typeof import('../SessionStore');

let home: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let store: SessionStoreModule;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'myagents-session-activity-'));
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

describe('session activity storage invariant', () => {
  it('never rolls lastActiveAt backward while still applying sibling metadata', async () => {
    const session = await store.createSession('/tmp/activity-workspace', {
      lastActiveAt: '2026-07-14T10:00:00.000Z',
      title: 'Before',
    });

    const updated = await store.updateSessionMetadata(session.id, {
      lastActiveAt: '2026-07-14T09:00:00.000Z',
      title: 'After',
    });

    expect(updated).toMatchObject({
      lastActiveAt: '2026-07-14T10:00:00.000Z',
      title: 'After',
    });
    expect(store.getSessionMetadata(session.id)).toMatchObject({
      lastActiveAt: '2026-07-14T10:00:00.000Z',
      title: 'After',
    });
  });

  it('accepts a newer activity timestamp and rejects malformed replacements', async () => {
    const session = await store.createSession('/tmp/activity-workspace', {
      lastActiveAt: '2026-07-14T10:00:00.000Z',
    });

    await store.updateSessionMetadata(session.id, {
      lastActiveAt: '2026-07-14T11:00:00.000Z',
    });
    const malformed = await store.updateSessionMetadata(session.id, {
      lastActiveAt: 'not-a-timestamp',
      favorite: true,
    });

    expect(malformed).toMatchObject({
      lastActiveAt: '2026-07-14T11:00:00.000Z',
      favorite: true,
    });

    await store.updateSessionMetadata(session.id, {
      lastActiveAt: '2027-02-30T00:00:00.000Z',
      title: 'Canonical timestamps only',
    });
    expect(store.getSessionMetadata(session.id)).toMatchObject({
      lastActiveAt: '2026-07-14T11:00:00.000Z',
      title: 'Canonical timestamps only',
    });
  });

  it('keeps the newest timestamp across concurrent writers', async () => {
    const session = await store.createSession('/tmp/activity-workspace', {
      lastActiveAt: '2026-07-14T10:00:00.000Z',
    });

    await Promise.all([
      store.updateSessionMetadata(session.id, {
        lastActiveAt: '2026-07-14T12:00:00.000Z',
        title: 'newer writer',
      }),
      store.updateSessionMetadata(session.id, {
        lastActiveAt: '2026-07-14T11:00:00.000Z',
        favorite: true,
      }),
    ]);

    expect(store.getSessionMetadata(session.id)).toMatchObject({
      lastActiveAt: '2026-07-14T12:00:00.000Z',
      title: 'newer writer',
      favorite: true,
    });
  });
});
