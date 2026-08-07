/**
 * Markdown - Enhanced Markdown renderer for AI chat
 * 
 * Features:
 * - Syntax highlighted code blocks with copy button
 * - LaTeX math formulas (KaTeX)
 * - Mermaid diagrams
 * - GFM tables, task lists, strikethrough
 * - External links open in system browser
 */

import 'katex/dist/katex.min.css';
import './Markdown.css';

import { memo, useEffect, useMemo, useState, type ComponentProps } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import { useTranslation } from 'react-i18next';

import CodeBlock from './markdown/CodeBlock';
import InlineCode from './markdown/InlineCode';
import MermaidDiagram from './markdown/MermaidDiagram';
import { useOpenWebLink } from '@/context/BrowserPanelContext';
import { useFileLinkAction } from '@/context/FileActionContext';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import { preprocessMarkdownContent } from '@/utils/markdownPreprocess';
import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS_DEFAULT,
  MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  convertFrontmatter,
} from '@/utils/markdownPipeline';

// ── Streaming leading-edge fade ──
// While streaming, wrap the LAST few characters of the last text node in a
// <span class="md-stream-tail"> so CSS can give them a left→right fade — newly-typed
// text emerges softly instead of hard-popping (replaces the old caret). A positional CSS
// mask can't target "the newest characters" (their on-screen position varies), but since
// the data-layer typewriter feeds revealed text into the message, we can find the tail in
// the parsed HAST. Runs AFTER sanitize (last in the rehype chain) so the injected span is
// never stripped. STREAM_TAIL_LEN code points fade; as reveal advances the window slides,
// so each char fades in over a few reveal steps. Tunable taste param.
const STREAM_TAIL_LEN = 10;
interface HastNodeLite { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNodeLite[]; }
type TailHit = { parent: HastNodeLite; index: number; value: string };
function rehypeStreamTail() {
  return (tree: HastNodeLite) => {
    // Find the LAST text node in document order. walk returns its hit (rather than mutating
    // an outer `let`, which TS can't narrow through a closure) — children are scanned in
    // order and the latest text/recursion result wins, so the document-order-last text node.
    const walk = (node: HastNodeLite): TailHit | null => {
      const kids = node.children;
      if (!kids) return null;
      let result: TailHit | null = null;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child.type === 'text' && child.value) {
          result = { parent: node, index: i, value: child.value };
        } else if (child.children) {
          const deeper = walk(child);
          if (deeper) result = deeper;
        }
      }
      return result;
    };
    const found = walk(tree);
    if (!found) return;
    const chars = Array.from(found.value); // code-point aware
    const n = Math.min(STREAM_TAIL_LEN, chars.length);
    if (n <= 0) return;
    const head = chars.slice(0, chars.length - n).join('');
    const tail = chars.slice(chars.length - n).join('');
    const span: HastNodeLite = {
      type: 'element', tagName: 'span',
      properties: { className: ['md-stream-tail'] },
      children: [{ type: 'text', value: tail }],
    };
    const replacement: HastNodeLite[] = head ? [{ type: 'text', value: head }, span] : [span];
    found.parent.children!.splice(found.index, 1, ...replacement);
  };
}

// Streaming variant: same chain + the trailing-fade injector last (post-sanitize).
const REHYPE_PLUGINS_STREAMING: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
  ...(MARKDOWN_REHYPE_PLUGINS ?? []),
  rehypeStreamTail as unknown as NonNullable<ComponentProps<typeof ReactMarkdown>['rehypePlugins']>[number],
];

// Custom link component that opens links in embedded browser panel (if available)
// or falls back to system browser. Supports text selection for copying.
// Strips react-markdown's hast `node` prop so it doesn't get spread onto the DOM <a>.
const MarkdownLink = memo(function MarkdownLink({
  href,
  children,
  node: _node,
  ...props
}: React.ComponentProps<'a'> & { node?: unknown }) {
  const fileLinkAction = useFileLinkAction();
  const openWebLink = useOpenWebLink();

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();

    // Check if user is selecting text - don't open link if selecting
    const selection = window.getSelection();
    const hasSelection = selection && selection.toString().length > 0;

    if (!hasSelection && href) {
      // Cmd (macOS) / Ctrl (Win/Linux) + click bypasses the embedded browser
      // panel and opens directly in the system default browser.
      const forceExternal = e.metaKey || e.ctrlKey;
      if (fileLinkAction?.openFileLink(href, { forceExternal })) {
        return;
      }
      openWebLink(href, { forceExternal });
    }
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!href) return;
    if (fileLinkAction?.openFileLinkMenu(e.clientX, e.clientY, href)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <a
      href={href}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      className="text-[var(--accent-warm)] underline decoration-[var(--accent-warm)]/40 underline-offset-2 transition-colors hover:text-[var(--accent-warm-hover)] hover:decoration-[var(--accent-warm)]/60"
      style={{ userSelect: 'text' }}
      {...props}
    >
      {children}
    </a>
  );
});

