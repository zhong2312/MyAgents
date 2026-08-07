import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SelectionCommentMenu from './SelectionCommentMenu';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SelectionCommentMenu', () => {
  it('yields to a context-menu intent and ignores the following secondary-button mouseup', async () => {
    render(
      <div data-role="assistant">
        <p>
          <span>selected text</span>{' '}
          <a href="./iteration-topic-miner/SKILL.md">file link</a>
        </p>
        <SelectionCommentMenu onQuote={vi.fn()} onElaborate={vi.fn()} />
      </div>,
    );

    const selectedText = screen.getByText('selected text');
    const textNode = selectedText.firstChild!;
    const range = {
      startContainer: textNode,
      endContainer: textNode,
      getClientRects: () => [{ left: 24, top: 80, bottom: 100 }],
    } as unknown as Range;
    const selection = {
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'selected text',
      getRangeAt: () => range,
      removeAllRanges: vi.fn(),
    } as unknown as Selection;
    vi.spyOn(window, 'getSelection').mockReturnValue(selection);

    fireEvent.mouseUp(selectedText, { button: 0 });
    expect(await screen.findByRole('button', { name: '引用' })).toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'file link' });
    fireEvent.contextMenu(link, { button: 2 });
    fireEvent.mouseUp(link, { button: 2 });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '引用' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '深入讲讲' })).not.toBeInTheDocument();
    });
  });

  it('cancels a deferred primary-button open when context-menu intent wins the frame', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const frameId = nextFrameId++;
      frames.set(frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => {
      frames.delete(frameId);
    });

    render(
      <div data-role="assistant">
        <span>selected text</span>
        <a href="https://example.com">external link</a>
        <SelectionCommentMenu onQuote={vi.fn()} onElaborate={vi.fn()} />
      </div>,
    );

    const selectedText = screen.getByText('selected text');
    const textNode = selectedText.firstChild!;
    const range = {
      startContainer: textNode,
      endContainer: textNode,
      getClientRects: () => [{ left: 24, top: 80, bottom: 100 }],
    } as unknown as Range;
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'selected text',
      getRangeAt: () => range,
    } as unknown as Selection);

    fireEvent.mouseUp(selectedText, { button: 0 });
    expect(frames).toHaveLength(1);

    fireEvent.contextMenu(screen.getByRole('link', { name: 'external link' }), { button: 2 });
    expect(frames).toHaveLength(0);

    expect(screen.queryByRole('button', { name: '引用' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '深入讲讲' })).not.toBeInTheDocument();
  });
});
