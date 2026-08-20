import {
  AlertTriangle,
  ArrowRight,
  BookOpenCheck,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Clock3,
  FileText,
  GitFork,
  History,
  Lightbulb,
  MoreHorizontal,
  Orbit,
  RefreshCw,
  Scale,
  Settings2,
  ShieldCheck,
  Sparkles,
  StepForward,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { WorkbenchStorage } from "@/workbench-sdk";

import { createWorldSimulationAdoptionFileProposalRepository } from "./worldSimulationAdoptionV2";
import {
  compareSimulationBranches,
  getSimulationEndSortKey,
} from "./worldSimulationEngineV2";
import {
  type CouncilSession,
  type CouncilStance,
  type SimulationBranch,
  type SimulationEvent,
  type SimulationEventKind,
  type SimulationRunIndexEntry,
  type TimeScale,
  type WorldDomainCommand,
  type WorldSimulationBaseline,
  type WorldSimulationRun,
  type WorldSimulationScenario,
  type WorldRuntimeState,
} from "./worldSimulationV2Schema";
import {
  TIME_SCALE_LABELS,
  durationToDays,
  formatWorldInstant,
} from "./worldSimulationTime";
import {
  useWorldSimulationController,
  type WorldSimulationModelScene,
  type WorldSimulationProgress,
} from "./useWorldSimulationController";
import WorldProposalReview from "./WorldProposalReview";
import "./WorldSimulationWorkbench.css";

interface WorldSimulationWorkbenchProps {
  readonly storage: WorkbenchStorage;
  readonly isActive: boolean;
  readonly onRunModelScene?: (
    scene: WorldSimulationModelScene,
    prompt: string,
  ) => Promise<string>;
}

const DURATION_UNITS: readonly {
  value: WorldSimulationScenario["duration"]["unit"];
  label: string;
}[] = [
  { value: "day", label: "日" },
  { value: "ten-day", label: "十日" },
  { value: "month", label: "月" },
  { value: "quarter", label: "季度" },
  { value: "three-month", label: "三月" },
  { value: "year", label: "年" },
  { value: "century", label: "百年" },
  { value: "millennium", label: "千年" },
  { value: "ten-thousand-years", label: "万年" },
  { value: "hundred-billion-years", label: "千亿年" },
  { value: "trillion-years", label: "万亿年" },
  { value: "era", label: "纪元" },
];

const STATUS_LABELS: Readonly<Record<SimulationBranch["status"], string>> = {
  ready: "已就绪",
  running: "结算中",
  paused: "已暂停",
  completed: "已完成",
  cancelled: "已取消",
};

const PROGRESS_PHASE_LABELS: Readonly<
  Record<WorldSimulationProgress["phase"], string>
> = {
  preparing: "读取已锁定基线",
  actors: "裁定主体行动",
  arbitrating: "裁定世界变化",
  saving: "保存检查点",
};

type SettlementStepState = "completed" | "active" | "pending";

interface SettlementStep {
  readonly id: WorldSimulationProgress["phase"];
  readonly title: string;
  readonly detail: string;
  readonly state: SettlementStepState;
}

export function buildSettlementSteps(
  phase: WorldSimulationProgress["phase"],
): readonly SettlementStep[] {
  const steps: readonly Omit<SettlementStep, "state">[] = [
    {
      id: "preparing",
      title: "固定时间边界",
      detail: "读取锁定基线、周期规则与尚未生效的传播影响。",
    },
    {
      id: "actors",
      title: "推演主体行动",
      detail: "人物、势力和民间生活在各自知识与寿命边界内作出响应。",
    },
    {
      id: "arbitrating",
      title: "裁定世界变化",
      detail: "核验规则、资源、境界与冲突，合并本轮可接受结果。",
    },
    {
      id: "saving",
      title: "写入世界检查点",
      detail: "追加事件账本，冻结这一轮结束时的实体状态。",
    },
  ];
  const activeIndex = steps.findIndex((step) => step.id === phase);
  return steps.map((step, index) => ({
    ...step,
    state:
      index < activeIndex
        ? "completed"
        : index === activeIndex
          ? "active"
          : "pending",
  }));
}

const EVENT_KIND_LABELS: Readonly<Record<SimulationEventKind, string>> = {
  "character-action": "人物行动",
  "faction-strategy": "势力策略",
  conflict: "冲突与遭遇",
  diplomacy: "外交关系",
  cultivation: "修炼突破",
  lifecycle: "生命与存续",
  propagation: "影响传播",
  "world-process": "民间与地域",
  epoch: "纪元变化",
};

type StoryChoiceAction =
  | "observe"
  | "silence"
  | "council"
  | "guardrail"
  | "lead"
  | "fork";

interface StoryChoice {
  readonly action: StoryChoiceAction;
  readonly label: string;
  readonly description: string;
}

export function storyChoicesForEvent(
  event: SimulationEvent,
): readonly StoryChoice[] {
  switch (event.kind) {
    case "faction-strategy":
    case "diplomacy":
    case "conflict":
      return [
        { action: "observe", label: "旁观局势", description: "让相关势力按既有目标继续博弈，先看下一轮如何落地" },
        { action: "council", label: "发起会商", description: "召集相关人物与势力，先把立场、代价和可行行动摆上桌面" },
        { action: "guardrail", label: "准备反制", description: "从这个节点建立作者护栏，只影响新的干预分支" },
      ];
    case "character-action":
    case "lifecycle":
    case "cultivation":
      return [
        { action: "observe", label: "跟随行动", description: "不替人物做决定，让他在自己的知识、寿命和资源边界内继续生活" },
        { action: "lead", label: "投递线索", description: "给候选层增加一个可能方向，不能直接改写人物已知事实" },
        { action: "silence", label: "保持沉默", description: "不介入人物知识边界，让误判、犹豫和自然后果继续发生" },
      ];
    default:
      return [
        { action: "observe", label: "继续观测", description: "让周期规则、民间生活和世界过程自然推进一轮" },
        { action: "guardrail", label: "设置护栏", description: "为后续世界过程增加作者约束，原运行保持不变" },
        { action: "fork", label: "创建分支", description: "从这个时间点保存一条独立的后续历史" },
      ];
  }
}

function storyChoiceFeedback(action: StoryChoiceAction): string {
  switch (action) {
    case "observe":
      return "已选择继续推进：当前结果会保留，并按设置的时间跨度结算下一轮。";
    case "silence":
      return "已选择保持沉默：不改变人物知识边界，下一轮仍由其处境与世界规则裁定。";
    case "council":
      return "已打开会商：相关主体的立场会先汇总，确认后才进入新的候选分支。";
    case "guardrail":
      return "已打开护栏候选：填写并确认后才会建立新的干预分支。";
    case "lead":
      return "已打开线索候选：它只影响后续候选，不会直接成为既成事实。";
    case "fork":
      return "已选择创建分支：原运行保持不变，后续历史将在新分支中展开。";
  }
}

const OBSERVER_LABELS: Readonly<
  Record<WorldSimulationScenario["observer"]["kind"], string>
> = {
  ensemble: "多主体世界",
  character: "指定人物",
  faction: "指定势力",
  mortal: "普通凡人",
};

const EPOCH_STAGE_LABELS: Readonly<
  Record<WorldRuntimeState["epoch"]["stage"], string>
> = {
  regional: "地域时代",
  civilizational: "文明时代",
  "world-law": "世界法则时代",
  cosmic: "宇宙时代",
  terminal: "终末阶段",
};

const FACTION_LIFECYCLE_LABELS: Readonly<
  Record<SimulationBranch["state"]["factions"][number]["lifecycle"], string>
> = {
  rising: "崛起",
  expanding: "扩张",
  peak: "鼎盛",
  stagnating: "停滞",
  declining: "衰退",
  fragmented: "分裂",
  dissolved: "已解体",
};

function durationLabel(duration: WorldSimulationScenario["duration"]): string {
  return `${duration.amount}${DURATION_UNITS.find((unit) => unit.value === duration.unit)?.label ?? duration.unit}`;
}

function observerEntityOptions(
  baseline: WorldSimulationBaseline,
  kind: WorldSimulationScenario["observer"]["kind"],
): readonly { value: string; label: string }[] {
  if (kind === "faction")
    return baseline.factions.map((item) => ({ value: item.id, label: item.name }));
  if (kind === "character" || kind === "mortal")
    return baseline.characters.map((item) => ({ value: item.id, label: item.name }));
  return [];
}

function displayWorldSimulationError(error: string | null): string | null {
  if (!error) return null;
  if (error.includes("File changed externally")) {
    return "世界推演资料已在其他窗口或磁盘中更新，请重新载入后继续。";
  }
  return error;
}

function eventColor(kind: SimulationEventKind): string {
  if (kind === "conflict") return "var(--error)";
  if (kind === "lifecycle") return "var(--warning)";
  if (kind === "character-action" || kind === "cultivation")
    return "var(--info)";
  if (kind === "faction-strategy" || kind === "diplomacy")
    return "var(--accent-warm)";
  if (kind === "propagation") return "var(--accent-cool)";
  return "var(--success)";
}

function eventEvidenceLabel(event: SimulationEvent): string {
  const types = new Set(event.evidence.map((item) => item.type));
  if (types.has("world-rule")) return "规则命中";
  if (types.has("narrative-constraint")) return "剧情约束";
  if (types.has("spatial-path")) return "空间路径";
  if (types.has("fact")) return "事实依据";
  return "状态裁定";
}

function entityName(
  baseline: WorldSimulationBaseline,
  type: "character" | "faction" | "region" | "item",
  id: string,
): string {
  if (type === "character")
    return baseline.characters.find((item) => item.id === id)?.name ?? id;
  if (type === "faction")
    return baseline.factions.find((item) => item.id === id)?.name ?? id;
  if (type === "region")
    return baseline.regions.find((item) => item.id === id)?.name ?? id;
  return baseline.items.find((item) => item.id === id)?.name ?? id;
}

function commandLabel(
  command: WorldDomainCommand,
  baseline: WorldSimulationBaseline,
): string {
  switch (command.type) {
    case "character.intent":
      return `${entityName(baseline, "character", command.characterId)}：${command.intent}`;
    case "character.move":
      return `${entityName(baseline, "character", command.characterId)}：前往${entityName(baseline, "region", command.toRegionId)}`;
    case "character.arrive":
      return `${entityName(baseline, "character", command.characterId)}抵达${entityName(baseline, "region", command.toRegionId)}`;
    case "character.cultivate":
      return `${entityName(baseline, "character", command.characterId)}修炼进度 ${command.progressDelta > 0 ? "+" : ""}${command.progressDelta}`;
    case "character.resource":
      return `${entityName(baseline, "character", command.characterId)}资源 ${command.resourceId} ${command.delta > 0 ? "+" : ""}${command.delta}`;
    case "character.relation":
      return `${entityName(baseline, "character", command.characterId)}与${entityName(baseline, "character", command.targetCharacterId)}关系变化`;
    case "character.life":
      return `${entityName(baseline, "character", command.characterId)}：${command.status}`;
    case "character.knowledge":
      return `${entityName(baseline, "character", command.characterId)}获得新知识`;
    case "faction.strategy":
      return `${entityName(baseline, "faction", command.factionId)}：${command.strategy}`;
    case "faction.metric":
      return `${entityName(baseline, "faction", command.factionId)} ${command.metric} ${command.delta > 0 ? "+" : ""}${command.delta}`;
    case "faction.relation":
      return `${entityName(baseline, "faction", command.factionId)}外交关系变化`;
    case "region.metric":
      return `${entityName(baseline, "region", command.regionId)} ${command.metric} ${command.delta > 0 ? "+" : ""}${command.delta}`;
    case "region.control":
      return `${entityName(baseline, "region", command.regionId)}控制权变化`;
    case "item.transfer":
      return `${entityName(baseline, "item", command.itemId)}转移`;
    case "world.emergent":
      return `${command.entity.name}作为${command.entity.kind === "character" ? "新生人物" : command.entity.kind === "faction" ? "新兴势力" : "新生制度"}进入当前分支`;
    case "effect.schedule":
      return `${entityName(baseline, "region", command.effect.originRegionId)}的影响将抵达${entityName(baseline, "region", command.effect.targetRegionId)}`;
    case "effect.consume":
      return `传播影响 ${command.effectId} 已生效`;
  }
}

function actorNames(
  event: SimulationEvent,
  baseline: WorldSimulationBaseline,
): string[] {
  return [
    ...event.characterIds.map((id) => entityName(baseline, "character", id)),
    ...event.factionIds.map((id) => entityName(baseline, "faction", id)),
  ];
}

type RoundPulseKind = "world" | "people" | "factions" | "life";

function inspectorTabForPulse(kind: RoundPulseKind): InspectorTab {
  if (kind === "people" || kind === "life") return "characters";
  if (kind === "factions") return "factions";
  return "regions";
}

interface RoundPulse {
  readonly kind: RoundPulseKind;
  readonly label: string;
  readonly count: number;
  readonly detail: string;
  readonly events: readonly SimulationEvent[];
}

function pulseKindForEvent(event: SimulationEvent): RoundPulseKind {
  if (event.kind === "lifecycle" || event.kind === "cultivation") return "life";
  if (event.kind === "character-action") return "people";
  if (event.kind === "faction-strategy" || event.kind === "diplomacy")
    return "factions";
  return "world";
}

function buildRoundPulses(
  events: readonly SimulationEvent[],
  unsettled = false,
): readonly RoundPulse[] {
  const groups: readonly {
    readonly kind: RoundPulseKind;
    readonly label: string;
    readonly pendingDetail: string;
    readonly quietDetail: string;
  }[] = [
    {
      kind: "world",
      label: "世界与民生",
      pendingDetail: "周期规则、地域稳定与民生变化将在结算后汇总。",
      quietDetail: "本轮没有显著世界事件，地域与民生状态已保存。",
    },
    {
      kind: "people",
      label: "人物行动",
      pendingDetail: "人物会按记忆、处境和当前意图回应世界。",
      quietDetail: "本轮没有显著人物行动，寿命与记忆仍已结算。",
    },
    {
      kind: "factions",
      label: "势力博弈",
      pendingDetail: "势力策略、战争与资源争夺由规则快照裁定。",
      quietDetail: "本轮没有显著势力转折，资源与关系状态仍已保存。",
    },
    {
      kind: "life",
      label: "生命与代际",
      pendingDetail: "寿命、死亡、继承与新生主体会随时间跨度自动处理。",
      quietDetail: "本轮没有跨过新的生命或代际边界。",
    },
  ];
  return groups.map((group) => {
    const matching = events.filter(
      (event) => pulseKindForEvent(event) === group.kind,
    );
    const highlight = matching[0];
    return {
      kind: group.kind,
      label: group.label,
      count: matching.length,
      detail:
        highlight?.summary ??
        (unsettled ? group.pendingDetail : group.quietDetail),
      events: matching,
    };
  });
}

function nextRoundChecks(
  branch: SimulationBranch,
  baseline: WorldSimulationBaseline,
  pendingRound: RoundView | undefined,
): readonly string[] {
  if (!pendingRound) return [];
  const start = BigInt(pendingRound.start);
  const end = BigInt(pendingRound.end);
  const checks: string[] = [];
  const periodicRules = baseline.rules
    .filter(
      (rule) =>
        rule.kind === "periodic" &&
        rule.intervalDays &&
        BigInt(rule.intervalDays) > 0n,
    )
    .filter((rule) => {
      const interval = BigInt(rule.intervalDays!);
      return end / interval > start / interval;
    })
    .slice(0, 3);
  periodicRules.forEach((rule) => {
    checks.push(`检查周期规则：${rule.title}`);
  });
  if (branch.state.characters.some((character) => character.alive)) {
    checks.push("结算人物行动、关系、记忆与寿命边界");
  }
  if (
    branch.state.factions.some((faction) => faction.lifecycle !== "dissolved")
  ) {
    checks.push("结算势力策略、资源争夺与外交响应");
  }
  if (
    BigInt(pendingRound.end) - BigInt(pendingRound.start) >=
    durationToDays({ amount: "80", unit: "year" }, baseline.calendar)
  ) {
    checks.push("聚合代际承接，并检查新生人物或势力");
  }
  checks.push("传播本轮事件，保存新的状态检查点");
  return [...new Set(checks)].slice(0, 5);
}

interface RoundView {
  readonly id: string;
  readonly index: number;
  readonly start: string;
  readonly end: string;
  readonly label: string;
  readonly events: readonly SimulationEvent[];
  readonly status: string;
  /** 每轮结算后的冻结状态，供历史回看而非实时状态检查器使用。 */
  readonly state: WorldRuntimeState;
  /** 尚未结算的下一轮，只作为时间线入口，不是可回放检查点。 */
  readonly pending?: boolean;
}

function buildRounds(
  branch: SimulationBranch,
  run: WorldSimulationRun,
  calendar: WorldSimulationBaseline["calendar"],
): readonly RoundView[] {
  const recorded = branch.checkpoints.map((checkpoint, index, checkpoints) => {
    const isBaseline = index === 0;
    const previous = isBaseline
      ? checkpoint.state.currentTime.sortKey
      : (branch.checkpoints[index - 1]?.state.currentTime.sortKey ?? "0");
    const events = isBaseline
      ? []
      : branch.ledger.filter(
          (event) =>
            BigInt(event.time.sortKey) > BigInt(previous) &&
            BigInt(event.time.sortKey) <=
              BigInt(checkpoint.state.currentTime.sortKey),
        );
    return {
      id: checkpoint.id,
      index,
      start: previous,
      end: checkpoint.state.currentTime.sortKey,
      label: isBaseline
        ? "推演起点"
        : `${formatWorldInstant(previous, calendar)} → ${checkpoint.label}`,
      events,
      status: isBaseline
        ? "事实基线"
        : index === checkpoints.length - 1
          ? STATUS_LABELS[branch.status]
          : "检查点已保存",
      state: checkpoint.state,
    };
  });
  const latest = recorded.at(-1);
  if (
    !latest ||
    branch.status === "completed" ||
    branch.status === "cancelled"
  ) {
    return recorded;
  }
  const current = BigInt(latest.end);
  const end = BigInt(getSimulationEndSortKey(run));
  if (current >= end) return recorded;
  const span = durationToDays(run.scenario.roundSpan, calendar);
  const nextEnd = current + span > end ? end : current + span;
  return [
    ...recorded,
    {
      id: `pending-${branch.id}-${nextEnd.toString()}`,
      index: recorded.length,
      start: current.toString(),
      end: nextEnd.toString(),
      label: "等待推演",
      events: [],
      status: "待推演",
      state: branch.state,
      pending: true,
    },
  ];
}

function IconButton({
  label,
  children,
  onClick,
  disabled,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="ws4-icon-button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function SettingField({
  label,
  children,
  hint,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly hint?: string;
}) {
  return (
    <label className="ws4-setting-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function SettingsDialog({
  scenario,
  baseline,
  busy,
  onChange,
  onCreate,
  onClose,
}: {
  readonly scenario: WorldSimulationScenario;
  readonly baseline: WorldSimulationBaseline;
  readonly busy: boolean;
  readonly onChange: (next: WorldSimulationScenario) => void;
  readonly onCreate: () => void;
  readonly onClose: () => void;
}) {
  const patch = (next: Partial<WorldSimulationScenario>) =>
    onChange({ ...scenario, ...next });
  const entityOptions = observerEntityOptions(baseline, scenario.observer.kind);
  const invalidSpan =
    durationToDays(scenario.roundSpan, scenario.calendar) >
    durationToDays(scenario.duration, scenario.calendar);
  return (
    <div className="ws4-modal-backdrop" role="presentation">
      <section className="ws4-modal ws4-settings-modal" role="dialog" aria-modal="true" aria-labelledby="ws4-settings-title">
        <header className="ws4-modal-header">
          <div>
            <small>可选设置</small>
            <h2 id="ws4-settings-title">推演设置</h2>
            <p>这些设置只改变观察方式；世界资料和内部运行参数会自动推导。</p>
          </div>
          <IconButton label="关闭设置" onClick={onClose}><X /></IconButton>
        </header>
        <div className="ws4-settings-grid">
          <SettingField label="推演名称">
            <input value={scenario.name} onChange={(event) => patch({ name: event.target.value })} />
          </SettingField>
          <SettingField label="总推演范围" hint="默认十二年，可按需要调整。">
            <div className="ws4-setting-inline">
              <input value={scenario.duration.amount} onChange={(event) => patch({ duration: { ...scenario.duration, amount: event.target.value.replace(/[^0-9]/gu, "") || "1" } })} />
              <select value={scenario.duration.unit} onChange={(event) => patch({ duration: { ...scenario.duration, unit: event.target.value as WorldSimulationScenario["duration"]["unit"] } })}>
                {DURATION_UNITS.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
              </select>
            </div>
          </SettingField>
          <SettingField label="每轮时间跨度" hint={invalidSpan ? "每轮跨度不能超过总范围。" : "每轮推进都会结算这一段时间。"}>
            <div className="ws4-setting-inline">
              <input value={scenario.roundSpan.amount} onChange={(event) => patch({ roundSpan: { ...scenario.roundSpan, amount: event.target.value.replace(/[^0-9]/gu, "") || "1" } })} />
              <select value={scenario.roundSpan.unit} onChange={(event) => patch({ roundSpan: { ...scenario.roundSpan, unit: event.target.value as WorldSimulationScenario["roundSpan"]["unit"] } })}>
                {DURATION_UNITS.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
              </select>
            </div>
          </SettingField>
          <SettingField label="叙事镜头" hint="只改变舞台展开重点，不限制世界变化。">
            <div className="ws4-setting-inline">
              <select value={scenario.observer.kind} onChange={(event) => { const kind = event.target.value as WorldSimulationScenario["observer"]["kind"]; patch({ observer: { kind, entityId: kind === "ensemble" ? null : (observerEntityOptions(baseline, kind)[0]?.value ?? null) } }); }}>
                {Object.entries(OBSERVER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              {scenario.observer.kind !== "ensemble" && <select value={scenario.observer.entityId ?? ""} onChange={(event) => patch({ observer: { ...scenario.observer, entityId: event.target.value || null } })}>
                {entityOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>}
            </div>
          </SettingField>
        </div>
        <div className="ws4-settings-auto-note"><Sparkles /><span>事实起点、观察范围、周期规则、人物地点、预算和规则版本都会从当前世界资料自动推导；资料缺失也不会阻止创建。</span></div>
        <footer className="ws4-settings-footer">
          <button type="button" className="ws4-button" onClick={onClose}>取消</button>
          <button type="button" className="ws4-button is-primary" disabled={busy || invalidSpan || !scenario.name.trim()} onClick={onCreate}><CirclePlay />保存并进入舞台</button>
        </footer>
      </section>
    </div>
  );
}

function RunMenu({
  run,
  runs,
  busy,
  onSelect,
  onSelectBranch,
  onNew,
  onRemove,
}: {
  readonly run: WorldSimulationRun | null;
  readonly runs: readonly SimulationRunIndexEntry[];
  readonly busy: boolean;
  readonly onSelect: (id: string) => void;
  readonly onSelectBranch: (runId: string, branchId: string) => void;
  readonly onNew: () => void;
  readonly onRemove: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null);
  const pendingRemoval =
    runs.find((item) => item.id === pendingRemovalId) ?? null;
  return (
    <div className="ws4-run-menu">
      <button
        type="button"
        className="ws4-run-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="ws4-run-dot" />
        <span>
          <small>当前推演</small>
          <strong>{run?.name ?? "新建推演"}</strong>
        </span>
        <ChevronDown />
      </button>
      {open && (
        <div className="ws4-run-popover">
          <div className="ws4-popover-title">
                <span>切换推演</span>
            <button
              type="button"
              onClick={() => {
                onNew();
                setOpen(false);
              }}
            >
              <Sparkles />
              新建
            </button>
          </div>
          {runs.length === 0 ? (
            <p className="ws4-popover-empty">还没有保存的推演</p>
          ) : (
            runs.map((item) => {
              const activeBranch = item.branches?.find(
                (branch) => branch.id === item.activeBranchId,
              );
              return (
              <section key={item.id} className="ws4-run-group">
                <div className="ws4-run-entry">
                <button
                  type="button"
                  className={item.id === run?.id ? "is-active" : ""}
                  onClick={() => {
                    onSelect(item.id);
                    setOpen(false);
                  }}
                >
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.anchorDisplayText ?? "事实基线"} · 总{" "}
                      {item.duration
                        ? durationLabel(item.duration)
                        : "范围未记录"}{" "}
                      · 每轮{" "}
                      {item.roundSpan
                        ? durationLabel(item.roundSpan)
                        : "跨度未记录"}
                    </small>
                    <small>
                      {STATUS_LABELS[item.status]} ·{" "}
                      {activeBranch?.currentTimeDisplayText ??
                        item.currentSortKey}{" "}
                      ·{" "}
                      {item.eventCount} 个事件
                    </small>
                  </span>
                  <ChevronRight />
                </button>
                <IconButton
                  label={`删除推演：${item.name}`}
                  disabled={busy}
                  onClick={() => setPendingRemovalId(item.id)}
                >
                  <Trash2 />
                </IconButton>
                </div>
                {(item.branches ?? [])
                .filter((branch) => branch.id !== item.activeBranchId)
                .map((branch) => (
                  <button
                    key={branch.id}
                    type="button"
                    className="ws4-run-branch-entry"
                    onClick={() => {
                      onSelectBranch(item.id, branch.id);
                      setOpen(false);
                    }}
                  >
                    <GitFork />
                    <span>
                      <strong>{branch.name}</strong>
                      <small>
                        {STATUS_LABELS[branch.status]} ·{" "}
                        {branch.currentTimeDisplayText} · {branch.eventCount} 个事件
                      </small>
                    </span>
                    <ChevronRight />
                  </button>
                ))}
              </section>
              );
            })
          )}
          {pendingRemoval && (
            <div className="ws4-run-delete-confirm" role="alertdialog">
              <strong>删除“{pendingRemoval.name}”？</strong>
              <span>将删除它的分支、检查点和事件账本，无法恢复。</span>
              <div>
                <button
                  type="button"
                  className="ws4-text-button"
                  onClick={() => setPendingRemovalId(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="ws4-text-button is-danger"
                  disabled={busy}
                  onClick={() => {
                    onRemove(pendingRemoval.id);
                    setPendingRemovalId(null);
                    setOpen(false);
                  }}
                >
                  删除推演
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BranchMenu({
  run,
  branch,
  busy,
  onSelect,
  onCreateComparison,
}: {
  readonly run: WorldSimulationRun | null;
  readonly branch: SimulationBranch | null;
  readonly busy: boolean;
  readonly onSelect: (branchId: string) => void;
  readonly onCreateComparison: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!run || !branch) return null;
  return (
    <div className="ws4-branch-menu">
      <button
        type="button"
        className="ws4-branch-trigger"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <GitFork />
        <span>
          <small>当前分支</small>
          <strong>{branch.name}</strong>
        </span>
        <ChevronDown />
      </button>
      {open && (
        <div className="ws4-branch-popover">
          <div className="ws4-popover-title">
            <span>{run.branches.length} 个分支</span>
            <button
              type="button"
              onClick={() => {
                onCreateComparison();
                setOpen(false);
              }}
              disabled={busy}
            >
              <GitFork />
              自然对照
            </button>
          </div>
          {run.branches.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === branch.id ? "is-active" : ""}
              onClick={() => {
                onSelect(item.id);
                setOpen(false);
              }}
            >
              <span>
                <strong>{item.name}</strong>
                <small>
                  {STATUS_LABELS[item.status]} · {item.ledger.length} 个事件
                </small>
              </span>
              {item.id === branch.id && <Check />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Header({
  baseline,
  run,
  branch,
  selectedRound,
  runs,
  busy,
  onSelectRun,
  onSelectRunBranch,
  onRemoveRun,
  onNew,
  onSettings,
  onRefresh,
  onAdvance,
  onRunRounds,
  roundCount,
  onRoundCountChange,
  onPause,
  onCancel,
  onCouncil,
  onSelectBranch,
  onCreateComparison,
  onMore,
  progress,
}: {
  readonly baseline: WorldSimulationBaseline;
  readonly run: WorldSimulationRun | null;
  readonly branch: SimulationBranch | null;
  readonly selectedRound: RoundView | null;
  readonly runs: readonly SimulationRunIndexEntry[];
  readonly busy: boolean;
  readonly onSelectRun: (id: string) => void;
  readonly onSelectRunBranch: (runId: string, branchId: string) => void;
  readonly onRemoveRun: (id: string) => void;
  readonly onNew: () => void;
  readonly onSettings: () => void;
  readonly onRefresh: () => void;
  readonly onAdvance: () => void;
  readonly onRunRounds: () => void;
  readonly roundCount: number;
  readonly onRoundCountChange: (value: number) => void;
  readonly onPause: () => void;
  readonly onCancel: () => void;
  readonly onCouncil: () => void;
  readonly onSelectBranch: (branchId: string) => void;
  readonly onCreateComparison: () => void;
  readonly onMore: () => void;
  readonly progress: WorldSimulationProgress | null;
}) {
  const [continuousOpen, setContinuousOpen] = useState(false);
  const pendingRound = selectedRound?.pending === true;
  const advanceLabel = pendingRound
    ? `推演第 ${selectedRound?.index ?? 1} 轮`
    : branch?.status === "paused"
      ? "继续推演一轮"
      : "推演一轮";
  return (
    <>
      <header className="ws4-header">
        <div className="ws4-brand">
          <span className="ws4-brand-mark">
            <Orbit />
          </span>
          <div>
            <small>{baseline.projectTitle}</small>
            <h1>世界推演</h1>
          </div>
        </div>
        <RunMenu
          run={run}
          runs={runs}
          busy={busy}
          onSelect={onSelectRun}
          onSelectBranch={onSelectRunBranch}
          onNew={onNew}
          onRemove={onRemoveRun}
        />
        <div className="ws4-header-time">
          <span
            className={`ws4-status-dot is-${progress ? "running" : (branch?.status ?? "ready")}`}
          />
          {progress
            ? "正在结算"
            : branch
              ? STATUS_LABELS[branch.status]
              : "等待创建"}
          <strong>
            {progress
              ? `第 ${progress.roundIndex} 轮`
              : (branch?.state.currentTime.displayText ??
                baseline.anchor.displayText)}
          </strong>
          <small>
            {progress
              ? `${progress.from} 至 ${progress.to}`
              : run
                ? `每轮 ${durationLabel(run.scenario.roundSpan)}`
                : "默认即可开始"}
          </small>
        </div>
        <div className="ws4-header-actions">
          <IconButton label="刷新资料" onClick={onRefresh} disabled={busy}>
            <RefreshCw className={busy ? "ws4-spin" : ""} />
          </IconButton>
          {run && (
            <IconButton label="推演设置" onClick={onSettings} disabled={busy}>
              <Settings2 />
            </IconButton>
          )}
        </div>
      </header>
      <div className="ws4-command-bar">
        <div className="ws4-command-context">
          <History />{" "}
          <span>
            {progress
              ? `第 ${progress.roundIndex} 轮 · ${PROGRESS_PHASE_LABELS[progress.phase]}`
              : run
              ? `${run.scenario.duration.amount}${TIME_SCALE_LABELS[run.scenario.duration.unit as TimeScale] ?? run.scenario.duration.unit}总范围`
              : "尚未创建运行"}
          </span>
          <ArrowRight />
          <span>
            {progress
              ? `${progress.from} 至 ${progress.to}`
              : branch
                ? `${branch.ledger.length} 个已裁定事件`
                : "等待第一轮"}
          </span>
        </div>
        <div className="ws4-command-actions">
          <BranchMenu
            run={run}
            branch={branch}
            busy={busy}
            onSelect={onSelectBranch}
            onCreateComparison={onCreateComparison}
          />
          <button
            type="button"
            className="ws4-button is-primary"
            onClick={onAdvance}
            aria-label={advanceLabel}
            disabled={
              !run ||
              busy ||
              branch?.status === "completed" ||
              branch?.status === "cancelled"
            }
          >
            <StepForward />
            {advanceLabel}
          </button>
          <button
            type="button"
            className="ws4-button"
            aria-expanded={continuousOpen}
            onClick={() => setContinuousOpen((value) => !value)}
            disabled={
              !run ||
              busy ||
              branch?.status === "completed" ||
              branch?.status === "cancelled"
            }
          >
            <CirclePlay />
            连续推演
          </button>
          {continuousOpen && (
            <div className="ws4-continuous-popover" role="dialog">
              <strong>连续推演</strong>
              <p>按设置的每轮时间跨度顺序推进，完成一轮就保存一次检查点。</p>
              <div>
                <span>本次推进</span>
                <b>{roundCount} 轮</b>
                <button
                  type="button"
                  className="ws4-button is-primary"
                  onClick={() => {
                    setContinuousOpen(false);
                    onRunRounds();
                  }}
                  disabled={!run || busy}
                >
                  <CirclePlay />
                  开始
                </button>
              </div>
            </div>
          )}
          <label className="ws4-round-count">
            <span>轮数</span>
            <input
              type="number"
              min={1}
              max={32}
              value={roundCount}
              disabled={!run || busy}
              aria-label="连续推演轮数"
              onChange={(event) =>
                onRoundCountChange(
                  Math.max(1, Math.min(32, Number(event.target.value) || 1)),
                )
              }
            />
          </label>
          <button
            type="button"
            className="ws4-button"
            onClick={onCouncil}
            disabled={!run || busy}
          >
            <BrainCircuit />
            会商
          </button>
          <IconButton
            label="更多运行操作"
            onClick={onMore}
            disabled={!run || busy}
          >
            <MoreHorizontal />
          </IconButton>
          {branch && branch.status === "running" && (
            <button
              type="button"
              className="ws4-icon-button"
              aria-label="暂停推演"
              title="暂停推演"
              onClick={onPause}
            >
              <CirclePause />
            </button>
          )}
          {(busy || branch?.status === "running") && (
            <button
              type="button"
              className="ws4-button is-danger"
              aria-label="取消当前推演"
              onClick={onCancel}
              disabled={!run}
            >
              <X />
              取消当前推演
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function Timeline({
  rounds,
  selectedEventId,
  selectedRoundId,
  onRound,
  onEvent,
  calendar,
  progress,
}: {
  rounds: readonly RoundView[];
  selectedEventId: string | null;
  selectedRoundId: string | null;
  onRound: (id: string) => void;
  onEvent: (id: string) => void;
  calendar: WorldSimulationBaseline["calendar"];
  progress: WorldSimulationProgress | null;
}) {
  const recordedCount = rounds.filter((round) => !round.pending).length;
  return (
    <aside className="ws4-timeline">
      <div className="ws4-panel-heading">
        <div>
          <small>世界时间</small>
          <strong>推演时间线</strong>
        </div>
        <span>{recordedCount} 轮已记录</span>
      </div>
      <div className="ws4-timeline-scroll">
        {rounds.length === 0 && (
          <>
            <div className="ws4-origin ws4-origin-static is-active">
              <i />
              <span>
                <b>第 0 轮 · 事实基线</b>
                <small>当前资料起点</small>
              </span>
            </div>
            <div className="ws4-timeline-empty">
              <Clock3 />
              <span>创建推演后，时间线会记录每一轮检查点</span>
            </div>
          </>
        )}
        {rounds.map((round) => {
          const isRunning = progress?.roundIndex === round.index;
          return round.pending ? (
            <div
              key={round.id}
              className={`ws4-round ws4-round-pending ${isRunning ? "is-running" : ""} ${selectedRoundId === round.id ? "is-active" : ""}`}
            >
              <button type="button" onClick={() => onRound(round.id)}>
                <i />
                <span>
                  <b>第 {round.index} 轮</b>
                  <small>
                    {isRunning
                      ? `正在结算 · ${PROGRESS_PHASE_LABELS[progress.phase]}`
                      : "等待推演"}
                  </small>
                  <small>
                    {isRunning
                      ? `${progress.from} 至 ${progress.to}`
                      : formatWorldInstant(round.end, calendar)}
                  </small>
                </span>
                <ChevronRight />
              </button>
            </div>
          ) : round.index === 0 ? (
            <button
              key={round.id}
              type="button"
              className={`ws4-origin ${selectedRoundId === round.id ? "is-active" : ""}`}
              onClick={() => onRound(round.id)}
            >
              <i />
              <span>
                <b>第 0 轮 · 事实基线</b>
                <small>{round.label}</small>
              </span>
              <ChevronRight />
            </button>
          ) : (
            <div
              key={round.id}
              className={`ws4-round ${selectedRoundId === round.id ? "is-active" : ""}`}
            >
              <button type="button" onClick={() => onRound(round.id)}>
                <i />
                <span>
                  <b>第 {round.index} 轮</b>
                  <small>{round.label}</small>
                  <small>
                    {round.status} · {round.events.length} 个变化
                  </small>
                </span>
                <ChevronRight />
              </button>
              {selectedRoundId === round.id && (
                <div className="ws4-round-events">
                  {round.events.length === 0 ? (
                    <small>本轮没有显著事件，状态已静默演化。</small>
                  ) : (
                    round.events.slice(-8).map((event) => (
                      <button
                        key={event.id}
                        type="button"
                        className={
                          selectedEventId === event.id ? "is-active" : ""
                        }
                        onClick={() => onEvent(event.id)}
                      >
                        <span
                          className="ws4-event-dot"
                          style={{ background: eventColor(event.kind) }}
                        />
                        <span>{event.title}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function Stage({
  run,
  branch,
  baseline,
  selectedEvent,
  rounds,
  selectedRoundId,
  onEvent,
  onInspectorTab,
  onCouncil,
  onCausal,
  onFork,
  onGuardrail,
  onLead,
  onAdopt,
  onAdvance,
  reports,
  onReport,
  busy,
  progress,
}: {
  run: WorldSimulationRun;
  branch: SimulationBranch;
  baseline: WorldSimulationBaseline;
  selectedEvent: SimulationEvent | null;
  rounds: readonly RoundView[];
  selectedRoundId: string | null;
  onEvent: (id: string) => void;
  onInspectorTab: (tab: InspectorTab) => void;
  onCouncil: () => void;
  onCausal: () => void;
  onFork: () => void;
  onGuardrail: () => void;
  onLead: () => void;
  onAdopt: () => void;
  onAdvance: () => void;
  reports: WorldSimulationRun["reports"];
  onReport: () => void;
  busy: boolean;
  progress: WorldSimulationProgress | null;
}) {
  const [choiceFeedback, setChoiceFeedback] =
    useState<StoryChoiceAction | null>(null);
  useEffect(() => {
    setChoiceFeedback(null);
  }, [selectedEvent?.id]);
  const currentRound = rounds.find((round) => round.id === selectedRoundId);
  const stageState = currentRound?.state ?? branch.state;
  const events = currentRound?.events ?? branch.ledger.slice(-12);
  const pendingRound = currentRound?.pending === true;
  const pendingWindow = currentRound?.pending
    ? currentRound
    : currentRound?.index === 0
      ? rounds.find((round) => round.pending)
      : undefined;
  const latestReport = reports
    .filter((report) => report.branchId === branch.id)
    .at(-1);
  const isBaselineRound = currentRound?.index === 0;
  const unsettledRound = isBaselineRound || pendingRound;
  const pulses = buildRoundPulses(events, unsettledRound);
  const upcomingChecks = nextRoundChecks(branch, baseline, pendingWindow);
  const isRecordedQuietRound = Boolean(
    currentRound && currentRound.index > 0 && !pendingRound,
  );
  const checkpointLabel = currentRound?.status ?? "尚未推进";
  const roundWindow = currentRound
    ? isBaselineRound
      ? "事实基线"
      : `${formatWorldInstant(currentRound.start, baseline.calendar)} 至 ${formatWorldInstant(currentRound.end, baseline.calendar)}`
    : stageState.currentTime.displayText;
  const observerHandoff = observerHandoffTarget(run, baseline, stageState);
  const storyChoices = selectedEvent
    ? storyChoicesForEvent(selectedEvent)
    : [];
  const storyChoiceDisabled =
    busy || branch.status === "completed" || branch.status === "cancelled";
  const handleStoryChoice = (action: StoryChoiceAction) => {
    setChoiceFeedback(action);
    if (action === "observe" || action === "silence") onAdvance();
    if (action === "council") onCouncil();
    if (action === "guardrail") onGuardrail();
    if (action === "lead") onLead();
    if (action === "fork") onFork();
  };
  const stageKicker = selectedEvent
    ? EVENT_KIND_LABELS[selectedEvent.kind]
    : isBaselineRound
      ? "事实基线 · 开场"
      : currentRound
        ? `叙事舞台 · 第 ${currentRound.index} 轮`
        : "当前世界";
  return (
    <main className="ws4-stage">
      <div className="ws4-stage-heading">
        <div>
          <small>{stageKicker}</small>
          <h2>
            {currentRound
              ? isBaselineRound
                ? "事实基线"
                : pendingRound
                  ? "等待下一次结算"
                  : `第 ${currentRound.index} 轮世界变化`
              : "等待世界开始行动"}
          </h2>
          <p>
            {selectedEvent?.time.displayText ??
              stageState.currentTime.displayText}{" "}
            · {runObserverLabel(baseline, selectedEvent)}
          </p>
        </div>
        <div className="ws4-stage-actions">
          <button type="button" className="ws4-button" onClick={onCausal}>
            <GitFork />
            因果链
          </button>
          <button
            type="button"
            className="ws4-button"
            onClick={onAdopt}
            disabled={!selectedEvent || busy}
          >
            <BookOpenCheck />
            生成提案
          </button>
        </div>
      </div>
      <div className="ws4-stage-summary" aria-label="当前推演摘要">
        <strong>
          {unsettledRound
            ? isBaselineRound
              ? "等待第一轮"
              : "等待结算"
            : `${events.length} 个已接受变化`}
        </strong>
        <span>
          跨度 {durationLabel(run.scenario.roundSpan)} · 观察{" "}
          {scenarioObserverLabel(baseline, run.scenario.observer)} · {roundWindow}
        </span>
        <em>
          <i />
          {checkpointLabel}
        </em>
      </div>
      <div className="ws4-scene-bar" aria-label="当前场景">
        <span>当前场景</span>
        <strong>{stageState.currentTime.displayText}</strong>
        <em>
          <i />
          {checkpointLabel}
        </em>
      </div>
      {progress && (
        <section className="ws4-settling-flow" aria-live="polite">
          <div
            className="ws4-settling-live"
            aria-label="当前轮次结算进度"
          >
            <Orbit className="ws4-spin" />
            <div>
              <small>
                第 {progress.roundIndex} 轮 · {PROGRESS_PHASE_LABELS[progress.phase]}
              </small>
              <strong>
                {progress.from} 至 {progress.to}
              </strong>
            </div>
            <span>世界规则、主体状态与传播影响正在按同一时间边界裁定。</span>
          </div>
          <ol className="ws4-settling-steps" aria-label="本轮结算步骤">
            {buildSettlementSteps(progress.phase).map((step, index) => (
              <li key={step.id} data-state={step.state}>
                <span className="ws4-settling-step-index">
                  {step.state === "completed" ? <Check /> : index + 1}
                </span>
                <span>
                  <strong>{step.title}</strong>
                  <small>{step.detail}</small>
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <section className="ws4-pulse-panel" aria-label="本轮世界脉动">
        <div className="ws4-section-heading">
          <span>本轮世界脉动</span>
          <small>
            {unsettledRound ? "结算后将生成" : `${events.length} 条已接受变化`}
          </small>
        </div>
        <div className="ws4-pulse-grid">
          {pulses.map((pulse) => (
            <div key={pulse.kind} className={`ws4-pulse is-${pulse.kind}`}>
              <div>
                <span>{pulse.label}</span>
                <strong>{unsettledRound ? "待结算" : `${pulse.count} 项`}</strong>
              </div>
              <p>{pulse.detail}</p>
              <button
                type="button"
                className="ws4-pulse-link"
                onClick={() => {
                  const event = pulse.events[0];
                  if (event) onEvent(event.id);
                  onInspectorTab(inspectorTabForPulse(pulse.kind));
                }}
              >
                {pulse.events.length ? "查看变化状态" : "查看当前状态"}
                <ChevronRight />
              </button>
            </div>
          ))}
        </div>
      </section>
      {pendingWindow && upcomingChecks.length > 0 && (
        <section className="ws4-next-window" aria-label="下一轮结算范围">
          <div className="ws4-next-window-mark">
            <Clock3 />
          </div>
          <div>
            <strong>
              下一轮将从{" "}
              {formatWorldInstant(pendingWindow.start, baseline.calendar)}
              结算至 {formatWorldInstant(pendingWindow.end, baseline.calendar)}
            </strong>
            <p>世界会按已编译规则同时处理以下变化，作者无需逐项设置。</p>
            <ul>
              {upcomingChecks.map((check) => (
                <li key={check}>{check}</li>
              ))}
            </ul>
          </div>
        </section>
      )}
      {observerHandoff && (
        <section className="ws4-observer-handoff">
          <History />
          <span>
            <strong>观察镜头已承接至{observerHandoff.title}</strong>
            <small>{observerHandoff.detail}</small>
          </span>
        </section>
      )}
      {selectedEvent ? (
        <article className="ws4-story">
          <div className="ws4-story-meta">
            <span
              className="ws4-story-kind"
              style={{ color: eventColor(selectedEvent.kind) }}
            >
              {EVENT_KIND_LABELS[selectedEvent.kind]}
            </span>
            <span>
              {actorNames(selectedEvent, baseline).join(" · ") || "世界过程"}
            </span>
            <span>
              {selectedEvent.generatedBy === "fallback"
                ? "确定性降级"
                : selectedEvent.generatedBy === "model"
                  ? "模型候选已裁定"
                  : "内核裁定"}
            </span>
          </div>
          <h3 className="ws4-story-title">{selectedEvent.title}</h3>
          <p className="ws4-story-summary">{selectedEvent.summary}</p>
          <div className="ws4-story-rule">
            <ShieldCheck />
            <span>
              <b>为什么发生</b>
              <small>
                {selectedEvent.evidence[0]?.detail ??
                  "已接受的世界规则与状态变化"}
              </small>
            </span>
          </div>
          <div className="ws4-story-facts" aria-label="事件事实标签">
            <span>{eventEvidenceLabel(selectedEvent)}</span>
            <span>{selectedEvent.causeEventIds.length} 条前因</span>
            <span>{selectedEvent.commands.length} 项状态写入</span>
            {selectedEvent.narrativeConstraintIds.length > 0 && (
              <span>
                {selectedEvent.narrativeConstraintIds.length} 条剧情约束
              </span>
            )}
          </div>
          <div className="ws4-choice-block">
            <div className="ws4-choice-heading">
              <span>你要如何处理这一刻？</span>
              <small>
                选项会随事件类型变化；世界规则仍由内核裁定，作者只决定是否观察或干预
              </small>
            </div>
            {choiceFeedback && (
              <div className="ws4-choice-feedback" role="status" aria-live="polite">
                <Check />
                <span>{storyChoiceFeedback(choiceFeedback)}</span>
              </div>
            )}
            <div className="ws4-choice-list">
              {storyChoices.map((choice, index) => (
                <button
                  key={choice.action}
                  type="button"
                  className={choiceFeedback === choice.action ? "is-selected" : ""}
                  onClick={() => handleStoryChoice(choice.action)}
                  disabled={storyChoiceDisabled}
                >
                  <span className="ws4-choice-key">
                    {String.fromCharCode(65 + index)}
                  </span>
                  <span>
                    <strong>{choice.label}</strong>
                    <small>{choice.description}</small>
                  </span>
                  <ChevronRight />
                </button>
              ))}
            </div>
          </div>
          <div className="ws4-story-actions">
            <button
              type="button"
              className="ws4-button is-primary"
              onClick={onCouncil}
              disabled={busy}
            >
              <BrainCircuit />
              让各方会商
            </button>
            <button
              type="button"
              className="ws4-button"
              onClick={onFork}
              disabled={busy}
            >
              <GitFork />
              从此处创建分支
            </button>
            <button
              type="button"
              className="ws4-button"
              onClick={onLead}
              disabled={busy}
            >
              <Lightbulb />
              投递线索
            </button>
            <button
              type="button"
              className="ws4-button"
              onClick={onAdopt}
              disabled={busy}
            >
              <BookOpenCheck />
              生成采纳提案
            </button>
          </div>
          <details className="ws4-story-evidence">
            <summary>
              <FileText />
              查看完整证据（{selectedEvent.evidence.length}）
            </summary>
            {selectedEvent.evidence.length ? (
              <ul>
                {selectedEvent.evidence.map((evidence, index) => (
                  <li key={`${evidence.label}-${index}`}>
                    <strong>{evidence.label}</strong>
                    <span>{evidence.detail}</span>
                    {evidence.sourceRefs[0] && (
                      <span>{evidence.sourceRefs[0].path}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p>该事件由已锁定的运行基线与内核状态变化裁定。</p>
            )}
          </details>
        </article>
      ) : isBaselineRound ? (
        <article className="ws4-story ws4-story-intro">
          <div className="ws4-story-meta">
            <span className="ws4-story-kind" style={{ color: "var(--ws4-accent)" }}>
              事实基线
            </span>
            <span>世界起点</span>
            <span>内核已锁定</span>
          </div>
          <h3 className="ws4-story-title">故事从这里开始</h3>
          <p className="ws4-story-summary">
            这是当前世界资料能够确认的起点。下一轮会让人物、势力、民间生活与世界规则一起跨过时间边界，结果会以事件和状态快照保存下来。
          </p>
          <div className="ws4-story-facts" aria-label="推演起点信息">
            <span>本轮跨度：{durationLabel(run.scenario.roundSpan)}</span>
            <span>观察对象：{scenarioObserverLabel(baseline, run.scenario.observer)}</span>
            <span>起点：{baseline.anchor.displayText}</span>
            <span>状态：等待第一轮</span>
          </div>
          <div className="ws4-choice-block">
            <div className="ws4-choice-heading">
              <span>从这里开始</span>
              <small>无需填写内部资料，直接选择你想先看的方向</small>
            </div>
            <div className="ws4-choice-list ws4-choice-list-intro">
              <button type="button" onClick={onAdvance} disabled={busy}>
                <span className="ws4-choice-key">A</span>
                <span>
                  <strong>推演第一轮</strong>
                  <small>让世界跨过下一个时间跨度并生成第一批事件</small>
                </span>
                <ChevronRight />
              </button>
              <button type="button" onClick={() => onInspectorTab("characters")}>
                <span className="ws4-choice-key">B</span>
                <span>
                  <strong>先看人物</strong>
                  <small>查看人物的寿命、目标、关系和当前行动边界</small>
                </span>
                <ChevronRight />
              </button>
              <button type="button" onClick={() => onInspectorTab("factions")}>
                <span className="ws4-choice-key">C</span>
                <span>
                  <strong>先看势力</strong>
                  <small>查看资源、外交、军力和组织生命周期</small>
                </span>
                <ChevronRight />
              </button>
              <button type="button" onClick={() => onInspectorTab("world")}>
                <span className="ws4-choice-key">D</span>
                <span>
                  <strong>先看世界规则</strong>
                  <small>查看周期事件、修行体系和纪元状态</small>
                </span>
                <ChevronRight />
              </button>
            </div>
          </div>
        </article>
      ) : (
        <section className="ws4-first-step">
          <div className="ws4-first-step-mark">
            <Orbit />
          </div>
          <div>
            <small>
              {isRecordedQuietRound ? "检查点 · 已保存" : "事实基线 · 已就绪"}
            </small>
            <h3>
              {pendingRound
                ? "下一轮尚未结算"
                : isRecordedQuietRound
                  ? "这一轮没有显著事件"
                  : "这一轮尚未开始"}
            </h3>
            <p>
              {pendingRound
                ? "这是下一轮待结算窗口。点击上方“推演一轮”，让人物、势力、民间生活与世界规则一起行动。"
                : isRecordedQuietRound
                  ? "本轮没有写入可展示的显著事件，但时间跨度已经完成结算。人物、势力、民间生活与世界规则的状态仍可能发生了变化，可在右侧检查器查看本轮快照。"
                  : "从事实基线向前推进一个完整时间跨度。人物会行动，势力会响应，民间生活与世界规则也会同时结算。"}
            </p>
          </div>
          <div className="ws4-first-step-actions">
            <button
              type="button"
              className="ws4-button is-primary"
              onClick={onAdvance}
              disabled={busy}
            >
              <StepForward />
              {pendingRound
                ? `推演第 ${currentRound?.index ?? 1} 轮`
                : isRecordedQuietRound
                  ? "继续推演"
                  : "推演第一轮"}
            </button>
            <span>
              {isRecordedQuietRound
                ? "检查点已保存，可查看状态或继续推进。"
                : "完成后会保存检查点，可随时回看或建立分支。"}
            </span>
          </div>
        </section>
      )}
      <section className="ws4-event-stream">
        <div className="ws4-section-heading">
          <span>本轮行动记录</span>
          <small>{events.length} 条</small>
        </div>
        {events.length ? (
          events.map((event, index) => (
            <button
              key={event.id}
              type="button"
              className={selectedEvent?.id === event.id ? "is-active" : ""}
              onClick={() => onEvent(event.id)}
            >
              <span
                className="ws4-event-seq"
                style={{ color: eventColor(event.kind) }}
              >
                {String(index + 1).padStart(2, "0")}
              </span>
              <span>
                <strong>{event.title}</strong>
                <small>
                  {EVENT_KIND_LABELS[event.kind]} · {event.time.displayText} ·{" "}
                  {eventEvidenceLabel(event)} ·{" "}
                  {event.generatedBy === "model"
                    ? "模型候选已裁定"
                    : event.generatedBy === "fallback"
                      ? "确定性降级"
                      : "内核裁定"}
                </small>
                <small>{event.summary}</small>
              </span>
              <ChevronRight />
            </button>
          ))
        ) : (
          <p className="ws4-muted">
            {isBaselineRound
              ? "第一轮尚未结算，点击“推演第一轮”让世界跨过这个时间边界。"
              : pendingRound
              ? "等待下一次结算，点击“推演一轮”让世界跨过这个时间边界。"
              : "本轮没有显著事件，人口、资源、记忆和稳定度仍按世界过程变化。"}
          </p>
        )}
      </section>
      <section className="ws4-report-panel">
        <div className="ws4-section-heading">
          <span>本分支报告</span>
          <button
            type="button"
            className="ws4-text-button"
            onClick={onReport}
            disabled={busy}
          >
            <FileText />
            {latestReport ? "重新生成" : "生成报告"}
          </button>
        </div>
        {latestReport ? (
          <div className="ws4-report-summary">
            <span>
              {latestReport.generatedBy === "model" ? "模型报告" : "确定性报告"}
            </span>
            <strong>{latestReport.title}</strong>
            <p>{latestReport.summary}</p>
          </div>
        ) : (
          <p className="ws4-muted">
            报告会汇总已接受事件、世界状态和未解决风险，不会改写推演历史。
          </p>
        )}
      </section>
    </main>
  );
}

function PreRunStage({
  busy,
  onStart,
}: {
  readonly busy: boolean;
  readonly onStart: () => void;
}) {
  return (
    <main className="ws4-stage ws4-prerun-stage ws4-prerun-empty">
      <div className="ws4-prerun-empty-mark" aria-hidden="true">
        <Orbit />
      </div>
      <small className="ws4-prerun-empty-kicker">推演舞台</small>
      <h2>开始一场推演</h2>
      <p>
        世界会从当前资料自动建立事实基线，并让人物、势力、民间生活与既有规则一起开始演化。
      </p>
      <div className="ws4-prerun-empty-actions">
        <button
          type="button"
          className="ws4-button is-primary"
          onClick={onStart}
          disabled={busy}
          aria-label="创建推演"
        >
          <StepForward />
          创建并开始推演
        </button>
      </div>
      <small className="ws4-prerun-empty-note">
        无需填写参数，系统会自动生成可运行的默认推演。
      </small>
    </main>
  );
}

function observerHandoffTarget(
  run: WorldSimulationRun,
  baseline: WorldSimulationBaseline,
  state: WorldRuntimeState,
): { readonly title: string; readonly detail: string } | null {
  const observer = run.scenario.observer;
  if (
    (observer.kind !== "character" && observer.kind !== "mortal") ||
    !observer.entityId
  )
    return null;
  const observed = state.characters.find(
    (item) => item.id === observer.entityId,
  );
  if (!observed || observed.alive) return null;
  const character = baseline.characters.find(
    (item) => item.id === observer.entityId,
  );
  const regionId = observed.locationId ?? character?.locationId ?? null;
  const emergent = state.emergentEntities
    ?.slice()
    .reverse()
    .find(
      (entity) =>
        entity.regionId === regionId &&
        (entity.kind === "character" || entity.kind === "institution"),
    );
  if (emergent) {
    return {
      title: emergent.name,
      detail: `${character?.name ?? "观察对象"}已离世；镜头改为跟随当前分支中承接其地域记忆的新生主体。`,
    };
  }
  const relic = state.items.find(
    (item) =>
      item.ownerId === null &&
      item.locationId === regionId &&
      character?.inventoryItemIds.includes(item.id),
  );
  if (relic) {
    return {
      title: entityName(baseline, "item", relic.id),
      detail: `${character?.name ?? "观察对象"}已离世；镜头暂时跟随其遗物的归属与后续影响。`,
    };
  }
  return {
    title: regionId ? entityName(baseline, "region", regionId) : "地方记忆",
    detail: `${character?.name ?? "观察对象"}已离世；镜头转向其留下的地方秩序、熟人记忆与世界后果。`,
  };
}

function runObserverLabel(
  baseline: WorldSimulationBaseline,
  event: SimulationEvent | null,
): string {
  if (!event) return "已保存的轮次快照";
  const region = event.regionIds[0]
    ? entityName(baseline, "region", event.regionIds[0])
    : "目标范围";
  return `${region} · ${event.confidence >= 0.9 ? "高置信" : "推演结果"}`;
}

function scenarioObserverLabel(
  baseline: WorldSimulationBaseline,
  observer: WorldSimulationScenario["observer"],
): string {
  if (observer.kind === "ensemble") return OBSERVER_LABELS.ensemble;
  if (!observer.entityId) return OBSERVER_LABELS[observer.kind];
  if (observer.kind === "faction") {
    return entityName(baseline, "faction", observer.entityId);
  }
  return entityName(baseline, "character", observer.entityId);
}

type AnalysisDrawerKind = "causal" | "operations" | "guardrail" | "lead";

function AnalysisDrawer({
  kind,
  run,
  branch,
  selectedEvent,
  busy,
  onClose,
  onCreateComparison,
  onFork,
  onCouncil,
  onAdopt,
  onReport,
  onCancel,
  onGuardrail,
  onLead,
  onOpenLead,
}: {
  readonly kind: AnalysisDrawerKind;
  readonly run: WorldSimulationRun;
  readonly branch: SimulationBranch;
  readonly selectedEvent: SimulationEvent | null;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onCreateComparison: () => void;
  readonly onFork: () => void;
  readonly onCouncil: () => void;
  readonly onAdopt: () => void;
  readonly onReport: () => void;
  readonly onCancel: () => void;
  readonly onGuardrail: (guardrail: string) => void;
  readonly onLead: (lead: string) => void;
  readonly onOpenLead: () => void;
}) {
  const causalParents = selectedEvent
    ? selectedEvent.causeEventIds
        .map((id) => branch.ledger.find((event) => event.id === id))
        .filter((event): event is SimulationEvent => Boolean(event))
    : [];
  const causalChildren = selectedEvent
    ? branch.ledger
        .filter((event) => event.causeEventIds.includes(selectedEvent.id))
        .slice(0, 6)
    : [];
  const evidence = selectedEvent?.evidence.slice(0, 4) ?? [];
  const comparisonCandidates = run.branches.filter(
    (candidate) => candidate.id !== branch.id,
  );
  const [comparisonBranchId, setComparisonBranchId] = useState(
    comparisonCandidates[0]?.id ?? "",
  );
  const [guardrail, setGuardrail] = useState("");
  const [lead, setLead] = useState("");
  const activeComparisonBranchId = comparisonCandidates.some(
    (candidate) => candidate.id === comparisonBranchId,
  )
    ? comparisonBranchId
    : (comparisonCandidates[0]?.id ?? "");
  const comparison =
    kind === "operations" && activeComparisonBranchId
      ? compareSimulationBranches(run, branch.id, activeComparisonBranchId)
      : null;
  const comparisonBranch = activeComparisonBranchId
    ? run.branches.find(
        (candidate) => candidate.id === activeComparisonBranchId,
      )
    : null;
  const title =
    kind === "causal"
      ? "本轮因果链"
      : kind === "guardrail"
        ? "设置护栏"
        : kind === "lead"
          ? "投递线索"
        : "更多运行操作";
  return (
    <div className="ws4-drawer-backdrop" onClick={onClose}>
      <aside
        className="ws4-drawer ws4-analysis-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ws4-analysis-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ws4-drawer-header">
          <div>
            <small>
              {kind === "causal"
                ? "因果追踪"
                : kind === "guardrail"
                  ? "作者护栏"
                  : kind === "lead"
                    ? "作者线索"
                  : "运行操作"}
            </small>
            <h2 id="ws4-analysis-title">{title}</h2>
            <p>
              {kind === "causal"
                ? "只展示已写入事件账本的前因、规则证据和后续影响。"
                : kind === "guardrail"
                  ? "护栏会进入新的干预分支，原运行保持只读。"
                  : kind === "lead"
                    ? "线索只作为下一轮候选的未来倾向，不会成为已发生事实。"
                  : "这些操作只创建候选、报告或分支，不会直接改写正式资料。"}
            </p>
          </div>
          <IconButton label="关闭运行操作" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        {kind === "causal" ? (
          <div className="ws4-analysis-scroll">
            {!selectedEvent ? (
              <div className="ws4-empty">
                <GitFork />
                请选择一条事件查看因果链
              </div>
            ) : (
              <>
                <AnalysisLane
                  title="前置状态"
                  items={causalParents}
                  empty="没有已记录的前置事件"
                />
                <AnalysisLane
                  title="本轮事件"
                  items={[selectedEvent]}
                  empty="当前事件不存在"
                  isCurrent
                />
                <section className="ws4-analysis-evidence">
                  <div className="ws4-section-heading">
                    <span>规则与事实证据</span>
                    <small>{evidence.length} 条</small>
                  </div>
                  {evidence.length ? (
                    evidence.map((item, index) => (
                      <article key={item.label + "-" + index}>
                        <strong>{item.label}</strong>
                        <p>{item.detail}</p>
                        <small>
                          {item.authority} ·{" "}
                          {item.sourceRefs[0]?.path ?? "运行基线"}
                        </small>
                      </article>
                    ))
                  ) : (
                    <p className="ws4-muted">
                      该事件由内核状态变化裁定，未附加单独来源。
                    </p>
                  )}
                </section>
                <AnalysisLane
                  title="后续影响"
                  items={causalChildren}
                  empty="当前账本尚未记录后续影响"
                />
              </>
            )}
          </div>
        ) : kind === "guardrail" ? (
          <div className="ws4-analysis-scroll">
            <div className="ws4-analysis-run-summary">
              <small>作者干预候选</small>
              <strong>{selectedEvent?.title ?? "当前事件"}</strong>
              <span>
                只影响从该事件继续演化的新分支，不会改写原运行或已完成轮次。
              </span>
            </div>
            <label className="ws4-guardrail-field">
              <span>护栏内容</span>
              <textarea
                value={guardrail}
                onChange={(event) => setGuardrail(event.target.value)}
                placeholder="例如：张三在下一轮不得主动离开青石镇"
                rows={5}
                autoFocus
              />
            </label>
            <p className="ws4-analysis-note">
              护栏会作为新分支的作者约束提供给候选裁定层；世界硬规则优先于作者护栏。
            </p>
            <button
              type="button"
              className="ws4-button is-primary"
              onClick={() => onGuardrail(guardrail)}
              disabled={busy || !selectedEvent || !guardrail.trim()}
            >
              <ShieldCheck />
              建立护栏分支
            </button>
          </div>
        ) : kind === "lead" ? (
          <div className="ws4-analysis-scroll">
            <div className="ws4-analysis-run-summary">
              <small>作者线索候选</small>
              <strong>{selectedEvent?.title ?? "当前事件"}</strong>
              <span>
                线索会随新的干预分支保存，只供候选层判断后续可能性，不作为当前世界事实。
              </span>
            </div>
            <label className="ws4-guardrail-field">
              <span>未来线索</span>
              <textarea
                value={lead}
                onChange={(event) => setLead(event.target.value)}
                placeholder="例如：旧井底的残卷可能与北山灵脉异动有关"
                rows={5}
                autoFocus
              />
            </label>
            <p className="ws4-analysis-note">
              线索不是人物已知信息，也不是必然发生的事件。候选仍须通过事实、空间、资源、寿命和世界规则裁定。
            </p>
            <button
              type="button"
              className="ws4-button is-primary"
              onClick={() => onLead(lead)}
              disabled={busy || !selectedEvent || !lead.trim()}
            >
              <Lightbulb />
              建立线索分支
            </button>
          </div>
        ) : (
          <div className="ws4-analysis-scroll">
            <div className="ws4-analysis-run-summary">
              <small>当前运行</small>
              <strong>{run.name}</strong>
              <span>
                {branch.name} · {branch.ledger.length} 个事件 ·{" "}
                {branch.state.currentTime.displayText}
              </span>
            </div>
            {(branch.authorLeads?.length ?? 0) > 0 && (
              <section className="ws4-author-leads">
                <div className="ws4-section-heading">
                  <span>当前投递线索</span>
                  <small>{branch.authorLeads?.length ?? 0} 条</small>
                </div>
                <p>
                  仅作为后续候选的软倾向；不会被当作事实、人物知识或必然结果。
                </p>
                <ul>
                  {branch.authorLeads?.map((lead, index) => (
                    <li key={`${lead}-${index}`}>
                      <Lightbulb />
                      <span>{lead}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <div className="ws4-analysis-actions">
              <button
                type="button"
                className="ws4-button"
                onClick={onFork}
                disabled={!selectedEvent || busy}
              >
                <GitFork />
                从当前事件创建分支
              </button>
              <button
                type="button"
                className="ws4-button"
                onClick={onOpenLead}
                disabled={!selectedEvent || busy}
              >
                <Lightbulb />
                向新分支投递线索
              </button>
              <button
                type="button"
                className="ws4-button"
                onClick={onCreateComparison}
                disabled={busy}
              >
                <GitFork />
                创建自然对照分支
              </button>
              <button
                type="button"
                className="ws4-button"
                onClick={onCouncil}
                disabled={busy}
              >
                <BrainCircuit />
                让各方会商
              </button>
              <button
                type="button"
                className="ws4-button"
                onClick={onAdopt}
                disabled={!selectedEvent || busy}
              >
                <BookOpenCheck />
                生成采纳提案
              </button>
              <button
                type="button"
                className="ws4-button is-primary"
                onClick={onReport}
                disabled={busy}
              >
                <FileText />
                生成本分支报告
              </button>
              <button
                type="button"
                className="ws4-button is-danger"
                onClick={onCancel}
                disabled={
                  busy ||
                  branch.status === "completed" ||
                  branch.status === "cancelled"
                }
              >
                <CirclePause />
                取消当前推演
              </button>
            </div>
            {comparisonCandidates.length > 0 && comparison && (
              <section className="ws4-branch-comparison">
                <div className="ws4-section-heading">
                  <span>分支对照</span>
                  <small>只读比较</small>
                </div>
                <select
                  aria-label="对照分支"
                  value={activeComparisonBranchId}
                  onChange={(event) =>
                    setComparisonBranchId(event.target.value)
                  }
                >
                  {comparisonCandidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
                <p>
                  <b>首次分歧：</b>
                  {comparison.firstDivergence?.summary ?? "尚未出现事件分歧"}
                </p>
                <p>
                  <b>叙事约束：</b>
                  {comparison.narrativeDifference}
                </p>
                {comparison.stateDifferences.length > 0 && (
                  <ul>
                    {comparison.stateDifferences.map((difference) => (
                      <li key={difference}>{difference}</li>
                    ))}
                  </ul>
                )}
                {comparisonBranch && (
                  <small>
                    {comparisonBranch.state.currentTime.displayText} ·{" "}
                    {comparisonBranch.ledger.length} 个事件
                  </small>
                )}
              </section>
            )}
            <p className="ws4-analysis-note">
              观察对象：
              {OBSERVER_LABELS[run.scenario.observer.kind]} ·
              规则、状态和事件仍以当前分支为准。
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

function AnalysisLane({
  title,
  items,
  empty,
  isCurrent = false,
}: {
  readonly title: string;
  readonly items: readonly SimulationEvent[];
  readonly empty: string;
  readonly isCurrent?: boolean;
}) {
  return (
    <section
      className={
        isCurrent ? "ws4-analysis-lane is-current" : "ws4-analysis-lane"
      }
    >
      <div className="ws4-section-heading">
        <span>{title}</span>
        <small>{items.length} 条</small>
      </div>
      {items.length ? (
        items.map((event) => (
          <article key={event.id}>
            <small>
              {event.time.displayText} · {EVENT_KIND_LABELS[event.kind]}
            </small>
            <strong>{event.title}</strong>
            <p>{event.summary}</p>
          </article>
        ))
      ) : (
        <p className="ws4-analysis-empty">{empty}</p>
      )}
    </section>
  );
}

type InspectorTab = "characters" | "factions" | "regions" | "world";

type InspectorEntityKind = Exclude<InspectorTab, "world">;

interface InspectorEntityFocus {
  readonly kind: InspectorEntityKind;
  readonly id: string;
  readonly name: string;
}

function focusForSimulationEvent(
  event: SimulationEvent | null,
  baseline: WorldSimulationBaseline,
): InspectorEntityFocus | null {
  if (!event) return null;
  const characterId = event.characterIds[0];
  if (characterId) {
    return {
      kind: "characters",
      id: characterId,
      name: entityName(baseline, "character", characterId),
    };
  }
  const factionId = event.factionIds[0];
  if (factionId) {
    return {
      kind: "factions",
      id: factionId,
      name: entityName(baseline, "faction", factionId),
    };
  }
  const regionId = event.regionIds[0];
  if (regionId) {
    return {
      kind: "regions",
      id: regionId,
      name: entityName(baseline, "region", regionId),
    };
  }
  return null;
}
type MobilePanel = "timeline" | "stage" | "inspector";

function MobilePanelTabs({
  value,
  onChange,
}: {
  readonly value: MobilePanel;
  readonly onChange: (value: MobilePanel) => void;
}) {
  const tabs: readonly [MobilePanel, string][] = [
    ["timeline", "轮次"],
    ["stage", "舞台"],
    ["inspector", "状态"],
  ];
  return (
    <nav className="ws4-mobile-tabs" aria-label="移动端工作台视图">
      {tabs.map(([tab, label]) => (
        <button
          key={tab}
          type="button"
          className={value === tab ? "is-active" : ""}
          aria-selected={value === tab}
          onClick={() => onChange(tab)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

function PreRunInspector({
  baseline,
  tab,
  onTab,
}: {
  readonly baseline: WorldSimulationBaseline;
  readonly tab: InspectorTab;
  readonly onTab: (tab: InspectorTab) => void;
}) {
  const tabs: readonly [InspectorTab, string][] = [
    ["characters", "人物"],
    ["factions", "势力"],
    ["regions", "地域"],
    ["world", "世界"],
  ];
  const groups: Record<
    InspectorTab,
    {
      readonly count: number;
      readonly names: readonly string[];
      readonly detail: string;
    }
  > = {
    characters: {
      count: baseline.characters.length,
      names: baseline.characters.map((item) => item.name),
      detail: "人物状态会在每轮结算寿命、关系、记忆、行动和境界。",
    },
    factions: {
      count: baseline.factions.length,
      names: baseline.factions.map((item) => item.name),
      detail: "势力状态会在每轮结算资源、外交、冲突和生命周期。",
    },
    regions: {
      count: baseline.regions.length,
      names: baseline.regions.map((item) => item.name),
      detail: "地域状态会承接民生、环境、控制权和传播影响。",
    },
    world: {
      count: baseline.rules.length + baseline.cultivationSystems.length,
      names: [
        ...baseline.rules.slice(0, 4).map((item) => item.title),
        ...baseline.cultivationSystems.slice(0, 4).map((item) => item.name),
      ],
      detail: "世界状态会承接周期规则、修行体系、时代和纪元变化。",
    },
  };
  const current = groups[tab];
  return (
    <aside className="ws4-inspector ws4-prerun-inspector">
      <div className="ws4-panel-heading">
        <div>
          <small>状态检查器</small>
          <strong>当前时间点</strong>
        </div>
        <span>{baseline.anchor.displayText}</span>
      </div>
      <div className="ws4-prerun-inspector-intro">
        <small>事实基线</small>
        <strong>推演创建后查看状态快照</strong>
        <p>当前资料已就绪，开始推演后这里会显示每轮结束时的真实状态。</p>
      </div>
      <div className="ws4-inspector-tabs">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={tab === value ? "is-active" : ""}
            onClick={() => onTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="ws4-inspector-scroll">
        <section className="ws4-prerun-state">
          <div className="ws4-prerun-state-heading">
            <strong>{tabs.find(([value]) => value === tab)?.[1]}</strong>
            <span>{current.count} 项已编译</span>
          </div>
          <p>{current.detail}</p>
          {current.names.length > 0 ? (
            <ul>
              {current.names.slice(0, 8).map((name, index) => (
                <li key={`${name}-${index}`}>{name}</li>
              ))}
            </ul>
          ) : (
            <div className="ws4-prerun-state-empty">
              当前资料尚未提供此类实体
            </div>
          )}
          {current.names.length > 8 && (
            <small>还有 {current.names.length - 8} 项将在推演中展开</small>
          )}
        </section>
      </div>
    </aside>
  );
}

function Inspector({
  branch,
  baseline,
  tab,
  onTab,
  selectedEvent,
  focus,
  onFocus,
  snapshotLabel,
  snapshotTime,
  pendingRound,
}: {
  branch: SimulationBranch;
  baseline: WorldSimulationBaseline;
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  selectedEvent: SimulationEvent | null;
  focus: InspectorEntityFocus | null;
  onFocus: (focus: InspectorEntityFocus) => void;
  snapshotLabel: string;
  snapshotTime: string;
  pendingRound: boolean;
}) {
  const tabs: readonly [InspectorTab, string][] = [
    ["characters", "人物"],
    ["factions", "势力"],
    ["regions", "地域"],
    ["world", "世界"],
  ];
  return (
    <aside className="ws4-inspector">
      <div className="ws4-panel-heading ws4-inspector-heading">
        <div>
          <small>状态检查器</small>
          <strong>当前时间点</strong>
          <p>选择轮次或事件，查看该时刻可追溯的实体状态。</p>
        </div>
      </div>
      <div className="ws4-inspector-snapshot">
        <small>状态快照</small>
        <strong>{pendingRound ? `待结算至 ${snapshotTime}` : snapshotTime}</strong>
      </div>
      <div className="ws4-inspector-focus">
        <small>
          {pendingRound
            ? "下一轮窗口"
            : selectedEvent
              ? "当前事件"
              : "当前快照"}
        </small>
        <strong>
          {pendingRound
            ? "等待下一次结算"
            : (selectedEvent?.title ?? snapshotLabel)}
        </strong>
        <span>
          {pendingRound
            ? `结算终点：${snapshotTime}`
            : (selectedEvent?.time.displayText ?? snapshotTime)}
        </span>
      </div>
      {selectedEvent && (
        <div className="ws4-inspector-change">
          <div>
            <small>本轮事件影响</small>
            <strong>{selectedEvent.commands.length} 项状态写入</strong>
          </div>
          {selectedEvent.commands.length > 0 ? (
            <ul>
              {selectedEvent.commands.slice(0, 4).map((command, index) => (
                <li key={command.type + "-" + index}>
                  {commandLabel(command, baseline)}
                </li>
              ))}
            </ul>
          ) : (
            <span>本事件只记录叙事或规则命中，没有直接状态写入。</span>
          )}
          {selectedEvent.commands.length > 4 && (
            <span>其余 {selectedEvent.commands.length - 4} 项见事件证据。</span>
          )}
        </div>
      )}
      {focus && (
        <div className="ws4-inspector-entity-focus">
          <small>状态焦点</small>
          <strong>{focus.name}</strong>
          <span>点击其他实体可切换焦点，当前轮次快照保持不变。</span>
        </div>
      )}
      <div className="ws4-inspector-tabs">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={tab === value ? "is-active" : ""}
            onClick={() => onTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="ws4-inspector-scroll">
        {tab === "characters" && (
          <CharacterStateList
            branch={branch}
            baseline={baseline}
            selectedEvent={selectedEvent}
            focus={focus}
            onFocus={onFocus}
          />
        )}
        {tab === "factions" && (
          <FactionStateList
            branch={branch}
            baseline={baseline}
            selectedEvent={selectedEvent}
            focus={focus}
            onFocus={onFocus}
          />
        )}
        {tab === "regions" && (
          <RegionStateList
            branch={branch}
            baseline={baseline}
            selectedEvent={selectedEvent}
            focus={focus}
            onFocus={onFocus}
          />
        )}
        {tab === "world" && <WorldState branch={branch} baseline={baseline} />}
      </div>
    </aside>
  );
}

function CharacterStateList({
  branch,
  baseline,
  selectedEvent,
  focus,
  onFocus,
}: {
  branch: SimulationBranch;
  baseline: WorldSimulationBaseline;
  selectedEvent: SimulationEvent | null;
  focus: InspectorEntityFocus | null;
  onFocus: (focus: InspectorEntityFocus) => void;
}) {
  const eventIds = new Set(selectedEvent?.characterIds ?? []);
  const ids = branch.state.characters
    .map((item) => item.id)
    .sort(
      (left, right) =>
        Number(eventIds.has(right)) - Number(eventIds.has(left)),
    );
  const daysPerYear =
    baseline.calendar.daysPerMonth * baseline.calendar.monthsPerYear;
  const emergentCharacters = (branch.state.emergentEntities ?? []).filter(
    (entity) => entity.kind === "character",
  );
  return (
    <div className="ws4-state-list">
      {ids.map((id) => {
        const state = branch.state.characters.find((item) => item.id === id);
        const base = baseline.characters.find((item) => item.id === id);
        if (!state || !base) return null;
        const resourceEntries = Object.entries(
          state.resourceBalances ?? base.cultivation.resourceBalances,
        ).slice(0, 2);
        const relation = state.relations?.[0];
        const relationTarget = relation
          ? (baseline.characters.find(
              (item) => item.id === relation.targetCharacterId,
            )?.name ?? relation.targetCharacterId)
          : null;
        return (
          <article
            key={id}
            className={[
              !state.alive ? "is-dead" : "",
              focus?.kind === "characters" && focus.id === id
                ? "is-focused"
                : "",
              eventIds.has(id) ? "is-involved" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            role="button"
            tabIndex={0}
            onClick={() =>
              onFocus({
                kind: "characters",
                id,
                name: base.name,
              })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onFocus({ kind: "characters", id, name: base.name });
              }
            }}
          >
            <div className="ws4-state-title">
              <span className="ws4-avatar">{base.name.slice(0, 1)}</span>
              <span>
                <strong>{base.name}</strong>
                <small>
                  {state.alive ? state.status : "已离世"} · 人物 ·{" "}
                  {state.locationId
                    ? entityName(baseline, "region", state.locationId)
                    : "位置未定"}
                </small>
              </span>
              <em>{base.cultivation.levelName || "凡人"}</em>
            </div>
            <dl>
              <div>
                <dt>位置</dt>
                <dd>
                  {state.locationId
                    ? entityName(baseline, "region", state.locationId)
                    : "未知"}
                </dd>
              </div>
              <div>
                <dt>年龄</dt>
                <dd>
                  {Math.floor(Number(state.ageDays) / daysPerYear)} /{" "}
                  {base.lifespanYears ?? "?"} 年
                </dd>
              </div>
              <div>
                <dt>意图</dt>
                <dd>{state.intent || "维持现状"}</dd>
              </div>
              <div>
                <dt>记忆</dt>
                <dd>{state.memory?.length ?? state.knowledgeIds.length} 条</dd>
              </div>
              <div>
                <dt>修炼</dt>
                <dd>
                  {base.cultivation.levelName || "凡人"} ·{" "}
                  {Math.round(state.cultivationProgress)}%
                </dd>
              </div>
              {resourceEntries.map(([resourceId, value]) => (
                <div key={resourceId}>
                  <dt>资源 · {resourceId}</dt>
                  <dd>{Math.round(value)}</dd>
                </div>
              ))}
              {relation && (
                <div>
                  <dt>关系</dt>
                  <dd>
                    对{relationTarget}：信任 {Math.round(relation.trust)}
                  </dd>
                </div>
              )}
            </dl>
            <div className="ws4-progress-track" aria-label="修炼进度">
              <i
                style={{
                  width: `${Math.max(0, Math.min(100, state.cultivationProgress))}%`,
                }}
              />
            </div>
          </article>
        );
      })}
      {emergentCharacters.map((entity) => (
        <article
          key={entity.id}
          className={[
            "ws4-emergent-card",
            focus?.kind === "characters" && focus.id === entity.id
              ? "is-focused"
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
          role="button"
          tabIndex={0}
          onClick={() =>
            onFocus({ kind: "characters", id: entity.id, name: entity.name })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onFocus({
                kind: "characters",
                id: entity.id,
                name: entity.name,
              });
            }
          }}
        >
          <div className="ws4-state-title">
            <span className="ws4-avatar is-emergent">人</span>
            <span>
              <strong>{entity.name}</strong>
              <small>
                新生人物 ·{" "}
                {entity.regionId
                  ? entityName(baseline, "region", entity.regionId)
                  : "世界范围"}
              </small>
            </span>
            <em>{entity.status}</em>
          </div>
          <p>{entity.origin}</p>
        </article>
      ))}
      {ids.length === 0 && emergentCharacters.length === 0 && (
        <div className="ws4-state-empty">
          <Users />
          <strong>当前没有人物状态</strong>
          <span>推演范围内尚未编译可观察人物，或人物已被范围筛选排除。</span>
        </div>
      )}
    </div>
  );
}

function FactionStateList({
  branch,
  baseline,
  selectedEvent,
  focus,
  onFocus,
}: {
  branch: SimulationBranch;
  baseline: WorldSimulationBaseline;
  selectedEvent: SimulationEvent | null;
  focus: InspectorEntityFocus | null;
  onFocus: (focus: InspectorEntityFocus) => void;
}) {
  const emergentFactions = (branch.state.emergentEntities ?? []).filter(
    (entity) => entity.kind === "faction",
  );
  const eventIds = new Set(selectedEvent?.factionIds ?? []);
  const factions = [...branch.state.factions].sort(
    (left, right) =>
      Number(eventIds.has(right.id)) - Number(eventIds.has(left.id)),
  );
  return (
    <div className="ws4-state-list">
      {factions.map((state) => {
        const base = baseline.factions.find((item) => item.id === state.id);
        if (!base) return null;
        const relation = state.relations?.[0];
        const relationTarget = relation
          ? (baseline.factions.find(
              (item) => item.id === relation.targetFactionId,
            )?.name ?? relation.targetFactionId)
          : null;
        const resource = base.resources[0];
        return (
          <article
            key={state.id}
            className={[
              eventIds.has(state.id) ? "is-involved" : "",
              focus?.kind === "factions" && focus.id === state.id
                ? "is-focused"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
            role="button"
            tabIndex={0}
            onClick={() =>
              onFocus({
                kind: "factions",
                id: state.id,
                name: base.name,
              })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onFocus({ kind: "factions", id: state.id, name: base.name });
              }
            }}
          >
            <div className="ws4-state-title">
              <span className="ws4-avatar is-faction">
                {base.name.slice(0, 1)}
              </span>
              <span>
                <strong>{base.name}</strong>
                <small>
                  {FACTION_LIFECYCLE_LABELS[state.lifecycle]} · 势力
                </small>
              </span>
              <em>{state.strategy}</em>
            </div>
            <div className="ws4-metric-grid">
              <span>
                军力 <b>{Math.round(state.military)}</b>
              </span>
              <span>
                经济 <b>{Math.round(state.economy)}</b>
              </span>
              <span>
                民望 <b>{Math.round(state.publicSupport)}</b>
              </span>
              <span>
                领土 <b>{Math.round(state.territorialIntegrity)}</b>
              </span>
            </div>
            <dl className="ws4-compact-facts">
              {resource && (
                <div>
                  <dt>争夺资源</dt>
                  <dd>{resource.name}</dd>
                </div>
              )}
              {relation && (
                <div>
                  <dt>外交</dt>
                  <dd>
                    对{relationTarget}：关系 {Math.round(relation.sentiment)}
                  </dd>
                </div>
              )}
            </dl>
          </article>
        );
      })}
      {emergentFactions.map((entity) => (
        <article
          key={entity.id}
          className={[
            "ws4-emergent-card",
            focus?.kind === "factions" && focus.id === entity.id
              ? "is-focused"
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
          role="button"
          tabIndex={0}
          onClick={() =>
            onFocus({ kind: "factions", id: entity.id, name: entity.name })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onFocus({ kind: "factions", id: entity.id, name: entity.name });
            }
          }}
        >
          <div className="ws4-state-title">
            <span className="ws4-avatar is-emergent">势</span>
            <span>
              <strong>{entity.name}</strong>
              <small>
                新生势力 ·{" "}
                {entity.regionId
                  ? entityName(baseline, "region", entity.regionId)
                  : "世界范围"}
              </small>
            </span>
            <em>{entity.status}</em>
          </div>
          <p>{entity.origin}</p>
        </article>
      ))}
      {branch.state.factions.length === 0 && emergentFactions.length === 0 && (
        <div className="ws4-state-empty">
          <Users />
          <strong>当前没有势力状态</strong>
          <span>
            推演范围内尚未编译可观察势力，长跨度的新生组织会在此出现。
          </span>
        </div>
      )}
    </div>
  );
}

function RegionStateList({
  branch,
  baseline,
  selectedEvent,
  focus,
  onFocus,
}: {
  branch: SimulationBranch;
  baseline: WorldSimulationBaseline;
  selectedEvent: SimulationEvent | null;
  focus: InspectorEntityFocus | null;
  onFocus: (focus: InspectorEntityFocus) => void;
}) {
  const eventIds = new Set(selectedEvent?.regionIds ?? []);
  const regions = [...branch.state.regions].sort(
    (left, right) =>
      Number(eventIds.has(right.id)) - Number(eventIds.has(left.id)),
  );
  return (
    <div className="ws4-state-list">
      {regions.map((state) => (
        <article
          key={state.id}
          className={[
            eventIds.has(state.id) ? "is-involved" : "",
            focus?.kind === "regions" && focus.id === state.id
              ? "is-focused"
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
          role="button"
          tabIndex={0}
          onClick={() =>
            onFocus({
              kind: "regions",
              id: state.id,
              name: entityName(baseline, "region", state.id),
            })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onFocus({
                kind: "regions",
                id: state.id,
                name: entityName(baseline, "region", state.id),
              });
            }
          }}
        >
          <div className="ws4-state-title">
            <span className="ws4-avatar is-region">⌂</span>
            <span>
              <strong>{entityName(baseline, "region", state.id)}</strong>
              <small>
                {state.controllingFactionIds.length ? "有势力控制" : "无主地域"}
              </small>
            </span>
            <em>压力 {Math.round(state.pressure)}</em>
          </div>
          <div className="ws4-metric-grid">
            <span>
              稳定 <b>{Math.round(state.stability)}</b>
            </span>
            <span>
              经济 <b>{Math.round(state.economy)}</b>
            </span>
            <span>
              人口 <b>{Math.round(state.population)}</b>
            </span>
            <span>
              灵气 <b>{Math.round(state.cultivation)}</b>
            </span>
          </div>
        </article>
      ))}
      {branch.state.regions.length === 0 && (
        <div className="ws4-state-empty">
          <Orbit />
          <strong>当前没有地域状态</strong>
          <span>
            当前没有地域资料，系统会继续推进世界时钟；补充世界架构后，新建推演即可看到地域变化。
          </span>
        </div>
      )}
    </div>
  );
}

function WorldState({
  branch,
  baseline,
}: {
  branch: SimulationBranch;
  baseline: WorldSimulationBaseline;
}) {
  return (
    <div className="ws4-world-state">
      <div className="ws4-world-clock">
        <Clock3 />
        <span>
          <small>当前世界时间</small>
          <strong>{branch.state.currentTime.displayText}</strong>
        </span>
      </div>
      <dl>
        <div>
          <dt>纪元阶段</dt>
          <dd>{EPOCH_STAGE_LABELS[branch.state.epoch.stage]}</dd>
        </div>
        <div>
          <dt>人口指数</dt>
          <dd>{Math.round(branch.state.epoch.populationIndex)}</dd>
        </div>
        <div>
          <dt>文明指数</dt>
          <dd>{Math.round(branch.state.epoch.civilizationIndex)}</dd>
        </div>
        <div>
          <dt>法则稳定</dt>
          <dd>{Math.round(branch.state.epoch.lawStability)}</dd>
        </div>
        <div>
          <dt>已编译规则</dt>
          <dd>{baseline.rules.length}</dd>
        </div>
        <div>
          <dt>待传播影响</dt>
          <dd>{branch.state.scheduledEffects.length}</dd>
        </div>
      </dl>
      {branch.warnings.length > 0 && (
        <div className="ws4-warning-list">
          <AlertTriangle />
          {branch.warnings.slice(-3).map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
      {(branch.state.emergentEntities?.length ?? 0) > 0 && (
        <section className="ws4-emergent-list">
          <div className="ws4-section-heading">
            <span>本分支新生主体</span>
            <small>{branch.state.emergentEntities?.length ?? 0} 个</small>
          </div>
          {branch.state.emergentEntities?.slice(-6).map((entity) => (
            <article key={entity.id}>
              <span className="ws4-avatar is-emergent">
                {entity.kind === "character"
                  ? "人"
                  : entity.kind === "faction"
                    ? "势"
                    : "制"}
              </span>
              <span>
                <strong>{entity.name}</strong>
                <small>
                  {entity.regionId
                    ? entityName(baseline, "region", entity.regionId)
                    : "世界范围"}
                  {" · "}
                  {entity.status}
                </small>
              </span>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

function CouncilDrawer({
  branch,
  baseline,
  sessions,
  onClose,
  onCreate,
  onSelect,
  onCommit,
}: {
  branch: SimulationBranch;
  baseline: WorldSimulationBaseline;
  sessions: readonly CouncilSession[];
  onClose: () => void;
  onCreate: (eventId: string | null, question: string) => void;
  onSelect: (sessionId: string, optionId: string) => void;
  onCommit: (sessionId: string, optionId: string) => void;
}) {
  const latest =
    sessions.filter((session) => session.branchId === branch.id).at(-1) ?? null;
  const [question, setQuestion] =
    useState("各方在当前局势下会如何选择下一步？");
  const [eventId, setEventId] = useState(branch.ledger.at(-1)?.id ?? "");
  const [activeParticipant, setActiveParticipant] = useState(0);
  const hasParticipants =
    branch.state.characters.some((item) => item.alive) ||
    branch.state.factions.some((item) => item.lifecycle !== "dissolved");
  const stance =
    latest?.stances[activeParticipant] ?? latest?.stances[0] ?? null;
  const selected =
    latest?.options.find((option) => option.id === latest.selectedOptionId) ??
    null;
  return (
    <div className="ws4-drawer-backdrop">
      <aside className="ws4-drawer" role="dialog" aria-modal="true">
        <header className="ws4-drawer-header">
          <div>
            <small>立场会商</small>
            <h2>让各方先说出自己的打算</h2>
            <p>会商只读取各方自己的知识、目标和资源，结论仍是候选。</p>
          </div>
          <IconButton label="关闭会商" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        {!latest ? (
          <section className="ws4-council-create">
            <div className="ws4-council-lead">
              <BrainCircuit />
              <strong>建立局势会商</strong>
              <p>选择一个已发生事件，生成受知识边界约束的立场。</p>
            </div>
            <label>
              讨论事件
              <select
                value={eventId}
                onChange={(event) => setEventId(event.target.value)}
              >
                <option value="">当前世界状态</option>
                {branch.ledger
                  .slice()
                  .reverse()
                  .map((event) => (
                    <option key={event.id} value={event.id}>
                      {event.time.displayText} · {event.title}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              会商问题
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
              />
            </label>
            {!hasParticipants && (
              <p className="ws4-modal-warning">
                <AlertTriangle />
                当前没有可会商主体。
              </p>
            )}
            <button
              type="button"
              className="ws4-button is-primary"
              disabled={!hasParticipants}
              onClick={() => onCreate(eventId || null, question)}
            >
              <Sparkles />
              生成各方立场
            </button>
          </section>
        ) : (
          <div className="ws4-council-body">
            <aside className="ws4-council-participants">
              <div className="ws4-section-heading">
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
                  <span className="ws4-avatar">
                    {participantName(baseline, item).slice(0, 1)}
                  </span>
                  <span>
                    <strong>{participantName(baseline, item)}</strong>
                    <small>{item.goal}</small>
                  </span>
                  <ChevronRight />
                </button>
              ))}
              <p>
                <ShieldCheck />
                每方只看到自己的知识投影
              </p>
            </aside>
            <section className="ws4-council-main">
              {stance ? (
                <div className="ws4-stance">
                  <div className="ws4-stance-heading">
                    <span className="ws4-avatar">
                      {participantName(baseline, stance).slice(0, 1)}
                    </span>
                    <div>
                      <small>当前立场</small>
                      <h3>{stance.position}</h3>
                      <p>{stance.goal}</p>
                    </div>
                  </div>
                  <div className="ws4-stance-columns">
                    <section>
                      <h4>已知事实</h4>
                      {stance.knownFactIds.length ? (
                        stance.knownFactIds.map((id) => <p key={id}>· {id}</p>)
                      ) : (
                        <p>· 仅掌握公开局势与自身信息</p>
                      )}
                    </section>
                    <section>
                      <h4>底线与风险</h4>
                      {stance.risks.length ? (
                        stance.risks.map((risk) => <p key={risk}>· {risk}</p>)
                      ) : (
                        <p>· 不接受无成本决策</p>
                      )}
                    </section>
                  </div>
                </div>
              ) : (
                <div className="ws4-empty">
                  <Users />
                  没有可会商主体
                </div>
              )}
              <div className="ws4-section-heading">
                <span>候选方案</span>
                <button
                  type="button"
                  className="ws4-text-button"
                  onClick={() => onCreate(eventId || null, question)}
                >
                  <RefreshCw />
                  重新生成
                </button>
              </div>
              <div className="ws4-council-options">
                {latest.options.map((option, index) => (
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
                ))}
              </div>
            </section>
            <aside className="ws4-council-review">
              <div className="ws4-section-heading">
                <span>方案审阅</span>
                {selected && <b>{selected.score}</b>}
              </div>
              {selected ? (
                <>
                  <h3>{selected.title}</h3>
                  <h4>会改变什么</h4>
                  {selected.commands.map((command, index) => (
                    <p key={`${command.type}-${index}`}>
                      {commandLabel(command, baseline)}
                    </p>
                  ))}
                  <h4>收益</h4>
                  {selected.benefits.map((item) => (
                    <p key={item}>
                      <Check />
                      {item}
                    </p>
                  ))}
                  <h4>成本</h4>
                  {selected.costs.map((item) => (
                    <p key={item}>
                      <AlertTriangle />
                      {item}
                    </p>
                  ))}
                  <div className="ws4-policy">
                    <ShieldCheck />
                    <span>
                      <strong>仍是候选</strong>
                      <small>确认后创建新的干预分支。</small>
                    </span>
                  </div>
                  <button
                    type="button"
                    className="ws4-button is-primary"
                    onClick={() => onCommit(latest.id, selected.id)}
                  >
                    <GitFork />
                    创建干预分支
                  </button>
                </>
              ) : (
                <div className="ws4-empty">
                  <Scale />
                  选择一个方案
                </div>
              )}
            </aside>
          </div>
        )}
      </aside>
    </div>
  );
}

function participantName(
  baseline: WorldSimulationBaseline,
  stance: CouncilStance,
): string {
  return stance.participantType === "character"
    ? entityName(baseline, "character", stance.participantId)
    : entityName(baseline, "faction", stance.participantId);
}

export default function WorldSimulationWorkbench({
  storage,
  isActive,
  onRunModelScene,
}: WorldSimulationWorkbenchProps) {
  const controller = useWorldSimulationController({
    storage,
    isActive,
    onRunModelScene,
  });
  const baseline = controller.baseline;
  const run = controller.run;
  const branch = controller.branch;
  const visibleControllerError = displayWorldSimulationError(controller.error);
  const showControllerError =
    Boolean(visibleControllerError) &&
    !visibleControllerError?.includes("资料已在其他窗口或磁盘中更新");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] =
    useState<WorldSimulationScenario | null>(null);
  const [councilOpen, setCouncilOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [analysisDrawer, setAnalysisDrawer] =
    useState<AnalysisDrawerKind | null>(null);
  const [selectedRoundId, setSelectedRoundId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("characters");
  const [inspectorFocus, setInspectorFocus] =
    useState<InspectorEntityFocus | null>(null);
  const [roundCount, setRoundCount] = useState(3);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("stage");
  const previousRoundCount = useRef(0);
  const previousTimelineKey = useRef<string | null>(null);
  const rounds = useMemo(
    () =>
      branch && baseline && run
        ? buildRounds(branch, run, baseline.calendar)
        : [],
    [baseline, branch, run],
  );
  const timelineKey = `${run?.id ?? "none"}:${branch?.id ?? "none"}`;
  useEffect(() => {
    const latest = rounds.filter((round) => !round.pending).at(-1);
    if (!latest) {
      previousRoundCount.current = 0;
      previousTimelineKey.current = timelineKey;
      return;
    }
    const timelineChanged = previousTimelineKey.current !== timelineKey;
    const hasNewRound = rounds.length > previousRoundCount.current;
    const selectionWasRemoved = !rounds.some(
      (round) => round.id === selectedRoundId,
    );
    previousTimelineKey.current = timelineKey;
    previousRoundCount.current = rounds.length;
    if (timelineChanged || hasNewRound || selectionWasRemoved) {
      setSelectedRoundId(latest.id);
      setSelectedEventId(latest.events[0]?.id ?? null);
    }
  }, [rounds, selectedRoundId, timelineKey]);
  useEffect(() => {
    if (
      branch &&
      selectedEventId &&
      !branch.ledger.some((event) => event.id === selectedEventId)
    )
      setSelectedEventId(branch.ledger.at(-1)?.id ?? null);
  }, [branch, selectedEventId]);
  const selectedRound = rounds.find((round) => round.id === selectedRoundId);
  const selectedEvent = selectedRound?.pending
    ? null
    : selectedRound
      ? (selectedRound.events.find((event) => event.id === selectedEventId) ??
        selectedRound.events.at(-1) ??
        null)
      : (branch?.ledger.find((event) => event.id === selectedEventId) ??
        (selectedRoundId ? null : (branch?.ledger.at(-1) ?? null)));
  useEffect(() => {
    setInspectorFocus(
      selectedEvent && baseline
        ? focusForSimulationEvent(selectedEvent, baseline)
        : null,
    );
  }, [baseline, selectedEvent?.id]);
  if (!baseline)
    return (
      <div className="ws4-loading">
        <Orbit className="ws4-spin" />
        <strong>正在编译世界投影</strong>
        <span>
          {visibleControllerError ??
            "人物、势力、地域、修炼、物品与时间线正在对齐"}
        </span>
        <button
          type="button"
          className="ws4-button"
          onClick={() => void controller.refresh().catch(() => undefined)}
        >
          <RefreshCw />
          重试
        </button>
      </div>
    );
  const runs = controller.runIndex?.value.runs ?? [];
  const inspectedBranch =
    branch && selectedRound
      ? { ...branch, state: selectedRound.state }
      : branch;
  const snapshotLabel = selectedRound
    ? `第 ${selectedRound.index} 轮结束状态`
    : "当前状态";
  const selectRound = (roundId: string) => {
    setSelectedRoundId(roundId);
    const round = rounds.find((item) => item.id === roundId);
    setSelectedEventId(round?.events[0]?.id ?? null);
  };
  const selectEvent = (eventId: string) => {
    setSelectedEventId(eventId);
    const event = branch?.ledger.find((item) => item.id === eventId);
    if (event) {
      const round = rounds.find((item) =>
        item.events.some((entry) => entry.id === eventId),
      );
      if (round) setSelectedRoundId(round.id);
      setInspectorTab(
        event.characterIds.length
          ? "characters"
          : event.factionIds.length
            ? "factions"
            : event.regionIds.length
              ? "regions"
              : "world",
      );
      setInspectorFocus(focusForSimulationEvent(event, baseline));
    }
  };
  const handleNew = () => {
    void controller
      .createScenarioDraft()
      .then((draft) => {
        setSettingsDraft(draft);
        setSettingsOpen(true);
      })
      .catch(() => undefined);
  };
  const handleOpenSettings = () => {
    setSettingsDraft(controller.scenario);
    setSettingsOpen(true);
  };
  const handleCloseSettings = () => {
    setSettingsDraft(null);
    setSettingsOpen(false);
  };
  const handleCreateFromSettings = () => {
    const draft = settingsDraft;
    if (!draft) return;
    void controller
      .createRun(draft)
      .then(handleCloseSettings)
      .catch(() => undefined);
  };
  const handleCreate = () => {
    void controller.createRun().catch(() => undefined);
  };
  const handleRounds = () => {
    void (async () => {
      for (let index = 0; index < roundCount; index += 1) {
        if (controller.busy) break;
        await controller.advanceOne();
      }
    })().catch(() => undefined);
  };
  const handleAdopt = () => {
    if (!selectedEvent) return;
    void controller
      .createAdoptionProposal([selectedEvent.id], "planned")
      .then(() => setReviewOpen(true))
      .catch(() => undefined);
  };
  const handleReport = () => {
    void controller
      .generateReport()
      .then(() => setAnalysisDrawer(null))
      .catch(() => undefined);
  };
  const handleFork = () => {
    if (!selectedEvent) return;
    void controller
      .forkAt(selectedEvent.id)
      .then(() => setAnalysisDrawer(null))
      .catch(() => undefined);
  };
  const handleComparison = () => {
    void controller
      .createNaturalComparison()
      .then(() => setAnalysisDrawer(null))
      .catch(() => undefined);
  };
  return (
    <div className="ws4-root">
      <Header
        baseline={baseline}
        run={run}
        branch={branch}
        selectedRound={selectedRound ?? null}
        runs={runs}
        busy={controller.busy}
        onSelectRun={(id) =>
          void controller.selectRun(id).catch(() => undefined)
        }
        onSelectRunBranch={(runId, branchId) =>
          void controller.selectRunBranch(runId, branchId).catch(() => undefined)
        }
        onRemoveRun={(id) =>
          void controller.removeRun(id).catch(() => undefined)
        }
        onNew={handleNew}
        onSettings={handleOpenSettings}
        onRefresh={() => void controller.refresh().catch(() => undefined)}
        onAdvance={() => void controller.advanceOne().catch(() => undefined)}
        onRunRounds={handleRounds}
        roundCount={roundCount}
        onRoundCountChange={setRoundCount}
        onPause={() => void controller.pauseRun().catch(() => undefined)}
        onCancel={() => void controller.cancelRun().catch(() => undefined)}
        onCouncil={() => setCouncilOpen(true)}
        onSelectBranch={(branchId) =>
          void controller.switchBranch(branchId).catch(() => undefined)
        }
        onCreateComparison={() =>
          void controller.createNaturalComparison().catch(() => undefined)
        }
        onMore={() => setAnalysisDrawer("operations")}
        progress={controller.progress}
      />
      {(showControllerError ||
        controller.modelWarning ||
        controller.sourceDriftWarning) && (
        <div
          className={showControllerError ? "ws4-alert is-error" : "ws4-alert"}
          role="alert"
        >
          <AlertTriangle />
          <div className="ws4-alert-copy">
            {showControllerError && visibleControllerError && (
              <span>{visibleControllerError}</span>
            )}
            {controller.modelWarning && <span>{controller.modelWarning}</span>}
            {controller.sourceDriftWarning && (
              <span>{controller.sourceDriftWarning}</span>
            )}
          </div>
          {showControllerError && (
            <button
              type="button"
              className="ws4-text-button"
              onClick={() => void controller.refresh().catch(() => undefined)}
              disabled={controller.busy}
            >
              <RefreshCw className={controller.busy ? "ws4-spin" : ""} />
              重新载入
            </button>
          )}
        </div>
      )}
      <MobilePanelTabs value={mobilePanel} onChange={setMobilePanel} />
      <div className={`ws4-body is-mobile-${mobilePanel}`}>
        <Timeline
          rounds={rounds}
          selectedEventId={selectedEvent?.id ?? null}
          selectedRoundId={selectedRoundId}
          onRound={selectRound}
          onEvent={selectEvent}
          calendar={baseline.calendar}
          progress={controller.progress}
        />
        {run && branch ? (
          <Stage
            run={run}
            branch={branch}
            baseline={baseline}
            selectedEvent={selectedEvent}
            rounds={rounds}
            selectedRoundId={selectedRoundId}
            onEvent={selectEvent}
            onInspectorTab={setInspectorTab}
            onCouncil={() => setCouncilOpen(true)}
            onCausal={() => setAnalysisDrawer("causal")}
            onFork={() => {
              if (selectedEvent)
                void controller.forkAt(selectedEvent.id).catch(() => undefined);
            }}
            onGuardrail={() => setAnalysisDrawer("guardrail")}
            onLead={() => setAnalysisDrawer("lead")}
            onAdopt={handleAdopt}
            onAdvance={() =>
              void controller.advanceOne().catch(() => undefined)
            }
            reports={run.reports}
            onReport={() =>
              void controller.generateReport().catch(() => undefined)
            }
            busy={controller.busy}
            progress={controller.progress}
          />
        ) : (
          <PreRunStage
            busy={controller.busy}
            onStart={handleCreate}
          />
        )}
        {inspectedBranch ? (
          <Inspector
            branch={inspectedBranch}
            baseline={baseline}
            tab={inspectorTab}
            onTab={setInspectorTab}
            selectedEvent={selectedEvent}
            focus={inspectorFocus}
            onFocus={(nextFocus) => {
              setInspectorFocus(nextFocus);
              setInspectorTab(nextFocus.kind);
            }}
            snapshotLabel={snapshotLabel}
            snapshotTime={
              selectedRound?.pending
                ? formatWorldInstant(selectedRound.end, baseline.calendar)
                : (selectedRound?.state.currentTime.displayText ??
                  inspectedBranch.state.currentTime.displayText)
            }
            pendingRound={selectedRound?.pending === true}
          />
        ) : (
          <PreRunInspector
            baseline={baseline}
            tab={inspectorTab}
            onTab={setInspectorTab}
          />
        )}
      </div>
      {settingsOpen && (
        <SettingsDialog
          scenario={settingsDraft ?? controller.scenario}
          baseline={baseline}
          busy={controller.busy}
          onChange={setSettingsDraft}
          onCreate={handleCreateFromSettings}
          onClose={handleCloseSettings}
        />
      )}
      {analysisDrawer && run && branch && (
        <AnalysisDrawer
          kind={analysisDrawer}
          run={run}
          branch={branch}
          selectedEvent={selectedEvent}
          busy={controller.busy}
          onClose={() => setAnalysisDrawer(null)}
          onCreateComparison={handleComparison}
          onFork={handleFork}
          onCouncil={() => {
            setAnalysisDrawer(null);
            setCouncilOpen(true);
          }}
          onAdopt={() => {
            setAnalysisDrawer(null);
            handleAdopt();
          }}
          onReport={handleReport}
          onGuardrail={(guardrail) => {
            if (!selectedEvent) return;
            void controller
              .setGuardrail(selectedEvent.id, guardrail)
              .then(() => setAnalysisDrawer(null))
              .catch(() => undefined);
          }}
          onLead={(lead) => {
            if (!selectedEvent) return;
            void controller
              .setLead(selectedEvent.id, lead)
              .then(() => setAnalysisDrawer(null))
              .catch(() => undefined);
          }}
          onOpenLead={() => setAnalysisDrawer("lead")}
          onCancel={() => {
            void controller
              .cancelRun()
              .then(() => setAnalysisDrawer(null))
              .catch(() => undefined);
          }}
        />
      )}
      {councilOpen && run && branch && (
        <CouncilDrawer
          branch={branch}
          baseline={baseline}
          sessions={run.councilSessions}
          onClose={() => setCouncilOpen(false)}
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
              .then(() => setCouncilOpen(false))
              .catch(() => undefined)
          }
        />
      )}
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
