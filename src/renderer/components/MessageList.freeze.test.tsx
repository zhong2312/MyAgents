// Regression test for the "phantom repeated rows + blank viewport" Virtuoso
// corruption (2026-05-25, /cross-bugfix).
//
// Root cause: while a tab is inactive the host wraps the list in
// `content-visibility:hidden`; WebKit skips its layout, so any data/height churn
// Virtuoso processes in that state poisons its offset/range cache. The streaming
// reveal loop kept growing the last row while hidden. The fix freezes the
// `data`/`firstItemIndex` handed to Virtuoso while `!isActive`, so no measurement
// churn reaches it; on re-activation we swap back to the live array.
//
// This test pins that invariant at the Virtuoso boundary: it captures the `data`
// / `firstItemIndex` props Virtuoso receives and asserts they stay frozen while
// inactive and resume live on re-activation.
import { render } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { VirtuosoHandle } from 'react-virtuoso';

import type { Message as MessageType } from '@/types/chat';

// ── Capture the props handed to Virtuoso on every render ──
type Recorded = { data: MessageType[]; firstItemIndex: number | undefined; heightEstimates: number[] | undefined };
const recorded: Recorded[] = [];
vi.mock('react-virtuoso', () => ({
  Virtuoso: (props: { data: MessageType[]; firstItemIndex?: number; heightEstimates?: number[] }) => {
    recorded.push({ data: props.data, firstItemIndex: props.firstItemIndex, heightEstimates: props.heightEstimates });
    return <div data-testid="virtuoso" data-count={props.data.length} />;
  },
}));

// Heavy children — stub so jsdom doesn't pull Markdown / tool / prompt trees.
vi.mock('@/components/Message', () => ({ default: () => <div data-testid="msg" /> }));
vi.mock('@/components/PermissionPrompt', () => ({ PermissionPrompt: () => null }));
vi.mock('@/components/AskUserQuestionPrompt', () => ({ AskUserQuestionPrompt: () => null }));
vi.mock('@/components/ExitPlanModePrompt', () => ({ ExitPlanModePrompt: () => null }));

import MessageList from './MessageList';

function msg(id: string, content: string, role: 'user' | 'assistant' = 'assistant'): MessageType {
  return { id, role, content, timestamp: new Date() } as MessageType;
}

function createFollowProps(initial: boolean | 'force' = true) {
  const followEnabledRef: React.MutableRefObject<boolean | 'force'> = { current: initial };
  return {
    followEnabledRef,
  };
}

function renderList(overrides: Partial<React.ComponentProps<typeof MessageList>>) {
  const props: React.ComponentProps<typeof MessageList> = {
    messages: [],
    streamingMessage: null,
    isLoading: false,
    sessionId: 's1',
    isActive: true,
    firstItemIndex: 1_000_000,
    virtuosoRef: { current: null },
    ...createFollowProps(),
    scrollToBottom: vi.fn(),
    handleAtBottomChange: vi.fn(),
    ...overrides,
  };
  return render(<MessageList {...props} />);
}

const lastData = () => recorded[recorded.length - 1];
const streamingText = (r: Recorded) => {
  const last = r.data[r.data.length - 1];
  return typeof last?.content === 'string' ? last.content : '';
};

