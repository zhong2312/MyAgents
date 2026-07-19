import { z } from "zod";

export const LOCATION_LIBRARY_SCHEMA_VERSION = 1 as const;
export const LOCATION_LIBRARY_PATH = "world/locations/index.json";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const locationStatusSchema = z.enum([
  "planned",
  "appeared",
  "archived",
]);

export type LocationStatus = z.infer<typeof locationStatusSchema>;

export const locationSchema = z
  .object({
    id: idSchema,
    nodeId: idSchema,
    parentLocationId: idSchema.nullable(),
    name: z.string().trim().min(1),
    aliases: z.array(z.string().trim().min(1)),
    type: z.string().trim().min(1),
    status: locationStatusSchema,
    summary: z.string(),
    appearanceNote: z.string(),
    description: z.string(),
    order: z.number().int().nonnegative(),
  })
  .strict();

export type NovelLocation = z.infer<typeof locationSchema>;

export const locationLibraryIndexSchema = z
  .object({
    schemaVersion: z.literal(LOCATION_LIBRARY_SCHEMA_VERSION),
    locations: z.array(locationSchema),
  })
  .strict()
  .superRefine((index, context) => {
    const byId = new Map<string, NovelLocation>();
    index.locations.forEach((location, position) => {
      if (byId.has(location.id)) {
        context.addIssue({
          code: "custom",
          path: ["locations", position, "id"],
          message: "地点 id 不得重复",
        });
      }
      byId.set(location.id, location);
    });

    index.locations.forEach((location, position) => {
      if (!location.parentLocationId) return;
      const parent = byId.get(location.parentLocationId);
      if (!parent) {
        context.addIssue({
          code: "custom",
          path: ["locations", position, "parentLocationId"],
          message: "上级地点不存在",
        });
        return;
      }
      if (parent.nodeId !== location.nodeId) {
        context.addIssue({
          code: "custom",
          path: ["locations", position, "parentLocationId"],
          message: "上级地点必须属于同一空间节点",
        });
      }
      const visited = new Set([location.id]);
      let parentId: string | null = location.parentLocationId;
      while (parentId) {
        if (visited.has(parentId)) {
          context.addIssue({
            code: "custom",
            path: ["locations", position, "parentLocationId"],
            message: "地点层级不得包含循环引用",
          });
          break;
        }
        visited.add(parentId);
        parentId = byId.get(parentId)?.parentLocationId ?? null;
      }
    });
  });

export type LocationLibraryIndex = z.infer<typeof locationLibraryIndexSchema>;

export function validateLocationNodeReferences(
  index: LocationLibraryIndex,
  nodeIds: Iterable<string>,
): void {
  const availableNodeIds = new Set(nodeIds);
  const invalid = index.locations.find(
    (location) => !availableNodeIds.has(location.nodeId),
  );
  if (invalid) {
    throw new LocationLibraryFormatError(
      LOCATION_LIBRARY_PATH,
      `地点“${invalid.name}”所属的空间节点不存在：${invalid.nodeId}`,
    );
  }
}

export class LocationLibraryFormatError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`地点库格式错误（${path}）：${detail}`);
    this.name = "LocationLibraryFormatError";
  }
}

export function parseLocationLibraryIndex(content: string): LocationLibraryIndex {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new LocationLibraryFormatError(
      LOCATION_LIBRARY_PATH,
      error instanceof Error ? error.message : String(error),
    );
  }
  const result = locationLibraryIndexSchema.safeParse(value);
  if (!result.success) {
    throw new LocationLibraryFormatError(
      LOCATION_LIBRARY_PATH,
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
    );
  }
  return result.data;
}

export function serializeLocationLibraryIndex(
  index: LocationLibraryIndex,
): string {
  return `${JSON.stringify(locationLibraryIndexSchema.parse(index), null, 2)}\n`;
}
