import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  advanceWorldSimulation,
  buildCouncilParticipantPrompts,
  buildDecisionPrompts,
  buildEpochNarrationPrompt,
  buildReportPrompt,
  buildResolutionPrompt,
  commitCouncilOptionToBranch,
  createCouncilSession,
  createNaturalEvolutionComparisonBranch,
  createSimulationReport,
  createWorldSimulationRun,
  forkSimulationBranch,
  forkSimulationBranchWithGuardrail,
  forkSimulationBranchWithLead,
  getActiveSimulationBranch,
  getSimulationEndSortKey,
  parseCouncilModelCandidate,
  parseEpochNarrationCandidate,
  parseModelDecisionCandidate,
  parseSimulationReportCandidate,
  selectCouncilOption,
  setSimulationBranchStatus,
  switchSimulationBranch,
  type ModelDecisionCandidate,
  type ModelDecisionSubmission,
  type EpochNarrationCandidate,
} from "./worldSimulationEngineV2";
import { buildWorldSimulationBaseline } from "./worldSimulationProjection";
import {
  createWorldSimulationRepositoryV2,
  type LoadedSimulationRunIndex,
  type LoadedSimulationScenarios,
  type LoadedWorldSimulationRun,
} from "./worldSimulationRepositoryV2";
import {
  createDefaultWorldSimulationScenario,
  type SimulationBranch,
  type SimulationAdoptionAuthority,
  type WorldSimulationBaseline,
  type WorldSimulationRun,
  type WorldSimulationScenario,
} from "./worldSimulationV2Schema";
import { createWorldSimulationAdoptionProposal } from "./worldSimulationAdoptionV2";
import {
  addWorldTicks,
  compareWorldTicks,
  durationToDays,
  formatWorldInstant,
} from "./worldSimulationTime";

export type WorldSimulationModelScene =
  | "simulation.actor"
  | "simulation.world"
  | "simulation.resolve"
  | "simulation.report"
  | "simulation.council"
  | "simulation.epoch-narration";

export type WorldSimulationProgressPhase =
  | "preparing"
  | "actors"
  | "arbitrating"
  | "saving";

export interface WorldSimulationProgress {
  readonly roundIndex: number;
  readonly phase: WorldSimulationProgressPhase;
  readonly from: string;
  readonly to: string;
}

export interface WorldSimulationControllerOptions {
  readonly storage: WorkbenchStorage;
  readonly isActive: boolean;
  readonly onRunModelScene?: (
    scene: WorldSimulationModelScene,
    prompt: string,
  ) => Promise<string>;
}

export interface WorldSimulationController {
  readonly scenarios: LoadedSimulationScenarios | null;
  readonly runIndex: LoadedSimulationRunIndex | null;
  readonly loadedRun: LoadedWorldSimulationRun | null;
  readonly run: WorldSimulationRun | null;
  readonly branch: SimulationBranch | null;
  readonly baseline: WorldSimulationBaseline | null;
  readonly scenario: WorldSimulationScenario;
  readonly scenarioDirty: boolean;
  readonly busy: boolean;
  readonly continuous: boolean;
  readonly progress: WorldSimulationProgress | null;
  readonly error: string | null;
  readonly modelWarning: string | null;
  readonly sourceDriftWarning: string | null;
  updateScenario(next: WorldSimulationScenario): void;
  applyScenarioAndRebuild(next: WorldSimulationScenario): Promise<void>;
  selectScenario(scenarioId: string): Promise<void>;
  createScenarioDraft(): Promise<WorldSimulationScenario>;
  refresh(): Promise<void>;
  selectRun(runId: string): Promise<void>;
  selectRunBranch(runId: string, branchId: string): Promise<void>;
  removeRun(runId: string): Promise<void>;
  rebuildBaseline(): Promise<void>;
  saveScenario(): Promise<LoadedSimulationScenarios>;
  createRun(scenario?: WorldSimulationScenario): Promise<void>;
  advanceOne(): Promise<void>;
  runToEnd(): Promise<void>;
  setContinuous(value: boolean): void;
  forkAt(eventId: string, name?: string): Promise<void>;
  setGuardrail(eventId: string, guardrail: string): Promise<void>;
  setLead(eventId: string, lead: string): Promise<void>;
  switchBranch(branchId: string): Promise<void>;
  createNaturalComparison(): Promise<void>;
  openCouncil(eventId: string | null, question: string): Promise<void>;
  chooseCouncilOption(sessionId: string, optionId: string): Promise<void>;
  commitCouncilOption(sessionId: string, optionId: string): Promise<void>;
  generateReport(): Promise<void>;
  createAdoptionProposal(
    eventIds: readonly string[],
    authority: SimulationAdoptionAuthority,
  ): Promise<string>;
  pauseRun(): Promise<void>;
  cancelRun(): Promise<void>;
}

function withRunWarning(
  run: WorldSimulationRun,
  warning: string,
): WorldSimulationRun {
  return {
    ...run,
    branches: run.branches.map((branch) =>
      branch.id === run.activeBranchId
        ? {
            ...branch,
            warnings: branch.warnings.includes(warning)
              ? branch.warnings
              : [...branch.warnings, warning],
          }
        : branch,
    ),
  };
}

