import { getSessionEngine } from '../session-engine';
import { createColdHistoryMessageReplay } from '../../shared/chatMessageReplay';
import { summarizeSsePayload } from '../sse';

type SseClient = {
  send(event: string, data: unknown): void;
};

export type ChatStreamRouteDeps = {
  createSseClient(onClose: () => void): { client: SseClient; response: Response };
  getLogLines(): string[];
};

export async function handleChatStreamRoute(
  pathname: string,
  request: Request,
  deps: ChatStreamRouteDeps,
): Promise<Response | null> {
  if (pathname !== '/chat/stream' || request.method !== 'GET') {
    return null;
  }

  // Capture and flush the coherent runtime snapshot before registering the new
  // client. Both operations are synchronous, so no event-loop gap exists; a
  // buffered live chunk cannot reach this client before chat:init clears it.
  const snapshot = getSessionEngine().getStreamReplaySnapshot();
  // No onClose turn-interrupt: SSE disconnect is not a cancellation authority.
  const { client, response } = deps.createSseClient(() => {});
  client.send('chat:init', {
    ...snapshot.initState,
    sessionId: snapshot.sessionId,
    liveStreamingMessage: snapshot.liveStreamingMessage ?? null,
  });

  for (const message of snapshot.replayMessages) {
    const replay = createColdHistoryMessageReplay(snapshot.sessionId, message);
    console.log(`[sse] chat:message-replay -> ${summarizeSsePayload('chat:message-replay', replay)}`);
    client.send(
      'chat:message-replay',
      replay,
    );
  }

  client.send('chat:logs', { lines: deps.getLogLines() });

  if (snapshot.systemInitPayload) {
    client.send('chat:system-init', snapshot.systemInitPayload);
  }

  for (const pending of snapshot.pendingInteractiveRequests) {
    client.send(pending.type, pending.data);
  }

  return response;
}
