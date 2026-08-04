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
        context.addIssue({ code: "custom", message: `非法${kind}文件路径` });
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
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
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
