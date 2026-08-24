import { z } from "zod";

import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  mapGenerationPlanSchema,
  type MapGenerationPlan,
} from "../../../../../../shared/workbenches/novel/mapGenerationPlan";

export const MAP_DRAFTS_DIRECTORY = "world/maps/drafts";

const mapPlanningDraftSchema = z
  .object({
    schemaVersion: z.literal(1),
    domain: z.literal("maps"),
    draftId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
    revision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    source: z
      .object({
        promptId: z.string().trim().min(1),
        promptVersion: z.string().trim().min(1),
        sessionId: z.string().trim().min(1),
      })
      .strict(),
    payload: z
      .object({
        phase: z.enum(["planning", "visual"]),
        title: z.string().trim().min(1),
        description: z.string(),
        generationPlan: mapGenerationPlanSchema,
        operations: z.array(z.unknown()).max(0),
      })
      .strict(),
  })
  .passthrough();

export type MapPlanningDraft = {
  readonly draftId: string;
  readonly revision: number;
  readonly title: string;
  readonly description: string;
  readonly generationPlan: MapGenerationPlan;
  readonly source: {
    readonly promptId: string;
    readonly promptVersion: string;
    readonly sessionId: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type MapPlanningDraftListResult = {
  readonly drafts: readonly MapPlanningDraft[];
  readonly errors: readonly { draftId: string; message: string }[];
};

export type ConfirmedMapPlanningDraft = {
  readonly draftId: string;
  readonly revision: number;
  readonly updatedAt: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MapPlanningDraftRepository {
  list(): Promise<MapPlanningDraftListResult>;
  confirm(draftId: string): Promise<ConfirmedMapPlanningDraft>;
}

export function createMapPlanningDraftRepository(
  storage: WorkbenchStorage,
): MapPlanningDraftRepository {
  const loadFile = async (draftId: string) => {
    const path = `${MAP_DRAFTS_DIRECTORY}/${draftId}/draft.json`;
    const file = await storage.readText(path);
    const parsed = mapPlanningDraftSchema.parse(JSON.parse(file.content));
    return { path, file, parsed };
  };

  const load = async (draftId: string): Promise<MapPlanningDraft | null> => {
    const { parsed } = await loadFile(draftId);
    if (parsed.payload.phase !== "planning") return null;

    return {
      draftId: parsed.draftId,
      revision: parsed.revision,
      title: parsed.payload.title,
      description: parsed.payload.description,
      generationPlan: parsed.payload.generationPlan,
      source: parsed.source,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    };
  };

  return {
    async list() {
      const [info] = await storage.stat([MAP_DRAFTS_DIRECTORY]);
      if (!info?.exists) return { drafts: [], errors: [] };
      if (info.kind !== "directory") {
        throw new Error("地图草稿路径不是目录");
      }
      const entries = await storage.list(MAP_DRAFTS_DIRECTORY);
      const drafts: MapPlanningDraft[] = [];
      const errors: { draftId: string; message: string }[] = [];
      for (const entry of entries) {
        if (entry.kind !== "directory") continue;
        try {
          const draft = await load(entry.name);
          if (draft) drafts.push(draft);
        } catch (error) {
          errors.push({ draftId: entry.name, message: errorMessage(error) });
        }
      }
      drafts.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
      return { drafts, errors };
    },

    async confirm(draftId) {
      const { path, file, parsed } = await loadFile(draftId);
      if (parsed.payload.phase !== "planning") {
        throw new Error("地图规划草稿已经确认，不能重复确认");
      }
      if (parsed.payload.operations.length !== 0) {
        throw new Error("规划阶段草稿不得包含视觉候选");
      }
      const updatedAt = new Date().toISOString();
      const next = {
        ...parsed,
        revision: parsed.revision + 1,
        updatedAt,
        payload: {
          ...parsed.payload,
          phase: "visual" as const,
        },
      };
      await storage.writeText(`${path}`, `${JSON.stringify(next, null, 2)}\n`, {
        expectedContent: file.content,
      });
      return {
        draftId: parsed.draftId,
        revision: next.revision,
        updatedAt,
      };
    },
  };
}
