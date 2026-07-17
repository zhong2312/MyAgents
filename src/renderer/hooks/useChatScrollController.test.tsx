import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatScrollController } from './useChatScrollController';
import { projectVisibleChatTimelineRows } from '@/utils/chatTimelineRows';
import type { Message } from '@/types/chat';

const controls = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  scrollBy: vi.fn(),
  scrollToBottom: vi.fn(),
  pauseAutoScroll: vi.fn(),
  handleAtBottomChange: vi.fn(),
  attachScroller: vi.fn(),
  virtuosoRef: { current: null as null | { scrollToIndex: ReturnType<typeof vi.fn>; scrollBy: ReturnType<typeof vi.fn> } },
  scrollerRef: { current: null as HTMLElement | null },
  followEnabledRef: { current: true as boolean | 'force' },
}));

vi.mock('@/hooks/useVirtuosoScroll', () => ({
  useVirtuosoScroll: () => ({
    virtuosoRef: controls.virtuosoRef,
    scrollerRef: controls.scrollerRef,
    followEnabledRef: controls.followEnabledRef,
    scrollToBottom: controls.scrollToBottom,
    pauseAutoScroll: controls.pauseAutoScroll,
    handleAtBottomChange: controls.handleAtBottomChange,
    attachScroller: controls.attachScroller,
  }),
}));

function msg(id: string, content = 'text'): Message {
  return { id, role: 'assistant', content, timestamp: new Date('2026-07-02T00:00:00Z') };
}

function setRect(el: Element, rect: Partial<DOMRect>) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: rect.top ?? 0,
      top: rect.top ?? 0,
      bottom: rect.bottom ?? 0,
      left: 0,
      right: 300,
      width: 300,
      height: (rect.bottom ?? 0) - (rect.top ?? 0),
      toJSON: () => ({}),
    } as DOMRect),
  });
}

describe('useChatScrollController', () => {
  beforeEach(() => {
    controls.scrollToIndex.mockReset();
    controls.scrollBy.mockReset();
    controls.scrollToBottom.mockReset();
    controls.pauseAutoScroll.mockReset();
    controls.handleAtBottomChange.mockReset();
    controls.attachScroller.mockReset();
    controls.virtuosoRef.current = {
      scrollToIndex: controls.scrollToIndex,
      scrollBy: controls.scrollBy,
    };
    controls.scrollerRef.current = null;
    controls.followEnabledRef.current = true;
  });

  it('scrollToMessage pauses follow and delegates to Virtuoso inside the controller', () => {
    const messages = [msg('m1'), msg('m2'), msg('m3')];
    const { result } = renderHook(() => useChatScrollController({ messages, isActive: true }));

    act(() => {
      result.current.scrollToMessage('m2', { align: 'center', behavior: 'auto', pauseMs: 1234 });
    });

    expect(controls.pauseAutoScroll).toHaveBeenCalledWith(1234);
    expect(controls.scrollToIndex).toHaveBeenCalledWith({
      index: 1,
      align: 'center',
      behavior: 'auto',
    });
  });

  it('does not assign a navigation index to hidden task notification records', () => {
    const messages = projectVisibleChatTimelineRows([
      msg('m1'),
      {
        ...msg('task-notification-bg-1'),
        role: 'user',
        content: '<task-notification>{"taskId":"bg-1","status":"completed"}</task-notification>',
      },
      msg('m2'),
      msg('m3'),
    ]);
    const { result } = renderHook(() => useChatScrollController({ messages, isActive: true }));

    act(() => {
      result.current.scrollToMessage('m3', { align: 'center', behavior: 'auto' });
    });

    expect(messages.map(message => message.id)).toEqual(['m1', 'm2', 'm3']);
    expect(controls.scrollToIndex).toHaveBeenCalledWith({
      index: 2,
      align: 'center',
      behavior: 'auto',
    });
  });

  it('scrollToTool resolves server_tool_use hosts inside the controller', () => {
    const messages: Message[] = [
      msg('m1'),
      {
        id: 'm2',
        role: 'assistant',
        timestamp: new Date('2026-07-02T00:00:00Z'),
        content: [
          {
            type: 'server_tool_use',
            tool: {
              id: 'server-tool-1',
              name: 'web_search',
              input: {},
              streamIndex: 0,
            },
          },
        ],
      },
    ];
    const { result } = renderHook(() => useChatScrollController({ messages, isActive: true }));

    act(() => {
      result.current.scrollToTool('server-tool-1');
    });

    expect(controls.pauseAutoScroll).toHaveBeenCalledWith(2000);
    expect(controls.scrollToIndex).toHaveBeenCalledWith({
      index: 1,
      align: 'center',
      behavior: 'smooth',
    });
  });

  it('pins bottom on tool completion when follow is still enabled', () => {
    controls.followEnabledRef.current = true;
    const { result } = renderHook(() => useChatScrollController({
      messages: [msg('m1')],
      isActive: true,
    }));

    act(() => {
      result.current.onRowLayoutChanged('m1', 'tool-complete');
    });

    expect(controls.scrollToBottom).toHaveBeenCalledWith('auto');
    expect(controls.scrollBy).not.toHaveBeenCalled();
    expect(controls.scrollToIndex).not.toHaveBeenCalled();
  });

  it.each(['attachment-settle', 'widget-resize'] as const)(
    'pins bottom on late %s layout growth when follow is still enabled',
    (reason) => {
      controls.followEnabledRef.current = true;
      const { result } = renderHook(() => useChatScrollController({
        messages: [msg('m1')],
        isActive: true,
      }));

      act(() => {
        result.current.onRowLayoutChanged('m1', reason);
      });

      expect(controls.scrollToBottom).toHaveBeenCalledWith('auto');
      expect(controls.scrollBy).not.toHaveBeenCalled();
      expect(controls.scrollToIndex).not.toHaveBeenCalled();
    },
  );

  it('does not bottom-pin late layout growth after follow is disabled', () => {
    controls.followEnabledRef.current = false;
    const { result } = renderHook(() => useChatScrollController({
      messages: [msg('m1')],
      isActive: true,
    }));

    act(() => {
      result.current.onRowLayoutChanged('m1', 'attachment-settle');
    });

    expect(controls.scrollToBottom).not.toHaveBeenCalled();
  });

  it('captures and restores an anchor with one offset correction', () => {
    const scroller = document.createElement('div');
    const row = document.createElement('div');
    row.setAttribute('data-chat-search-scope', '');
    row.setAttribute('data-message-id', 'm1');
    scroller.appendChild(row);
    setRect(scroller, { top: 10, bottom: 410 });
    setRect(row, { top: 30, bottom: 100 });
    controls.scrollerRef.current = scroller;

    const { result } = renderHook(() => useChatScrollController({
      messages: [msg('m1')],
      isActive: true,
    }));

    const anchor = result.current.captureAnchor('test');
    expect(anchor).toMatchObject({ messageId: 'm1', offsetFromViewportTop: 20 });

    setRect(row, { top: 80, bottom: 150 });
    act(() => {
      result.current.restoreAnchorAfterNextCommit(anchor!);
    });

    expect(controls.scrollBy).toHaveBeenCalledWith({ top: 50, behavior: 'auto' });
  });
});
