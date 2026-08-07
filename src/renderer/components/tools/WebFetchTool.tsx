import type { ToolUseSimple, WebFetchInput } from '@/types/chat';

import ExternalLink from '@/components/ExternalLink';
import { ExpandableResult, ToolHeader } from './utils';

interface WebFetchToolProps {
  tool: ToolUseSimple;
}

export default function WebFetchTool({ tool }: WebFetchToolProps) {
  const input = tool.parsedInput as WebFetchInput;

  if (!input) {
    return (
      <div className="my-0.5">
        <ToolHeader tool={tool} toolName={tool.name} />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Inner header (B2): URL link + prompt — no tool name */}
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <ExternalLink
          href={input.url}
          onClick={(e) => e.stopPropagation()}
          className="rounded border border-[var(--line-subtle)] bg-[var(--paper-inset)]/50 px-1.5 py-0.5 font-mono text-xs text-[var(--accent)] hover:text-[var(--accent-warm-hover)] hover:underline"
        >
          {input.url}
        </ExternalLink>
        {input.prompt && (
          <span className="text-xs text-[var(--ink-muted)]">{input.prompt}</span>
        )}
      </div>

      {tool.result && (
        <ExpandableResult
          content={tool.result}
          className="rounded bg-[var(--paper-inset)]/50 px-2 py-1 break-words text-[var(--ink-secondary)]"
        />
      )}
    </div>
  );
}
