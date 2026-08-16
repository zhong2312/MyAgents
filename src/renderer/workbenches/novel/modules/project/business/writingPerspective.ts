export const NOVEL_WRITING_PERSPECTIVES = [
  "first-person",
  "third-person-limited",
  "third-person-omniscient",
  "multiple-perspective",
] as const;

export type NovelWritingPerspective =
  (typeof NOVEL_WRITING_PERSPECTIVES)[number];

export const DEFAULT_NOVEL_WRITING_PERSPECTIVE: NovelWritingPerspective =
  "third-person-limited";

export const NOVEL_WRITING_PERSPECTIVE_OPTIONS = [
  {
    value: "first-person",
    label: "第一人称",
    instruction:
      "只从叙述者的所见、所闻、所感和已知信息展开，不得写出其无法得知的事实。",
  },
  {
    value: "third-person-limited",
    label: "第三人称限知",
    instruction:
      "以当前场景焦点人物为认知边界，避免直接揭示其他人物未说出口的内心与未知事实。",
  },
  {
    value: "third-person-omniscient",
    label: "第三人称全知",
    instruction:
      "可以在必要处切换人物认知并交代全局信息，但必须保持清晰、克制的叙述重心。",
  },
  {
    value: "multiple-perspective",
    label: "多视角",
    instruction:
      "允许在明确的场景或段落边界切换视角；每段必须清楚标明焦点人物，禁止无提示跳转。",
  },
] as const satisfies readonly {
  readonly value: NovelWritingPerspective;
  readonly label: string;
  readonly instruction: string;
}[];

export function getNovelWritingPerspective(value: NovelWritingPerspective) {
  return (
    NOVEL_WRITING_PERSPECTIVE_OPTIONS.find((item) => item.value === value) ??
    NOVEL_WRITING_PERSPECTIVE_OPTIONS[1]
  );
}
