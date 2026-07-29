/**
 * SseConnection — race / leak invariants.
 *
 * Background: a regression in dev/0.2.6 produced two SseConnection instances
 * for the same tab, each registering its own Tauri event listeners. Tauri
 * `listen()` is multicast per event name, so every SSE event was processed
 * twice and streaming text appeared duplicated end-to-end.
 *
 * The fix relies on three invariants — these tests hold them down:
 *  1. disconnect() called mid-connectTauri() must NOT leak listeners
 *     (the earlier early-exit guard skipped listener cleanup when
 *     `tauriActive` was still false).
 *  2. disconnect() is idempotent (safe to call multiple times).
 *  3. After a mid-flight cancel + re-connect, the new connection ends with
 *     exactly one set of listeners.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock hoists above imports — declare shared mock state via vi.hoisted so
// it's visible to the factory bodies.
const mocks = vi.hoisted(() => {
    const listenerCounts = new Map<string, number>();
    const state = { listenCalls: 0, isTauri: true };
    // Default implementations — restored in beforeEach so individual tests
    // can override mockImplementation() without polluting later tests.
    const defaultListenImpl = async (eventName: string) => {
        state.listenCalls++;
        // Yield once so disconnect can interleave between iterations.
        await Promise.resolve();
        listenerCounts.set(eventName, (listenerCounts.get(eventName) ?? 0) + 1);
        return () => {
            listenerCounts.set(eventName, (listenerCounts.get(eventName) ?? 1) - 1);
        };
    };
    const defaultInvokeImpl = async (_cmd: string, _args?: unknown) => undefined;
    return {
        listenerCounts,
        state,
        defaultListenImpl,
        defaultInvokeImpl,
        listenImpl: vi.fn(defaultListenImpl),
        invokeImpl: vi.fn(defaultInvokeImpl),
    };
});

vi.mock('@tauri-apps/api/event', () => ({
    listen: mocks.listenImpl,
}));
vi.mock('@tauri-apps/api/core', () => ({
    invoke: mocks.invokeImpl,
}));
vi.mock('../utils/browserMock', () => ({
    isTauriEnvironment: () => mocks.state.isTauri,
}));
vi.mock('./tauriClient', () => ({
    getTabServerUrl: vi.fn(async () => 'http://127.0.0.1:31426'),
    getSessionPort: vi.fn(async () => null),
}));

import { SseConnection } from './SseConnection';

// ---- helpers ------------------------------------------------------------

function totalListeners(): number {
    let total = 0;
    for (const count of mocks.listenerCounts.values()) total += count;
    return total;
}

beforeEach(() => {
    mocks.listenerCounts.clear();
    mocks.state.listenCalls = 0;
    mocks.state.isTauri = true;
    mocks.invokeImpl.mockClear();
    mocks.listenImpl.mockClear();
    // Restore default implementations so per-test mockImplementation overrides
    // do not bleed across tests.
    mocks.listenImpl.mockImplementation(mocks.defaultListenImpl);
    mocks.invokeImpl.mockImplementation(mocks.defaultInvokeImpl);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    expect(totalListeners(), 'listener leak between tests').toBe(0);
});

// ---- tests --------------------------------------------------------------

describe('SseConnection — listener cleanup invariants', () => {
    it('successful connect → disconnect leaves listeners at zero', async () => {
        const conn = new SseConnection('test-tab', { current: 'session-a' });
        const statusHandler = vi.fn();
        conn.setStatusHandler(statusHandler);
        await conn.connect();
        expect(totalListeners()).toBeGreaterThan(0);
        expect(statusHandler).not.toHaveBeenCalled();
        expect(mocks.invokeImpl).toHaveBeenCalledWith('start_sse_proxy', {
            connectionKey: 'test-tab',
            sessionIdHint: 'session-a',
            sidecarOwnerType: 'tab',
            sidecarOwnerId: 'test-tab',
        });

        await conn.disconnect();
        expect(totalListeners()).toBe(0);
        expect(conn.isActive()).toBe(false);
    });

    it('passes the Floating Ball companion owner without inventing a new owner type', async () => {
        const conn = new SseConnection('fb', { current: 'floating-session' }, {
            type: 'companion',
            id: 'floating-ball',
        });
        await conn.connect();

        expect(mocks.invokeImpl).toHaveBeenCalledWith('start_sse_proxy', {
            connectionKey: 'fb',
            sessionIdHint: 'floating-session',
            sidecarOwnerType: 'companion',
            sidecarOwnerId: 'floating-ball',
        });
        await conn.disconnect();
    });

    it('mid-connect disconnect does not leak listeners', async () => {
        const conn = new SseConnection('test-tab', { current: 'session-a' });

        // Kick off connect; do not await. The mocked listen() yields once
        // per call, so connectTauri's for-await loop will be in-flight when
        // we issue disconnect below.
        const connectPromise = conn.connect();

        // Yield enough microtasks for connectTauri to enter the listen loop
        // and register one or two listeners before we call disconnect.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        await conn.disconnect();
        await connectPromise.catch(() => { /* connect may have bailed */ });

        expect(totalListeners()).toBe(0);
        expect(conn.isActive()).toBe(false);
    });

    it('repeated disconnect is idempotent', async () => {
        const conn = new SseConnection('test-tab', { current: 'session-a' });
        await conn.connect();
        await conn.disconnect();
        await conn.disconnect();
        await conn.disconnect();

        expect(totalListeners()).toBe(0);
        expect(conn.isActive()).toBe(false);
    });

    it('disconnect on a never-connected instance is a no-op', async () => {
        const conn = new SseConnection('test-tab', { current: 'session-a' });
        await conn.disconnect();
        expect(mocks.invokeImpl).not.toHaveBeenCalledWith('stop_sse_proxy', expect.anything());
        expect(totalListeners()).toBe(0);
    });

    it('listen() rejection cleans up already-registered listeners', async () => {
        // Make the 3rd listen() call reject. Earlier listeners should still
        // be cleaned up — without the try/catch in connectTauri's listen
        // loop they would leak just like the original race bug.
        const realListen = mocks.listenImpl.getMockImplementation()!;
        let callCount = 0;
        mocks.listenImpl.mockImplementation(async (...args: Parameters<typeof realListen>) => {
            callCount++;
            if (callCount === 3) throw new Error('synthetic listen rejection');
            return realListen(...args);
        });

        const conn = new SseConnection('test-tab', { current: 'session-a' });
        await expect(conn.connect()).rejects.toThrow('synthetic listen rejection');

        expect(totalListeners()).toBe(0);
        expect(conn.isActive()).toBe(false);
    });

    it('cancel after start_sse_proxy succeeds tears down both proxy and listeners', async () => {
        // This is the trickiest race: connectTauri completes the listen loop
        // and start_sse_proxy resolves successfully — and EXACTLY at that
        // moment a concurrent disconnect flips shouldReconnect=false. The
        // post-start checkpoint must call stop_sse_proxy + cleanup, not
        // promote the connection to "connected".
        let resolveStart: (() => void) | null = null;
        mocks.invokeImpl.mockImplementation(async (cmd: string) => {
            if (cmd === 'start_sse_proxy') {
                await new Promise<void>((resolve) => { resolveStart = resolve; });
            }
            return undefined;
        });

        const conn = new SseConnection('test-tab', { current: 'session-a' });
        const connectPromise = conn.connect();

        // Yield until start_sse_proxy is being awaited. connectTauri() must first
        // `await listen()` for every entry in ALL_EVENTS
        // before it reaches start_sse_proxy, and the mocked listen() adds an async
        // boundary per call — so this spin budget MUST exceed
        // (ALL_EVENTS.length + 1) × (microtasks per listen). A previously
        // hardcoded `100` silently broke this test as new SSE event types were
        // added (52 listeners → ~100+ microtasks); the loop timed out before
        // start_sse_proxy, the body bailed at the assert below, and the still-
        // running connect leaked its listeners into afterEach. Keep this bound
        // generously above the listener count so adding events can't re-break it.
        for (let i = 0; i < 2000 && !resolveStart; i++) await Promise.resolve();
        expect(resolveStart, 'start_sse_proxy was not reached within the microtask budget — bump the bound if ALL_EVENTS grew').not.toBeNull();

        // Race: disconnect first, then let start_sse_proxy resolve.
        const disconnectPromise = conn.disconnect();
        resolveStart!();

        await connectPromise;
        await disconnectPromise;

        expect(conn.isActive()).toBe(false);
        expect(totalListeners()).toBe(0);
        // Should have called stop_sse_proxy as part of post-start cancellation.
        expect(mocks.invokeImpl).toHaveBeenCalledWith('stop_sse_proxy', expect.objectContaining({ connectionKey: 'test-tab' }));
    });

    it('reconnect after mid-flight cancel ends with exactly one listener per event', async () => {
        const conn = new SseConnection('test-tab', { current: 'session-a' });

        const firstConnect = conn.connect();
        await Promise.resolve();
        await Promise.resolve();
        await conn.disconnect();
        await firstConnect.catch(() => { /* ignore */ });

        await conn.connect();

        const counts = Array.from(mocks.listenerCounts.values());
        const hasNegative = counts.some((c) => c < 0);
        const hasDouble = counts.some((c) => c > 1);
        expect(hasNegative, 'negative count means we double-unlistened').toBe(false);
        expect(hasDouble, 'count > 1 means duplicate subscription').toBe(false);
        expect(conn.isActive()).toBe(true);

        await conn.disconnect();
    });

    it('unwraps revisioned envelopes using Rust transport generation metadata', async () => {
        const conn = new SseConnection('test-tab', { current: 'session-a' });
        const handler = vi.fn();
        conn.setEventHandler(handler);
        await conn.connect();

        (conn as unknown as {
            handleTauriEnvelope(eventName: string, envelope: { transportGeneration: number; data: string }): void;
        }).handleTauriEnvelope('chat:message-chunk', {
            transportGeneration: 42,
            data: JSON.stringify({
                sessionId: 'session-a',
                liveRevision: 9,
                payload: 'hello',
            }),
        });

        expect(handler).toHaveBeenCalledWith('chat:message-chunk', 'hello', {
            connectionGeneration: 42,
            sessionId: 'session-a',
            liveRevision: 9,
        });
        await conn.disconnect();
    });

    it('unwraps a revisioned terminal error as structured data', async () => {
        const conn = new SseConnection('test-tab', { current: 'session-a' });
        const handler = vi.fn();
        conn.setEventHandler(handler);
        await conn.connect();

        const payload = {
            message: 'terminal failure',
            completionTerminal: {
                sessionId: 'session-a',
                workspacePath: '/tmp/workspace',
                turnId: 'turn-a',
                origin: { kind: 'desktop', surface: 'launcher_input' },
                status: 'error',
            },
        };
        (conn as unknown as {
            handleTauriEnvelope(eventName: string, envelope: { transportGeneration: number; data: string }): void;
        }).handleTauriEnvelope('chat:message-error', {
            transportGeneration: 43,
            data: JSON.stringify({
                sessionId: 'session-a',
                liveRevision: 10,
                payload,
            }),
        });

        expect(handler).toHaveBeenCalledWith('chat:message-error', payload, {
            connectionGeneration: 43,
            sessionId: 'session-a',
            liveRevision: 10,
        });
        await conn.disconnect();
    });

    it('announces a new generation before its first event and drops older envelopes', async () => {
        const conn = new SseConnection('test-tab', { current: 'session-a' });
        const order: string[] = [];
        conn.setStatusHandler(status => order.push(`status:${status}`));
        conn.setEventHandler((_eventName, data) => order.push(`event:${String(data)}`));
        await conn.connect();

        const receive = (transportGeneration: number, payload: string) => {
            (conn as unknown as {
                handleTauriEnvelope(eventName: string, envelope: { transportGeneration: number; data: string }): void;
            }).handleTauriEnvelope('chat:message-chunk', {
                transportGeneration,
                data: payload,
            });
        };

        receive(10, 'first');
        receive(9, 'stale');
        receive(10, 'same');
        receive(11, 'next');

        expect(order).toEqual([
            'status:connected',
            'event:first',
            'event:same',
            'status:connected',
            'event:next',
        ]);
        await conn.disconnect();
    });

    it('keeps browser EventSource reconnect and browser-owned generation', async () => {
        mocks.state.isTauri = false;
        vi.useFakeTimers();

        class FakeEventSource {
            static instances: FakeEventSource[] = [];
            onopen: (() => void) | null = null;
            onerror: (() => void) | null = null;
            readonly listeners = new Map<string, EventListener>();
            closed = false;

            constructor(readonly url: string) {
                FakeEventSource.instances.push(this);
            }

            addEventListener(name: string, listener: EventListener): void {
                this.listeners.set(name, listener);
            }

            close(): void {
                this.closed = true;
            }
        }
        vi.stubGlobal('EventSource', FakeEventSource);

        const statuses: string[] = [];
        const handler = vi.fn();
        const conn = new SseConnection('test-tab', { current: 'session-a' });
        conn.setStatusHandler(status => statuses.push(status));
        conn.setEventHandler(handler);
        await conn.connect();

        const first = FakeEventSource.instances[0];
        first.onopen?.();
        first.listeners.get('chat:message-chunk')?.({
            type: 'chat:message-chunk',
            data: 'first',
        } as MessageEvent<string>);
        first.onerror?.();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(first.closed).toBe(true);
        expect(FakeEventSource.instances).toHaveLength(2);
        const second = FakeEventSource.instances[1];
        second.onopen?.();
        second.listeners.get('chat:message-chunk')?.({
            type: 'chat:message-chunk',
            data: 'second',
        } as MessageEvent<string>);

        expect(statuses).toEqual(['connected', 'reconnecting', 'connected']);
        expect(handler).toHaveBeenNthCalledWith(1, 'chat:message-chunk', 'first', {
            connectionGeneration: 1,
        });
        expect(handler).toHaveBeenNthCalledWith(2, 'chat:message-chunk', 'second', {
            connectionGeneration: 2,
        });
        expect(mocks.invokeImpl).not.toHaveBeenCalled();
        await conn.disconnect();
    });
});
