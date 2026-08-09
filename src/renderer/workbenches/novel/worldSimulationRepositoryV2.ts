import type { WorkbenchStorage, WorkbenchTextFile } from "@/workbench-sdk";

import {
  WORLD_SIMULATION_PATHS,
  WORLD_SIMULATION_SCHEMA_VERSION,
  createEmptySimulationRunIndex,
  createEmptySimulationScenarioFile,
  createWorldSimulationRunManifest,
  parseSimulationRunIndex,
  parseSimulationScenarioFile,
  parseWorldSimulationRun,
  parseWorldSimulationRunManifest,
  serializeWorldSimulation,
  worldSimulationBranchRoot,
  worldSimulationRunPath,
  worldSimulationRunRoot,
  worldSimulationScenarioSchema,
  type SimulationBranch,
  type SimulationRunIndexEntry,
  type SimulationRunIndexFile,
  type SimulationScenarioFile,
  type WorldSimulationRun,
  type WorldSimulationScenario,
} from "./worldSimulationV2Schema";
import { createStorageTransaction } from "./shared/infrastructure/storageTransaction";

export interface LoadedSimulationScenarios {
  readonly value: SimulationScenarioFile;
  readonly content: string;
}

export interface LoadedSimulationRunIndex {
  readonly value: SimulationRunIndexFile;
  readonly content: string;
}

export interface LoadedWorldSimulationRun {
  readonly value: WorldSimulationRun;
  /** 当前运行目录内所有正式文件的有序快照，用于多文件并发保存。 */
  readonly content: string;
}

export interface WorldSimulationRepositoryV2 {
  loadScenarios(): Promise<LoadedSimulationScenarios>;
  saveScenario(current: LoadedSimulationScenarios, scenario: WorldSimulationScenario): Promise<LoadedSimulationScenarios>;
  removeScenario(current: LoadedSimulationScenarios, scenarioId: string): Promise<LoadedSimulationScenarios>;
  loadRunIndex(): Promise<LoadedSimulationRunIndex>;
  createRun(run: WorldSimulationRun): Promise<{ readonly run: LoadedWorldSimulationRun; readonly index: LoadedSimulationRunIndex }>;
  loadRun(runId: string, expectedProjectId?: string): Promise<LoadedWorldSimulationRun>;
  saveRun(current: LoadedWorldSimulationRun, run: WorldSimulationRun): Promise<{ readonly run: LoadedWorldSimulationRun; readonly index: LoadedSimulationRunIndex }>;
  removeRun(runId: string): Promise<LoadedSimulationRunIndex>;
}

interface LoadedRunFiles {
  readonly value: WorldSimulationRun;
  readonly files: ReadonlyMap<string, string>;
}

function isContentVersionConflict(cause: unknown): boolean {
  return cause instanceof Error && cause.message.includes("File changed externally");
}

async function ensureDirectory(storage: WorkbenchStorage, path: string): Promise<void> {
  const segments = path.split("/").filter(Boolean);
  for (let index = 1; index <= segments.length; index += 1) {
    const directory = segments.slice(0, index).join("/");
    const [info] = await storage.stat([directory]);
    if (info?.exists) {
      if (info.kind !== "directory") throw new Error(`推演归档路径不是目录：${directory}`);
      continue;
    }
    try {
      await storage.createDirectory(directory);
    } catch (cause) {
      const [afterCreate] = await storage.stat([directory]);
      if (!afterCreate?.exists || afterCreate.kind !== "directory") throw cause;
    }
  }
}

async function ensureCurrentTextFile(
  storage: WorkbenchStorage,
  path: string,
  initialContent: string,
  parse: (content: string) => unknown,
): Promise<WorkbenchTextFile> {
  const [info] = await storage.stat([path]);
  if (!info?.exists) {
    const separator = path.lastIndexOf("/");
    if (separator >= 0) await ensureDirectory(storage, path.slice(0, separator));
    try {
      return await storage.createText(path, initialContent);
    } catch (cause) {
      const [afterCreate] = await storage.stat([path]);
      if (!afterCreate?.exists) throw cause;
      if (afterCreate.kind !== "file") throw new Error(`推演初始化路径不是文件：${path}`);
      const file = await storage.readText(path);
      parse(file.content);
      return file;
    }
  }
  if (info.kind !== "file") throw new Error(`推演初始化路径不是文件：${path}`);
  const file = await storage.readText(path);
  parse(file.content);
  return file;
}

