import { z } from "zod";

export const FACTION_LIBRARY_SCHEMA_VERSION = 1 as const;
export const FACTION_LIBRARY_PATH = "world/factions/index.json";

const idSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/);
const textSchema = z.string();

export const factionTerritorySchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    worldNodeId: idSchema.nullable(),
    description: textSchema,
  })
  .strict();

export const factionMemberSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    characterId: idSchema.nullable(),
    role: textSchema,
    count: z.number().int().positive(),
    description: textSchema,
  })
  .strict();

export const factionAssetSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    kind: textSchema,
    value: textSchema,
    description: textSchema,
  })
  .strict();

export const factionResourceSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    kind: textSchema,
    control: textSchema,
    description: textSchema,
  })
  .strict();

export const factionRecordSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    type: textSchema,
    status: z.enum(["active", "neutral", "declining", "dissolved"]),
    summary: textSchema,
    territories: z.array(factionTerritorySchema),
    members: z.array(factionMemberSchema),
    assets: z.array(factionAssetSchema),
    resources: z.array(factionResourceSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type FactionTerritory = z.infer<typeof factionTerritorySchema>;
export type FactionMember = z.infer<typeof factionMemberSchema>;
export type FactionAsset = z.infer<typeof factionAssetSchema>;
export type FactionResource = z.infer<typeof factionResourceSchema>;
export type FactionRecord = z.infer<typeof factionRecordSchema>;

export const factionLibrarySchema = z
  .object({
    schemaVersion: z.literal(FACTION_LIBRARY_SCHEMA_VERSION),
    factions: z.array(factionRecordSchema),
  })
  .strict()
  .superRefine((library, context) => {
    const ids = new Set<string>();
    library.factions.forEach((faction, index) => {
      if (ids.has(faction.id)) {
        context.addIssue({
          code: "custom",
          path: ["factions", index, "id"],
          message: "势力 id 不得重复",
        });
      }
      ids.add(faction.id);
    });
  });

export type FactionLibrary = z.infer<typeof factionLibrarySchema>;

export function parseFactionLibrary(content: string): FactionLibrary {
  let source: unknown;
  try {
    source = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `势力组织数据无法解析：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = factionLibrarySchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `势力组织数据格式无效：${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；")}`,
    );
  }
  return parsed.data;
}

export function createEmptyFactionLibrary(): FactionLibrary {
  return { schemaVersion: FACTION_LIBRARY_SCHEMA_VERSION, factions: [] };
}

export function serializeFactionLibrary(library: FactionLibrary): string {
  return `${JSON.stringify(library, null, 2)}\n`;
}
