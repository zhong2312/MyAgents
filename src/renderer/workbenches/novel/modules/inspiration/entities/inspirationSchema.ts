import { z } from "zod";

export const INSPIRATION_SCHEMA_VERSION = 1 as const;
export const INSPIRATION_LIBRARY_PATH = "inspiration/index.json";
export const INSPIRATION_STORAGE_VERSION = 1 as const;
export const INSPIRATION_RECORDS_DIRECTORY = "inspiration/records";

const idSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/u, "id 只能包含小写字母、数字和连字符");
const nonEmptyTextSchema = z.string().trim().min(1);

export const inspirationSourceSchema = z
  .object({
    kind: z.enum(["manual", "myagents-thought", "research", "web", "other"]),
    label: nonEmptyTextSchema,
    uri: z.string(),
  })
  .strict();
export type InspirationSource = z.infer<typeof inspirationSourceSchema>;

export const inspirationItemSchema = z
  .object({
    id: idSchema,
    title: nonEmptyTextSchema,
    body: z.string(),
    state: z.enum(["inbox", "organizing", "unused", "archived"]),
    source: inspirationSourceSchema,
    tags: z.array(nonEmptyTextSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type InspirationItem = z.infer<typeof inspirationItemSchema>;

export function inspirationRecordPath(id: string): string {
  return `${INSPIRATION_RECORDS_DIRECTORY}/${idSchema.parse(id)}.json`;
}

export const inspirationIndexEntrySchema = z
  .object({
    id: idSchema,
    path: z.string(),
  })
  .strict()
  .superRefine((entry, context) => {
    const expected = inspirationRecordPath(entry.id);
    if (entry.path !== expected) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: `必须是 ${expected}`,
      });
    }
  });

export const inspirationLibraryIndexSchema = z
  .object({
    schemaVersion: z.literal(INSPIRATION_SCHEMA_VERSION),
    storageVersion: z.literal(INSPIRATION_STORAGE_VERSION),
    updatedAt: z.string().min(1),
    items: z.array(inspirationIndexEntrySchema),
  })
  .strict();
export type InspirationLibraryIndex = z.infer<
  typeof inspirationLibraryIndexSchema
>;

export const inspirationLibrarySchema = z
  .object({
    schemaVersion: z.literal(INSPIRATION_SCHEMA_VERSION),
    items: z.array(inspirationItemSchema),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((library, context) => {
    const seen = new Set<string>();
    library.items.forEach((item, index) => {
      if (seen.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: "id 不得重复",
        });
      }
      seen.add(item.id);
    });
  });
export type InspirationLibrary = z.infer<typeof inspirationLibrarySchema>;

export class InspirationFormatError extends Error {
  constructor(detail: string) {
    super(`${INSPIRATION_LIBRARY_PATH} 数据格式无效：${detail}`);
    this.name = "InspirationFormatError";
  }
}

export function parseInspirationLibrary(content: string): InspirationLibrary {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new InspirationFormatError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const result = inspirationLibrarySchema.safeParse(value);
  if (!result.success) {
    throw new InspirationFormatError(
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
    );
  }
  return result.data;
}

export function serializeInspirationLibrary(value: InspirationLibrary): string {
  return `${JSON.stringify(inspirationLibrarySchema.parse(value), null, 2)}\n`;
}

export function createEmptyInspirationLibrary(
  createdAt: string,
): InspirationLibrary {
  return inspirationLibrarySchema.parse({
    schemaVersion: INSPIRATION_SCHEMA_VERSION,
    items: [],
    updatedAt: createdAt,
  });
}
