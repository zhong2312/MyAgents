import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { expandAssistantParagraphSelection } from './assistantTextSelection';

afterEach(() => {
  window.getSelection()?.removeAllRanges();
});

describe('expandAssistantParagraphSelection', () => {
  it('keeps native double-click word selection, then selects paragraph contents without its separator', () => {
    render(
      <div data-role="assistant">
        <p className="markdown-paragraph">
          同时删除了<strong>目标读者</strong>和重复字段。
        </p>
      </div>,
    );

    const target = screen.getByText('目标读者');
    const targetText = target.firstChild!;
    const nativeWordRange = document.createRange();
    nativeWordRange.setStart(targetText, 0);
    nativeWordRange.setEnd(targetText, 2);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(nativeWordRange);

    expect(expandAssistantParagraphSelection({ detail: 2, target })).toBe(false);
    expect(selection.toString()).toBe('目标');

    expect(expandAssistantParagraphSelection({ detail: 3, target })).toBe(true);
    expect(selection.toString()).toBe('同时删除了目标读者和重复字段。');
    const paragraphRange = selection.getRangeAt(0);
    const paragraph = target.closest('.markdown-paragraph')!;
    expect(paragraphRange.startContainer).toBe(paragraph);
    expect(paragraphRange.startOffset).toBe(0);
    expect(paragraphRange.endContainer).toBe(paragraph);
    expect(paragraphRange.endOffset).toBe(paragraph.childNodes.length);
  });

  it('does not replace code or non-assistant selection semantics', () => {
    render(
      <>
        <div data-role="assistant">
          <p className="markdown-paragraph"><code>MEMORY_UPDATE_OK</code></p>
        </div>
        <div data-role="user">
          <p className="markdown-paragraph"><span>user text</span></p>
        </div>
      </>,
    );

    expect(expandAssistantParagraphSelection({
      detail: 4,
      target: screen.getByText('MEMORY_UPDATE_OK'),
    })).toBe(false);
    expect(expandAssistantParagraphSelection({
      detail: 4,
      target: screen.getByText('user text'),
    })).toBe(false);
  });
});
