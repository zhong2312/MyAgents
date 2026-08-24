import type { WorkbenchStorage } from "@/workbench-sdk";

import { createStorageTransaction } from "../../../shared/infrastructure/storageTransaction";
import {
  createSimulationFiles,
  loadSimulationFiles,
  serializeSimulationFileSnapshot,
  simulationEventPath,
  simulationManifestPath,
  simulationRoundPath,
  type LoadedSimulationFiles,
  type SimulationRunFiles,
} from "./worldSimulationStorage";
import {
  SIMULATION_INDEX_PATH,
  SIMULATION_DEFAULT_AI_TIMEOUT_MINUTES,
  SIMULATION_SCHEMA_VERSION,
  SIMULATION_STORAGE_VERSION,
  simulationIndexSchema,
  simulationRunSchema,
  type SimulationBaselineMode,
  type SimulationIndex,
  type SimulationObserver,
  type SimulationObservationTarget,
  type SimulationRun,
  type SimulationRunStatus,
  type SimulationTimeScale,
} from "../entities/simulationSchema";

export function createSimulationInitializationFiles(): readonly {
  readonly path: string;
  readonly content: string;
}[] {
  return [
    {
      path: SIMULATION_INDEX_PATH,
      content: `${JSON.stringify(
        {
          schemaVersion: SIMULATION_SCHEMA_VERSION,
          storageVersion: SIMULATION_STORAGE_VERSION,
          activeRunId: null,
          runs: [],
        },
        null,
        2,
      )}\n`,
    },
  ];
}

export interface LoadedSimulationLibrary extends LoadedSimulationFiles {
  readonly content: string;
}

export interface CreateSimulationRunInput {
  readonly id?: string;
  readonly name: string;
  readonly baselineMode: SimulationBaselineMode;
  readonly baselineSourceHash: string;
  readonly baselineLabel: string;
  readonly parentRunId?: string | null;
  readonly forkRoundId?: string | null;
  readonly endTime: number;
  readonly endTimeAmount?: number;
  readonly endTimeUnit?: SimulationTimeScale;
  readonly aiTimeoutMinutes?: number;
  readonly timeScale: SimulationTimeScale;
  readonly timeStep?: number;
  readonly observationSpaceIds: readonly string[];
  readonly observationSpaceLabel: string;
  readonly observer: SimulationObserver;
  readonly observerId?: string | null;
  readonly observationTargets?: readonly SimulationObservationTarget[];
  readonly baselineChapterId?: string | null;
  readonly baselineChapterLabel?: string | null;
  readonly seed: number;
  readonly now?: string;
}

export interface SimulationRunUpdate {
  readonly status?: SimulationRunStatus;
  readonly currentTime?: number;
  readonly currentRoundId?: string | null;
  readonly roundsCompleted?: number;
  readonly aiTimeoutMinutes?: number;
  readonly updatedAt?: string;
}

function nowIso(value?: string): string {
  return value ?? new Date().toISOString();
}

