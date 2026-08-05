import { z } from "zod";

import { normalizeWorkbenchStoragePath } from "@/workbench-sdk";

import { ITEM_LIBRARY_SCHEMA_VERSION } from "../business/itemLibraryDefaults";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);
const trimmedTextSchema = z.string().trim();

export const itemStatusSchema = z.enum([
  "draft",
  "active",
  "inactive",
  "lost",
  "destroyed",
  "archived",
]);

export type ItemStatus = z.infer<typeof itemStatusSchema>;

export const itemFieldTypeSchema = z.enum([
  "text",
  "textarea",
  "number",
  "single-select",
  "multi-select",
  "boolean",
  "story-time",
  "entity-reference",
  "asset-reference",
]);

export type ItemFieldType = z.infer<typeof itemFieldTypeSchema>;

export const itemFieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
]);

export type ItemFieldValue = z.infer<typeof itemFieldValueSchema>;

const fieldDefinitionShape = {
  id: idSchema,
  label: z.string().trim().min(1),
  description: trimmedTextSchema,
  group: z.string().trim().min(1),
  type: itemFieldTypeSchema,
  required: z.boolean(),
  defaultValue: itemFieldValueSchema,
  options: z.array(z.string().trim().min(1)),
  unit: trimmedTextSchema.optional(),
  entityTypes: z.array(z.string().trim().min(1)).optional(),
  order: z.number().int().nonnegative(),
  archived: z.boolean().optional(),
} as const;

export const categoryFieldDefinitionSchema = z
  .object({
    ...fieldDefinitionShape,
    ownerCategoryId: idSchema,
  })
  .strict();

export type CategoryFieldDefinition = z.infer<
  typeof categoryFieldDefinitionSchema
>;

export const itemFieldDefinitionSchema = z
  .object(fieldDefinitionShape)
  .strict();

export type ItemFieldDefinition = z.infer<typeof itemFieldDefinitionSchema>;

