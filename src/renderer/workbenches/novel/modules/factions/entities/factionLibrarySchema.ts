import { z } from "zod";

import {
  factionIdSchema,
  factionRecordSchema,
  type FactionRecord,
} from "../../../../../../shared/workbenches/novel/factionStorage";

export {
  factionAssetSchema,
  factionLinkKindSchema,
  factionLinkSchema,
  factionMemberSchema,
  factionOrganizationUnitSchema,
  factionRecordSchema,
  factionRelationKindSchema,
  factionRelationSchema,
  factionResourceControlSchema,
  factionResourceHistorySchema,
  factionResourceSchema,
  factionRightKindSchema,
  factionRightSchema,
  factionStateSchema,
  factionStatusSchema,
  factionTerritorySchema,
} from "../../../../../../shared/workbenches/novel/factionStorage";
export type {
  FactionAsset,
  FactionLink,
  FactionMember,
  FactionOrganizationUnit,
  FactionRecord,
  FactionRelation,
  FactionResource,
  FactionRight,
  FactionState,
  FactionTerritory,
} from "../../../../../../shared/workbenches/novel/factionStorage";

export const FACTION_LIBRARY_SCHEMA_VERSION = 2 as const;
export const FACTION_LIBRARY_PATH = "world/factions/index.json";
export const FACTION_LIBRARY_STORAGE_VERSION = 1 as const;

export const factionIndexEntrySchema = z
  .object({
    id: factionIdSchema,
    path: z
      .string()
      .regex(/^world\/factions\/records\/[a-z0-9][a-z0-9-]*\.json$/u),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.path !== `world/factions/records/${entry.id}.json`) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: `必须是 world/factions/records/${entry.id}.json`,
      });
    }
  });

export const factionLibraryIndexSchema = z
  .object({
    schemaVersion: z.literal(FACTION_LIBRARY_SCHEMA_VERSION),
    storageVersion: z.literal(FACTION_LIBRARY_STORAGE_VERSION),
    factions: z.array(factionIndexEntrySchema),
  })
  .strict();

export const factionRecordFileSchema = factionRecordSchema;

