import { ArrowRight, FileText, Info } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { createElement as createSyntaxElement, Prism as SyntaxHighlighter } from 'react-syntax-highlighter';

import { useNotifyRowLayoutChanged } from '@/context/ChatRowLayoutContext';
import { useResolvedTheme } from '@/theme';
import type { ToolUseSimple } from '@/types/chat';
import { getPrismLanguage } from '@/utils/languageUtils';

import type {
  DiffRow,
  FilePatchRenderChange,
  FilePatchRenderModel,
} from '../../../shared/toolDisplay/filePatch';
import {
  FILE_PATCH_MAX_CHARACTER_BUDGET,
  resolveFilePatchRenderModel,
} from '../../../shared/toolDisplay/filePatch';
import { ExpandableResult, FileActionMenuButton } from './utils';

interface FilePatchToolProps {
  tool: ToolUseSimple;
}

type ChatTranslator = (key: string, options?: Record<string, unknown>) => string;

const INITIAL_ROWS_PER_FILE = 400;
const INITIAL_ROWS_PER_TOOL = 400;
const INITIAL_VISIBLE_VIEWPORT_ROWS = 16;
const MAX_RENDER_ROWS_PER_FILE = 5_000;
const SYNTAX_HIGHLIGHT_ROW_BUDGET = 1_000;
const SYNTAX_HIGHLIGHT_TEXT_BUDGET = 100 * 1024;

