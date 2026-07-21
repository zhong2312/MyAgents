import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Clock3,
  Loader2,
  Orbit,
  Plus,
  RefreshCw,
  Save,
  SkipForward,
  Users,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  WORKBENCH_SIMULATION_REQUEST_VERSION,
  type WorkbenchSimulationCapabilities,
  WORKBENCH_SIMULATION_MODEL_SCENE_IDS,
  type WorkbenchSimulationModelSelections,
  type WorkbenchSimulationRun,
  type WorkbenchSimulationRunStatus,
  type WorkbenchSimulationScenario,
  type WorkbenchSimulationWorldSnapshot,
  type WorkbenchStorage,
  type WorkbenchSimulationRuns,
} from "@/workbench-sdk";

import { buildWorldSimulationSnapshot } from "./worldSimulationSnapshot";
import {
  getEffectiveModelSceneSelection,
  type NovelModelSceneId,
} from "./modelSceneSettings";
import { createNovelModelSceneSettingsRepository } from "./modelSceneSettingsRepository";
import {
  createWorldSimulationRepository,
  type LoadedWorldSimulationProject,
} from "./worldSimulationRepository";
import type { WorldSimulationRunReference } from "./worldSimulationSchema";
import "./WorldSimulationWorkbench.css";

type ConnectionState = "checking" | "connected" | "unavailable";
type ScenarioDraft = Omit<WorkbenchSimulationScenario, "schemaVersion">;

const STATUS_LABELS: Record<WorkbenchSimulationRunStatus, string> = {
  draft: "待启动",
  running: "推演中",
  paused: "已暂停",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
};

function lines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function lineText(value: readonly string[]): string {
  return value.join("\n");
}

