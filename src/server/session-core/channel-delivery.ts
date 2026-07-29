/**
 * Per-turn ownership of user/assistant delivery to a Session's bound IM channel.
 *
 * This is intentionally independent from SessionOrigin and InteractionScenario:
 * those describe attribution and prompting, while this contract answers which
 * transport owns each externally visible side effect for the current turn.
 */
export type UserChannelDelivery = 'session-binding' | 'none';

export type AssistantChannelDelivery =
  | 'session-binding'
  | 'reply-router'
  | 'caller-owned'
  | 'none';

export type TurnChannelDelivery = Readonly<{
  user: UserChannelDelivery;
  assistant: AssistantChannelDelivery;
}>;

export const DESKTOP_CHANNEL_DELIVERY: TurnChannelDelivery = {
  user: 'session-binding',
  assistant: 'session-binding',
};

export const IM_CHANNEL_DELIVERY: TurnChannelDelivery = {
  user: 'none',
  assistant: 'reply-router',
};

export const SESSION_BOUND_CHANNEL_DELIVERY: TurnChannelDelivery = {
  user: 'none',
  assistant: 'session-binding',
};

export const CALLER_OWNED_CHANNEL_DELIVERY: TurnChannelDelivery = {
  user: 'none',
  assistant: 'caller-owned',
};

export const NO_CHANNEL_DELIVERY: TurnChannelDelivery = {
  user: 'none',
  assistant: 'none',
};

export function injectedTurnChannelDelivery(
  assistant: AssistantChannelDelivery,
): TurnChannelDelivery {
  return { user: 'none', assistant };
}

/** Explicit model-level silence tokens are transport control, never content. */
export function isSilentAssistantChannelText(text: string): boolean {
  return text.trim() === 'NO_REPLY' || text.trim() === '<NO_REPLY>';
}

/**
 * A realtime message joins an already-running turn. A new request/caller owner
 * may take responsibility for the combined response; a Desktop steer may only
 * fill an otherwise ownerless turn and must never displace ReplyRouter/outbox.
 */
export function reconcileRealtimeAssistantChannelDelivery(
  current: AssistantChannelDelivery,
  incoming: AssistantChannelDelivery,
): AssistantChannelDelivery {
  if (incoming === 'reply-router' || incoming === 'caller-owned') return incoming;
  if (current === 'reply-router' || current === 'caller-owned') return current;
  if (incoming === 'session-binding' || current === 'session-binding') return 'session-binding';
  return 'none';
}
