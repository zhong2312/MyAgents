import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cancellableFetch: vi.fn(),
  resolvePersistedAgentWorkspaceRegistry: vi.fn(),
  agentWorkspaceIdentityFailure: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  })),
  getSessionMetadata: vi.fn(),
}));

vi.mock('../utils/cancellation', () => ({ cancellableFetch: mocks.cancellableFetch }));
vi.mock('../utils/agent-workspace-identity', () => ({
  resolvePersistedAgentWorkspaceRegistry: mocks.resolvePersistedAgentWorkspaceRegistry,
  agentWorkspaceIdentityFailure: mocks.agentWorkspaceIdentityFailure,
}));
vi.mock('../SessionStore', () => ({ getSessionMetadata: mocks.getSessionMetadata }));

import { handleAdminSessionStart } from './start-admin-handler';

function registry(archived = false) {
  const identity = {
    agentId: 'agent-1',
    workspacePath: '/target/workspace',
    agent: { id: 'agent-1', name: 'Target', enabled: false },
    projectId: 'project-1',
    association: 'project-linked',
    canMutateProjectLifecycle: true,
    project: {
      id: 'project-1',
      name: 'Target',
      path: '/target/workspace',
      agentId: 'agent-1',
      ...(archived ? { archivedAt: '2026-08-01T00:00:00.000Z' } : {}),
    },
  };
  return {
    identities: [identity],
    agentProjections: [identity],
    diagnostics: [],
  };
}

describe('handleAdminSessionStart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MYAGENTS_MANAGEMENT_PORT = '43123';
    mocks.resolvePersistedAgentWorkspaceRegistry.mockResolvedValue(registry());
    mocks.getSessionMetadata.mockReturnValue({ title: 'Source chat', agentDir: '/source' });
  });

  it('returns a non-blocking accepted receipt from Rust admission', async () => {
    mocks.cancellableFetch.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      outcome: {
        status: 'accepted',
        agentId: 'agent-1',
        sessionId: 'fresh-session',
        messageId: 'message-1',
        replyBack: true,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Review this',
      replyBack: true,
    });

    expect(result).toEqual({
      status: 200,
      response: {
        accepted: true,
        asynchronous: true,
        agentId: 'agent-1',
        sessionId: 'fresh-session',
        messageId: 'message-1',
        replyBack: true,
        resultDelivery: 'send.result',
      },
    });
    expect(mocks.cancellableFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:43123/api/inbox/start-session',
      expect.objectContaining({
        method: 'POST',
        body: expect.not.stringContaining('birthFingerprint'),
      }),
      { timeoutMs: 180_000 },
    );
  });

  it('preserves IDs and warns against automatic retry when admission is unconfirmed', async () => {
    mocks.cancellableFetch.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      outcome: {
        status: 'unconfirmed',
        agentId: 'agent-1',
        sessionId: 'fresh-session',
        messageId: 'message-1',
        replyBack: true,
        reason: 'ACK lost',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Review this',
    });

    expect(result.status).toBe(502);
    expect(result.response).toMatchObject({
      accepted: null,
      unconfirmed: true,
      sessionId: 'fresh-session',
      messageId: 'message-1',
      error: { code: 'admission_unconfirmed' },
      recoveryHint: {
        recoveryCommand: 'myagents session list --agent agent-1',
        message: expect.stringContaining('do not automatically resend'),
      },
    });
  });

  it('rejects caller configuration overrides before delivery', async () => {
    const result = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Review this',
      runtime: 'builtin',
    });

    expect(result).toMatchObject({
      status: 400,
      response: { error: { code: 'target_config_override_forbidden' } },
    });
    expect(mocks.cancellableFetch).not.toHaveBeenCalled();
  });

  it('requires a source Session and rejects archived targets', async () => {
    const missingSource = await handleAdminSessionStart('', {
      agentId: 'agent-1',
      prompt: 'Review this',
    });
    expect(missingSource.response).toMatchObject({
      error: { code: 'caller_session_required' },
    });

    mocks.resolvePersistedAgentWorkspaceRegistry.mockResolvedValue(registry(true));
    const archived = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Review this',
    });
    expect(archived.response).toMatchObject({ error: { code: 'agent_archived' } });
    expect(mocks.cancellableFetch).not.toHaveBeenCalled();
  });
});
