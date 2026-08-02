import { z } from "zod";

export const WORLD_SIMULATION_WORLD_PATH = "simulation/world-state.json";
export const WORLD_SIMULATION_WORLD_SCHEMA_VERSION = 1 as const;

const id = z.string().trim().min(1).max(160);
const tick = z.string().regex(/^-?\d+$/u);

export const worldTimeSchema = z.object({
  calendarId: z.string().trim().min(1).max(80),
  tick,
  unit: z.enum(["tick", "day", "month", "year", "era"]),
  label: z.string().trim().min(1).max(200),
}).strict();

export const simulationRegionSchema = z.object({
  id,
  name: z.string().trim().min(1).max(200),
  parentId: id.nullable(),
  activity: z.enum(["quiet", "stable", "tense", "war", "catastrophe"]),
  pressure: z.number().min(0).max(100),
  state: z.record(z.string(), z.string()),
}).strict();

export const simulationActorStateSchema = z.object({
  id,
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["character", "faction", "group"]),
  locationId: id.nullable(),
  status: z.enum(["idle", "moving", "acting", "dead", "unknown"]),
  intent: z.string(),
  state: z.record(z.string(), z.string()),
}).strict();

export const scheduledWorldEventSchema = z.object({
  id,
  title: z.string().trim().min(1).max(240),
  description: z.string().max(8_000),
  startTick: tick,
  endTick: tick.nullable(),
  regionIds: z.array(id),
  actorIds: z.array(id),
  kind: z.enum(["planned", "periodic", "emergent", "milestone", "catastrophe"]),
  priority: z.number().int().min(-100).max(100),
  recurrence: z.object({ every: tick, until: tick.nullable() }).strict().optional(),
  effects: z.array(z.object({
    targetType: z.enum(["actor", "region", "world"]),
    targetId: id,
    field: z.string().trim().min(1).max(160),
    operation: z.enum(["set", "add", "multiply", "trigger"]),
    value: z.string(),
    reason: z.string(),
  }).strict()),
}).strict();

export const executedWorldEventSchema = z.object({
  id,
  tick,
  title: z.string(),
  summary: z.string(),
  kind: z.string(),
  regionIds: z.array(id),
  actorIds: z.array(id),
  changes: z.array(z.object({
    targetType: z.string(),
    targetId: z.string(),
    field: z.string(),
    before: z.string().nullable(),
    after: z.string().nullable(),
    reason: z.string(),
  }).strict()),
}).strict();

export const worldSimulationStateSchema = z.object({
  schemaVersion: z.literal(WORLD_SIMULATION_WORLD_SCHEMA_VERSION),
  projectId: id,
  calendarId: z.string().trim().min(1).max(80),
  currentTick: tick,
  currentLabel: z.string().trim().min(1).max(200),
  timeUnit: z.enum(["tick", "day", "month", "year", "era"]),
  endTick: tick.nullable(),
  regions: z.array(simulationRegionSchema),
  actors: z.array(simulationActorStateSchema),
  scheduledEvents: z.array(scheduledWorldEventSchema),
  executedEvents: z.array(executedWorldEventSchema),
  worldState: z.record(z.string(), z.string()),
}).strict();

export type WorldTime = z.infer<typeof worldTimeSchema>;
export type SimulationRegion = z.infer<typeof simulationRegionSchema>;
export type SimulationActorState = z.infer<typeof simulationActorStateSchema>;
export type ScheduledWorldEvent = z.infer<typeof scheduledWorldEventSchema>;
export type ExecutedWorldEvent = z.infer<typeof executedWorldEventSchema>;
export type WorldSimulationState = z.infer<typeof worldSimulationStateSchema>;

export function createEmptyWorldSimulationState(projectId: string): WorldSimulationState {
  return {
    schemaVersion: WORLD_SIMULATION_WORLD_SCHEMA_VERSION,
    projectId,
    calendarId: "xian-tu",
    currentTick: "0",
    currentLabel: "第 0 天",
    timeUnit: "day",
    endTick: null,
    regions: [],
    actors: [],
    scheduledEvents: [],
    executedEvents: [],
    worldState: {},
  };
}

export function parseWorldSimulationState(content: string): WorldSimulationState {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`${WORLD_SIMULATION_WORLD_PATH} JSON 无效：${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = worldSimulationStateSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${WORLD_SIMULATION_WORLD_PATH} 格式错误：${parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("；")}`);
  }
  return parsed.data;
}

export function serializeWorldSimulationState(value: WorldSimulationState): string {
  return `${JSON.stringify(worldSimulationStateSchema.parse(value), null, 2)}\n`;
}

