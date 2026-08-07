import { useState } from 'react';
import { Globe, ExternalLink as ExternalLinkIcon, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ToolUseSimple, WebSearchInput } from '@/types/chat';
import ExternalLink from '@/components/ExternalLink';
import { ExpandableResult } from './utils';

const COLLAPSED_COUNT = 5;

interface WebSearchToolProps {
  tool: ToolUseSimple;
}

interface SearchResult {
  title: string;
  url: string;
}

/**
 * Parse search results from the complex tool_use_result format
 *
 * The actual format is:
 * {
 *   "query": "...",
 *   "results": [
 *     "text string...",
 *     { "tool_use_id": "...", "content": [{ "title": "...", "url": "..." }, ...] },
 *     "more text..."
 *   ]
 * }
 */
function parseSearchResults(resultStr: string): SearchResult[] {
  const results: SearchResult[] = [];

  try {
    const parsed = JSON.parse(resultStr);

    // Handle the nested results format
    if (parsed.results && Array.isArray(parsed.results)) {
      for (const item of parsed.results) {
        // Skip string items (text content)
        if (typeof item === 'string') continue;

        // Extract from { content: [{ title, url }, ...] } format
        if (item && Array.isArray(item.content)) {
          for (const contentItem of item.content) {
            if (contentItem.title && contentItem.url) {
              results.push({
                title: contentItem.title,
                url: contentItem.url,
              });
            }
          }
        }
      }
    }

    // Fallback: try simple array format
    if (results.length === 0 && Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item.title && item.url) {
          results.push({ title: item.title, url: item.url });
        }
      }
    }

    // Fallback: try { results: [{ title, url }] } format
    if (results.length === 0 && parsed.results && Array.isArray(parsed.results)) {
      for (const item of parsed.results) {
        if (typeof item === 'object' && item.title && item.url) {
          results.push({ title: item.title, url: item.url });
        }
      }
    }
  } catch {
    // Parsing failed, return empty array
  }

  return results;
}

export default function WebSearchTool({ tool }: WebSearchToolProps) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const input = tool.parsedInput as WebSearchInput;
  const results = tool.result ? parseSearchResults(tool.result) : [];
  const showRawResult = tool.result && results.length === 0;

  if (!input && !tool.inputJson) {
    return <div className="text-sm text-[var(--ink-muted)]">{t('shell.toolChrome.webSearch.initializing')}</div>;
  }

  let query = input?.query || '';
  if (!query && tool.inputJson) {
    try {
      query = JSON.parse(tool.inputJson).query || '';
    } catch {
      // Invalid JSON, use empty string
    }
  }
  const hasMore = results.length > COLLAPSED_COUNT;
  const visibleResults = expanded ? results : results.slice(0, COLLAPSED_COUNT);
  const hiddenCount = results.length - COLLAPSED_COUNT;

  return (
    <div className="flex flex-col gap-3 font-sans text-sm">
      {/* Search Results */}
      {results.length > 0 && (
        <div className="flex flex-col">
          {visibleResults.map((item) => (
            <ExternalLink
              key={item.url}
              href={item.url}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--paper-inset)] [&:hover_.result-title]:text-[var(--accent)] [&:hover_.result-icon]:opacity-100"
            >
              {/* Globe icon */}
              <Globe className="size-4 shrink-0 text-[var(--ink-muted)]" />

              {/* Title */}
              <span className="result-title flex-1 truncate text-[var(--ink)] transition-colors">
                {item.title}
              </span>

              {/* External link indicator */}
              <ExternalLinkIcon className="result-icon size-3 shrink-0 text-[var(--ink-muted)] opacity-0 transition-opacity" />
            </ExternalLink>
          ))}

          {/* Expand button */}
          {hasMore && !expanded && (
            <button
              onClick={() => setExpanded(true)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-[var(--ink-muted)] hover:text-[var(--ink)] transition-colors"
            >
              <ChevronDown className="size-3" />
              <span>{t('shell.toolChrome.webSearch.expandRemaining', { count: hiddenCount })}</span>
            </button>
          )}
        </div>
      )}

      {/* Raw Output fallback — height-clamped for consistency with other tools */}
      {showRawResult && tool.result && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">{t('shell.toolChrome.webSearch.toolOutput')}</div>
          <ExpandableResult
            content={tool.result}
            className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-inset)] p-3 text-xs text-[var(--ink-secondary)]"
          />
        </div>
      )}

      {/* Loading state if no result yet */}
      {!tool.result && tool.isLoading && (
        <div className="flex items-center gap-2 text-xs text-[var(--ink-muted)] animate-pulse">
          <Globe className="size-3" />
          <span>{t('shell.toolChrome.webSearch.searchingFor', { query })}</span>
        </div>
      )}
    </div>
  );
}
