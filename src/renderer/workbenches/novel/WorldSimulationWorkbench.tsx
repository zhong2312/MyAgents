import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle,
  ArrowRight,
  BookOpenCheck,
  Boxes,
  BrainCircuit,
  CalendarClock,
  Check,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Clock3,
  FileText,
  GitCompareArrows,
  GitFork,
  Globe2,
  History,
  ListTree,
  Map as MapIcon,
  Network,
  Orbit,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Scale,
  Settings2,
  ShieldCheck,
  Sparkles,
  StepForward,
  Trash2,
  Users,
  Waypoints,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  CustomSelect,
  type WorkbenchNavigationGuard,
  type WorkbenchStorage,
} from "@/workbench-sdk";

import { compareSimulationBranches } from "./worldSimulationEngineV2";
import WorldProposalReview from "./WorldProposalReview";
import { createWorldSimulationAdoptionFileProposalRepository } from "./worldSimulationAdoptionV2";
import {
  createWorldInstant,
  progressRatio,
  TIME_SCALE_LABELS,
} from "./worldSimulationTime";
import {
  type CouncilSession,
  type CouncilStance,
  type NarrativeConstraintMode,
  type SimulationBranch,
  type SimulationAdoptionAuthority,
  type SimulationDiagnostic,
  type SimulationEvent,
  type TimeScale,
  type WorldDomainCommand,
  type WorldSimulationBaseline,
  type WorldSimulationScenario,
} from "./worldSimulationV2Schema";
import {
  useWorldSimulationController,
  type WorldSimulationModelScene,
} from "./useWorldSimulationController";
import "./WorldSimulationWorkbench.css";
import NarrativeUnsavedChangesGuard from "./NarrativeUnsavedChangesGuard";

export type WorldSimulationView = "console" | "lab" | "council";
export type WorldSimulationSetupRoute =
  | "timeline"
  | "characters"
  | "factions"
  | "lore"
  | "lore-config"
  | "map"
  | "items"
  | "narrative"
  | "manuscript";

interface WorldSimulationWorkbenchProps {
  readonly storage: WorkbenchStorage;
  readonly isActive: boolean;
  readonly view: WorldSimulationView;
  readonly onNavigate: (view: WorldSimulationView) => void;
  readonly onOpenSetup: (route: WorldSimulationSetupRoute) => void;
  readonly onRunModelScene?: (
    scene: WorldSimulationModelScene,
    prompt: string,
  ) => Promise<string>;
  readonly registerNavigationGuard?: (
    guard: WorkbenchNavigationGuard,
  ) => () => void;
}

const SCALE_ORDER: readonly TimeScale[] = [
  "day",
  "month",
  "year",
  "century",
  "millennium",
  "ten-thousand-years",
  "hundred-billion-years",
  "trillion-years",
];

const VIEW_ITEMS: readonly {
  readonly id: WorldSimulationView;
  readonly label: string;
  readonly icon: typeof Settings2;
}[] = [
  { id: "console", label: "运行控制台", icon: Settings2 },
  { id: "lab", label: "世界实验室", icon: MapIcon },
  { id: "council", label: "立场会商", icon: BrainCircuit },
];

const CHAPTER_MODE_LABELS: Readonly<
  Record<WorldSimulationScenario["chapterContext"]["mode"], string>
> = {
  none: "不使用章节",
  after: "从章节后继续",
  before: "从章节前重演",
  branch: "从章节处分支",
};

const NARRATIVE_MODE_LABELS: Readonly<Record<NarrativeConstraintMode, string>> =
  {
    off: "关闭",
    observe: "仅观察",
    guide: "引导",
    strict: "强约束",
  };

const STATUS_LABELS: Readonly<Record<SimulationBranch["status"], string>> = {
  ready: "已就绪",
  running: "运行中",
  paused: "已暂停",
  completed: "已完成",
  cancelled: "已取消",
};

const EVENT_KIND_LABELS: Readonly<Record<SimulationEvent["kind"], string>> = {
  "character-action": "人物行动",
  "faction-strategy": "势力策略",
  conflict: "冲突",
  diplomacy: "外交",
  cultivation: "修炼",
  lifecycle: "生命周期",
  propagation: "空间传播",
  "world-process": "世界过程",
  epoch: "纪元演化",
};

function PatchScenario({
  scenario,
  onChange,
}: {
  readonly scenario: WorldSimulationScenario;
  readonly onChange: (next: WorldSimulationScenario) => void;
}) {
  return {
    value: scenario,
    patch: (patch: Partial<WorldSimulationScenario>) =>
      onChange({ ...scenario, ...patch }),
  };
}

