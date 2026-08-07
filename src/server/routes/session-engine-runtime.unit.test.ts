import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  engine: {
    respondPermission: vi.fn(async () => true),
  },
  updateExternalRuntimeConfigAtSelector: vi.fn<() => Promise<{
    httpStatus: number;
    body: Record<string, unknown>;
  }>>(async () => ({ httpStatus: 200, body: { success: true } })),
  prewarmExternalRuntimeAtSelector: vi.fn<() => Promise<{
    httpStatus: number;
    body: Record<string, unknown>;
  }>>(async () => ({ httpStatus: 200, body: { success: true, prewarmed: true } })),
}));

vi.mock('../session-engine', () => ({
  getSessionEngine: () => mocks.engine,
  getPermissionResponseEngine: () => mocks.engine,
  updateExternalRuntimeConfigAtSelector: mocks.updateExternalRuntimeConfigAtSelector,
  prewarmExternalRuntimeAtSelector: mocks.prewarmExternalRuntimeAtSelector,
}));

import { handleSessionEngineRuntimeRoute } from './session-engine-runtime';

const deps = {
  workspacePath: '/workspace',
  resolvePrewarmSessionId: vi.fn((requested?: string) => requested ?? 'resolved-session'),
};

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe('handleSessionEngineRuntimeRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateExternalRuntimeConfigAtSelector.mockResolvedValue({
      httpStatus: 200,
      body: { success: true },
    });
    mocks.prewarmExternalRuntimeAtSelector.mockResolvedValue({
      httpStatus: 200,
      body: { success: true, prewarmed: true },
    });
  });

  it('returns null for unrelated routes', async () => {
    await expect(handleSessionEngineRuntimeRoute('/api/runtime/type', new Request('http://local/api/runtime/type'), deps))
      .resolves.toBeNull();
  });

  it('rejects runtime config when the active engine is builtin', async () => {
    mocks.updateExternalRuntimeConfigAtSelector.mockResolvedValueOnce({
      httpStatus: 400,
      body: { success: false, error: 'Runtime config endpoint is only for external runtimes' },
    });
    const response = await handleSessionEngineRuntimeRoute(
      '/api/runtime/config',
      new Request('http://local/api/runtime/config', {
        method: 'POST',
        body: JSON.stringify({ runtime: 'codex', runtimeConfig: { model: 'gpt-5' } }),
      }),
      deps,
    );

    expect(response?.status).toBe(400);
    expect(await readJson(response!)).toMatchObject({
      success: false,
      error: 'Runtime config endpoint is only for external runtimes',
    });
    expect(mocks.updateExternalRuntimeConfigAtSelector).toHaveBeenCalledWith({
      runtime: 'codex',
      runtimeConfig: { model: 'gpt-5' },
      source: undefined,
    });
  });

  it('applies external runtime config patches through the active engine', async () => {
    const response = await handleSessionEngineRuntimeRoute(
      '/api/runtime/config',
      new Request('http://local/api/runtime/config', {
        method: 'POST',
        body: JSON.stringify({
          runtime: 'codex',
          runtimeConfig: {
            model: 'gpt-5',
            permissionMode: null,
            reasoningEffort: 'high',
          },
        }),
      }),
      deps,
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response!)).toEqual({ success: true });
    expect(mocks.updateExternalRuntimeConfigAtSelector).toHaveBeenCalledWith({
      runtime: 'codex',
      runtimeConfig: { model: 'gpt-5', permissionMode: null, reasoningEffort: 'high' },
      source: undefined,
    });
  });

  it('preserves IM sync source on external runtime config patches', async () => {
    const response = await handleSessionEngineRuntimeRoute(
      '/api/runtime/config',
      new Request('http://local/api/runtime/config', {
        method: 'POST',
        body: JSON.stringify({
          runtime: 'codex',
          runtimeConfig: { model: 'channel-model' },
          source: 'im-sync',
        }),
      }),
      deps,
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response!)).toEqual({ success: true });
    expect(mocks.updateExternalRuntimeConfigAtSelector).toHaveBeenCalledWith({
      runtime: 'codex',
      runtimeConfig: { model: 'channel-model' },
      source: 'im-sync',
    });
  });

  it('rejects system-only full-auto at the managed Codex runtime boundary', async () => {
    mocks.updateExternalRuntimeConfigAtSelector.mockResolvedValueOnce({
      httpStatus: 400,
      body: { success: false, error: "Invalid permissionMode 'full-auto' for managed-provider" },
    });

    const response = await handleSessionEngineRuntimeRoute(
      '/api/runtime/config',
      new Request('http://local/api/runtime/config', {
        method: 'POST',
        body: JSON.stringify({ runtime: 'codex', runtimeConfig: { permissionMode: 'full-auto' } }),
      }),
      deps,
    );

    expect(response?.status).toBe(400);
    expect(await readJson(response!)).toEqual({
      success: false,
      error: "Invalid permissionMode 'full-auto' for managed-provider",
    });
  });

  it('keeps full-auto legal for the system Codex runtime', async () => {
    const response = await handleSessionEngineRuntimeRoute(
      '/api/runtime/config',
      new Request('http://local/api/runtime/config', {
        method: 'POST',
        body: JSON.stringify({ runtime: 'codex', runtimeConfig: { permissionMode: 'full-auto' } }),
      }),
      deps,
    );

    expect(response?.status).toBe(200);
    expect(mocks.updateExternalRuntimeConfigAtSelector).toHaveBeenCalledWith({
      runtime: 'codex',
      runtimeConfig: { permissionMode: 'full-auto' },
      source: undefined,
    });
  });

  it.each(['auto', 'manual'])('accepts Claude Code native %s mode', async (permissionMode) => {
    const response = await handleSessionEngineRuntimeRoute(
      '/api/runtime/config',
      new Request('http://local/api/runtime/config', {
        method: 'POST',
        body: JSON.stringify({ runtime: 'claude-code', runtimeConfig: { permissionMode } }),
      }),
      deps,
    );

    expect(response?.status).toBe(200);
    expect(mocks.updateExternalRuntimeConfigAtSelector).toHaveBeenCalledWith({
      runtime: 'claude-code',
      runtimeConfig: { permissionMode },
      source: undefined,
    });
  });

  it('rejects obsolete Claude Code default literal', async () => {
    mocks.updateExternalRuntimeConfigAtSelector.mockResolvedValueOnce({
      httpStatus: 400,
      body: { success: false, error: "Invalid permissionMode 'default' for system-cli" },
    });

    const response = await handleSessionEngineRuntimeRoute(
      '/api/runtime/config',
      new Request('http://local/api/runtime/config', {
        method: 'POST',
        body: JSON.stringify({ runtime: 'claude-code', runtimeConfig: { permissionMode: 'default' } }),
      }),
      deps,
    );

    expect(response?.status).toBe(400);
    expect(await readJson(response!)).toEqual({
      success: false,
      error: "Invalid permissionMode 'default' for system-cli",
    });
  });

  it('prewarms external runtime sessions with resolved session id and workspace', async () => {
    const response = await handleSessionEngineRuntimeRoute(
      '/api/runtime/prewarm',
      new Request('http://local/api/runtime/prewarm', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5', permissionMode: 'no-restrictions' }),
      }),
      deps,
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response!)).toEqual({ success: true, prewarmed: true });
    expect(deps.resolvePrewarmSessionId).toHaveBeenCalledWith(undefined);
    expect(mocks.prewarmExternalRuntimeAtSelector).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      workspacePath: '/workspace',
      model: 'gpt-5',
    });
  });

  it('routes runtime permission-response through the active session engine for legacy approved payloads', async () => {
    const response = await handleSessionEngineRuntimeRoute(
      '/api/runtime/permission-response',
      new Request('http://local/api/runtime/permission-response', {
        method: 'POST',
        body: JSON.stringify({ requestId: 'perm-1', approved: true, reason: 'ok' }),
      }),
      deps,
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response!)).toEqual({ success: true });
    expect(mocks.engine.respondPermission).toHaveBeenCalledWith('perm-1', 'allow_once', 'ok');
  });
});
