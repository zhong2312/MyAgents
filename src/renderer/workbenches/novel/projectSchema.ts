import { z } from "zod";

import { normalizeWorkbenchStoragePath } from "@/workbench-sdk";

export const NOVEL_SCHEMA_VERSION = 1 as const;

const rawNovelMetadataSchema = z
  .object({
    schemaVersion: z.literal(NOVEL_SCHEMA_VERSION),
    projectId: z.string().trim().min(1),
    workbenchId: z.literal("io.myagents.novel"),
    title: z.string().trim().min(1),
    genres: z.array(z.string().trim().min(1)).min(1).optional(),
    targetWordCount: z.number().int().positive().optional(),
    genre: z.string().trim().min(1).optional(),
    form: z.enum(["blank", "long", "short"]).optional(),
    status: z.enum(["planning", "writing", "completed", "paused"]),
    language: z.string().trim().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough()
  .superRefine((metadata, context) => {
    if (!metadata.genres && !metadata.genre) {
      context.addIssue({
        code: "custom",
        path: ["genres"],
        message: "至少需要一个小说题材",
      });
    }
    if (
      metadata.genres &&
      new Set(metadata.genres).size !== metadata.genres.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["genres"],
        message: "小说题材不得重复",
      });
    }
  });

export const novelMetadataSchema = rawNovelMetadataSchema.transform(
  (metadata) => ({
    ...metadata,
    genres: metadata.genres ?? [metadata.genre!],
    targetWordCount: metadata.targetWordCount ?? null,
  }),
);

export type NovelMetadata = z.infer<typeof novelMetadataSchema>;

export const novelChapterStatusSchema = z.enum([
  "draft",
  "complete",
  "planned",
]);
export type NovelChapterStatus = z.infer<typeof novelChapterStatusSchema>;

export const novelChapterRecordSchema = z
  .object({
    id: z.string().regex(/^chapter-[0-9]{6}$/),
    number: z.number().int().positive(),
    title: z.string().trim().min(1),
    path: z.string().transform((path, context) => {
      try {
        const normalized = normalizeWorkbenchStoragePath(path);
        if (!/^manuscript\/chapters\/[0-9]{6}\.md$/.test(normalized)) {
          context.addIssue({
            code: "custom",
            message:
              "章节路径必须位于 manuscript/chapters/ 并使用六位数字文件名",
          });
          return z.NEVER;
        }
        return normalized;
      } catch (error) {
        context.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : String(error),
        });
        return z.NEVER;
      }
    }),
    status: novelChapterStatusSchema,
  })
  .strict();

export type NovelChapterRecord = z.infer<typeof novelChapterRecordSchema>;

export const novelChapterIndexSchema = z
  .object({
    schemaVersion: z.literal(NOVEL_SCHEMA_VERSION),
    nextChapterNumber: z.number().int().positive(),
    chapters: z.array(novelChapterRecordSchema),
  })
  .strict()
  .superRefine((index, context) => {
    const seenIds = new Set<string>();
    const seenNumbers = new Set<number>();
    const seenPaths = new Set<string>();
    for (const [position, chapter] of index.chapters.entries()) {
      const serial = String(chapter.number).padStart(6, "0");
      if (chapter.id !== `chapter-${serial}`) {
        context.addIssue({
          code: "custom",
          path: ["chapters", position, "id"],
          message: "章节 id 必须与 number 使用同一六位编号",
        });
      }
      if (chapter.path !== `manuscript/chapters/${serial}.md`) {
        context.addIssue({
          code: "custom",
          path: ["chapters", position, "path"],
          message: "章节 path 必须与 number 使用同一六位编号",
        });
      }
      if (seenIds.has(chapter.id)) {
        context.addIssue({
          code: "custom",
          path: ["chapters", position, "id"],
          message: "章节 id 不得重复",
        });
      }
      if (seenNumbers.has(chapter.number)) {
        context.addIssue({
          code: "custom",
          path: ["chapters", position, "number"],
          message: "章节 number 不得重复",
        });
      }
      if (seenPaths.has(chapter.path)) {
        context.addIssue({
          code: "custom",
          path: ["chapters", position, "path"],
          message: "章节 path 不得重复",
        });
      }
      seenIds.add(chapter.id);
      seenNumbers.add(chapter.number);
      seenPaths.add(chapter.path);
    }
    const highestNumber = index.chapters.reduce(
      (highest, chapter) => Math.max(highest, chapter.number),
      0,
    );
    if (index.nextChapterNumber <= highestNumber) {
      context.addIssue({
        code: "custom",
        path: ["nextChapterNumber"],
        message: "nextChapterNumber 必须大于已有章节编号",
      });
    }
  });

export type NovelChapterIndex = z.infer<typeof novelChapterIndexSchema>;

export class NovelProjectFormatError extends Error {
  constructor(
    readonly filePath: string,
    detail: string,
  ) {
    super(`${filePath} 格式错误：${detail}`);
    this.name = "NovelProjectFormatError";
  }
}

function parseJson(filePath: string, content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new NovelProjectFormatError(
      filePath,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("；");
}

export function parseNovelMetadata(content: string): NovelMetadata {
  const result = novelMetadataSchema.safeParse(
    parseJson("novel.json", content),
  );
  if (!result.success) {
    throw new NovelProjectFormatError("novel.json", formatIssues(result.error));
  }
  return result.data;
}

export function parseNovelChapterIndex(content: string): NovelChapterIndex {
  const path = "manuscript/index.json";
  const result = novelChapterIndexSchema.safeParse(parseJson(path, content));
  if (!result.success) {
    throw new NovelProjectFormatError(path, formatIssues(result.error));
  }
  return result.data;
}

export function serializeNovelChapterIndex(index: NovelChapterIndex): string {
  const parsed = novelChapterIndexSchema.parse(index);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
