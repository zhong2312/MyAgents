import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    apiFetch: vi.fn(),
    apiGetJson: vi.fn(),
    apiPostJson: vi.fn(),
    deleteSessionIfUnowned: vi.fn(),
    invoke: vi.fn(),
    isTauri: vi.fn(),
}));

vi.mock('../apiFetch', () => ({
    apiFetch: mocks.apiFetch,
    apiGetJson: mocks.apiGetJson,
    apiPostJson: mocks.apiPostJson,
}));

vi.mock('../tauriClient', () => ({
    deleteSessionIfUnowned: mocks.deleteSessionIfUnowned,
    isTauri: mocks.isTauri,
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: mocks.invoke,
}));

import { deleteSession, getSessions } from '../sessionClient';

const okResponse = () => new Response(JSON.stringify({ success: true }), { status: 200 });

describe('deleteSession', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isTauri.mockReturnValue(true);
        mocks.deleteSessionIfUnowned.mockResolvedValue({ deleted: true });
        mocks.apiFetch.mockResolvedValue(okResponse());
    });

    it('delegates desktop deletion to the atomic Rust owner boundary', async () => {
        await expect(deleteSession('session-1', ['tab-a'])).resolves.toEqual({ deleted: true });

        expect(mocks.deleteSessionIfUnowned).toHaveBeenCalledWith('session-1', ['tab-a']);
        expect(mocks.apiFetch).not.toHaveBeenCalled();
    });

    it('refuses to delete storage while any sidecar owner is still alive', async () => {
        mocks.deleteSessionIfUnowned.mockResolvedValue({ deleted: false, reason: 'in-use' });

        await expect(deleteSession('session-live')).resolves.toEqual({ deleted: false, reason: 'in-use' });

        expect(mocks.apiFetch).not.toHaveBeenCalled();
    });

    it('does not release any owner as a side effect of storage deletion', async () => {
        mocks.deleteSessionIfUnowned.mockResolvedValue({ deleted: false, reason: 'in-use' });

        await expect(deleteSession('session-owned')).resolves.toEqual({ deleted: false, reason: 'in-use' });

        expect(mocks.apiFetch).not.toHaveBeenCalled();
    });

    it('fails closed in browser development mode where Rust cannot fence owners', async () => {
        mocks.isTauri.mockReturnValue(false);
        mocks.deleteSessionIfUnowned.mockResolvedValue({ deleted: false, reason: 'authority-unavailable' });

        await expect(deleteSession('session-browser')).resolves.toEqual({ deleted: false, reason: 'authority-unavailable' });

        expect(mocks.deleteSessionIfUnowned).toHaveBeenCalledWith('session-browser', []);
        expect(mocks.apiFetch).not.toHaveBeenCalled();
    });

    it('fails closed when sidecar presence cannot be verified', async () => {
        mocks.deleteSessionIfUnowned.mockResolvedValue({ deleted: false, reason: 'unexpected' });

        await expect(deleteSession('session-unknown')).resolves.toEqual({ deleted: false, reason: 'unexpected' });

        expect(mocks.apiFetch).not.toHaveBeenCalled();
        expect(mocks.deleteSessionIfUnowned).toHaveBeenCalledWith('session-unknown', []);
    });

    it('preserves the atomic boundary refusal reason', async () => {
        mocks.deleteSessionIfUnowned.mockResolvedValue({ deleted: false, reason: 'not-found' });

        await expect(deleteSession('missing-session')).resolves.toEqual({ deleted: false, reason: 'not-found' });

        expect(mocks.deleteSessionIfUnowned).toHaveBeenCalledWith('missing-session', []);
    });
});

describe('getSessions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isTauri.mockReturnValue(true);
        mocks.invoke.mockResolvedValue([
            { id: 'session-older', lastActiveAt: '2026-07-03T00:00:00.000Z' },
            { id: 'session-tauri', lastActiveAt: '2026-07-04T00:00:00.000Z' },
        ]);
        mocks.apiGetJson.mockResolvedValue({
            success: true,
            sessions: [
                { id: 'session-http-old', lastActiveAt: '2026-07-02T00:00:00.000Z' },
                { id: 'session-http', lastActiveAt: '2026-07-04T00:00:00.000Z' },
            ],
        });
    });

    it('uses the Tauri metadata fast path in desktop mode', async () => {
        await expect(getSessions()).resolves.toEqual([
            { id: 'session-tauri', lastActiveAt: '2026-07-04T00:00:00.000Z' },
            { id: 'session-older', lastActiveAt: '2026-07-03T00:00:00.000Z' },
        ]);

        expect(mocks.invoke).toHaveBeenCalledWith('cmd_list_session_metadata', { agentDir: null });
        expect(mocks.apiGetJson).not.toHaveBeenCalled();
    });

    it('passes the optional workspace filter to the fast path', async () => {
        await getSessions('C:\\Users\\me\\workspace');

        expect(mocks.invoke).toHaveBeenCalledWith('cmd_list_session_metadata', {
            agentDir: 'C:\\Users\\me\\workspace',
        });
    });

    it('falls back to the HTTP sessions endpoint when the fast path fails', async () => {
        mocks.invoke.mockRejectedValue(new Error('ipc unavailable'));

        await expect(getSessions('/workspace/a')).resolves.toEqual([
            { id: 'session-http', lastActiveAt: '2026-07-04T00:00:00.000Z' },
            { id: 'session-http-old', lastActiveAt: '2026-07-02T00:00:00.000Z' },
        ]);

        expect(mocks.apiGetJson).toHaveBeenCalledWith('/sessions?agentDir=%2Fworkspace%2Fa');
    });

    it('keeps browser development mode on the HTTP sessions endpoint', async () => {
        mocks.isTauri.mockReturnValue(false);

        await expect(getSessions()).resolves.toEqual([
            { id: 'session-http', lastActiveAt: '2026-07-04T00:00:00.000Z' },
            { id: 'session-http-old', lastActiveAt: '2026-07-02T00:00:00.000Z' },
        ]);

        expect(mocks.invoke).not.toHaveBeenCalled();
        expect(mocks.apiGetJson).toHaveBeenCalledWith('/sessions');
    });
});