function runIndexEntry(run: WorldSimulationRun): SimulationRunIndexEntry {
  const branch = run.branches.find((item) => item.id === run.activeBranchId);
  if (!branch) throw new Error("运行缺少当前分支");
  return {
    id: run.id,
    projectId: run.projectId,
    name: run.name,
    scenarioId: run.scenario.id,
    activeBranchId: branch.id,
    status: branch.status,
    currentSortKey: branch.state.currentTime.sortKey,
    eventCount: branch.ledger.length,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function serializeJsonl(values: readonly unknown[]): string {
  return values.map((value) => `${JSON.stringify(value)}\n`).join("");
}

function parseJson(path: string, content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (cause) {
    throw new Error(`${path} 无法解析：${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function parseObject(path: string, content: string): Record<string, unknown> {
  const value = parseJson(path, content);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} 格式无效：根节点必须是对象`);
  }
  return value as Record<string, unknown>;
}

function parseArrayFile<T>(path: string, content: string, key: string): readonly T[] {
  const value = parseObject(path, content);
  if (value.schemaVersion !== WORLD_SIMULATION_SCHEMA_VERSION || !Array.isArray(value[key])) {
    throw new Error(`${path} 格式无效：缺少 schemaVersion 或 ${key} 数组`);
  }
  return value[key] as readonly T[];
}

function parseJsonl<T>(path: string, content: string): readonly T[] {
  if (!content) return [];
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (cause) {
        throw new Error(`${path} 第 ${index + 1} 行无法解析：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    });
}

function serializeRunSnapshot(files: ReadonlyMap<string, string>): string {
  return JSON.stringify([...files.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function createRunFiles(run: WorldSimulationRun): ReadonlyMap<string, string> {
  const manifest = createWorldSimulationRunManifest(run);
  const files = new Map<string, string>([
    [manifest.baselinePath, serializeWorldSimulation(run.baseline)],
    [manifest.councilPath, serializeWorldSimulation({
      schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
      sessions: run.councilSessions,
    })],
    [manifest.reportsPath, serializeWorldSimulation({
      schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
      reports: run.reports,
    })],
  ]);
  for (const [index, branch] of run.branches.entries()) {
    const entry = manifest.branches[index];
    if (!entry || entry.id !== branch.id) throw new Error("推演分支清单与运行数据不一致");
    files.set(entry.statePath, serializeWorldSimulation(branch.state));
    files.set(entry.eventLedgerPath, serializeJsonl(branch.ledger));
    files.set(entry.observationsPath, serializeWorldSimulation({
      schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
      observations: branch.observations,
    }));
    files.set(entry.checkpointsPath, serializeJsonl(branch.checkpoints));
  }
  files.set(worldSimulationRunPath(run.id), serializeWorldSimulation(manifest));
  return files;
}

async function loadRunFiles(storage: WorkbenchStorage, runId: string): Promise<LoadedRunFiles> {
  const files = new Map<string, string>();
  const read = async (path: string): Promise<string> => {
    const existing = files.get(path);
    if (existing !== undefined) return existing;
    const content = (await storage.readText(path)).content;
    files.set(path, content);
    return content;
  };
  const manifestPath = worldSimulationRunPath(runId);
  const manifest = parseWorldSimulationRunManifest(await read(manifestPath));
  if (manifest.id !== runId) throw new Error("推演运行清单身份与目录不一致");

  const baseline = parseObject(manifest.baselinePath, await read(manifest.baselinePath));
  if (baseline.projectId !== manifest.projectId) {
    throw new Error("推演基线不属于运行清单声明的小说项目");
  }
  const councilSessions = parseArrayFile(
    manifest.councilPath,
    await read(manifest.councilPath),
    "sessions",
  );
  const reports = parseArrayFile(
    manifest.reportsPath,
    await read(manifest.reportsPath),
    "reports",
  );
  const branches = await Promise.all(manifest.branches.map(async (branch) => {
    const { statePath, eventLedgerPath, observationsPath, checkpointsPath, ...metadata } = branch;
    return {
      ...metadata,
      state: parseObject(statePath, await read(statePath)),
      ledger: parseJsonl(eventLedgerPath, await read(eventLedgerPath)),
      observations: parseArrayFile(
        observationsPath,
        await read(observationsPath),
        "observations",
      ),
      checkpoints: parseJsonl(checkpointsPath, await read(checkpointsPath)),
    } as unknown as SimulationBranch;
  }));
  const value = parseWorldSimulationRun(serializeWorldSimulation({
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    projectId: manifest.projectId,
    name: manifest.name,
    scenario: manifest.scenario,
    baseline,
    activeBranchId: manifest.activeBranchId,
    branches,
    councilSessions,
    reports,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  }));
  return { value, files };
}

function assertAppendOnly(path: string, previous: string, next: string): void {
  if (!next.startsWith(previous)) throw new Error(`推演 JSONL 账本不能回退或改写：${path}`);
}

async function writeRunFiles(
  storage: WorkbenchStorage,
  run: WorldSimulationRun,
  currentFiles?: ReadonlyMap<string, string>,
): Promise<void> {
  const nextFiles = createRunFiles(run);
  await ensureDirectory(storage, worldSimulationRunRoot(run.id));
  await ensureDirectory(storage, `${worldSimulationRunRoot(run.id)}/reports`);
  for (const branch of run.branches) {
    await ensureDirectory(storage, worldSimulationBranchRoot(run.id, branch.id));
  }

  const manifestPath = worldSimulationRunPath(run.id);
  const orderedPaths = [...nextFiles.keys()].sort((left, right) => {
    if (left === manifestPath) return 1;
    if (right === manifestPath) return -1;
    return left.localeCompare(right);
  });
  const transaction = createStorageTransaction(storage);
  for (const path of orderedPaths) {
    const content = nextFiles.get(path);
    if (content === undefined) continue;
    const previous = currentFiles?.get(path);
    if (previous === content) continue;
    if (previous === undefined) {
      transaction.createText(path, content);
      continue;
    }
    if (path.endsWith(".jsonl")) assertAppendOnly(path, previous, content);
    transaction.writeText(path, content, previous);
  }
  await transaction.commit();

  if (currentFiles) {
    const removedPaths = [...currentFiles.keys()].filter((path) => !nextFiles.has(path));
    await Promise.allSettled(
      removedPaths.map((path) => storage.remove(path, { permanent: true })),
    );
  }
}

export function createWorldSimulationV2InitializationFiles(): readonly { readonly path: string; readonly content: string }[] {
  return [
    { path: WORLD_SIMULATION_PATHS.scenarios, content: serializeWorldSimulation(createEmptySimulationScenarioFile()) },
    { path: WORLD_SIMULATION_PATHS.runIndex, content: serializeWorldSimulation(createEmptySimulationRunIndex()) },
  ];
}

export function createWorldSimulationRepositoryV2(storage: WorkbenchStorage): WorldSimulationRepositoryV2 {
  const loadScenarios = async (): Promise<LoadedSimulationScenarios> => {
    if (!storage.isAvailable) throw new Error("世界推演仅在 MyAgents 桌面端可用");
    const initial = serializeWorldSimulation(createEmptySimulationScenarioFile());
    const file = await ensureCurrentTextFile(storage, WORLD_SIMULATION_PATHS.scenarios, initial, parseSimulationScenarioFile);
    return Object.freeze({ value: parseSimulationScenarioFile(file.content), content: file.content });
  };

  const loadRunIndex = async (): Promise<LoadedSimulationRunIndex> => {
    if (!storage.isAvailable) throw new Error("世界推演仅在 MyAgents 桌面端可用");
    const initial = serializeWorldSimulation(createEmptySimulationRunIndex());
    const file = await ensureCurrentTextFile(storage, WORLD_SIMULATION_PATHS.runIndex, initial, parseSimulationRunIndex);
    return Object.freeze({ value: parseSimulationRunIndex(file.content), content: file.content });
  };

  const saveIndex = async (current: LoadedSimulationRunIndex, value: SimulationRunIndexFile): Promise<LoadedSimulationRunIndex> => {
    const content = serializeWorldSimulation(value);
    const file = await storage.writeText(WORLD_SIMULATION_PATHS.runIndex, content, { expectedContent: current.content });
    return Object.freeze({ value: parseSimulationRunIndex(file.content), content: file.content });
  };

  const upsertIndex = async (run: WorldSimulationRun): Promise<LoadedSimulationRunIndex> => {
    const current = await loadRunIndex();
    const entry = runIndexEntry(run);
    const runs = [entry, ...current.value.runs.filter((item) => item.id !== run.id)]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 200);
    return saveIndex(current, { schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION, runs, activeRunId: run.id });
  };

  const repository: WorldSimulationRepositoryV2 = {
    loadScenarios,

    async saveScenario(current, scenario) {
      const parsed = worldSimulationScenarioSchema.parse(scenario);
      const save = async (source: LoadedSimulationScenarios): Promise<LoadedSimulationScenarios> => {
        const scenarios = [...source.value.scenarios.filter((item) => item.id !== parsed.id), parsed]
          .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
        const content = serializeWorldSimulation({ schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION, scenarios, activeScenarioId: parsed.id });
        const file = await storage.writeText(WORLD_SIMULATION_PATHS.scenarios, content, { expectedContent: source.content });
        return Object.freeze({ value: parseSimulationScenarioFile(file.content), content: file.content });
      };
      try {
        return await save(current);
      } catch (cause) {
        if (!isContentVersionConflict(cause)) throw cause;
        return save(await loadScenarios());
      }
    },

    async removeScenario(current, scenarioId) {
      const remove = async (source: LoadedSimulationScenarios): Promise<LoadedSimulationScenarios> => {
        const scenarios = source.value.scenarios.filter((item) => item.id !== scenarioId);
        if (scenarios.length === 0) throw new Error("至少保留一个推演方案");
        const activeScenarioId = source.value.activeScenarioId === scenarioId ? scenarios[0]!.id : source.value.activeScenarioId;
        const content = serializeWorldSimulation({ schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION, scenarios, activeScenarioId });
        const file = await storage.writeText(WORLD_SIMULATION_PATHS.scenarios, content, { expectedContent: source.content });
        return Object.freeze({ value: parseSimulationScenarioFile(file.content), content: file.content });
      };
      try {
        return await remove(current);
      } catch (cause) {
        if (!isContentVersionConflict(cause)) throw cause;
        return remove(await loadScenarios());
      }
    },

    loadRunIndex,

    async createRun(run) {
      const parsed = parseWorldSimulationRun(serializeWorldSimulation(run));
      await writeRunFiles(storage, parsed);
      const loaded = await loadRunFiles(storage, parsed.id);
      const index = await upsertIndex(loaded.value);
      return {
        run: Object.freeze({ value: loaded.value, content: serializeRunSnapshot(loaded.files) }),
        index,
      };
    },

    async loadRun(runId, expectedProjectId) {
      const loaded = await loadRunFiles(storage, runId);
      if (expectedProjectId && loaded.value.projectId !== expectedProjectId) {
        throw new Error("推演运行不属于当前小说项目");
      }
      return Object.freeze({ value: loaded.value, content: serializeRunSnapshot(loaded.files) });
    },

    async saveRun(current, run) {
      if (run.id !== current.value.id || run.projectId !== current.value.projectId) {
        throw new Error("保存推演时不得修改运行或项目身份");
      }
      const onDisk = await loadRunFiles(storage, run.id);
      if (serializeRunSnapshot(onDisk.files) !== current.content) {
        throw new Error("推演运行事实源已被外部修改，请重新加载后再保存");
      }
      const parsed = parseWorldSimulationRun(serializeWorldSimulation(run));
      await writeRunFiles(storage, parsed, onDisk.files);
      const loaded = await loadRunFiles(storage, parsed.id);
      const index = await upsertIndex(loaded.value);
      return {
        run: Object.freeze({ value: loaded.value, content: serializeRunSnapshot(loaded.files) }),
        index,
      };
    },

    async removeRun(runId) {
      const current = await loadRunIndex();
      const entry = current.value.runs.find((item) => item.id === runId);
      if (!entry) return current;
      await storage.remove(worldSimulationRunRoot(runId), { permanent: true });
      const runs = current.value.runs.filter((item) => item.id !== runId);
      return saveIndex(current, {
        schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
        runs,
        activeRunId: current.value.activeRunId === runId ? runs[0]?.id ?? null : current.value.activeRunId,
      });
    },
  };
  return Object.freeze(repository);
}