describe('MessageList — freeze data while inactive (Virtuoso cache-poisoning regression)', () => {
  beforeEach(() => {
    recorded.length = 0;
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(1_000);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does NOT forward streaming growth to Virtuoso while inactive, and resumes live on re-activation', () => {
    const history = [msg('h1', 'hello', 'user'), msg('h2', 'hi there')];

    // 1. Active, streaming "a".
    const { rerender } = renderList({
      messages: [...history, msg('stream', 'a')],
      streamingMessage: msg('stream', 'a'),
      isLoading: true,
      isActive: true,
    });
    expect(streamingText(lastData())).toBe('a');

    // 2. Go inactive (content-visibility:hidden). The reveal loop keeps growing the
    //    streaming row — emulate by re-rendering with a longer streaming message.
    rerender(
      <MessageList
        messages={[...history, msg('stream', 'abc')]}
        streamingMessage={msg('stream', 'abc')}
        isLoading isActive={false}
        firstItemIndex={1_000_000}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...createFollowProps()}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );
    // FROZEN: Virtuoso must still see the pre-hidden snapshot ("a"), not "abc".
    expect(streamingText(lastData())).toBe('a');

    // 3. More growth while still hidden → still frozen.
    rerender(
      <MessageList
        messages={[...history, msg('stream', 'abcdef')]}
        streamingMessage={msg('stream', 'abcdef')}
        isLoading isActive={false}
        firstItemIndex={1_000_000}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...createFollowProps()}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );
    expect(streamingText(lastData())).toBe('a');

    // 4. Re-activate → Virtuoso swaps to the live (grown) array.
    rerender(
      <MessageList
        messages={[...history, msg('stream', 'abcdefghi')]}
        streamingMessage={msg('stream', 'abcdefghi')}
        isLoading isActive
        firstItemIndex={1_000_000}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...createFollowProps()}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );
    expect(streamingText(lastData())).toBe('abcdefghi');
  });

  it('does NOT carry a stale "scrolled-up" follow snapshot across a session switch made while hidden', () => {
    // Repro: user scrolls up in session s1, switches tab away (snapshot=false@s1),
    // the tab's session is switched to s2 while hidden, then user returns. The old
    // s1 "don't follow" intent must NOT disable follow for the fresh s2 — otherwise
    // s2 loads at bottom but never auto-scrolls new streaming.
    const followRef: React.MutableRefObject<boolean | 'force'> = { current: true };
    const followProps = () => ({
      followEnabledRef: followRef,
    });
    // Realistic scrollToBottom: mirrors the hook by flipping the ref to 'force'.
    const scrollToBottom = vi.fn(() => {
      followRef.current = 'force';
    });

    const s1 = [msg('a1', 'x', 'user'), msg('a2', 'y')];
    const { rerender } = renderList({
      sessionId: 's1', messages: s1, isActive: true,
      ...followProps(), scrollToBottom,
    });

    // User scrolls up in s1 → follow disabled.
    followRef.current = false;

    // Switch tab away → inactive snapshot captures (false @ s1).
    rerender(
      <MessageList
        sessionId="s1" messages={s1} streamingMessage={null}
        isLoading={false} isActive={false} firstItemIndex={1_000_000}
        virtuosoRef={{ current: null }} {...followProps()}
        scrollToBottom={scrollToBottom} handleAtBottomChange={vi.fn()}
      />,
    );

    // Session switched to s2 while still hidden, then user returns (isActive=true).
    const s2 = [msg('b1', 'p', 'user'), msg('b2', 'q')];
    rerender(
      <MessageList
        sessionId="s2" messages={s2} streamingMessage={null}
        isLoading={false} isActive firstItemIndex={1_000_000}
        virtuosoRef={{ current: null }} {...followProps()}
        scrollToBottom={scrollToBottom} handleAtBottomChange={vi.fn()}
      />,
    );

    // The stale s1 "false" must have been dropped: s2 ends up following, not disabled.
    expect(followRef.current).not.toBe(false);
  });

  it('freezes firstItemIndex while inactive (no prepend anchor drift mid-hide)', () => {
    const history = [msg('h1', 'a', 'user'), msg('h2', 'b')];
    const { rerender } = renderList({
      messages: history,
      isActive: true,
      firstItemIndex: 1_000_000,
    });
    expect(lastData().firstItemIndex).toBe(1_000_000);

    // Inactive: even if a stray prepend decrements firstItemIndex, Virtuoso keeps the snapshot.
    rerender(
      <MessageList
        messages={history}
        streamingMessage={null}
        isLoading={false} isActive={false}
        firstItemIndex={999_995}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...createFollowProps()}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );
    expect(lastData().firstItemIndex).toBe(1_000_000);
  });

  it('freezes heightEstimateSeed while inactive', () => {
    const history = [msg('h1', 'a', 'user'), msg('h2', 'b')];
    const { rerender } = renderList({
      messages: history,
      isActive: true,
      heightEstimateSeed: [120, 480],
    });
    expect(lastData().heightEstimates).toEqual([120, 480]);

    rerender(
      <MessageList
        messages={[...history, msg('stream', 'hidden growth')]}
        streamingMessage={msg('stream', 'hidden growth')}
        isLoading isActive={false}
        firstItemIndex={1_000_000}
        heightEstimateSeed={[120, 480, 900]}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...createFollowProps()}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );

    expect(lastData().heightEstimates).toEqual([120, 480]);
  });

  it('keeps active streaming pinned before paint through Virtuoso LAST/end alignment while following', () => {
    const scrollToIndex = vi.fn();
    const autoscrollToBottom = vi.fn();
    renderList({
      messages: [msg('h1', 'hello', 'user'), msg('stream', 'partial')],
      streamingMessage: msg('stream', 'partial'),
      isLoading: true,
      isActive: true,
      ...createFollowProps(),
      virtuosoRef: {
        current: { scrollToIndex, autoscrollToBottom },
      } as unknown as React.RefObject<VirtuosoHandle | null>,
    });

    expect(scrollToIndex).toHaveBeenCalledWith({ index: 'LAST', align: 'end', behavior: 'auto' });
    expect(autoscrollToBottom).not.toHaveBeenCalled();
  });

  it('pins to bottom once when a turn completes while follow is enabled', () => {
    const followRef: React.MutableRefObject<boolean | 'force'> = { current: true };
    const scrollToBottom = vi.fn();
    const history = [msg('h1', 'hello', 'user')];
    const baseProps = {
      firstItemIndex: 1_000_000,
      sessionId: 's1',
      virtuosoRef: { current: null },
      followEnabledRef: followRef,
      scrollToBottom,
      handleAtBottomChange: vi.fn(),
    };
    const { rerender } = renderList({
      ...baseProps,
      messages: [...history, msg('stream', 'partial')],
      streamingMessage: msg('stream', 'partial'),
      isLoading: true,
      isActive: true,
    });
    scrollToBottom.mockClear();

    rerender(
      <MessageList
        {...baseProps}
        messages={[...history, msg('assistant-1', 'final')]}
        streamingMessage={null}
        isLoading={false}
        isActive
      />,
    );

    expect(scrollToBottom).toHaveBeenCalledWith('auto');
  });
});
