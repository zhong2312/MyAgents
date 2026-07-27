import type { CSSProperties, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';

import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  convertFrontmatter,
} from '@/utils/markdownPipeline';
import { copyPlainText } from './clipboard';

export { copyPlainText } from './clipboard';

type RichCopyResult = 'rich' | 'plain';

interface MarkdownClipboardPayload {
  html: string;
  plainText: string;
}

const bodyStyle: CSSProperties = {
  color: '#1f1f1f',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontSize: '16px',
  lineHeight: 1.65,
};

const headingBaseStyle: CSSProperties = {
  color: '#111111',
  fontWeight: 700,
  lineHeight: 1.3,
  margin: '1em 0 0.45em',
};

const paragraphStyle: CSSProperties = {
  margin: '0 0 1em',
};

const listStyle: CSSProperties = {
  margin: '0 0 1em 1.5em',
  padding: 0,
};

const codeBlockStyle: CSSProperties = {
  background: '#f5f5f5',
  border: '1px solid #dddddd',
  borderRadius: '6px',
  color: '#222222',
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
  fontSize: '14px',
  lineHeight: 1.55,
  margin: '0.8em 0 1em',
  padding: '12px',
  whiteSpace: 'pre-wrap',
};

const inlineCodeStyle: CSSProperties = {
  background: '#f5f5f5',
  borderRadius: '4px',
  color: '#222222',
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
  fontSize: '0.9em',
  padding: '2px 5px',
};

const tableStyle: CSSProperties = {
  borderCollapse: 'collapse',
  margin: '0.8em 0 1em',
  width: '100%',
};

const tableCellStyle: CSSProperties = {
  border: '1px solid #dddddd',
  padding: '6px 10px',
  textAlign: 'left',
  verticalAlign: 'top',
};

const blockquoteStyle: CSSProperties = {
  borderLeft: '3px solid #cccccc',
  color: '#555555',
  margin: '0.8em 0 1em',
  padding: '0.2em 0 0.2em 1em',
};

function extractText(child: ReactNode, depth = 0): string {
  if (depth > 50) return '';
  if (typeof child === 'string') return child;
  if (typeof child === 'number') return String(child);
  if (Array.isArray(child)) return child.map(c => extractText(c, depth + 1)).join('');
  if (child && typeof child === 'object' && 'props' in child) {
    const element = child as { props?: { children?: ReactNode } };
    return element.props?.children ? extractText(element.props.children, depth + 1) : '';
  }
  return '';
}

const ClipboardCode: Components['code'] = ({ className, children }) => {
  const text = extractText(children).replace(/\n$/, '');
  const isBlock = Boolean(className) || text.includes('\n');
  if (isBlock) {
    return (
      <pre style={codeBlockStyle}>
        <code>{text}</code>
      </pre>
    );
  }
  return <code style={inlineCodeStyle}>{children}</code>;
};

const ClipboardPre: Components['pre'] = ({ children }) => <>{children}</>;

const clipboardComponents: Components = {
  h1: ({ children }) => <h1 style={{ ...headingBaseStyle, fontSize: '28px' }}>{children}</h1>,
  h2: ({ children }) => <h2 style={{ ...headingBaseStyle, fontSize: '24px' }}>{children}</h2>,
  h3: ({ children }) => <h3 style={{ ...headingBaseStyle, fontSize: '20px' }}>{children}</h3>,
  h4: ({ children }) => <h4 style={{ ...headingBaseStyle, fontSize: '18px' }}>{children}</h4>,
  h5: ({ children }) => <h5 style={{ ...headingBaseStyle, fontSize: '16px' }}>{children}</h5>,
  h6: ({ children }) => <h6 style={{ ...headingBaseStyle, fontSize: '16px', color: '#555555' }}>{children}</h6>,
  p: ({ children }) => <p style={paragraphStyle}>{children}</p>,
  ul: ({ children }) => <ul style={listStyle}>{children}</ul>,
  ol: ({ children, start }) => <ol start={start} style={listStyle}>{children}</ol>,
  li: ({ children }) => <li style={{ margin: '0.25em 0' }}>{children}</li>,
  blockquote: ({ children }) => <blockquote style={blockquoteStyle}>{children}</blockquote>,
  code: ClipboardCode,
  pre: ClipboardPre,
  table: ({ children }) => <table style={tableStyle}>{children}</table>,
  th: ({ children }) => <th style={{ ...tableCellStyle, background: '#f5f5f5', fontWeight: 700 }}>{children}</th>,
  td: ({ children }) => <td style={tableCellStyle}>{children}</td>,
  a: ({ href, children }) => (
    <a href={href} style={{ color: '#0b57d0', textDecoration: 'underline' }}>
      {children}
    </a>
  ),
  hr: () => <hr style={{ border: 0, borderTop: '1px solid #dddddd', margin: '1.5em 0' }} />,
};