function runId(value?: string): string {
  if (value) return value;
  const random =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `run-${random.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

function parseIndex(value: SimulationIndex): SimulationIndex {
  return simulationIndexSchema.parse(value);
}

function asMap(
  runs: ReadonlyMap<string, SimulationRunFiles>,
): Map<string, SimulationRunFiles> {
  return new Map(runs.entries());
}

async function readFiles(
  storage: WorkbenchStorage,
): Promise<LoadedSimulationLibrary> {
  const loaded = await loadSimulationFiles(
    async (path) => (await storage.readText(path)).content,
  );
  return Object.freeze({
    ...loaded,
    content: serializeSimulationFileSnapshot(loaded.files),
  });
}

export function createEmptySimulationIndex(): SimulationIndex {
  return {
    schemaVersion: SIMULATION_SCHEMA_VERSION,
    storageVersion: SIMULATION_STORAGE_VERSION,
    activeRunId: null,
    runs: [],
  };
}

export function createNovelSimulationRepository(storage: WorkbenchStorage) {
  const save = async (
    current: LoadedSimulationLibrary,
    index: SimulationIndex,
    runs: ReadonlyMap<string, SimulationRunFiles>,
  ): Promise<LoadedSimulationLibrary> => {
    const onDisk = await loadSimulationFiles(
      async (path) => (await storage.readText(path)).content,
    );
    const onDiskContent = serializeSimulationFileSnapshot(onDisk.files);
    if (onDiskContent !== current.content)
      throw new Error("世界推演事实源已被外部修改，请重新加载后再保存");
    const files = createSimulationFiles(parseIndex(index), [...runs.values()]);
    const nextFiles = new Map(
      files.map((file) => [file.path, file.content] as const),
    );
    const transaction = createStorageTransaction(storage);
    for (const [path, content] of [...nextFiles.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const previous = onDisk.files.get(path);
      if (previous === content) continue;
      if (previous === undefined) transaction.createText(path, content);
      else transaction.writeText(path, content, previous);
    }
    await transaction.commit();
    const removed = [...onDisk.files.keys()].filter(
      (path) => !nextFiles.has(path),
    );
    await Promise.all(
      removed.map((path) => storage.remove(path, { permanent: true })),
    );
    return readFiles(storage);
  };

  const load = async (): Promise<LoadedSimulationLibrary> => {
    if (!storage.isAvailable)
      throw new Error("世界推演仅在 MyAgents 桌面端可用");
    const [entry] = await storage.stat([SIMULATION_INDEX_PATH]);
    if (!entry?.exists) {
      const transaction = createStorageTransaction(storage);
      transaction.createText(
        SIMULATION_INDEX_PATH,
        `${JSON.stringify(createEmptySimulationIndex(), null, 2)}\n`,
      );
      await transaction.commit();
    } else if (entry.kind !== "file") {
      throw new Error(`${SIMULATION_INDEX_PATH} 不是文件`);
    }
    return readFiles(storage);
  };

  const createRun = async (
    current: LoadedSimulationLibrary,
    input: CreateSimulationRunInput,
  ): Promise<{
    readonly loaded: LoadedSimulationLibrary;
    readonly run: SimulationRun;
  }> => {
    const createdAt = nowIso(input.now);
    const id = runId(input.id);
    const run = simulationRunSchema.parse({
      schemaVersion: SIMULATION_SCHEMA_VERSION,
      id,
      name: input.name.trim(),
      status: "ready",
      baselineMode: input.baselineMode,
      baselineSourceHash: input.baselineSourceHash,
      baselineLabel: input.baselineLabel,
      parentRunId: input.parentRunId ?? null,
      forkRoundId: input.forkRoundId ?? null,
      startTime: 0,
      currentTime: 0,
      endTime: input.endTime,
      endTimeAmount: input.endTimeAmount,
      endTimeUnit: input.endTimeUnit,
      aiTimeoutMinutes:
        input.aiTimeoutMinutes ?? SIMULATION_DEFAULT_AI_TIMEOUT_MINUTES,
      timeScale: input.timeScale,
      timeStep: input.timeStep ?? 1,
      observationSpaceIds: [...input.observationSpaceIds],
      observationSpaceLabel: input.observationSpaceLabel,
      observer: input.observer,
      observerId: input.observerId ?? null,
      observationTargets: input.observationTargets?.map((target) => ({
        ...target,
      })),
      ...(input.baselineChapterId
        ? { baselineChapterId: input.baselineChapterId }
        : {}),
      ...(input.baselineChapterLabel
        ? { baselineChapterLabel: input.baselineChapterLabel }
        : {}),
      seed: input.seed,
      engineVersion: "simulation-engine/1",
      rulesetVersion: "world-rules/1",
      currentRoundId: null,
      roundsCompleted: 0,
      diagnostics: [],
      createdAt,
      updatedAt: createdAt,
    });
    const nextRuns = asMap(current.runs);
    nextRuns.set(id, { manifest: run, rounds: [], events: [] });
    const nextIndex: SimulationIndex = {
      ...current.index,
      activeRunId: id,
      runs: [
        ...current.index.runs,
        {
          id,
          path: simulationManifestPath(id),
          name: run.name,
          status: run.status,
          updatedAt: run.updatedAt,
        },
      ],
    };
    const loaded = await save(current, nextIndex, nextRuns);
    return { loaded, run: loaded.runs.get(id)!.manifest };
  };

  const updateRun = async (
    current: LoadedSimulationLibrary,
    runIdValue: string,
    update: SimulationRunUpdate,
    nextRunFiles?: SimulationRunFiles,
  ): Promise<LoadedSimulationLibrary> => {
    const existing = current.runs.get(runIdValue);
    if (!existing) throw new Error(`运行不存在：${runIdValue}`);
    const run = simulationRunSchema.parse({
      ...(nextRunFiles?.manifest ?? existing.manifest),
      ...update,
      updatedAt:
        update.updatedAt ?? nextRunFiles?.manifest.updatedAt ?? nowIso(),
    });
    const runs = asMap(current.runs);
    runs.set(
      runIdValue,
      nextRunFiles
        ? { ...nextRunFiles, manifest: run }
        : { ...existing, manifest: run },
    );
    const index: SimulationIndex = {
      ...current.index,
      activeRunId: current.index.activeRunId ?? runIdValue,
      runs: current.index.runs.map((entry) =>
        entry.id === runIdValue
          ? {
              ...entry,
              name: run.name,
              status: run.status,
              updatedAt: run.updatedAt,
            }
          : entry,
      ),
    };
    return save(current, index, runs);
  };

  return Object.freeze({
    load,
    save,
    createRun,
    updateRun,

    paths: Object.freeze({
      simulationManifestPath,
      simulationRoundPath,
      simulationEventPath,
    }),
  });
}

export type NovelSimulationRepository = ReturnType<
  typeof createNovelSimulationRepository
>;
