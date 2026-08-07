import { render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message as MessageType } from '@/types/chat';
import { projectVisibleChatTimelineRows } from '@/utils/chatTimelineRows';

vi.mock('react-virtuoso', () => ({
  Virtuoso: (props: {
    data: MessageType[];
    context?: unknown;
    itemContent: (index: number, message: MessageType, context?: unknown) => React.ReactNode;
  }) => (
    <div data-testid="virtuoso" data-message-ids={props.data.map(message => message.id).join(',')}>
      {props.data.map((message, index) => (
        <React.Fragment key={message.id}>
          {props.itemContent(index, message, props.context)}
        </React.Fragment>
      ))}
    </div>
  ),
}));

vi.mock('@/components/Message', () => ({
  default: ({ message }: { message: MessageType }) => <div data-testid="message">{message.id}</div>,
}));
vi.mock('@/components/PermissionPrompt', () => ({ PermissionPrompt: () => null }));
vi.mock('@/components/AskUserQuestionPrompt', () => ({ AskUserQuestionPrompt: () => null }));
vi.mock('@/components/ExitPlanModePrompt', () => ({ ExitPlanModePrompt: () => null }));

import MessageList from './MessageList';

function msg(id: string, content: string, role: 'user' | 'assistant' = 'assistant'): MessageType {
  return { id, role, content, timestamp: new Date(0) } as MessageType;
}

function renderList(messages: MessageType[]) {
  return render(
    <MessageList
      messages={projectVisibleChatTimelineRows(messages)}
      streamingMessage={null}
      isLoading={false}
      sessionId="s1"
      isActive
      firstItemIndex={1_000_000}
      virtuosoRef={{ current: null }}
      followEnabledRef={{ current: true }}
      scrollToBottom={vi.fn()}
      handleAtBottomChange={vi.fn()}
    />
  );
}

describe('MessageList — task notification records', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(1_000);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never receives hidden task notification records in Virtuoso data', () => {
    const { container } = renderList([
      msg('u1', 'hello', 'user'),
      msg(
        'task-notification-bg-1',
        '<task-notification>{"taskId":"bg-1","status":"completed","description":"Audit repo","summary":"Long summary"}</task-notification>',
        'user',
      ),
      msg('a1', 'done'),
    ]);

    expect(screen.getAllByTestId('message').map(node => node.textContent)).toEqual(['u1', 'a1']);
    expect(screen.getByTestId('virtuoso')).toHaveAttribute('data-message-ids', 'u1,a1');
    expect(container.querySelector('[data-message-id="task-notification-bg-1"]')).toBeNull();
    expect(container).not.toHaveTextContent('Long summary');
    expect(container).not.toHaveTextContent('Audit repo');
  });
});