function remainingModelCalls(
  run: WorldSimulationRun,
  pendingCalls = 0,
): number {
  const limit = run.scenario.maxModelCalls;
  if (limit === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(
    0,
    limit - (getActiveSimulationBranch(run).modelCallCount ?? 0) - pendingCalls,
  );
}

function modelConcurrency(run: WorldSimulationRun): number {
  const configured = run.scenario.maxModelConcurrency ?? 4;
  return Number.isInteger(configured)
    ? Math.max(1, Math.min(32, configured))
    : 4;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerLoop = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!, index);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), values.length) },
      () => workerLoop(),
    ),
  );
  return results;
}

function recordStandaloneModelCalls(
  run: WorldSimulationRun,
  calls: number,
): WorldSimulationRun {
  if (!Number.isInteger(calls) || calls < 0)
    throw new Error("模型调用计数必须是非负整数");
  if (calls === 0) return run;
  if (run.scenario.intelligence.mode !== "assisted")
    throw new Error("仅确定性推演不能登记模型调用");
  if (remainingModelCalls(run) < calls)
    throw new Error("模型调用预算不足，不能执行该模型场景");
  const branch = getActiveSimulationBranch(run);
  const modelCallCount = (branch.modelCallCount ?? 0) + calls;
  const limit = run.scenario.maxModelCalls;
  const budgetWarning =
    limit !== undefined && modelCallCount >= limit
      ? `已达到模型调用预算（${limit}），推演已暂停并保存检查点。`
      : null;
  return {
    ...run,
    branches: run.branches.map((item) =>
      item.id !== branch.id
        ? item
        : {
            ...item,
            modelCallCount,
            // 报告/会商是运行完成后的审阅动作，不能因为它恰好耗尽
            // 模型预算而把已经完成的世界分支重新标成暂停。
            status:
              budgetWarning && item.status !== "completed"
                ? "paused"
                : item.status,
            warnings:
              budgetWarning && !item.warnings.includes(budgetWarning)
                ? [...item.warnings, budgetWarning]
                : item.warnings,
          },
    ),
  };
}

function shouldStopWorldSimulation(branch: SimulationBranch): boolean {
  if (branch.status === "completed" || branch.status === "cancelled")
    return true;
  return branch.warnings.some(
    (warning) =>
      warning.startsWith("已达到事件预算（") ||
      warning.startsWith("已达到主体决策预算（") ||
      warning.startsWith("已达到模型调用预算（") ||
      warning.startsWith("剧情不可实现："),
  );
}

function shouldAskModelForStep(
  run: WorldSimulationRun,
  branch: SimulationBranch,
  hasModelRunner: boolean,
): boolean {
  if (
    !hasModelRunner ||
    run.scenario.intelligence.mode !== "assisted" ||
    (run.scenario.maxModelCalls !== undefined &&
      (branch.modelCallCount ?? 0) >= run.scenario.maxModelCalls)
  ) {
    return false;
  }
  return (
    run.scenario.intelligence.cadence === "each-step" ||
    branch.checkpoints.length % 4 === 1
  );
}

function pendingRoundProgress(
  run: WorldSimulationRun,
  phase: WorldSimulationProgressPhase,
): WorldSimulationProgress {
  const branch = getActiveSimulationBranch(run);
  const start = branch.state.currentTime.sortKey;
  const candidateEnd = addWorldTicks(
    start,
    durationToDays(run.scenario.roundSpan, run.scenario.calendar),
  );
  const endBoundary = getSimulationEndSortKey(run);
  const end =
    compareWorldTicks(candidateEnd, endBoundary) > 0
      ? endBoundary
      : candidateEnd;
  return {
    roundIndex: Math.max(1, branch.checkpoints.length),
    phase,
    from: formatWorldInstant(start, run.scenario.calendar),
    to: formatWorldInstant(end, run.scenario.calendar),
  };
}

function freshScenario(runNumber: number): WorldSimulationScenario {
  const base = createDefaultWorldSimulationScenario();
  const suffix = Date.now().toString(36);
  return {
    ...base,
    id: `scenario-${suffix}`,
    name: `自动推演 ${runNumber}`,
    // 运行参数由系统的默认策略生成，而不是由创建界面收集。
    // 保留领域默认场景的稳定契约，避免影响内核和已有测试夹具。
    duration: { amount: "12", unit: "year" },
    roundSpan: { amount: "3", unit: "month" },
    seed: `world-${suffix}`,
  };
}

function initialCreationScenario(
  scenario: WorldSimulationScenario,
): WorldSimulationScenario {
  if (scenario.id !== "scenario-natural-evolution") return scenario;
  return {
    ...scenario,
    name: "自动推演 1",
    // 空项目首次打开时直接给出原型中的可用起步值；这只是创建入口
    // 的默认草稿，不改变领域层用于测试和重放的默认场景契约。
    duration: { amount: "12", unit: "year" },
    roundSpan: { amount: "3", unit: "month" },
  };
}

