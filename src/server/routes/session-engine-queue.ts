import { getSessionEngine } from '../session-engine';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleSessionEngineQueueRoute(
  pathname: string,
  request: Request,
): Promise<Response | null> {
  if (pathname === '/chat/queue/cancel' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const queueId = body?.queueId as string;
    if (!queueId) {
      return jsonResponse({ success: false, error: 'queueId is required' }, 400);
    }
    const cancelResult = await getSessionEngine().cancelQueuedMessage(queueId);
    if (cancelResult.status !== 'cancelled') {
      if (cancelResult.status === 'not_cancelled') {
        return jsonResponse({ success: false, error: 'Queue item was already accepted by SDK' }, 409);
      }
      if (cancelResult.status === 'unavailable') {
        return jsonResponse({ success: false, error: 'Queue cancellation is unavailable for this session' }, 503);
      }
      if (cancelResult.status === 'error') {
        return jsonResponse({ success: false, error: 'Queue cancellation failed' }, 500);
      }
      return jsonResponse({ success: false, stale: true, error: 'Queue item not found' });
    }
    return jsonResponse({ success: true, cancelledText: cancelResult.cancelledText });
  }

  if (pathname === '/chat/queue/force' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const queueId = body?.queueId as string;
    if (!queueId) {
      return jsonResponse({ success: false, error: 'queueId is required' }, 400);
    }
    try {
      const result = await getSessionEngine().forceQueuedMessage(queueId);
      if (!result) {
        return jsonResponse({ success: false, stale: true, error: 'Queue item not found' });
      }
      return jsonResponse({ success: true });
    } catch (error) {
      return jsonResponse(
        { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
        500,
      );
    }
  }

  if (pathname === '/chat/queue/status' && request.method === 'GET') {
    return jsonResponse({ success: true, queue: getSessionEngine().getQueueStatus() });
  }

  return null;
}
