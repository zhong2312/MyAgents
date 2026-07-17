import { describe, expect, it, vi } from 'vitest';
import {
  MCP_PREWARM_GRACE_MS,
  awaitMcpPrewarm,
  classifyMcpPrewarmStatuses,
  type McpPrewarmOwner,
  type McpServerStatusSnapshot,
} from './mcp-prewarm-policy';

describe('MCP soft pre-warm policy', () => {
  it('keeps the grace budget in one policy constant', () => {
    expect(MCP_PREWARM_GRACE_MS).toBe(10_000);
  });

  it.each([
    {
      name: 'connected',
      statuses: [{ name: 'fs', status: 'connected' }],
      expected: { state: 'ready' },
    },
    {
      name: 'pending',
      statuses: [{ name: 'fs', status: 'pending' }],
      expected: {
        state: 'pending',
        pendingServers: [{ id: 'fs', status: 'pending' }],
        degradedServers: [],
      },
    },
    {
      name: 'failed',
      statuses: [{ name: 'fs', status: 'failed', error: 'spawn failed' }],
      expected: {
        state: 'degraded',
        servers: [{ id: 'fs', status: 'failed', error: 'spawn failed' }],
      },
    },
    {
      name: 'needs auth',
      statuses: [{ name: 'fs', status: 'needs-auth' }],
      expected: { state: 'degraded', servers: [{ id: 'fs', status: 'needs-auth' }] },
    },
    {
      name: 'disabled',
      statuses: [{ name: 'fs', status: 'disabled' }],
      expected: { state: 'degraded', servers: [{ id: 'fs', status: 'disabled' }] },
    },
    {
      name: 'missing',
      statuses: [],
      expected: { state: 'degraded', servers: [{ id: 'fs' }] },
    },
  ] satisfies Array<{
    name: string;
    statuses: McpServerStatusSnapshot[];
    expected: unknown;
  }>)('classifies $name without creating a failure result', ({ statuses, expected }) => {
    expect(classifyMcpPrewarmStatuses(['fs'], statuses)).toEqual(expected);
  });

  it('waits only for pending servers while preserving terminal degraded details', () => {
    expect(classifyMcpPrewarmStatuses(['ready', 'slow', 'broken'], [
      { name: 'ready', status: 'connected' },
      { name: 'slow', status: 'pending' },
      { name: 'broken', status: 'failed', error: 'stdio exited' },
    ])).toEqual({
      state: 'pending',
      pendingServers: [{ id: 'slow', status: 'pending' }],
      degradedServers: [{ id: 'broken', status: 'failed', error: 'stdio exited' }],
    });
  });

  function owner(params: {
    statuses: () => Promise<readonly McpServerStatusSnapshot[]>;
    identity?: object;
    generation?: number;
    revision?: number;
    startedAt?: number;
    deadlineAt?: number;
    ids?: string[];
  }): McpPrewarmOwner {
    return {
      identity: params.identity ?? {},
      generation: params.generation ?? 1,
      revision: params.revision ?? 1,
      fingerprint: (params.ids ?? ['fs']).join(','),
      requiredServerIds: params.ids ?? ['fs'],
      startedAt: params.startedAt ?? 0,
      deadlineAt: params.deadlineAt ?? MCP_PREWARM_GRACE_MS,
      readStatuses: params.statuses,
    };
  }

  it('returns as soon as a pending server connects', async () => {
    let clock = 1_000;
    let reads = 0;
    const current = owner({
      statuses: async () => [{
        name: 'fs',
        status: ++reads === 1 ? 'pending' : 'connected',
      }],
    });

    const result = await awaitMcpPrewarm({
      owner: current,
      getOwner: () => current,
      now: () => clock,
      sleep: async ms => { clock += ms; },
    });

    expect(result).toEqual({ state: 'ready', elapsedMs: 1_250 });
    expect(reads).toBe(2);
  });

  it('consumes only the remaining owner-created absolute budget', async () => {
    let clock = 7_000;
    const current = owner({
      startedAt: 0,
      deadlineAt: 10_000,
      statuses: async () => [{ name: 'fs', status: 'pending' }],
    });

    const result = await awaitMcpPrewarm({
      owner: current,
      getOwner: () => current,
      now: () => clock,
      sleep: async ms => { clock += ms; },
    });

    expect(clock).toBe(10_000);
    expect(result).toEqual({
      state: 'degraded',
      reason: 'timeout',
      servers: [{ id: 'fs', status: 'pending' }],
      elapsedMs: 10_000,
    });
  });

  it('does not poll after a terminal status', async () => {
    const sleep = vi.fn(async () => undefined);
    const current = owner({
      statuses: async () => [{ name: 'fs', status: 'failed', error: 'boom' }],
    });

    await expect(awaitMcpPrewarm({
      owner: current,
      getOwner: () => current,
      now: () => 500,
      sleep,
    })).resolves.toEqual({
      state: 'degraded',
      reason: 'terminal_status',
      servers: [{ id: 'fs', status: 'failed', error: 'boom' }],
      elapsedMs: 500,
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits for pending peers before settling a mixed generation degraded', async () => {
    let clock = 0;
    let reads = 0;
    const current = owner({
      ids: ['slow', 'broken'],
      statuses: async () => {
        reads += 1;
        return [
          { name: 'slow', status: reads === 1 ? 'pending' : 'connected' },
          { name: 'broken', status: 'failed', error: 'boom' },
        ];
      },
    });

    await expect(awaitMcpPrewarm({
      owner: current,
      getOwner: () => current,
      now: () => clock,
      sleep: async ms => { clock += ms; },
    })).resolves.toEqual({
      state: 'degraded',
      reason: 'terminal_status',
      servers: [{ id: 'broken', status: 'failed', error: 'boom' }],
      elapsedMs: 250,
    });
    expect(reads).toBe(2);
  });

  it('never accepts a status response from a replaced owner', async () => {
    let release!: (statuses: McpServerStatusSnapshot[]) => void;
    const oldOwner = owner({ statuses: () => new Promise(resolve => { release = resolve; }) });
    const replacement = owner({
      generation: 2,
      statuses: async () => [{ name: 'fs', status: 'connected' }],
    });
    let current: McpPrewarmOwner | null = oldOwner;
    const result = awaitMcpPrewarm({
      owner: oldOwner,
      getOwner: () => current,
      now: () => 500,
    });
    await Promise.resolve();
    current = replacement;
    release([{ name: 'fs', status: 'connected' }]);

    await expect(result).resolves.toEqual({
      state: 'owner_replaced',
      servers: [{ id: 'fs' }],
      elapsedMs: 500,
    });
  });

  it('cancels an in-flight status read immediately', async () => {
    const controller = new AbortController();
    const current = owner({ statuses: () => new Promise(() => undefined) });
    const result = awaitMcpPrewarm({
      owner: current,
      getOwner: () => current,
      now: () => 500,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    await expect(result).rejects.toThrow('MCP pre-warm wait cancelled');
  });

  it('degrades a status-read error and keeps the turn dispatchable', async () => {
    const current = owner({ statuses: async () => { throw new Error('control pipe closed'); } });

    await expect(awaitMcpPrewarm({
      owner: current,
      getOwner: () => current,
      now: () => 600,
    })).resolves.toEqual({
      state: 'degraded',
      reason: 'status_read_failed',
      servers: [{ id: 'fs', error: 'control pipe closed' }],
      elapsedMs: 600,
    });
  });

  it('treats an empty installed MCP map as immediately ready', async () => {
    const current = owner({ ids: [], statuses: async () => [] });
    await expect(awaitMcpPrewarm({
      owner: current,
      getOwner: () => current,
      now: () => 100,
    })).resolves.toEqual({ state: 'ready', elapsedMs: 100 });
  });
});