/**
 * 新版工作台不再要求作者填写章节锚点、空间范围或内部叙事开关。
 * 这些字段仍属于运行快照，但创建入口必须把它们归一到“自动观察”契约，
 * 避免旧表单遗留值把本来可以运行的世界挡在启动诊断之外。
 */
function normalizeScenarioForCreation(
  scenario: WorldSimulationScenario,
): WorldSimulationScenario {
  return {
    ...scenario,
    start: { mode: "facts-anchor", sortKey: "0" },
    chapterContext: { mode: "none", chapterId: null },
    narrativeContext: {
      ...scenario.narrativeContext,
      mode: "observe",
      selectedPlotLineIds: [],
      selectedStoryArcIds: [],
      selectedDirectoryIds: [],
      selectedChapterPlanIds: [],
    },
    scope: {
      ...scenario.scope,
      regionIds: [],
      characterIds: [],
      factionIds: [],
      includeDescendants: true,
      adjacencyDepth: 1,
      autoIncludeCounterparts: true,
      outsidePolicy: "respond",
    },
  };
}

function displayControllerError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes("File changed externally")) {
    return "世界推演资料已在其他窗口或磁盘中更新。当前未保存的设置仍保留在此处，请重新载入后再继续操作。";
  }
  return message;
}

function isExternalChangeError(cause: unknown): boolean {
  return (
    cause instanceof Error && cause.message.includes("File changed externally")
  );
}

async function retryExternalChange<T>(
  task: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task();
    } catch (cause) {
      lastError = cause;
      if (!isExternalChangeError(cause) || attempt === attempts - 1) {
        throw cause;
      }
      // 文件监听与另一个工作台实例的初始化写入可能只相差一个事件循环。
      // 让出一次调度后重读最新快照，用户无需处理内部并发细节。
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 30));
    }
  }
  throw lastError ?? new Error("世界推演资料加载失败");
}

function describeSourceDrift(
  baseline: WorldSimulationBaseline,
  current: WorldSimulationBaseline,
): string | null {
  if (baseline.sourceRevision === current.sourceRevision) return null;
  const currentHashesByPath = new Map<string, Set<string>>();
  current.sourceRefs.forEach((ref) => {
    const hashes = currentHashesByPath.get(ref.path) ?? new Set<string>();
    hashes.add(ref.sourceHash);
    currentHashesByPath.set(ref.path, hashes);
  });
  const changedPaths = [
    ...new Set(
      baseline.sourceRefs
        .filter(
          (ref) => !currentHashesByPath.get(ref.path)?.has(ref.sourceHash),
        )
        .map((ref) => ref.path),
    ),
  ];
  const detail = changedPaths.length
    ? `${changedPaths.slice(0, 3).join("、")}${changedPaths.length > 3 ? " 等" : ""}`
    : "参与推演的资料";
  return `正式资料已变化：${detail}。当前运行继续使用已锁定基线；请重建基线后新建运行以使用最新资料。`;
}

