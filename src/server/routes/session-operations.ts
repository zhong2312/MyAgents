import { getSessionEngine, retryLastExternalUserMessageAtSelector } from '../session-engine';
import type { CapabilityOperationResult } from '../session-engine/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function parseJsonObject(request: Request): Promise<Record<string, unknown>> {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

function operationResponse(result: CapabilityOperationResult): Response {
  const { status, ...body } = result;
  return jsonResponse(body, result.success ? 200 : status ?? 200);
}

export async function handleSessionOperationRoute(
  pathname: string,
  request: Request,
  deps: { workspacePath: string },
): Promise<Response | null> {
  if (pathname === '/chat/reset' && request.method === 'POST') {
    try {
      const result = await getSessionEngine().resetForNewDesktopSession(deps.workspacePath);
      return jsonResponse(
        result.success
          ? { success: true, sessionId: result.sessionId }
          : { success: false, error: result.error },
        result.success ? 200 : 500,
      );
    } catch (error) {
      return jsonResponse(
        { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
        500,
      );
    }
  }

  if (pathname === '/chat/rewind' && request.method === 'POST') {
    const body = await parseJsonObject(request);
    const userMessageId = typeof body.userMessageId === 'string' ? body.userMessageId : '';
    if (!userMessageId) {
      return jsonResponse({ success: false, error: 'Missing userMessageId' }, 400);
    }
    const result = await getSessionEngine().rewindToUserMessage(userMessageId);
    return operationResponse(result);
  }

  if (pathname === '/chat/external-retry' && request.method === 'POST') {
    const body = await parseJsonObject(request);
    const userMessageId = typeof body.userMessageId === 'string' ? body.userMessageId : '';
    if (!userMessageId) {
      return jsonResponse({ success: false, error: 'Missing userMessageId' }, 400);
    }
    const result = await retryLastExternalUserMessageAtSelector(userMessageId);
    return operationResponse(result);
  }

  if (pathname === '/sessions/fork' && request.method === 'POST') {
    const body = await parseJsonObject(request);
    const messageId = typeof body.messageId === 'string' ? body.messageId : '';
    if (!messageId) {
      return jsonResponse({ success: false, error: 'Missing messageId' }, 400);
    }
    const result = await getSessionEngine().forkAtAssistantMessage(messageId);
    return operationResponse(result);
  }

  if (pathname === '/api/im/session/new' && request.method === 'POST') {
    try {
      const body = await parseJsonObject(request);
      const resetOptions: { metadataBirthPending: boolean; metadataIndexed?: boolean } = {
        metadataBirthPending: body.metadataBirthPending === true,
      };
      if (typeof body.metadataIndexed === 'boolean') {
        resetOptions.metadataIndexed = body.metadataIndexed;
      }
      const result = await getSessionEngine().resetForNewImSession(deps.workspacePath, resetOptions);
      if (!result.success) {
        return jsonResponse(result, 500);
      }
      return jsonResponse({ sessionId: result.sessionId });
    } catch (error) {
      console.error('[im/session/new] Error:', error);
      return jsonResponse(
        { success: false, error: error instanceof Error ? error.message : 'Reset error' },
        500,
      );
    }
  }

  return null;
}
