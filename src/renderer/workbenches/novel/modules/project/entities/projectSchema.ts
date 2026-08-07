import { z } from "zod";

import { normalizeWorkbenchStoragePath } from "@/workbench-sdk";

export const NOVEL_SCHEMA_VERSION = 1 as const;
export const MANUSCRIPT_SCHEMA_VERSION = 4 as const;

export const novelKnowledgeGraphSettingsSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export type NovelKnowledgeGraphSettings = z.infer<
  typeof novelKnowledgeGraphSettingsSchema
>;

const rawNovelMetadataSchema = z
  .object({
    schemaVersion: z.literal(NOVEL_SCHEMA_VERSION),
    projectId: z.string().trim().min(1),
    workbenchId: z.literal("io.myagents.novel"),
    projectName: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1),
    genres: z.array(z.string().trim().min(1)).min(1).optional(),
    targetWordCount: z.number().int().positive().optional(),
    targetWordCountMin: z.number().int().positive().optional(),
    targetWordCountMax: z.number().int().positive().optional(),
    chapterWordCount: z.number().int().positive().optional(),
    genre: z.string().trim().min(1).optional(),
    form: z.enum(["blank", "long", "short"]).optional(),
    status: z.enum(["planning", "writing", "completed", "paused"]),
    language: z.string().trim().min(1),
    description: z.string().trim().optional(),
    knowledgeGraph: novelKnowledgeGraphSettingsSchema.optional(),
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
    if (
      (metadata.targetWordCountMin === undefined) !==
      (metadata.targetWordCountMax === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["targetWordCountMin"],
        message: "目标字数区间必须同时提供下限和上限",
      });
    }
    if (
      metadata.targetWordCountMin !== undefined &&
      metadata.targetWordCountMax !== undefined &&
      metadata.targetWordCountMin > metadata.targetWordCountMax
    ) {
      context.addIssue({
        code: "custom",
        path: ["targetWordCountMin"],
        message: "目标字数下限不得大于上限",
      });
    }
  });

export const novelMetadataSchema = rawNovelMetadataSchema.transform(
  (metadata) => ({
    ...metadata,
    projectName: metadata.projectName ?? metadata.title,
    genres: metadata.genres ?? [metadata.genre!],
    targetWordCount: metadata.targetWordCount ?? null,
    targetWordCountMin:
      metadata.targetWordCountMin ?? metadata.targetWordCount ?? null,
    targetWordCountMax:
      metadata.targetWordCountMax ?? metadata.targetWordCount ?? null,
    chapterWordCount: metadata.chapterWordCount ?? null,
    knowledgeGraph: metadata.knowledgeGraph ?? { enabled: false },
  }),
);

export type NovelMetadata = z.infer<typeof novelMetadataSchema>;

export const novelChapterStatusSchema = z.enum([
  "planned",
  "draft",
  "revising",
  "complete",
]);
export type NovelChapterStatus = z.infer<typeof novelChapterStatusSchema>;

export const manuscriptStructureModeSchema = z.enum([
  "free",
  "merged",
  "locked",
]);
export type ManuscriptStructureMode = z.infer<
  typeof manuscriptStructureModeSchema
>;

export const manuscriptTrackingStatusSchema = z.enum([
  "idle",
  // legacy：历史版本可能包含该值，但当前没有任何代码路径产生它；
  // 保留枚举仅为兼容旧数据解析，新状态流转只使用 idle/review/synced/stale/failed。
  "pending",
  "review",
  "synced",
  "stale",
  "failed",
]);
export type ManuscriptTrackingStatus = z.infer<
  typeof manuscriptTrackingStatusSchema
>;

export const manuscriptPlanningModeSchema = z.enum(["reference", "detached"]);
export type ManuscriptPlanningMode = z.infer<
  typeof manuscriptPlanningModeSchema
>;

export const manuscriptDirectoryKindSchema = z.enum([
  "volume",
  "part",
  "folder",
]);
export type ManuscriptDirectoryKind = z.infer<
  typeof manuscriptDirectoryKindSchema
>;

const stableIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]*$/u);

