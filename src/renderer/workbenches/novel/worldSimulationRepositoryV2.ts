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
  saveScenario(
    current: LoadedSimulationScenarios,
    scenario: WorldSimulationScenario,
  ): Promise<LoadedSimulationScenarios>;
  removeScenario(
    current: LoadedSimulationScenarios,
    scenarioId: string,
  ): Promise<LoadedSimulationScenarios>;
  loadRunIndex(): Promise<LoadedSimulationRunIndex>;
  activateRun(runId: string): Promise<LoadedSimulationRunIndex>;
  createRun(run: WorldSimulationRun): Promise<{
    readonly run: LoadedWorldSimulationRun;
    readonly index: LoadedSimulationRunIndex;
  }>;
  loadRun(
    runId: string,
    expectedProjectId?: string,
  ): Promise<LoadedWorldSimulationRun>;
  saveRun(
    current: LoadedWorldSimulationRun,
    run: WorldSimulationRun,
  ): Promise<{
    readonly run: LoadedWorldSimulationRun;
    readonly index: LoadedSimulationRunIndex;
  }>;
  removeRun(runId: string): Promise<LoadedSimulationRunIndex>;
}

interface LoadedRunFiles {
  readonly value: WorldSimulationRun;
  readonly files: ReadonlyMap<string, string>;
}

function isContentVersionConflict(cause: unknown): boolean {
  return (
    cause instanceof Error && cause.message.includes("File changed externally")
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const CONTENT_CONFLICT_RETRIES = 4;

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

async function ensureTextFile(
  storage: WorkbenchStorage,
  path: string,
  initialContent: string,
): Promise<WorkbenchTextFile> {
  const [info] = await storage.stat([path]);
  if (!info?.exists) {
    const separator = path.lastIndexOf("/");
    if (separator >= 0)
      await ensureDirectory(storage, path.slice(0, separator));
    try {
      return await storage.createText(path, initialContent);
    } catch (cause) {
      const [afterCreate] = await storage.stat([path]);
      if (!afterCreate?.exists) throw cause;
      if (afterCreate.kind !== "file")
        throw new Error(`推演初始化路径不是文件：${path}`);
      return storage.readText(path);
    }
  }
  if (info.kind !== "file") throw new Error(`推演初始化路径不是文件：${path}`);
  return storage.readText(path);
}

function isLegacySimulationIndex(content: string): boolean {
  try {
    const value = JSON.parse(content) as unknown;
    const visit = (candidate: unknown, isRoot = false): boolean => {
      if (Array.isArray(candidate)) return candidate.some((item) => visit(item));
      if (!candidate || typeof candidate !== "object") return false;
      const record = candidate as Record<string, unknown>;
      const schemaVersion = record.schemaVersion;
      // V1-V3 的部分项目文件没有写版本号，只有 scenarios/runs 这类
      // 顶层集合。它们同样不具备 V4 契约，必须走一次空存储重建；
      // 当前版本带 schemaVersion=4 但内部结构损坏则交给 Zod 报错。
      if (
        isRoot &&
        schemaVersion === undefined &&
        ("scenarios" in record ||
          "runs" in record ||
          "activeScenarioId" in record ||
          "activeRunId" in record)
      ) {
        return true;
      }
      if (
        typeof schemaVersion === "number" &&
        Number.isInteger(schemaVersion) &&
        schemaVersion >= 1 &&
        schemaVersion < WORLD_SIMULATION_SCHEMA_VERSION
      ) {
        return true;
      }
      return Object.values(record).some((item) => visit(item));
    };
    return visit(value, true);
  } catch {
    return false;
  }
}

async function removeFilesUnder(
  storage: WorkbenchStorage,
  directory: string,
  preservedPaths: ReadonlySet<string>,
): Promise<void> {
  const entries = await storage.list(directory);
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.kind === "directory") {
        await removeFilesUnder(storage, entry.path, preservedPaths);
        return;
      }
      if (preservedPaths.has(entry.path)) return;
      await storage.remove(entry.path, { permanent: true });
    }),
  );
}

