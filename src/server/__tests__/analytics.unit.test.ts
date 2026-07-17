import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configRaw: null as string | null,
  fetch: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: () => '/tmp/myagents-analytics-test',
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => {
    if (mocks.configRaw === null) throw new Error('missing config');
    return mocks.configRaw;
  }),
}));

function enabledConfig(): string {
  return JSON.stringify({
    enabled: true,
    apiKey: 'api-key',
    endpoint: 'https://analytics.example.test/events',
    deviceId: 'device-1',
    platform: 'darwin-aarch64',
    appVersion: '0.2.36-test',
  });
}

describe('server analytics', () => {
  let restoreProxyState: (() => void) | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    mocks.configRaw = null;
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mocks.fetch);
    const cancellation = await import('../utils/cancellation');
    cancellation._setGeneralFetchTransportForTests(
      async (url, init) => globalThis.fetch(url, init as RequestInit),
    );
    const proxyState = await import('../proxy-state');
    const settings = proxyState.getCurrentProxySettings();
    const inherited = proxyState._getInheritedProxySnapshotForTests();
    proxyState._resetProxyStateForTests(null, {});
    restoreProxyState = () => proxyState._resetProxyStateForTests(settings, inherited);
  });

  afterEach(async () => {
    const cancellation = await import('../utils/cancellation');
    cancellation._setGeneralFetchTransportForTests();
    restoreProxyState?.();
    restoreProxyState = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('keeps early events until the renderer-written config appears', async () => {
    const { trackServer } = await import('../analytics');

    trackServer('ai_turn_complete', { source: 'desktop', runtime: 'builtin' });
    expect(mocks.fetch).not.toHaveBeenCalled();

    mocks.configRaw = enabledConfig();
    await vi.advanceTimersByTimeAsync(1000);

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const request = mocks.fetch.mock.calls[0];
    expect(request[0]).toBe('https://analytics.example.test/events');
    expect(request[1]?.headers).toEqual(expect.objectContaining({ 'X-API-Key': 'api-key' }));
    expect(JSON.parse(String(request[1]?.body))).toEqual({
      events: [
        expect.objectContaining({
          event: 'ai_turn_complete',
          device_id: 'device-1',
          platform: 'darwin-aarch64',
          app_version: '0.2.36-test',
          params: { source: 'desktop', runtime: 'builtin' },
        }),
      ],
    });
  });

  it('does not queue events when analytics is explicitly disabled', async () => {
    mocks.configRaw = JSON.stringify({
      enabled: false,
      apiKey: '',
      endpoint: '',
      deviceId: 'device-1',
      platform: 'darwin-aarch64',
      appVersion: '0.2.36-test',
    });
    const { trackServer } = await import('../analytics');

    trackServer('ai_turn_complete', { source: 'desktop' });
    mocks.configRaw = enabledConfig();
    await vi.advanceTimersByTimeAsync(2000);

    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('does not overlap flushes while a send is still in flight', async () => {
    mocks.configRaw = enabledConfig();
    let resolveFetch: ((value: { ok: boolean }) => void) | undefined;
    mocks.fetch.mockImplementation(() => new Promise(resolve => {
      resolveFetch = resolve as (value: { ok: boolean }) => void;
    }));
    const { trackServer } = await import('../analytics');

    for (let i = 0; i < 30; i += 1) {
      trackServer('ai_turn_complete', { index: i });
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);

    for (let i = 30; i < 60; i += 1) {
      trackServer('ai_turn_complete', { index: i });
    }
    expect(mocks.fetch).toHaveBeenCalledTimes(1);

    resolveFetch?.({ ok: true });
    await Promise.resolve();
  });
});
