import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigProvider } from './ConfigProvider';
import { DEFAULT_CONFIG, type AppConfig, type Project, type Provider } from './types';
import { useConfigData } from './useConfigData';
import { useConfigActions } from './useConfigActions';

const mocks = vi.hoisted(() => ({
  config: {} as AppConfig,
  projects: [] as Project[],
  providers: [] as Provider[],
  listeners: new Map<string, () => void>(),
  loadAppConfig: vi.fn(),
  loadProjects: vi.fn(),
  getAllProviders: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => true }));
vi.mock('@/utils/tauriListen', () => ({
  listenWithCleanup: vi.fn(async (event: string, handler: () => void) => {
    mocks.listeners.set(event, handler);
  }),
}));
vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(async () => ({ models: [] })) }));

vi.mock('./services/appConfigService', () => ({
  loadAppConfig: mocks.loadAppConfig,
  atomicModifyConfig: vi.fn(async (modify: (config: AppConfig) => AppConfig) => {
    mocks.config = modify(mocks.config);
    return mocks.config;
  }),
  ensureBundledWorkspace: vi.fn(async () => {}),
  ensureManagedCodexProviderDevGateDefault: vi.fn(async () => {}),
  mergePresetCustomModels: vi.fn((providers: Provider[]) => providers),
}));

vi.mock('./services/providerService', () => ({
  getAllProviders: mocks.getAllProviders,
  loadApiKeys: vi.fn(async () => ({})),
  saveApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  loadProviderVerifyStatus: vi.fn(async () => ({})),
  saveProviderVerifyStatus: vi.fn(),
  saveCustomProvider: vi.fn(),
  deleteCustomProvider: vi.fn(),
  rebuildAndPersistAvailableProviders: vi.fn(async () => {}),
}));

vi.mock('./services/projectService', () => ({
  loadProjects: mocks.loadProjects,
  saveProjects: vi.fn(async () => {}),
  addProject: vi.fn(),
  updateProject: vi.fn(),
  patchProject: vi.fn(),
  removeOrHideProject: vi.fn(),
  touchProject: vi.fn(),
}));

vi.mock('./services/agentConfigService', () => ({
  addAgentConfig: vi.fn(),
  buildAgentForProject: vi.fn(),
  configureMemoryAutoUpdateTaskForAgent: vi.fn(),
  configureMemoryEvolutionTasksForAgent: vi.fn(),
  ensureAllProjectsHaveAgent: vi.fn(() => ({ changed: false })),
  migrateImBotConfigsToAgents: vi.fn((config: AppConfig) => config),
  persistAgents: vi.fn(async () => {}),
}));

function provider(id: string): Provider {
  return {
    id,
    name: id,
    vendor: id,
    cloudProvider: '',
    type: 'api',
    primaryModel: `${id}-model`,
    isBuiltin: false,
    config: { baseUrl: 'https://provider.example' },
    authType: 'api_key',
    models: [{ model: `${id}-model`, modelName: `${id} model`, modelSeries: id }],
  };
}

function project(id: string, name: string, path: string): Project {
  return { id, name, path, providerId: null, permissionMode: null };
}

function Probe() {
  const { config, projects, providers, apiKeys, providerVerifyStatus } = useConfigData();
  const { updateConfig } = useConfigActions();
  return (
    <>
      <output data-testid="snapshot">
        {JSON.stringify({
          defaultProviderId: config.defaultProviderId,
          projects: projects.map(project => project.id),
          providers: providers.map(item => item.id),
          apiKeys: Object.keys(apiKeys),
          verified: Object.keys(providerVerifyStatus),
        })}
      </output>
      <button type="button" onClick={() => void updateConfig({ defaultProviderId: 'local-provider' })}>
        Save local config
      </button>
    </>
  );
}

