import { describe, expect, it } from 'vitest';
import {
  SESSION_ENGINE_ROUTE_CONTRACTS,
  findSessionEngineRouteContract,
} from './route-contracts';

describe('SESSION_ENGINE_ROUTE_CONTRACTS', () => {
  it('covers the Phase1 and Phase5 high-risk runtime split routes', () => {
    const required = [
      'POST /chat/send',
      'POST /chat/stop',
      'POST /chat/reset',
      'POST /chat/rewind',
      'POST /chat/external-retry',
      'POST /api/goal/objective',
      'GET /chat/stream',
      'POST /chat/queue/cancel',
      'POST /chat/queue/force',
      'GET /chat/queue/status',
      'POST /cron/execute-sync',
      'POST /goal/execute-sync',
      'POST /task/stop',
      'POST /api/im/enqueue',
      'POST /api/im/cancel',
      'POST /api/im/heartbeat',
      'POST /api/memory/update',
      'POST /api/inbox/drain',
      'POST /api/model/set',
      'POST /api/reasoning-effort/set',
      'POST /api/session/permission-mode',
      'POST /api/session/materialize',
      'GET /api/session/config',
      'GET /api/session-state',
      'GET /api/session-latest-result',
      'POST /api/session-watch/register',
      'GET /sessions/:id',
      'POST /sessions/fork',
      'POST /sessions/switch',
      'POST /api/im/session/new',
      'POST /api/interaction-scenario/set',
      'POST /api/mcp/set',
      'POST /api/official-tools/session-enable',
      'POST /api/agents/set',
      'POST /api/provider/set',
      'POST /api/runtime/config',
      'POST /api/runtime/prewarm',
      'POST /api/runtime/permission-response',
      'POST /api/permission/respond',
      'POST /api/im/permission-response',
      'POST /api/ask-user-question/respond',
    ];

    const actual = new Set(
      SESSION_ENGINE_ROUTE_CONTRACTS.map((contract) => `${contract.method} ${contract.path}`),
    );

    expect(actual).toEqual(new Set(required));
  });

  it('has no duplicate path/method entries', () => {
    const keys = SESSION_ENGINE_ROUTE_CONTRACTS.map(
      (contract) => `${contract.method} ${contract.path}`,
    );

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps desktop send and AskUserQuestion compatibility notes explicit', () => {
    expect(findSessionEngineRouteContract('/chat/send', 'POST')?.behavior).toContain(
      'returns before external runtime dispatch completes',
    );
    expect(findSessionEngineRouteContract('/api/ask-user-question/respond', 'POST')?.behavior).toContain(
      'pending request ownership',
    );
    expect(findSessionEngineRouteContract('/api/runtime/permission-response', 'POST')?.engineMethod).toBe(
      'respondPermission',
    );
    expect(findSessionEngineRouteContract('/task/stop', 'POST')).toMatchObject({
      engineMethod: 'stopOwnedTurnByQueueId',
      requiredFields: ['taskId', 'queueId'],
    });
    expect(findSessionEngineRouteContract('/task/stop', 'POST')?.behavior).toContain(
      'pre-metadata creator request to settle',
    );
    expect(findSessionEngineRouteContract('/api/im/heartbeat', 'POST')).toMatchObject({
      engineMethod: 'runInjectedTurn',
      responseKeys: expect.arrayContaining(['messageEnqueued']),
      behavior: expect.stringContaining('metadataBirthPending'),
    });
    expect(findSessionEngineRouteContract('/api/memory/update', 'POST')?.behavior).toContain(
      'manual and automatic turns both require the exact official myagents-memory-update skill',
    );
    expect(findSessionEngineRouteContract('/cron/execute-sync', 'POST')?.behavior).toContain(
      'managed memory jobs also require their exact official system skill',
    );
    expect(findSessionEngineRouteContract('/cron/execute-sync', 'POST')?.behavior).toContain(
      'Authorizes and settles Session metadata birth',
    );
  });
});