export function useWorldSimulationController({
  storage,
  isActive,
  onRunModelScene,
}: WorldSimulationControllerOptions): WorldSimulationController {
  const repository = useMemo(
    () => createWorldSimulationRepositoryV2(storage),
    [storage],
  );
  const [scenarios, setScenarios] = useState<LoadedSimulationScenarios | null>(
    null,
  );
  const [runIndex, setRunIndex] = useState<LoadedSimulationRunIndex | null>(
    null,
  );
  const [loadedRun, setLoadedRun] = useState<LoadedWorldSimulationRun | null>(
    null,
  );
  const [baseline, setBaseline] = useState<WorldSimulationBaseline | null>(
    null,
  );
  const [scenario, setScenario] = useState<WorldSimulationScenario>(() =>
    createDefaultWorldSimulationScenario(),
  );
  const [scenarioDirty, setScenarioDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [continuous, setContinuous] = useState(false);
  const [progress, setProgress] = useState<WorldSimulationProgress | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [modelWarning, setModelWarning] = useState<string | null>(null);
  const [sourceDriftWarning, setSourceDriftWarning] = useState<string | null>(
    null,
  );
  const operation = useRef<Promise<unknown>>(Promise.resolve());
  const loadedRunRef = useRef<LoadedWorldSimulationRun | null>(null);
  // 取消请求需要在当前串行操作完成后立即生效，不能等到取消 mutation
  // 排到队列末尾才通知推进循环。
  const cancelRequestedRef = useRef(false);
  const scenarioRef = useRef(scenario);
  const scenarioDirtyRef = useRef(scenarioDirty);

  useEffect(() => {
    loadedRunRef.current = loadedRun;
  }, [loadedRun]);
  useEffect(() => {
    scenarioRef.current = scenario;
  }, [scenario]);
  useEffect(() => {
    scenarioDirtyRef.current = scenarioDirty;
  }, [scenarioDirty]);

  const enqueue = useCallback(<T>(task: () => Promise<T>): Promise<T> => {
    setBusy(true);
    setError(null);
    const next = operation.current.then(task, task);
    operation.current = next
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => setBusy(false));
    return next.catch((cause) => {
      setError(displayControllerError(cause));
      throw cause;
    });
  }, []);

  const refresh = useCallback(async () => {
    await enqueue(async () => {
      const [loadedScenarios, nextIndex] = await retryExternalChange(() =>
        Promise.all([repository.loadScenarios(), repository.loadRunIndex()]),
      );
      let nextScenarios = loadedScenarios;
      if (scenarioDirtyRef.current) {
        nextScenarios = await repository.saveScenario(
          scenarios ?? nextScenarios,
          scenarioRef.current,
        );
      }
      const selectedStoredScenario =
        nextScenarios.value.scenarios.find(
          (item) => item.id === nextScenarios.value.activeScenarioId,
        ) ??
        nextScenarios.value.scenarios[0] ??
        createDefaultWorldSimulationScenario();
      const selected = nextIndex.value.activeRunId
        ? selectedStoredScenario
        : initialCreationScenario(
            normalizeScenarioForCreation(selectedStoredScenario),
          );
      const nextBaseline = await buildWorldSimulationBaseline(
        storage,
        selected,
      );
      let nextRun: LoadedWorldSimulationRun | null = null;
      let runLoadError: string | null = null;
      if (nextIndex.value.activeRunId) {
        try {
          nextRun = await repository.loadRun(
            nextIndex.value.activeRunId,
            nextBaseline.projectId,
          );
        } catch (cause) {
          runLoadError = `活动推演运行加载失败：${displayControllerError(cause)}`;
          nextRun = null;
        }
      }
      setScenarios(nextScenarios);
      setRunIndex(nextIndex);
      scenarioRef.current = selected;
      setScenario(selected);
      setScenarioDirty(false);
      setBaseline(nextRun?.value.baseline ?? nextBaseline);
      loadedRunRef.current = nextRun;
      setLoadedRun(nextRun);
      if (runLoadError) setError(runLoadError);
      setSourceDriftWarning(
        nextRun
          ? describeSourceDrift(nextRun.value.baseline, nextBaseline)
          : null,
      );
    });
  }, [enqueue, repository, scenarios, storage]);

  useEffect(() => {
    if (!isActive || scenarios) return;
    void refresh().catch(() => undefined);
  }, [isActive, refresh, scenarios]);

  const rebuildBaseline = useCallback(async () => {
    await enqueue(async () => {
      const next = await buildWorldSimulationBaseline(
        storage,
        scenarioRef.current,
      );
      const currentRun = loadedRunRef.current;
      if (currentRun) {
        // 已创建运行的基线必须保持不可变。重新编译只用于检查正式资料
        // 是否发生漂移，最新投影留给作者创建新运行时使用。
        setSourceDriftWarning(
          describeSourceDrift(currentRun.value.baseline, next),
        );
        return;
      }
      setBaseline(next);
      setSourceDriftWarning(null);
    });
  }, [enqueue, storage]);

  const applyScenarioAndRebuild = useCallback(
    async (next: WorldSimulationScenario) => {
      // 一键修正需要立即反映到启动检查；常规表单编辑仍由用户主动重新检查。
      scenarioRef.current = next;
      setScenario(next);
      setScenarioDirty(true);
      await enqueue(async () => {
        const nextBaseline = await buildWorldSimulationBaseline(storage, next);
        setBaseline(nextBaseline);
      });
    },
    [enqueue, storage],
  );

  const saveScenario =
    useCallback(async (): Promise<LoadedSimulationScenarios> => {
      return enqueue(async () => {
        const current = scenarios ?? (await repository.loadScenarios());
        const saved = await repository.saveScenario(
          current,
          scenarioRef.current,
        );
        setScenarios(saved);
        setScenarioDirty(false);
        return saved;
      });
    }, [enqueue, repository, scenarios]);

  const selectScenario = useCallback(
    async (scenarioId: string) => {
      let current = scenarios ?? (await repository.loadScenarios());
      if (scenarioDirty) current = await saveScenario();
      const selected = current.value.scenarios.find(
        (item) => item.id === scenarioId,
      );
      if (!selected) return;
      if (current.value.activeScenarioId !== selected.id) {
        current = await enqueue(() =>
          repository.saveScenario(current, selected),
        );
      }
      const nextBaseline = await enqueue(() =>
        buildWorldSimulationBaseline(storage, selected),
      );
      scenarioRef.current = selected;
      setScenarios(current);
      setScenario(selected);
      setScenarioDirty(false);
      setBaseline(nextBaseline);
    },
    [enqueue, repository, saveScenario, scenarioDirty, scenarios, storage],
  );

  const createScenarioDraft = useCallback(async () => {
    const current = scenarios ?? (await repository.loadScenarios());
    return freshScenario(current.value.scenarios.length + 1);
  }, [repository, scenarios]);

  const selectRun = useCallback(
    async (runId: string) => {
      await enqueue(async () => {
        let currentScenarios = scenarios ?? (await repository.loadScenarios());
        if (scenarioDirty) {
          currentScenarios = await repository.saveScenario(
            currentScenarios,
            scenarioRef.current,
          );
          setScenarios(currentScenarios);
          setScenarioDirty(false);
        }
        loadedRunRef.current = null;
        setLoadedRun(null);
        setBaseline(null);
        setSourceDriftWarning(null);
        const loaded = await repository.loadRun(runId);
        const nextIndex = await repository.activateRun(runId);
        const latestBaseline = await buildWorldSimulationBaseline(
          storage,
          loaded.value.scenario,
        );
        loadedRunRef.current = loaded;
        setLoadedRun(loaded);
        setRunIndex(nextIndex);
        scenarioRef.current = loaded.value.scenario;
        setScenario(loaded.value.scenario);
        setScenarioDirty(false);
        setBaseline(loaded.value.baseline);
        setSourceDriftWarning(
          describeSourceDrift(loaded.value.baseline, latestBaseline),
        );
      });
    },
    [enqueue, repository, scenarioDirty, scenarios, storage],
  );

  const removeRun = useCallback(
    async (runId: string) => {
      await enqueue(async () => {
        const current = await repository.loadRunIndex();
        const removingActive = current.value.activeRunId === runId;
        const nextIndex = await repository.removeRun(runId);
        setRunIndex(nextIndex);
        if (!removingActive) return;
        loadedRunRef.current = null;
        setLoadedRun(null);
        setBaseline(null);
        setSourceDriftWarning(null);
        if (!nextIndex.value.activeRunId) {
          loadedRunRef.current = null;
          setLoadedRun(null);
          setBaseline(
            await buildWorldSimulationBaseline(storage, scenarioRef.current),
          );
          setSourceDriftWarning(null);
          return;
        }
        const nextRun = await repository.loadRun(nextIndex.value.activeRunId);
        loadedRunRef.current = nextRun;
        setLoadedRun(nextRun);
        setBaseline(nextRun.value.baseline);
        const latestBaseline = await buildWorldSimulationBaseline(
          storage,
          nextRun.value.scenario,
        );
        setSourceDriftWarning(
          describeSourceDrift(nextRun.value.baseline, latestBaseline),
        );
      });
    },
    [enqueue, repository, storage],
  );

  const createRun = useCallback(async (draft?: WorldSimulationScenario) => {
    await enqueue(async () => {
      const currentScenarios = scenarios ?? (await repository.loadScenarios());
      const scenarioForCreation = normalizeScenarioForCreation(
        draft ?? scenarioRef.current,
      );
      const savedScenarios = await repository.saveScenario(
        currentScenarios,
        scenarioForCreation,
      );
      const nextBaseline = await buildWorldSimulationBaseline(
        storage,
        scenarioForCreation,
      );
      const run = createWorldSimulationRun(nextBaseline, scenarioForCreation);
      const created = await repository.createRun(run);
      setScenarios(savedScenarios);
      setScenarioDirty(false);
      scenarioRef.current = scenarioForCreation;
      setScenario(scenarioForCreation);
      setBaseline(nextBaseline);
      loadedRunRef.current = created.run;
      setLoadedRun(created.run);
      setRunIndex(created.index);
      setContinuous(false);
      setModelWarning(null);
      setSourceDriftWarning(null);
    });
  }, [enqueue, repository, scenarios, storage]);

  const generateReportForRun = useCallback(
    async (sourceRun: WorldSimulationRun): Promise<WorldSimulationRun> => {
      let candidate:
        | ReturnType<typeof parseSimulationReportCandidate>
        | undefined;
      let epochNarrative: EpochNarrationCandidate | undefined;
      let degradedReason: string | null = null;
      let modelCallsUsed = 0;
      const noteDegraded = (reason: string) => {
        degradedReason = degradedReason
          ? `${degradedReason}；${reason}`
          : reason;
      };
      if (
        sourceRun.scenario.intelligence.mode === "assisted" &&
        onRunModelScene
      ) {
        const hasEpochEvents = getActiveSimulationBranch(sourceRun).ledger.some(
          (event) => event.kind === "epoch",
        );
        if (hasEpochEvents) {
          if (remainingModelCalls(sourceRun, modelCallsUsed) < 1) {
            noteDegraded("模型调用预算已耗尽，未生成纪元叙事");
          } else {
            try {
              modelCallsUsed += 1;
              epochNarrative = parseEpochNarrationCandidate(
                await onRunModelScene(
                  "simulation.epoch-narration",
                  buildEpochNarrationPrompt(sourceRun),
                ),
              );
            } catch (cause) {
              noteDegraded(
                `纪元叙事模型不可用：${cause instanceof Error ? cause.message : String(cause)}`,
              );
            }
          }
        }
        if (remainingModelCalls(sourceRun, modelCallsUsed) < 1) {
          noteDegraded("模型调用预算已耗尽，未生成模型报告");
        } else {
          try {
            modelCallsUsed += 1;
            candidate = parseSimulationReportCandidate(
              await onRunModelScene(
                "simulation.report",
                buildReportPrompt(sourceRun),
              ),
            );
          } catch (cause) {
            noteDegraded(
              `报告模型不可用：${cause instanceof Error ? cause.message : String(cause)}`,
            );
          }
        }
      } else {
        noteDegraded(
          sourceRun.scenario.intelligence.mode === "deterministic"
            ? "方案配置为仅确定性内核"
            : "模型运行能力不可用",
        );
      }
      if (degradedReason) {
        setModelWarning(`报告生成存在降级：${degradedReason}`);
      } else {
        setModelWarning(null);
      }
      const runWithModelUsage = recordStandaloneModelCalls(
        sourceRun,
        modelCallsUsed,
      );
      return createSimulationReport(
        runWithModelUsage,
        candidate,
        degradedReason,
        undefined,
        epochNarrative,
      );
    },
    [onRunModelScene],
  );

  const advance = useCallback(
    async (toEnd: boolean) => {
      cancelRequestedRef.current = false;
      await enqueue(async () => {
        const current = loadedRunRef.current;
        if (!current) throw new Error("请先创建推演运行");
        let sourceRun = current.value;
        setProgress(pendingRoundProgress(sourceRun, "preparing"));
        try {
          try {
            const latestBaseline = await buildWorldSimulationBaseline(
              storage,
              sourceRun.scenario,
            );
            setSourceDriftWarning(
              describeSourceDrift(sourceRun.baseline, latestBaseline),
            );
          } catch (cause) {
            const detail = cause instanceof Error ? cause.message : String(cause);
            setSourceDriftWarning(
              `无法校验最新正式资料：${detail}。当前运行仍使用已锁定基线。`,
            );
          }
          const wasCompleted =
            getActiveSimulationBranch(sourceRun).status === "completed";
          // 连续推演的上限由总时长与每轮跨度推导；maxSteps 只保留为
          // 防御性预算，不能再改变“每轮 = roundSpan”的运行语义。
          const requestedSteps = toEnd ? sourceRun.scenario.maxSteps : 1;
          for (let index = 0; index < requestedSteps; index += 1) {
            if (cancelRequestedRef.current) break;
            const branch = getActiveSimulationBranch(sourceRun);
            if (shouldStopWorldSimulation(branch)) break;

            const stepProgress = pendingRoundProgress(sourceRun, "preparing");
            setProgress(stepProgress);

            let modelCandidates: readonly ModelDecisionSubmission[] = [];
            let modelCallsUsed = 0;
            const shouldAskModel = shouldAskModelForStep(
              sourceRun,
              branch,
              Boolean(onRunModelScene),
            );
            if (shouldAskModel && onRunModelScene) {
              setProgress({ ...stepProgress, phase: "actors" });
            const runModelScene = async (
              scene: WorldSimulationModelScene,
              prompt: string,
            ): Promise<string> => {
              if (remainingModelCalls(sourceRun, modelCallsUsed) < 1) {
                throw new Error("模型调用预算已耗尽");
              }
              modelCallsUsed += 1;
              return onRunModelScene(scene, prompt);
            };
            const accepted: ModelDecisionSubmission[] = [];
            const warnings: string[] = [];
            const decisions = buildDecisionPrompts(sourceRun);
            const actorResults = await mapWithConcurrency(
              decisions,
              modelConcurrency(sourceRun),
              async (decision) => {
                if (remainingModelCalls(sourceRun, modelCallsUsed) < 1) {
                  return {
                    decision,
                    candidate: null,
                    warning: "模型调用预算已耗尽，未请求其余主体的智能候选。",
                  };
                }
                try {
                  const rawModelOutput = await runModelScene(
                    decision.subject.type === "character"
                      ? "simulation.actor"
                      : "simulation.world",
                    decision.prompt,
                  );
                  return {
                    decision,
                    candidate: parseModelDecisionCandidate(rawModelOutput),
                    rawModelOutput,
                    warning: null,
                  };
                } catch (cause) {
                  return {
                    decision,
                    candidate: null,
                    warning: `主体智能候选不可用，已使用确定性策略：${cause instanceof Error ? cause.message : String(cause)}`,
                  };
                }
              },
            );
            const candidatesForResolution = actorResults.filter(
              (
                result,
              ): result is typeof result & {
                candidate: ModelDecisionCandidate;
              } => result.candidate !== null,
            );
              setProgress({ ...stepProgress, phase: "arbitrating" });
              const resolvedResults = await mapWithConcurrency(
              candidatesForResolution,
              modelConcurrency(sourceRun),
              async (result) => {
                if (remainingModelCalls(sourceRun, modelCallsUsed) < 1) {
                  return {
                    ...result,
                    warning: "模型调用预算已耗尽，已跳过候选冲突复核。",
                  };
                }
                try {
                  const rawModelOutput = await runModelScene(
                    "simulation.resolve",
                    buildResolutionPrompt(sourceRun, result.candidate),
                  );
                  return {
                    ...result,
                    candidate: parseModelDecisionCandidate(rawModelOutput),
                    rawModelOutput,
                    warning: null,
                  };
                } catch (cause) {
                  return {
                    ...result,
                    warning: `冲突复核不可用，已保留${result.decision.subject.type === "character" ? "人物" : "势力"}候选：${cause instanceof Error ? cause.message : String(cause)}`,
                  };
                }
              },
            );
            for (const result of actorResults) {
              if (result.warning) warnings.push(result.warning);
            }
            for (const result of resolvedResults) {
              if (result.warning) warnings.push(result.warning);
              if (result.candidate) {
                accepted.push({
                  subject: result.decision.subject,
                  candidate: result.candidate,
                  rawModelOutput: result.rawModelOutput,
                });
              }
            }
              modelCandidates = accepted;
              const warning = warnings.at(-1) ?? null;
              if (warning) {
                sourceRun = withRunWarning(sourceRun, warnings.join("；"));
                setModelWarning(warnings.join("；"));
              } else {
                setModelWarning(null);
              }
            } else if (
              sourceRun.scenario.intelligence.mode === "assisted" &&
              !onRunModelScene
            ) {
              const warning = "模型运行能力不可用，本次使用确定性策略。";
              sourceRun = withRunWarning(sourceRun, warning);
              setModelWarning(warning);
            }

            setProgress({ ...stepProgress, phase: "arbitrating" });
            try {
              sourceRun = advanceWorldSimulation(sourceRun, {
                steps: 1,
                modelCandidates,
                modelCallsUsed,
              });
            } catch (cause) {
              if (modelCandidates.length === 0) throw cause;
              const warning = `智能候选未通过内核校验，已丢弃并使用确定性策略：${cause instanceof Error ? cause.message : String(cause)}`;
              sourceRun = withRunWarning(sourceRun, warning);
              setModelWarning(warning);
              sourceRun = advanceWorldSimulation(sourceRun, {
                steps: 1,
                modelCallsUsed,
              });
            }

            if (
              cancelRequestedRef.current ||
              !toEnd ||
              shouldStopWorldSimulation(getActiveSimulationBranch(sourceRun))
            ) {
              break;
            }
          }
          let next = sourceRun;
          if (
            toEnd &&
            !wasCompleted &&
            getActiveSimulationBranch(next).status === "completed"
          ) {
            next = await generateReportForRun(next);
          }
          setProgress((currentProgress) =>
            currentProgress ? { ...currentProgress, phase: "saving" } : null,
          );
          const saved = await repository.saveRun(current, next);
          loadedRunRef.current = saved.run;
          setLoadedRun(saved.run);
          setRunIndex(saved.index);
          if (getActiveSimulationBranch(saved.run.value).status === "completed")
            setContinuous(false);
        } finally {
          setProgress(null);
        }
      });
    },
    [enqueue, generateReportForRun, onRunModelScene, repository, storage],
  );

  const advanceOne = useCallback(() => advance(false), [advance]);
  const runToEnd = useCallback(() => advance(true), [advance]);

  useEffect(() => {
    if (!continuous || busy || !loadedRun) return;
    const branch = getActiveSimulationBranch(loadedRun.value);
    if (branch.status === "completed" || branch.status === "cancelled") {
      setContinuous(false);
      return;
    }
    const timer = globalThis.setTimeout(() => {
      void advanceOne().catch(() => setContinuous(false));
    }, 420);
    return () => globalThis.clearTimeout(timer);
  }, [advanceOne, busy, continuous, loadedRun]);

  const persistMutation = useCallback(
    async (mutate: (run: WorldSimulationRun) => WorldSimulationRun) => {
      await enqueue(async () => {
        const current = loadedRunRef.current;
        if (!current) throw new Error("当前没有可操作的推演运行");
        const saved = await repository.saveRun(current, mutate(current.value));
        loadedRunRef.current = saved.run;
        setLoadedRun(saved.run);
        setRunIndex(saved.index);
      });
    },
    [enqueue, repository],
  );

  const selectRunBranch = useCallback(
    async (runId: string, branchId: string) => {
      await selectRun(runId);
      if (loadedRunRef.current?.value.activeBranchId !== branchId) {
        await persistMutation((run) => switchSimulationBranch(run, branchId));
      }
    },
    [persistMutation, selectRun],
  );

  const openCouncil = useCallback(
    async (eventId: string | null, question: string) => {
      await enqueue(async () => {
        const current = loadedRunRef.current;
        if (!current) throw new Error("当前没有可会商的推演运行");
        let candidate;
        let degradedReason: string | null = null;
        let modelCallsUsed = 0;
        if (
          current.value.scenario.intelligence.mode === "assisted" &&
          onRunModelScene
        ) {
          if (remainingModelCalls(current.value) < 1) {
            degradedReason = "模型调用预算已耗尽";
            setModelWarning(
              `会商模型未调用，已使用受知识边界约束的确定性立场：${degradedReason}`,
            );
          } else {
            try {
              const prompts = buildCouncilParticipantPrompts(
                current.value,
                eventId,
                question,
              );
              const responses: ReturnType<typeof parseCouncilModelCandidate>[] =
                [];
              for (const participant of prompts) {
                if (remainingModelCalls(current.value, modelCallsUsed) < 1) {
                  throw new Error("模型调用预算不足，无法完成全部会商席位");
                }
                modelCallsUsed += 1;
                responses.push(
                  parseCouncilModelCandidate(
                    await onRunModelScene(
                      "simulation.council",
                      participant.prompt,
                    ),
                  ),
                );
              }
              candidate = {
                stances: responses.flatMap((partial, participantIndex) => {
                  const participant = prompts[participantIndex]!;
                  const optionIdMap = new Map(
                    partial.options.map((option, optionIndex) => [
                      option.id,
                      `${participant.participantId}-option-${optionIndex + 1}`,
                    ]),
                  );
                  return partial.stances
                    .filter(
                      (stance) =>
                        stance.participantType ===
                          participant.participantType &&
                        stance.participantId === participant.participantId,
                    )
                    .map((stance) => ({
                      ...stance,
                      optionIds: stance.optionIds
                        .map((id) => optionIdMap.get(id))
                        .filter((id): id is string => Boolean(id)),
                    }));
                }),
                options: responses.flatMap((partial, participantIndex) => {
                  const participant = prompts[participantIndex]!;
                  return partial.options.map((option, optionIndex) => ({
                    ...option,
                    id: `${participant.participantId}-option-${optionIndex + 1}`,
                  }));
                }),
              };
              if (
                candidate.stances.length === 0 ||
                candidate.options.length === 0
              )
                throw new Error("会商模型没有生成当前参与方的有效立场或方案");
              setModelWarning(null);
            } catch (cause) {
              degradedReason =
                cause instanceof Error ? cause.message : String(cause);
              candidate = undefined;
              setModelWarning(
                `会商模型不可用，已使用受知识边界约束的确定性立场：${degradedReason}`,
              );
            }
          }
        } else {
          degradedReason =
            current.value.scenario.intelligence.mode === "deterministic"
              ? "方案配置为仅确定性内核"
              : "模型运行能力不可用";
        }
        const runWithModelUsage = recordStandaloneModelCalls(
          current.value,
          modelCallsUsed,
        );
        const next = createCouncilSession(
          runWithModelUsage,
          eventId,
          question,
          candidate,
          degradedReason,
        );
        const saved = await repository.saveRun(current, next);
        loadedRunRef.current = saved.run;
        setLoadedRun(saved.run);
        setRunIndex(saved.index);
      });
    },
    [enqueue, onRunModelScene, repository],
  );

  const generateReport = useCallback(async () => {
    await enqueue(async () => {
      const current = loadedRunRef.current;
      if (!current) throw new Error("当前没有可生成报告的推演运行");
      const next = await generateReportForRun(current.value);
      const saved = await repository.saveRun(current, next);
      loadedRunRef.current = saved.run;
      setLoadedRun(saved.run);
      setRunIndex(saved.index);
    });
  }, [enqueue, generateReportForRun, repository]);

  const createAdoptionProposal = useCallback(
    async (
      eventIds: readonly string[],
      authority: SimulationAdoptionAuthority,
    ): Promise<string> =>
      enqueue(async () => {
        const current = loadedRunRef.current;
        if (!current) throw new Error("当前没有可采纳的推演运行");
        return createWorldSimulationAdoptionProposal(
          storage,
          current.value,
          eventIds,
          authority,
        );
      }),
    [enqueue, storage],
  );

  return {
    scenarios,
    runIndex,
    loadedRun,
    run: loadedRun?.value ?? null,
    branch: loadedRun ? getActiveSimulationBranch(loadedRun.value) : null,
    baseline,
    scenario,
    scenarioDirty,
    busy,
    continuous,
    progress,
    error,
    modelWarning,
    sourceDriftWarning,
    updateScenario(next) {
      scenarioRef.current = next;
      setScenario(next);
      setScenarioDirty(true);
    },
    applyScenarioAndRebuild,
    selectScenario,
    createScenarioDraft,
    refresh,
    selectRun,
    selectRunBranch,
    removeRun,
    rebuildBaseline,
    saveScenario,
    createRun,
    advanceOne,
    runToEnd,
    setContinuous,
    forkAt(eventId, name) {
      return persistMutation((run) => forkSimulationBranch(run, eventId, name));
    },
    setGuardrail(eventId, guardrail) {
      return persistMutation((run) =>
        forkSimulationBranchWithGuardrail(run, eventId, guardrail),
      );
    },
    setLead(eventId, lead) {
      return persistMutation((run) =>
        forkSimulationBranchWithLead(run, eventId, lead),
      );
    },
    switchBranch(branchId) {
      return persistMutation((run) => switchSimulationBranch(run, branchId));
    },
    createNaturalComparison() {
      return persistMutation(createNaturalEvolutionComparisonBranch);
    },
    openCouncil,
    chooseCouncilOption(sessionId, optionId) {
      return persistMutation((run) =>
        selectCouncilOption(run, sessionId, optionId),
      );
    },
    commitCouncilOption(sessionId, optionId) {
      return persistMutation((run) =>
        commitCouncilOptionToBranch(run, sessionId, optionId),
      );
    },
    generateReport,
    createAdoptionProposal,
    pauseRun() {
      setContinuous(false);
      return persistMutation((run) => setSimulationBranchStatus(run, "paused"));
    },
    cancelRun() {
      cancelRequestedRef.current = true;
      setContinuous(false);
      return persistMutation((run) =>
        setSimulationBranchStatus(run, "cancelled"),
      );
    },
  };
}
