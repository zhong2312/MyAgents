import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from './types';
import { ConfigProvider } from './ConfigProvider';
import { useConfigActions } from './useConfigActions';
import { useConfigData } from './useConfigData';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    loadAppConfig: vi.fn(),
    loadProjects: vi.fn(),
    statusPromise: undefined as Promise<void> | undefined,
    resolveStatus: undefined as (() => void) | undefined,
    downloadPromise: undefined as Promise<never> | undefined,
    rejectDownload: undefined as ((error: Error) => void) | undefined,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => true }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn(async () => {}) }));
vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(async () => ({ models: [] })) }));
vi.mock('./services/configStore', () => ({
    isLockBusyError: (error: unknown) => (
        !!error && typeof error === 'object' && 'code' in error && String(error.code).endsWith('BUSY')
    ),
    withAgentConfigIntentLock: vi.fn(async <T,>(run: () => Promise<T>) => run()),
    withProjectsLock: vi.fn(async <T,>(run: () => Promise<T>) => run()),
}));

vi.mock('./services/appConfigService', () => ({
    loadAppConfig: mocks.loadAppConfig,
    atomicModifyConfig: vi.fn(async (modify: (config: object) => object) => modify({})),
    ensureBundledWorkspace: vi.fn(async () => {}),
    ensureManagedCodexProviderDevGateDefault: vi.fn(async () => {}),
    mergePresetCustomModels: vi.fn((providers: unknown[]) => providers),
}));

vi.mock('./services/providerService', () => ({
    getAllProviders: vi.fn(async () => []),
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
    configureMemoryAutoUpdateTaskForAgent: vi.fn(),
    configureMemoryEvolutionTasksForAgent: vi.fn(),
    migrateImBotConfigsToAgents: vi.fn((config: object) => config),
    persistAgents: vi.fn(async () => {}),
    reconcilePersistedAgentWorkspaceIdentities: vi.fn(async () => ({
        config: {}, projects: [], changed: false, createdAgents: [],
    })),
    reconcilePersistedAgentWorkspaceIdentitiesLocked: vi.fn(),
}));

describe('ConfigProvider Managed Codex startup update lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.loadProjects.mockResolvedValue([]);
        mocks.loadAppConfig.mockImplementation(async () => ({
            ...DEFAULT_CONFIG,
            agents: [],
            managedCodexProviderDevGate: true,
            managedCodexRuntimeInstall: {
                status: 'error',
                usable: true,
                installedVersion: '0.0.0-previous',
            },
            managedCodexAuth: {
                status: 'valid',
                authMethod: 'chatgpt',
            },
        }));
        mocks.statusPromise = new Promise<void>(resolve => {
            mocks.resolveStatus = resolve;
        });
        mocks.downloadPromise = new Promise<never>((_, reject) => {
            mocks.rejectDownload = reject;
        });
        mocks.invoke.mockImplementation(async (command: string) => {
            if (command === 'cmd_managed_codex_status') {
                return mocks.statusPromise;
            }
            if (command === 'cmd_managed_codex_download') {
                return mocks.downloadPromise;
            }
            return undefined;
        });
    });

    function UpdateStateProbe() {
        const { managedCodexRuntimeUpdateInFlight } = useConfigData();
        const { requestManagedCodexRuntimeUpdate } = useConfigActions();
        return (
            <>
                <div data-testid="managed-codex-update-in-flight">
                    {String(managedCodexRuntimeUpdateInFlight)}
                </div>
                <button
                    type="button"
                    onClick={() => void requestManagedCodexRuntimeUpdate().catch(() => {})}
                >
                    request update
                </button>
            </>
        );
    }

    it('attempts once per App module, without looping after refresh or React remount', async () => {
        const first = render(<ConfigProvider><UpdateStateProbe /></ConfigProvider>);

        await waitFor(() => expect(screen.getByTestId('managed-codex-update-in-flight')).toHaveTextContent('true'));
        expect(mocks.invoke.mock.calls.filter(([command]) => (
            command === 'cmd_managed_codex_download'
        ))).toHaveLength(0);
        fireEvent.click(screen.getByRole('button', { name: 'request update' }));
        expect(mocks.invoke.mock.calls.filter(([command]) => (
            command === 'cmd_managed_codex_download'
        ))).toHaveLength(0);

        mocks.resolveStatus?.();
        await waitFor(() => {
            expect(mocks.invoke.mock.calls.filter(([command]) => (
                command === 'cmd_managed_codex_download'
            ))).toHaveLength(1);
        });
        const invokedCommands = mocks.invoke.mock.calls.map(([command]) => command);
        expect(invokedCommands.indexOf('cmd_managed_codex_status'))
            .toBeLessThan(invokedCommands.indexOf('cmd_managed_codex_download'));

        first.unmount();
        const loadsBeforeRemount = mocks.loadAppConfig.mock.calls.length;
        render(<ConfigProvider><UpdateStateProbe /></ConfigProvider>);
        await waitFor(() => expect(screen.getByTestId('managed-codex-update-in-flight')).toHaveTextContent('true'));
        fireEvent.click(screen.getByRole('button', { name: 'request update' }));
        expect(mocks.invoke.mock.calls.filter(([command]) => (
            command === 'cmd_managed_codex_download'
        ))).toHaveLength(1);

        mocks.rejectDownload?.(new Error('offline'));
        await waitFor(() => expect(screen.getByTestId('managed-codex-update-in-flight')).toHaveTextContent('false'));
        await waitFor(() => expect(mocks.loadAppConfig.mock.calls.length).toBeGreaterThanOrEqual(3));
        expect(mocks.invoke.mock.calls.filter(([command]) => (
            command === 'cmd_managed_codex_download'
        ))).toHaveLength(1);

        await waitFor(() => expect(mocks.loadAppConfig.mock.calls.length).toBeGreaterThan(loadsBeforeRemount));
        expect(mocks.invoke.mock.calls.filter(([command]) => (
            command === 'cmd_managed_codex_download'
        ))).toHaveLength(1);
    });
});