export function buildMarkdownClipboardHtml(markdown: string): string {
  return buildMarkdownClipboardPayload(markdown).html;
}

export function buildMarkdownClipboardPlainText(markdown: string): string {
  return buildMarkdownClipboardPayload(markdown).plainText;
}

function buildMarkdownClipboardPayload(markdown: string): MarkdownClipboardPayload {
  const processedContent = convertFrontmatter(markdown);
  const html = renderToStaticMarkup(
    <div style={bodyStyle}>
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS_WITH_BREAKS}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
        components={clipboardComponents}
      >
        {processedContent}
      </ReactMarkdown>
    </div>,
  );
  return {
    html,
    plainText: htmlToPlainText(html),
  };
}

export async function copyMarkdownAsRichText(markdown: string): Promise<RichCopyResult> {
  const { html, plainText } = buildMarkdownClipboardPayload(markdown);
  if (await writeHtmlToClipboard(html, plainText)) {
    return 'rich';
  }
  await copyPlainText(plainText);
  return 'plain';
}

async function writeHtmlToClipboard(html: string, plainText: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
        }),
      ]);
      return true;
    }
  } catch {
    // Fall through to selection-based rich copy, then plain text.
  }
  return copyHtmlWithSelection(html);
}

function copyHtmlWithSelection(html: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const selection = window.getSelection?.();
  if (!selection) return false;

  const container = document.createElement('div');
  container.setAttribute('contenteditable', 'true');
  container.style.position = 'fixed';
  container.style.left = '-10000px';
  container.style.top = '0';
  container.style.width = '1px';
  container.style.height = '1px';
  container.style.overflow = 'hidden';
  container.style.opacity = '0';
  container.innerHTML = html;

  const previousRanges: Range[] = [];
  for (let i = 0; i < selection.rangeCount; i += 1) {
    previousRanges.push(selection.getRangeAt(i).cloneRange());
  }

  document.body.appendChild(container);
  try {
    const range = document.createRange();
    range.selectNodeContents(container);
    selection.removeAllRanges();
    selection.addRange(range);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    selection.removeAllRanges();
    for (const range of previousRanges) {
      selection.addRange(range);
    }
    container.remove();
  }
}

function htmlToPlainText(html: string): string {
  if (typeof document === 'undefined') return '';
  const root = document.createElement('div');
  root.innerHTML = html;
  const out: string[] = [];

  const append = (value: string) => {
    out.push(value);
  };
  const newline = () => {
    const current = out.join('');
    if (current && !current.endsWith('\n')) append('\n');
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      append(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    if (tag === 'br') {
      newline();
      return;
    }
    if (tag === 'li') {
      newline();
      append('- ');
    }

    for (const child of Array.from(el.childNodes)) {
      walk(child);
    }

    if (tag === 'td' || tag === 'th') {
      append('\t');
      return;
    }
    if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'pre', 'blockquote'].includes(tag)) {
      newline();
    }
  };

  walk(root);
  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\t+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
