import { render } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { Message as MessageType } from '@/types/chat';

const virtuoso = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  scrollBy: vi.fn(),
}));

vi.mock('react-virtuoso', async () => {
  const ReactModule = await import('react');
  return {
    Virtuoso: ReactModule.forwardRef(function MockVirtuoso(_props, ref) {
      ReactModule.useImperativeHandle(ref, () => ({
        scrollToIndex: virtuoso.scrollToIndex,
        scrollBy: virtuoso.scrollBy,
      }), []);
      return <div data-testid="virtuoso" />;
    }),
  };
});

vi.mock('@/components/Message', () => ({ default: () => <div /> }));
vi.mock('@/components/PermissionPrompt', () => ({ PermissionPrompt: () => null }));
vi.mock('@/components/AskUserQuestionPrompt', () => ({ AskUserQuestionPrompt: () => null }));
vi.mock('@/components/ExitPlanModePrompt', () => ({ ExitPlanModePrompt: () => null }));

import MessageList from './MessageList';
import { useChatScrollController } from '@/hooks/useChatScrollController';

function msg(id: string, content: string, role: 'user' | 'assistant' = 'assistant'): MessageType {
  return { id, role, content, timestamp: new Date('2026-08-01T00:00:00Z') } as MessageType;
}

function Harness({ focused, streamingContent }: { focused: boolean; streamingContent: string }) {
  const streamingMessage = msg('stream', streamingContent);
  const messages = [msg('user', 'query', 'user'), streamingMessage];
  const controller = useChatScrollController({
    messages,
    isActive: true,
    isWindowFocused: focused,
    sessionId: 's1',
  });
  return (
    <MessageList
      messages={messages}
      streamingMessage={streamingMessage}
      isLoading
      sessionId="s1"
      isActive
      isWindowFocused={focused}
      firstItemIndex={1_000_000}
      virtuosoRef={controller.virtuosoRef}
      onScrollerRef={controller.attachScroller}
      followEnabledRef={controller.followEnabledRef}
      scrollToBottom={controller.scrollToBottom}
      handleAtBottomChange={controller.handleAtBottomChange}
      onRowLayoutChanged={controller.onRowLayoutChanged}
    />
  );
}

describe('Chat window focus scroll composition', () => {
  it('keeps a visible followed stream live while blurred and restores once on focus', () => {
    const view = render(<Harness focused streamingContent="a" />);
    virtuoso.scrollToIndex.mockClear();

    view.rerender(<Harness focused={false} streamingContent="background output" />);
    expect(virtuoso.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtuoso.scrollToIndex).toHaveBeenLastCalledWith({
      index: 'LAST',
      align: 'end',
      behavior: 'auto',
    });

    view.rerender(<Harness focused streamingContent="latest output" />);

    expect(virtuoso.scrollToIndex).toHaveBeenCalledTimes(2);
    expect(virtuoso.scrollToIndex).toHaveBeenLastCalledWith({
      index: 'LAST',
      align: 'end',
      behavior: 'auto',
    });
  });
});
