import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mode: 'disabled' as 'disabled' | 'deleted' | 'missing-key',
}));

vi.mock('./admin-config', () => ({
  findProvider: vi.fn((providerId: string) => (
    mocks.mode === 'deleted'
      ? undefined
      : { id: providerId, type: 'api_key' }
  )),
  isProviderDisabled: vi.fn(() => mocks.mode === 'disabled'),
  resolveProviderEnv: vi.fn(() => undefined),
}));

import { resolveTaskProviderRouting } from './task-provider-routing';

describe('Task provider routing recovery owner', () => {
  beforeEach(() => {
    mocks.mode = 'disabled';
  });

  it.each([
    [{ kind: 'task', taskId: 'task-1' } as const, "Task 'task-1'", 'myagents task update task-1 --providerId <providerId> --model <model>'],
    [{ kind: 'agent', agentId: 'agent-1' } as const, "Agent 'agent-1'", 'myagents agent set agent-1 providerId <providerId>'],
    [{ kind: 'session', sessionId: 'session-1' } as const, "Session 'session-1'", 'create a new Session'],
  ])('points a disabled provider at its %s owner', (owner, ownerText, recoveryText) => {
    expect(() => resolveTaskProviderRouting('provider-disabled', owner)).toThrow(ownerText);
    expect(() => resolveTaskProviderRouting('provider-disabled', owner)).toThrow(recoveryText);
  });

  it.each([
    ['deleted' as const, 'not found in config'],
    ['missing-key' as const, 'has no API Key'],
  ])('preserves the %s reason while pointing to the Task owner', (mode, reason) => {
    mocks.mode = mode;
    expect(() => resolveTaskProviderRouting('provider-broken', { kind: 'task', taskId: 'task-2' }))
      .toThrow(reason);
    expect(() => resolveTaskProviderRouting('provider-broken', { kind: 'task', taskId: 'task-2' }))
      .toThrow("Task 'task-2'");
  });
});
