import { describe, expect, it } from 'vitest';

import { MANAGED_CODEX_REQUIRED_RUNTIME } from '@/config/types';

import {
    getManagedCodexRuntimePresentation,
    getManagedCodexUpdateRefreshAction,
} from './managedCodexRuntimePresentation';

describe('Managed Codex runtime presentation', () => {
    it('keeps the installed layout while a usable old runtime updates', () => {
        expect(getManagedCodexRuntimePresentation({
            status: 'downloading',
            usable: true,
            installedVersion: '0.143.0',
            requiredVersion: '0.144.1',
        }, null)).toEqual({
            runtimeUsable: true,
            isUpdatingRuntime: true,
            showDownloadRow: false,
        });
    });

    it('keeps the download row for a first install', () => {
        expect(getManagedCodexRuntimePresentation({
            status: 'downloading',
            usable: false,
            requiredVersion: '0.144.1',
        }, 'download')).toEqual({
            runtimeUsable: false,
            isUpdatingRuntime: false,
            showDownloadRow: true,
        });
    });

    it('shows updating immediately when an installed update command starts', () => {
        expect(getManagedCodexRuntimePresentation({
            status: 'update-required',
            usable: true,
            installedVersion: '0.143.0',
            requiredVersion: '0.144.1',
        }, 'download')).toEqual({
            runtimeUsable: true,
            isUpdatingRuntime: true,
            showDownloadRow: false,
        });
    });

    it('shows a ConfigProvider-owned startup update before disk status reaches downloading', () => {
        expect(getManagedCodexRuntimePresentation({
            status: 'update-required',
            usable: true,
            installedVersion: '0.143.0',
            requiredVersion: '0.144.1',
        }, null, true)).toEqual({
            runtimeUsable: true,
            isUpdatingRuntime: true,
            showDownloadRow: false,
        });
    });

    it('keeps a usable old runtime installed after an update failure', () => {
        expect(getManagedCodexRuntimePresentation({
            status: 'error',
            usable: true,
            installedVersion: '0.143.0',
            requiredVersion: '0.144.1',
            error: 'offline',
        }, null)).toEqual({
            runtimeUsable: true,
            isUpdatingRuntime: false,
            showDownloadRow: false,
        });
    });
});

describe('Managed Codex update refresh action', () => {
    it('reports an update already in progress without starting a duplicate', () => {
        expect(getManagedCodexUpdateRefreshAction({
            status: 'downloading',
            usable: true,
            installedVersion: '0.143.0',
        })).toBe('already-updating');
    });

    it('starts the App-locked update when the installed version is stale', () => {
        expect(getManagedCodexUpdateRefreshAction({
            status: 'update-required',
            usable: true,
            installedVersion: '0.143.0',
        })).toBe('start-update');
    });

    it('refreshes required signing metadata even when the version already matches', () => {
        expect(getManagedCodexUpdateRefreshAction({
            status: 'update-required',
            usable: false,
            installedVersion: '0.144.1',
            requiredVersion: '0.144.1',
        })).toBe('start-update');
    });

    it('retries a failed update even when the installed version already matches', () => {
        expect(getManagedCodexUpdateRefreshAction({
            status: 'error',
            usable: true,
            installedVersion: '0.144.1',
            requiredVersion: '0.144.1',
        })).toBe('start-update');
    });

    it('reports no update when the installed version matches the App lock', () => {
        expect(getManagedCodexUpdateRefreshAction({
            status: 'installed',
            usable: true,
            installedVersion: MANAGED_CODEX_REQUIRED_RUNTIME.version,
        })).toBe('no-update');
    });
});
