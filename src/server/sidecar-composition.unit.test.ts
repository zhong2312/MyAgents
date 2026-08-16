import { describe, expect, it, vi } from 'vitest';
import {
  classifySidecarRequest,
  composeSidecarRequestHandler,
  resolveSidecarComposition,
  runSidecarBootstrap,
  type SidecarCapability,
} from './sidecar-composition';

function request(path: string, method = 'GET'): Request {
  return new Request(`http://127.0.0.1:31415${path}`, { method });
}

describe('Sidecar production composition', () => {
  it('keeps omitted role fail-safe Session and requires an explicit development union', () => {
    expect([...resolveSidecarComposition(null, false).capabilities]).toEqual(['common', 'session']);
    expect([...resolveSidecarComposition(null, true).capabilities]).toEqual(['common', 'global', 'session']);
    expect(() => resolveSidecarComposition('global', true)).toThrow(
      '--dev-union cannot be combined with --sidecar-role',
    );
  });

  it.each([
    ['GET', '/health', 'common'],
    ['GET', '/refs/12345678', 'common'],
    ['POST', '/api/provider/verify', 'global'],
    ['POST', '/api/mcp/oauth/discover', 'global'],
    ['GET', '/api/runtime/models?type=codex', 'common'],
    ['GET', '/api/runtime/permission-modes?type=codex', 'common'],
    ['GET', '/api/runtime/type', 'session'],
    ['GET', '/sessions', 'global'],
    ['GET', '/sessions/session-1', 'common'],
    ['PATCH', '/sessions/session-1', 'global'],
    ['POST', '/chat/send', 'session'],
    ['POST', '/cron/execute-sync', 'session'],
    ['POST', '/goal/execute-sync', 'session'],
    ['POST', '/api/im/enqueue', 'session'],
    ['POST', '/api/inbox/drain', 'session'],
    ['POST', '/api/runtime/config', 'session'],
    ['POST', '/api/admin/session/send', 'session'],
    ['POST', '/api/admin/goal/update', 'session'],
    ['POST', '/api/admin/task/create-attached', 'session'],
    ['POST', '/api/admin/task/run', 'common'],
    ['POST', '/api/admin/mcp/remove', 'common'],
    ['POST', '/api/cc-plugin/session-enable', 'session'],
    ['GET', '/api/cc-plugin/list', 'common'],
    ['POST', '/api/workbench-agent/configure', 'session'],
    ['POST', '/api/workbench-ai/run', 'global'],
    ['GET', '/api/workbench-ai/run/7ed0f6ee-0000-4000-8000-000000000000', 'global'],
  ] as const)('%s %s is owned by %s', (method, path, capability) => {
    expect(classifySidecarRequest(request(path, method))).toBe(capability);
  });

  it('does not grant unknown control routes a default capability', () => {
    expect(classifySidecarRequest(request('/api/admin/future-owner', 'POST'))).toBeNull();
    expect(classifySidecarRequest(request('/api/future-owner', 'POST'))).toBeNull();
  });

  it.each([
    ['global', 'POST', '/chat/send'],
    ['global', 'POST', '/cron/execute-sync'],
    ['global', 'POST', '/goal/execute-sync'],
    ['global', 'POST', '/api/im/enqueue'],
    ['global', 'POST', '/api/inbox/drain'],
    ['session', 'POST', '/api/provider/verify'],
    ['session', 'POST', '/api/mcp/oauth/start'],
    ['session', 'PATCH', '/sessions/session-1'],
    ['global', 'POST', '/api/workbench-agent/configure'],
    ['session', 'POST', '/api/workbench-ai/run'],
  ] as const)('%s rejects wrong-role %s %s before the real handler', async (role, method, path) => {
    const realHandler = vi.fn(async () => new Response('handled'));
    const handler = composeSidecarRequestHandler(
      resolveSidecarComposition(role, false),
      realHandler,
    );

    const response = await handler(request(path, method));

    expect(response.status).toBe(404);
    expect(realHandler).not.toHaveBeenCalled();
  });

  it.each([
    ['global', 'POST', '/api/provider/verify'],
    ['global', 'POST', '/api/mcp/oauth/start'],
    ['session', 'POST', '/chat/send'],
    ['session', 'POST', '/cron/execute-sync'],
    ['session', 'POST', '/goal/execute-sync'],
    ['session', 'POST', '/api/im/enqueue'],
    ['session', 'POST', '/api/inbox/drain'],
    ['session', 'POST', '/api/workbench-agent/configure'],
    ['global', 'POST', '/api/workbench-ai/run'],
  ] as const)('%s dispatches real-role %s %s', async (role, method, path) => {
    const realHandler = vi.fn(async () => new Response('handled', { status: 202 }));
    const handler = composeSidecarRequestHandler(
      resolveSidecarComposition(role, false),
      realHandler,
    );

    const response = await handler(request(path, method));

    expect(response.status).toBe(202);
    expect(realHandler).toHaveBeenCalledOnce();
  });

  it('runs common plus only the selected production boot capability', async () => {
    const calls: SidecarCapability[] = [];
    const steps = (['common', 'global', 'session'] as const).map(capability => ({
      capability,
      run: () => { calls.push(capability); },
    }));

    await runSidecarBootstrap(resolveSidecarComposition('global', false), steps);
    expect(calls).toEqual(['common', 'global']);

    calls.length = 0;
    await runSidecarBootstrap(resolveSidecarComposition('session', false), steps);
    expect(calls).toEqual(['common', 'session']);
  });

  it('runs both production capability groups only in the explicit dev harness', async () => {
    const calls: SidecarCapability[] = [];
    await runSidecarBootstrap(resolveSidecarComposition(null, true), [
      { capability: 'common', run: () => { calls.push('common'); } },
      { capability: 'global', run: () => { calls.push('global'); } },
      { capability: 'session', run: () => { calls.push('session'); } },
    ]);
    expect(calls).toEqual(['common', 'global', 'session']);
  });
});
