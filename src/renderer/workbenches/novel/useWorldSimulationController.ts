import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  advanceWorldSimulation,
  buildCouncilParticipantPrompts,
  buildDecisionPrompt,
  buildReportPrompt,
  buildResolutionPrompt,
  commitCouncilOptionToBranch,
  createCouncilSession,
  createNaturalEvolutionComparisonBranch,
  createSimulationReport,
  createWorldSimulationRun,
  forkSimulationBranch,
  getActiveSimulationBranch,
  parseCouncilModelCandidate,
  parseModelDecisionCandidate,
  parseSimulationReportCandidate,
  selectCouncilOption,
  setSimulationBranchStatus,
  switchSimulationBranch,
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

export type WorldSimulationModelScene =
  | "simulation.actor"
  | "simulation.world"
  | "simulation.resolve"
  | "simulation.report"
  | "simulation.council";

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
  readonly error: string | null;
  readonly modelWarning: string | null;
  readonly sourceDriftWarning: string | null;
  updateScenario(next: WorldSimulationScenario): void;
  applyScenarioAndRebuild(next: WorldSimulationScenario): Promise<void>;
  selectScenario(scenarioId: string): Promise<void>;
  newScenario(): Promise<void>;
  refresh(): Promise<void>;
  selectRun(runId: string): Promise<void>;
  removeRun(runId: string): Promise<void>;
  rebuildBaseline(): Promise<void>;
  saveScenario(): Promise<LoadedSimulationScenarios>;
  createRun(): Promise<void>;
  advanceOne(): Promise<void>;
  runToEnd(): Promise<void>;
  setContinuous(value: boolean): void;
  forkAt(eventId: string, name?: string): Promise<void>;
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