function runIndexEntry(run: WorldSimulationRun): SimulationRunIndexEntry {
  const branch = run.branches.find((item) => item.id === run.activeBranchId);
  if (!branch) throw new Error("运行缺少当前分支");
  const currentTime = branch.state.currentTime;
  return {
    id: run.id,
    projectId: run.projectId,
    name: run.name,
    scenarioId: run.scenario.id,
    activeBranchId: branch.id,
    status: branch.status,
    currentSortKey: currentTime.sortKey,
    eventCount: branch.ledger.length,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    anchorDisplayText: run.baseline.anchor?.displayText ?? "世界日 0",
    duration: run.scenario.duration,
    roundSpan: run.scenario.roundSpan,
    branches: run.branches.map((item) => ({
      id: item.id,
      name: item.name,
      parentBranchId: item.parentBranchId,
      status: item.status,
      currentSortKey: item.state.currentTime.sortKey,
      currentTimeDisplayText:
        item.state.currentTime.displayText ??
        "世界日 " + item.state.currentTime.sortKey,
      eventCount: item.ledger.length,
    })),
  };
}

function serializeJsonl(values: readonly unknown[]): string {
  return values.map((value) => `${JSON.stringify(value)}\n`).join("");
}

function parseJson(path: string, content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (cause) {
    throw new Error(
      `${path} 无法解析：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function parseObject(path: string, content: string): Record<string, unknown> {
  const value = parseJson(path, content);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} 格式无效：根节点必须是对象`);
  }
  return value as Record<string, unknown>;
}