function createScenarioDraft(): ScenarioDraft {
  return {
    id: `scenario-${Date.now().toString(36)}`,
    name: "新推演方案",
    objective: "",
    horizonRounds: 5,
    selectedActorIds: [],
    seedEvents: [],
    constraints: ["不得把未来规划当作已发生事实"],
  };
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function displayScalar(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function isTerminalRunStatus(status: WorkbenchSimulationRunStatus): boolean {
  return ["completed", "cancelled", "failed"].includes(status);
}

function ConnectionBadge({
  state,
  capabilities,
}: {
  readonly state: ConnectionState;
  readonly capabilities: WorkbenchSimulationCapabilities | null;
}) {
  if (state === "checking") {
    return (
      <span className="world-simulation-connection is-checking">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> 检查服务
      </span>
    );
  }
  if (state === "connected") {
    return (
      <span
        className="world-simulation-connection is-connected"
        title={`${capabilities?.engine ?? "MiroFish"} ${capabilities?.engineVersion ?? ""}`}
      >
        <CheckCircle2 className="h-3.5 w-3.5" /> MiroFish 已连接
      </span>
    );
  }
  return (
    <span className="world-simulation-connection is-unavailable">
      <WifiOff className="h-3.5 w-3.5" /> MiroFish 未连接
    </span>
  );
}

function RunStatus({ status }: { readonly status: WorkbenchSimulationRunStatus }) {
  return (
    <span className={`world-simulation-status is-${status}`}>
      {status === "running" && <span className="world-simulation-pulse" />}
      {STATUS_LABELS[status]}
    </span>
  );
}

interface WorldSimulationWorkbenchProps {
  readonly storage: WorkbenchStorage;
  readonly simulationRuns: WorkbenchSimulationRuns;
  readonly isActive: boolean;
}

export default function WorldSimulationWorkbench({
  storage,
  simulationRuns,
  isActive,
}: WorldSimulationWorkbenchProps) {
  const repository = useMemo(
    () => createWorldSimulationRepository(storage),
    [storage],
  );
  const [projectFile, setProjectFile] =
    useState<LoadedWorldSimulationProject | null>(null);
  const [snapshot, setSnapshot] =
    useState<WorkbenchSimulationWorldSnapshot | null>(null);
  const [modelSelections, setModelSelections] =
    useState<WorkbenchSimulationModelSelections>({});
  const [draft, setDraft] = useState<ScenarioDraft>(() => createScenarioDraft());
  const [seedEventText, setSeedEventText] = useState("");
  const [constraintText, setConstraintText] = useState(
    "不得把未来规划当作已发生事实",
  );
  const [connection, setConnection] =
    useState<ConnectionState>("checking");
  const [capabilities, setCapabilities] =
    useState<WorkbenchSimulationCapabilities | null>(null);
  const [remoteRuns, setRemoteRuns] = useState<readonly WorkbenchSimulationRun[]>(
    [],
  );
  const [activeRun, setActiveRun] =
    useState<WorkbenchSimulationRun | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollInFlight = useRef(false);

  const loadRemoteRuns = useCallback(
    async (projectId: string) => {
      const result = await simulationRuns.request({
        version: WORKBENCH_SIMULATION_REQUEST_VERSION,
        operation: "list",
        projectId,
      });
      setRemoteRuns(result.runs);
      return result.runs;
    },
    [simulationRuns],
  );

  const persistRunReference = useCallback(
    async (run: WorkbenchSimulationRun) => {
      try {
        const latest = await repository.load();
        const saved = await repository.saveRunReference(latest, run);
        setProjectFile(saved);
      } catch {
        // The companion remains authoritative; a later action retries the summary.
      }
    },
    [repository],
  );

  const loadModelSelections = useCallback(async () => {
    const loaded = await createNovelModelSceneSettingsRepository(storage).load();
    return Object.freeze(
      Object.fromEntries(
        WORKBENCH_SIMULATION_MODEL_SCENE_IDS.flatMap((sceneId) => {
          const selection = getEffectiveModelSceneSelection(
            loaded.settings,
            sceneId as NovelModelSceneId,
          );
          return selection ? [[sceneId, selection]] : [];
        }),
      ),
    ) as WorkbenchSimulationModelSelections;
  }, [storage]);

  const refreshAll = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [loadedProject, nextSnapshot] = await Promise.all([
        repository.load(),
        buildWorldSimulationSnapshot(storage),
      ]);
      const nextModelSelections = await loadModelSelections();
      setProjectFile(loadedProject);
      setSnapshot(nextSnapshot);
      setModelSelections(nextModelSelections);
      setConnection("checking");
      try {
        const nextCapabilities = await simulationRuns.request({
          version: WORKBENCH_SIMULATION_REQUEST_VERSION,
          operation: "capabilities",
        });
        setCapabilities(nextCapabilities);
        setConnection("connected");
        const runs = await loadRemoteRuns(nextSnapshot.projectId);
        setActiveRun((current) =>
          current
            ? (runs.find((run) => run.runId === current.runId) ?? current)
            : (runs[0] ?? null),
        );
      } catch (cause) {
        setConnection("unavailable");
        setCapabilities(null);
        setRemoteRuns([]);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsLoading(false);
    }
  }, [loadModelSelections, loadRemoteRuns, repository, simulationRuns, storage]);

  useEffect(() => {
    if (!isActive) return;
    void refreshAll();
  }, [isActive, refreshAll]);

  useEffect(() => {
    if (!isActive || activeRun?.status !== "running") return;
    const timer = window.setInterval(() => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      void simulationRuns
        .request({
          version: WORKBENCH_SIMULATION_REQUEST_VERSION,
          operation: "get",
          runId: activeRun.runId,
        })
        .then((run) => {
          setActiveRun(run);
          setRemoteRuns((current) => [
            run,
            ...current.filter((item) => item.runId !== run.runId),
          ]);
          if (isTerminalRunStatus(run.status)) {
            return persistRunReference(run);
          }
          return undefined;
        })
        .catch((cause) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        )
        .finally(() => {
          pollInFlight.current = false;
        });
    }, 1_200);
    return () => window.clearInterval(timer);
  }, [
    activeRun?.runId,
    activeRun?.status,
    isActive,
    persistRunReference,
    simulationRuns,
  ]);

  const selectScenario = (scenario: WorkbenchSimulationScenario) => {
    const actorIds = new Set(snapshot?.actors.map((actor) => actor.id) ?? []);
    setDraft({
      id: scenario.id,
      name: scenario.name,
      objective: scenario.objective,
      horizonRounds: scenario.horizonRounds,
      selectedActorIds: scenario.selectedActorIds.filter((id) =>
        actorIds.has(id),
      ),
      seedEvents: scenario.seedEvents,
      constraints: scenario.constraints,
    });
    setSeedEventText(lineText(scenario.seedEvents));
    setConstraintText(lineText(scenario.constraints));
  };

  const scenarioValue = (): WorkbenchSimulationScenario => ({
    schemaVersion: 1,
    ...draft,
    name: draft.name.trim(),
    objective: draft.objective.trim(),
    selectedActorIds: draft.selectedActorIds.filter((id) =>
      snapshot?.actors.some((actor) => actor.id === id),
    ),
    seedEvents: lines(seedEventText),
    constraints: lines(constraintText),
  });

  const saveScenario = async (): Promise<WorkbenchSimulationScenario> => {
    const scenario = scenarioValue();
    const latest = await repository.load();
    const saved = await repository.saveScenario(latest, scenario);
    setProjectFile(saved);
    return scenario;
  };

  const handleSaveScenario = async () => {
    setBusyAction("save");
    setError(null);
    try {
      await saveScenario();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyAction(null);
    }
  };

  const createRun = async () => {
    setBusyAction("create");
    setError(null);
    try {
      const scenario = await saveScenario();
      const nextSnapshot = await buildWorldSimulationSnapshot(storage);
      const nextModelSelections = await loadModelSelections();
      setSnapshot(nextSnapshot);
      setModelSelections(nextModelSelections);
      const run = await simulationRuns.request({
        version: WORKBENCH_SIMULATION_REQUEST_VERSION,
        operation: "create",
        snapshot: nextSnapshot,
        scenario,
        modelSelections: nextModelSelections,
      });
      setActiveRun(run);
      setRemoteRuns((current) => [run, ...current]);
      await persistRunReference(run);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyAction(null);
    }
  };

  const runAction = async (
    operation: "start" | "pause" | "resume" | "advance" | "cancel",
  ) => {
    if (!activeRun) return;
    setBusyAction(operation);
    setError(null);
    try {
      const run = await simulationRuns.request({
        version: WORKBENCH_SIMULATION_REQUEST_VERSION,
        operation,
        runId: activeRun.runId,
      });
      setActiveRun(run);
      setRemoteRuns((current) => [
        run,
        ...current.filter((item) => item.runId !== run.runId),
      ]);
      await persistRunReference(run);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyAction(null);
    }
  };

  const openRun = async (runId: string) => {
    setBusyAction(`open:${runId}`);
    setError(null);
    try {
      const run = await simulationRuns.request({
        version: WORKBENCH_SIMULATION_REQUEST_VERSION,
        operation: "get",
        runId,
      });
      setActiveRun(run);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyAction(null);
    }
  };

  const toggleActor = (actorId: string) => {
    setDraft((current) => ({
      ...current,
      selectedActorIds: current.selectedActorIds.includes(actorId)
        ? current.selectedActorIds.filter((id) => id !== actorId)
        : [...current.selectedActorIds, actorId],
    }));
  };

  const history: readonly (
    | WorkbenchSimulationRun
    | WorldSimulationRunReference
  )[] = remoteRuns.length
    ? remoteRuns
    : (projectFile?.value.runReferences ?? []);
  const selectedCount = draft.selectedActorIds.length;
  const isBusy = busyAction !== null;
  const canCreate =
    connection === "connected" &&
    Boolean(draft.name.trim()) &&
    Boolean(draft.objective.trim()) &&
    !isBusy;

  if (isLoading && !snapshot) {
    return (
      <div className="world-simulation-loading">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span>正在构建世界快照</span>
      </div>
    );
  }

  return (
    <div className="world-simulation-root">
      <header className="world-simulation-header">
        <div className="world-simulation-heading">
          <Orbit className="h-5 w-5" />
          <div>
            <h1>世界推演</h1>
            <p>
              {snapshot?.title ?? "小说项目"} · {snapshot?.anchor ?? "当前基线"}
            </p>
          </div>
        </div>
        <div className="world-simulation-header-actions">
          <ConnectionBadge state={connection} capabilities={capabilities} />
          <button
            type="button"
            className="world-simulation-icon-button"
            aria-label="刷新世界快照与推演记录"
            title="刷新世界快照与推演记录"
            onClick={() => void refreshAll()}
            disabled={isLoading || isBusy}
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </header>

      {error && (
        <div className="world-simulation-error" role="alert">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="world-simulation-facts">
        <span><Users className="h-3.5 w-3.5" /> {snapshot?.actors.length ?? 0} 个行动主体</span>
        <span>{snapshot?.locations.length ?? 0} 个地点</span>
        <span>{snapshot?.rules.length ?? 0} 条世界规则</span>
        <span>{snapshot?.timelineEvents.length ?? 0} 个已发生事件</span>
        <span className="world-simulation-revision" title={snapshot?.sourceRevision}>
          基线 {snapshot?.sourceRevision.slice(-10) ?? "--"}
        </span>
      </div>

      <div className="world-simulation-layout">
        <aside className="world-simulation-scenarios">
          <div className="world-simulation-panel-title">
            <h2>推演方案</h2>
            <button
              type="button"
              className="world-simulation-icon-button is-small"
              aria-label="新建推演方案"
              title="新建推演方案"
              onClick={() => {
                const next = createScenarioDraft();
                setDraft(next);
                setSeedEventText("");
                setConstraintText(lineText(next.constraints));
              }}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="world-simulation-scenario-list">
            {(projectFile?.value.scenarios ?? []).map((scenario) => (
              <button
                type="button"
                key={scenario.id}
                className={`world-simulation-scenario-row ${scenario.id === draft.id ? "is-active" : ""}`}
                onClick={() => selectScenario(scenario)}
              >
                <span>{scenario.name}</span>
                <small>{scenario.horizonRounds} 轮</small>
              </button>
            ))}
            {!projectFile?.value.scenarios.length && (
              <p className="world-simulation-empty-note">暂无已保存方案</p>
            )}
          </div>

          <div className="world-simulation-history-title">
            <h2>推演记录</h2>
            <Clock3 className="h-3.5 w-3.5" />
          </div>
          <div className="world-simulation-history-list">
            {history.map((run) => (
              <button
                type="button"
                key={run.runId}
                className={`world-simulation-history-row ${activeRun?.runId === run.runId ? "is-active" : ""}`}
                onClick={() => void openRun(run.runId)}
                disabled={connection !== "connected" || isBusy}
              >
                <span className="world-simulation-history-copy">
                  <strong>{"scenario" in run ? run.scenario.name : run.scenarioName}</strong>
                  <small>{formatTime(run.updatedAt)}</small>
                </span>
                <RunStatus status={run.status} />
              </button>
            ))}
            {!history.length && (
              <p className="world-simulation-empty-note">暂无推演记录</p>
            )}
          </div>
        </aside>

        <section className="world-simulation-editor">
          <div className="world-simulation-section-heading">
            <div>
              <h2>方案配置</h2>
              <p>
                Canon 与事实时间线进入世界快照 · 模型场景 {
                  Object.keys(modelSelections).length
                } / {WORKBENCH_SIMULATION_MODEL_SCENE_IDS.length}
              </p>
            </div>
            <button
              type="button"
              className="world-simulation-secondary-button"
              onClick={() => void handleSaveScenario()}
              disabled={isBusy || !draft.name.trim() || !draft.objective.trim()}
            >
              {busyAction === "save" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              保存方案
            </button>
          </div>

          <label className="world-simulation-field">
            <span>方案名称</span>
            <input
              value={draft.name}
              maxLength={120}
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
          </label>
          <label className="world-simulation-field">
            <span>推演目标</span>
            <textarea
              value={draft.objective}
              rows={4}
              maxLength={4_000}
              placeholder="例如：推演宗门封山后三日内，各方会如何行动"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  objective: event.target.value,
                }))
              }
            />
          </label>
          <div className="world-simulation-round-field">
            <span>推演轮数</span>
            <input
              type="range"
              min={1}
              max={30}
              value={draft.horizonRounds}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  horizonRounds: Number(event.target.value),
                }))
              }
            />
            <output>{draft.horizonRounds}</output>
          </div>

          <div className="world-simulation-actor-heading">
            <div>
              <h3>行动主体</h3>
              <span>{selectedCount ? `已选 ${selectedCount}` : "全部参与"}</span>
            </div>
            <button
              type="button"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  selectedActorIds: current.selectedActorIds.length
                    ? []
                    : snapshot?.actors.map((actor) => actor.id) ?? [],
                }))
              }
            >
              {selectedCount ? "全部参与" : "全选"}
            </button>
          </div>
          <div className="world-simulation-actor-list">
            {(snapshot?.actors ?? []).map((actor) => {
              const checked = draft.selectedActorIds.includes(actor.id);
              return (
                <label key={actor.id} className={checked ? "is-checked" : ""}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleActor(actor.id)}
                  />
                  <span>
                    <strong>{actor.name}</strong>
                    <small>{actor.kind === "character" ? "人物" : "势力"}</small>
                  </span>
                </label>
              );
            })}
          </div>

          <div className="world-simulation-two-fields">
            <label className="world-simulation-field">
              <span>触发事件</span>
              <textarea
                value={seedEventText}
                rows={5}
                placeholder="每行一个事件"
                onChange={(event) => setSeedEventText(event.target.value)}
              />
            </label>
            <label className="world-simulation-field">
              <span>推演约束</span>
              <textarea
                value={constraintText}
                rows={5}
                placeholder="每行一个约束"
                onChange={(event) => setConstraintText(event.target.value)}
              />
            </label>
          </div>

          <div className="world-simulation-create-row">
            <button
              type="button"
              className="world-simulation-primary-button"
              disabled={!canCreate}
              onClick={() => void createRun()}
            >
              {busyAction === "create" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Orbit className="h-4 w-4" />
              )}
              创建推演
            </button>
          </div>
        </section>

        <section className="world-simulation-run">
          <div className="world-simulation-section-heading">
            <div>
              <h2>推演进程</h2>
              <p>
                {activeRun
                  ? `${activeRun.currentRound} / ${activeRun.maxRounds} 轮`
                  : "尚未创建推演"}
              </p>
            </div>
            {activeRun && <RunStatus status={activeRun.status} />}
          </div>

          <div className="world-simulation-controls" aria-label="推演控制">
            {activeRun?.status === "draft" && (
              <button
                type="button"
                onClick={() => void runAction("start")}
                disabled={isBusy}
                title="开始连续推演"
              >
                <CirclePlay className="h-4 w-4" /> 开始
              </button>
            )}
            {activeRun?.status === "running" && (
              <button
                type="button"
                onClick={() => void runAction("pause")}
                disabled={isBusy}
                title="暂停推演"
              >
                <CirclePause className="h-4 w-4" /> 暂停
              </button>
            )}
            {activeRun?.status === "paused" && (
              <button
                type="button"
                onClick={() => void runAction("resume")}
                disabled={isBusy}
                title="继续连续推演"
              >
                <CirclePlay className="h-4 w-4" /> 继续
              </button>
            )}
            {(activeRun?.status === "draft" || activeRun?.status === "paused") && (
              <button
                type="button"
                onClick={() => void runAction("advance")}
                disabled={isBusy}
                title="只推进一轮"
              >
                <SkipForward className="h-4 w-4" /> 单步
              </button>
            )}
            {activeRun &&
              !["completed", "cancelled", "failed"].includes(activeRun.status) && (
                <button
                  type="button"
                  className="is-danger"
                  onClick={() => void runAction("cancel")}
                  disabled={isBusy}
                  title="取消本次推演"
                >
                  <Ban className="h-4 w-4" /> 取消
                </button>
              )}
            {busyAction && !["save", "create"].includes(busyAction) && (
              <Loader2 className="ml-auto h-4 w-4 animate-spin text-[var(--ink-muted)]" />
            )}
          </div>

          {!activeRun ? (
            <div className="world-simulation-run-empty">
              <Orbit className="h-7 w-7" />
              <span>等待推演方案</span>
            </div>
          ) : (
            <div className="world-simulation-results">
              {activeRun.error && (
                <div className="world-simulation-run-error">{activeRun.error}</div>
              )}
              <div className="world-simulation-result-section">
                <h3>事件流</h3>
                <div className="world-simulation-event-list">
                  {[...activeRun.events].reverse().map((event, index) => (
                    <article key={textField(event.id) || `${index}`}>
                      <div className="world-simulation-event-index">
                        {displayScalar(event.round) || activeRun.events.length - index}
                      </div>
                      <div>
                        <h4>{textField(event.title) || "世界状态变化"}</h4>
                        <p>{textField(event.summary)}</p>
                        {(textField(event.cause) || textField(event.consequence)) && (
                          <dl>
                            {textField(event.cause) && (
                              <><dt>因</dt><dd>{textField(event.cause)}</dd></>
                            )}
                            {textField(event.consequence) && (
                              <><dt>果</dt><dd>{textField(event.consequence)}</dd></>
                            )}
                          </dl>
                        )}
                        <div className="world-simulation-event-meta">
                          {stringList(event.actorIds).map((id) => (
                            <span key={id}>{activeRun.snapshot.actors.find((actor) => actor.id === id)?.name ?? id}</span>
                          ))}
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-[var(--ink-subtle)]" />
                    </article>
                  ))}
                  {!activeRun.events.length && (
                    <p className="world-simulation-empty-note">尚未产生事件</p>
                  )}
                </div>
              </div>

              {!!activeRun.stateChanges.length && (
                <div className="world-simulation-result-section">
                  <h3>状态变化</h3>
                  <div className="world-simulation-change-list">
                    {[...activeRun.stateChanges].reverse().map((change, index) => (
                      <div key={`${textField(change.entityId)}-${textField(change.field)}-${index}`}>
                        <strong>{textField(change.entityId) || "世界"}</strong>
                        <span>{textField(change.field)}</span>
                        <p>
                          {textField(change.before) || "未记录"}
                          <ChevronRight className="h-3.5 w-3.5" />
                          {textField(change.after) || "未记录"}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!!activeRun.warnings.length && (
                <div className="world-simulation-result-section is-warning">
                  <h3>推演警告</h3>
                  <ul>
                    {activeRun.warnings.map((warning, index) => (
                      <li key={`${warning}-${index}`}>
                        <AlertTriangle className="h-3.5 w-3.5" /> {warning}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