function freshScenario(): WorldSimulationScenario {
  const base = createDefaultWorldSimulationScenario();
  const suffix = Date.now().toString(36);
  return {
    ...base,
    id: `scenario-${suffix}`,
    name: "新的世界演化方案",
    seed: `world-${suffix}`,
  };
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
  const [error, setError] = useState<string | null>(null);
  const [modelWarning, setModelWarning] = useState<string | null>(null);
  const [sourceDriftWarning, setSourceDriftWarning] = useState<string | null>(
    null,
  );
  const operation = useRef<Promise<unknown>>(Promise.resolve());
  const loadedRunRef = useRef<LoadedWorldSimulationRun | null>(null);
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
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      throw cause;
    });
  }, []);

  const refresh = useCallback(async () => {
    await enqueue(async () => {
      let [nextScenarios, nextIndex] = await Promise.all([
        repository.loadScenarios(),
        repository.loadRunIndex(),
      ]);
      if (scenarioDirtyRef.current) {
        nextScenarios = await repository.saveScenario(
          scenarios ?? nextScenarios,
          scenarioRef.current,
        );
      }
      const selected =
        nextScenarios.value.scenarios.find(
          (item) => item.id === nextScenarios.value.activeScenarioId,
        ) ??
        nextScenarios.value.scenarios[0] ??
        createDefaultWorldSimulationScenario();
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
          runLoadError = `活动推演运行加载失败：${cause instanceof Error ? cause.message : String(cause)}`;
          nextRun = null;
        }
      }
      setScenarios(nextScenarios);
      setRunIndex(nextIndex);
      scenarioRef.current = selected;
      setScenario(selected);
      setScenarioDirty(false);
      setBaseline(nextRun?.value.baseline ?? nextBaseline);
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
      setBaseline(next);
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

  const newScenario = useCallback(async () => {
    if (scenarioDirty) await saveScenario();
    const next = freshScenario();
    scenarioRef.current = next;
    setScenario(next);
    setScenarioDirty(true);
  }, [saveScenario, scenarioDirty]);

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
        const loaded = await repository.loadRun(runId);
        const nextIndex = await repository.activateRun(runId);
        const latestBaseline = await buildWorldSimulationBaseline(
          storage,
          loaded.value.scenario,
        );
        setLoadedRun(loaded);
        setRunIndex(nextIndex);
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
        if (!nextIndex.value.activeRunId) {
          setLoadedRun(null);
          setBaseline(
            await buildWorldSimulationBaseline(storage, scenarioRef.current),
          );
          setSourceDriftWarning(null);
          return;
        }
        const nextRun = await repository.loadRun(nextIndex.value.activeRunId);
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

  const createRun = useCallback(async () => {
    await enqueue(async () => {
      const currentScenarios = scenarios ?? (await repository.loadScenarios());
      const savedScenarios = await repository.saveScenario(
        currentScenarios,
        scenarioRef.current,
      );
      const nextBaseline = await buildWorldSimulationBaseline(
        storage,
        scenarioRef.current,
      );
      const run = createWorldSimulationRun(nextBaseline, scenarioRef.current);
      const created = await repository.createRun(run);
      setScenarios(savedScenarios);
      setScenarioDirty(false);
      setBaseline(nextBaseline);
      setLoadedRun(created.run);
      setRunIndex(created.index);
      setContinuous(false);
      setModelWarning(null);
      setSourceDriftWarning(null);
    });
  }, [enqueue, repository, scenarios, storage]);

  const advance = useCallback(
    async (toEnd: boolean) => {
      await enqueue(async () => {
        const current = loadedRunRef.current;
        if (!current) throw new Error("请先创建推演运行");
        let sourceRun = current.value;
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
        let modelCandidate;
        const branch = getActiveSimulationBranch(sourceRun);
        const shouldAskModel =
          sourceRun.scenario.intelligence.mode === "assisted" &&
          Boolean(onRunModelScene) &&
          (sourceRun.scenario.intelligence.cadence === "each-step" ||
            branch.checkpoints.length % 4 === 1);
        if (shouldAskModel && onRunModelScene) {
          try {
            const scene: WorldSimulationModelScene =
              branch.ledger.length % 2 === 0
                ? "simulation.actor"
                : "simulation.world";
            modelCandidate = parseModelDecisionCandidate(
              await onRunModelScene(scene, buildDecisionPrompt(sourceRun)),
            );
            setModelWarning(null);
            try {
              modelCandidate = parseModelDecisionCandidate(
                await onRunModelScene(
                  "simulation.resolve",
                  buildResolutionPrompt(sourceRun, modelCandidate),
                ),
              );
            } catch (cause) {
              const warning = `冲突复核不可用，已保留通过内核校验的原始候选：${cause instanceof Error ? cause.message : String(cause)}`;
              sourceRun = withRunWarning(sourceRun, warning);
              setModelWarning(warning);
            }
          } catch (cause) {
            const warning = `智能候选不可用，已使用确定性策略：${cause instanceof Error ? cause.message : String(cause)}`;
            sourceRun = withRunWarning(sourceRun, warning);
            setModelWarning(warning);
          }
        } else if (
          sourceRun.scenario.intelligence.mode === "assisted" &&
          !onRunModelScene
        ) {
          const warning = "模型运行能力不可用，本次使用确定性策略。";
          sourceRun = withRunWarning(sourceRun, warning);
          setModelWarning(warning);
        }
        let next: WorldSimulationRun;
        try {
          next = advanceWorldSimulation(sourceRun, { toEnd, modelCandidate });
        } catch (cause) {
          if (!modelCandidate) throw cause;
          const warning = `智能候选未通过内核校验，已丢弃并使用确定性策略：${cause instanceof Error ? cause.message : String(cause)}`;
          sourceRun = withRunWarning(sourceRun, warning);
          setModelWarning(warning);
          next = advanceWorldSimulation(sourceRun, { toEnd });
        }
        const saved = await repository.saveRun(current, next);
        setLoadedRun(saved.run);
        setRunIndex(saved.index);
        if (getActiveSimulationBranch(saved.run.value).status === "completed")
          setContinuous(false);
      });
    },
    [enqueue, onRunModelScene, repository, storage],
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
        setLoadedRun(saved.run);
        setRunIndex(saved.index);
      });
    },
    [enqueue, repository],
  );

  const openCouncil = useCallback(
    async (eventId: string | null, question: string) => {
      await enqueue(async () => {
        const current = loadedRunRef.current;
        if (!current) throw new Error("当前没有可会商的推演运行");
        let candidate;
        let degradedReason: string | null = null;
        if (
          current.value.scenario.intelligence.mode === "assisted" &&
          onRunModelScene
        ) {
          try {
            const prompts = buildCouncilParticipantPrompts(
              current.value,
              eventId,
              question,
            );
            const responses = await Promise.all(
              prompts.map(async (participant) => {
                const partial = parseCouncilModelCandidate(
                  await onRunModelScene(
                    "simulation.council",
                    participant.prompt,
                  ),
                );
                const optionIdMap = new Map(
                  partial.options.map((option, index) => [
                    option.id,
                    `${participant.participantId}-option-${index + 1}`,
                  ]),
                );
                return {
                  stances: partial.stances
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
                    })),
                  options: partial.options.map((option, index) => ({
                    ...option,
                    id: `${participant.participantId}-option-${index + 1}`,
                  })),
                };
              }),
            );
            candidate = {
              stances: responses.flatMap((response) => response.stances),
              options: responses.flatMap((response) => response.options),
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
            setModelWarning(
              `会商模型不可用，已使用受知识边界约束的确定性立场：${degradedReason}`,
            );
          }
        } else {
          degradedReason =
            current.value.scenario.intelligence.mode === "deterministic"
              ? "方案配置为仅确定性内核"
              : "模型运行能力不可用";
        }
        const next = createCouncilSession(
          current.value,
          eventId,
          question,
          candidate,
          degradedReason,
        );
        const saved = await repository.saveRun(current, next);
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
      let candidate;
      let degradedReason: string | null = null;
      if (
        current.value.scenario.intelligence.mode === "assisted" &&
        onRunModelScene
      ) {
        try {
          candidate = parseSimulationReportCandidate(
            await onRunModelScene(
              "simulation.report",
              buildReportPrompt(current.value),
            ),
          );
          setModelWarning(null);
        } catch (cause) {
          degradedReason =
            cause instanceof Error ? cause.message : String(cause);
          setModelWarning(
            `报告模型不可用，已生成确定性报告：${degradedReason}`,
          );
        }
      } else {
        degradedReason =
          current.value.scenario.intelligence.mode === "deterministic"
            ? "方案配置为仅确定性内核"
            : "模型运行能力不可用";
      }
      const next = createSimulationReport(
        current.value,
        candidate,
        degradedReason,
      );
      const saved = await repository.saveRun(current, next);
      setLoadedRun(saved.run);
      setRunIndex(saved.index);
    });
  }, [enqueue, onRunModelScene, repository]);

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
    newScenario,
    refresh,
    selectRun,
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
    cancelRun() {
      setContinuous(false);
      return persistMutation((run) =>
        setSimulationBranchStatus(run, "cancelled"),
      );
    },
  };
}
