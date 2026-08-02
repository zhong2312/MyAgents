import { AlertTriangle, CalendarClock, ChevronRight, CirclePause, FastForward, MapPin, Orbit, Play, RefreshCw, Save, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CustomSelect, type WorkbenchSimulationScenario, type WorkbenchStorage } from "@/workbench-sdk";
import { buildWorldSimulationSnapshot } from "./worldSimulationSnapshot";
import { createWorldSimulationRepository, type LoadedWorldSimulationProject } from "./worldSimulationRepository";
import { advanceBy, advanceTo, advanceToNextEvent, compareTicks, createWorldSimulationState } from "./worldSimulationEngine";
import { createWorldSimulationWorldRepository, type LoadedWorldSimulationState } from "./worldSimulationWorldRepository";
import type { ExecutedWorldEvent, WorldSimulationState } from "./worldSimulationWorldSchema";
import "./WorldSimulationWorkbench.css";

interface WorldSimulationWorkbenchProps {
  readonly storage: WorkbenchStorage;
  readonly isActive: boolean;
  /** 兼容旧宿主协议；本地引擎不再调用远程服务。 */
  readonly simulationRuns?: unknown;
}

function newScenario(): WorkbenchSimulationScenario {
  return { schemaVersion: 1, id: `scenario-${Date.now().toString(36)}`, name: "新世界时间线", objective: "观察世界在时间流动中的自然变化", horizonRounds: 30, selectedActorIds: [], seedEvents: [], constraints: ["不得把未来规划当作已发生事实"] };
}

function lines(value: string): string[] { return value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean); }

function activityLabel(value: WorldSimulationState["regions"][number]["activity"]): string {
  return ({ quiet: "静默", stable: "稳定", tense: "紧张", war: "战争", catastrophe: "灾变" })[value];
}

function RunEvent({ event }: { readonly event: ExecutedWorldEvent }) {
  return <article className="world-simulation-local-event">
    <div className="world-simulation-local-event-dot" />
    <div className="world-simulation-local-event-copy">
      <div className="world-simulation-local-event-meta"><span>{event.tick}</span><span>{event.kind}</span></div>
      <h3>{event.title}</h3>
      <p>{event.summary}</p>
      {event.changes.length > 0 && <ul>{event.changes.map((change) => <li key={`${change.targetId}-${change.field}`}><strong>{change.field}</strong> {change.before ?? "未设定"} → {change.after ?? "未设定"}<small>{change.reason}</small></li>)}</ul>}
    </div>
  </article>;
}