function parseArrayFile<T>(
  path: string,
  content: string,
  key: string,
): readonly T[] {
  const value = parseObject(path, content);
  if (
    value.schemaVersion !== WORLD_SIMULATION_SCHEMA_VERSION ||
    !Array.isArray(value[key])
  ) {
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
        throw new Error(
          `${path} 第 ${index + 1} 行无法解析：${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    });
}

function serializeRunSnapshot(files: ReadonlyMap<string, string>): string {
  return JSON.stringify(
    [...files.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function createRunFiles(run: WorldSimulationRun): ReadonlyMap<string, string> {
  const manifest = createWorldSimulationRunManifest(run);
  const files = new Map<string, string>([
    [manifest.baselinePath, serializeWorldSimulation(run.baseline)],
    [
      manifest.councilPath,
      serializeWorldSimulation({
        schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
        sessions: run.councilSessions,
      }),
    ],
    [
      manifest.reportsPath,
      serializeWorldSimulation({
        schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
        reports: run.reports,
      }),
    ],
  ]);
  for (const [index, branch] of run.branches.entries()) {
    const entry = manifest.branches[index];
    if (!entry || entry.id !== branch.id)
      throw new Error("推演分支清单与运行数据不一致");
    files.set(entry.statePath, serializeWorldSimulation(branch.state));
    files.set(entry.eventLedgerPath, serializeJsonl(branch.ledger));
    files.set(
      entry.observationsPath,
      serializeWorldSimulation({
        schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
        observations: branch.observations,
      }),
    );
    files.set(entry.checkpointsPath, serializeJsonl(branch.checkpoints));
  }
  files.set(worldSimulationRunPath(run.id), serializeWorldSimulation(manifest));
  return files;
}

async function loadRunFiles(
  storage: WorkbenchStorage,
  runId: string,
): Promise<LoadedRunFiles> {
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

  const baseline = parseObject(
    manifest.baselinePath,
    await read(manifest.baselinePath),
  );
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
  const branches = await Promise.all(
    manifest.branches.map(async (branch) => {
      const {
        statePath,
        eventLedgerPath,
        observationsPath,
        checkpointsPath,
        ...metadata
      } = branch;
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
    }),
  );
  const value = parseWorldSimulationRun(
    serializeWorldSimulation({
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
    }),
  );
  return { value, files };
}

function assertAppendOnly(path: string, previous: string, next: string): void {
  if (!next.startsWith(previous))
    throw new Error(`推演 JSONL 账本不能回退或改写：${path}`);
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
    await ensureDirectory(
      storage,
      worldSimulationBranchRoot(run.id, branch.id),
    );
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
    const removedPaths = [...currentFiles.keys()].filter(
      (path) => !nextFiles.has(path),
    );
    await Promise.allSettled(
      removedPaths.map((path) => storage.remove(path, { permanent: true })),
    );
  }
}

export function createWorldSimulationV2InitializationFiles(): readonly {
  readonly path: string;
  readonly content: string;
}[] {
  return [
    {
      path: WORLD_SIMULATION_PATHS.scenarios,
      content: serializeWorldSimulation(createEmptySimulationScenarioFile()),
    },
    {
      path: WORLD_SIMULATION_PATHS.runIndex,
      content: serializeWorldSimulation(createEmptySimulationRunIndex()),
    },
  ];
}

export function createWorldSimulationRepositoryV2(
  storage: WorkbenchStorage,
): WorldSimulationRepositoryV2 {
  let legacyReset: Promise<void> | null = null;

  const resetLegacySimulationStorage = async (
    scenarios: WorkbenchTextFile,
    runIndex: WorkbenchTextFile,
  ): Promise<void> => {
    const scenarioContent = serializeWorldSimulation(
      createEmptySimulationScenarioFile(),
    );
    const runIndexContent = serializeWorldSimulation(
      createEmptySimulationRunIndex(),
    );

    // V1-V3 运行没有可迁移的 V4 语义。多个工作台实例可能同时发现旧
    // 文件，因此重建必须是幂等的：若另一实例已经完成替换，直接复用其
    // 结果；若只替换成功一个文件，则基于最新快照重试另一个文件。
    let currentScenarios = scenarios;
    let currentRunIndex = runIndex;
    let wroteStorage = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const writes = await Promise.allSettled([
        storage.writeText(WORLD_SIMULATION_PATHS.scenarios, scenarioContent, {
          expectedContent: currentScenarios.content,
        }),
        storage.writeText(WORLD_SIMULATION_PATHS.runIndex, runIndexContent, {
          expectedContent: currentRunIndex.content,
        }),
      ]);
      const rejected = writes.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (!rejected) {
        wroteStorage = true;
        break;
      }
      if (!isContentVersionConflict(rejected.reason)) throw rejected.reason;

      const [latestScenarios, latestRunIndex] = await Promise.all([
        storage.readText(WORLD_SIMULATION_PATHS.scenarios),
        storage.readText(WORLD_SIMULATION_PATHS.runIndex),
      ]);
      if (
        !isLegacySimulationIndex(latestScenarios.content) &&
        !isLegacySimulationIndex(latestRunIndex.content)
      ) {
        // 另一实例已经完成了重建；不要再次清理它可能刚刚创建的运行文件。
        return;
      }
      currentScenarios = latestScenarios;
      currentRunIndex = latestRunIndex;
    }
    if (!wroteStorage) {
      throw new Error("世界推演旧版存储正在被其他窗口重建，请稍后重试");
    }

    // 只有本次调用真正完成替换时才清理旧运行文件，避免并发实例误删
    // 另一实例已经创建的新 V4 运行。
    await removeFilesUnder(
      storage,
      WORLD_SIMULATION_PATHS.runRoot,
      new Set([WORLD_SIMULATION_PATHS.runIndex]),
    );
  };

  const ensureV4SimulationStorage = async (): Promise<void> => {
    if (legacyReset) return legacyReset;
    legacyReset = (async () => {
      const scenarios = await ensureTextFile(
        storage,
        WORLD_SIMULATION_PATHS.scenarios,
        serializeWorldSimulation(createEmptySimulationScenarioFile()),
      );
      const runIndex = await ensureTextFile(
        storage,
        WORLD_SIMULATION_PATHS.runIndex,
        serializeWorldSimulation(createEmptySimulationRunIndex()),
      );
      if (
        !isLegacySimulationIndex(scenarios.content) &&
        !isLegacySimulationIndex(runIndex.content)
      ) {
        return;
      }
      await resetLegacySimulationStorage(scenarios, runIndex);
    })();
    try {
      await legacyReset;
    } finally {
      legacyReset = null;
    }
  };

  const loadScenarios = async (): Promise<LoadedSimulationScenarios> => {
    if (!storage.isAvailable)
      throw new Error("世界推演仅在 MyAgents 桌面端可用");
    await ensureV4SimulationStorage();
    const file = await ensureTextFile(
      storage,
      WORLD_SIMULATION_PATHS.scenarios,
      serializeWorldSimulation(createEmptySimulationScenarioFile()),
    );
    return Object.freeze({
      value: parseSimulationScenarioFile(file.content),
      content: file.content,
    });
  };

  const loadRunIndex = async (): Promise<LoadedSimulationRunIndex> => {
    if (!storage.isAvailable)
      throw new Error("世界推演仅在 MyAgents 桌面端可用");
    await ensureV4SimulationStorage();
    const file = await ensureTextFile(
      storage,
      WORLD_SIMULATION_PATHS.runIndex,
      serializeWorldSimulation(createEmptySimulationRunIndex()),
    );
    return Object.freeze({
      value: parseSimulationRunIndex(file.content),
      content: file.content,
    });
  };

  const saveIndex = async (
    current: LoadedSimulationRunIndex,
    value: SimulationRunIndexFile,
  ): Promise<LoadedSimulationRunIndex> => {
    const content = serializeWorldSimulation(value);
    const file = await storage.writeText(
      WORLD_SIMULATION_PATHS.runIndex,
      content,
      { expectedContent: current.content },
    );
    return Object.freeze({
      value: parseSimulationRunIndex(file.content),
      content: file.content,
    });
  };

  const upsertIndex = async (
    run: WorldSimulationRun,
  ): Promise<LoadedSimulationRunIndex> => {
    const entry = runIndexEntry(run);
    let lastConflict: unknown = null;
    for (let attempt = 0; attempt < CONTENT_CONFLICT_RETRIES; attempt += 1) {
      const current = await loadRunIndex();
      const runs = [
        entry,
        ...current.value.runs.filter((item) => item.id !== run.id),
      ]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 200);
      try {
        return await saveIndex(current, {
          schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
          runs,
          activeRunId: run.id,
        });
      } catch (cause) {
        if (!isContentVersionConflict(cause)) throw cause;
        lastConflict = cause;
      }
    }
    throw lastConflict ?? new Error("推演运行索引连续被其他窗口更新");
  };

  const repository: WorldSimulationRepositoryV2 = {
    loadScenarios,

    async saveScenario(current, scenario) {
      const parsed = worldSimulationScenarioSchema.parse(scenario);
      let source = current;
      let lastConflict: unknown = null;
      for (
        let attempt = 0;
        attempt < CONTENT_CONFLICT_RETRIES;
        attempt += 1
      ) {
        const scenarios = [
          ...source.value.scenarios.filter((item) => item.id !== parsed.id),
          parsed,
        ].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
        const content = serializeWorldSimulation({
          schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
          scenarios,
          activeScenarioId: parsed.id,
        });
        try {
          const file = await storage.writeText(
            WORLD_SIMULATION_PATHS.scenarios,
            content,
            { expectedContent: source.content },
          );
          return Object.freeze({
            value: parseSimulationScenarioFile(file.content),
            content: file.content,
          });
        } catch (cause) {
          if (!isContentVersionConflict(cause)) throw cause;
          lastConflict = cause;
          source = await loadScenarios();
        }
      }
      throw lastConflict ?? new Error("世界推演方案连续被其他窗口更新");
    },

    async removeScenario(current, scenarioId) {
      let source = current;
      let lastConflict: unknown = null;
      for (
        let attempt = 0;
        attempt < CONTENT_CONFLICT_RETRIES;
        attempt += 1
      ) {
        const scenarios = source.value.scenarios.filter(
          (item) => item.id !== scenarioId,
        );
        if (scenarios.length === 0) throw new Error("至少保留一个推演方案");
        const activeScenarioId =
          source.value.activeScenarioId === scenarioId
            ? scenarios[0]!.id
            : source.value.activeScenarioId;
        const content = serializeWorldSimulation({
          schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
          scenarios,
          activeScenarioId,
        });
        try {
          const file = await storage.writeText(
            WORLD_SIMULATION_PATHS.scenarios,
            content,
            { expectedContent: source.content },
          );
          return Object.freeze({
            value: parseSimulationScenarioFile(file.content),
            content: file.content,
          });
        } catch (cause) {
          if (!isContentVersionConflict(cause)) throw cause;
          lastConflict = cause;
          source = await loadScenarios();
        }
      }
      throw lastConflict ?? new Error("世界推演方案连续被其他窗口更新");
    },

    loadRunIndex,

    async activateRun(runId) {
      let lastConflict: unknown = null;
      for (let attempt = 0; attempt < CONTENT_CONFLICT_RETRIES; attempt += 1) {
        const current = await loadRunIndex();
        if (!current.value.runs.some((run) => run.id === runId)) {
          throw new Error("推演运行记录不存在");
        }
        try {
          return await saveIndex(current, {
            ...current.value,
            activeRunId: runId,
          });
        } catch (cause) {
          if (!isContentVersionConflict(cause)) throw cause;
          lastConflict = cause;
        }
      }
      throw lastConflict ?? new Error("推演运行索引连续被其他窗口更新");
    },

    async createRun(run) {
      const parsed = parseWorldSimulationRun(serializeWorldSimulation(run));
      await writeRunFiles(storage, parsed);
      const loaded = await loadRunFiles(storage, parsed.id);
      const index = await upsertIndex(loaded.value);
      return {
        run: Object.freeze({
          value: loaded.value,
          content: serializeRunSnapshot(loaded.files),
        }),
        index,
      };
    },

    async loadRun(runId, expectedProjectId) {
      const loaded = await loadRunFiles(storage, runId);
      if (expectedProjectId && loaded.value.projectId !== expectedProjectId) {
        throw new Error("推演运行不属于当前小说项目");
      }
      return Object.freeze({
        value: loaded.value,
        content: serializeRunSnapshot(loaded.files),
      });
    },

    async saveRun(current, run) {
      if (
        run.id !== current.value.id ||
        run.projectId !== current.value.projectId
      ) {
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
        run: Object.freeze({
          value: loaded.value,
          content: serializeRunSnapshot(loaded.files),
        }),
        index,
      };
    },

    async removeRun(runId) {
      const current = await loadRunIndex();
      const entry = current.value.runs.find((item) => item.id === runId);
      if (!entry) return current;
      const runs = current.value.runs.filter((item) => item.id !== runId);
      const next = await saveIndex(current, {
        schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
        runs,
        activeRunId:
          current.value.activeRunId === runId
            ? (runs[0]?.id ?? null)
            : current.value.activeRunId,
      });
      // 先提交索引 CAS，再清理运行目录。索引写失败时保留完整运行，
      // 避免留下指向已删除目录的正式记录。
      try {
        await storage.remove(worldSimulationRunRoot(runId), {
          permanent: true,
        });
      } catch (cause) {
        try {
          await storage.writeText(
            WORLD_SIMULATION_PATHS.runIndex,
            current.content,
            {
              expectedContent: next.content,
            },
          );
        } catch (rollbackCause) {
          throw new Error(
            `删除推演运行目录失败（${errorText(cause)}），且无法恢复运行索引：${errorText(rollbackCause)}`,
          );
        }
        throw new Error(
          `删除推演运行目录失败，已恢复运行索引：${errorText(cause)}`,
        );
      }
      return next;
    },
  };
  return Object.freeze(repository);
}
