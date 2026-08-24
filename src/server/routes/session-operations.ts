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

  if (pathname === '/api/session/compact' && request.method === 'POST') {
    const result = await getSessionEngine().compactContext();
    return operationResponse(result);
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

  if (pathname === '/api/session/surface-migration' && request.method === 'POST') {
    try {
      const body = await parseJsonObject(request);
      const targetSessionId = typeof body.targetSessionId === 'string' ? body.targetSessionId : '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetSessionId)) {
        return jsonResponse({ success: false, error: 'Missing or invalid targetSessionId' }, 400);
      }
      const migrationOptions: {
        targetSessionId: string;
        metadataBirthPending: boolean;
        metadataIndexed?: boolean;
      } = {
        targetSessionId,
        metadataBirthPending: body.metadataBirthPending === true,
      };
      if (typeof body.metadataIndexed === 'boolean') {
        migrationOptions.metadataIndexed = body.metadataIndexed;
      }
      const result = await getSessionEngine().migrateBoundSurfaceSession(
        deps.workspacePath,
        migrationOptions,
      );
      if (!result.success) {
        return jsonResponse(result, 500);
      }
      if (result.sessionId !== targetSessionId) {
        return jsonResponse({ success: false, error: 'Runtime adopted an unexpected Session identity' }, 500);
      }
      return jsonResponse({ sessionId: result.sessionId });
    } catch (error) {
      console.error('[session/surface-migration] Error:', error);
      return jsonResponse(
        { success: false, error: error instanceof Error ? error.message : 'Reset error' },
        500,
      );
    }
  }

  return null;
}