const chapterPathSchema = z.string().transform((path, context) => {
  try {
    const normalized = normalizeWorkbenchStoragePath(path);
    if (!/^manuscript\/chapters\/[0-9]{6}\.md$/.test(normalized)) {
      context.addIssue({
        code: "custom",
        message: "章节路径必须位于 manuscript/chapters/ 并使用六位数字文件名",
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
});

const trashPathSchema = z.string().transform((path, context) => {
  try {
    const normalized = normalizeWorkbenchStoragePath(path);
    if (!/^manuscript\/trash\/[a-z0-9-]+\/[0-9]{6}\.md$/.test(normalized)) {
      context.addIssue({
        code: "custom",
        message: "回收站路径必须位于 manuscript/trash/<删除记录>/",
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
});

const novelChapterRecordV1Schema = z
  .object({
    id: z.string().regex(/^chapter-[0-9]{6}$/),
    number: z.number().int().positive(),
    title: z.string().trim().min(1),
    path: chapterPathSchema,
    status: z.enum(["draft", "complete", "planned"]),
  })
  .strict();

const novelChapterRecordV2Schema = z
  .object({
    id: z.string().regex(/^chapter-[0-9]{6}$/),
    number: z.number().int().positive(),
    title: z.string().trim().min(1),
    path: chapterPathSchema,
    status: novelChapterStatusSchema,
    directoryId: stableIdSchema.nullable(),
    order: z.number().int().nonnegative(),
    narrativeChapterId: stableIdSchema.nullable(),
    trackingStatus: manuscriptTrackingStatusSchema,
    lastTrackedAt: z.string().datetime().nullable(),
  })
  .strict();

const novelChapterRecordV3Schema = novelChapterRecordV2Schema
  .extend({
    displayNumber: z.number().int().positive(),
  })
  .strict();

const deletedNovelChapterV3Schema = novelChapterRecordV3Schema
  .omit({ path: true })
  .extend({
    deletionId: stableIdSchema,
    deletedAt: z.string().datetime(),
    originalPath: chapterPathSchema,
    trashPath: trashPathSchema,
    rollbackBatchIds: z.array(stableIdSchema),
  })
  .strict();

export const novelChapterRecordSchema = novelChapterRecordV2Schema.extend({
  // User-facing sequence number. `number` remains the immutable file serial.
  displayNumber: z.number().int().positive(),
  planningMode: manuscriptPlanningModeSchema.default("reference"),
});

export type NovelChapterRecord = z.infer<typeof novelChapterRecordSchema>;

export const manuscriptDirectorySchema = z
  .object({
    id: stableIdSchema,
    parentId: stableIdSchema.nullable(),
    kind: manuscriptDirectoryKindSchema,
    title: z.string().trim().min(1),
    order: z.number().int().nonnegative(),
    narrativeDirectoryId: stableIdSchema.nullable(),
  })
  .strict();

export type ManuscriptDirectory = z.infer<typeof manuscriptDirectorySchema>;

interface OrderedDirectoryLike {
  readonly id: string;
  readonly parentId: string | null;
  readonly order: number;
}

interface OrderedChapterLike {
  readonly id: string;
  readonly directoryId: string | null;
  readonly order: number;
}

export function orderManuscriptChapters<T extends OrderedChapterLike>(
  directories: readonly OrderedDirectoryLike[],
  chapters: readonly T[],
): T[] {
  const directoriesByParent = new Map<string | null, OrderedDirectoryLike[]>();
  const chaptersByDirectory = new Map<string | null, T[]>();
  for (const directory of directories) {
    const siblings = directoriesByParent.get(directory.parentId) ?? [];
    siblings.push(directory);
    directoriesByParent.set(directory.parentId, siblings);
  }
  for (const chapter of chapters) {
    const siblings = chaptersByDirectory.get(chapter.directoryId) ?? [];
    siblings.push(chapter);
    chaptersByDirectory.set(chapter.directoryId, siblings);
  }
  directoriesByParent.forEach((siblings) =>
    siblings.sort(
      (left, right) =>
        left.order - right.order || left.id.localeCompare(right.id),
    ),
  );
  chaptersByDirectory.forEach((siblings) =>
    siblings.sort(
      (left, right) =>
        left.order - right.order || left.id.localeCompare(right.id),
    ),
  );

  const result: T[] = [];
  const visitedDirectories = new Set<string>();
  const visitedChapters = new Set<string>();
  const append = (parentId: string | null) => {
    for (const directory of directoriesByParent.get(parentId) ?? []) {
      if (visitedDirectories.has(directory.id)) continue;
      visitedDirectories.add(directory.id);
      append(directory.id);
    }
    for (const chapter of chaptersByDirectory.get(parentId) ?? []) {
      if (visitedChapters.has(chapter.id)) continue;
      visitedChapters.add(chapter.id);
      result.push(chapter);
    }
  };
  append(null);

  // Schema validation normally makes these fallbacks unreachable, but keeping
  // every record visible is safer while a project is being repaired manually.
  for (const directory of directories) {
    if (!visitedDirectories.has(directory.id)) append(directory.id);
  }
  for (const chapter of chapters) {
    if (!visitedChapters.has(chapter.id)) result.push(chapter);
  }
  return result;
}

export function manuscriptChapterOrderMap(
  directories: readonly OrderedDirectoryLike[],
  chapters: readonly OrderedChapterLike[],
): ReadonlyMap<string, number> {
  return new Map(
    orderManuscriptChapters(directories, chapters).map((chapter, index) => [
      chapter.id,
      index,
    ]),
  );
}

export const manuscriptTypographySchema = z
  .object({
    fontFamily: z.enum([
      "system-serif",
      "songti",
      "kaiti",
      "fangsong",
      "system-sans",
    ]),
    fontSize: z.number().int().min(14).max(28),
    titleSize: z.number().int().min(22).max(44).default(30),
    lineHeight: z.number().min(1.3).max(2.6),
    paragraphSpacing: z.number().int().min(0).max(40),
    firstLineIndent: z.number().min(0).max(4),
    contentWidth: z.number().int().min(560).max(1000),
    textAlign: z.enum(["left", "justify"]).default("left"),
    paperTone: z.enum(["warm", "white", "gray"]).default("warm"),
  })
  .strict();

export type ManuscriptTypography = z.infer<typeof manuscriptTypographySchema>;

export const DEFAULT_MANUSCRIPT_TYPOGRAPHY: ManuscriptTypography =
  Object.freeze({
    fontFamily: "system-serif",
    fontSize: 18,
    titleSize: 30,
    lineHeight: 1.9,
    paragraphSpacing: 12,
    firstLineIndent: 2,
    contentWidth: 760,
    textAlign: "left",
    paperTone: "warm",
  });

const deletedNovelChapterV2Schema = novelChapterRecordV2Schema
  .omit({ path: true })
  .extend({
    deletionId: stableIdSchema,
    deletedAt: z.string().datetime(),
    originalPath: chapterPathSchema,
    trashPath: trashPathSchema,
    rollbackBatchIds: z.array(stableIdSchema),
  })
  .strict();

export const deletedNovelChapterSchema = novelChapterRecordSchema
  .omit({ path: true })
  .extend({
    deletionId: stableIdSchema,
    deletedAt: z.string().datetime(),
    originalPath: chapterPathSchema,
    trashPath: trashPathSchema,
    rollbackBatchIds: z.array(stableIdSchema),
  })
  .strict();

export type DeletedNovelChapter = z.infer<typeof deletedNovelChapterSchema>;

const novelChapterIndexV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    nextChapterNumber: z.number().int().positive(),
    chapters: z.array(novelChapterRecordV1Schema),
  })
  .strict();

const novelChapterIndexV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    nextChapterNumber: z.number().int().positive(),
    structureMode: manuscriptStructureModeSchema,
    directories: z.array(manuscriptDirectorySchema),
    chapters: z.array(novelChapterRecordV2Schema),
    typography: manuscriptTypographySchema,
    trash: z.array(deletedNovelChapterV2Schema),
  })
  .strict();

const novelChapterIndexV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    nextChapterNumber: z.number().int().positive(),
    structureMode: manuscriptStructureModeSchema,
    directories: z.array(manuscriptDirectorySchema),
    chapters: z.array(novelChapterRecordV3Schema),
    typography: manuscriptTypographySchema,
    trash: z.array(deletedNovelChapterV3Schema),
  })
  .strict();

export const novelChapterIndexSchema = z
  .object({
    schemaVersion: z.literal(MANUSCRIPT_SCHEMA_VERSION),
    nextChapterNumber: z.number().int().positive(),
    structureMode: manuscriptStructureModeSchema,
    directories: z.array(manuscriptDirectorySchema),
    chapters: z.array(novelChapterRecordSchema),
    typography: manuscriptTypographySchema,
    trash: z.array(deletedNovelChapterSchema),
  })
  .strict()
  .superRefine((index, context) => {
    const directoryIds = new Set(index.directories.map((item) => item.id));
    const seenDirectoryIds = new Set<string>();
    const seenNarrativeDirectoryIds = new Set<string>();
    index.directories.forEach((directory, position) => {
      if (seenDirectoryIds.has(directory.id)) {
        context.addIssue({
          code: "custom",
          path: ["directories", position, "id"],
          message: "目录 id 不得重复",
        });
      }
      seenDirectoryIds.add(directory.id);
      if (
        directory.narrativeDirectoryId &&
        seenNarrativeDirectoryIds.has(directory.narrativeDirectoryId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["directories", position, "narrativeDirectoryId"],
          message: "一个剧情目录最多关联一个正文目录",
        });
      }
      if (directory.narrativeDirectoryId) {
        seenNarrativeDirectoryIds.add(directory.narrativeDirectoryId);
      }
      if (directory.parentId && !directoryIds.has(directory.parentId)) {
        context.addIssue({
          code: "custom",
          path: ["directories", position, "parentId"],
          message: "父目录不存在",
        });
      }
      const visited = new Set<string>([directory.id]);
      let parentId = directory.parentId;
      while (parentId) {
        if (visited.has(parentId)) {
          context.addIssue({
            code: "custom",
            path: ["directories", position, "parentId"],
            message: "目录层级不得形成循环",
          });
          break;
        }
        visited.add(parentId);
        parentId =
          index.directories.find((item) => item.id === parentId)?.parentId ??
          null;
      }
    });

    const seenIds = new Set<string>();
    const seenNumbers = new Set<number>();
    const seenPaths = new Set<string>();
    const seenNarrativeChapterIds = new Set<string>();
    const seenNarrativeDisplayNumbers = new Set<number>();
    const seenFreeDisplayNumbers = new Set<number>();
    index.chapters.forEach((chapter, position) => {
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
      const seenDisplayNumbers = chapter.narrativeChapterId
        ? seenNarrativeDisplayNumbers
        : seenFreeDisplayNumbers;
      if (seenDisplayNumbers.has(chapter.displayNumber)) {
        context.addIssue({
          code: "custom",
          path: ["chapters", position, "displayNumber"],
          message: `同一${chapter.narrativeChapterId ? "剧情工程" : "自由正文"}序列的章节显示编号不得重复`,
        });
      }
      if (chapter.directoryId && !directoryIds.has(chapter.directoryId)) {
        context.addIssue({
          code: "custom",
          path: ["chapters", position, "directoryId"],
          message: "章节所属目录不存在",
        });
      }
      if (
        chapter.narrativeChapterId &&
        seenNarrativeChapterIds.has(chapter.narrativeChapterId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["chapters", position, "narrativeChapterId"],
          message: "一份章节规划最多关联一篇正文",
        });
      }
      seenIds.add(chapter.id);
      seenNumbers.add(chapter.number);
      seenPaths.add(chapter.path);
      seenDisplayNumbers.add(chapter.displayNumber);
      if (chapter.narrativeChapterId) {
        seenNarrativeChapterIds.add(chapter.narrativeChapterId);
      }
    });
    const highestNumber = [...index.chapters, ...index.trash].reduce(
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

export function createEmptyNovelChapterIndex(): NovelChapterIndex {
  return {
    schemaVersion: MANUSCRIPT_SCHEMA_VERSION,
    nextChapterNumber: 1,
    structureMode: "free",
    directories: [],
    chapters: [],
    typography: { ...DEFAULT_MANUSCRIPT_TYPOGRAPHY },
    trash: [],
  };
}

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
  const source = parseJson(path, content);
  const v3Result = novelChapterIndexSchema.safeParse(source);
  if (v3Result.success) return v3Result.data;

  const v1Result = novelChapterIndexV1Schema.safeParse(source);
  if (v1Result.success) {
    return novelChapterIndexSchema.parse({
      ...createEmptyNovelChapterIndex(),
      nextChapterNumber: v1Result.data.nextChapterNumber,
      chapters: v1Result.data.chapters.map((chapter, order) => ({
        ...chapter,
        displayNumber: order + 1,
        directoryId: null,
        order,
        narrativeChapterId: null,
        trackingStatus: "idle",
        lastTrackedAt: null,
        planningMode: "reference" as const,
      })),
    });
  }

  const v2Result = novelChapterIndexV2Schema.safeParse(source);
  if (v2Result.success) {
    let linkedDisplayNumber = 0;
    let freeDisplayNumber = 0;
    const displayNumberById = new Map<string, number>();
    orderManuscriptChapters(
      v2Result.data.directories,
      v2Result.data.chapters,
    ).forEach((chapter) => {
      const next = chapter.narrativeChapterId
        ? ++linkedDisplayNumber
        : ++freeDisplayNumber;
      displayNumberById.set(chapter.id, next);
    });
    return novelChapterIndexSchema.parse({
      ...v2Result.data,
      schemaVersion: MANUSCRIPT_SCHEMA_VERSION,
      chapters: v2Result.data.chapters.map((chapter) => ({
        ...chapter,
        displayNumber: displayNumberById.get(chapter.id) ?? chapter.order + 1,
        planningMode: "reference" as const,
      })),
      trash: v2Result.data.trash.map((chapter) => ({
        ...chapter,
        displayNumber: chapter.number,
        planningMode: "reference" as const,
      })),
    });
  }

  const v3SchemaResult = novelChapterIndexV3Schema.safeParse(source);
  if (v3SchemaResult.success) {
    return novelChapterIndexSchema.parse({
      ...v3SchemaResult.data,
      schemaVersion: MANUSCRIPT_SCHEMA_VERSION,
      chapters: v3SchemaResult.data.chapters.map((chapter) => ({
        ...chapter,
        planningMode: "reference" as const,
      })),
      trash: v3SchemaResult.data.trash.map((chapter) => ({
        ...chapter,
        planningMode: "reference" as const,
      })),
    });
  }

  throw new NovelProjectFormatError(path, formatIssues(v3Result.error));
}

export function serializeNovelChapterIndex(index: NovelChapterIndex): string {
  const parsed = novelChapterIndexSchema.parse(index);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
