import type { NovelMetadata } from "../entities/projectSchema";
import { getNovelWritingPerspective } from "./writingPerspective";

function formatWordCount(value: number | null): string {
  return value === null ? "未设置" : `${value.toLocaleString()} 字`;
}

/**
 * 所有小说工作台 AI 请求共用的项目级事实与硬约束。
 * 这段内容属于系统提示词，而非可由单次任务覆盖的作者临时要求。
 */
export function formatNovelOverviewContext(
  metadata: Pick<
    NovelMetadata,
    | "title"
    | "genres"
    | "targetWordCountMin"
    | "targetWordCountMax"
    | "chapterWordCount"
    | "language"
    | "description"
    | "writingPerspective"
  >,
): string {
  const perspective = getNovelWritingPerspective(metadata.writingPerspective);
  const totalWordCount =
    metadata.targetWordCountMin === metadata.targetWordCountMax
      ? formatWordCount(metadata.targetWordCountMin)
      : `${formatWordCount(metadata.targetWordCountMin)} 至 ${formatWordCount(metadata.targetWordCountMax)}`;
  const chapterRange =
    metadata.targetWordCountMin !== null &&
    metadata.targetWordCountMax !== null &&
    metadata.chapterWordCount !== null
      ? `${Math.ceil(metadata.targetWordCountMin / metadata.chapterWordCount)} 至 ${Math.ceil(metadata.targetWordCountMax / metadata.chapterWordCount)} 章`
      : "未设置";
  return [
    "【小说总览：所有生成必须遵守】",
    `书名：${metadata.title}`,
    `题材：${metadata.genres.join("、") || "未设置"}`,
    `创作语言：${metadata.language}`,
    `总字数目标：${totalWordCount}`,
    `每章目标字数：${formatWordCount(metadata.chapterWordCount)}`,
    `预计章节规模：${chapterRange}`,
    `写作视角：${perspective.label}。${perspective.instruction}`,
    metadata.description?.trim()
      ? `本书简介：${metadata.description.trim()}`
      : "本书简介：未设置",
    "生成的方案、设定、剧情、对话和正文必须与以上总览一致。局部任务不得推翻题材、视角、篇幅、语言或简介中的核心前提；信息不足时保持已有事实，不得自行改写总览。",
  ].join("\n");
}

export function appendNovelOverviewContext(
  metadata: Parameters<typeof formatNovelOverviewContext>[0],
  prompt: string | undefined,
): string {
  return [formatNovelOverviewContext(metadata), prompt?.trim() ?? ""]
    .filter(Boolean)
    .join("\n\n");
}
