// Regression tests for compact process-group folding.
//
// A group of 4+ process blocks auto-folds the middle ones behind a 「展开全部」
// bar (and UNMOUNTS them — "collapse = unmount"). If the user has deliberately
// expanded a row, the fold must NOT kick in for that turn — otherwise it would
// unmount the row they opened and silently drop its expanded state. Expanding
// any row pins the group open (same effect as clicking 「展开全部」).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

import BlockGroup from './BlockGroup';
import type { ContentBlock } from '@/types/chat';

afterEach(() => cleanup());

function thinking(i: number): ContentBlock {
  return { type: 'thinking', thinking: `REASON_${i}`, isComplete: true, thinkingDurationMs: 1000 } as ContentBlock;
}

function task(i: number): ContentBlock {
  return {
    type: 'tool_use',
    tool: {
      id: `task-${i}`,
      name: 'Task',
      input: {},
      inputJson: '{}',
      result: '{}',
    },
  } as ContentBlock;
}

function processRowCount(container: HTMLElement): number {
  return container.querySelectorAll('button[aria-expanded]').length;
}

describe('BlockGroup compact folding', () => {
  it('shows all 3 blocks without exposing an inactive fold control', () => {
    const blocks = Array.from({ length: 3 }, (_, i) => thinking(i));
    const { container } = render(<BlockGroup blocks={blocks} isStreaming={false} />);

    expect(processRowCount(container)).toBe(3);
    expect(screen.queryByRole('button', { name: /展开全部/ })).toBeNull();

    fireEvent.click(container.querySelectorAll('button[aria-expanded]')[1]);
    expect(screen.getByText(/REASON_1/)).toBeTruthy();
  });

  it('folds 4 blocks into first + more + latest and expands all on demand', () => {
    const blocks = Array.from({ length: 4 }, (_, i) => task(i));
    const { container } = render(<BlockGroup blocks={blocks} isStreaming={false} />);

    expect(processRowCount(container)).toBe(2);
    expect(container.querySelector('[data-tool-id="task-0"]')).toBeTruthy();
    expect(container.querySelector('[data-tool-id="task-1"]')).toBeNull();
    expect(container.querySelector('[data-tool-id="task-2"]')).toBeNull();
    expect(container.querySelector('[data-tool-id="task-3"]')).toBeTruthy();
    expect(screen.getByText('+2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /展开全部/ }));

    expect(processRowCount(container)).toBe(4);
    expect(container.querySelector('[data-tool-id="task-1"]')).toBeTruthy();
    expect(container.querySelector('[data-tool-id="task-2"]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /展开全部/ })).toBeNull();
  });

  it('switches from 3 visible rows to the compact layout when streaming appends a fourth block', () => {
    const firstThree = Array.from({ length: 3 }, (_, i) => task(i));
    const { container, rerender } = render(<BlockGroup blocks={firstThree} isStreaming />);

    expect(processRowCount(container)).toBe(3);

    rerender(<BlockGroup blocks={[...firstThree, task(3)]} isStreaming />);

    expect(processRowCount(container)).toBe(2);
    expect(container.querySelector('[data-tool-id="task-0"]')).toBeTruthy();
    expect(container.querySelector('[data-tool-id="task-3"]')).toBeTruthy();
    expect(screen.getByText('+2')).toBeTruthy();
  });

  it('suppresses the fold once a row is expanded', () => {
    const blocks = Array.from({ length: 4 }, (_, i) => thinking(i));
    render(<BlockGroup blocks={blocks} isStreaming={false} />);

    // Folded: the 「展开全部」 bar's grid is open (1fr). Its nearest `.grid`
    // ancestor is the styled fold-bar container (the middle-zone grid is not
    // rendered while folded, so this is unambiguous).
    const foldBtn = screen.getByText('展开全部');
    const grid = foldBtn.closest('.grid') as HTMLElement;
    expect(grid.style.gridTemplateRows).toBe('1fr');

    // Expand the first (always-visible head) row.
    fireEvent.click(screen.getAllByRole('button')[0]);

    // Fold is now suppressed (grid collapsed) and the opened row's reasoning shows.
    expect(grid.style.gridTemplateRows).toBe('0fr');
    expect(screen.getByText(/REASON_0/)).toBeTruthy();
  });
});
