import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cancellableFetch: vi.fn(),
}));

vi.mock('./cancellation', () => ({
  cancellableFetch: mocks.cancellableFetch,
}));

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  mocks.cancellableFetch.mockReset();
});

describe('resolveManagedOAuthCredential', () => {
  it('authenticates a Global Sidecar by its immutable process identity', async () => {
    vi.stubEnv('MYAGENTS_MANAGEMENT_PORT', '31415');
    vi.stubEnv('MYAGENTS_SIDECAR_GENERATION', '7');
    vi.stubEnv('MYAGENTS_SIDECAR_ID', '__global__');
    vi.stubEnv('MYAGENTS_SESSION_ID', 'stale-product-session');
    mocks.cancellableFetch.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      accessToken: 'managed-token',
      credentialVersion: 3,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const { resolveManagedOAuthCredential } = await import('./management-api-client');
    await expect(resolveManagedOAuthCredential(
      'xai-sub',
      { reason: 'request' },
      undefined,
      { purpose: 'verification', expectedLineage: 'lineage-1' },
    )).resolves.toEqual({
      accessToken: 'managed-token',
      credentialVersion: 3,
    });

    const [url, options] = mocks.cancellableFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:31415/api/grok/bearer');
    expect(options.headers).toMatchObject({
      'X-MyAgents-Sidecar-Generation': '7',
    });
    expect(JSON.parse(String(options.body))).toEqual({
      sidecarId: '__global__',
      reason: 'request',
      purpose: 'verification',
      expectedLineage: 'lineage-1',
    });
  });

  it('does not substitute a Product Session id for process authority', async () => {
    vi.stubEnv('MYAGENTS_MANAGEMENT_PORT', '31415');
    vi.stubEnv('MYAGENTS_SIDECAR_ID', '');
    vi.stubEnv('MYAGENTS_SESSION_ID', 'session-1');

    const { resolveManagedOAuthCredential } = await import('./management-api-client');
    await expect(resolveManagedOAuthCredential('xai-sub', { reason: 'request' }))
      .rejects.toThrow('Managed OAuth requires a Sidecar process identity');
    expect(mocks.cancellableFetch).not.toHaveBeenCalled();
  });
});