function IconButton({
  label,
  children,
  onClick,
  disabled,
  active,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly active?: boolean;
}) {
  return (
    <button
      type="button"
      className={`ws2-icon-button ${active ? "is-active" : ""}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function WorkflowHeader({
  view,
  baseline,
  branch,
  busy,
  onNavigate,
  onRefresh,
}: {
  readonly view: WorldSimulationView;
  readonly baseline: WorldSimulationBaseline | null;
  readonly branch: SimulationBranch | null;
  readonly busy: boolean;
  readonly onNavigate: (view: WorldSimulationView) => void;
  readonly onRefresh: () => void;
}) {
  return (
    <>
      <header className="ws2-header">
        <div className="ws2-brand">
          <span className="ws2-brand-mark">
            <Orbit />
          </span>
          <div>
            <small>{baseline?.projectTitle ?? "小说工作台"}</small>
            <h1>世界推演</h1>
          </div>
        </div>
        <div className="ws2-run-state">
          <i className={branch?.status === "completed" ? "is-complete" : ""} />
          <span>{branch ? STATUS_LABELS[branch.status] : "基线准备中"}</span>
          <small>
            {branch?.state.currentTime.displayText ??
              baseline?.anchor.displayText ??
              "等待事实锚点"}
          </small>
        </div>
        <IconButton
          label="刷新世界资料投影"
          onClick={onRefresh}
          disabled={busy}
        >
          <RefreshCw className={busy ? "ws2-spin" : ""} />
        </IconButton>
      </header>
      <nav className="ws2-workflow" aria-label="世界推演工作面">
        <div>
          {VIEW_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={view === item.id ? "is-active" : ""}
                onClick={() => onNavigate(item.id)}
              >
                <Icon /> {item.label}
              </button>
            );
          })}
        </div>
        <span>
          <Waypoints /> 事实基线 → 主体决策 → 规则裁定 → 空间传播 → 多尺度观察
        </span>
      </nav>
    </>
  );
}

function SimulationSidebar({
  scenario,
  scenarios,
  baseline,
  runIndex,
  onSelectScenario,
  onNewScenario,
  onSelectRun,
  onRemoveRun,
}: {
  readonly scenario: WorldSimulationScenario;
  readonly scenarios: readonly WorldSimulationScenario[];
  readonly baseline: WorldSimulationBaseline | null;
  readonly runIndex: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: SimulationBranch["status"];
    readonly eventCount: number;
  }[];
  readonly onSelectScenario: (id: string) => void;
  readonly onNewScenario: () => void;
  readonly onSelectRun: (id: string) => void;
  readonly onRemoveRun: (id: string) => void;
}) {
  const completion = baseline
    ? Math.round(
        ([
          baseline.characters.length > 0,
          baseline.factions.length > 0,
          baseline.regions.length > 0,
          baseline.rules.length > 0,
          baseline.cultivationSystems.length > 0,
          baseline.timelineFacts.length > 0,
        ].filter(Boolean).length /
          6) *
          100,
      )
    : 0;
  return (
    <aside className="ws2-sidebar">
      <section className="ws2-sidebar-heading">
        <div>
          <small>运行方案</small>
          <strong>{baseline?.projectTitle ?? "世界资料投影"}</strong>
        </div>
        <IconButton label="新建推演方案" onClick={onNewScenario}>
          <Boxes />
        </IconButton>
      </section>
      <div className="ws2-scenario-list">
        {scenarios.map((item, index) => (
          <button
            key={item.id}
            type="button"
            className={item.id === scenario.id ? "is-active" : ""}
            onClick={() => onSelectScenario(item.id)}
          >
            <i
              style={{
                background: ["#c45f35", "#3c7189", "#3f7b65", "#866a9b"][
                  index % 4
                ],
              }}
            />
            <span>
              <strong>{item.name}</strong>
              <small>
                {item.duration.amount}{" "}
                {item.duration.unit === "year"
                  ? "年"
                  : (TIME_SCALE_LABELS[item.duration.unit as TimeScale] ??
                    item.duration.unit)}
              </small>
            </span>
            <ChevronRight />
          </button>
        ))}
      </div>
      <section className="ws2-context">
        <div className="ws2-section-caption">
          <span>当前上下文</span>
          <small>投影只读</small>
        </div>
        <dl>
          <div>
            <dt>
              <History />
              事实截止点
            </dt>
            <dd>{baseline?.anchor.displayText ?? "未构建"}</dd>
          </div>
          <div>
            <dt>
              <BookOpenCheck />
              章节上下文
            </dt>
            <dd>{CHAPTER_MODE_LABELS[scenario.chapterContext.mode]}</dd>
          </div>
          <div>
            <dt>
              <ListTree />
              剧情工程
            </dt>
            <dd>
              {NARRATIVE_MODE_LABELS[scenario.narrativeContext.mode]} ·{" "}
              {baseline?.narrativeConstraints.length ?? 0} 项
            </dd>
          </div>
          <div>
            <dt>
              <Globe2 />
              目标地域
            </dt>
            <dd>
              {scenario.scope.regionIds.length || baseline?.regions.length || 0}{" "}
              个
            </dd>
          </div>
        </dl>
      </section>
      <section className="ws2-run-history">
        <div className="ws2-section-caption">
          <span>最近运行</span>
          <small>{runIndex.length}</small>
        </div>
        {runIndex.slice(0, 4).map((run) => (
          <div key={run.id} className="ws2-run-history-item">
            <button type="button" onClick={() => onSelectRun(run.id)}>
              <span>
                <strong>{run.name}</strong>
                <small>{run.eventCount} 个事件</small>
              </span>
              <em>{STATUS_LABELS[run.status]}</em>
            </button>
            <button
              type="button"
              title="删除运行记录"
              aria-label={`删除${run.name}`}
              onClick={() => onRemoveRun(run.id)}
            >
              <Trash2 />
            </button>
          </div>
        ))}
        {runIndex.length === 0 && <p>还没有推演记录</p>}
      </section>
      <footer className="ws2-sidebar-footer">
        <span>
          <i /> 数据投影完整度 {completion}%
        </span>
        {baseline?.diagnostics.some((item) => item.severity !== "info") && (
          <AlertTriangle />
        )}
      </footer>
    </aside>
  );
}

function Segmented<T extends string>({
  value,
  items,
  onChange,
  label,
}: {
  readonly value: T;
  readonly items: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (next: T) => void;
  readonly label: string;
}) {
  return (
    <div className="ws2-segmented" role="group" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          className={item.value === value ? "is-active" : ""}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function setupRouteForDiagnostic(
  diagnostic: SimulationDiagnostic,
): WorldSimulationSetupRoute | null {
  if (
    diagnostic.id === "timeline-facts-anchor-missing" ||
    diagnostic.id === "chapter-timeline-unlinked"
  ) {
    return "timeline";
  }
  if (diagnostic.id === "chapter-context-missing") return "manuscript";
  if (
    diagnostic.id.startsWith("selected-character-") ||
    diagnostic.id === "actionable-subjects-missing"
  ) {
    return "characters";
  }
  if (diagnostic.id.startsWith("selected-faction-")) return "factions";
  if (
    diagnostic.id === "regions-empty" ||
    diagnostic.id.startsWith("selected-region-")
  ) {
    return "lore-config";
  }
  if (diagnostic.id.startsWith("narrative-")) return "narrative";
  if (diagnostic.id.startsWith("map-")) return "map";
  if (diagnostic.id.startsWith("item-")) return "items";
  if (diagnostic.id.startsWith("setting-")) return "lore";
  return null;
}

function setupRouteLabel(
  diagnostic: SimulationDiagnostic,
  route: WorldSimulationSetupRoute,
): string {
  if (diagnostic.id === "timeline-facts-anchor-missing") {
    return "锁定已发生事实";
  }
  if (diagnostic.id === "chapter-timeline-unlinked") {
    return "关联章节事实";
  }
  if (diagnostic.id === "chapter-context-missing") {
    return "选择有效章节";
  }
  if (diagnostic.id.includes("location-missing")) {
    return "设置人物初始地点";
  }
  if (diagnostic.id === "actionable-subjects-missing") {
    return "补充人物或势力条件";
  }
  switch (route) {
    case "timeline":
      return "打开时间线";
    case "characters":
      return "打开人物库";
    case "factions":
      return "打开势力库";
    case "lore":
      return "打开设定库";
    case "lore-config":
      return "配置世界架构";
    case "map":
      return "打开地图";
    case "items":
      return "打开物品库";
    case "narrative":
      return "打开剧情工程";
    case "manuscript":
      return "打开正文";
  }
}

function DiagnosticGuidance({
  diagnostic,
  scenario,
  baseline,
  onApplyFix,
  onOpenSetup,
}: {
  readonly diagnostic: SimulationDiagnostic;
  readonly scenario: WorldSimulationScenario;
  readonly baseline: WorldSimulationBaseline;
  readonly onApplyFix: (next: WorldSimulationScenario) => Promise<void>;
  readonly onOpenSetup: (route: WorldSimulationSetupRoute) => void;
}) {
  const route = setupRouteForDiagnostic(diagnostic);
  const useCustomStart =
    diagnostic.id === "timeline-facts-anchor-missing" &&
    scenario.start.mode === "facts-anchor";
  const disableChapterContext =
    diagnostic.id === "chapter-context-missing" ||
    diagnostic.id === "chapter-timeline-unlinked";
  if (!route && !useCustomStart && !disableChapterContext) return null;
  return (
    <div className="ws2-readiness-actions">
      {useCustomStart && (
        <button
          type="button"
          onClick={() =>
            void onApplyFix({
              ...scenario,
              start: { mode: "custom", sortKey: baseline.anchor.sortKey },
            }).catch(() => undefined)
          }
        >
          <CalendarClock />
          改用自定义起点
        </button>
      )}
      {disableChapterContext && (
        <button
          type="button"
          onClick={() =>
            void onApplyFix({
              ...scenario,
              chapterContext: { mode: "none", chapterId: null },
            }).catch(() => undefined)
          }
        >
          <X />
          暂不使用章节
        </button>
      )}
      {route && (
        <button type="button" onClick={() => onOpenSetup(route)}>
          <ArrowRight />
          {setupRouteLabel(diagnostic, route)}
        </button>
      )}
    </div>
  );
}

function ConsoleView({
  scenario,
  baseline,
  branch,
  busy,
  continuous,
  onChange,
  onApplyFix,
  onSave,
  onRebuild,
  onCreateRun,
  onAdvance,
  onContinuous,
  onRunToEnd,
  onCancel,
  onOpenSetup,
}: {
  readonly scenario: WorldSimulationScenario;
  readonly baseline: WorldSimulationBaseline;
  readonly branch: SimulationBranch | null;
  readonly busy: boolean;
  readonly continuous: boolean;
  readonly onChange: (next: WorldSimulationScenario) => void;
  readonly onApplyFix: (next: WorldSimulationScenario) => Promise<void>;
  readonly onSave: () => void;
  readonly onRebuild: () => void;
  readonly onCreateRun: () => void;
  readonly onAdvance: () => void;
  readonly onContinuous: (value: boolean) => void;
  readonly onRunToEnd: () => void;
  readonly onCancel: () => void;
  readonly onOpenSetup: (route: WorldSimulationSetupRoute) => void;
}) {
  const { patch } = PatchScenario({ scenario, onChange });
  const blocking = baseline.diagnostics.filter(
    (item) => item.severity === "blocking",
  );
  const actionableWarnings = baseline.diagnostics.filter(
    (item) => item.severity === "warning",
  );
  const selectedActors =
    scenario.scope.characterIds.length + scenario.scope.factionIds.length;
  return (
    <main className="ws2-main ws2-console">
      <div className="ws2-page-title">
        <div>
          <small>RUN CONTROL</small>
          <h2>定义这一次世界如何开始</h2>
          <p>
            先锁定事实、时间、地域和作者意图，再让主体在规则内自行做出选择。
          </p>
        </div>
        <div className="ws2-title-actions">
          <button
            type="button"
            className="ws2-button"
            onClick={onSave}
            disabled={busy}
          >
            <Save />
            保存方案
          </button>
          <button
            type="button"
            className="ws2-button is-primary"
            onClick={onCreateRun}
            disabled={busy || blocking.length > 0}
          >
            <Play />
            开始推演
          </button>
        </div>
      </div>

      {branch && (
        <section className="ws2-run-controls">
          <div>
            <span>当前运行</span>
            <strong>{branch.name}</strong>
            <small>
              {branch.state.currentTime.displayText} · {branch.ledger.length}{" "}
              个事件
            </small>
          </div>
          <div>
            <button
              type="button"
              onClick={onAdvance}
              disabled={
                busy ||
                branch.status === "completed" ||
                branch.status === "cancelled"
              }
            >
              <StepForward />
              单步
            </button>
            <button
              type="button"
              onClick={() => onContinuous(!continuous)}
              disabled={
                branch.status === "completed" || branch.status === "cancelled"
              }
            >
              {continuous ? <Pause /> : <CirclePlay />}
              {continuous ? "暂停连续推进" : "连续推进"}
            </button>
            <button
              type="button"
              onClick={onRunToEnd}
              disabled={
                busy ||
                branch.status === "completed" ||
                branch.status === "cancelled"
              }
            >
              <Clock3 />
              运行到终点
            </button>
            <IconButton
              label="取消当前分支"
              onClick={onCancel}
              disabled={busy || branch.status === "cancelled"}
            >
              <X />
            </IconButton>
          </div>
        </section>
      )}

      <div className="ws2-config-grid">
        <section className="ws2-config-section ws2-time-config">
          <div className="ws2-config-heading">
            <b>01</b>
            <span>
              <strong>时间窗口</strong>
              <small>{scenario.calendar.name}</small>
            </span>
          </div>
          <div className="ws2-field-grid">
            <label>
              <span>起点</span>
              <input
                value={
                  scenario.start.mode === "facts-anchor"
                    ? "事实终点"
                    : scenario.start.sortKey
                }
                readOnly={scenario.start.mode === "facts-anchor"}
                onChange={(event) =>
                  patch({
                    start: { mode: "custom", sortKey: event.target.value },
                  })
                }
              />
              <small>主时间线 factsThroughEventId</small>
            </label>
            <label>
              <span>时间跨度</span>
              <div className="ws2-inline-input">
                <input
                  value={scenario.duration.amount}
                  onChange={(event) =>
                    patch({
                      duration: {
                        ...scenario.duration,
                        amount: event.target.value,
                      },
                    })
                  }
                />
                <CustomSelect
                  value={scenario.duration.unit}
                  options={[
                    ...SCALE_ORDER.map((scale) => ({
                      value: scale,
                      label: TIME_SCALE_LABELS[scale],
                    })),
                    { value: "era", label: "纪元" },
                  ]}
                  onChange={(value) =>
                    patch({
                      duration: {
                        ...scenario.duration,
                        unit: value as WorldSimulationScenario["duration"]["unit"],
                      },
                    })
                  }
                  ariaLabel="时间跨度单位"
                />
              </div>
              <small>长时段自动进入阶段和纪元叙事</small>
            </label>
          </div>
          <div className="ws2-field-grid ws2-time-options">
            <div>
              <span>输出尺度</span>
              <div className="ws2-scale-picks">
                {SCALE_ORDER.map((scale) => (
                  <button
                    key={scale}
                    type="button"
                    className={
                      scenario.outputScales.includes(scale) ? "is-active" : ""
                    }
                    onClick={() => {
                      const has = scenario.outputScales.includes(scale);
                      const next = has
                        ? scenario.outputScales.filter((item) => item !== scale)
                        : [...scenario.outputScales, scale];
                      if (next.length) patch({ outputScales: next });
                    }}
                  >
                    {TIME_SCALE_LABELS[scale]}
                  </button>
                ))}
              </div>
              <small>同一因果链的不同观察层</small>
            </div>
            <label>
              <span>推进预算</span>
              <div className="ws2-inline-input">
                <input
                  type="number"
                  min={1}
                  max={512}
                  value={scenario.maxSteps}
                  onChange={(event) =>
                    patch({ maxSteps: Number(event.target.value) || 1 })
                  }
                />
                <CustomSelect
                  value={scenario.intelligence.mode}
                  options={[
                    { value: "assisted", label: "智能候选 + 内核裁定" },
                    { value: "deterministic", label: "仅确定性内核" },
                  ]}
                  onChange={(value) =>
                    patch({
                      intelligence: {
                        ...scenario.intelligence,
                        mode: value as WorldSimulationScenario["intelligence"]["mode"],
                      },
                    })
                  }
                  ariaLabel="推进模式"
                />
              </div>
              <small>不会逐日循环超长时间</small>
            </label>
          </div>
          <details className="ws2-calendar-details">
            <summary>
              <CalendarClock />
              历法换算参数
            </summary>
            <div>
              <label>
                每月天数
                <input
                  type="number"
                  value={scenario.calendar.daysPerMonth}
                  onChange={(event) =>
                    patch({
                      calendar: {
                        ...scenario.calendar,
                        daysPerMonth: Math.max(1, Number(event.target.value)),
                      },
                    })
                  }
                />
              </label>
              <label>
                每年月份
                <input
                  type="number"
                  value={scenario.calendar.monthsPerYear}
                  onChange={(event) =>
                    patch({
                      calendar: {
                        ...scenario.calendar,
                        monthsPerYear: Math.max(1, Number(event.target.value)),
                      },
                    })
                  }
                />
              </label>
              <label>
                纪元年数
                <input
                  value={scenario.calendar.eraYears}
                  onChange={(event) =>
                    patch({
                      calendar: {
                        ...scenario.calendar,
                        eraYears: event.target.value,
                      },
                    })
                  }
                />
              </label>
            </div>
          </details>
        </section>

        <section className="ws2-config-section ws2-chapter-config">
          <div className="ws2-config-heading">
            <b>02</b>
            <span>
              <strong>章节上下文</strong>
              <small>正文明确事实进入沙盒</small>
            </span>
          </div>
          <Segmented
            value={scenario.chapterContext.mode}
            label="章节上下文模式"
            items={(
              Object.entries(CHAPTER_MODE_LABELS) as [
                WorldSimulationScenario["chapterContext"]["mode"],
                string,
              ][]
            ).map(([value, label]) => ({ value, label }))}
            onChange={(mode) =>
              patch({
                chapterContext: {
                  mode,
                  chapterId:
                    mode === "none"
                      ? null
                      : (scenario.chapterContext.chapterId ??
                        baseline.chapters[0]?.id ??
                        null),
                },
              })
            }
          />
          <label className="ws2-full-field">
            <span>章节锚点</span>
            <CustomSelect
              value={scenario.chapterContext.chapterId ?? ""}
              options={[
                { value: "", label: "选择章节" },
                ...baseline.chapters.map((chapter) => ({
                  value: chapter.id,
                  label: `第 ${chapter.displayNumber} 章 · ${chapter.title}`,
                })),
              ]}
              disabled={scenario.chapterContext.mode === "none"}
              onChange={(value) =>
                patch({
                  chapterContext: {
                    ...scenario.chapterContext,
                    chapterId: value || null,
                  },
                })
              }
              ariaLabel="章节锚点"
            />
            <small>只将正文中明确发生、并被事实时间线确认的内容视为事实</small>
          </label>
          <div className="ws2-policy-note">
            <ShieldCheck />
            <span>
              <strong>权威边界已锁定</strong>
              <small>梦想、传闻、误判和未来计划不会自动成为事实。</small>
            </span>
          </div>
        </section>

        <section className="ws2-config-section ws2-narrative-config">
          <div className="ws2-config-heading">
            <b>03</b>
            <span>
              <strong>剧情工程约束</strong>
              <small>
                当前 {NARRATIVE_MODE_LABELS[scenario.narrativeContext.mode]} ·{" "}
                {baseline.narrativeConstraints.length} 项设计
              </small>
            </span>
          </div>
          <div className="ws2-narrative-columns">
            <div>
              <span>参与方式</span>
              <Segmented
                value={scenario.narrativeContext.mode}
                label="剧情工程约束模式"
                items={(
                  Object.entries(NARRATIVE_MODE_LABELS) as [
                    NarrativeConstraintMode,
                    string,
                  ][]
                ).map(([value, label]) => ({ value, label }))}
                onChange={(mode) =>
                  patch({
                    narrativeContext: { ...scenario.narrativeContext, mode },
                  })
                }
              />
              <small>
                世界硬规则始终优先，强约束冲突时会报“剧情不可实现”。
              </small>
            </div>
            <fieldset>
              <legend>使用哪些设计</legend>
              {[
                [
                  "usePlotLines",
                  "主线 / 剧情线路",
                  baseline.narrativeConstraints.filter(
                    (item) => item.kind === "plot-line",
                  ).length,
                ],
                [
                  "useStoryArcs",
                  "故事弧",
                  baseline.narrativeConstraints.filter(
                    (item) => item.kind === "story-arc",
                  ).length,
                ],
                [
                  "useDirectoryOutline",
                  "卷 / 单元大纲",
                  baseline.narrativeConstraints.filter(
                    (item) => item.kind === "outline",
                  ).length,
                ],
                [
                  "useChapterPlans",
                  "章节计划",
                  baseline.narrativeConstraints.filter(
                    (item) => item.kind === "chapter-plan",
                  ).length,
                ],
              ].map(([key, label, count]) => (
                <label key={String(key)}>
                  <input
                    type="checkbox"
                    checked={Boolean(
                      scenario.narrativeContext[
                        key as keyof WorldSimulationScenario["narrativeContext"]
                      ],
                    )}
                    onChange={(event) =>
                      patch({
                        narrativeContext: {
                          ...scenario.narrativeContext,
                          [key]: event.target.checked,
                        },
                      })
                    }
                  />
                  <span>
                    {label}
                    <small>{count} 项进入当前投影</small>
                  </span>
                </label>
              ))}
            </fieldset>
          </div>
        </section>

        <section className="ws2-config-section ws2-scope-config">
          <div className="ws2-config-heading">
            <b>04</b>
            <span>
              <strong>空间与主体</strong>
              <small>
                {scenario.scope.outsidePolicy === "respond"
                  ? "范围外只响应"
                  : "边界策略已配置"}
              </small>
            </span>
          </div>
          <div className="ws2-scope-summary">
            <Globe2 />
            <span>
              <strong>
                {scenario.scope.regionIds.length || baseline.regions.length}{" "}
                个目标地域
              </strong>
              <small>
                {baseline.regions
                  .slice(0, 3)
                  .map((item) => item.name)
                  .join(" · ") || "尚无空间节点"}
              </small>
            </span>
            <em>相邻 {scenario.scope.adjacencyDepth} 层</em>
          </div>
          <div className="ws2-scope-summary">
            <Users />
            <span>
              <strong>
                {selectedActors ||
                  baseline.characters.length + baseline.factions.length}{" "}
                个重点主体
              </strong>
              <small>
                人物{" "}
                {scenario.scope.characterIds.length ||
                  baseline.characters.length}{" "}
                · 势力{" "}
                {scenario.scope.factionIds.length || baseline.factions.length}
              </small>
            </span>
            <em>
              {scenario.scope.autoIncludeCounterparts
                ? "自动包含对手"
                : "仅选定主体"}
            </em>
          </div>
          <details className="ws2-scope-picker">
            <summary>
              <Settings2 />
              调整地域与主体
            </summary>
            <div className="ws2-scope-policies">
              <label>
                <input
                  type="checkbox"
                  checked={scenario.scope.includeDescendants}
                  onChange={(event) =>
                    patch({
                      scope: {
                        ...scenario.scope,
                        includeDescendants: event.target.checked,
                      },
                    })
                  }
                />
                包含所有子地域
              </label>
              <label>
                相邻深度
                <input
                  type="number"
                  min={0}
                  max={8}
                  value={scenario.scope.adjacencyDepth}
                  onChange={(event) =>
                    patch({
                      scope: {
                        ...scenario.scope,
                        adjacencyDepth: Math.max(
                          0,
                          Math.min(8, Number(event.target.value) || 0),
                        ),
                      },
                    })
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={scenario.scope.autoIncludeCounterparts}
                  onChange={(event) =>
                    patch({
                      scope: {
                        ...scenario.scope,
                        autoIncludeCounterparts: event.target.checked,
                      },
                    })
                  }
                />
                自动纳入相关对手
              </label>
              <label>
                范围外策略
                <CustomSelect
                  value={scenario.scope.outsidePolicy}
                  options={[
                    { value: "ignore", label: "忽略" },
                    { value: "respond", label: "只响应目标区域" },
                    { value: "approximate", label: "统计近似" },
                    { value: "full", label: "完整展开" },
                  ]}
                  onChange={(value) =>
                    patch({
                      scope: {
                        ...scenario.scope,
                        outsidePolicy:
                          value as WorldSimulationScenario["scope"]["outsidePolicy"],
                      },
                    })
                  }
                  ariaLabel="范围外策略"
                />
              </label>
            </div>
            <div className="ws2-picker-columns">
              <fieldset>
                <legend>地域</legend>
                {baseline.regions.map((region) => (
                  <label key={region.id}>
                    <input
                      type="checkbox"
                      checked={scenario.scope.regionIds.includes(region.id)}
                      onChange={() => {
                        const exists = scenario.scope.regionIds.includes(
                          region.id,
                        );
                        patch({
                          scope: {
                            ...scenario.scope,
                            regionIds: exists
                              ? scenario.scope.regionIds.filter(
                                  (id) => id !== region.id,
                                )
                              : [...scenario.scope.regionIds, region.id],
                          },
                        });
                      }}
                    />
                    {region.name}
                    <small>{region.type}</small>
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>人物</legend>
                {baseline.characters.map((character) => (
                  <label key={character.id}>
                    <input
                      type="checkbox"
                      checked={scenario.scope.characterIds.includes(
                        character.id,
                      )}
                      onChange={() => {
                        const exists = scenario.scope.characterIds.includes(
                          character.id,
                        );
                        patch({
                          scope: {
                            ...scenario.scope,
                            characterIds: exists
                              ? scenario.scope.characterIds.filter(
                                  (id) => id !== character.id,
                                )
                              : [...scenario.scope.characterIds, character.id],
                          },
                        });
                      }}
                    />
                    {character.name}
                    <small>
                      {character.cultivation.levelName || character.status}
                    </small>
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>势力</legend>
                {baseline.factions.map((faction) => (
                  <label key={faction.id}>
                    <input
                      type="checkbox"
                      checked={scenario.scope.factionIds.includes(faction.id)}
                      onChange={() => {
                        const exists = scenario.scope.factionIds.includes(
                          faction.id,
                        );
                        patch({
                          scope: {
                            ...scenario.scope,
                            factionIds: exists
                              ? scenario.scope.factionIds.filter(
                                  (id) => id !== faction.id,
                                )
                              : [...scenario.scope.factionIds, faction.id],
                          },
                        });
                      }}
                    />
                    {faction.name}
                    <small>{faction.status}</small>
                  </label>
                ))}
              </fieldset>
            </div>
          </details>
        </section>
      </div>

      <section
        className={`ws2-readiness ${blocking.length ? "has-errors" : ""}`}
      >
        {blocking.length ? <AlertTriangle /> : <ShieldCheck />}
        <div>
          <strong>{blocking.length ? "启动检查未通过" : "启动检查通过"}</strong>
          <small>
            {blocking.length
              ? blocking.map((item) => item.title).join(" · ")
              : `事实锚点明确 · 历法可换算 · ${baseline.rules.length} 条规则参与裁定 · ${baseline.sourceRefs.length} 个来源已锁定`}
          </small>
          {(blocking.length > 0 || actionableWarnings.length > 0) && (
            <ul className="ws2-readiness-details">
              {[...blocking, ...actionableWarnings].slice(0, 4).map((item) => (
                <li key={item.id}>
                  <strong>{item.title}</strong>
                  <span>{item.detail}</span>
                  <DiagnosticGuidance
                    diagnostic={item}
                    scenario={scenario}
                    baseline={baseline}
                    onApplyFix={onApplyFix}
                    onOpenSetup={onOpenSetup}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
        <button type="button" onClick={onRebuild} disabled={busy}>
          <RotateCcw />
          重新检查
        </button>
      </section>
    </main>
  );
}

type LabMode = "timeline" | "space" | "changes";

const LAB_MODE_ITEMS: readonly {
  readonly id: LabMode;
  readonly label: string;
  readonly icon: typeof Clock3;
}[] = [
  { id: "timeline", label: "时间流", icon: Clock3 },
  { id: "space", label: "空间传播", icon: Globe2 },
  { id: "changes", label: "状态变化", icon: Scale },
];

function eventColor(kind: SimulationEvent["kind"]): string {
  if (kind === "conflict") return "var(--error)";
  if (kind === "character-action" || kind === "cultivation")
    return "var(--info)";
  if (kind === "faction-strategy" || kind === "diplomacy")
    return "var(--warning)";
  if (kind === "propagation") return "var(--accent-cool)";
  return "var(--success)";
}

function commandLabel(command: WorldDomainCommand): string {
  switch (command.type) {
    case "character.intent":
      return `${command.characterId}：${command.intent}`;
    case "character.move":
      return `${command.characterId}：${command.fromRegionId ?? "未知"} → ${command.toRegionId}（${command.arrivalSortKey}抵达）`;
    case "character.arrive":
      return `${command.characterId}：抵达 ${command.toRegionId}`;
    case "character.cultivate":
      return `${command.characterId}：修行 ${command.progressDelta > 0 ? "+" : ""}${command.progressDelta}`;
    case "character.life":
      return `${command.characterId}：${command.status}`;
    case "character.knowledge":
      return `${command.characterId}：获知 ${command.knowledgeId}`;
    case "faction.strategy":
      return `${command.factionId}：${command.strategy}`;
    case "faction.metric":
      return `${command.factionId}.${command.metric} ${command.delta > 0 ? "+" : ""}${command.delta}`;
    case "region.metric":
      return `${command.regionId}.${command.metric} ${command.delta > 0 ? "+" : ""}${command.delta}`;
    case "region.control":
      return `${command.regionId}：控制权 → ${command.factionIds.join("、")}`;
    case "item.transfer":
      return `${command.itemId}：归属 → ${command.ownerId ?? "无主"}`;
    case "effect.schedule":
      return `传播：${command.effect.originRegionId} → ${command.effect.targetRegionId}（${command.effect.dueSortKey}抵达）`;
    case "effect.consume":
      return `传播影响 ${command.effectId}：已抵达并生效`;
  }
}

function LabEventInspector({
  event,
  baseline,
  adoptionAuthority,
  onAdoptionAuthorityChange,
  onFork,
  onCreateAdoption,
}: {
  readonly event: SimulationEvent | null;
  readonly baseline: WorldSimulationBaseline;
  readonly adoptionAuthority: SimulationAdoptionAuthority;
  readonly onAdoptionAuthorityChange: (
    authority: SimulationAdoptionAuthority,
  ) => void;
  readonly onFork: (eventId: string) => void;
  readonly onCreateAdoption: (
    eventId: string,
    authority: SimulationAdoptionAuthority,
  ) => void;
}) {
  if (!event)
    return (
      <aside className="ws2-inspector ws2-inspector-empty">
        <Network />
        <strong>选择一个事件</strong>
        <p>查看触发条件、证据、领域命令和后续传播。</p>
      </aside>
    );
  return (
    <aside className="ws2-inspector">
      <div className="ws2-inspector-heading">
        <span>事件检查器</span>
        <em style={{ color: eventColor(event.kind) }}>
          {EVENT_KIND_LABELS[event.kind]}
        </em>
      </div>
      <h3>{event.title}</h3>
      <div className="ws2-event-tags">
        <span>{event.time.displayText}</span>
        {event.regionIds.map((id) => (
          <span key={id}>
            {baseline.regions.find((item) => item.id === id)?.name ?? id}
          </span>
        ))}
      </div>
      <section>
        <h4>为什么发生</h4>
        <p>{event.summary}</p>
      </section>
      <section>
        <h4>证据链</h4>
        {event.evidence.map((evidence, index) => (
          <div className="ws2-evidence" key={`${evidence.type}-${index}`}>
            <i className={`is-${evidence.authority}`} />
            <span>
              <strong>{evidence.label}</strong>
              <small>{evidence.detail}</small>
            </span>
            <em>{evidence.authority}</em>
          </div>
        ))}
      </section>
      <section>
        <h4>状态提交</h4>
        {event.commands.map((command, index) => (
          <div className="ws2-command" key={`${command.type}-${index}`}>
            <ArrowRight />
            <span>{commandLabel(command)}</span>
          </div>
        ))}
      </section>
      <section>
        <h4>后续影响</h4>
        <p>
          {event.causeEventIds.length
            ? `承接 ${event.causeEventIds.join("、")}，并可能成为后续地域或主体事件的前因。`
            : "这是当前分支的新因果起点。"}
        </p>
      </section>
      <button
        type="button"
        className="ws2-button ws2-full-button"
        onClick={() => onFork(event.id)}
      >
        <GitFork />
        从这里创建分支
      </button>
      <div className="ws2-adoption-action">
        <label>
          采纳语义
          <CustomSelect
            value={adoptionAuthority}
            options={[
              { value: "planned", label: "保存为未来计划" },
              { value: "author-secret", label: "保存为作者秘密" },
              { value: "actual", label: "保存为已确认事实" },
            ]}
            onChange={(value) =>
              onAdoptionAuthorityChange(value as SimulationAdoptionAuthority)
            }
            ariaLabel="采纳语义"
          />
        </label>
        <button
          type="button"
          className="ws2-button ws2-full-button"
          onClick={() => onCreateAdoption(event.id, adoptionAuthority)}
        >
          <BookOpenCheck />
          生成采纳提案
        </button>
      </div>
    </aside>
  );
}

function TimelineLab({
  branch,
  baseline,
  selectedEventId,
  selectedRegionId,
  observationScale,
  onSelectEvent,
}: {
  readonly branch: SimulationBranch;
  readonly baseline: WorldSimulationBaseline;
  readonly selectedEventId: string | null;
  readonly selectedRegionId: string | null;
  readonly observationScale: TimeScale | "all";
  readonly onSelectEvent: (id: string) => void;
}) {
  const start = baseline.anchor.sortKey;
  const end = branch.state.currentTime.sortKey;
  const relevantObservations = branch.observations.filter(
    (item) =>
      !selectedRegionId || item.dominantRegionIds.includes(selectedRegionId),
  );
  const relevantEvents = branch.ledger.filter(
    (item) =>
      (!selectedRegionId || item.regionIds.includes(selectedRegionId)) &&
      (observationScale === "all" || item.scale === observationScale),
  );
  const rulerTicks = [0n, 1n, 2n, 3n, 4n].map(
    (index) =>
      createWorldInstant(
        (
          BigInt(start) +
          ((BigInt(end) - BigInt(start)) * index) / 4n
        ).toString(),
        baseline.calendar,
      ).displayText,
  );
  const lanes: readonly {
    readonly id: string;
    readonly title: string;
    readonly subtitle: string;
    readonly kinds: readonly SimulationEvent["kind"][];
  }[] = [
    {
      id: "characters",
      title: "人物行动",
      subtitle: "日 / 月",
      kinds: ["character-action", "cultivation", "lifecycle"],
    },
    {
      id: "factions",
      title: "势力博弈",
      subtitle: "年 / 百年",
      kinds: ["faction-strategy", "conflict", "diplomacy"],
    },
    {
      id: "world",
      title: "世界过程",
      subtitle: "传播 / 纪元",
      kinds: ["propagation", "world-process", "epoch"],
    },
  ];
  return (
    <div className="ws2-timeline-lab">
      <header>
        <span>统一世界时间</span>
        <strong>
          {baseline.anchor.displayText} 到{" "}
          {branch.state.currentTime.displayText}
        </strong>
        <small>
          已验证 {relevantEvents.length} 个事件 · {relevantObservations.length}{" "}
          个观察节点
        </small>
      </header>
      <div className="ws2-time-ruler">
        {rulerTicks.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div className="ws2-time-lanes">
        {lanes.map((lane) => {
          const laneEvents = relevantEvents.filter((event) =>
            lane.kinds.includes(event.kind),
          );
          return (
            <div className="ws2-time-lane" key={lane.id}>
              <label>
                {lane.title}
                <small>
                  {lane.subtitle} · {laneEvents.length} 件
                </small>
              </label>
              <div>
                {laneEvents.map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    className={event.id === selectedEventId ? "is-active" : ""}
                    style={{
                      left: `${Math.min(97, Math.max(0, progressRatio(start, end, event.time.sortKey) * 100))}%`,
                      borderColor: eventColor(event.kind),
                    }}
                    title={`${event.time.displayText} · ${event.title}`}
                    aria-label={`${event.time.displayText} · ${event.title}`}
                    onClick={() => onSelectEvent(event.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {relevantEvents.length > 0 ? (
        <>
          <div className="ws2-causal-strip">
            {relevantEvents.slice(-6).map((event, index) => (
              <button
                key={event.id}
                type="button"
                className={event.id === selectedEventId ? "is-active" : ""}
                onClick={() => onSelectEvent(event.id)}
              >
                <small>{String(index + 1).padStart(2, "0")}</small>
                <strong>{event.title}</strong>
                <span>{event.time.displayText}</span>
                {index < Math.min(5, relevantEvents.slice(-6).length - 1) && (
                  <ArrowRight />
                )}
              </button>
            ))}
          </div>
          <div className="ws2-event-table">
            {relevantEvents
              .slice()
              .reverse()
              .map((event) => (
                <button
                  key={event.id}
                  type="button"
                  className={event.id === selectedEventId ? "is-active" : ""}
                  onClick={() => onSelectEvent(event.id)}
                >
                  <time>{event.time.displayText}</time>
                  <em style={{ color: eventColor(event.kind) }}>
                    {EVENT_KIND_LABELS[event.kind]}
                  </em>
                  <strong>{event.title}</strong>
                  <span>
                    {event.commands.length} 项状态提交 ·{" "}
                    {event.causeEventIds.length} 个前因
                  </span>
                  <ChevronRight />
                </button>
              ))}
          </div>
        </>
      ) : (
        <div className="ws2-timeline-empty">
          <CirclePause />
          <strong>这段时间没有可验证事件</strong>
          <p>
            内核只会记录有事实、规则、可达路径或已验证主体命令支撑的状态变化。请回到运行控制台补齐主体与触发条件，或使用已配置的模型场景生成候选。
          </p>
        </div>
      )}
    </div>
  );
}

function spatialGraph(
  baseline: WorldSimulationBaseline,
  branch: SimulationBranch,
): { nodes: Node[]; edges: Edge[] } {
  const pendingByRegion = new Map<string, number>();
  branch.state.scheduledEffects.forEach((effect) => {
    pendingByRegion.set(
      effect.targetRegionId,
      (pendingByRegion.get(effect.targetRegionId) ?? 0) + 1,
    );
  });
  const travellersByRegion = new Map<string, string[]>();
  branch.state.characters.forEach((character) => {
    if (!character.travel) return;
    travellersByRegion.set(character.travel.toRegionId, [
      ...(travellersByRegion.get(character.travel.toRegionId) ?? []),
      baseline.characters.find((item) => item.id === character.id)?.name ??
        character.id,
    ]);
  });
  const nodes: Node[] = baseline.regions.map((region, index) => {
    const state = branch.state.regions.find((item) => item.id === region.id);
    const depth = region.parentId ? 1 : 0;
    const pending = pendingByRegion.get(region.id) ?? 0;
    const travellers = travellersByRegion.get(region.id) ?? [];
    return {
      id: region.id,
      position: {
        x: depth * 300 + (index % 3) * 230,
        y: Math.floor(index / 3) * 150 + depth * 40,
      },
      data: {
        label: (
          <div className="ws2-region-node">
            <strong>{region.name}</strong>
            <small>
              {region.type} · 压力 {Math.round(state?.pressure ?? 0)}
            </small>
            <span>
              <i style={{ width: `${state?.stability ?? 0}%` }} />
            </span>
            {travellers.length > 0 && <em>旅行中 {travellers.length} 人</em>}
            {pending > 0 && <em>待抵达影响 {pending} 项</em>}
          </div>
        ),
      },
      style: {
        borderColor:
          (state?.pressure ?? 0) > 60 ? "var(--error)" : "var(--line-strong)",
        background: "var(--panel)",
        color: "var(--ink)",
        width: 190,
        borderRadius: 4,
      },
    };
  });
  const connections = new Map<string, SpatialConnectionLike>();
  baseline.regions
    .flatMap((region) => region.connections)
    .forEach((connection) => connections.set(connection.id, connection));
  const edges: Edge[] = [...connections.values()].map((connection) => ({
    id: connection.id,
    source: connection.fromRegionId,
    target: connection.toRegionId,
    label: connection.kind,
    animated: connection.kind === "information" || connection.kind === "trade",
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: "var(--ink-subtle)" },
    labelStyle: { fill: "var(--ink-muted)", fontSize: 10 },
  }));
  branch.state.scheduledEffects.forEach((effect) => {
    edges.push({
      id: `scheduled-${effect.id}`,
      source: effect.originRegionId,
      target: effect.targetRegionId,
      label: `传播中 · ${effect.dueSortKey}`,
      animated: true,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: {
        stroke: "var(--accent-warm)",
        strokeDasharray: "5 4",
        strokeWidth: 2,
      },
      labelStyle: { fill: "var(--accent-warm)", fontSize: 10 },
    });
  });
  branch.state.characters.forEach((character) => {
    if (!character.travel || !character.locationId) return;
    edges.push({
      id: `travelling-${character.id}-${character.travel.arrivalSortKey}`,
      source: character.locationId,
      target: character.travel.toRegionId,
      label: `${baseline.characters.find((item) => item.id === character.id)?.name ?? character.id} · ${character.travel.arrivalSortKey}抵达`,
      animated: true,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: "var(--info)", strokeDasharray: "3 3" },
      labelStyle: { fill: "var(--info)", fontSize: 10 },
    });
  });
  return { nodes, edges };
}

type SpatialConnectionLike =
  WorldSimulationBaseline["regions"][number]["connections"][number];

function ChangesLab({ branch }: { readonly branch: SimulationBranch }) {
  const changes = branch.ledger
    .slice()
    .reverse()
    .flatMap((event) =>
      event.commands.map((command, index) => ({ event, command, index })),
    );
  if (changes.length === 0) {
    return (
      <div className="ws2-empty">
        <Scale />
        <strong>尚未提交状态变化</strong>
        <p>
          这里不会显示“静默期间”的猜测值。只有通过规则或主体命令校验的实际状态变化才会记录。
        </p>
      </div>
    );
  }
  return (
    <div className="ws2-changes-table">
      <header>
        <span>时间</span>
        <span>事件</span>
        <span>领域命令</span>
        <span>来源</span>
      </header>
      {changes.map(({ event, command, index }) => (
        <div key={`${event.id}-${index}`}>
          <time>{event.time.displayText}</time>
          <strong>{event.title}</strong>
          <code>{commandLabel(command)}</code>
          <em>{event.generatedBy}</em>
        </div>
      ))}
    </div>
  );
}

function LabView({
  run,
  branch,
  baseline,
  onFork,
  onSwitchBranch,
  onCreateNaturalComparison,
  onGenerateReport,
  onCreateAdoption,
  onNavigateCouncil,
}: {
  readonly run: NonNullable<
    ReturnType<typeof useWorldSimulationController>["run"]
  >;
  readonly branch: SimulationBranch;
  readonly baseline: WorldSimulationBaseline;
  readonly onFork: (id: string) => void;
  readonly onSwitchBranch: (id: string) => void;
  readonly onCreateNaturalComparison: () => void;
  readonly onGenerateReport: () => void;
  readonly onCreateAdoption: (
    eventId: string,
    authority: SimulationAdoptionAuthority,
  ) => void;
  readonly onNavigateCouncil: () => void;
}) {
  const [mode, setMode] = useState<LabMode>("timeline");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(
    branch.ledger.at(-1)?.id ?? null,
  );
  const [adoptionAuthority, setAdoptionAuthority] =
    useState<SimulationAdoptionAuthority>("planned");
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [observationScale, setObservationScale] = useState<TimeScale | "all">(
    "all",
  );
  const resolvedSelectedEventId = branch.ledger.some(
    (event) => event.id === selectedEventId,
  )
    ? selectedEventId
    : (branch.ledger.at(-1)?.id ?? null);
  const resolvedComparisonBranchId =
    run.branches.find((item) => item.id !== branch.id)?.id ?? "";
  const selectedEvent =
    branch.ledger.find((event) => event.id === resolvedSelectedEventId) ??
    branch.ledger.at(-1) ??
    null;
  const spatial = useMemo(
    () => spatialGraph(baseline, branch),
    [baseline, branch],
  );
  const comparison = resolvedComparisonBranchId
    ? compareSimulationBranches(run, branch.id, resolvedComparisonBranchId)
    : null;
  const report =
    run.reports.filter((item) => item.branchId === branch.id).at(-1) ?? null;
  const selectEvent = (eventId: string) => {
    setSelectedEventId(eventId);
    const event = branch.ledger.find((item) => item.id === eventId);
    if (event?.regionIds[0]) setSelectedRegionId(event.regionIds[0]);
  };
  return (
    <main className="ws2-main ws2-lab">
      <div className="ws2-page-title">
        <div>
          <small>WORLD LABORATORY</small>
          <h2>看见世界怎样变成现在这样</h2>
          <p>时间轴、空间传播、状态提交和因果链共享同一个运行分支。</p>
        </div>
        <div className="ws2-title-actions">
          <CustomSelect
            value={branch.id}
            options={run.branches.map((item) => ({
              value: item.id,
              label: `${item.name} · ${item.narrativePolicy === "disabled" ? "自然" : "剧情"}`,
            }))}
            onChange={onSwitchBranch}
            ariaLabel="选择推演分支"
          />
          <button
            type="button"
            className="ws2-button"
            onClick={onCreateNaturalComparison}
          >
            <GitCompareArrows />
            自然对照
          </button>
          <button
            type="button"
            className="ws2-button"
            onClick={onGenerateReport}
          >
            <FileText />
            生成报告
          </button>
          <button
            type="button"
            className="ws2-button"
            onClick={onNavigateCouncil}
          >
            <BrainCircuit />
            让各方会商
          </button>
        </div>
      </div>
      <div className="ws2-lab-tabs">
        {LAB_MODE_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={mode === item.id ? "is-active" : ""}
              onClick={() => setMode(item.id)}
            >
              <Icon className="ws2-tab-icon" />
              {item.label}
            </button>
          );
        })}
      </div>
      <div className="ws2-lab-controls">
        <span>观察尺度</span>
        <CustomSelect
          value={observationScale}
          options={[
            { value: "all", label: "全部尺度" },
            ...SCALE_ORDER.filter((scale) =>
              branch.observations.some((item) => item.scale === scale),
            ).map((scale) => ({
              value: scale,
              label: TIME_SCALE_LABELS[scale],
            })),
          ]}
          onChange={(value) => setObservationScale(value as TimeScale | "all")}
          ariaLabel="观察尺度"
        />
        {selectedRegionId && (
          <button type="button" onClick={() => setSelectedRegionId(null)}>
            清除地域筛选：
            {baseline.regions.find((item) => item.id === selectedRegionId)
              ?.name ?? selectedRegionId}
          </button>
        )}
      </div>
      {(comparison || report) && (
        <section className="ws2-lab-summary">
          {comparison && (
            <div>
              <strong>分支比较</strong>
              <p>
                {comparison.firstDivergence?.summary ??
                  "两个分支尚未产生可见分歧。"}
              </p>
              <small>{comparison.narrativeDifference}</small>
              {comparison.stateDifferences.slice(0, 3).map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          )}
          {report && (
            <div>
              <strong>{report.title}</strong>
              <p>{report.summary}</p>
              <small>
                {report.generatedBy === "fallback"
                  ? "确定性报告"
                  : "模型增强报告"}{" "}
                · {report.sections.length} 个分析章节
              </small>
            </div>
          )}
        </section>
      )}
      <div className="ws2-lab-layout">
        <section className="ws2-lab-canvas">
          {mode === "timeline" ? (
            <TimelineLab
              branch={branch}
              baseline={baseline}
              selectedEventId={resolvedSelectedEventId}
              selectedRegionId={selectedRegionId}
              observationScale={observationScale}
              onSelectEvent={selectEvent}
            />
          ) : mode === "space" ? (
            spatial.nodes.length > 0 ? (
              <ReactFlow
                nodes={spatial.nodes}
                edges={spatial.edges}
                fitView
                minZoom={0.25}
                maxZoom={1.8}
                onNodeClick={(_, node) => setSelectedRegionId(node.id)}
              >
                <Background gap={24} size={1} />
                <Controls showInteractive={false} />
              </ReactFlow>
            ) : (
              <div className="ws2-empty">
                <Globe2 />
                <strong>尚无可推演地域</strong>
                <p>
                  请先在世界架构中建立空间节点，并为地域补充可引用的地点与连接。
                </p>
              </div>
            )
          ) : (
            <ChangesLab branch={branch} />
          )}
        </section>
        <LabEventInspector
          event={selectedEvent}
          baseline={baseline}
          adoptionAuthority={adoptionAuthority}
          onAdoptionAuthorityChange={setAdoptionAuthority}
          onFork={onFork}
          onCreateAdoption={onCreateAdoption}
        />
      </div>
    </main>
  );
}

function participantName(
  baseline: WorldSimulationBaseline,
  type: "character" | "faction",
  id: string,
): string {
  return type === "character"
    ? (baseline.characters.find((item) => item.id === id)?.name ?? id)
    : (baseline.factions.find((item) => item.id === id)?.name ?? id);
}

function knownFactLabel(
  baseline: WorldSimulationBaseline,
  participantType: CouncilStance["participantType"],
  id: string,
): string {
  if (participantType === "character") {
    const knowledge = baseline.characters
      .flatMap((character) => character.knowledge)
      .find((item) => item.id === id);
    if (knowledge) return knowledge.statement;
  }
  return baseline.timelineFacts.find((event) => event.id === id)?.title ?? id;
}

function CouncilView({
  branch,
  baseline,
  sessions,
  onCreate,
  onSelect,
  onCommit,
}: {
  readonly branch: SimulationBranch;
  readonly baseline: WorldSimulationBaseline;
  readonly sessions: readonly CouncilSession[];
  readonly onCreate: (eventId: string | null, question: string) => void;
  readonly onSelect: (sessionId: string, optionId: string) => void;
  readonly onCommit: (sessionId: string, optionId: string) => void;
}) {
  const latest =
    sessions.filter((session) => session.branchId === branch.id).at(-1) ?? null;
  const [question, setQuestion] =
    useState("各方在当前局势下会如何选择下一步？");
  const [activeParticipant, setActiveParticipant] = useState(0);
  const [eventId, setEventId] = useState<string>(
    branch.ledger.at(-1)?.id ?? "",
  );
  const hasParticipants = branch.ledger.at(-1)
    ? branch.ledger.at(-1)!.characterIds.length +
        branch.ledger.at(-1)!.factionIds.length >
      0
    : branch.state.characters.some(
        (character) => character.alive && Boolean(character.locationId),
      ) || branch.state.factions.length > 0;
  const stance =
    latest?.stances[activeParticipant] ?? latest?.stances[0] ?? null;
  const selectedOption =
    latest?.options.find((option) => option.id === latest.selectedOptionId) ??
    null;
  return (
    <main className="ws2-main ws2-council">
      <div className="ws2-page-title">
        <div>
          <small>STANCE COUNCIL</small>
          <h2>让各方先说出自己的打算</h2>
          <p>会商只读取主体各自的知识、目标和资源，结论仍是推演候选。</p>
        </div>
        <span className="ws2-authority-lock">
          <ShieldCheck />
          不会直接改变世界
        </span>
      </div>
      {!latest ? (
        <section className="ws2-council-create">
          <div>
            <BrainCircuit />
            <h3>建立一次局势会商</h3>
            <p>
              选择一个已发生的推演事件作为讨论背景，系统会为参与人物和势力生成受知识边界约束的立场。
            </p>
          </div>
          <label>
            讨论事件
            <CustomSelect
              value={eventId}
              options={[
                { value: "", label: "当前世界状态" },
                ...branch.ledger
                  .slice()
                  .reverse()
                  .map((event) => ({
                    value: event.id,
                    label: `${event.time.displayText} · ${event.title}`,
                  })),
              ]}
              onChange={setEventId}
              ariaLabel="讨论事件"
            />
          </label>
          <label>
            会商问题
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>
          {!hasParticipants && (
            <p className="ws2-data-warning">
              <AlertTriangle />
              当前事实锚点没有可会商的人物或势力。先在运行控制台补齐主体和地点，才能生成有依据的立场。
            </p>
          )}
          <button
            type="button"
            className="ws2-button is-primary"
            disabled={!hasParticipants}
            onClick={() => onCreate(eventId || null, question)}
          >
            <Sparkles />
            生成各方立场
          </button>
        </section>
      ) : (
        <div className="ws2-council-layout">
          <aside className="ws2-participants">
            <div className="ws2-section-caption">
              <span>参与方</span>
              <small>{latest.stances.length} 方</small>
            </div>
            {latest.stances.map((item, index) => (
              <button
                key={`${item.participantType}-${item.participantId}`}
                type="button"
                className={index === activeParticipant ? "is-active" : ""}
                onClick={() => setActiveParticipant(index)}
              >
                <b>
                  {participantName(
                    baseline,
                    item.participantType,
                    item.participantId,
                  ).slice(0, 1)}
                </b>
                <span>
                  <strong>
                    {participantName(
                      baseline,
                      item.participantType,
                      item.participantId,
                    )}
                  </strong>
                  <small>目标：{item.goal}</small>
                </span>
                <ChevronRight />
              </button>
            ))}
            <p>
              <ShieldCheck />
              每方只看到自己的知识投影
            </p>
          </aside>
          <section className="ws2-stance-panel">
            <div className="ws2-council-context">
              <span>{branch.state.currentTime.displayText}</span>
              <span>
                {latest.eventId
                  ? branch.ledger.find((event) => event.id === latest.eventId)
                      ?.title
                  : "当前世界状态"}
              </span>
              <em>事实隔离已启用</em>
            </div>
            {stance ? (
              <>
                <div className="ws2-current-stance">
                  <b>
                    {participantName(
                      baseline,
                      stance.participantType,
                      stance.participantId,
                    ).slice(0, 1)}
                  </b>
                  <div>
                    <small>当前立场</small>
                    <h3>{stance.position}</h3>
                    <p>{stance.goal}</p>
                  </div>
                </div>
                <div className="ws2-stance-knowledge">
                  <section>
                    <h4>已知事实</h4>
                    {stance.knownFactIds.length ? (
                      stance.knownFactIds.map((id) => (
                        <p key={id}>
                          •{" "}
                          {knownFactLabel(baseline, stance.participantType, id)}
                        </p>
                      ))
                    ) : (
                      <p>• 仅掌握公开局势与自身信息</p>
                    )}
                  </section>
                  <section>
                    <h4>底线与风险</h4>
                    {stance.risks.length ? (
                      stance.risks.map((risk) => <p key={risk}>• {risk}</p>)
                    ) : (
                      <p>• 不接受无成本、瞬移或全知决策</p>
                    )}
                  </section>
                </div>
              </>
            ) : (
              <div className="ws2-empty">
                <Users />
                <strong>当前事件没有可会商主体</strong>
              </div>
            )}
            <div className="ws2-option-heading">
              <div>
                <small>候选方案</small>
                <h3>各方准备怎么做</h3>
              </div>
              <button
                type="button"
                onClick={() => onCreate(eventId || null, question)}
              >
                <RefreshCw />
                重新生成
              </button>
            </div>
            <div className="ws2-options">
              {latest.options.length > 0 ? (
                latest.options.map((option, index) => (
                  <button
                    key={option.id}
                    type="button"
                    className={
                      option.id === latest.selectedOptionId ? "is-active" : ""
                    }
                    onClick={() => onSelect(latest.id, option.id)}
                  >
                    <b>{String.fromCharCode(65 + index)}</b>
                    <span>
                      <strong>{option.title}</strong>
                      <small>{option.summary}</small>
                    </span>
                    <em>{option.score}</em>
                    <ChevronRight />
                  </button>
                ))
              ) : (
                <div className="ws2-empty ws2-council-empty">
                  <Scale />
                  <strong>没有可执行候选方案</strong>
                  <p>
                    当前会商只读到了局势，没有通过状态校验的命令。补充主体目标、关系或资源后重新生成。
                  </p>
                </div>
              )}
            </div>
          </section>
          <aside className="ws2-option-review">
            <div className="ws2-section-caption">
              <span>方案审阅</span>
              {selectedOption && <b>{selectedOption.score}</b>}
            </div>
            {selectedOption ? (
              <>
                <h3>{selectedOption.title}</h3>
                <section>
                  <h4>会改变什么</h4>
                  {selectedOption.commands.map((command, index) => (
                    <p key={`${command.type}-${index}`}>
                      {commandLabel(command)}
                    </p>
                  ))}
                </section>
                <section>
                  <h4>前置条件</h4>
                  <p>
                    <ShieldCheck />
                    主体、地点与状态命令已由确定性内核预校验。
                  </p>
                  <p>
                    <ShieldCheck />
                    创建后只在新的会商干预分支生效。
                  </p>
                </section>
                <section>
                  <h4>收益</h4>
                  {selectedOption.benefits.map((item) => (
                    <p key={item}>
                      <Check />
                      {item}
                    </p>
                  ))}
                </section>
                <section>
                  <h4>成本</h4>
                  {selectedOption.costs.map((item) => (
                    <p key={item}>
                      <AlertTriangle />
                      {item}
                    </p>
                  ))}
                </section>
                <div className="ws2-policy-note">
                  <ShieldCheck />
                  <span>
                    <strong>仍是候选</strong>
                    <small>
                      确认后会创建新的干预分支，既有分支和正式事实都不会被改写。
                    </small>
                  </span>
                </div>
                <button
                  type="button"
                  className="ws2-button is-primary ws2-full-button"
                  onClick={() => onCommit(latest.id, selectedOption.id)}
                >
                  <GitFork />
                  创建干预分支
                </button>
              </>
            ) : (
              <div className="ws2-empty">
                <Scale />
                <strong>选择一个方案</strong>
                <p>查看它会提交哪些领域命令，以及对应成本与收益。</p>
              </div>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}

export default function WorldSimulationWorkbench({
  storage,
  isActive,
  view,
  onNavigate,
  onOpenSetup,
  onRunModelScene,
  registerNavigationGuard,
}: WorldSimulationWorkbenchProps) {
  const controller = useWorldSimulationController({
    storage,
    isActive,
    onRunModelScene,
  });
  const baseline = controller.baseline;
  const branch = controller.branch;
  const [reviewOpen, setReviewOpen] = useState(false);
  if (!baseline) {
    return (
      <div className="ws2-loading">
        <Orbit className="ws2-spin" />
        <strong>正在编译世界投影</strong>
        <span>
          {controller.error ??
            "人物、势力、地域、修炼、物品、时间线与剧情工程正在对齐"}
        </span>
        <button
          type="button"
          onClick={() => void controller.refresh().catch(() => undefined)}
        >
          <RefreshCw />
          重试
        </button>
      </div>
    );
  }
  return (
    <div className="ws2-root">
      {registerNavigationGuard && (
        <NarrativeUnsavedChangesGuard
          dirty={controller.scenarioDirty}
          label="世界推演方案"
          registerNavigationGuard={registerNavigationGuard}
          onSave={async () => {
            try {
              await controller.saveScenario();
              return true;
            } catch {
              return false;
            }
          }}
        />
      )}
      <WorkflowHeader
        view={view}
        baseline={baseline}
        branch={branch}
        busy={controller.busy}
        onNavigate={onNavigate}
        onRefresh={() => void controller.refresh().catch(() => undefined)}
      />
      {(controller.error ||
        controller.modelWarning ||
        controller.sourceDriftWarning) && (
        <div className="ws2-alert" role="alert">
          <AlertTriangle />
          <span>
            {controller.error ??
              controller.modelWarning ??
              controller.sourceDriftWarning}
          </span>
        </div>
      )}
      <div className="ws2-body">
        <SimulationSidebar
          scenario={controller.scenario}
          scenarios={
            controller.scenarios?.value.scenarios ?? [controller.scenario]
          }
          baseline={baseline}
          runIndex={controller.runIndex?.value.runs ?? []}
          onSelectScenario={(id) =>
            void controller.selectScenario(id).catch(() => undefined)
          }
          onNewScenario={() =>
            void controller.newScenario().catch(() => undefined)
          }
          onSelectRun={(id) =>
            void controller.selectRun(id).catch(() => undefined)
          }
          onRemoveRun={(id) =>
            void controller.removeRun(id).catch(() => undefined)
          }
        />
        {view === "console" ? (
          <ConsoleView
            scenario={controller.scenario}
            baseline={baseline}
            branch={branch}
            busy={controller.busy}
            continuous={controller.continuous}
            onChange={controller.updateScenario}
            onApplyFix={controller.applyScenarioAndRebuild}
            onSave={() => void controller.saveScenario().catch(() => undefined)}
            onRebuild={() =>
              void controller.rebuildBaseline().catch(() => undefined)
            }
            onCreateRun={() =>
              void controller.createRun().catch(() => undefined)
            }
            onAdvance={() =>
              void controller.advanceOne().catch(() => undefined)
            }
            onContinuous={controller.setContinuous}
            onRunToEnd={() => void controller.runToEnd().catch(() => undefined)}
            onCancel={() => void controller.cancelRun().catch(() => undefined)}
            onOpenSetup={onOpenSetup}
          />
        ) : !branch || !controller.run ? (
          <main className="ws2-main">
            <div className="ws2-empty ws2-empty-page">
              <Orbit />
              <strong>还没有运行分支</strong>
              <p>
                先在运行控制台锁定事实、时间、地域和剧情约束，再创建第一次推演。
              </p>
              <button
                type="button"
                className="ws2-button is-primary"
                onClick={() => onNavigate("console")}
              >
                <Settings2 />
                前往运行控制台
              </button>
            </div>
          </main>
        ) : view === "lab" ? (
          <LabView
            run={controller.run}
            branch={branch}
            baseline={baseline}
            onFork={(id) => void controller.forkAt(id).catch(() => undefined)}
            onSwitchBranch={(id) =>
              void controller.switchBranch(id).catch(() => undefined)
            }
            onCreateNaturalComparison={() =>
              void controller.createNaturalComparison().catch(() => undefined)
            }
            onGenerateReport={() =>
              void controller.generateReport().catch(() => undefined)
            }
            onCreateAdoption={(eventId, authority) =>
              void controller
                .createAdoptionProposal([eventId], authority)
                .then(() => setReviewOpen(true))
                .catch(() => undefined)
            }
            onNavigateCouncil={() => onNavigate("council")}
          />
        ) : (
          <CouncilView
            branch={branch}
            baseline={baseline}
            sessions={controller.run.councilSessions}
            onCreate={(eventId, question) =>
              void controller
                .openCouncil(eventId, question)
                .catch(() => undefined)
            }
            onSelect={(sessionId, optionId) =>
              void controller
                .chooseCouncilOption(sessionId, optionId)
                .catch(() => undefined)
            }
            onCommit={(sessionId, optionId) =>
              void controller
                .commitCouncilOption(sessionId, optionId)
                .then(() => onNavigate("lab"))
                .catch(() => undefined)
            }
          />
        )}
      </div>
      {reviewOpen && (
        <WorldProposalReview
          storage={storage}
          projectTitle={baseline.projectTitle}
          onClose={() => setReviewOpen(false)}
          repositoryFactory={
            createWorldSimulationAdoptionFileProposalRepository
          }
          reviewTitle="世界推演采纳提案"
          proposalSubject="世界推演"
          onApplied={() => void controller.refresh().catch(() => undefined)}
        />
      )}
    </div>
  );
}
