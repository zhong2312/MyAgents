import { z } from "zod";

export const FACTION_DIRECTORY = "world/factions";
export const FACTION_INDEX_PATH = "world/factions/index.json";
export const FACTION_STORAGE_VERSION = 1 as const;
export const FACTION_SCHEMA_VERSION = 2 as const;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export const factionIdSchema = z.string().trim().regex(ID_PATTERN);
const textSchema = z.string();

export const factionStatusSchema = z.enum([
  "active",
  "neutral",
  "declining",
  "dissolved",
]);

export const factionTerritorySchema = z
  .object({
    id: factionIdSchema,
    name: z.string().trim().min(1),
    worldNodeId: factionIdSchema.nullable(),
    description: textSchema,
  })
  .strict();

export const factionMemberSchema = z
  .object({
    id: factionIdSchema,
    name: z.string().trim().min(1),
    characterId: factionIdSchema.nullable(),
    role: textSchema,
    count: z.number().int().positive(),
    description: textSchema,
  })
  .strict();

export const factionAssetSchema = z
  .object({
    id: factionIdSchema,
    name: z.string().trim().min(1),
    kind: textSchema,
    value: textSchema,
    description: textSchema,
  })
  .strict();

export const factionResourceControlSchema = z.enum([
  "owned",
  "dominant",
  "shared",
  "access",
  "contested",
  "lost",
]);

export const factionResourceHistorySchema = z
  .object({
    id: factionIdSchema,
    timeLabel: textSchema,
    summary: textSchema,
  })
  .strict();

export const factionResourceSchema = z
  .object({
    id: factionIdSchema,
    name: z.string().trim().min(1),
    kind: textSchema,
    control: textSchema,
    controlLevel: factionResourceControlSchema.default("contested"),
    worldNodeId: factionIdSchema.nullable().default(null),
    itemId: factionIdSchema.nullable().default(null),
    competingFactionIds: z.array(factionIdSchema).default([]),
    history: z.array(factionResourceHistorySchema).default([]),
    description: textSchema,
  })
  .strict();

export const factionOrganizationUnitSchema = z
  .object({
    id: factionIdSchema,
    parentId: factionIdSchema.nullable(),
    name: z.string().trim().min(1),
    kind: textSchema,
    leaderMemberId: factionIdSchema.nullable(),
    description: textSchema,
  })
  .strict();

export const factionRelationKindSchema = z.enum([
  "subordinate",
  "alliance",
  "hostile",
  "competitive",
  "dependent",
]);

export const factionRelationSchema = z
  .object({
    id: factionIdSchema,
    targetFactionId: factionIdSchema,
    kind: factionRelationKindSchema,
    direction: z.enum(["outbound", "inbound", "mutual"]),
    status: z.enum(["active", "suspended", "ended"]),
    startedAt: textSchema,
    endedAt: textSchema,
    description: textSchema,
  })
  .strict();

export const factionRightKindSchema = z.enum([
  "legitimacy",
  "title",
  "jurisdiction",
  "passage",
  "procurement",
  "trade",
  "mining",
  "taxation",
  "minting",
  "custom",
]);

export const factionRightSchema = z
  .object({
    id: factionIdSchema,
    name: z.string().trim().min(1),
    kind: factionRightKindSchema,
    issuerFactionId: factionIdSchema.nullable(),
    worldNodeId: factionIdSchema.nullable(),
    scope: textSchema,
    status: z.enum(["active", "suspended", "revoked", "expired"]),
    startedAt: textSchema,
    endedAt: textSchema,
    description: textSchema,
  })
  .strict();

export const factionLinkKindSchema = z.enum([
  "trade-route",
  "war",
  "industry",
  "character",
  "setting",
  "item",
  "timeline",
  "custom",
]);

export const factionLinkSchema = z
  .object({
    id: factionIdSchema,
    kind: factionLinkKindSchema,
    targetId: factionIdSchema.nullable(),
    label: z.string().trim().min(1),
    description: textSchema,
  })
  .strict();

export const factionStateSchema = z
  .object({
    governance: textSchema,
    military: textSchema,
    economy: textSchema,
    publicSupport: textSchema,
    territorialIntegrity: textSchema,
  })
  .strict();

