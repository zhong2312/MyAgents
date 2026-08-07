import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminAppConfig, ProjectSlim } from './admin-config';

const state = vi.hoisted(() => ({
  config: { defaultPermissionMode: 'auto', agents: [] } as AdminAppConfig,
  projects: [] as ProjectSlim[],
  writes: [] as string[],
  failProjectOnce: false,
  failConfigOnce: false,
  lockTail: Promise.resolve() as Promise<void>,
}));

vi.mock('../sse', () => ({ broadcast: vi.fn() }));
vi.mock('./admin-config', async importOriginal => {
  const actual = await importOriginal<typeof import('./admin-config')>();
  return {
    ...actual,
    loadConfig: vi.fn(() => state.config),
    loadProjects: vi.fn(() => state.projects),
    withAgentConfigIntentLock: vi.fn(async (run: () => Promise<unknown>) => {
      let release!: () => void;
      const prior = state.lockTail;
      state.lockTail = new Promise<void>(resolve => { release = resolve; });
      await prior;
      try {
        return await run();
      } finally {
        release();
      }
    }),
    atomicModifyProjects: vi.fn(async (modify: (projects: ProjectSlim[]) => ProjectSlim[]) => {
      state.writes.push('projects');
      if (state.failProjectOnce) {
        state.failProjectOnce = false;
        throw new Error('projects write interrupted');
      }
      state.projects = modify(state.projects);
      return state.projects;
    }),
    atomicModifyConfig: vi.fn(async (modify: (config: AdminAppConfig) => AdminAppConfig) => {
      state.writes.push('config');
      if (state.failConfigOnce) {
        state.failConfigOnce = false;
        throw new Error('config write interrupted');
      }
      state.config = modify(state.config);
      return state.config;
    }),
  };
});

import { resolvePersistedAgentWorkspaceRegistry } from './agent-workspace-identity';

function project(overrides: Partial<ProjectSlim> = {}): ProjectSlim {
  return {
    id: 'project-1',
    name: 'Workspace',
    path: '/repo/current',
    ...overrides,
  };
}

describe('persisted Agent workspace identity', () => {
  beforeEach(() => {
    state.config = { defaultPermissionMode: 'auto', agents: [] };
    state.projects = [project()];
    state.writes = [];
    state.failProjectOnce = false;
    state.failConfigOnce = false;
    state.lockTail = Promise.resolve();
  });

  it('commits Project.agentId before creating the pathless Agent record', async () => {
    const result = await resolvePersistedAgentWorkspaceRegistry();

    expect(state.writes).toEqual(['projects', 'config']);
    expect(result.projects[0].agentId).toBeTruthy();
    expect(result.config.agents).toEqual([
      expect.objectContaining({ id: result.projects[0].agentId, name: 'Workspace' }),
    ]);
    expect(result.config.agents?.[0]).not.toHaveProperty('workspacePath');
    expect(result.agentProjections[0]).toMatchObject({
      agentId: result.projects[0].agentId,
      workspacePath: '/repo/current',
      association: 'project-linked',
    });
  });

  it('rebuilds a stale Project link with the same id after an interrupted Agent write', async () => {
    state.projects = [project({ agentId: 'stale-agent-id' })];

    const result = await resolvePersistedAgentWorkspaceRegistry();

    expect(result.config.agents?.map(agent => agent.id)).toEqual(['stale-agent-id']);
    expect(result.projects[0].agentId).toBe('stale-agent-id');
  });

  it('recovers a Project-first birth after the Agent write is interrupted', async () => {
    state.failConfigOnce = true;

    const interrupted = await resolvePersistedAgentWorkspaceRegistry();
    const persistedAgentId = state.projects[0].agentId;
    expect(persistedAgentId).toBeTruthy();
    expect(state.config.agents).toEqual([]);
    expect(interrupted.repairDeferred).toBe(true);
    expect(interrupted.agentProjections).toEqual([]);

    const retried = await resolvePersistedAgentWorkspaceRegistry();
    expect(retried.projects[0].agentId).toBe(persistedAgentId);
    expect(retried.config.agents?.map(agent => agent.id)).toEqual([persistedAgentId]);
  });

  it('keeps a deterministic legacy match usable when Project repair persistence is deferred', async () => {
    state.projects = [project()];
    state.config = {
      defaultPermissionMode: 'auto',
      agents: [{
        id: 'legacy-agent',
        name: 'Legacy',
        enabled: true,
        workspacePath: '/repo/current',
      } as unknown as NonNullable<AdminAppConfig['agents']>[number]],
    };
    state.failProjectOnce = true;

    const result = await resolvePersistedAgentWorkspaceRegistry();

    expect(result.repairDeferred).toBe(true);
    expect(result.projects[0].agentId).toBe('legacy-agent');
    expect(result.agentProjections).toContainEqual(expect.objectContaining({
      agentId: 'legacy-agent',
      workspacePath: '/repo/current',
    }));
    expect(state.projects[0].agentId).toBeUndefined();
  });

  it('does not create an Agent when the Project link write is interrupted', async () => {
    state.failProjectOnce = true;

    await expect(resolvePersistedAgentWorkspaceRegistry())
      .rejects.toThrow('projects write interrupted');
    expect(state.projects[0].agentId).toBeUndefined();
    expect(state.config.agents).toEqual([]);
  });

  it('serializes concurrent births to one Project link and one Agent id', async () => {
    const [first, second] = await Promise.all([
      resolvePersistedAgentWorkspaceRegistry(),
      resolvePersistedAgentWorkspaceRegistry(),
    ]);

    const persistedAgentId = state.projects[0].agentId;
    expect(persistedAgentId).toBeTruthy();
    expect(state.config.agents?.map(agent => agent.id)).toEqual([persistedAgentId]);
    expect(first.projects[0].agentId).toBe(persistedAgentId);
    expect(second.projects[0].agentId).toBe(persistedAgentId);
  });

  it('keeps an exact id link authoritative when its historical path disagrees', async () => {
    state.projects = [project({ agentId: 'selected' })];
    state.config = {
      defaultPermissionMode: 'auto',
      agents: [{
        id: 'selected',
        name: 'Selected',
        enabled: true,
        workspacePath: '/repo/old',
      } as unknown as NonNullable<AdminAppConfig['agents']>[number]],
    };

    const result = await resolvePersistedAgentWorkspaceRegistry();

    expect(result.agentProjections[0]).toMatchObject({
      agentId: 'selected',
      workspacePath: '/repo/current',
    });
    expect(result.createdAgentIds).toEqual([]);
  });
});