describe('ConfigProvider external config invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.config = {
      ...DEFAULT_CONFIG,
      agents: [],
      defaultProviderId: 'old-provider',
      providerApiKeys: { 'old-provider': 'old-key' },
      providerVerifyStatus: {
        'old-provider': { status: 'valid', verifiedAt: '2026-07-23T00:00:00.000Z' },
      },
    };
    mocks.projects = [project('old-project', 'Old', '/old')];
    mocks.providers = [provider('old-provider')];
    mocks.loadAppConfig.mockImplementation(async () => mocks.config);
    mocks.loadProjects.mockImplementation(async () => mocks.projects);
    mocks.getAllProviders.mockImplementation(async () => mocks.providers);
  });

  it('reloads config, projects, providers, keys, and verify state from one app event', async () => {
    render(<ConfigProvider><Probe /></ConfigProvider>);

    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('old-provider'));
    await waitFor(() => expect(mocks.listeners.has('app:config-changed')).toBe(true));

    mocks.config = {
      ...DEFAULT_CONFIG,
      agents: [],
      defaultProviderId: 'new-provider',
      providerApiKeys: { 'new-provider': 'new-key' },
      providerVerifyStatus: {
        'new-provider': { status: 'valid', verifiedAt: '2026-07-23T01:00:00.000Z' },
      },
    };
    mocks.projects = [project('new-project', 'New', '/new')];
    mocks.providers = [provider('new-provider')];

    await act(async () => {
      mocks.listeners.get('app:config-changed')?.();
    });

    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('new-project'));
    const snapshot = JSON.parse(screen.getByTestId('snapshot').textContent ?? '{}') as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      defaultProviderId: 'new-provider',
      projects: ['new-project'],
      apiKeys: ['new-provider'],
      verified: ['new-provider'],
    });
    expect(snapshot.providers).toEqual(expect.arrayContaining(['new-provider']));
    expect(mocks.getAllProviders).toHaveBeenLastCalledWith(mocks.config);
  });

  it('does not let an older overlapping disk read overwrite a newer event', async () => {
    render(<ConfigProvider><Probe /></ConfigProvider>);
    await waitFor(() => expect(mocks.listeners.has('app:config-changed')).toBe(true));
    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('old-project'));

    const slowConfig: AppConfig = {
      ...DEFAULT_CONFIG,
      agents: [],
      defaultProviderId: 'slow-provider',
      providerApiKeys: { 'slow-provider': 'slow-key' },
    };
    let resolveSlow: ((config: AppConfig) => void) | undefined;
    const slowRead = new Promise<AppConfig>(resolve => { resolveSlow = resolve; });
    const loadCountBefore = mocks.loadAppConfig.mock.calls.length;
    mocks.loadAppConfig.mockImplementationOnce(async () => slowRead);

    act(() => { mocks.listeners.get('app:config-changed')?.(); });
    await waitFor(() => expect(mocks.loadAppConfig.mock.calls.length).toBe(loadCountBefore + 1));

    mocks.config = {
      ...DEFAULT_CONFIG,
      agents: [],
      defaultProviderId: 'latest-provider',
      providerApiKeys: { 'latest-provider': 'latest-key' },
    };
    mocks.projects = [project('latest-project', 'Latest', '/latest')];
    mocks.providers = [provider('latest-provider')];
    await act(async () => { mocks.listeners.get('app:config-changed')?.(); });
    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('latest-project'));

    await act(async () => { resolveSlow?.(slowConfig); });
    expect(screen.getByTestId('snapshot')).toHaveTextContent('latest-provider');
    expect(screen.getByTestId('snapshot')).not.toHaveTextContent('slow-provider');
  });

  it('does not let an older external read overwrite a newer local disk commit', async () => {
    render(<ConfigProvider><Probe /></ConfigProvider>);
    await waitFor(() => expect(mocks.listeners.has('app:config-changed')).toBe(true));
    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('old-project'));

    const staleConfig: AppConfig = {
      ...DEFAULT_CONFIG,
      agents: [],
      defaultProviderId: 'stale-external-provider',
    };
    let resolveStale: ((config: AppConfig) => void) | undefined;
    const staleRead = new Promise<AppConfig>(resolve => { resolveStale = resolve; });
    const loadCountBefore = mocks.loadAppConfig.mock.calls.length;
    mocks.loadAppConfig.mockImplementationOnce(async () => staleRead);

    act(() => { mocks.listeners.get('app:config-changed')?.(); });
    await waitFor(() => expect(mocks.loadAppConfig.mock.calls.length).toBe(loadCountBefore + 1));

    fireEvent.click(screen.getByRole('button', { name: 'Save local config' }));
    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('local-provider'));

    await act(async () => { resolveStale?.(staleConfig); });
    expect(screen.getByTestId('snapshot')).toHaveTextContent('local-provider');
    expect(screen.getByTestId('snapshot')).not.toHaveTextContent('stale-external-provider');
  });
});
