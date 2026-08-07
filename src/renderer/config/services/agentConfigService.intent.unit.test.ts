import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig, Project } from '../types';

const state = vi.hoisted(() => ({
  config: undefined as unknown as AppConfig,
  project: undefined as unknown as Project,
  failProject: false,
  concurrentAgentName: undefined as string | undefined,
  events: [] as string[],
}));

const invokeMock = vi.hoisted(() => vi.fn(async () => {
  state.events.push('live');
}));

vi.mock('./appConfigService', () => ({
  loadAppConfig: vi.fn(async () => state.config),
  atomicModifyConfig: vi.fn(async (
    modify: (config: AppConfig) => AppConfig,
    options: { notification: 'immediate' | 'deferred' } = { notification: 'immediate' },
  ) => {
    state.events.push('agent-disk');
    state.config = modify(state.config);
    if (options.notification === 'immediate') state.events.push('config-notify');
    return state.config;
  }),
  notifyConfigChanged: vi.fn(() => {
    state.events.push('config-notify');
  }),
}));

vi.mock('./projectService', () => ({
  loadProjects: vi.fn(async () => [state.project]),
  patchProject: vi.fn(async (_projectId: string, patch: Partial<Project>) => {
    state.events.push('project-disk');
    if (state.concurrentAgentName && state.config.agents?.[0]) {
      state.config = {
        ...state.config,
        agents: [{ ...state.config.agents[0], name: state.concurrentAgentName }],
      };
    }
    if (state.failProject) throw new Error('project disk full');
    state.project = { ...state.project, ...patch };
    return state.project;
  }),
}));

vi.mock('./configStore', () => ({
  withAgentConfigIntentLock: vi.fn(async <T>(fn: () => Promise<T>) => {
    state.events.push('intent:start');
    try {
      return await fn();
    } finally {
      state.events.push('intent:end');
    }
  }),
}));

vi.mock('@/utils/browserMock', () => ({
  isTauriEnvironment: () => true,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { patchAgentConfig, patchAgentProjectConfig } from './agentConfigService';

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
    agents: [{
      id: 'agent-1',
      name: 'Agent',
      enabled: true,
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
      channels: [],
    }],
  };
}

describe('Agent/Project configuration intent ownership', () => {
  beforeEach(() => {
    state.config = initialConfig();
    state.project = {
      id: 'project-1',
      name: 'Agent',
      path: '/tmp/agent',
      agentId: 'agent-1',
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
    };
    state.failProject = false;
    state.concurrentAgentName = undefined;
    state.events = [];
    invokeMock.mockClear();
  });

  it('makes direct mirrored-field writers commit both authorities before live projection', async () => {
    await patchAgentConfig('agent-1', { model: 'claude-opus-4-6' });

    expect(state.events).toEqual([
      'intent:start',
      'agent-disk',
      'project-disk',
      'intent:end',
      'config-notify',
      'live',
    ]);
    expect(state.config.agents?.[0].model).toBe('claude-opus-4-6');
    expect(state.project.model).toBe('claude-opus-4-6');
  });

  it('preserves an old raw workspacePath while patching another Agent field', async () => {
    Object.assign(state.config.agents?.[0] ?? {}, { workspacePath: '/legacy/location' });

    await patchAgentConfig('agent-1', { model: 'claude-opus-4-6' });

    expect(state.config.agents?.[0]).toMatchObject({
      model: 'claude-opus-4-6',
      workspacePath: '/legacy/location',
    });
  });

  it('reconciles the proactive Memory task when the Agent master switch changes', async () => {
    await patchAgentConfig('agent-1', { enabled: false });

    expect(invokeMock).toHaveBeenCalledWith('cmd_configure_memory_auto_update_task', {
      request: expect.objectContaining({
        agentId: 'agent-1',
        workspacePath: '/tmp/agent',
      }),
    });
  });

  it('commits both disk stores before releasing the intent lock and hot-reloading', async () => {
    await patchAgentProjectConfig(
      'agent-1',
      { model: 'claude-opus-4-6' },
      'project-1',
      { model: 'claude-opus-4-6' },
    );

    expect(state.events).toEqual([
      'intent:start',
      'agent-disk',
      'project-disk',
      'intent:end',
      'config-notify',
      'live',
    ]);
    expect(state.config.agents?.[0].model).toBe('claude-opus-4-6');
    expect(state.project.model).toBe('claude-opus-4-6');
  });

  it('rolls back an automatically mirrored direct write when the Project save fails', async () => {
    state.failProject = true;

    await expect(patchAgentConfig(
      'agent-1',
      { model: 'claude-opus-4-6' },
    )).rejects.toThrow('Project mirror could not be saved');

    expect(state.config.agents?.[0].model).toBe('claude-sonnet-4-6');
    expect(state.project.model).toBe('claude-sonnet-4-6');
    expect(state.events).toEqual([
      'intent:start',
      'agent-disk',
      'project-disk',
      'agent-disk',
      'intent:end',
      'config-notify',
    ]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('rolls the Agent record back and skips live projection when the Project write fails', async () => {
    state.failProject = true;

    await expect(patchAgentProjectConfig(
      'agent-1',
      { model: 'claude-opus-4-6' },
      'project-1',
      { model: 'claude-opus-4-6' },
    )).rejects.toThrow('Project mirror could not be saved');

    expect(state.config.agents?.[0].model).toBe('claude-sonnet-4-6');
    expect(state.project.model).toBe('claude-sonnet-4-6');
    expect(state.events).toEqual([
      'intent:start',
      'agent-disk',
      'project-disk',
      'agent-disk',
      'intent:end',
      'config-notify',
    ]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('restores only committed fields and preserves an unrelated concurrent Agent update', async () => {
    state.failProject = true;
    state.concurrentAgentName = 'Renamed elsewhere';

    await expect(patchAgentProjectConfig(
      'agent-1',
      { model: 'claude-opus-4-6' },
      'project-1',
      { model: 'claude-opus-4-6' },
    )).rejects.toThrow('Project mirror could not be saved');

    expect(state.config.agents?.[0]).toMatchObject({
      name: 'Renamed elsewhere',
      model: 'claude-sonnet-4-6',
    });
  });
});
