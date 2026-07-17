import { describe, expect, it } from 'vitest';

import type { Message } from '@/types/chat';
import {
  countVisibleChatTimelineRows,
  isVisibleChatTimelineRow,
  projectVisibleChatTimelineRows,
  shiftFirstItemIndexForVisiblePrepend,
} from '@/utils/chatTimelineRows';

function message(id: string, content: string, role: Message['role'] = 'user'): Message {
  return { id, role, content, timestamp: new Date(0) } as Message;
}

describe('chatTimelineRows', () => {
  const completedNotification = message(
    'task-notification-bg-1',
    '<task-notification>{"taskId":"bg-1","status":"completed"}</task-notification>',
  );

  it('projects persisted task state out of the visual timeline', () => {
    const visible = projectVisibleChatTimelineRows([
      message('u1', 'question'),
      completedNotification,
      message('a1', 'answer', 'assistant'),
    ]);

    expect(visible.map(row => row.id)).toEqual(['u1', 'a1']);
    expect(countVisibleChatTimelineRows([completedNotification])).toBe(0);
  });

  it.each(['completed', 'error', 'failed', 'stopped'])(
    'filters a parseable %s task notification',
    (status) => {
      const notification = message(
        `task-notification-${status}`,
        `<task-notification>{"taskId":"bg-${status}","status":"${status}"}</task-notification>`,
      );

      expect(isVisibleChatTimelineRow(notification)).toBe(false);
    },
  );

  it('retains similarly named or tagged messages that are not valid persisted records', () => {
    const prefixOnly = message('task-notification-user-text', 'ordinary user content');
    const malformedPayload = message(
      'task-notification-malformed',
      '<task-notification>{not-json}</task-notification>',
    );
    const tagOnly = message(
      'ordinary-id',
      '<task-notification>{"taskId":"bg-2","status":"completed"}</task-notification>',
    );

    expect(projectVisibleChatTimelineRows([prefixOnly, malformedPayload, tagOnly])).toEqual([
      prefixOnly,
      malformedPayload,
      tagOnly,
    ]);
  });

  it('counts only visible rows when a pagination page contains hidden state records', () => {
    const page = [
      message('u1', 'question'),
      completedNotification,
      message('a1', 'answer', 'assistant'),
    ];

    expect(countVisibleChatTimelineRows(page)).toBe(2);
    expect(shiftFirstItemIndexForVisiblePrepend(1_000_000, page)).toBe(999_998);
  });
});
