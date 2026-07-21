import { z } from "zod";

import type {
  WorkbenchSimulationRun,
  WorkbenchSimulationScenario,
} from "@/workbench-sdk";

export const WORLD_SIMULATION_SCHEMA_VERSION = 1 as const;
export const WORLD_SIMULATION_SCENARIOS_PATH = "simulation/scenarios.json";

const idSchema = z.string().trim().min(1).max(120);
const textSchema = z.string();

export const worldSimulationScenarioSchema = z
  .object({
    schemaVersion: z.literal(WORLD_SIMULATION_SCHEMA_VERSION),
    id: idSchema,
    name: z.string().trim().min(1).max(120),
    objective: z.string().trim().min(1).max(4_000),
    horizonRounds: z.number().int().min(1).max(30),
    selectedActorIds: z.array(idSchema),
    seedEvents: z.array(z.string().trim().min(1).max(1_000)),
    constraints: z.array(z.string().trim().min(1).max(1_000)),
  })
  .strict();

export const worldSimulationRunReferenceSchema = z
  .object({
    runId: idSchema,
    scenarioId: idSchema,
    scenarioName: textSchema,
    status: z.enum([
      "draft",
      "running",
      "paused",
      "completed",
      "cancelled",
      "failed",
    ]),
    currentRound: z.number().int().nonnegative(),
    maxRounds: z.number().int().positive(),
    sourceRevision: textSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();

export const worldSimulationProjectFileSchema = z
  .object({
    schemaVersion: z.literal(WORLD_SIMULATION_SCHEMA_VERSION),
    scenarios: z.array(worldSimulationScenarioSchema),
    runReferences: z.array(worldSimulationRunReferenceSchema),
  })
  .strict();

export type WorldSimulationProjectFile = z.infer<
  typeof worldSimulationProjectFileSchema
>;
export type WorldSimulationRunReference = z.infer<
  typeof worldSimulationRunReferenceSchema
>;

export function createEmptyWorldSimulationProjectFile(): WorldSimulationProjectFile {
  return {
    schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
    scenarios: [],
    runReferences: [],
  };
}

export function parseWorldSimulationProjectFile(
  content: string,
): WorldSimulationProjectFile {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `${WORLD_SIMULATION_SCENARIOS_PATH} JSON 无效：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = worldSimulationProjectFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `${WORLD_SIMULATION_SCENARIOS_PATH} 格式错误：${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；")}`,
    );
  }
  return parsed.data;
}

export function serializeWorldSimulationProjectFile(
  value: WorldSimulationProjectFile,
): string {
  return `${JSON.stringify(worldSimulationProjectFileSchema.parse(value), null, 2)}\n`;
}

export function simulationRunReference(
  run: WorkbenchSimulationRun,
): WorldSimulationRunReference {
  return {
    runId: run.runId,
    scenarioId: run.scenario.id,
    scenarioName: run.scenario.name,
    status: run.status,
    currentRound: run.currentRound,
    maxRounds: run.maxRounds,
    sourceRevision: run.snapshot.sourceRevision,
    updatedAt: run.updatedAt,
  };
}

export function normalizeSimulationScenario(
  scenario: WorkbenchSimulationScenario,
): WorkbenchSimulationScenario {
  return worldSimulationScenarioSchema.parse(scenario);
}
