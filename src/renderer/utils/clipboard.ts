/**
 * Write plain text to the system clipboard.
 *
 * WebKit/WebView2 can expose Async Clipboard while rejecting writes because
 * of focus or permission state. A hidden selection + execCommand fallback is
 * still the broadest reliable user-gesture path across the desktop WebViews.
 * The promise resolves only after one path reports a real copy success.
 */
export async function copyPlainText(text: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the selection fallback.
    }
  }
  if (copyPlainTextWithSelection(text)) return;
  throw new Error('Clipboard write is unavailable');
}

function copyPlainTextWithSelection(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const selection = window.getSelection?.();
  const previousRanges: Range[] = [];
  if (selection) {
    for (let i = 0; i < selection.rangeCount; i += 1) {
      previousRanges.push(selection.getRangeAt(i).cloneRange());
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-10000px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    if (selection) {
      selection.removeAllRanges();
      for (const range of previousRanges) selection.addRange(range);
    }
    textarea.remove();
  }
}
