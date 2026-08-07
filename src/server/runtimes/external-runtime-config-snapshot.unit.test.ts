import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  metadata: undefined as Record<string, unknown> | undefined,
  data: undefined as { messages: unknown[] } | undefined,
}));

vi.mock('../SessionStore', () => ({
  getSessionMetadata: vi.fn(() => mocks.metadata),
  getSessionData: vi.fn(() => mocks.data),
  resolvePendingConversationMutation: vi.fn(async () => ({
    success: true,
    metadata: mocks.metadata,
    messages: mocks.data?.messages ?? [],
  })),
  loadSessionTranscript: vi.fn(async () => ({
    messages: mocks.data?.messages ?? [],
    cursor: { persistedMessageCount: mocks.data?.messages.length ?? 0 },
    hasMalformedRows: false,
  })),
  appendSessionMessages: vi.fn(),
  mutateSessionTranscript: vi.fn(),
  saveSessionMetadata: vi.fn(),
  updateSessionMetadata: vi.fn(),
}));

import {
  getExternalSessionModel,
  getExternalSessionPermissionMode,
  getExternalSessionReasoningEffort,
  restoreExternalSessionState,
  updateExternalRuntimeConfig,
} from './external-session';

const originalRuntime = process.env.MYAGENTS_RUNTIME;

describe('external runtime config snapshot guard', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.MYAGENTS_RUNTIME = 'codex';
    mocks.data = { messages: [] };
    mocks.metadata = {
      id: 'snapshot-session',
      runtime: 'codex',
      source: 'desktop',
      configSnapshotAt: '2026-06-21T00:00:00.000Z',
      model: 'snapshot-model',
      permissionMode: 'full-auto',
      reasoningEffort: 'high',
    };
    await restoreExternalSessionState('snapshot-session', '/workspace', { type: 'desktop' });
  });

  afterEach(() => {
    if (originalRuntime === undefined) {
      delete process.env.MYAGENTS_RUNTIME;
    } else {
      process.env.MYAGENTS_RUNTIME = originalRuntime;
    }
  });

  it('does not let IM runtime config sync mutate snapshotted desired state', async () => {
    const result = await updateExternalRuntimeConfig(
      {
        model: 'channel-model',
        permissionMode: 'full-auto',
        reasoningEffort: 'xhigh',
      },
      { source: 'im-sync' },
    );

    expect(result).toMatchObject({
      success: true,
      status: 'noop',
      warnings: ['snapshot-authoritative fields skipped: model,permissionMode,reasoningEffort'],
    });
    expect(getExternalSessionModel()).toBe('snapshot-model');
    expect(getExternalSessionPermissionMode()).toBe('full-auto');
    expect(getExternalSessionReasoningEffort()).toBe('high');
  });
});
