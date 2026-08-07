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

  it.each([
    'process-row-expand',
    'process-row-collapse',
    'user-message-expand',
    'block-group-expand',
    'expandable-container-expand',
  ] as const)('leaves %s in natural document flow instead of restoring a later message anchor', (reason) => {
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

    act(() => {
      result.current.onRowLayoutChanged('m1', reason);
      // Emulate the same React commit growing or shrinking the virtualized row.
      setRect(row, { top: 80, bottom: 150 });
    });

    expect(controls.scrollBy).not.toHaveBeenCalled();
    expect(controls.scrollToIndex).not.toHaveBeenCalled();
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

  it.each([true, 'force'] as const)(
    'restores %s follow intent to the latest background output on window focus',
    (followMode) => {
      controls.followEnabledRef.current = followMode;
      const initial = [msg('m1')];
      const { rerender } = renderHook(
        ({ messages, focused }) => useChatScrollController({
          messages,
          isActive: true,
          isWindowFocused: focused,
          sessionId: 's1',
        }),
        { initialProps: { messages: initial, focused: true } },
      );

      rerender({ messages: initial, focused: false });
      // Simulate a stale background callback changing the live ref while the
      // controller's blur snapshot remains authoritative.
      controls.followEnabledRef.current = false;
      rerender({ messages: [...initial, msg('m2', 'finished in background')], focused: false });
      controls.scrollToBottom.mockClear();

      rerender({ messages: [...initial, msg('m2', 'finished in background')], focused: true });

      expect(controls.scrollToBottom).toHaveBeenCalledTimes(1);
      expect(controls.scrollToBottom).toHaveBeenCalledWith('auto');
      expect(controls.scrollBy).not.toHaveBeenCalled();
    },
  );

  it('restores the same message anchor when a scrolled-up reader returns', () => {
    const scroller = document.createElement('div');
    const row = document.createElement('div');
    row.setAttribute('data-chat-search-scope', '');
    row.setAttribute('data-message-id', 'm1');
    scroller.appendChild(row);
    setRect(scroller, { top: 10, bottom: 410 });
    setRect(row, { top: 30, bottom: 100 });
    controls.scrollerRef.current = scroller;
    controls.followEnabledRef.current = false;

    const initial = [msg('m1')];
    const { rerender } = renderHook(
      ({ messages, focused }) => useChatScrollController({
        messages,
        isActive: true,
        isWindowFocused: focused,
        sessionId: 's1',
      }),
      { initialProps: { messages: initial, focused: true } },
    );

    rerender({ messages: initial, focused: false });
    setRect(row, { top: 80, bottom: 150 });
    rerender({ messages: [...initial, msg('m2', 'new output below')], focused: false });

    rerender({ messages: [...initial, msg('m2', 'new output below')], focused: true });

    expect(controls.scrollToBottom).not.toHaveBeenCalled();
    expect(controls.scrollBy).toHaveBeenCalledTimes(1);
    expect(controls.scrollBy).toHaveBeenCalledWith({ top: 50, behavior: 'auto' });
    expect(controls.followEnabledRef.current).toBe(false);
  });

  it('handles row layout changes while the active Chat window is unfocused', () => {
    controls.followEnabledRef.current = true;
    const { result } = renderHook(() => useChatScrollController({
      messages: [msg('m1')],
      isActive: true,
      isWindowFocused: false,
      sessionId: 's1',
    }));

    act(() => {
      result.current.onRowLayoutChanged('m1', 'tool-complete');
    });

    expect(controls.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(controls.scrollToBottom).toHaveBeenCalledWith('auto');
    expect(controls.scrollBy).not.toHaveBeenCalled();
    expect(controls.scrollToIndex).not.toHaveBeenCalled();
  });

  it('invalidates a blur snapshot when the Session changes before focus returns', () => {
    controls.followEnabledRef.current = true;
    const { rerender } = renderHook(
      ({ focused, sessionId }) => useChatScrollController({
        messages: [msg('m1')],
        isActive: true,
        isWindowFocused: focused,
        sessionId,
      }),
      { initialProps: { focused: true, sessionId: 's1' } },
    );

    rerender({ focused: false, sessionId: 's1' });
    controls.scrollToBottom.mockClear();
    rerender({ focused: false, sessionId: 's2' });
    rerender({ focused: true, sessionId: 's2' });

    expect(controls.scrollToBottom).not.toHaveBeenCalled();
    expect(controls.scrollBy).not.toHaveBeenCalled();
    expect(controls.scrollToIndex).not.toHaveBeenCalled();
  });

  it('consumes only the latest snapshot across consecutive blur and focus transitions', () => {
    controls.followEnabledRef.current = true;
    const { rerender } = renderHook(
      ({ focused }) => useChatScrollController({
        messages: [msg('m1')],
        isActive: true,
        isWindowFocused: focused,
        sessionId: 's1',
      }),
      { initialProps: { focused: true } },
    );

    rerender({ focused: false });
    rerender({ focused: true });
    expect(controls.scrollToBottom).toHaveBeenCalledTimes(1);

    controls.followEnabledRef.current = true;
    rerender({ focused: false });
    rerender({ focused: true });
    expect(controls.scrollToBottom).toHaveBeenCalledTimes(2);
  });

  it('drops a delayed anchor correction after the Session changes', () => {
    let correctionFrame: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      correctionFrame = callback;
      return 1;
    });
    const scroller = document.createElement('div');
    setRect(scroller, { top: 10, bottom: 410 });
    controls.scrollerRef.current = scroller;

    const { result, rerender } = renderHook(
      ({ sessionId }) => useChatScrollController({
        messages: [msg('m1')],
        isActive: true,
        isWindowFocused: true,
        sessionId,
      }),
      { initialProps: { sessionId: 's1' } },
    );

    act(() => {
      result.current.restoreAnchorAfterNextCommit({
        messageId: 'm1',
        offsetFromViewportTop: 20,
        label: 'window-blur',
      });
    });
    expect(controls.scrollToIndex).toHaveBeenCalledWith({
      index: 0,
      align: 'start',
      behavior: 'auto',
    });

    const row = document.createElement('div');
    row.setAttribute('data-chat-search-scope', '');
    row.setAttribute('data-message-id', 'm1');
    setRect(row, { top: 80, bottom: 150 });
    scroller.appendChild(row);
    rerender({ sessionId: 's2' });
    act(() => correctionFrame?.(1_000));

    expect(controls.scrollBy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('drops an older delayed correction after a newer focus recovery in the same Session', () => {
    const correctionFrames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      correctionFrames.push(callback);
      return correctionFrames.length;
    });
    const scroller = document.createElement('div');
    const row = document.createElement('div');
    row.setAttribute('data-chat-search-scope', '');
    row.setAttribute('data-message-id', 'm1');
    scroller.appendChild(row);
    setRect(scroller, { top: 10, bottom: 410 });
    setRect(row, { top: 30, bottom: 100 });
    controls.scrollerRef.current = scroller;
    controls.followEnabledRef.current = false;

    const { rerender } = renderHook(
      ({ focused }) => useChatScrollController({
        messages: [msg('m1')],
        isActive: true,
        isWindowFocused: focused,
        sessionId: 's1',
      }),
      { initialProps: { focused: true } },
    );

    rerender({ focused: false });
    row.remove();
    rerender({ focused: true });

    setRect(row, { top: 80, bottom: 150 });
    scroller.appendChild(row);
    rerender({ focused: false });
    row.remove();
    rerender({ focused: true });

    setRect(row, { top: 130, bottom: 200 });
    scroller.appendChild(row);
    expect(correctionFrames).toHaveLength(2);
    act(() => correctionFrames[0](1_000));
    expect(controls.scrollBy).not.toHaveBeenCalled();

    act(() => correctionFrames[1](1_001));
    expect(controls.scrollBy).toHaveBeenCalledTimes(1);
    expect(controls.scrollBy).toHaveBeenCalledWith({ top: 50, behavior: 'auto' });
    vi.unstubAllGlobals();
  });
});