// Custom code component - handles both inline and block code
const CodeComponent: Components['code'] = ({ className, children, node: _node, ...props }) => {
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : '';

  // Extract text content from children, handling both string and React elements
  // Max depth prevents stack overflow on deeply nested structures (defensive)
  const extractText = (child: React.ReactNode, depth = 0): string => {
    if (depth > 50) return ''; // Defensive: prevent stack overflow
    if (typeof child === 'string') return child;
    if (typeof child === 'number') return String(child);
    if (Array.isArray(child)) return child.map(c => extractText(c, depth + 1)).join('');
    if (child && typeof child === 'object' && 'props' in child) {
      const element = child as { props?: { children?: React.ReactNode } };
      if (element.props?.children) {
        return extractText(element.props.children, depth + 1);
      }
    }
    return '';
  };

  const codeString = extractText(children).replace(/\n$/, '');

  // Check if this is a block code (has language or multiple lines)
  const isBlock = match || codeString.includes('\n');

  if (isBlock) {
    // Special handling for Mermaid diagrams
    if (language === 'mermaid') {
      return <MermaidDiagram>{codeString}</MermaidDiagram>;
    }

    return (
      <CodeBlock language={language} className={className}>
        {codeString}
      </CodeBlock>
    );
  }

  // Inline code
  return <InlineCode {...props}>{children}</InlineCode>;
};

// Custom pre component - wrapper for code blocks
const PreComponent: Components['pre'] = ({ children }) => {
  // Just pass through - CodeBlock handles the styling
  return <>{children}</>;
};

// Custom table components for better styling
const TableComponent: Components['table'] = ({ children }) => (
  <div className="markdown-table overflow-x-auto rounded-lg border border-[var(--line)]">
    <table className="m-0 min-w-full divide-y divide-[var(--line)]">
      {children}
    </table>
  </div>
);

const TableHeadComponent: Components['thead'] = ({ children }) => (
  <thead className="bg-[var(--paper-inset)]/40">{children}</thead>
);

const TableRowComponent: Components['tr'] = ({ children }) => (
  <tr className="border-b border-[var(--line-subtle)] last:border-0">
    {children}
  </tr>
);

// 表格 = text-sm(14px)：嵌在 16px 正文里的密集内容比正文低一档（13px 会造成
// 肉眼可见跳变，PRD 0.2.34 P0-1 定为 14）。v2.5 起 ui 档本身就是 14px，原 dense
// 专用档（text-md）与其 lint 白名单机制已随 Part 3 合并删除。
const TableCellComponent: Components['td'] = ({ children }) => (
  <td className="markdown-table-cell">{children}</td>
);

const TableHeaderComponent: Components['th'] = ({ children }) => (
  <th className="markdown-table-header">
    {children}
  </th>
);

// Custom blockquote for better styling
const BlockquoteComponent: Components['blockquote'] = ({ children }) => (
  <blockquote className="markdown-blockquote">
    {children}
  </blockquote>
);

// Custom heading components - H1:22px H2:20px H3:18px H4-H6:16px
const H1Component: Components['h1'] = ({ children }) => (
  <h1 className="markdown-heading markdown-h1">
    {children}
  </h1>
);

const H2Component: Components['h2'] = ({ children }) => (
  <h2 className="markdown-heading markdown-h2">
    {children}
  </h2>
);

const H3Component: Components['h3'] = ({ children }) => (
  <h3 className="markdown-heading markdown-h3">
    {children}
  </h3>
);

const H4Component: Components['h4'] = ({ children }) => (
  <h4 className="markdown-heading markdown-h4">
    {children}
  </h4>
);

const H5Component: Components['h5'] = ({ children }) => (
  <h5 className="markdown-heading markdown-h5">
    {children}
  </h5>
);

const H6Component: Components['h6'] = ({ children }) => (
  <h6 className="markdown-heading markdown-h6">
    {children}
  </h6>
);

// Custom list components
const UlComponent: Components['ul'] = ({ children, className, node: _node, ...props }) => (
  <ul
    {...props}
    className={['markdown-list', 'markdown-list-unordered', className].filter(Boolean).join(' ')}
  >
    {children}
  </ul>
);

const OlComponent: Components['ol'] = ({ children, className, node: _node, start, ...props }) => (
  <ol
    {...props}
    start={start}
    className={['markdown-list', 'markdown-list-ordered', className].filter(Boolean).join(' ')}
  >
    {children}
  </ol>
);

