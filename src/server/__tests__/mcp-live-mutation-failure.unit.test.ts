import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../tools/builtin-mcp-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools/builtin-mcp-registry')>();
  return {
    ...actual,
    getBuiltinMcpInstance: vi.fn(() => Promise.reject(new Error('builtin factory failed'))),
  };
});

import {
  ensureSdkMcpInSync,
  initializeAgent,
} from '../agent-session';
import {
  getQueryMcpPrewarmOwner,
  isAbortRequested,
  resetLifecycleForTest,
  setQueryMcpPrewarmOwner,
  setQuerySession,
} from '../builtin-session/lifecycle';
import {
  resetConfigForTest,
  setCurrentMcpServers,
  setFrozenSdkMcpFingerprint,
} from '../builtin-session/config';
import { resetQueueForTest } from '../builtin-session/queue';

describe('live Query MCP mutation recovery', () => {
  beforeEach(async () => {
    resetLifecycleForTest();
    resetQueueForTest();
    resetConfigForTest();
    await initializeAgent('/tmp/myagents-mcp-live-mutation-failure', null, undefined, {
      preWarmDisabled: true,
    });
  });

  it('invalidates and rebuilds the Query when MCP map construction rejects', async () => {
    const setMcpServers = vi.fn();
    const query = { setMcpServers } as never;
    setQuerySession(query);
    setQueryMcpPrewarmOwner({
      query,
      fingerprint: 'old',
      requiredServerIds: ['old'],
    });
    setFrozenSdkMcpFingerprint('old');
    setCurrentMcpServers([{
      id: 'factory-failure',
      name: 'factory-failure',
      isBuiltin: true,
      type: 'stdio',
      command: '__builtin__',
      args: [],
    }]);

    await ensureSdkMcpInSync();

    expect(isAbortRequested()).toBe(true);
    expect(getQueryMcpPrewarmOwner()).toBeNull();
    expect(setMcpServers).not.toHaveBeenCalled();
  });
});