export const factionLibrarySchema = z
  .object({
    schemaVersion: z.literal(FACTION_LIBRARY_SCHEMA_VERSION),
    factions: z.array(factionRecordSchema),
  })
  .strict()
  .superRefine((library, context) => {
    const ids = new Set<string>();
    const symmetricRelationKeys = new Set<string>();
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
    library.factions.forEach((faction, factionIndex) => {
      const unitIds = new Set(faction.organizationUnits.map((unit) => unit.id));
      const memberIds = new Set(faction.members.map((member) => member.id));
      const relationTargets = new Set<string>();
      faction.organizationUnits.forEach((unit, unitIndex) => {
        if (
          faction.organizationUnits.findIndex(
            (candidate) => candidate.id === unit.id,
          ) !== unitIndex
        ) {
          context.addIssue({
            code: "custom",
            path: [
              "factions",
              factionIndex,
              "organizationUnits",
              unitIndex,
              "id",
            ],
            message: "组织单元 id 不得重复",
          });
        }
        if (unit.parentId && !unitIds.has(unit.parentId)) {
          context.addIssue({
            code: "custom",
            path: [
              "factions",
              factionIndex,
              "organizationUnits",
              unitIndex,
              "parentId",
            ],
            message: "组织单元的上级不存在",
          });
        }
        if (unit.leaderMemberId && !memberIds.has(unit.leaderMemberId)) {
          context.addIssue({
            code: "custom",
            path: [
              "factions",
              factionIndex,
              "organizationUnits",
              unitIndex,
              "leaderMemberId",
            ],
            message: "组织单元负责人不存在",
          });
        }
        const visited = new Set([unit.id]);
        let parentId = unit.parentId;
        while (parentId) {
          if (visited.has(parentId)) {
            context.addIssue({
              code: "custom",
              path: [
                "factions",
                factionIndex,
                "organizationUnits",
                unitIndex,
                "parentId",
              ],
              message: "组织层级不得包含循环引用",
            });
            break;
          }
          visited.add(parentId);
          parentId =
            faction.organizationUnits.find(
              (candidate) => candidate.id === parentId,
            )?.parentId ?? null;
        }
      });
      faction.relations.forEach((relation, relationIndex) => {
        if (relation.targetFactionId === faction.id) {
          context.addIssue({
            code: "custom",
            path: [
              "factions",
              factionIndex,
              "relations",
              relationIndex,
              "targetFactionId",
            ],
            message: "势力不能与自身建立关系",
          });
        }
        if (!ids.has(relation.targetFactionId)) {
          context.addIssue({
            code: "custom",
            path: [
              "factions",
              factionIndex,
              "relations",
              relationIndex,
              "targetFactionId",
            ],
            message: "关联势力不存在",
          });
        }
        const key = `${relation.targetFactionId}:${relation.kind}:${relation.direction}`;
        if (relationTargets.has(key)) {
          context.addIssue({
            code: "custom",
            path: ["factions", factionIndex, "relations", relationIndex],
            message: "同一势力关系不得重复",
          });
        }
        relationTargets.add(key);
        if (relation.direction === "mutual") {
          const pair = [faction.id, relation.targetFactionId].sort().join(":");
          const symmetricKey = `${pair}:${relation.kind}`;
          if (symmetricRelationKeys.has(symmetricKey)) {
            context.addIssue({
              code: "custom",
              path: ["factions", factionIndex, "relations", relationIndex],
              message: "双向势力关系只应保留一条记录",
            });
          }
          symmetricRelationKeys.add(symmetricKey);
        }
      });
      faction.resources.forEach((resource, resourceIndex) => {
        resource.competingFactionIds.forEach(
          (competitorId, competitorIndex) => {
            if (competitorId === faction.id || !ids.has(competitorId)) {
              context.addIssue({
                code: "custom",
                path: [
                  "factions",
                  factionIndex,
                  "resources",
                  resourceIndex,
                  "competingFactionIds",
                  competitorIndex,
                ],
                message: "资源争夺势力不存在或不能是当前势力",
              });
            }
          },
        );
      });
      faction.rights.forEach((right, rightIndex) => {
        if (right.issuerFactionId && !ids.has(right.issuerFactionId)) {
          context.addIssue({
            code: "custom",
            path: [
              "factions",
              factionIndex,
              "rights",
              rightIndex,
              "issuerFactionId",
            ],
            message: "权利授予势力不存在",
          });
        }
      });
    });
  });

export type FactionLibrary = z.infer<typeof factionLibrarySchema>;

function normalizeFactionRecord(record: FactionRecord): FactionRecord {
  return {
    ...record,
    organizationUnits: record.organizationUnits.map((unit) => ({ ...unit })),
    relations: record.relations.map((relation) => ({ ...relation })),
    rights: record.rights.map((right) => ({ ...right })),
    links: record.links.map((link) => ({ ...link })),
    resources: record.resources.map((resource) => ({
      ...resource,
      competingFactionIds: [...new Set(resource.competingFactionIds)],
      history: resource.history.map((entry) => ({ ...entry })),
    })),
  };
}

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
  if (parsed.success) {
    return {
      ...parsed.data,
      factions: parsed.data.factions.map(normalizeFactionRecord),
    };
  }
  throw new Error(
    `势力组织数据格式无效：${parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("；")}`,
  );
}

export function createEmptyFactionLibrary(): FactionLibrary {
  return { schemaVersion: FACTION_LIBRARY_SCHEMA_VERSION, factions: [] };
}

export function serializeFactionLibrary(library: FactionLibrary): string {
  return `${JSON.stringify(factionLibrarySchema.parse(library), null, 2)}\n`;
}
