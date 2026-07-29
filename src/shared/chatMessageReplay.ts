export const COLD_HISTORY_REPLAY_KIND = 'cold-history' as const;
export const LIVE_USER_ECHO_REPLAY_KIND = 'live-user-echo' as const;

export type ChatMessageReplayKind =
  | typeof COLD_HISTORY_REPLAY_KIND
  | typeof LIVE_USER_ECHO_REPLAY_KIND;

export type ChatMessageReplayPayload<TMessage> = {
  message: TMessage;
  replayKind?: ChatMessageReplayKind;
  /** Session identity captured when the event was created. */
  sessionId?: string;
};

export function createLiveUserMessageReplay<TMessage>(
  sessionId: string,
  message: TMessage,
): ChatMessageReplayPayload<TMessage> {
  return {
    message,
    replayKind: LIVE_USER_ECHO_REPLAY_KIND,
    sessionId,
  };
}

export function createColdHistoryMessageReplay<TMessage>(
  sessionId: string,
  message: TMessage,
): ChatMessageReplayPayload<TMessage> {
  return {
    message,
    replayKind: COLD_HISTORY_REPLAY_KIND,
    sessionId,
  };
}
