import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { RegisteredAgentSessionOrigin } from '../../shared/session-origin';

type SessionStoreModule = typeof import('../SessionStore');

let home: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let store: SessionStoreModule;

const exactOrigin: RegisteredAgentSessionOrigin = {
  kind: 'registered-agent',
  surface: 'space_issue_delivery',
  context: { spaceId: 'space-a', registeredAgentId: 'agent-a' },
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'myagents-registered-origin-'));
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

describe('Registered Agent Session origin persistence', () => {
  it('adopts only the historical context-free origin and persists exact identity', async () => {
    const session = await store.createSession('/tmp/registered-origin', {
      origin: {
        kind: 'registered-agent',
        surface: 'space_issue_delivery',
      } as never,
    });

    await expect(
      store.ensureRegisteredAgentSessionOrigin(session.id, exactOrigin),
    ).resolves.toEqual({
      success: true,
      metadataExists: true,
      adoptedLegacyOrigin: true,
    });
    expect(store.getPersistedSessionOrigin(session.id)).toEqual(exactOrigin);
    await expect(
      store.ensureRegisteredAgentSessionOrigin(session.id, exactOrigin),
    ).resolves.toEqual({ success: true, metadataExists: true });
  });

  it('fails closed for conflicting or malformed persisted authority', async () => {
    const conflicting = await store.createSession('/tmp/registered-origin', {
      origin: {
        kind: 'registered-agent',
        surface: 'space_issue_delivery',
        context: { spaceId: 'space-b', registeredAgentId: 'agent-b' },
      },
    });
    const malformed = await store.createSession('/tmp/registered-origin', {
      origin: {
        kind: 'registered-agent',
        surface: 'space_issue_delivery',
        context: { spaceId: 'space-a' },
      } as never,
    });
    const missing = await store.createSession('/tmp/registered-origin');
    const explicitNull = await store.createSession('/tmp/registered-origin', {
      origin: null as never,
    });
    const desktop = await store.createSession('/tmp/registered-origin', {
      origin: { kind: 'desktop', surface: 'new_chat_button' },
    });

    await expect(
      store.ensureRegisteredAgentSessionOrigin(conflicting.id, exactOrigin),
    ).resolves.toMatchObject({ success: false });
    await expect(
      store.ensureRegisteredAgentSessionOrigin(malformed.id, exactOrigin),
    ).resolves.toMatchObject({ success: false });
    await expect(
      store.ensureRegisteredAgentSessionOrigin(missing.id, exactOrigin),
    ).resolves.toMatchObject({ success: false });
    await expect(
      store.ensureRegisteredAgentSessionOrigin(explicitNull.id, exactOrigin),
    ).resolves.toMatchObject({ success: false });
    await expect(
      store.ensureRegisteredAgentSessionOrigin(desktop.id, exactOrigin),
    ).resolves.toMatchObject({ success: false });
    await expect(
      store.ensureRegisteredAgentSessionOrigin('missing-session', exactOrigin),
    ).resolves.toEqual({ success: true, metadataExists: false });
  });
});