const LiComponent: Components['li'] = ({ children, className, node: _node, ...props }) => (
  <li
    {...props}
    className={['markdown-list-item', className].filter(Boolean).join(' ')}
  >
    {children}
  </li>
);

// Paragraph rhythm is owned by the Markdown root stylesheet. Keeping a semantic
// class here lets default and compact density change as one coherent system.
const ParagraphComponent: Components['p'] = ({ children }) => (
  <p className="markdown-paragraph">{children}</p>
);

const StrongComponent: Components['strong'] = ({ children }) => (
  <strong className="markdown-strong">{children}</strong>
);

// Horizontal rule
const HrComponent: Components['hr'] = () => (
  <hr className="markdown-rule border-[var(--line)]" />
);

// Combine all custom components
const markdownComponents: Components = {
  a: MarkdownLink,
  code: CodeComponent,
  pre: PreComponent,
  table: TableComponent,
  thead: TableHeadComponent,
  tr: TableRowComponent,
  td: TableCellComponent,
  th: TableHeaderComponent,
  blockquote: BlockquoteComponent,
  p: ParagraphComponent,
  hr: HrComponent,
  h1: H1Component,
  h2: H2Component,
  h3: H3Component,
  h4: H4Component,
  h5: H5Component,
  h6: H6Component,
  ul: UlComponent,
  ol: OlComponent,
  li: LiComponent,
  strong: StrongComponent,
};

interface MarkdownProps {
  children: string;
  /** Use compact styling for smaller spaces like thinking blocks */
  compact?: boolean;
  /** Preserve single newlines as line breaks (useful for user messages in chat) */
  preserveNewlines?: boolean;
  /** Skip preprocessing (for rendering complete documents like file preview) */
  raw?: boolean;
  /** Active streaming tail: softly fade the bottom edge + show a breathing caret
   *  on the last paragraph. Only the currently-growing assistant text block sets
   *  this (see Message.tsx); it is removed the instant the turn ends → crisp final. */
  streaming?: boolean;
  /** Document base directory path **relative to workspace root** — used to
   *  resolve `<img src="../foo.png">` against the doc's own location. */
  basePath?: string;
  /** **Absolute** workspace root path — fed to `useWorkspaceFileService` so
   *  the relative-image fetch goes through `cmd_workspace_download_file`.
   *  Required when `basePath` is set; the two are independent because
   *  `basePath` is the doc's directory inside the workspace, not the
   *  workspace itself. */
  workspacePath?: string | null;
}

/**
 * Resolve a relative path against a base directory.
 * Handles ./ and ../ prefixes, normalizes the result.
 */
function resolveRelativePath(baseDir: string, src: string): string {
  // Strip leading ./
  const cleaned = src.replace(/^\.\//, '');
  // Combine base dir and relative path
  const parts = (baseDir ? baseDir + '/' + cleaned : cleaned).split('/').filter(Boolean);
  // Resolve .. by walking the parts
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      stack.pop();
    } else if (part !== '.') {
      stack.push(part);
    }
  }
  return stack.join('/');
}

/** Whether a URL is absolute (http/https/data/blob) */
function isAbsoluteUrl(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src);
}

/** Safely decode URI component, returning original on malformed input */
function safeDecodeURIComponent(str: string): string {
  try { return decodeURIComponent(str); } catch { return str; }
}

/**
 * Image component that resolves relative paths via the Rust workspace_files
 * download command. Only used when basePath is provided (file preview mode).
 *
 * Phase D.5: switched from sidecar `/agent/download` HTTP fetch to
 * `useWorkspaceFileService.readFileAsBlobUrl` invoke. The blob-URL handle
 * is the source of truth for cleanup — calling `handle.revoke()` on unmount
 * frees the object URL.
 *
 * State model:
 * - empty / absolute src → handled purely in render, no state or effect needed
 * - relative src → useEffect fetches via fileService, stores blob URL handle
 */
