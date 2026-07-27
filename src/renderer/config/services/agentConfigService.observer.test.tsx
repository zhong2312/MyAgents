import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../types';

const observerState = vi.hoisted(() => ({
  notificationCountAtProjectWrite: -1,
  notifications: [] as string[],
  project: undefined as unknown as Project,
}));

vi.mock('./configStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./configStore')>();
  return {
    ...actual,
    withAgentConfigIntentLock: async <T,>(fn: () => Promise<T>) => fn(),
  };
});

vi.mock('./projectService', () => ({
  loadProjects: vi.fn(async () => [observerState.project]),
  patchProject: vi.fn(async (_projectId: string, patch: Partial<Project>) => {
    observerState.notificationCountAtProjectWrite = observerState.notifications.length;
    observerState.project = { ...observerState.project, ...patch };
    return observerState.project;
  }),
}));

vi.mock('@/utils/browserMock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/browserMock')>();
  return { ...actual, isTauriEnvironment: () => true };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));

import {
  atomicModifyConfig,
  CONFIG_CHANGED_EVENT,
} from './appConfigService';
import { patchAgentProjectConfig } from './agentConfigService';

describe('Agent/Project composite observer boundary', () => {
  const onConfigChanged = (event: Event) => {
    const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
    observerState.notifications.push(reason ?? 'unknown');
  };

  beforeEach(async () => {
    localStorage.clear();
    observerState.project = {
      id: 'project-1',
      name: 'Agent',
      path: '/tmp/agent',
      agentId: 'agent-1',
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
    };
    await atomicModifyConfig(config => ({
      ...config,
      agents: [{
        id: 'agent-1',
        name: 'Agent',
        workspacePath: '/tmp/agent',
        enabled: true,
        model: 'claude-sonnet-4-6',
        permissionMode: 'auto',
        channels: [],
      }],
    }));
    observerState.notificationCountAtProjectWrite = -1;
    observerState.notifications = [];
    window.addEventListener(CONFIG_CHANGED_EVENT, onConfigChanged);
  });

  afterEach(() => {
    window.removeEventListener(CONFIG_CHANGED_EVENT, onConfigChanged);
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('publishes one refresh only after both disk halves reach their final state', async () => {
    await patchAgentProjectConfig(
      'agent-1',
      { model: 'claude-opus-4-6' },
      'project-1',
      { model: 'claude-opus-4-6' },
    );

    expect(observerState.notificationCountAtProjectWrite).toBe(0);
    expect(observerState.notifications).toEqual(['patchAgentProjectConfig']);
    expect(observerState.project.model).toBe('claude-opus-4-6');
  });

  it('publishes the final refresh when only a stale Project mirror changes', async () => {
    observerState.project = { ...observerState.project, model: 'claude-opus-4-6' };
    await patchAgentProjectConfig(
      'agent-1',
      { model: 'claude-sonnet-4-6' },
      'project-1',
      { model: 'claude-sonnet-4-6' },
    );

    expect(observerState.notificationCountAtProjectWrite).toBe(0);
    expect(observerState.notifications).toEqual(['patchAgentProjectConfig']);
    expect(observerState.project.model).toBe('claude-sonnet-4-6');
  });
});
