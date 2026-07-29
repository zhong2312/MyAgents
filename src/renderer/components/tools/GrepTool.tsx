import type { GrepInput, ToolUseSimple } from '@/types/chat';
import { useTranslation } from 'react-i18next';

import { getToolSummaryNode, parseGrepStats } from './toolBadgeConfig';
import { ExpandableResult, InlineCode, ToolHeader } from './utils';

interface GrepToolProps {
  tool: ToolUseSimple;
}

export default function GrepTool({ tool }: GrepToolProps) {
  const { t } = useTranslation('chat');
  const input = tool.parsedInput as GrepInput;

  if (!input) {
    return (
      <div className="my-0.5">
        <ToolHeader tool={tool} toolName={tool.name} />
      </div>
    );
  }

  const summary = getToolSummaryNode(tool);
  const stats = parseGrepStats(tool.result);
  const resultRange = getGrepResultRange(stats);

  return (
    <div className="space-y-2">
      {/* Inner header (B2): pattern + path + summary chip, no tool name */}
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <InlineCode>{input.pattern}</InlineCode>
        {input.path && (
          <span className="text-xs text-[var(--ink-muted)]">in {input.path}</span>
        )}
        {summary}
      </div>

      {resultRange && (
        <div
          role="status"
          className="rounded bg-[var(--warning-bg)] px-2 py-1 text-xs text-[var(--warning)]"
        >
          {t(
            resultRange.kind === 'lines'
              ? 'shell.toolChrome.grep.partialLines'
              : 'shell.toolChrome.grep.partialFiles',
            resultRange,
          )}
        </div>
      )}

      {tool.result && (
        <ExpandableResult
          content={tool.result}
          className="rounded bg-[var(--paper-inset)]/50 px-2 py-1 wrap-break-word text-[var(--ink-secondary)]"
        />
      )}
    </div>
  );
}

function getGrepResultRange(stats: ReturnType<typeof parseGrepStats>): {
  kind: 'lines' | 'files';
  start: number;
  end: number;
  total: number;
} | null {
  if (!stats) return null;
  const kind = stats.totalLines !== undefined ? 'lines' : 'files';
  const total = kind === 'lines' ? stats.totalLines : stats.totalFiles;
  if (total === undefined) return null;
  const returned = kind === 'lines' ? stats.returnedLines ?? stats.matches : stats.files;
  const offset = stats.appliedOffset ?? 0;
  if (
    !Number.isSafeInteger(total) || total < 0
    || !Number.isSafeInteger(returned) || returned < 0
    || !Number.isSafeInteger(offset) || offset < 0 || offset > total
  ) return null;
  const end = Math.min(total, offset + returned);
  const isPartial = offset > 0 || end < total;
  if (!isPartial) return null;
  return {
    kind,
    start: returned > 0 ? offset + 1 : 0,
    end,
    total,
  };
}