/** 势力正式记录的跨进程事实源契约。 */
export const factionRecordSchema = z
  .object({
    id: factionIdSchema,
    name: z.string().trim().min(1),
    type: textSchema,
    status: factionStatusSchema,
    summary: textSchema,
    state: factionStateSchema,
    territories: z.array(factionTerritorySchema),
    members: z.array(factionMemberSchema),
    assets: z.array(factionAssetSchema),
    resources: z.array(factionResourceSchema),
    organizationUnits: z.array(factionOrganizationUnitSchema),
    relations: z.array(factionRelationSchema),
    rights: z.array(factionRightSchema),
    links: z.array(factionLinkSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type FactionRecord = z.infer<typeof factionRecordSchema>;
export type FactionTerritory = z.infer<typeof factionTerritorySchema>;
export type FactionMember = z.infer<typeof factionMemberSchema>;
export type FactionAsset = z.infer<typeof factionAssetSchema>;
export type FactionResource = z.infer<typeof factionResourceSchema>;
export type FactionOrganizationUnit = z.infer<
  typeof factionOrganizationUnitSchema
>;
export type FactionRelation = z.infer<typeof factionRelationSchema>;
export type FactionRight = z.infer<typeof factionRightSchema>;
export type FactionLink = z.infer<typeof factionLinkSchema>;
export type FactionState = z.infer<typeof factionStateSchema>;

/** 目录拆分层只负责路径与索引，语义校验由势力 Repository 使用 FactionRecord。 */
export interface FactionStorageRecord {
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface FactionStorageAggregate {
  readonly schemaVersion: typeof FACTION_SCHEMA_VERSION;
  readonly factions: readonly FactionStorageRecord[];
}

export interface FactionTextFile {
  readonly path: string;
  readonly content: string;
}

export interface LoadedFactionFiles {
  readonly library: FactionStorageAggregate;
  readonly files: ReadonlyMap<string, string>;
}

export type ReadFactionText = (path: string) => Promise<string>;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJson(path: string, content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (cause) {
    throw new Error(
      `${path} 不是有效 JSON：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function objectValue(path: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function idValue(path: string, value: unknown): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new Error(`${path} 只能使用小写字母、数字和连字符`);
  }
  return value;
}

export function factionRecordPath(id: string): string {
  const validId = idValue("faction id", id);
  return `${FACTION_DIRECTORY}/records/${validId}.json`;
}

function createRecordFiles(records: readonly FactionStorageRecord[]): {
  readonly entries: readonly { readonly id: string; readonly path: string }[];
  readonly files: readonly FactionTextFile[];
} {
  const ids = new Set<string>();
  const files: FactionTextFile[] = [];
  const entries = records.map((record, position) => {
    const id = idValue(`factions.${position}.id`, record.id);
    if (ids.has(id)) throw new Error(`factions 包含重复 id：${id}`);
    ids.add(id);
    const path = factionRecordPath(id);
    files.push({ path, content: json(record) });
    return { id, path };
  });
  return { entries, files };
}

/** 将完整势力库拆成轻量根索引与独立势力记录；根索引固定最后返回。 */
export function createFactionFiles(
  library: FactionStorageAggregate,
): readonly FactionTextFile[] {
  if (library.schemaVersion !== FACTION_SCHEMA_VERSION) {
    throw new Error(`势力 schemaVersion 必须是 ${FACTION_SCHEMA_VERSION}`);
  }
  const collection = createRecordFiles(library.factions);
  const files = [...collection.files].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  files.push({
    path: FACTION_INDEX_PATH,
    content: json({
      schemaVersion: FACTION_SCHEMA_VERSION,
      storageVersion: FACTION_STORAGE_VERSION,
      factions: collection.entries,
    }),
  });
  return files;
}

async function loadRecords(
  read: ReadFactionText,
  index: Record<string, unknown>,
): Promise<readonly FactionStorageRecord[]> {
  const entries = index.factions;
  if (!Array.isArray(entries)) {
    throw new Error(`${FACTION_INDEX_PATH}.factions 必须是数组`);
  }
  const ids = new Set<string>();
  return Promise.all(
    entries.map(async (entry, position) => {
      const owner = `${FACTION_INDEX_PATH}.factions.${position}`;
      const reference = objectValue(owner, entry);
      const id = idValue(`${owner}.id`, reference.id);
      if (ids.has(id)) throw new Error(`factions 索引包含重复 id：${id}`);
      ids.add(id);
      const expectedPath = factionRecordPath(id);
      if (reference.path !== expectedPath) {
        throw new Error(`${owner}.path 必须是 ${expectedPath}`);
      }
      const record = objectValue(
        expectedPath,
        parseJson(expectedPath, await read(expectedPath)),
      );
      if (idValue(`${expectedPath}.id`, record.id) !== id) {
        throw new Error(`${expectedPath}.id 与索引不一致`);
      }
      return record as FactionStorageRecord;
    }),
  );
}

/** 从根索引递归读取全部势力记录并聚合完整势力库。 */
export async function loadFactionFiles(
  readText: ReadFactionText,
): Promise<LoadedFactionFiles> {
  const files = new Map<string, string>();
  const read: ReadFactionText = async (path) => {
    const cached = files.get(path);
    if (cached !== undefined) return cached;
    const content = await readText(path);
    files.set(path, content);
    return content;
  };
  const index = objectValue(
    FACTION_INDEX_PATH,
    parseJson(FACTION_INDEX_PATH, await read(FACTION_INDEX_PATH)),
  );
  if (index.schemaVersion !== FACTION_SCHEMA_VERSION) {
    throw new Error(
      `${FACTION_INDEX_PATH}.schemaVersion 必须是 ${FACTION_SCHEMA_VERSION}`,
    );
  }
  if (index.storageVersion !== FACTION_STORAGE_VERSION) {
    throw new Error(
      `${FACTION_INDEX_PATH}.storageVersion 必须是 ${FACTION_STORAGE_VERSION}；旧单文件势力库不兼容且不迁移`,
    );
  }
  return {
    library: {
      schemaVersion: FACTION_SCHEMA_VERSION,
      factions: await loadRecords(read, index),
    },
    files,
  };
}

export function factionFileMap(
  files: readonly FactionTextFile[],
): ReadonlyMap<string, string> {
  return new Map(files.map((file) => [file.path, file.content] as const));
}

export function serializeFactionFileSnapshot(
  files: ReadonlyMap<string, string>,
): string {
  return JSON.stringify(
    [...files.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}