export default function WorldSimulationWorkbench({ storage, isActive }: WorldSimulationWorkbenchProps) {
  const scenarioRepository = useMemo(() => createWorldSimulationRepository(storage), [storage]);
  const worldRepository = useMemo(() => createWorldSimulationWorldRepository(storage), [storage]);
  const [project, setProject] = useState<LoadedWorldSimulationProject | null>(null);
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof buildWorldSimulationSnapshot>> | null>(null);
  const [loadedState, setLoadedState] = useState<LoadedWorldSimulationState | null>(null);
  const [state, setState] = useState<WorldSimulationState | null>(null);
  const [scenario, setScenario] = useState<WorkbenchSimulationScenario>(() => newScenario());
  const [seedText, setSeedText] = useState("");
  const [constraintText, setConstraintText] = useState("不得把未来规划当作已发生事实");
  const [spanTick, setSpanTick] = useState("100");
  const [seedRegionIds, setSeedRegionIds] = useState<readonly string[]>([]);
  const [regionFilter, setRegionFilter] = useState("all");
  const [targetTick, setTargetTick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const [nextProject, nextSnapshot] = await Promise.all([scenarioRepository.load(), buildWorldSimulationSnapshot(storage)]);
      const nextState = await worldRepository.load(nextSnapshot.projectId);
      setProject(nextProject); setSnapshot(nextSnapshot); setLoadedState(nextState); setState(nextState.value);
      const first = nextProject.value.scenarios[0];
      if (first) { setScenario(first); setSeedText(first.seedEvents.join("\n")); setConstraintText(first.constraints.join("\n")); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }, [scenarioRepository, storage, worldRepository]);

  useEffect(() => { if (isActive) void refresh(); }, [isActive, refresh]);

  const saveScenario = async () => {
    if (!project) return;
    const next = { ...scenario, name: scenario.name.trim() || "未命名时间线", objective: scenario.objective.trim() || "观察世界变化", seedEvents: lines(seedText), constraints: lines(constraintText) };
    const saved = await scenarioRepository.saveScenario(project, next);
    setProject(saved); setScenario(next);
  };

  const selectScenario = (next: WorkbenchSimulationScenario) => { setScenario(next); setSeedText(next.seedEvents.join("\n")); setConstraintText(next.constraints.join("\n")); };

  const toggleActor = (actorId: string) => setScenario((current) => ({ ...current, selectedActorIds: current.selectedActorIds.includes(actorId) ? current.selectedActorIds.filter((id) => id !== actorId) : [...current.selectedActorIds, actorId] }));
  const toggleRegion = (regionId: string) => setSeedRegionIds((current) => current.includes(regionId) ? current.filter((id) => id !== regionId) : [...current, regionId]);

  const startScenario = async () => {
    if (!snapshot || !loadedState) return;
    setBusy(true); setError(null);
    try {
      await saveScenario();
      const next = createWorldSimulationState(snapshot, { ...scenario, seedEvents: lines(seedText), constraints: lines(constraintText) }, seedRegionIds);
      const bounded = spanTick.trim() ? { ...next, endTick: spanTick.trim() } : next;
      const saved = await worldRepository.save(loadedState, bounded);
      setLoadedState(saved); setState(saved.value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };

  const advance = async (kind: "next" | "day" | "month" | "year" | "target", requestedTick?: string) => {
    if (!state || !loadedState) return;
    setBusy(true); setError(null);
    try {
      const result = kind === "next" ? advanceToNextEvent(state) : kind === "target" ? advanceTo(state, (requestedTick ?? targetTick).trim()) : advanceBy(state, kind === "day" ? 1 : kind === "month" ? 30 : 365);
      const saved = await worldRepository.save(loadedState, result.state);
      setLoadedState(saved); setState(saved.value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };

  const selectedRegions = useMemo(() => (state?.regions ?? []).filter((region) => regionFilter === "all" || region.id === regionFilter), [regionFilter, state?.regions]);
  const upcoming = useMemo(() => (state?.scheduledEvents ?? []).filter((event) => !(state?.executedEvents.some((done) => done.id === event.id))).slice().sort((a, b) => compareTicks(a.startTick, b.startTick)).slice(0, 8), [state]);
  const latestEvents = state?.executedEvents.slice().reverse() ?? [];

  if (!snapshot || !state) return <div className="world-simulation-loading"><Orbit className="h-5 w-5 animate-spin" /> <span>{error ?? "正在构建时空世界"}</span><button type="button" onClick={() => void refresh()} disabled={busy}><RefreshCw className="h-4 w-4" /></button></div>;

  return <div className="world-simulation-root world-simulation-local-root">
    <header className="world-simulation-header"><div className="world-simulation-heading"><Orbit className="h-5 w-5" /><div><h1>时空世界引擎</h1><p>{snapshot.title} · 世界是活的，时间会自行流动</p></div></div><div className="world-simulation-header-actions"><span className="world-simulation-local-clock"><CalendarClock className="h-3.5 w-3.5" /> {state.currentLabel}</span><button type="button" className="world-simulation-icon-button" aria-label="刷新" title="刷新" onClick={() => void refresh()} disabled={busy}><RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} /></button></div></header>
    {error && <div className="world-simulation-error" role="alert"><AlertTriangle className="h-4 w-4" />{error}</div>}
    <div className="world-simulation-local-toolbar"><div className="world-simulation-local-toolbar-group"><button type="button" onClick={() => void advance("next")} disabled={busy}><FastForward className="h-3.5 w-3.5" />下一事件</button><button type="button" onClick={() => void advance("day")} disabled={busy}>+1 天</button><button type="button" onClick={() => void advance("month")} disabled={busy}>+1 月</button><button type="button" onClick={() => void advance("year")} disabled={busy}>+1 年</button><input value={targetTick} onChange={(event) => setTargetTick(event.target.value)} placeholder="目标时间" aria-label="目标时间" /><button type="button" onClick={() => void advance("target")} disabled={busy || !targetTick.trim()}><Play className="h-3.5 w-3.5" />跳转</button></div><div className="world-simulation-local-toolbar-note">{latestEvents.length ? `已记录 ${latestEvents.length} 个世界事件` : "尚未发生事件，推进时间开始观察"}</div></div>
    <div className="world-simulation-local-grid">
      <aside className="world-simulation-local-sidebar"><section><div className="world-simulation-section-heading"><h2>时间线方案</h2><button type="button" title="新建方案" aria-label="新建方案" onClick={() => { const next = newScenario(); setScenario(next); setSeedText(""); setSeedRegionIds([]); setConstraintText(next.constraints.join("\n")); }}><ChevronRight className="h-4 w-4" /></button></div>{(project?.value.scenarios ?? []).map((item) => <button type="button" key={item.id} className={`world-simulation-local-scenario ${item.id === scenario.id ? "is-active" : ""}`} onClick={() => selectScenario(item)}>{item.name}<small>{item.horizonRounds} 天</small></button>)}{!(project?.value.scenarios.length) && <p className="world-simulation-empty-note">保存第一条世界时间线</p>}</section><section className="world-simulation-local-form"><label>方案名称<input value={scenario.name} onChange={(event) => setScenario({ ...scenario, name: event.target.value })} /></label><label>推演目标<textarea value={scenario.objective} onChange={(event) => setScenario({ ...scenario, objective: event.target.value })} /></label><label>时间跨度（天，可填超大整数）<input value={spanTick} onChange={(event) => setSpanTick(event.target.value)} placeholder="例如 1000000000000" /></label><div className="world-simulation-local-selection"><span>参与主体（{scenario.selectedActorIds.length}）</span>{snapshot.actors.slice(0, 12).map((actor) => <label key={actor.id}><input type="checkbox" checked={scenario.selectedActorIds.includes(actor.id)} onChange={() => toggleActor(actor.id)} />{actor.name}</label>)}</div><div className="world-simulation-local-selection"><span>受影响区域（{seedRegionIds.length}）</span>{state.regions.slice(0, 12).map((region) => <label key={region.id}><input type="checkbox" checked={seedRegionIds.includes(region.id)} onChange={() => toggleRegion(region.id)} />{region.name}</label>)}</div><label>种子事件<textarea value={seedText} onChange={(event) => setSeedText(event.target.value)} placeholder="每行一个；用 10|某主体行动 指定第10天" /></label><label>规则约束<textarea value={constraintText} onChange={(event) => setConstraintText(event.target.value)} /></label><div className="world-simulation-local-form-actions"><button type="button" onClick={() => void saveScenario()} disabled={busy}><Save className="h-3.5 w-3.5" />保存方案</button><button type="button" className="is-primary" onClick={() => void startScenario()} disabled={busy}><Play className="h-3.5 w-3.5" />重置并开始</button></div></section></aside>
      <main className="world-simulation-local-main"><section className="world-simulation-local-overview"><div><span>世界时间</span><strong>{state.currentLabel}</strong><small>时间单位：{state.timeUnit === "day" ? "日" : state.timeUnit}</small></div><div><span>活动区域</span><strong>{selectedRegions.filter((region) => region.activity !== "quiet").length} / {state.regions.length}</strong><small>压力会随时间缓慢回落</small></div><div><span>行动主体</span><strong>{state.actors.filter((actor) => actor.status === "acting").length}</strong><small>当前时刻正在行动</small></div></section><section className="world-simulation-local-panel"><div className="world-simulation-section-heading"><div><h2>区域状态</h2><p>空间范围决定谁能感知、响应和传播事件</p></div><div className="world-simulation-local-filter"><MapPin className="h-3.5 w-3.5" /><CustomSelect value={regionFilter} options={[{ value: "all", label: "全部区域" }, ...state.regions.map((region) => ({ value: region.id, label: region.name }))]} onChange={setRegionFilter} ariaLabel="筛选区域" compact className="w-36" /></div></div><div className="world-simulation-local-regions">{selectedRegions.map((region) => <article key={region.id}><div className="world-simulation-local-region-title"><MapPin className="h-3.5 w-3.5" /><strong>{region.name}</strong><span className={`is-${region.activity}`}>{activityLabel(region.activity)}</span></div><div className="world-simulation-local-meter"><i style={{ width: `${region.pressure}%` }} /></div><small>世界压力 {Math.round(region.pressure)} · {region.parentId ? "隶属上级区域" : "顶层区域"}</small></article>)}{!selectedRegions.length && <p className="world-simulation-empty-note">设定中还没有空间节点</p>}</div></section><section className="world-simulation-local-panel"><div className="world-simulation-section-heading"><div><h2>主体动态</h2><p>事件触发主体行动，行动又会改变世界状态</p></div><Users className="h-4 w-4 text-[var(--accent-cool)]" /></div><div className="world-simulation-local-actors">{state.actors.filter((actor) => actor.status !== "idle" || actor.intent).slice(0, 12).map((actor) => <div key={actor.id}><span>{actor.name}</span><small>{actor.status === "acting" ? actor.intent : "等待下一次变化"}</small></div>)}{!state.actors.some((actor) => actor.status !== "idle" || actor.intent) && <p className="world-simulation-empty-note">当前没有主体行动，世界处于静默区间</p>}</div></section></main>
      <aside className="world-simulation-local-rail"><section><div className="world-simulation-section-heading"><h2>即将到来</h2><span>{upcoming.length}</span></div>{upcoming.map((event) => <button type="button" key={event.id} className="world-simulation-local-upcoming" onClick={() => { setTargetTick(event.startTick); void advance("target", event.startTick); }}><time>第 {event.startTick} 天</time><strong>{event.title}</strong><small>{event.regionIds.length ? `${event.regionIds.length} 个区域` : "全局"}</small></button>)}{!upcoming.length && <p className="world-simulation-empty-note">事件队列已清空</p>}</section><section><div className="world-simulation-section-heading"><h2>世界事件流</h2><span>{latestEvents.length}</span></div>{latestEvents.map((event) => <RunEvent key={event.id} event={event} />)}{!latestEvents.length && <div className="world-simulation-local-silence"><CirclePause className="h-5 w-5" /><p>静默区间</p><small>没有事件并不代表世界停止。时间正在向下一个边界流动。</small></div>}</section></aside>
    </div>
  </div>;
}
