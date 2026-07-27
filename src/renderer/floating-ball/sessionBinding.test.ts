import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/config/types';

const mocks = vi.hoisted(() => {
    let config: AppConfig;
    const invoke = vi.fn(async () => undefined);
    const setConfig = (next: AppConfig) => {
        config = next;
    };
    const getConfig = () => config;
    return {
        invoke,
        setConfig,
        getConfig,
        atomicModifyConfig: vi.fn(async (modifier: (config: AppConfig) => AppConfig) => {
            config = modifier(config);
            return config;
        }),
    };
});

vi.mock('@tauri-apps/api/core', () => ({
    invoke: mocks.invoke,
}));

vi.mock('@/utils/browserMock', () => ({
    isTauriEnvironment: () => true,
}));

vi.mock('@/config/services/appConfigService', () => ({
    atomicModifyConfig: mocks.atomicModifyConfig,
}));

import {
    migrateFloatingBallSessionBinding,
    migrateFloatingBallSessionConfig,
} from './sessionBinding';

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
        defaultPermissionMode: 'auto',
        themeId: 'myagents-default',
        appearanceMode: 'system',
        minimizeToTray: false,
        showDevTools: false,
        ...overrides,
    } as AppConfig;
}

describe('floating ball session binding migration', () => {
    beforeEach(() => {
        mocks.invoke.mockClear();
        mocks.atomicModifyConfig.mockClear();
        mocks.setConfig(baseConfig());
    });

    it('rewrites the stored floating-ball session id without touching workspace/date identity', () => {
        const current = baseConfig({
            floatingBallSessionId: 'old',
            floatingBallSessionDate: '2026-06-14',
            floatingBallSessionWorkspace: '/workspace/mino',
        });

        const next = migrateFloatingBallSessionConfig(current, 'old', 'new');

        expect(next).not.toBe(current);
        expect(next.floatingBallSessionId).toBe('new');
        expect(next.floatingBallSessionDate).toBe('2026-06-14');
        expect(next.floatingBallSessionWorkspace).toBe('/workspace/mino');
    });

    it('does nothing when the stored binding points at another session', () => {
        const current = baseConfig({ floatingBallSessionId: 'someone-else' });

        expect(migrateFloatingBallSessionConfig(current, 'old', 'new')).toBe(current);
    });

    it('persists the migration and notifies the active companion window', async () => {
        mocks.setConfig(baseConfig({
            floatingBallEnabled: true,
            floatingBallSessionId: 'old',
            floatingBallSessionWorkspace: '/workspace/mino',
        }));

        const result = await migrateFloatingBallSessionBinding('old', 'new');

        expect(result).toEqual({ migrated: true, notified: true });
        expect(mocks.getConfig().floatingBallSessionId).toBe('new');
        expect(mocks.invoke).toHaveBeenCalledWith('cmd_fb_relay', {
            target: 'companion',
            event: 'fb:session-migrated',
            payload: {
                oldSessionId: 'old',
                newSessionId: 'new',
                workspacePath: '/workspace/mino',
            },
        });
    });

    it('treats an omitted desktop pet gate as enabled for existing active companions', async () => {
        mocks.setConfig(baseConfig({
            floatingBallEnabled: true,
            floatingBallSessionId: 'old',
        }));

        const result = await migrateFloatingBallSessionBinding('old', 'new');

        expect(result).toEqual({ migrated: true, notified: true });
        expect(mocks.invoke).toHaveBeenCalledWith('cmd_fb_relay', {
            target: 'companion',
            event: 'fb:session-migrated',
            payload: {
                oldSessionId: 'old',
                newSessionId: 'new',
                workspacePath: undefined,
            },
        });
    });

    it('keeps disabled companion windows quiet while still updating the stored binding', async () => {
        mocks.setConfig(baseConfig({
            floatingBallDevGate: true,
            floatingBallEnabled: false,
            floatingBallSessionId: 'old',
        }));

        const result = await migrateFloatingBallSessionBinding('old', 'new');

        expect(result).toEqual({ migrated: true, notified: false });
        expect(mocks.getConfig().floatingBallSessionId).toBe('new');
        expect(mocks.invoke).not.toHaveBeenCalled();
    });
});
