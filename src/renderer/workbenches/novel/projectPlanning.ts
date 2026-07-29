export const DEFAULT_TARGET_WORD_COUNT_MIN_WAN = "80";
export const DEFAULT_TARGET_WORD_COUNT_MAX_WAN = "120";
export const DEFAULT_CHAPTER_WORD_COUNT = "3000";

export const MIN_TARGET_WORD_COUNT_WAN = 0.1;
export const MAX_TARGET_WORD_COUNT_WAN = 10_000;
export const MIN_CHAPTER_WORD_COUNT = 100;
export const MAX_CHAPTER_WORD_COUNT = 100_000;

export interface NovelPlanningInput {
  readonly targetWordCountMin: number;
  readonly targetWordCountMax: number;
  readonly chapterWordCount: number;
}

export interface EstimatedChapterRange {
  readonly min: number;
  readonly max: number;
}

export function parseWanWordCount(value: string): number | null {
  const parsed = Number(value);
  if (
    !value.trim() ||
    !Number.isFinite(parsed) ||
    parsed < MIN_TARGET_WORD_COUNT_WAN ||
    parsed > MAX_TARGET_WORD_COUNT_WAN
  ) {
    return null;
  }
  return Math.round(parsed * 10_000);
}

export function parseChapterWordCount(value: string): number | null {
  const parsed = Number(value);
  if (
    !value.trim() ||
    !Number.isInteger(parsed) ||
    parsed < MIN_CHAPTER_WORD_COUNT ||
    parsed > MAX_CHAPTER_WORD_COUNT
  ) {
    return null;
  }
  return parsed;
}

export function parseNovelPlanningInput(
  targetWordCountMinWan: string,
  targetWordCountMaxWan: string,
  chapterWordCount: string,
): NovelPlanningInput | null {
  const targetWordCountMin = parseWanWordCount(targetWordCountMinWan);
  const targetWordCountMax = parseWanWordCount(targetWordCountMaxWan);
  const parsedChapterWordCount = parseChapterWordCount(chapterWordCount);
  if (
    targetWordCountMin === null ||
    targetWordCountMax === null ||
    parsedChapterWordCount === null ||
    targetWordCountMin > targetWordCountMax
  ) {
    return null;
  }
  return {
    targetWordCountMin,
    targetWordCountMax,
    chapterWordCount: parsedChapterWordCount,
  };
}

export function estimateChapterRange(
  input: NovelPlanningInput,
): EstimatedChapterRange {
  return {
    min: Math.ceil(input.targetWordCountMin / input.chapterWordCount),
    max: Math.ceil(input.targetWordCountMax / input.chapterWordCount),
  };
}

export function formatWordCountInWan(wordCount: number): string {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 2,
  }).format(wordCount / 10_000);
}

export function wordCountToWanInput(wordCount: number): string {
  return String(Number((wordCount / 10_000).toFixed(4)));
}
