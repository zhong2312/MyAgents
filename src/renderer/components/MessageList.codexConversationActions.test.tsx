import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { Message as MessageType } from '@/types/chat';

const VirtualRow = React.memo(function VirtualRow({
  index,
  message,
  context,
  itemContent,
}: {
  index: number;
  message: MessageType;
  context?: unknown;
  itemContent?: (index: number, message: MessageType, context?: unknown) => React.ReactNode;
}) {
  return itemContent?.(index, message, context);
});

vi.mock('react-virtuoso', () => ({
  Virtuoso: (props: {
    data: MessageType[];
    context?: unknown;
    itemContent?: (index: number, message: MessageType, context?: unknown) => React.ReactNode;
  }) => (
    <div>
      {props.data.map((message, index) => (
        <VirtualRow
          key={message.id}
          index={index}
          message={message}
          context={props.context}
          itemContent={props.itemContent}
        />
      ))}
    </div>
  ),
}));

vi.mock('@/components/Message', () => ({
  default: ({
    message,
    onRewind,
    onFork,
  }: {
    message: MessageType;
    onRewind?: (id: string) => void;
    onFork?: (id: string) => void;
  }) => (
    <div
      data-testid={`message-${message.id}`}
      data-rewind={Boolean(onRewind)}
      data-fork={Boolean(onFork)}
    />
  ),
}));
vi.mock('@/components/PermissionPrompt', () => ({ PermissionPrompt: () => null }));
vi.mock('@/components/AskUserQuestionPrompt', () => ({ AskUserQuestionPrompt: () => null }));
vi.mock('@/components/ExitPlanModePrompt', () => ({ ExitPlanModePrompt: () => null }));

import MessageList from './MessageList';

function message(id: string, role: 'user' | 'assistant', content: string): MessageType {
  return { id, role, content, timestamp: new Date() } as MessageType;
}

describe('MessageList — Codex conversation actions', () => {
  it('shows rewind and fork only at persisted exact root-turn anchors', () => {
    const user1 = message('user-1', 'user', 'first');
    const assistant1 = {
      ...message('assistant-1', 'assistant', 'answer'),
      runtimeTurnAnchor: { turnId: 'turn-1', rootUserMessageId: user1.id },
    };
    const user2 = message('user-2', 'user', 'legacy turn');
    const assistant2 = message('assistant-2', 'assistant', 'legacy answer');

    render(
      <MessageList
        messages={[user1, assistant1, user2, assistant2]}
        streamingMessage={null}
        isLoading={false}
        sessionId="session-1"
        isActive
        firstItemIndex={1_000_000}
        virtuosoRef={{ current: null }}
        followEnabledRef={{ current: true }}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
        conversationOperations="codex"
        rewindableUserMessageIds={new Set([user1.id])}
        onRewind={vi.fn()}
        onFork={vi.fn()}
      />
    );

    expect(screen.getByTestId('message-user-1')).toHaveAttribute('data-rewind', 'true');
    expect(screen.getByTestId('message-assistant-1')).toHaveAttribute('data-fork', 'true');
    expect(screen.getByTestId('message-user-2')).toHaveAttribute('data-rewind', 'false');
    expect(screen.getByTestId('message-assistant-2')).toHaveAttribute('data-fork', 'false');
  });

  it('updates an already-mounted user row when its terminal anchor arrives', () => {
    const user = message('user-live', 'user', 'follow up');
    const streamingAssistant = message('assistant-live', 'assistant', 'streaming');
    const baseProps = {
      streamingMessage: null,
      isLoading: false,
      sessionId: 'session-live',
      isActive: true,
      firstItemIndex: 1_000_000,
      virtuosoRef: { current: null },
      followEnabledRef: { current: true as const },
      scrollToBottom: vi.fn(),
      handleAtBottomChange: vi.fn(),
      conversationOperations: 'codex' as const,
      onFork: vi.fn(),
    };
    const { rerender } = render(
      <MessageList
        {...baseProps}
        messages={[user, streamingAssistant]}
        rewindableUserMessageIds={new Set()}
      />
    );
    expect(screen.getByTestId(`message-${user.id}`)).toHaveAttribute('data-rewind', 'false');

    const anchoredAssistant: MessageType = {
      ...streamingAssistant,
      runtimeTurnAnchor: { turnId: 'turn-live', rootUserMessageId: user.id },
    };
    const rewindableIds = new Set([user.id]);
    rerender(
      <MessageList
        {...baseProps}
        messages={[user, anchoredAssistant]}
        rewindableUserMessageIds={rewindableIds}
        onRewind={vi.fn()}
      />
    );

    expect(screen.getByTestId(`message-${user.id}`)).toHaveAttribute('data-rewind', 'true');

    rerender(
      <MessageList
        {...baseProps}
        messages={[user, anchoredAssistant]}
        rewindableUserMessageIds={rewindableIds}
      />
    );
    expect(screen.getByTestId(`message-${user.id}`)).toHaveAttribute('data-rewind', 'false');
  });
});