export default function FilePatchTool({ tool }: FilePatchToolProps) {
  const { t } = useTranslation('chat');
  const model = resolveFilePatchRenderModel(tool);

  if (!model) {
    if (!tool.result) return null;
    return (
      <RawFilePatchResult
        result={tool.result}
        hasHiddenContent={tool.resultMeta?.largeValueRef != null}
        t={t}
      />
    );
  }

  const moveTargetApplied = !!tool.result
    && !tool.isError
    && (!model.status || model.status === 'completed');
  const isMultiFile = model.changes.length > 1;
  const pathPresentations = buildPathPresentations(model.changes, t);
  const initialRowBudgets = allocateInitialRowBudgets(model.changes);

  return (
    <div className="space-y-2.5">
      <FilePatchNotices model={model} t={t} />
      <div className={isMultiFile ? 'space-y-3' : ''}>
        {model.changes.map((change, index) => (
          <FilePatchSection
            key={`${change.kind}:${change.path ?? ''}:${change.movePath ?? ''}:${index}`}
            change={change}
            index={index}
            path={pathPresentations[index]}
            actionPath={change.movePath && moveTargetApplied ? change.movePath : change.path}
            initialRowBudget={initialRowBudgets[index]}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

function RawFilePatchResult({
  result,
  hasHiddenContent: hasSpilledContent,
  t,
}: {
  result: string;
  hasHiddenContent?: boolean;
  t: ChatTranslator;
}) {
  const hasHiddenContent = hasSpilledContent || result.length > FILE_PATCH_MAX_CHARACTER_BUDGET;
  return (
    <section className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-elevated)] shadow-[var(--shadow-xs)]">
      <div className="flex items-center gap-2 border-b border-[var(--line-subtle)] px-3 py-2 text-xs font-medium text-[var(--ink-muted)]">
        <Info className="size-3.5" aria-hidden="true" />
        {t('shell.toolChrome.filePatch.rawResult')}
        {hasHiddenContent && (
          <span className="ml-auto text-[var(--warning)]">
            {t('shell.toolChrome.filePatch.boundedPreview')}
          </span>
        )}
      </div>
      <ExpandableResult
        content={hasHiddenContent ? result.slice(0, FILE_PATCH_MAX_CHARACTER_BUDGET) : result}
        fade="paper-elevated"
        className="px-3 py-2.5 text-[var(--ink-secondary)]"
      />
    </section>
  );
}

function FilePatchNotices({ model, t }: { model: FilePatchRenderModel; t: ChatTranslator }) {
  const notices: Array<{ key: string; label: string; tone: 'error' | 'warning' | 'info' }> = [];
  if (model.status && model.status !== 'completed') {
    notices.push({
      key: `status:${model.status}`,
      label: statusLabel(model.status, t),
      tone: model.status === 'failed' || model.status === 'declined' ? 'error' : 'warning',
    });
  }
  if (model.replaceAll) {
    notices.push({ key: 'replace-all', label: t('shell.toolChrome.filePatch.replaceAll'), tone: 'warning' });
  }
  if (model.userModified) {
    notices.push({ key: 'user-modified', label: t('shell.toolChrome.filePatch.userModified'), tone: 'info' });
  }
  if (model.hasHiddenContent) {
    notices.push({
      key: 'bounded-preview',
      label: t('shell.toolChrome.filePatch.boundedPreview'),
      tone: 'warning',
    });
  }
  if (notices.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label={notices.map((notice) => notice.label).join(', ')}>
      {notices.map((notice) => (
        <span
          key={notice.key}
          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${noticeToneClass(notice.tone)}`}
        >
          {notice.label}
        </span>
      ))}
    </div>
  );
}

function statusLabel(status: string, t: ChatTranslator): string {
  const known = new Set(['declined', 'failed', 'stopped', 'interrupted', 'running']);
  return known.has(status)
    ? t(`shell.toolChrome.filePatch.status.${status}`)
    : t('shell.toolChrome.filePatch.status.unknown', { status });
}

function noticeToneClass(tone: 'error' | 'warning' | 'info'): string {
  if (tone === 'error') return 'border-[var(--error)]/25 bg-[var(--error-bg)] text-[var(--error)]';
  if (tone === 'warning') return 'border-[var(--warning)]/25 bg-[var(--warning-bg)] text-[var(--warning)]';
  return 'border-[var(--info)]/25 bg-[var(--info-bg)] text-[var(--info)]';
}

function FilePatchSection({
  change,
  index,
  path,
  actionPath,
  initialRowBudget,
  t,
}: {
  change: FilePatchRenderChange;
  index: number;
  path: FilePathPresentation;
  actionPath?: string;
  initialRowBudget: number;
  t: ChatTranslator;
}) {
  const instanceId = useId();
  const movePath = change.movePath ? pathPresentation(change.movePath, t) : null;
  const headingId = `file-patch-${safeDomId(instanceId)}-${index}-${safeDomId(path.fileName)}`;
  const showsPreviousVersionNotice = change.kind === 'write'
    && change.written !== undefined
    && change.added === 0
    && change.removed === 0;

  return (
    <section
      aria-labelledby={headingId}
      data-file-patch-path={change.path ?? ''}
      className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-elevated)] shadow-[var(--shadow-xs)]"
    >
      <header className="flex min-h-12 flex-wrap items-center gap-2.5 border-b border-[var(--line-subtle)] px-3 py-2 sm:flex-nowrap">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-subtle)] text-[var(--accent)]">
          <FileText className="size-4" aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1 basis-[calc(100%-2.5rem)] sm:basis-auto" title={change.path}>
          <div className="flex min-w-0 items-center gap-1.5">
            <h3
              id={headingId}
              aria-label={path.accessibleName}
              className="truncate font-mono text-sm font-semibold text-[var(--ink)]"
            >
              {path.fileName}
            </h3>
            {movePath && (
              <>
                <span className="sr-only">{t('shell.toolChrome.filePatch.moveTo', { path: movePath.fileName })}</span>
                <ArrowRight className="size-3.5 shrink-0 text-[var(--ink-muted)]" aria-hidden="true" />
                <span className="truncate font-mono text-sm font-semibold text-[var(--ink)]" title={change.movePath}>
                  {movePath.fileName}
                </span>
              </>
            )}
          </div>
          {(path.parent || movePath?.parent) && (
            <p className="truncate font-mono text-xs text-[var(--ink-muted)]">
              {path.parent}
              {movePath?.parent && movePath.parent !== path.parent ? ` → ${movePath.parent}` : ''}
            </p>
          )}
        </div>

        <div data-file-patch-actions="true" className="ml-9 flex w-[calc(100%-2.25rem)] min-w-0 items-center justify-end gap-2 sm:ml-0 sm:w-auto sm:shrink-0">
          <span className="inline-flex shrink-0 rounded-full border border-[var(--line)] bg-[var(--paper)] px-2 py-0.5 text-xs font-medium text-[var(--ink-secondary)]">
            {operationLabel(change.kind, t)}
          </span>
          <FileChangeStats change={change} t={t} />
          <FileActionMenuButton path={actionPath} />
        </div>
      </header>

      {showsPreviousVersionNotice && (
        <div className="flex items-center gap-1.5 border-b border-[var(--line-subtle)] bg-[var(--info-bg)] px-3 py-1.5 text-xs text-[var(--info)]">
          <Info className="size-3.5 shrink-0" aria-hidden="true" />
          {t('shell.toolChrome.filePatch.previousVersionUnavailable')}
        </div>
      )}

      <FilePatchViewport
        change={change}
        fileName={path.accessibleName}
        initialRowBudget={initialRowBudget}
        t={t}
      />
    </section>
  );
}

function FileChangeStats({ change, t }: { change: FilePatchRenderChange; t: ChatTranslator }) {
  if (change.written !== undefined && change.added === 0 && change.removed === 0) {
    return (
      <span className="shrink-0 font-mono text-xs text-[var(--ink-muted)]">
        {t('shell.toolChrome.labels.writeLines', { count: change.written })}
      </span>
    );
  }
  if (change.added === 0 && change.removed === 0) {
    return null;
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs">
      <span className="text-[var(--success)]">+{change.added}</span>
      <span className="text-[var(--error)]">−{change.removed}</span>
    </span>
  );
}

function FilePatchViewport({
  change,
  fileName,
  initialRowBudget,
  t,
}: {
  change: FilePatchRenderChange;
  fileName: string;
  initialRowBudget: number;
  t: ChatTranslator;
}) {
  const prismTheme = useResolvedTheme().adapters.prism;
  const syntaxTheme = useMemo<Record<string, CSSProperties>>(() => ({
    ...prismTheme,
    'pre[class*="language-"]': {
      ...prismTheme['pre[class*="language-"]'],
      margin: 0,
      padding: 0,
      overflow: 'visible',
      background: 'transparent',
      textShadow: 'none',
      borderRadius: 0,
      fontFamily: 'var(--font-code)',
      fontSize: 'var(--text-sm)',
      lineHeight: '1.5rem',
    },
    'code[class*="language-"]': {
      ...prismTheme['code[class*="language-"]'],
      display: 'block',
      minWidth: 'max-content',
      background: 'transparent',
      textShadow: 'none',
      fontFamily: 'var(--font-code)',
      fontSize: 'var(--text-sm)',
      lineHeight: '1.5rem',
    },
  }), [prismTheme]);
  const [isExpanded, setIsExpanded] = useState(false);
  const notifyRowLayoutChanged = useNotifyRowLayoutChanged();
  const expandId = useId();
  const truncationId = useId();

  if (change.rows.length === 0) {
    return (
      <div className="flex min-h-16 items-center justify-center px-4 py-5 text-center text-sm text-[var(--ink-muted)]">
        {change.detailUnavailable
          ? t('shell.toolChrome.filePatch.detailUnavailable')
          : change.kind === 'write' && change.written === 0
            ? t('shell.toolChrome.filePatch.emptyWrittenContent')
            : t('shell.toolChrome.filePatch.noTextChanges')}
      </div>
    );
  }

  const renderLimit = isExpanded
    ? MAX_RENDER_ROWS_PER_FILE
    : Math.max(0, initialRowBudget);
  const visibleRows = change.rows.slice(0, renderLimit);
  const initiallyVisibleRowCount = Math.min(
    change.rows.length,
    initialRowBudget,
    INITIAL_VISIBLE_VIEWPORT_ROWS,
  );
  const hiddenRowCount = Math.max(0, change.rows.length - initiallyVisibleRowCount);
  const shouldOfferShowAll = !isExpanded && hiddenRowCount > 0;
  const isHardTruncated = isExpanded
    && (change.rows.length > MAX_RENDER_ROWS_PER_FILE || change.hasHiddenContent === true);
  const language = getPrismLanguage(change.movePath ?? change.path ?? '');
  const canSyntaxHighlight = visibleRows.length <= SYNTAX_HIGHLIGHT_ROW_BUDGET;
  const syntaxSource = canSyntaxHighlight
    ? visibleRows.map((row) => row.kind === 'hunk' || row.kind === 'omission' ? '' : row.text).join('\n')
    : '';
  const shouldSyntaxHighlight = canSyntaxHighlight
    && syntaxSource.length <= SYNTAX_HIGHLIGHT_TEXT_BUDGET;

  const renderRows = (syntaxRows?: SyntaxRendererNode[], stylesheet?: Record<string, CSSProperties>, useInlineStyles?: boolean) => (
    <>
      {visibleRows.map((row, index) => {
        const syntaxNode = syntaxRows?.[index];
        const code = syntaxNode && row.kind !== 'hunk' && row.kind !== 'omission'
          ? createSyntaxElement({
              node: stripTrailingSyntaxNewline(syntaxNode),
              stylesheet: stylesheet ?? {},
              useInlineStyles: useInlineStyles ?? true,
              key: `syntax:${row.key}`,
            })
          : row.text;
        return <DiffRowView key={row.key} row={row} code={code} t={t} />;
      })}
    </>
  );

  return (
    <div className={`relative min-w-0 bg-[var(--paper)] ${shouldOfferShowAll ? 'min-h-24' : ''}`}>
      <div
        data-syntax-highlighted={shouldSyntaxHighlight ? 'true' : 'false'}
        className={`${shouldOfferShowAll ? 'max-h-96 overflow-y-hidden' : ''} overflow-x-auto bg-[var(--paper)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-border)]/25`}
        tabIndex={0}
        aria-label={t('shell.toolChrome.filePatch.diffAria', { file: fileName })}
        aria-describedby={shouldOfferShowAll ? expandId : isHardTruncated ? truncationId : undefined}
      >
        {shouldSyntaxHighlight ? (
          <SyntaxHighlighter
            language={language}
            style={syntaxTheme}
            PreTag="div"
            CodeTag="div"
            customStyle={{ margin: 0, padding: 0, overflow: 'visible', background: 'transparent' }}
            codeTagProps={{ className: 'block min-w-max font-mono' }}
            wrapLongLines={false}
            renderer={({ rows: syntaxRows, stylesheet, useInlineStyles }) => (
              renderRows(syntaxRows, stylesheet, useInlineStyles)
            )}
          >
            {syntaxSource || ' '}
          </SyntaxHighlighter>
        ) : renderRows()}
      </div>

      {shouldOfferShowAll && (
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center justify-end bg-gradient-to-t from-[var(--paper)] via-[var(--paper)]/90 to-[var(--paper-a0)] pb-2 pt-12">
          <span id={expandId} className="mb-1 text-xs text-[var(--ink-muted)]">
            {t('shell.toolChrome.filePatch.remainingLines', { count: hiddenRowCount })}
          </span>
          <button
            type="button"
            data-file-patch-show-all="true"
            aria-label={t('shell.toolChrome.filePatch.showAllForFile', {
              file: fileName,
              count: hiddenRowCount,
            })}
            onClick={() => {
              setIsExpanded(true);
              notifyRowLayoutChanged('expandable-container-expand');
            }}
            className="rounded-full border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-1 text-xs font-medium text-[var(--ink-secondary)] shadow-[var(--shadow-xs)] transition-colors duration-150 hover:border-[var(--ink-subtle)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-border)]/30 motion-reduce:transition-none"
          >
            {t('shell.toolChrome.filePatch.showAll')}
          </button>
        </div>
      )}

      {isHardTruncated && (
        <div
          id={truncationId}
          role="status"
          data-file-patch-truncated="true"
          className="border-t border-[var(--line-subtle)] bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning)]"
        >
          {t('shell.toolChrome.filePatch.onlyFirstLines', { count: MAX_RENDER_ROWS_PER_FILE })}
        </div>
      )}
    </div>
  );
}

function DiffRowView({ row, code, t }: { row: DiffRow; code: ReactNode; t: ChatTranslator }) {
  if (row.kind === 'hunk') {
    if (!row.hunk) return null;
    const oldSpan = t('shell.toolChrome.filePatch.hunkLineCount', { count: row.hunk.oldLines });
    const newSpan = t('shell.toolChrome.filePatch.hunkLineCount', { count: row.hunk.newLines });
    const label = row.hunk.oldStart === row.hunk.newStart
      ? t('shell.toolChrome.filePatch.hunkSameStart', {
          line: row.hunk.oldStart,
          oldSpan,
          newSpan,
        })
      : t('shell.toolChrome.filePatch.hunkMovedStart', {
          oldStart: row.hunk.oldStart,
          newStart: row.hunk.newStart,
          oldSpan,
          newSpan,
        });
    return (
      <div
        data-diff-row="true"
        data-diff-kind="hunk"
        className="min-w-full select-none border-y border-[var(--line-subtle)] bg-[var(--paper-elevated)] px-3 py-1 font-sans text-xs text-[var(--ink-muted)] first:border-t-0"
      >
        {label}
      </div>
    );
  }
  if (row.kind === 'omission') {
    return (
      <div
        data-diff-row="true"
        data-diff-kind="omission"
        className="min-w-full select-none border-y border-[var(--line-subtle)] bg-[var(--paper-elevated)] px-3 py-1 font-mono text-xs italic text-[var(--ink-muted)]"
      >
        {row.text}
      </div>
    );
  }

  const ariaLabel = row.kind === 'add'
    ? t(row.newLine === undefined ? 'shell.toolChrome.filePatch.addedLineUnknown' : 'shell.toolChrome.filePatch.addedLine', { line: row.newLine })
    : row.kind === 'remove'
      ? t(row.oldLine === undefined ? 'shell.toolChrome.filePatch.removedLineUnknown' : 'shell.toolChrome.filePatch.removedLine', { line: row.oldLine })
      : null;

  return (
    <div
      data-diff-row="true"
      data-diff-kind={row.kind}
      className={`grid min-w-full grid-cols-[3.25rem_3.25rem_1.75rem_minmax(12rem,1fr)] border-l-2 font-mono text-sm leading-6 ${diffRowTone(row.kind)}`}
    >
      {ariaLabel && <span className="sr-only select-none">{ariaLabel}</span>}
      <span data-diff-column="old-line" className="select-none border-r border-[var(--line-subtle)] px-2 text-right text-xs leading-6 text-[var(--ink-muted)]" aria-hidden="true">
        {row.oldLine ?? ''}
      </span>
      <span data-diff-column="new-line" className="select-none border-r border-[var(--line-subtle)] px-2 text-right text-xs leading-6 text-[var(--ink-muted)]" aria-hidden="true">
        {row.newLine ?? ''}
      </span>
      <span data-diff-column="marker" className="select-none border-r border-[var(--line-subtle)] text-center font-semibold text-[var(--ink-secondary)]" aria-hidden="true">
        {row.marker}
      </span>
      <span data-diff-column="code" className="block min-w-max whitespace-pre px-3 text-[var(--ink)] select-text">
        {code}
      </span>
    </div>
  );
}

function diffRowTone(kind: DiffRow['kind']): string {
  if (kind === 'add') return 'border-l-[var(--success)] bg-[var(--success-bg)]';
  if (kind === 'remove') return 'border-l-[var(--error)] bg-[var(--error-bg)]';
  return 'border-l-transparent bg-[var(--paper)]';
}

function operationLabel(kind: string, t: ChatTranslator): string {
  const known = new Set(['add', 'update', 'delete', 'move', 'write']);
  return t(`shell.toolChrome.filePatch.operation.${known.has(kind) ? kind : 'change'}`);
}

interface FilePathPresentation {
  fileName: string;
  parent: string;
  accessibleName: string;
}

interface ParsedDisplayPath {
  fileName: string;
  parentParts: string[];
}

function parseDisplayPath(path: string | undefined, t: ChatTranslator): ParsedDisplayPath {
  if (!path?.trim()) {
    return { fileName: t('shell.toolChrome.filePatch.unnamedFile'), parentParts: [] };
  }
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/').filter(Boolean);
  const fileName = parts.pop() || t('shell.toolChrome.filePatch.unnamedFile');
  return { fileName, parentParts: parts };
}

function pathPresentation(path: string | undefined, t: ChatTranslator): FilePathPresentation {
  const parsed = parseDisplayPath(path, t);
  return {
    fileName: parsed.fileName,
    parent: parsed.parentParts.slice(-2).join('/'),
    accessibleName: parsed.fileName,
  };
}

function buildPathPresentations(
  changes: readonly FilePatchRenderChange[],
  t: ChatTranslator,
): FilePathPresentation[] {
  const parsed = changes.map((change) => parseDisplayPath(change.path, t));
  const duplicateIndexes = new Map<string, number[]>();
  parsed.forEach((item, index) => {
    const indexes = duplicateIndexes.get(item.fileName) ?? [];
    indexes.push(index);
    duplicateIndexes.set(item.fileName, indexes);
  });

  return parsed.map((item, index) => {
    const peers = duplicateIndexes.get(item.fileName) ?? [index];
    if (peers.length === 1) {
      return {
        fileName: item.fileName,
        parent: item.parentParts.slice(-2).join('/'),
        accessibleName: item.fileName,
      };
    }

    let depth = 1;
    const maxDepth = Math.max(1, item.parentParts.length);
    while (depth < maxDepth) {
      const suffix = item.parentParts.slice(-depth).join('/');
      const isUnique = peers.every((peerIndex) => (
        peerIndex === index
        || parsed[peerIndex].parentParts.slice(-depth).join('/') !== suffix
      ));
      if (isUnique) break;
      depth++;
    }
    const parent = item.parentParts.slice(-depth).join('/') || '.';
    return {
      fileName: item.fileName,
      parent,
      accessibleName: `${parent}/${item.fileName}`,
    };
  });
}

function allocateInitialRowBudgets(changes: readonly FilePatchRenderChange[]): number[] {
  let remainingToolBudget = INITIAL_ROWS_PER_TOOL;
  return changes.map((change, index) => {
    const remainingFiles = changes.length - index;
    const fairShare = Math.floor(remainingToolBudget / Math.max(1, remainingFiles));
    const budget = Math.min(change.rows.length, INITIAL_ROWS_PER_FILE, fairShare);
    remainingToolBudget -= budget;
    return budget;
  });
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

type SyntaxRendererNode = Parameters<typeof createSyntaxElement>[0]['node'];

function stripTrailingSyntaxNewline(node: SyntaxRendererNode): SyntaxRendererNode {
  if (node.type === 'text' && typeof node.value === 'string') {
    return { ...node, value: node.value.replace(/\n$/, '') };
  }
  if (!node.children?.length) return node;
  const children = [...node.children];
  children[children.length - 1] = stripTrailingSyntaxNewline(children[children.length - 1]);
  return { ...node, children };
}