function MarkdownImageInner({ src, alt, basePath, workspacePath }: {
  src?: string;
  alt?: string;
  basePath: string;
  workspacePath: string | null;
}) {
  const { t } = useTranslation('app');
  // Classify src type on every render (derived, not state)
  const srcType: 'empty' | 'absolute' | 'relative' =
    !src ? 'empty' : isAbsoluteUrl(src) ? 'absolute' : 'relative';

  // CRITICAL: `basePath` is the doc's dir RELATIVE to the workspace; it MUST
  // NOT be passed as the workspace root to the hook (Rust `validate_workspace_root`
  // requires an absolute path and would reject). Pre-Phase-D.5 the sidecar
  // resolved relative paths against its ambient `currentAgentDir`; in
  // Phase D.5 the renderer threads `workspacePath` explicitly.
  const fileService = useWorkspaceFileService(workspacePath);

  // State only needed for async-loaded relative paths
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only relative paths need async loading
    if (srcType !== 'relative') return;
    if (!fileService.isAvailable) return;

    // Decode first to prevent double-encoding (e.g. "some%20image.png")
    const decoded = safeDecodeURIComponent(src!);
    const resolvedPath = resolveRelativePath(basePath, decoded);
    let cancelled = false;
    let handle: { blobUrl: string; revoke: () => void } | null = null;

    (async () => {
      try {
        handle = await fileService.readFileAsBlobUrl({ path: resolvedPath });
        if (cancelled) {
          handle.revoke();
          return;
        }
        setBlobUrl(handle.blobUrl);
      } catch {
        if (!cancelled) setError(t('markdown.imageLoadFailed', { src }));
      }
    })();

    return () => {
      cancelled = true;
      // The handle owns the blob URL — revoke through it so we don't leak if
      // we created it before the cancel flag flipped.
      if (handle) handle.revoke();
      setBlobUrl(null);
      setError(null);
    };
  }, [src, srcType, basePath, fileService, t]);

  // Empty src: static error (no state needed)
  if (srcType === 'empty') {
    return <span className="text-xs text-[var(--ink-muted)] italic">[{t('markdown.emptyImagePath')}]</span>;
  }

  // Absolute URL: render directly (no state needed, always fresh from props)
  if (srcType === 'absolute') {
    return <img src={src} alt={alt ?? ''} className="max-w-full" />;
  }

  // Relative path: loading / error / loaded
  if (error) {
    return <span className="text-xs text-[var(--ink-muted)] italic">[{error}]</span>;
  }

  if (!blobUrl) {
    return <span className="inline-block h-4 w-16 animate-pulse rounded bg-[var(--paper-inset)]" />;
  }

  return <img src={blobUrl} alt={alt ?? ''} className="max-w-full" />;
}

/**
 * Memoized MarkdownImage — second cross-review caught that streamed markdown
 * remounts every <img> on each chunk, which re-fetches the blob and pegs the
 * Tauri IPC channel. The custom comparator keys on (src, basePath, workspacePath)
 * — the only props that affect what gets fetched. Alt text changes don't need
 * to re-trigger the effect.
 */
const MarkdownImage = memo(MarkdownImageInner, (prev, next) =>
  prev.src === next.src
  && prev.basePath === next.basePath
  && prev.workspacePath === next.workspacePath
  && prev.alt === next.alt,
);

const Markdown = memo(function Markdown({ children, compact = false, preserveNewlines = false, raw = false, basePath, workspacePath = null, streaming = false }: MarkdownProps) {
  // Skip preprocessing for raw mode (file preview) - preprocessing is for streaming chat messages.
  // In raw mode, convert YAML frontmatter to a fenced code block for proper rendering.
  //
  // NOTE: the per-character typewriter is NOT here. It lives in TabProvider's reveal loop
  // (data layer) so streamingMessage grows on a single clock that also drives autoscroll +
  // Virtuoso measurement. A view-layer typewriter inside this component animated item height
  // on its own rAF, decoupled from scroll/measurement → the streaming-phantom-thinking-rows
  // regressions. `streaming` here only swaps in the rehypeStreamTail plugin (leading-edge fade).
  const processedContent = useMemo(
    () => raw ? convertFrontmatter(children) : preprocessMarkdownContent(children),
    [children, raw],
  );

  // Phase D.5: image loading goes through Rust workspace_files. Renderer threads
  // `workspacePath` (absolute) and `basePath` (workspace-relative dir of the
  // doc) separately — the hook needs the absolute path to call the Rust cmd,
  // while basePath is only used to resolve relative `<img src>` against the
  // doc's own location.

  // Merge img handler when basePath is provided (for resolving relative image paths)
  // Use == null to allow empty string basePath (root-level files)
  const components = useMemo(() => {
    if (basePath == null) return markdownComponents;
    return {
      ...markdownComponents,
      img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
        <MarkdownImage src={props.src} alt={props.alt} basePath={basePath} workspacePath={workspacePath} />
      ),
    };
  }, [basePath, workspacePath]);

  return (
    <div className={`markdown-content break-words${compact ? ' markdown-content--compact' : ''}`}>
      <ReactMarkdown
        remarkPlugins={preserveNewlines ? MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : MARKDOWN_REMARK_PLUGINS_DEFAULT}
        rehypePlugins={streaming && !raw ? REHYPE_PLUGINS_STREAMING : MARKDOWN_REHYPE_PLUGINS}
        components={components}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
});

export default Markdown;
