
import { MoreHorizontal } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContentBlock } from '@/types/chat';
import { useNotifyRowLayoutChanged } from '@/context/ChatRowLayoutContext';
import ProcessRow from './ProcessRow';

interface BlockGroupProps {
  blocks: ContentBlock[];
  isLatestActiveSection?: boolean;
  isStreaming?: boolean;
}

/** 1 head + N folded + 1 tail — collapsed view is capped at 3 rows. */
const FOLD_THRESHOLD = 4;
const VISIBLE_HEAD = 1;
const VISIBLE_TAIL = 1;

const BlockGroup = memo(function BlockGroup({
  blocks,
  isLatestActiveSection = false,
  isStreaming = false
}: BlockGroupProps) {
  const { t } = useTranslation('app');
  const [isUnfolded, setIsUnfolded] = useState(false);
  const notifyRowLayoutChanged = useNotifyRowLayoutChanged();

  // When the user expands any row, pin the group open (same effect as clicking
  // 「展开全部」) so the auto-fold never unmounts the row they just opened and
  // silently drops its expanded state. Stable identity keeps ProcessRow's memo.
  const handleChildExpand = useCallback(() => {
    notifyRowLayoutChanged('block-group-expand');
    setIsUnfolded(true);
  }, [notifyRowLayoutChanged]);

  if (blocks.length === 0) return null;

  const isStreamingActive = isStreaming && isLatestActiveSection;
  const shouldFold = !isUnfolded && blocks.length >= FOLD_THRESHOLD;
  const foldedCount = shouldFold ? blocks.length - VISIBLE_HEAD - VISIBLE_TAIL : 0;

  // Collapsible layout: activates 1 step before FOLD_THRESHOLD so the DOM structure
  // is already stable when folding triggers, enabling smooth CSS Grid transition.
  if (blocks.length > VISIBLE_HEAD + VISIBLE_TAIL) {
    return (
      <div className="my-3 overflow-hidden rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-inset)]/30 transition-all select-none">
        <div className="flex flex-col">
          {/* Head: first block — always visible */}
          {blocks.slice(0, VISIBLE_HEAD).map((block, i) => (
            <ProcessRow
              key={i}
              block={block}
              index={i}
              totalBlocks={blocks.length}
              isStreaming={isStreamingActive}
              onUserExpand={handleChildExpand}
            />
          ))}

          {/* Middle: collapsible zone — Pattern 3 §3.2.3 (Collapse = unmount).
              Folded rows are not rendered at all; previously they mounted
              behind `gridTemplateRows: 0fr` and burned re-render cost on
              every streaming delta. The fold-bar below replaces them when
              `shouldFold` is true; tail rows always stay mounted. */}
          {!shouldFold && (
            <div className="grid grid-rows-[1fr] transition-[grid-template-rows] duration-200 ease-out">
              <div className="overflow-hidden">
                {blocks.slice(VISIBLE_HEAD, -VISIBLE_TAIL).map((block, i) => {
                  const index = VISIBLE_HEAD + i;
                  return (
                    <ProcessRow
                      key={index}
                      block={block}
                      index={index}
                      totalBlocks={blocks.length}
                      isStreaming={isStreamingActive}
                      onUserExpand={handleChildExpand}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {/* Fold bar: inversely animated — appears as middle collapses */}
          <div
            className="grid transition-[grid-template-rows] duration-200 ease-out"
            style={{ gridTemplateRows: shouldFold ? '1fr' : '0fr' }}
            aria-hidden={!shouldFold}
            inert={!shouldFold}
          >
            <div className="overflow-hidden">
              <button
                type="button"
                onClick={() => {
                  notifyRowLayoutChanged('block-group-expand');
                  setIsUnfolded(true);
                }}
                className="group/fold flex w-full items-center gap-3 border-b border-[var(--line-subtle)] px-4 py-2 text-left transition-colors cursor-pointer hover:bg-[var(--hover-bg)]"
              >
                <div className="size-1.5 shrink-0" />
                <div className="flex size-4 shrink-0 items-center justify-center text-[var(--ink-muted)]">
                  <MoreHorizontal className="size-4" />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-[var(--ink-muted)] group-hover/fold:text-[var(--ink-secondary)] transition-colors">
                    {t('blockGroup.expandAll')}
                  </span>
                  <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-[var(--accent)]/15 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-[var(--accent)]">
                    +{foldedCount}
                  </span>
                </div>
              </button>
            </div>
          </div>

          {/* Tail: last block — always visible */}
          {blocks.slice(-VISIBLE_TAIL).map((block, i) => {
            const index = blocks.length - VISIBLE_TAIL + i;
            return (
              <ProcessRow
                key={index}
                block={block}
                index={index}
                totalBlocks={blocks.length}
                isStreaming={isStreamingActive}
                onUserExpand={handleChildExpand}
              />
            );
          })}
        </div>
      </div>
    );
  }

  // Flat layout for small block groups (≤2 blocks)
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-inset)]/30 transition-all select-none">
      <div className="flex flex-col">
        {blocks.map((block, index) => (
          <ProcessRow
            key={index}
            block={block}
            index={index}
            totalBlocks={blocks.length}
            isStreaming={isStreamingActive}
            onUserExpand={handleChildExpand}
          />
        ))}
      </div>
    </div>
  );
});

export default BlockGroup;
