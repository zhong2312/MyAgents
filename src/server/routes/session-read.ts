import { getSessionEngine } from '../session-engine';
import { getSessionData, isHistoryVisibleSession } from '../SessionStore';
import { pendingSessionWatchCount, registerPendingSessionWatch } from '../inbox/watch-registry';
import {
  shrinkSessionMessageForClient,
  shrinkSessionMessagesForClient,
} from '../utils/session-message-preview';
import { toClientSessionMetadata } from '../utils/session-metadata-wire';
import type { SessionMessage, SessionMetadata } from '../types/session';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mergeActiveOverlayMessages(
  diskMessages: SessionMessage[],
  inMemoryMessages: SessionMessage[] | undefined,
): SessionMessage[] {
  if (!inMemoryMessages?.length) return diskMessages;
  const memoryById = new Map(inMemoryMessages.map(message => [message.id, message]));
  const diskIds = new Set(diskMessages.map(message => message.id));
  const merged = diskMessages.map(message => memoryById.get(message.id) ?? message);
  for (const message of inMemoryMessages) {
    if (!diskIds.has(message.id)) merged.push(message);
  }
  return merged;
}

function paginateMessages(
  messages: SessionMessage[],
  url: URL,
): { messages: SessionMessage[]; totalCount: number; hasMoreBefore: boolean } {
  const rawLimit = parseInt(url.searchParams.get('limit') ?? '0', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 0;
  const before = url.searchParams.get('before');

  const totalCount = messages.length;
  let paginatedMessages = messages;
  let hasMoreBefore = false;

  if (limit > 0) {
    if (before) {
      const beforeIdx = messages.findIndex(message => message.id === before);
      if (beforeIdx < 0) {
        paginatedMessages = [];
      } else {
        const start = Math.max(0, beforeIdx - limit);
        paginatedMessages = messages.slice(start, beforeIdx);
        hasMoreBefore = start > 0;
      }
    } else {
      const start = Math.max(0, totalCount - limit);
      paginatedMessages = messages.slice(start);
      hasMoreBefore = start > 0;
    }
  }

  return { messages: paginatedMessages, totalCount, hasMoreBefore };
}

async function handleSessionWatchRegister(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    watchId?: string;
    watcherSessionId?: string;
    watcherResumeWorkspacePath?: string;
    targetSessionId?: string;
    targetLabel?: string;
    observedSidecarState?: string;
  } | null;
  if (!body?.watchId || !body.watcherSessionId || !body.targetSessionId) {
    return jsonResponse({ accepted: false, reason: 'invalid body' }, 400);
  }

  const engine = getSessionEngine();
  const runtimeIdentity = engine.getRuntimeIdentity();
  if (body.targetSessionId !== runtimeIdentity.sessionId) {
    return jsonResponse({ accepted: false, reason: 'target session mismatch' }, 409);
  }

  const targetSessionState = engine.getLiveSessionState().sessionState;
  const latestResult = engine.getLatestAssistantResult().latestResult;
  if (targetSessionState === 'error') {
    return jsonResponse({
      accepted: false,
      delivery: 'error',
      reason: 'target_error',
      targetStateAtRegistration: targetSessionState,
      finalState: 'error',
      terminalReason: 'target_error',
      latestResult,
    });
  }
  if (targetSessionState !== 'running' && targetSessionState !== 'starting') {
    return jsonResponse({
      accepted: false,
      delivery: 'already_idle',
      reason: 'already_idle',
      targetStateAtRegistration: targetSessionState,
      finalState: 'idle',
      terminalReason: 'already_idle',
      latestResult,
    });
  }

  registerPendingSessionWatch({
    watchId: body.watchId,
    watcherSessionId: body.watcherSessionId,
    watcherResumeWorkspacePath: body.watcherResumeWorkspacePath,
    targetSessionId: body.targetSessionId,
    targetLabel: body.targetLabel || 'a session',
    targetStateAtRegistration: targetSessionState,
    registeredAt: new Date().toISOString(),
  });
  return jsonResponse({
    accepted: true,
    delivery: 'registered',
    targetStateAtRegistration: targetSessionState,
    pending: pendingSessionWatchCount(),
  });
}

function handleSessionDetails(sessionId: string, url: URL): Response {
  const engine = getSessionEngine();
  const session = getSessionData(sessionId);
  const overlay = engine.getLiveSessionOverlay(sessionId);

  if (!session) {
    if (overlay.isActive) {
      const { messages, totalCount, hasMoreBefore } = paginateMessages(
        overlay.inMemoryMessages ?? [],
        url,
      );
      return jsonResponse({
        success: true,
        session: {
          id: sessionId,
          runtime: overlay.runtime ?? engine.getRuntimeIdentity().runtime,
          messages: shrinkSessionMessagesForClient(messages),
          snapshotRevision: overlay.snapshotRevision ?? 0,
          liveStreamingMessage: overlay.liveStreamingMessage
            ? shrinkSessionMessageForClient(overlay.liveStreamingMessage)
            : null,
          liveSessionState: overlay.liveSessionState,
          pendingInteractiveRequests: overlay.pendingInteractiveRequests ?? [],
          totalCount,
          hasMoreBefore,
        },
      });
    }
    return jsonResponse({ success: false, error: 'Session not found.' }, 404);
  }
  const isActivePreparedSession =
    overlay.isActive && session.materializationState === 'prepared';
  if (!isHistoryVisibleSession(session) && !isActivePreparedSession) {
    return jsonResponse({ success: false, error: 'Session not found.' }, 404);
  }

  const mergedMessages = mergeActiveOverlayMessages(session.messages, overlay.inMemoryMessages);
  const { messages, totalCount, hasMoreBefore } = paginateMessages(mergedMessages, url);
  const liveStreamingMessage = overlay.liveStreamingMessage
    ? shrinkSessionMessageForClient(overlay.liveStreamingMessage)
    : null;

  const sessionWithPreview = {
    ...toClientSessionMetadata(session as SessionMetadata),
    liveStreamingMessage,
    snapshotRevision: overlay.snapshotRevision ?? 0,
    liveSessionState: overlay.liveSessionState,
    pendingInteractiveRequests: overlay.pendingInteractiveRequests ?? [],
    messages: shrinkSessionMessagesForClient(messages),
    totalCount,
    hasMoreBefore,
  };

  return jsonResponse({ success: true, session: sessionWithPreview });
}

export async function handleSessionReadRoute(
  pathname: string,
  request: Request,
  url: URL,
): Promise<Response | null> {
  if (pathname === '/api/session-state' && request.method === 'GET') {
    const engine = getSessionEngine();
    const liveState = engine.getLiveSessionState();
    return jsonResponse({
      sessionId: engine.getRuntimeIdentity().sessionId,
      sessionState: liveState.sessionState,
      isBusy: liveState.isBusy,
      completionTerminal: engine.getSessionCompletionTerminal(),
    });
  }

  if (pathname === '/api/session-latest-result' && request.method === 'GET') {
    return jsonResponse(getSessionEngine().getLatestAssistantResult());
  }

  if (pathname === '/api/session-watch/register' && request.method === 'POST') {
    return handleSessionWatchRegister(request);
  }

  const sessionPathMatch = pathname.match(/^\/sessions\/([^/]+)$/);
  if (sessionPathMatch && request.method === 'GET') {
    const sessionId = sessionPathMatch[1];
    if (!sessionId) {
      return jsonResponse({ success: false, error: 'Session ID required.' }, 400);
    }
    return handleSessionDetails(sessionId, url);
  }

  return null;
}
