import { describe, expect, it, vi } from 'vitest';

import { materializePendingSessionConfig, type MaterializePostBody } from '../sessionMaterialize';

const metadata = {
  id: 'real-session',
  agentDir: '/tmp/workspace',
  title: 'New Chat',
  createdAt: '2026-06-23T00:00:00.000Z',
  lastActiveAt: '2026-06-23T00:00:00.000Z',
};

function makeTransport() {
  return {
    postCurrent: vi.fn(async (body: MaterializePostBody) => {
      if (body.phase === 'prepare') return { success: true, sessionId: 'real-session', metadata };
      if (body.phase === 'rollback') return { success: true };
      return { success: false, error: `unexpected current ${body.phase}` };
    }),
    postForSession: vi.fn(async (_sessionId: string, body: MaterializePostBody) => {
      if (body.phase === 'commit') return { success: true, sessionId: 'real-session', metadata };
      if (body.phase === 'rollback') return { success: true };
      return { success: false, error: `unexpected target ${body.phase}` };
    }),
    upgradeSessionId: vi.fn(async () => true),
  };
}

describe('materializePendingSessionConfig', () => {
  it('prepares, upgrades Rust, commits through the prepared session id, and returns metadata', async () => {
    const transport = makeTransport();

    const result = await materializePendingSessionConfig({
      pendingSessionId: 'pending-tab-1',
      tabId: 'tab-1',
      workspacePath: '/tmp/workspace',
      snapshotPatch: { permissionMode: 'fullAgency' },
      transport,
    });

    expect(result).toEqual({ sessionId: 'real-session', metadata });
    expect(transport.postCurrent).toHaveBeenCalledWith({
      workspacePath: '/tmp/workspace',
      phase: 'prepare',
      snapshotPatch: { permissionMode: 'fullAgency' },
    });
    expect(transport.upgradeSessionId).toHaveBeenNthCalledWith(1, 'pending-tab-1', 'real-session', 'tab-1');
    expect(transport.postForSession).toHaveBeenCalledWith('real-session', {
      workspacePath: '/tmp/workspace',
      phase: 'commit',
      preparedSessionId: 'real-session',
    });
  });

  it('rolls back prepared metadata and stops before commit when Rust upgrade fails', async () => {
    const transport = makeTransport();
    transport.upgradeSessionId.mockResolvedValueOnce(false);

    await expect(materializePendingSessionConfig({
      pendingSessionId: 'pending-tab-1',
      tabId: 'tab-1',
      workspacePath: '/tmp/workspace',
      snapshotPatch: { model: 'model-a' },
      transport,
    })).rejects.toThrow('Failed to upgrade sidecar session id');

    expect(transport.postCurrent).toHaveBeenLastCalledWith({
      workspacePath: '/tmp/workspace',
      phase: 'rollback',
      preparedSessionId: 'real-session',
    });
    expect(transport.postForSession).not.toHaveBeenCalled();
  });

  it('rolls back target metadata and Rust key when commit fails after Rust upgrade', async () => {
    const transport = makeTransport();
    transport.postForSession.mockResolvedValueOnce({ success: false, error: 'commit failed' });

    await expect(materializePendingSessionConfig({
      pendingSessionId: 'pending-tab-1',
      tabId: 'tab-1',
      workspacePath: '/tmp/workspace',
      snapshotPatch: { model: 'model-a' },
      transport,
    })).rejects.toThrow('commit failed');

    expect(transport.postForSession).toHaveBeenLastCalledWith('real-session', {
      workspacePath: '/tmp/workspace',
      phase: 'rollback',
      preparedSessionId: 'real-session',
    });
    expect(transport.upgradeSessionId).toHaveBeenNthCalledWith(2, 'real-session', 'pending-tab-1', 'tab-1');
  });
});