export const itemCategorySchema = z
  .object({
    id: idSchema,
    parentId: idSchema.nullable(),
    name: z.string().trim().min(1),
    description: trimmedTextSchema,
    icon: z.string().trim().min(1),
    order: z.number().int().nonnegative(),
    system: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .strict();

export type ItemCategory = z.infer<typeof itemCategorySchema>;

export const itemLibraryMetaSchema = z
  .object({
    schemaVersion: z.literal(ITEM_LIBRARY_SCHEMA_VERSION),
    categories: z.array(itemCategorySchema).min(1),
    fields: z.array(categoryFieldDefinitionSchema),
  })
  .strict()
  .superRefine((meta, context) => {
    const categoryIds = new Set<string>();
    meta.categories.forEach((category, index) => {
      if (categoryIds.has(category.id)) {
        context.addIssue({
          code: "custom",
          path: ["categories", index, "id"],
          message: "分类 id 不得重复",
        });
      }
      categoryIds.add(category.id);
    });
    meta.categories.forEach((category, index) => {
      if (category.parentId !== null && !categoryIds.has(category.parentId)) {
        context.addIssue({
          code: "custom",
          path: ["categories", index, "parentId"],
          message: "父分类不存在",
        });
      }
      const visited = new Set([category.id]);
      let parentId = category.parentId;
      while (parentId !== null) {
        if (visited.has(parentId)) {
          context.addIssue({
            code: "custom",
            path: ["categories", index, "parentId"],
            message: "分类树不得包含循环引用",
          });
          break;
        }
        visited.add(parentId);
        parentId =
          meta.categories.find((item) => item.id === parentId)?.parentId ??
          null;
      }
    });

    const fieldIds = new Set<string>();
    meta.fields.forEach((field, index) => {
      if (fieldIds.has(field.id)) {
        context.addIssue({
          code: "custom",
          path: ["fields", index, "id"],
          message: "字段 id 不得重复",
        });
      }
      fieldIds.add(field.id);
      if (!categoryIds.has(field.ownerCategoryId)) {
        context.addIssue({
          code: "custom",
          path: ["fields", index, "ownerCategoryId"],
          message: "字段所属分类不存在",
        });
      }
    });
  });

export type ItemLibraryMeta = z.infer<typeof itemLibraryMetaSchema>;

function itemFilePath(kind: "records" | "pages") {
  return z.string().transform((path, context) => {
    try {
      const normalized = normalizeWorkbenchStoragePath(path);
      const extension = kind === "records" ? "json" : "md";
      const pattern = new RegExp(
        `^world/items/${kind}/[a-z0-9][a-z0-9-]*\\.${extension}$`,
        "u",
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

export const itemIndexEntrySchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    categoryId: idSchema,
    status: itemStatusSchema,
    tags: z.array(z.string().trim().min(1)),
    summary: trimmedTextSchema,
    recordPath: itemFilePath("records"),
    pagePath: itemFilePath("pages"),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ItemIndexEntry = z.infer<typeof itemIndexEntrySchema>;

export const itemLibraryIndexSchema = z
  .object({
    schemaVersion: z.literal(ITEM_LIBRARY_SCHEMA_VERSION),
    items: z.array(itemIndexEntrySchema),
  })
  .strict()
  .superRefine((index, context) => {
    const ids = new Set<string>();
    index.items.forEach((item, position) => {
      if (ids.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["items", position, "id"],
          message: "物品 id 不得重复",
        });
      }
      ids.add(item.id);
    });
  });

export type ItemLibraryIndex = z.infer<typeof itemLibraryIndexSchema>;

export const itemRecordSchema = z
  .object({
    schemaVersion: z.literal(ITEM_LIBRARY_SCHEMA_VERSION),
    id: idSchema,
    name: z.string().trim().min(1),
    aliases: z.array(z.string().trim().min(1)),
    categoryId: idSchema,
    status: itemStatusSchema,
    tags: z.array(z.string().trim().min(1)),
    summary: trimmedTextSchema,
    coverPath: z.string().trim().min(1).nullable(),
    values: z.record(idSchema, itemFieldValueSchema),
    itemFields: z.array(itemFieldDefinitionSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((record, context) => {
    const fieldIds = new Set<string>();
    record.itemFields.forEach((field, index) => {
      if (fieldIds.has(field.id)) {
        context.addIssue({
          code: "custom",
          path: ["itemFields", index, "id"],
          message: "物品字段 id 不得重复",
        });
      }
      fieldIds.add(field.id);
    });
  });

export type ItemRecord = z.infer<typeof itemRecordSchema>;

export class ItemLibraryFormatError extends Error {
  constructor(
    readonly filePath: string,
    detail: string,
  ) {
    super(`${filePath} 格式错误：${detail}`);
    this.name = "ItemLibraryFormatError";
  }
}

function parseFile<T>(filePath: string, schema: z.ZodType<T>, content: string) {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new ItemLibraryFormatError(
      filePath,
      error instanceof Error ? error.message : String(error),
    );
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ItemLibraryFormatError(
      filePath,
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
    );
  }
  return result.data;
}

export function parseItemLibraryMeta(content: string): ItemLibraryMeta {
  return parseFile("world/items/meta.json", itemLibraryMetaSchema, content);
}

export function parseItemLibraryIndex(content: string): ItemLibraryIndex {
  return parseFile("world/items/index.json", itemLibraryIndexSchema, content);
}

export function parseItemRecord(path: string, content: string): ItemRecord {
  return parseFile(path, itemRecordSchema, content);
}

export function serializeItemLibraryFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function getCategoryAncestors(
  meta: ItemLibraryMeta,
  categoryId: string,
): readonly ItemCategory[] {
  const result: ItemCategory[] = [];
  const visited = new Set<string>();
  let category = meta.categories.find((item) => item.id === categoryId);
  while (category && !visited.has(category.id)) {
    result.unshift(category);
    visited.add(category.id);
    category = category.parentId
      ? meta.categories.find((item) => item.id === category?.parentId)
      : undefined;
  }
  return result;
}

export function getCategoryPath(
  meta: ItemLibraryMeta,
  categoryId: string,
): string {
  return getCategoryAncestors(meta, categoryId)
    .map((category) => category.name)
    .join(" / ");
}

export function getEffectiveCategoryFields(
  meta: ItemLibraryMeta,
  categoryId: string,
): readonly CategoryFieldDefinition[] {
  const ancestorIds = new Set(
    getCategoryAncestors(meta, categoryId).map((category) => category.id),
  );
  return meta.fields
    .filter(
      (field) => ancestorIds.has(field.ownerCategoryId) && !field.archived,
    )
    .sort((left, right) => left.order - right.order);
}

export function getRetainedFieldValues(
  meta: ItemLibraryMeta,
  record: ItemRecord,
): readonly { readonly fieldId: string; readonly value: ItemFieldValue }[] {
  const activeIds = new Set([
    ...getEffectiveCategoryFields(meta, record.categoryId).map(
      (field) => field.id,
    ),
    ...record.itemFields
      .filter((field) => !field.archived)
      .map((field) => field.id),
  ]);
  return Object.entries(record.values)
    .filter(([fieldId]) => !activeIds.has(fieldId))
    .map(([fieldId, value]) => ({ fieldId, value }));
}
