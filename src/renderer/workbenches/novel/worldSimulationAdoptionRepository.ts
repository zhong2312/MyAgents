import type { WorkbenchStorage, WorkbenchTextFile } from "@/workbench-sdk";

import { z } from "zod";

export const WORLD_SIMULATION_ADOPTIONS_PATH = "simulation/adoptions.json";

const adoptionEntrySchema = z.object({
  schemaVersion: z.literal(1),
  key: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1),
  sourceRevision: z.string(),
  kind: z.enum(["character", "faction"]),
  targetId: z.string().min(1),
  field: z.string().min(1),
  before: z.string().nullable(),
  after: z.string(),
  status: z.enum(["adopted", "rolled-back"]),
  updatedAt: z.string().datetime(),
});

const adoptionFileSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(adoptionEntrySchema),
});

export type WorldSimulationAdoptionEntry = z.infer<typeof adoptionEntrySchema>;

export interface LoadedWorldSimulationAdoptions {
  readonly value: z.infer<typeof adoptionFileSchema>;
  readonly content: string;
}

export interface WorldSimulationAdoptionRepository {
  load(): Promise<LoadedWorldSimulationAdoptions>;
  save(
    current: LoadedWorldSimulationAdoptions,
    entries: readonly WorldSimulationAdoptionEntry[],
  ): Promise<LoadedWorldSimulationAdoptions>;
}

function serialize(value: z.infer<typeof adoptionFileSchema>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function ensureTextFile(
  storage: WorkbenchStorage,
  content: string,
): Promise<WorkbenchTextFile> {
  const [info] = await storage.stat([WORLD_SIMULATION_ADOPTIONS_PATH]);
  if (info?.exists) return storage.readText(WORLD_SIMULATION_ADOPTIONS_PATH);
  try {
    return await storage.createText(WORLD_SIMULATION_ADOPTIONS_PATH, content, {
      createParents: true,
    });
  } catch {
    return storage.readText(WORLD_SIMULATION_ADOPTIONS_PATH);
  }
}

export function createWorldSimulationAdoptionRepository(
  storage: WorkbenchStorage,
): WorldSimulationAdoptionRepository {
  return {
    async load(): Promise<LoadedWorldSimulationAdoptions> {
      const file = await ensureTextFile(
        storage,
        serialize({ schemaVersion: 1, entries: [] }),
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(file.content);
      } catch (cause) {
        throw new Error(
          `${WORLD_SIMULATION_ADOPTIONS_PATH} JSON 无效：${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      const result = adoptionFileSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(`${WORLD_SIMULATION_ADOPTIONS_PATH} 格式错误`);
      }
      return Object.freeze({ value: result.data, content: file.content });
    },

    async save(
      current: LoadedWorldSimulationAdoptions,
      entries: readonly WorldSimulationAdoptionEntry[],
    ): Promise<LoadedWorldSimulationAdoptions> {
      const value = adoptionFileSchema.parse({ schemaVersion: 1, entries });
      const file = await storage.writeText(
        WORLD_SIMULATION_ADOPTIONS_PATH,
        serialize(value),
        { expectedContent: current.content },
      );
      return Object.freeze({ value, content: file.content });
    },
  };
}
