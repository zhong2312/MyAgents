import type { Message } from '@/types/chat';
import { parseBackgroundTaskNotificationMessage } from '@/utils/backgroundTaskStatus';

/**
 * Persisted background-task notifications are session state, not visual chat rows.
 * Keep the parser as the authority so malformed or merely similarly-named user
 * messages are never silently removed from the timeline.
 */
export function isVisibleChatTimelineRow(message: Message): boolean {
  return parseBackgroundTaskNotificationMessage(message) === null;
}

export function projectVisibleChatTimelineRows(
  historyMessages: readonly Message[],
  streamingMessage: Message | null = null,
): Message[] {
  const messages = streamingMessage
    ? [...historyMessages, streamingMessage]
    : historyMessages;
  return messages.filter(isVisibleChatTimelineRow);
}

export function countVisibleChatTimelineRows(messages: readonly Message[]): number {
  let count = 0;
  for (const message of messages) {
    if (isVisibleChatTimelineRow(message)) count += 1;
  }
  return count;
}

export function shiftFirstItemIndexForVisiblePrepend(
  firstItemIndex: number,
  prependedMessages: readonly Message[],
): number {
  return firstItemIndex - countVisibleChatTimelineRows(prependedMessages);
}
