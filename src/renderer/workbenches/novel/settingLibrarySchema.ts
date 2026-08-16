import { z } from "zod";

import { normalizeWorkbenchStoragePath } from "@/workbench-sdk";

import { SETTING_LIBRARY_SCHEMA_VERSION } from "./settingLibraryDefaults";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const sourceSchema = z.enum(["builtin", "project"]);

export const levelTypeSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    description: z.string(),
    icon: z.string().trim().min(1),
    mapKind: z.enum([
      "cosmic-region",
      "stellar-region",
      "planet-point",
      "geographic-area",
      "settlement-point",
      "hidden",
    ]),
    source: sourceSchema,
    suggestedParentTypeIds: z.array(idSchema),
    suggestedChildTypeIds: z.array(idSchema),
    archived: z.boolean().optional(),
  })
  .strict();

export type LevelType = z.infer<typeof levelTypeSchema>;

export const settingTemplateSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    group: z.string().trim().min(1),
    description: z.string(),
    source: sourceSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    skeleton: z.string(),
    agentGuide: z.string(),
    archived: z.boolean().optional(),
  })
  .strict();

export type SettingTemplate = z.infer<typeof settingTemplateSchema>;

export const levelTypeSettingProfileSchema = z
  .object({
    levelTypeId: idSchema,
    templateIds: z.array(idSchema),
  })
  .strict();

export type LevelTypeSettingProfile = z.infer<
  typeof levelTypeSettingProfileSchema
>;

export const settingLibraryMetaSchema = z
  .object({
    schemaVersion: z.literal(SETTING_LIBRARY_SCHEMA_VERSION),
    levelTypes: z.array(levelTypeSchema).min(1),
    settingTemplates: z.array(settingTemplateSchema),
    profiles: z.array(levelTypeSettingProfileSchema),
  })
  .strict()
  .superRefine((meta, context) => {
    const typeIds = new Set<string>();
    const templateIds = new Set<string>();
    const profileTypeIds = new Set<string>();
    meta.levelTypes.forEach((type, index) => {
      if (typeIds.has(type.id)) {
        context.addIssue({
          code: "custom",
          path: ["levelTypes", index, "id"],
          message: "层级类型 id 不得重复",
        });
      }
      typeIds.add(type.id);
    });
    meta.settingTemplates.forEach((template, index) => {
      if (templateIds.has(template.id)) {
        context.addIssue({
          code: "custom",
          path: ["settingTemplates", index, "id"],
          message: "设定模板 id 不得重复",
        });
      }
      templateIds.add(template.id);
    });
    meta.levelTypes.forEach((type, index) => {
      [...type.suggestedParentTypeIds, ...type.suggestedChildTypeIds].forEach(
        (reference) => {
          if (!typeIds.has(reference)) {
            context.addIssue({
              code: "custom",
              path: ["levelTypes", index],
              message: `引用了不存在的层级类型：${reference}`,
            });
          }
        },
      );
    });
    meta.profiles.forEach((profile, index) => {
      if (profileTypeIds.has(profile.levelTypeId)) {
        context.addIssue({
          code: "custom",
          path: ["profiles", index, "levelTypeId"],
          message: "同一层级类型只能有一份模板关联",
        });
      }
      profileTypeIds.add(profile.levelTypeId);
      if (!typeIds.has(profile.levelTypeId)) {
        context.addIssue({
          code: "custom",
          path: ["profiles", index, "levelTypeId"],
          message: "关联的层级类型不存在",
        });
      }
      const seen = new Set<string>();
      profile.templateIds.forEach((templateId, templateIndex) => {
        if (!templateIds.has(templateId)) {
          context.addIssue({
            code: "custom",
            path: ["profiles", index, "templateIds", templateIndex],
            message: "关联的设定模板不存在",
          });
        }
        if (seen.has(templateId)) {
          context.addIssue({
            code: "custom",
            path: ["profiles", index, "templateIds", templateIndex],
            message: "模板关联不得重复",
          });
        }
        seen.add(templateId);
      });
    });
  });

export type SettingLibraryMeta = z.infer<typeof settingLibraryMetaSchema>;

export const spatialNodeSchema = z
  .object({
    id: idSchema,
    parentId: idSchema.nullable(),
    name: z.string().trim().min(1),
    typeId: idSchema,
    order: z.number().int().nonnegative(),
  })
  .strict();

export type SpatialNode = z.infer<typeof spatialNodeSchema>;

