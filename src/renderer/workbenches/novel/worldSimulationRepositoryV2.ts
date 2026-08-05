import type { WorkbenchStorage, WorkbenchTextFile } from "@/workbench-sdk";

import {
  WORLD_SIMULATION_PATHS,
  WORLD_SIMULATION_SCHEMA_VERSION,
  createEmptySimulationRunIndex,
  createEmptySimulationScenarioFile,
  parseSimulationRunIndex,
  parseSimulationScenarioFile,
  parseWorldSimulationRun,
  serializeWorldSimulation,
  worldSimulationRunPath,
  worldSimulationScenarioSchema,
  type SimulationRunIndexEntry,
  type SimulationRunIndexFile,
  type SimulationScenarioFile,
  type WorldSimulationRun,
  type WorldSimulationScenario,
} from "./worldSimulationV2Schema";

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

function olderSimulationSchemaVersion(content: string): number | null {
  try {
    const value: unknown = JSON.parse(content);
    const schemaVersion =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as { schemaVersion?: unknown }).schemaVersion
        : null;
    return (
      typeof schemaVersion === "number" &&
      Number.isInteger(schemaVersion) &&
      schemaVersion < WORLD_SIMULATION_SCHEMA_VERSION
    )
      ? schemaVersion
      : null;
  } catch {
    return null;
  }
}

function isContentVersionConflict(cause: unknown): boolean {
  return cause instanceof Error && cause.message.includes("File changed externally");
}

