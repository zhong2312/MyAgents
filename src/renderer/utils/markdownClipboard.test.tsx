import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildMarkdownClipboardHtml,
  buildMarkdownClipboardPlainText,
  copyMarkdownAsRichText,
  copyPlainText,
} from './markdownClipboard';

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard')
  ?? Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalExecCommand = document.execCommand;

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
    reader.readAsText(blob);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
  }
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: originalExecCommand,
  });
});

describe('markdownClipboard', () => {
  it('builds semantic rich-text html for markdown copy', () => {
    const html = buildMarkdownClipboardHtml([
      '# Title',
      '',
      '**Bold** text',
      '',
      '- first',
      '- second',
      '',
      '```ts',
      'const answer = 42;',
      '```',
    ].join('\n'));

    expect(html).toContain('<h1');
    expect(html).toContain('Title');
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<ul');
    expect(html).toContain('<li');
    expect(html).toContain('<pre');
    expect(html).toContain('const answer = 42;');
  });

  it('applies raw markdown frontmatter conversion and sanitizes unsafe html', () => {
    const html = buildMarkdownClipboardHtml([
      '---',
      'title: Hidden',
      '---',
      '',
      '<script>alert("x")</script>',
      '',
      '<strong>safe</strong>',
    ].join('\n'));

    expect(html).toContain('title: Hidden');
    expect(html).toContain('<pre');
    expect(html).not.toContain('<script');
    expect(html).toContain('<strong>safe</strong>');
  });

  it('builds rendered plain text for markdown preview fallback payloads', () => {
    const text = buildMarkdownClipboardPlainText('# Title\n\n**Bold** text');

    expect(text).toContain('Title');
    expect(text).toContain('Bold text');
    expect(text).not.toContain('# Title');
    expect(text).not.toContain('**Bold**');
  });

  it('writes both html and rendered plain text in the primary rich clipboard path', async () => {
    class TestClipboardItem {
      constructor(readonly data: Record<string, Blob>) {}
    }
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', TestClipboardItem);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write },
    });

    await expect(copyMarkdownAsRichText('# Title\n\n**Bold** text')).resolves.toBe('rich');

    const item = write.mock.calls[0]?.[0]?.[0] as TestClipboardItem;
    expect(item.data['text/html']).toBeInstanceOf(Blob);
    expect(item.data['text/plain']).toBeInstanceOf(Blob);
    await expect(blobText(item.data['text/html'])).resolves.toContain('<h1');
    await expect(blobText(item.data['text/plain'])).resolves.toBe('Title\n\nBold text');
  });

  it('falls back to selection copy when clipboard text write rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    await copyPlainText('raw text');

    expect(writeText).toHaveBeenCalledWith('raw text');
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('rejects when both clipboard paths fail instead of reporting false success', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    const execCommand = vi.fn().mockReturnValue(false);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    await expect(copyPlainText('raw text')).rejects.toThrow('Clipboard write is unavailable');
    expect(writeText).toHaveBeenCalledWith('raw text');
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('falls back to selection-based rich copy when ClipboardItem is unavailable', async () => {
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    await expect(copyMarkdownAsRichText('# Title')).resolves.toBe('rich');

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.body.textContent).not.toContain('Title');
  });
});
