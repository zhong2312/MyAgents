import { Calculator } from "lucide-react";

import {
  MAX_CHAPTER_WORD_COUNT,
  MAX_TARGET_WORD_COUNT_WAN,
  MIN_CHAPTER_WORD_COUNT,
  MIN_TARGET_WORD_COUNT_WAN,
  estimateChapterRange,
  parseChapterWordCount,
  parseNovelPlanningInput,
  parseWanWordCount,
} from "./projectPlanning";

interface NovelPlanningFieldsProps {
  readonly idPrefix: string;
  readonly targetWordCountMinWan: string;
  readonly targetWordCountMaxWan: string;
  readonly chapterWordCount: string;
  readonly disabled?: boolean;
  onTargetWordCountMinWanChange(value: string): void;
  onTargetWordCountMaxWanChange(value: string): void;
  onChapterWordCountChange(value: string): void;
}

export default function NovelPlanningFields({
  idPrefix,
  targetWordCountMinWan,
  targetWordCountMaxWan,
  chapterWordCount,
  disabled = false,
  onTargetWordCountMinWanChange,
  onTargetWordCountMaxWanChange,
  onChapterWordCountChange,
}: NovelPlanningFieldsProps) {
  const parsedMin = parseWanWordCount(targetWordCountMinWan);
  const parsedMax = parseWanWordCount(targetWordCountMaxWan);
  const parsedChapterWords = parseChapterWordCount(chapterWordCount);
  const planning = parseNovelPlanningInput(
    targetWordCountMinWan,
    targetWordCountMaxWan,
    chapterWordCount,
  );
  const estimatedChapters = planning ? estimateChapterRange(planning) : null;
  const hasReversedRange =
    parsedMin !== null && parsedMax !== null && parsedMin > parsedMax;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2 max-sm:grid-cols-1">
        <div>
          <label
            htmlFor={`${idPrefix}-target-min`}
            className="mb-2 block text-sm font-medium text-[var(--ink)]"
          >
            总字数下限
          </label>
          <div className="relative">
            <input
              id={`${idPrefix}-target-min`}
              aria-label="总字数下限"
              type="number"
              min={MIN_TARGET_WORD_COUNT_WAN}
              max={MAX_TARGET_WORD_COUNT_WAN}
              step="0.1"
              inputMode="decimal"
              value={targetWordCountMinWan}
              disabled={disabled}
              onChange={(event) =>
                onTargetWordCountMinWanChange(event.target.value)
              }
              aria-invalid={parsedMin === null || hasReversedRange}
              className="h-10 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 pr-12 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)] aria-invalid:border-[var(--error)] disabled:opacity-50"
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-[var(--ink-muted)]">
              万字
            </span>
          </div>
        </div>
        <span className="mb-2.5 text-sm text-[var(--ink-muted)] max-sm:mb-0 max-sm:text-center">
          至
        </span>
        <div>
          <label
            htmlFor={`${idPrefix}-target-max`}
            className="mb-2 block text-sm font-medium text-[var(--ink)]"
          >
            总字数上限
          </label>
          <div className="relative">
            <input
              id={`${idPrefix}-target-max`}
              aria-label="总字数上限"
              type="number"
              min={MIN_TARGET_WORD_COUNT_WAN}
              max={MAX_TARGET_WORD_COUNT_WAN}
              step="0.1"
              inputMode="decimal"
              value={targetWordCountMaxWan}
              disabled={disabled}
              onChange={(event) =>
                onTargetWordCountMaxWanChange(event.target.value)
              }
              aria-invalid={parsedMax === null || hasReversedRange}
              className="h-10 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 pr-12 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)] aria-invalid:border-[var(--error)] disabled:opacity-50"
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-[var(--ink-muted)]">
              万字
            </span>
          </div>
        </div>
      </div>
      {hasReversedRange && (
        <p className="text-xs text-[var(--error)]" role="alert">
          总字数下限不能大于上限
        </p>
      )}
      <div className="grid grid-cols-2 items-end gap-4 max-sm:grid-cols-1">
        <div>
          <label
            htmlFor={`${idPrefix}-chapter-words`}
            className="mb-2 block text-sm font-medium text-[var(--ink)]"
          >
            每章字数
          </label>
          <div className="relative">
            <input
              id={`${idPrefix}-chapter-words`}
              type="number"
              min={MIN_CHAPTER_WORD_COUNT}
              max={MAX_CHAPTER_WORD_COUNT}
              step="100"
              inputMode="numeric"
              value={chapterWordCount}
              disabled={disabled}
              onChange={(event) => onChapterWordCountChange(event.target.value)}
              aria-invalid={parsedChapterWords === null}
              className="h-10 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 pr-9 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)] aria-invalid:border-[var(--error)] disabled:opacity-50"
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-[var(--ink-muted)]">
              字
            </span>
          </div>
        </div>
        <div
          className="flex h-10 items-center gap-2 rounded-md border border-[var(--line-subtle)] bg-[var(--accent-warm-subtle)] px-3 text-sm"
          aria-live="polite"
        >
          <Calculator className="h-3.5 w-3.5 shrink-0 text-[var(--accent-warm)]" />
          <span className="text-[var(--ink-muted)]">预计章节</span>
          <strong className="ml-auto font-semibold text-[var(--ink)]">
            {estimatedChapters
              ? `${estimatedChapters.min.toLocaleString()} 至 ${estimatedChapters.max.toLocaleString()} 章`
              : "待计算"}
          </strong>
        </div>
      </div>
    </div>
  );
}