async function ensureDirectory(
  storage: WorkbenchStorage,
  path: string,
): Promise<void> {
  const segments = path.split("/").filter(Boolean);
  for (let index = 1; index <= segments.length; index += 1) {
    const directory = segments.slice(0, index).join("/");
    const [info] = await storage.stat([directory]);
    if (info?.exists) {
      if (info.kind !== "directory")
        throw new Error(`推演归档路径不是目录：${directory}`);
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

function legacyArchivePath(path: string, schemaVersion: number): string {
  const relative = path.startsWith("simulation/")
    ? path.slice("simulation/".length)
    : path;
  return `simulation/legacy/schema-v${schemaVersion}/${relative}`;
}

async function archiveHistoricalSimulationFile(
  storage: WorkbenchStorage,
  path: string,
  content: string,
  schemaVersion: number,
): Promise<void> {
  const archivePath = legacyArchivePath(path, schemaVersion);
  const separator = archivePath.lastIndexOf("/");
  if (separator >= 0)
    await ensureDirectory(storage, archivePath.slice(0, separator));
  const [existing] = await storage.stat([archivePath]);
  if (existing?.exists) {
    if (existing.kind !== "file")
      throw new Error(`推演历史归档路径不是文件：${archivePath}`);
    const archived = await storage.readText(archivePath);
    if (archived.content !== content)
      throw new Error(
        `推演历史归档已存在不同内容：${archivePath}。为保护旧数据，未覆盖原文件。`,
      );
    return;
  }
  try {
    await storage.createText(archivePath, content);
  } catch (cause) {
    const [afterCreate] = await storage.stat([archivePath]);
    if (!afterCreate?.exists || afterCreate.kind !== "file") throw cause;
    const archived = await storage.readText(archivePath);
    if (archived.content !== content) throw cause;
  }
}

async function ensureV2TextFile(
  storage: WorkbenchStorage,
  path: string,
  initialContent: string,
  parse: (content: string) => unknown,
): Promise<WorkbenchTextFile> {
  const [info] = await storage.stat([path]);
  if (!info?.exists) {
    const separator = path.lastIndexOf("/");
    const parent = separator < 0 ? "" : path.slice(0, separator);
    if (parent) await storage.createDirectory(parent);
    try {
      return await storage.createText(path, initialContent);
    } catch (cause) {
      const [afterCreate] = await storage.stat([path]);
      if (!afterCreate?.exists) throw cause;
      if (afterCreate.kind !== "file") throw new Error(`推演初始化路径不是文件：${path}`);
      return storage.readText(path);
    }
  }
  if (info.kind !== "file") throw new Error(`推演初始化路径不是文件：${path}`);
  const file = await storage.readText(path);
  try {
    parse(file.content);
    return file;
  } catch (cause) {
    const schemaVersion = olderSimulationSchemaVersion(file.content);
    if (schemaVersion === null) throw cause;
    await archiveHistoricalSimulationFile(
      storage,
      path,
      file.content,
      schemaVersion,
    );
    return storage.writeText(path, initialContent, { expectedContent: file.content });
  }
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

async function writeAppendOnlyJsonl(
  storage: WorkbenchStorage,
  path: string,
  values: readonly unknown[],
): Promise<void> {
  const nextContent = serializeJsonl(values);
  const [info] = await storage.stat([path]);
  if (!info?.exists) {
    try {
      await storage.createText(path, nextContent);
      return;
    } catch (cause) {
      const [afterCreate] = await storage.stat([path]);
      if (!afterCreate?.exists || afterCreate.kind !== "file") throw cause;
    }
  }
  const current = await storage.readText(path);
  const existingLines = current.content === ""
    ? []
    : current.content.split("\n").filter((line) => line.length > 0);
  if (existingLines.length > values.length) {
    throw new Error(`推演 JSONL 账本不能回退：${path}`);
  }
  const expectedExisting = serializeJsonl(values.slice(0, existingLines.length));
  if (current.content !== expectedExisting) {
    throw new Error(`推演 JSONL 账本已被外部修改：${path}`);
  }
  const appended = nextContent.slice(expectedExisting.length);
  if (appended) {
    await storage.writeText(path, `${current.content}${appended}`, {
      expectedContent: current.content,
    });
  }
}

async function writeMaterializedRunFiles(storage: WorkbenchStorage, run: WorldSimulationRun): Promise<void> {
  const root = `${WORLD_SIMULATION_PATHS.runRoot}/${run.id}`;
  await storage.createDirectory(root);
  await storage.createDirectory(`${root}/reports`);
  await storage.createDirectory(`${root}/branches`);
  for (const branch of run.branches) {
    await storage.createDirectory(`${root}/branches/${branch.id}`);
  }

  const files: readonly { readonly path: string; readonly value: unknown }[] = [
    { path: `${root}/baseline.json`, value: run.baseline },
    { path: `${root}/council.json`, value: { schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION, sessions: run.councilSessions } },
    { path: `${root}/reports/index.json`, value: { schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION, reports: run.reports } },
    ...run.branches.flatMap((branch) => {
      const branchRoot = `${root}/branches/${branch.id}`;
      return [
        { path: `${branchRoot}/state.json`, value: branch.state },
        { path: `${branchRoot}/observations.json`, value: { schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION, observations: branch.observations } },
      ];
    }),
  ];
  for (const { path, value } of files) {
    const content = serializeWorldSimulation(value);
    const [info] = await storage.stat([path]);
    if (info?.exists) {
      if (info.kind !== "file") throw new Error(`推演物化路径不是文件：${path}`);
      const current = await storage.readText(path);
      await storage.writeText(path, content, { expectedContent: current.content });
    } else {
      try {
        await storage.createText(path, content);
      } catch (cause) {
        const [afterCreate] = await storage.stat([path]);
        if (!afterCreate?.exists) throw cause;
        if (afterCreate.kind !== "file") throw new Error(`推演物化路径不是文件：${path}`);
        const current = await storage.readText(path);
        await storage.writeText(path, content, { expectedContent: current.content });
      }
    }
  }
  for (const branch of run.branches) {
    const branchRoot = `${root}/branches/${branch.id}`;
    await writeAppendOnlyJsonl(
      storage,
      `${branchRoot}/${WORLD_SIMULATION_PATHS.branchEventLedgerFile}`,
      branch.ledger,
    );
    await writeAppendOnlyJsonl(
      storage,
      `${branchRoot}/${WORLD_SIMULATION_PATHS.branchCheckpointsFile}`,
      branch.checkpoints,
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
    const file = await ensureV2TextFile(storage, WORLD_SIMULATION_PATHS.scenarios, initial, parseSimulationScenarioFile);
    return Object.freeze({ value: parseSimulationScenarioFile(file.content), content: file.content });
  };

  const loadRunIndex = async (): Promise<LoadedSimulationRunIndex> => {
    if (!storage.isAvailable) throw new Error("世界推演仅在 MyAgents 桌面端可用");
    const initial = serializeWorldSimulation(createEmptySimulationRunIndex());
    const file = await ensureV2TextFile(storage, WORLD_SIMULATION_PATHS.runIndex, initial, parseSimulationRunIndex);
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
      const root = `${WORLD_SIMULATION_PATHS.runRoot}/${run.id}`;
      await storage.createDirectory(root);
      const path = worldSimulationRunPath(run.id);
      const content = serializeWorldSimulation(run);
      const file = await storage.createText(path, content);
      await writeMaterializedRunFiles(storage, run);
      const index = await upsertIndex(run);
      return { run: Object.freeze({ value: parseWorldSimulationRun(file.content), content: file.content }), index };
    },

    async loadRun(runId, expectedProjectId) {
      const file = await storage.readText(worldSimulationRunPath(runId));
      const value = parseWorldSimulationRun(file.content);
      if (expectedProjectId && value.projectId !== expectedProjectId) throw new Error("推演运行不属于当前小说项目");
      return Object.freeze({ value, content: file.content });
    },

    async saveRun(current, run) {
      if (run.id !== current.value.id || run.projectId !== current.value.projectId) throw new Error("保存推演时不得修改运行或项目身份");
      const content = serializeWorldSimulation(run);
      const file = await storage.writeText(worldSimulationRunPath(run.id), content, { expectedContent: current.content });
      await writeMaterializedRunFiles(storage, run);
      const index = await upsertIndex(run);
      return { run: Object.freeze({ value: parseWorldSimulationRun(file.content), content: file.content }), index };
    },

    async removeRun(runId) {
      const current = await loadRunIndex();
      const entry = current.value.runs.find((item) => item.id === runId);
      if (!entry) return current;
      await storage.remove(`${WORLD_SIMULATION_PATHS.runRoot}/${runId}`, { permanent: true });
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
