import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => true }));

async function loadClient() {
    vi.resetModules();
    return import('./tauriClient');
}

describe('tauriClient global sidecar readiness', () => {
    beforeEach(() => mocks.invoke.mockReset());

    it('probes Rust readiness without exposing or caching the physical URL', async () => {
        mocks.invoke.mockResolvedValue('http://127.0.0.1:31415');
        const { waitForGlobalSidecar } = await loadClient();

        await expect(waitForGlobalSidecar()).resolves.toBeUndefined();
        expect(mocks.invoke).toHaveBeenCalledWith('cmd_get_global_server_url');
    });

    it('polls Rust until the global sidecar becomes available', async () => {
        let attempts = 0;
        mocks.invoke.mockImplementation(async (cmd: string) => {
            if (cmd !== 'cmd_get_global_server_url') return undefined;
            attempts++;
            if (attempts < 3) throw new Error('No running sidecar for tab __global__');
            return 'http://127.0.0.1:31416';
        });
        const { waitForGlobalSidecar } = await loadClient();

        await expect(waitForGlobalSidecar()).resolves.toBeUndefined();
        expect(attempts).toBe(3);
    });

});

describe('tauriClient owner-addressed control dispatch', () => {
    beforeEach(() => mocks.invoke.mockReset());

    it('sends Session requests with logical owner and path, never a renderer-selected URL', async () => {
        mocks.invoke.mockResolvedValue({
            status: 200,
            body: '{}',
            headers: { 'content-type': 'application/json' },
            is_base64: false,
        });
        const {
            getActiveTabId,
            sessionSidecarFetch,
            setActiveCorrelation,
            setAppActiveCorrelation,
            setFocusedCorrelationTabId,
        } = await loadClient();

        setActiveCorrelation({ tabId: 'old-chat-tab', sessionId: 'old-session', mounted: true });
        setFocusedCorrelationTabId('old-chat-tab');
        setAppActiveCorrelation({
            tabId: 'new-launcher-tab',
            tabs: [
                { id: 'old-chat-tab', sessionId: 'old-session' },
                { id: 'new-launcher-tab', sessionId: null },
            ],
        });

        await sessionSidecarFetch('target-session', { type: 'tab', id: 'target-tab' }, '/api/test');

        expect(getActiveTabId()).toBe('new-launcher-tab');
        expect(mocks.invoke).toHaveBeenCalledWith('session_sidecar_http_request', {
            sessionIdHint: 'target-session',
            sidecarOwnerType: 'tab',
            sidecarOwnerId: 'target-tab',
            request: {
                path: '/api/test',
                method: 'GET',
                body: undefined,
                headers: { 'X-MyAgents-Tab-Id': 'new-launcher-tab' },
            },
        });
    });

    it('keeps explicit correlation headers on global owner-addressed requests', async () => {
        mocks.invoke.mockResolvedValue({
            status: 200,
            body: '{}',
            headers: { 'content-type': 'application/json' },
            is_base64: false,
        });
        const { globalSidecarFetch } = await loadClient();

        await globalSidecarFetch('/chat/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-MyAgents-Tab-Id': 'target-tab',
                'X-MyAgents-Session-Id': 'target-session',
            },
            body: '{}',
        });

        expect(mocks.invoke).toHaveBeenCalledWith('global_sidecar_http_request', {
            request: {
                path: '/chat/send',
                method: 'POST',
                body: '{}',
                headers: {
                    'Content-Type': 'application/json',
                    'X-MyAgents-Tab-Id': 'target-tab',
                    'X-MyAgents-Session-Id': 'target-session',
                },
            },
        });
    });
});
