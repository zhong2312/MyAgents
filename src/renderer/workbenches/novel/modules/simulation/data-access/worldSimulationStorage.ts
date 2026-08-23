import {
  parseSimulationJson,
  serializeSimulationJson,
  SIMULATION_INDEX_PATH,
  SIMULATION_SCHEMA_VERSION,
  SIMULATION_STORAGE_VERSION,
  simulationEventSchema,
  simulationIndexSchema,
  simulationRoundSchema,
  simulationRunSchema,
  type SimulationEvent,
  type SimulationIndex,
  type SimulationRound,
  type SimulationRun,
} from "../entities/simulationSchema";

export const SIMULATIONS_DIRECTORY = "world/simulations";
export const SIMULATION_RUNS_DIRECTORY = `${SIMULATIONS_DIRECTORY}/runs`;

export interface SimulationTextFile {
  readonly path: string;
  readonly content: string;
}

export interface SimulationRunFiles {
  readonly manifest: SimulationRun;
  readonly rounds: readonly SimulationRound[];
  readonly events: readonly SimulationEvent[];
}

export interface LoadedSimulationFiles {
  readonly index: SimulationIndex;
  readonly runs: ReadonlyMap<string, SimulationRunFiles>;
  readonly files: ReadonlyMap<string, string>;
}

export function simulationManifestPath(id: string): string {
  return `${SIMULATION_RUNS_DIRECTORY}/${id}/manifest.json`;
}

export function simulationRoundsIndexPath(id: string): string {
  return `${SIMULATION_RUNS_DIRECTORY}/${id}/rounds/index.json`;
}

export function simulationRoundPath(runId: string, roundId: string): string {
  return `${SIMULATION_RUNS_DIRECTORY}/${runId}/rounds/records/${roundId}.json`;
}

export function simulationEventsIndexPath(id: string): string {
  return `${SIMULATION_RUNS_DIRECTORY}/${id}/events/index.json`;
}

export function simulationEventPath(runId: string, eventId: string): string {
  return `${SIMULATION_RUNS_DIRECTORY}/${runId}/events/records/${eventId}.json`;
}

function idPathValue(value: string, field: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(value)) {
    throw new Error(`${field} 只能使用小写字母、数字和连字符`);
  }
  return value;
}

function parseRecordIndex(
  path: string,
  content: string,
  expectedPath: (id: string) => string,
): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`${path} 不是有效 JSON：${String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} 必须是 JSON 对象`);
  }
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion !== SIMULATION_SCHEMA_VERSION) {
    throw new Error(
      `${path}.schemaVersion 必须为 ${SIMULATION_SCHEMA_VERSION}`,
    );
  }
  const records = (value as { records?: unknown }).records;
  if (!Array.isArray(records)) throw new Error(`${path}.records 必须是数组`);
  const ids = records.map((entry, position) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${path}.records.${position} 必须是对象`);
    }
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string")
      throw new Error(`${path}.records.${position}.id 必须是字符串`);
    const normalizedId = idPathValue(id, `${path}.records.${position}.id`);
    const recordPath = (entry as { path?: unknown }).path;
    if (recordPath !== expectedPath(normalizedId)) {
      throw new Error(`${path}.records.${position}.path 必须与记录 id 对应`);
    }
    return normalizedId;
  });
  if (new Set(ids).size !== ids.length)
    throw new Error(`${path}.records 不得重复`);
  return ids;
}

function json(value: unknown): string {
  return serializeSimulationJson(value);
}

export function createSimulationFiles(
  index: SimulationIndex,
  runs: readonly SimulationRunFiles[],
): readonly SimulationTextFile[] {
  const normalizedIndex = simulationIndexSchema.parse({
    schemaVersion: SIMULATION_SCHEMA_VERSION,
    storageVersion: SIMULATION_STORAGE_VERSION,
    activeRunId: index.activeRunId,
    runs: index.runs,
  });
  const files: SimulationTextFile[] = [];
  for (const run of runs) {
    const manifest = simulationRunSchema.parse(run.manifest);
    const runId = idPathValue(manifest.id, "运行 id");
    const roundRecords = run.rounds.map((round) =>
      simulationRoundSchema.parse(round),
    );
    const eventRecords = run.events.map((event) =>
      simulationEventSchema.parse(event),
    );
    files.push({
      path: simulationManifestPath(runId),
      content: json(manifest),
    });
    files.push({
      path: simulationRoundsIndexPath(runId),
      content: json({
        schemaVersion: SIMULATION_SCHEMA_VERSION,
        records: roundRecords.map((round) => ({
          id: round.id,
          path: simulationRoundPath(runId, round.id),
        })),
      }),
    });
    files.push({
      path: simulationEventsIndexPath(runId),
      content: json({
        schemaVersion: SIMULATION_SCHEMA_VERSION,
        records: eventRecords.map((event) => ({
          id: event.id,
          path: simulationEventPath(runId, event.id),
        })),
      }),
    });
    roundRecords.forEach((round) =>
      files.push({
        path: simulationRoundPath(runId, round.id),
        content: json(round),
      }),
    );
    eventRecords.forEach((event) =>
      files.push({
        path: simulationEventPath(runId, event.id),
        content: json(event),
      }),
    );
  }
  files.push({ path: SIMULATION_INDEX_PATH, content: json(normalizedIndex) });
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function loadSimulationFiles(
  readText: (path: string) => Promise<string>,
): Promise<LoadedSimulationFiles> {
  const files = new Map<string, string>();
  const read = async (path: string) => {
    const cached = files.get(path);
    if (cached !== undefined) return cached;
    const content = await readText(path);
    files.set(path, content);
    return content;
  };
  const index = parseSimulationJson(
    SIMULATION_INDEX_PATH,
    simulationIndexSchema,
    await read(SIMULATION_INDEX_PATH),
  );
  const runs = new Map<string, SimulationRunFiles>();
  for (const entry of index.runs) {
    const manifest = parseSimulationJson(
      entry.path,
      simulationRunSchema,
      await read(entry.path),
    );
    const runId = idPathValue(manifest.id, "运行 id");
    if (runId !== entry.id) throw new Error(`${entry.path}.id 与索引不一致`);
    const roundIndexPath = simulationRoundsIndexPath(runId);
    const eventIndexPath = simulationEventsIndexPath(runId);
    const roundIds = parseRecordIndex(
      roundIndexPath,
      await read(roundIndexPath),
      (id) => simulationRoundPath(runId, id),
    );
    const eventIds = parseRecordIndex(
      eventIndexPath,
      await read(eventIndexPath),
      (id) => simulationEventPath(runId, id),
    );
    const rounds = await Promise.all(
      roundIds.map(async (id) =>
        parseSimulationJson(
          simulationRoundPath(runId, id),
          simulationRoundSchema,
          await read(simulationRoundPath(runId, id)),
        ),
      ),
    );
    const events = await Promise.all(
      eventIds.map(async (id) =>
        parseSimulationJson(
          simulationEventPath(runId, id),
          simulationEventSchema,
          await read(simulationEventPath(runId, id)),
        ),
      ),
    );
    runs.set(runId, { manifest, rounds, events });
  }
  return { index, runs, files };
}

export function serializeSimulationFileSnapshot(
  files: ReadonlyMap<string, string>,
): string {
  return JSON.stringify(
    [...files.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}
