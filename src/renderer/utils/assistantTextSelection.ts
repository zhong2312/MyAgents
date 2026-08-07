/**
 * Keep the platform-native double-click word/phrase selection, but normalize
 * the next click-count step to the semantic Markdown paragraph contents.
 *
 * WKWebView can extend its native paragraph selection through the block
 * separator. The selected newline then paints as a full-width trailing stripe
 * even though the copied text looks nearly identical. A Range rooted inside
 * the paragraph preserves the expected progressive selection without owning
 * word segmentation or interfering with code/link interaction semantics.
 */
export function expandAssistantParagraphSelection(
  event: Pick<MouseEvent, 'detail' | 'target'>,
): boolean {
  if (event.detail < 3) return false;

  const target = event.target instanceof Element
    ? event.target
    : event.target instanceof Node
      ? event.target.parentElement
      : null;
  if (!target) return false;

  if (target.closest('a, button, input, textarea, select, pre, code, [contenteditable]:not([contenteditable="false"])')) {
    return false;
  }

  const paragraph = target.closest<HTMLElement>('.markdown-paragraph');
  if (!paragraph || paragraph.textContent?.trim().length === 0) return false;

  const roleBoundary = paragraph.closest<HTMLElement>('[data-role]');
  if (roleBoundary?.dataset.role !== 'assistant') return false;

  const selection = window.getSelection();
  if (!selection) return false;

  const range = document.createRange();
  range.selectNodeContents(paragraph);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}
