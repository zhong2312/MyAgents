import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig, Project } from '../types';

const state = vi.hoisted(() => ({
  config: undefined as unknown as AppConfig,
  projects: [] as Project[],
  events: [] as string[],
  failProjectsOnce: false,
  failConfigOnce: false,
  intentTail: Promise.resolve() as Promise<void>,
}));

vi.mock('./appConfigService', () => ({
  loadAppConfig: vi.fn(async () => state.config),
  atomicModifyConfig: vi.fn(async (modify: (config: AppConfig) => AppConfig) => {
    state.events.push('config');
    const next = modify(state.config);
    if (state.failConfigOnce) {
      state.failConfigOnce = false;
      throw new Error('config write interrupted');
    }
    state.config = next;
    return state.config;
  }),
  notifyConfigChanged: vi.fn(),
}));

vi.mock('./projectService', () => ({
  loadProjects: vi.fn(async () => state.projects),
  saveProjects: vi.fn(async (projects: Project[]) => {
    state.events.push('projects');
    if (state.failProjectsOnce) {
      state.failProjectsOnce = false;
      throw new Error('projects write interrupted');
    }
    state.projects = projects;
  }),
}));

vi.mock('./configStore', () => ({
  withProjectsLock: vi.fn(async <T>(run: () => Promise<T>) => run()),
  withAgentConfigIntentLock: vi.fn(async <T>(run: () => Promise<T>) => {
    let release!: () => void;
    const prior = state.intentTail;
    state.intentTail = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try {
      return await run();
    } finally {
      release();
    }
  }),
}));

import { reconcilePersistedAgentWorkspaceIdentities } from './agentConfigService';

function initialConfig(): AppConfig {
  return {
    defaultPermissionMode: 'auto',
    themeId: 'myagents-default',
    appearanceMode: 'system',
    minimizeToTray: true,
    showDevTools: false,
    autoStart: false,
    osNotifications: true,
    notificationSound: true,
    agents: [],
  };
}

function initialProject(): Project {
  return {
    id: 'project-1',
    name: 'Workspace',
    path: '/repo/current',
    providerId: null,
    permissionMode: null,
  };
}

describe('Renderer Project-first Agent reconciliation', () => {
  beforeEach(() => {
    state.config = initialConfig();
    state.projects = [initialProject()];
    state.events = [];
    state.failProjectsOnce = false;
    state.failConfigOnce = false;
    state.intentTail = Promise.resolve();
  });

  it('persists Project.agentId before creating a pathless Agent', async () => {
    const result = await reconcilePersistedAgentWorkspaceIdentities();

    expect(state.events).toEqual(['projects', 'config']);
    expect(result.projects[0].agentId).toBeTruthy();
    expect(result.config.agents?.map(agent => agent.id)).toEqual([result.projects[0].agentId]);
    expect(result.config.agents?.[0]).not.toHaveProperty('workspacePath');
  });

  it('does not create an Agent when the Project write is interrupted', async () => {
    state.failProjectsOnce = true;

    await expect(reconcilePersistedAgentWorkspaceIdentities())
      .rejects.toThrow('projects write interrupted');
    expect(state.projects[0].agentId).toBeUndefined();
    expect(state.config.agents).toEqual([]);
    expect(state.events).toEqual(['projects']);
  });

  it('reuses the persisted Project id after an interrupted Agent write', async () => {
    state.failConfigOnce = true;

    await expect(reconcilePersistedAgentWorkspaceIdentities())
      .rejects.toThrow('config write interrupted');
    const persistedAgentId = state.projects[0].agentId;
    expect(persistedAgentId).toBeTruthy();
    expect(state.config.agents).toEqual([]);

    const retried = await reconcilePersistedAgentWorkspaceIdentities();
    expect(retried.projects[0].agentId).toBe(persistedAgentId);
    expect(retried.config.agents?.map(agent => agent.id)).toEqual([persistedAgentId]);
  });

  it('serializes concurrent births to one Project link and one Agent record', async () => {
    const [first, second] = await Promise.all([
      reconcilePersistedAgentWorkspaceIdentities(),
      reconcilePersistedAgentWorkspaceIdentities(),
    ]);

    const persistedAgentId = state.projects[0].agentId;
    expect(persistedAgentId).toBeTruthy();
    expect(state.config.agents?.map(agent => agent.id)).toEqual([persistedAgentId]);
    expect(first.projects[0].agentId).toBe(persistedAgentId);
    expect(second.projects[0].agentId).toBe(persistedAgentId);
  });
});