export const settingLibrarySpatialTreeSchema = z
  .object({
    schemaVersion: z.literal(SETTING_LIBRARY_SCHEMA_VERSION),
    nodes: z.array(spatialNodeSchema).min(1),
  })
  .strict()
  .superRefine((tree, context) => {
    const ids = new Set<string>();
    tree.nodes.forEach((node, index) => {
      if (ids.has(node.id)) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "id"],
          message: "空间节点 id 不得重复",
        });
      }
      ids.add(node.id);
    });
    tree.nodes.forEach((node, index) => {
      if (node.parentId !== null && !ids.has(node.parentId)) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "parentId"],
          message: "父节点不存在",
        });
      }
      const visited = new Set([node.id]);
      let parentId = node.parentId;
      while (parentId !== null) {
        if (visited.has(parentId)) {
          context.addIssue({
            code: "custom",
            path: ["nodes", index, "parentId"],
            message: "空间树不得包含循环引用",
          });
          break;
        }
        visited.add(parentId);
        parentId =
          tree.nodes.find((item) => item.id === parentId)?.parentId ?? null;
      }
    });
  });

export type SettingLibrarySpatialTree = z.infer<
  typeof settingLibrarySpatialTreeSchema
>;

function settingFilePath(kind: "pages" | "entries") {
  return z.string().transform((path, context) => {
    try {
      const normalized = normalizeWorkbenchStoragePath(path);
      const extension = kind === "pages" ? "md" : "json";
      const pattern = new RegExp(
        `^world/setting-library/${kind}/[a-z0-9-]+/[a-z0-9-]+\\.${extension}$`,
      );
      if (!pattern.test(normalized)) {
        // 带上期望格式与实际值：仅说“非法entries文件路径”时，作者无法判断是
        // 目录放错、扩展名写错，还是 id 含大写/下划线等非法字符。
        context.addIssue({
          code: "custom",
          message: `路径必须形如 world/setting-library/${kind}/<nodeId>/<settingId>.${extension}（nodeId 与 settingId 只能用小写字母、数字和连字符），当前为 ${normalized}`,
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
}

export const settingInstanceSchema = z
  .object({
    id: idSchema,
    nodeId: idSchema,
    templateId: idSchema.nullable(),
    /** 落盘时模板的 version；用于提示“页面基于旧版模板”。旧数据可能缺失。 */
    templateVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .optional(),
    name: z.string().trim().min(1),
    group: z.string().trim().min(1),
    status: z.enum(["draft", "completed"]),
    pagePath: settingFilePath("pages"),
    entriesPath: settingFilePath("entries"),
  })
  .strict();

export type SettingInstance = z.infer<typeof settingInstanceSchema>;

export const settingLibrarySettingsIndexSchema = z
  .object({
    schemaVersion: z.literal(SETTING_LIBRARY_SCHEMA_VERSION),
    settings: z.array(settingInstanceSchema),
  })
  .strict()
  .superRefine((index, context) => {
    const ids = new Set<string>();
    const materializedTemplates = new Set<string>();
    index.settings.forEach((setting, position) => {
      if (ids.has(setting.id)) {
        context.addIssue({
          code: "custom",
          path: ["settings", position, "id"],
          message: "设定实例 id 不得重复",
        });
      }
      ids.add(setting.id);
      if (setting.templateId) {
        const identity = `${setting.nodeId}:${setting.templateId}`;
        if (materializedTemplates.has(identity)) {
          context.addIssue({
            code: "custom",
            path: ["settings", position, "templateId"],
            message: "同一节点的模板页面只能落盘一次",
          });
        }
        materializedTemplates.add(identity);
      }
    });
  });

export type SettingLibrarySettingsIndex = z.infer<
  typeof settingLibrarySettingsIndexSchema
>;

export const settingEntrySchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    category: z.string().trim().min(1),
    aliases: z.array(z.string().trim().min(1)),
    definition: z.string(),
  })
  .strict();

export type SettingEntry = z.infer<typeof settingEntrySchema>;

export const settingEntriesFileSchema = z
  .object({
    schemaVersion: z.literal(SETTING_LIBRARY_SCHEMA_VERSION),
    entries: z.array(settingEntrySchema),
  })
  .strict();

export interface SettingEntriesFile {
  readonly schemaVersion: typeof SETTING_LIBRARY_SCHEMA_VERSION;
  readonly entries: readonly SettingEntry[];
}

export class SettingLibraryFormatError extends Error {
  constructor(
    readonly filePath: string,
    detail: string,
  ) {
    super(`${filePath} 格式错误：${detail}`);
    this.name = "SettingLibraryFormatError";
  }
}

/** 把 zod 的英文内部错误翻译成用户可读的中文（仅覆盖高频缺失字段场景）。 */
function humanizeIssueMessage(message: string): string {
  if (/^Invalid input: expected string, received undefined$/.test(message)) {
    return "缺少该字段（应为字符串）";
  }
  if (/^Invalid input: expected number, received undefined$/.test(message)) {
    return "缺少该字段（应为数值）";
  }
  if (/^Invalid input: expected boolean, received undefined$/.test(message)) {
    return "缺少该字段（应为布尔值）";
  }
  if (/^Invalid input: expected object, received undefined$/.test(message)) {
    return "缺少该字段（应为对象）";
  }
  if (/^Invalid input: expected array, received undefined$/.test(message)) {
    return "缺少该字段（应为数组）";
  }
  if (/^Invalid input: expected string, received null$/.test(message)) {
    return "该字段不能为 null（应为字符串）";
  }
  return message;
}

/**
 * 把一条 format 校验的 zod issues 压缩成简洁、可操作的消息。
 *
 * 当数组里大量条目都缺同一批字段时（例如 AI 提案的 settings 用了空对象占位），
 * zod 会为每个条目×每个字段各产生一条 issue，直接拼接会输出上百行内部错误。
 * 这里做两级归并：
 *  1. “数组条目缺字段 / 枚举取值非法”按字段合并成一行汇总；
 *  2. 其余问题按“字段 + 错误原因”归并，只展示一个实例并附带条目数，
 *     避免同一条长提示（如路径格式说明）重复输出几十遍。
 */
function summarizeZodIssues(issues: readonly z.ZodIssue[]): string {
  if (issues.length === 0) return "未知结构错误";
  const MAX_SHOWN = 4;
  const missingByField = new Map<string, number>();
  /** key = 字段名 + 错误原因骨架；用于把同类问题折叠成一条。 */
  const otherByReason = new Map<
    string,
    { path: string; message: string; count: number }
  >();
  for (const issue of issues) {
    const [root, index, field] = issue.path;
    const isArrayItemField =
      typeof root === "string" &&
      typeof index === "number" &&
      typeof field === "string";
    const isMissing = /received undefined$/.test(issue.message);
    if (isArrayItemField && isMissing) {
      missingByField.set(field, (missingByField.get(field) ?? 0) + 1);
      continue;
    }
    const path = issue.path.join(".") || "root";
    const message =
      field === "source" &&
      /^Invalid option: expected one of/.test(issue.message)
        ? "source 只能为 builtin 或 project"
        : humanizeIssueMessage(issue.message);
    // 归并键去掉“当前为 xxx”这类随条目变化的尾部，使同类问题落到同一桶。
    const reasonKey = `${isArrayItemField ? field : path}::${message.replace(/，当前为.*$/, "")}`;
    const existing = otherByReason.get(reasonKey);
    if (existing) {
      existing.count += 1;
    } else {
      otherByReason.set(reasonKey, { path, message, count: 1 });
    }
  }
  const parts: string[] = [];
  if (missingByField.size > 0) {
    const maxCount = Math.max(...missingByField.values());
    const fields = [...missingByField.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([field]) => field)
      .join("、");
    parts.push(`${maxCount} 个条目缺少必要字段：${fields}`);
  }
  const others = [...otherByReason.values()].sort((a, b) => b.count - a.count);
  parts.push(
    ...others
      .slice(0, MAX_SHOWN)
      .map((item) =>
        item.count > 1
          ? `${item.count} 个条目：${item.message}（例如 ${item.path}）`
          : `${item.path}: ${item.message}`,
      ),
  );
  const sumMissing = [...missingByField.values()].reduce((a, b) => a + b, 0);
  const shownOtherIssues = others
    .slice(0, MAX_SHOWN)
    .reduce((total, item) => total + item.count, 0);
  const remainder = issues.length - sumMissing - shownOtherIssues;
  if (remainder > 0) {
    parts.push(`…另有 ${remainder} 项问题`);
  }
  return parts.join("；");
}

function parseFile<T>(
  filePath: string,
  schema: z.ZodType<T>,
  content: string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new SettingLibraryFormatError(
      filePath,
      error instanceof Error ? error.message : String(error),
    );
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new SettingLibraryFormatError(
      filePath,
      summarizeZodIssues(result.error.issues),
    );
  }
  return result.data;
}

export function parseSettingLibraryMeta(content: string): SettingLibraryMeta {
  return parseFile(
    "world/setting-library/meta.json",
    settingLibraryMetaSchema,
    content,
  );
}

export function parseSettingLibrarySpatialTree(
  content: string,
): SettingLibrarySpatialTree {
  return parseFile(
    "world/setting-library/spatial-tree.json",
    settingLibrarySpatialTreeSchema,
    content,
  );
}

export function parseSettingLibrarySettingsIndex(
  content: string,
): SettingLibrarySettingsIndex {
  return parseFile(
    "world/setting-library/settings.json",
    settingLibrarySettingsIndexSchema,
    content,
  );
}

export function parseSettingEntriesFile(content: string): SettingEntriesFile {
  return parseFile("设定词条文件", settingEntriesFileSchema, content);
}

export function serializeSettingLibraryFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
