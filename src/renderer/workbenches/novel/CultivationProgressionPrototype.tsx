import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  BarChart3,
  ChevronRight,
  CircleDot,
  GitBranch,
  GripVertical,
  Layers3,
  Link2,
  Pencil,
  RefreshCw,
  Route,
  Sparkles,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import type {
  CultivationLevel,
  CultivationLevelSubStage,
  CultivationSystem,
  ProgressionTrack,
  TrackInteraction,
  Transition,
} from "../../../shared/workbenches/novel/cultivationEcologySchema";

type TrackMetric = ProgressionTrack["metrics"][number];
export type ProgressionView =
  | "levels"
  | "metrics"
  | "transitions"
  | "interactions";

type ViewSelection =
  | { kind: "track"; track: ProgressionTrack }
  | { kind: "level"; track: ProgressionTrack; level: CultivationLevel }
  | {
      kind: "stage";
      track: ProgressionTrack;
      level: CultivationLevel;
      stage: CultivationLevelSubStage;
    }
  | { kind: "metric"; track: ProgressionTrack; metric: TrackMetric }
  | { kind: "transition"; track: ProgressionTrack; transition: Transition }
  | {
      kind: "interaction";
      track: ProgressionTrack;
      interaction: TrackInteraction;
    };

export type CultivationProgressionViewSelection = ViewSelection;

const viewOptions: readonly {
  id: ProgressionView;
  label: string;
  icon: typeof Route;
}[] = [
  { id: "levels", label: "境界图", icon: Route },
  { id: "metrics", label: "指标", icon: BarChart3 },
  { id: "transitions", label: "转换", icon: GitBranch },
  { id: "interactions", label: "交叉规则", icon: Link2 },
];

function structureLabel(structure: ProgressionTrack["structure"]): string {
  switch (structure) {
    case "ordered":
      return "线性递进";
    case "branching":
      return "分支成长";
    case "cyclic":
      return "循环成长";
    case "free":
      return "自由组合";
  }
}

function metricModelLabel(model: TrackMetric["model"]): string {
  return {
    number: "固定数值",
    range: "区间",
    formula: "公式",
    descriptive: "描述判定",
  }[model];
}

function metricDirectionLabel(direction: TrackMetric["direction"]): string {
  return {
    "higher-better": "越高越优",
    "lower-better": "越低越优",
    neutral: "中性",
  }[direction];
}

function transitionTypeLabel(type: Transition["transitionType"]): string {
  return {
    breakthrough: "突破",
    conversion: "转换",
    awakening: "觉醒",
    degeneration: "退化",
  }[type];
}

function interactionKindLabel(kind: TrackInteraction["kind"]): string {
  return {
    synchronization: "同步约束",
    synergy: "协同效应",
    imbalance: "失衡惩罚",
    "cross-breakthrough": "跨轨突破",
    "resource-competition": "资源竞争",
    dependency: "轨道依赖",
  }[kind];
}

function resolveLevelName(
  track: ProgressionTrack,
  levelId: string | null,
): string {
  if (!levelId) return "轨道外部";
  return track.levels.find((item) => item.id === levelId)?.name ?? levelId;
}

function resolveTrackName(system: CultivationSystem, trackId: string): string {
  return (
    system.progressionTracks.find((item) => item.id === trackId)?.name ??
    trackId
  );
}

function DetailFacts({
  facts,
}: {
  readonly facts: readonly { label: string; value: string }[];
}) {
  return (
    <div className="cp-detail-facts">
      {facts.map((fact) => (
        <div key={fact.label}>
          <span>{fact.label}</span>
          <strong>{fact.value || "未定义"}</strong>
        </div>
      ))}
    </div>
  );
}

function DetailGroup({
  title,
  items,
  empty = "未定义",
  tone,
}: {
  readonly title: string;
  readonly items: readonly string[];
  readonly empty?: string;
  readonly tone?: "warning" | "cool";
}) {
  return (
    <section className={`cp-detail-group${tone ? ` is-${tone}` : ""}`}>
      <h4>{title}</h4>
      {items.length > 0 ? (
        <ul>
          {items.map((item, index) => (
            <li key={`${item}-${index}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <span className="cp-detail-empty-value">{empty}</span>
      )}
    </section>
  );
}

function ResourceRequirements({
  system,
  requirements,
}: {
  readonly system: CultivationSystem;
  readonly requirements: CultivationLevel["resourceRequirements"];
}) {
  return (
    <DetailGroup
      title="资源需求"
      items={requirements.map((item) => {
        const resource = system.resources.find(
          (candidate) => candidate.id === item.resourceId,
        );
        return `${resource?.name ?? item.resourceId} · ${item.quantity || "数量未定"} · ${item.consumed ? "消耗" : "不消耗"}${item.missingConsequence ? ` · 缺失：${item.missingConsequence}` : ""}`;
      })}
    />
  );
}

function ReferenceGroup({
  title,
  ids,
  resolve,
}: {
  readonly title: string;
  readonly ids: readonly string[];
  readonly resolve: (id: string) => string;
}) {
  return <DetailGroup title={title} items={ids.map(resolve)} />;
}

function SelectionDetails({
  system,
  selection,
  onEdit,
}: {
  readonly system: CultivationSystem;
  readonly selection: ViewSelection;
  readonly onEdit?: (selection: ViewSelection) => void;
}) {
  const resolveMetric = (track: ProgressionTrack, metricId: string) =>
    track.metrics.find((item) => item.id === metricId)?.name ?? metricId;
  const resolveAbility = (id: string) =>
    system.abilities.find((item) => item.id === id)?.name ?? id;
  const resolveMethod = (id: string) =>
    system.methods.find((item) => item.id === id)?.name ?? id;

  let kindLabel = "轨道";
  let eyebrow = "当前成长轨道";
  let title = selection.track.name;
  let description = selection.track.summary || "尚未填写轨道说明。";
  let facts: readonly { label: string; value: string }[] = [
    { label: "成长方式", value: selection.track.mode },
    { label: "轨道结构", value: structureLabel(selection.track.structure) },
    { label: "境界数量", value: `${selection.track.levels.length} 个` },
    { label: "突破转换", value: `${selection.track.transitions.length} 条` },
  ];
  let body: ReactNode = (
    <>
      <DetailGroup
        title="指标定义"
        items={selection.track.metrics.map(
          (item) => `${item.name} · ${item.baseline || "无基线"} ${item.unit}`,
        )}
      />
      <DetailGroup
        title="境界序列"
        items={selection.track.levels.map(
          (item, index) => `${index + 1}. ${item.name}`,
        )}
      />
    </>
  );

  if (selection.kind === "level") {
    const { track, level } = selection;
    kindLabel = "境界";
    eyebrow = `${track.name} / 第 ${level.order + 1} 境界`;
    title = level.name;
    description = level.summary || "尚未填写境界说明。";
    facts = [
      { label: "阶段类型", value: level.stageType },
      { label: "阶段质量", value: level.quality },
      { label: "境内阶段", value: `${level.subStages.length} 个` },
      { label: "突破结果", value: level.breakthroughResult },
    ];
    body = (
      <>
        <DetailGroup
          title="指标门槛"
          items={level.metricThresholds.map(
            (item) =>
              `${resolveMetric(track, item.metricId)}：${item.threshold}`,
          )}
        />
        <DetailGroup title="进入条件" items={level.entryConditions} />
        <DetailGroup title="维持条件" items={level.maintenanceConditions} />
        <DetailGroup
          title="突破条件"
          items={level.breakthroughConditions}
          tone="cool"
        />
        <DetailGroup
          title="失败后果"
          items={level.failureConsequences}
          tone="warning"
        />
        <DetailGroup
          title="退化规则"
          items={level.degeneration ? [level.degeneration] : []}
          tone="warning"
        />
        <ResourceRequirements
          system={system}
          requirements={level.resourceRequirements}
        />
        <ReferenceGroup
          title="自然能力"
          ids={level.naturalAbilityIds}
          resolve={resolveAbility}
        />
        <ReferenceGroup
          title="关联法门"
          ids={level.methodIds}
          resolve={resolveMethod}
        />
      </>
    );
  } else if (selection.kind === "stage") {
    const { track, level, stage } = selection;
    kindLabel = "阶段";
    eyebrow = `${track.name} / ${level.name}`;
    title = stage.name;
    description = stage.summary || "尚未填写阶段说明。";
    facts = [
      { label: "阶段序位", value: `第 ${stage.order + 1} 阶段` },
      { label: "入场条件", value: `${stage.entryConditions.length} 条` },
      { label: "完成条件", value: `${stage.completionConditions.length} 条` },
      { label: "资源需求", value: `${stage.resourceRequirements.length} 项` },
    ];
    body = (
      <>
        <DetailGroup
          title="指标门槛"
          items={stage.metricThresholds.map(
            (item) =>
              `${resolveMetric(track, item.metricId)}：${item.threshold}`,
          )}
        />
        <DetailGroup title="进入条件" items={stage.entryConditions} />
        <DetailGroup
          title="完成条件"
          items={stage.completionConditions}
          tone="cool"
        />
        <ResourceRequirements
          system={system}
          requirements={stage.resourceRequirements}
        />
        <ReferenceGroup
          title="自然能力"
          ids={stage.naturalAbilityIds}
          resolve={resolveAbility}
        />
        <ReferenceGroup
          title="关联法门"
          ids={stage.methodIds}
          resolve={resolveMethod}
        />
      </>
    );
  } else if (selection.kind === "metric") {
    const { track, metric } = selection;
    const usages = track.levels.flatMap((level) => [
      ...level.metricThresholds
        .filter((item) => item.metricId === metric.id)
        .map((item) => `${level.name}：${item.threshold}`),
      ...level.subStages.flatMap((stage) =>
        stage.metricThresholds
          .filter((item) => item.metricId === metric.id)
          .map((item) => `${level.name} / ${stage.name}：${item.threshold}`),
      ),
    ]);
    kindLabel = "指标";
    eyebrow = `${track.name} / 数值指标`;
    title = metric.name;
    description = metric.summary || "尚未填写指标说明。";
    facts = [
      { label: "单位", value: metric.unit },
      { label: "判定模型", value: metricModelLabel(metric.model) },
      { label: "变化方向", value: metricDirectionLabel(metric.direction) },
      { label: "基线", value: metric.baseline },
    ];
    body = <DetailGroup title="境界与阶段门槛" items={usages} />;
  } else if (selection.kind === "transition") {
    const { track, transition } = selection;
    kindLabel = "转换";
    eyebrow = `${track.name} / ${resolveLevelName(track, transition.fromLevelId)} → ${resolveLevelName(track, transition.toLevelId)}`;
    title = transition.name;
    description = transition.summary || "尚未填写转换说明。";
    facts = [
      {
        label: "转换类型",
        value: transitionTypeLabel(transition.transitionType),
      },
      { label: "起点", value: resolveLevelName(track, transition.fromLevelId) },
      { label: "终点", value: resolveLevelName(track, transition.toLevelId) },
      { label: "可逆性", value: transition.reversible ? "可逆" : "不可逆" },
    ];
    body = (
      <>
        <DetailGroup title="触发条件" items={transition.conditions} />
        <DetailGroup
          title="成功规则"
          items={transition.successRule ? [transition.successRule] : []}
          tone="cool"
        />
        <DetailGroup
          title="成功结果"
          items={transition.successResult ? [transition.successResult] : []}
          tone="cool"
        />
        <DetailGroup
          title="失败结果"
          items={transition.failureResult ? [transition.failureResult] : []}
          tone="warning"
        />
        <DetailGroup
          title="永久后果"
          items={
            transition.permanentConsequence
              ? [transition.permanentConsequence]
              : []
          }
          tone="warning"
        />
        <DetailGroup
          title="质量继承"
          items={
            transition.qualityInheritance ? [transition.qualityInheritance] : []
          }
        />
        <DetailGroup
          title="退化状态"
          items={
            transition.degenerationState ? [transition.degenerationState] : []
          }
        />
        <ResourceRequirements
          system={system}
          requirements={transition.resourceRequirements}
        />
        <ReferenceGroup
          title="所需法门"
          ids={transition.methodIds}
          resolve={resolveMethod}
        />
      </>
    );
  } else if (selection.kind === "interaction") {
    const { interaction } = selection;
    kindLabel = "交叉规则";
    eyebrow = `${resolveTrackName(system, interaction.sourceTrackId)} → ${resolveTrackName(system, interaction.targetTrackId)}`;
    title = interaction.name;
    description = interaction.summary || "尚未填写交叉规则说明。";
    facts = [
      { label: "规则类型", value: interactionKindLabel(interaction.kind) },
      {
        label: "源轨道",
        value: resolveTrackName(system, interaction.sourceTrackId),
      },
      {
        label: "目标轨道",
        value: resolveTrackName(system, interaction.targetTrackId),
      },
      { label: "可逆性", value: interaction.reversible ? "可逆" : "不可逆" },
    ];
    body = (
      <>
        <DetailGroup
          title="规则正文"
          items={interaction.rule ? [interaction.rule] : []}
          tone="cool"
        />
        <DetailGroup title="触发条件" items={interaction.conditions} />
        <DetailGroup
          title="规则后果"
          items={interaction.consequence ? [interaction.consequence] : []}
          tone="warning"
        />
        <DetailGroup
          title="资源策略"
          items={interaction.resourcePolicy ? [interaction.resourcePolicy] : []}
        />
      </>
    );
  }

  return (
    <>
      <div className="cp-detail-topline">
        <span className={`cp-detail-kind cp-detail-kind-${selection.kind}`}>
          {kindLabel}
        </span>
        <span>完整模型 · 只读</span>
      </div>
      <span className="cp-section-kicker">{eyebrow}</span>
      <h3>{title}</h3>
      <p className="cp-detail-description">{description}</p>
      <DetailFacts facts={facts} />
      <div className="cp-detail-sections">{body}</div>
      {onEdit && (
        <button
          type="button"
          className="cp-detail-edit"
          onClick={() => onEdit(selection)}
        >
          <Pencil className="h-3.5 w-3.5" />
          编辑对象
        </button>
      )}
    </>
  );
}

function LevelNode({
  level,
  index,
  active,
  onSelectLevel,
  onSelectStage,
  selectedStageId,
}: {
  readonly level: CultivationLevel;
  readonly index: number;
  readonly active: boolean;
  readonly onSelectLevel: () => void;
  readonly onSelectStage: (stageId: string) => void;
  readonly selectedStageId?: string;
}) {
  return (
    <div className="cp-level-content">
      <button
        type="button"
        className="cp-level-node"
        onClick={onSelectLevel}
        aria-pressed={active && !selectedStageId}
      >
        <span className="cp-level-node-title">
          <span className="cp-level-number">
            {String(index + 1).padStart(2, "0")}
          </span>
          <strong>{level.name}</strong>
          <ChevronRight className="h-4 w-4" />
        </span>
        <span className="cp-level-node-summary">
          {level.summary || "境界说明待补充"}
        </span>
        <span className="cp-level-node-tags">
          <em>{level.stageType || "类型未定义"}</em>
          <em>{level.quality || "质量未定义"}</em>
          <em>{level.subStages.length} 个阶段</em>
        </span>
      </button>
      <div className="cp-stage-strip" aria-label={`${level.name} 的境内阶段`}>
        <span className="cp-stage-label">境内阶段</span>
        <div className="cp-stage-list">
          {level.subStages.map((stage) => (
            <button
              type="button"
              key={stage.id}
              className={`cp-stage-chip${selectedStageId === stage.id ? " is-active" : ""}`}
              onClick={() => onSelectStage(stage.id)}
              aria-pressed={selectedStageId === stage.id}
            >
              <CircleDot className="h-3 w-3" />
              {stage.name}
            </button>
          ))}
          {level.subStages.length === 0 && (
            <span className="cp-stage-empty">尚未划分阶段</span>
          )}
        </div>
      </div>
    </div>
  );
}

function SortableOrderedLevelRow({
  track,
  level,
  index,
  active,
  selectedStageId,
  outgoing,
  sortable,
  onSelectLevel,
  onSelectStage,
  onSelectTransition,
}: {
  readonly track: ProgressionTrack;
  readonly level: CultivationLevel;
  readonly index: number;
  readonly active: boolean;
  readonly selectedStageId?: string;
  readonly outgoing: readonly Transition[];
  readonly sortable: boolean;
  readonly onSelectLevel: () => void;
  readonly onSelectStage: (stageId: string) => void;
  readonly onSelectTransition: (transition: Transition) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: level.id, disabled: !sortable });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  } as CSSProperties;

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`cp-level-row${active ? " is-active" : ""}${isDragging ? " is-dragging" : ""}`}
    >
      <div className="cp-level-spine" aria-hidden="true">
        <span>{String(index + 1).padStart(2, "0")}</span>
        <i />
      </div>
      <div
        className={`cp-level-sortable-body${sortable ? " is-sortable" : ""}`}
      >
        {sortable && (
          <button
            type="button"
            className="cp-level-drag-handle"
            title={`拖动调整「${level.name}」顺序`}
            aria-label={`拖动调整境界「${level.name}」顺序`}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        )}
        <div>
          <LevelNode
            level={level}
            index={index}
            active={active}
            selectedStageId={selectedStageId}
            onSelectLevel={onSelectLevel}
            onSelectStage={onSelectStage}
          />
          {outgoing.map((transition) => (
            <button
              type="button"
              className="cp-inline-transition"
              key={transition.id}
              onClick={() => onSelectTransition(transition)}
            >
              <ArrowDown className="h-3.5 w-3.5" />
              <span>{transition.name}</span>
              <small>
                {transitionTypeLabel(transition.transitionType)} · 至{" "}
                {resolveLevelName(track, transition.toLevelId)}
              </small>
            </button>
          ))}
        </div>
      </div>
    </li>
  );
}

function SortableStructureLevelNode({
  level,
  index,
  active,
  selectedStageId,
  sortable,
  onSelectLevel,
  onSelectStage,
}: {
  readonly level: CultivationLevel;
  readonly index: number;
  readonly active: boolean;
  readonly selectedStageId?: string;
  readonly sortable: boolean;
  readonly onSelectLevel: () => void;
  readonly onSelectStage: (stageId: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: level.id, disabled: !sortable });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  } as CSSProperties;

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`cp-structure-node${active ? " is-active" : ""}${isDragging ? " is-dragging" : ""}`}
    >
      <div
        className={`cp-level-sortable-body${sortable ? " is-sortable" : ""}`}
      >
        {sortable && (
          <button
            type="button"
            className="cp-level-drag-handle"
            title={`拖动调整「${level.name}」顺序`}
            aria-label={`拖动调整境界「${level.name}」顺序`}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        )}
        <LevelNode
          level={level}
          index={index}
          active={active}
          selectedStageId={selectedStageId}
          onSelectLevel={onSelectLevel}
          onSelectStage={onSelectStage}
        />
      </div>
    </article>
  );
}

function LevelMap({
  track,
  selection,
  onSelectLevel,
  onSelectStage,
  onSelectTransition,
  onReorderLevels,
}: {
  readonly track: ProgressionTrack;
  readonly selection: ViewSelection;
  readonly onSelectLevel: (level: CultivationLevel) => void;
  readonly onSelectStage: (
    level: CultivationLevel,
    stage: CultivationLevelSubStage,
  ) => void;
  readonly onSelectTransition: (transition: Transition) => void;
  readonly onReorderLevels?: (
    activeLevelId: string,
    overLevelId: string,
  ) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const sortable = Boolean(onReorderLevels && track.levels.length > 1);
  const handleDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id || !onReorderLevels)
      return;
    onReorderLevels(String(event.active.id), String(event.over.id));
  };

  if (track.levels.length === 0) {
    return (
      <div className="cp-empty-state">
        <Layers3 className="h-5 w-5" />
        <strong>当前轨道还没有境界</strong>
        <span>正式编辑器中可从轨道层级新增第一个境界。</span>
      </div>
    );
  }

  if (track.structure !== "ordered") {
    return (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={track.levels.map((level) => level.id)}
          strategy={rectSortingStrategy}
        >
          <div className={`cp-structure-map is-${track.structure}`}>
            <div className="cp-structure-notice">
              {track.structure === "branching" && (
                <GitBranch className="h-4 w-4" />
              )}
              {track.structure === "cyclic" && (
                <RefreshCw className="h-4 w-4" />
              )}
              {track.structure === "free" && <Layers3 className="h-4 w-4" />}
              <span>
                {track.structure === "branching"
                  ? "节点通过转换关系形成分支，不按数组顺序解释为唯一前后级。"
                  : track.structure === "cyclic"
                    ? "节点允许回流和重复进入，转换决定循环方向。"
                    : "节点没有默认先后关系，转换存在时才建立方向。"}
              </span>
            </div>
            <div className="cp-structure-nodes">
              {track.levels.map((level, index) => (
                <SortableStructureLevelNode
                  key={level.id}
                  level={level}
                  index={index}
                  sortable={sortable}
                  active={
                    selection.kind !== "track" &&
                    "level" in selection &&
                    selection.level.id === level.id
                  }
                  selectedStageId={
                    selection.kind === "stage" &&
                    selection.level.id === level.id
                      ? selection.stage.id
                      : undefined
                  }
                  onSelectLevel={() => onSelectLevel(level)}
                  onSelectStage={(stageId) => {
                    const stage = level.subStages.find(
                      (item) => item.id === stageId,
                    );
                    if (stage) onSelectStage(level, stage);
                  }}
                />
              ))}
            </div>
            {track.transitions.length > 0 && (
              <div className="cp-structure-links">
                <span>节点关系</span>
                {track.transitions.map((transition) => (
                  <button
                    type="button"
                    key={transition.id}
                    onClick={() => onSelectTransition(transition)}
                  >
                    <strong>
                      {resolveLevelName(track, transition.fromLevelId)}
                    </strong>
                    <ArrowRight className="h-3.5 w-3.5" />
                    <strong>
                      {resolveLevelName(track, transition.toLevelId)}
                    </strong>
                    <small>
                      {transitionTypeLabel(transition.transitionType)}
                    </small>
                  </button>
                ))}
              </div>
            )}
          </div>
        </SortableContext>
      </DndContext>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={track.levels.map((level) => level.id)}
        strategy={verticalListSortingStrategy}
      >
        <ol className="cp-level-list">
          {track.levels.map((level, index) => {
            const activeLevel =
              selection.kind !== "track" &&
              "level" in selection &&
              selection.level.id === level.id;
            const outgoing = track.transitions.filter(
              (item) => item.fromLevelId === level.id,
            );
            return (
              <SortableOrderedLevelRow
                key={level.id}
                track={track}
                level={level}
                index={index}
                active={activeLevel}
                sortable={sortable}
                selectedStageId={
                  selection.kind === "stage" && selection.level.id === level.id
                    ? selection.stage.id
                    : undefined
                }
                outgoing={outgoing}
                onSelectLevel={() => onSelectLevel(level)}
                onSelectStage={(stageId) => {
                  const stage = level.subStages.find(
                    (item) => item.id === stageId,
                  );
                  if (stage) onSelectStage(level, stage);
                }}
                onSelectTransition={onSelectTransition}
              />
            );
          })}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function MetricDirectory({
  track,
  selection,
  onSelect,
}: {
  readonly track: ProgressionTrack;
  readonly selection: ViewSelection;
  readonly onSelect: (metric: TrackMetric) => void;
}) {
  if (track.metrics.length === 0)
    return (
      <div className="cp-empty-state">
        <BarChart3 className="h-5 w-5" />
        <strong>当前轨道尚未定义指标</strong>
        <span>指标用于描述境界和阶段门槛，不应硬编码为固定灵力或经验值。</span>
      </div>
    );
  return (
    <div className="cp-object-directory">
      {track.metrics.map((metric) => {
        const usageCount = track.levels.reduce(
          (total, level) =>
            total +
            level.metricThresholds.filter((item) => item.metricId === metric.id)
              .length +
            level.subStages.reduce(
              (stageTotal, stage) =>
                stageTotal +
                stage.metricThresholds.filter(
                  (item) => item.metricId === metric.id,
                ).length,
              0,
            ),
          0,
        );
        return (
          <button
            type="button"
            key={metric.id}
            className={`cp-object-row${selection.kind === "metric" && selection.metric.id === metric.id ? " is-active" : ""}`}
            onClick={() => onSelect(metric)}
          >
            <BarChart3 className="h-4 w-4" />
            <span>
              <strong>{metric.name}</strong>
              <small>{metric.summary || "指标说明待补充"}</small>
            </span>
            <em>
              {metric.baseline || "无基线"} {metric.unit}
            </em>
            <i>{usageCount} 处门槛</i>
          </button>
        );
      })}
    </div>
  );
}

function TransitionDirectory({
  track,
  selection,
  onSelect,
}: {
  readonly track: ProgressionTrack;
  readonly selection: ViewSelection;
  readonly onSelect: (transition: Transition) => void;
}) {
  if (track.transitions.length === 0)
    return (
      <div className="cp-empty-state">
        <GitBranch className="h-5 w-5" />
        <strong>当前轨道尚未定义转换</strong>
        <span>转换是独立业务对象，负责连接起止境界并承载成功与失败语义。</span>
      </div>
    );
  return (
    <div className="cp-object-directory">
      {track.transitions.map((transition) => (
        <button
          type="button"
          key={transition.id}
          className={`cp-object-row cp-transition-row${selection.kind === "transition" && selection.transition.id === transition.id ? " is-active" : ""}`}
          onClick={() => onSelect(transition)}
        >
          <GitBranch className="h-4 w-4" />
          <span>
            <strong>{transition.name}</strong>
            <small>
              {resolveLevelName(track, transition.fromLevelId)} →{" "}
              {resolveLevelName(track, transition.toLevelId)}
            </small>
          </span>
          <em>{transitionTypeLabel(transition.transitionType)}</em>
          <i>{transition.reversible ? "可逆" : "不可逆"}</i>
        </button>
      ))}
    </div>
  );
}

function InteractionDirectory({
  system,
  track,
  interactions,
  selection,
  onSelect,
}: {
  readonly system: CultivationSystem;
  readonly track: ProgressionTrack;
  readonly interactions: readonly TrackInteraction[];
  readonly selection: ViewSelection;
  readonly onSelect: (interaction: TrackInteraction) => void;
}) {
  if (interactions.length === 0)
    return (
      <div className="cp-empty-state">
        <Link2 className="h-5 w-5" />
        <strong>当前轨道没有交叉规则</strong>
        <span>多轨规则用于表达同步、协同、失衡、资源竞争和跨轨突破。</span>
      </div>
    );
  return (
    <div className="cp-object-directory">
      {interactions.map((interaction) => {
        const outgoing = interaction.sourceTrackId === track.id;
        return (
          <button
            type="button"
            key={interaction.id}
            className={`cp-object-row cp-interaction-row${selection.kind === "interaction" && selection.interaction.id === interaction.id ? " is-active" : ""}`}
            onClick={() => onSelect(interaction)}
          >
            <Link2 className="h-4 w-4" />
            <span>
              <strong>{interaction.name}</strong>
              <small>
                {interaction.rule || interaction.summary || "规则说明待补充"}
              </small>
            </span>
            <em>{interactionKindLabel(interaction.kind)}</em>
            <i>
              {outgoing ? "指向" : "来自"}：
              {resolveTrackName(
                system,
                outgoing
                  ? interaction.targetTrackId
                  : interaction.sourceTrackId,
              )}
            </i>
          </button>
        );
      })}
    </div>
  );
}

function selectionForView(
  view: ProgressionView,
  track: ProgressionTrack,
  interactions: readonly TrackInteraction[],
): ViewSelection {
  if (view === "levels" && track.levels[0])
    return { kind: "level", track, level: track.levels[0] };
  if (view === "metrics" && track.metrics[0])
    return { kind: "metric", track, metric: track.metrics[0] };
  if (view === "transitions" && track.transitions[0])
    return { kind: "transition", track, transition: track.transitions[0] };
  if (view === "interactions" && interactions[0])
    return { kind: "interaction", track, interaction: interactions[0] };
  return { kind: "track", track };
}

function viewForSelection(selection: ViewSelection): ProgressionView {
  if (selection.kind === "metric") return "metrics";
  if (selection.kind === "transition") return "transitions";
  if (selection.kind === "interaction") return "interactions";
  return "levels";
}

function resolveCurrentSelection(
  current: ViewSelection | null,
  view: ProgressionView,
  track: ProgressionTrack | undefined,
  interactions: readonly TrackInteraction[],
): ViewSelection | null {
  if (!track) return null;
  if (!current) return selectionForView(view, track, interactions);
  if (current.kind === "track") return { kind: "track", track };
  if (current.kind === "level") {
    const level = track.levels.find((item) => item.id === current.level.id);
    return level ? { kind: "level", track, level } : { kind: "track", track };
  }
  if (current.kind === "stage") {
    const level = track.levels.find((item) => item.id === current.level.id);
    const stage = level?.subStages.find((item) => item.id === current.stage.id);
    return level && stage
      ? { kind: "stage", track, level, stage }
      : { kind: "track", track };
  }
  if (current.kind === "metric") {
    const metric = track.metrics.find((item) => item.id === current.metric.id);
    return metric
      ? { kind: "metric", track, metric }
      : { kind: "track", track };
  }
  if (current.kind === "transition") {
    const transition = track.transitions.find(
      (item) => item.id === current.transition.id,
    );
    return transition
      ? { kind: "transition", track, transition }
      : { kind: "track", track };
  }
  const interaction = interactions.find(
    (item) => item.id === current.interaction.id,
  );
  return interaction
    ? { kind: "interaction", track, interaction }
    : { kind: "track", track };
}

export default function CultivationProgressionPrototype({
  system,
  onClose,
  mode = "preview",
  selectedTrackId,
  selectedSelection,
  onSelect,
  onEdit,
  onReorderLevels,
  sidebarAction,
  railAction,
  renderViewActions,
  renderDetails,
}: {
  readonly system: CultivationSystem;
  readonly onClose?: () => void;
  readonly mode?: "preview" | "embedded";
  readonly selectedTrackId?: string | null;
  readonly selectedSelection?: ViewSelection | null;
  readonly onSelect?: (selection: ViewSelection) => void;
  readonly onEdit?: (selection: ViewSelection) => void;
  readonly onReorderLevels?: (
    trackId: string,
    activeLevelId: string,
    overLevelId: string,
  ) => void;
  readonly sidebarAction?: ReactNode;
  readonly railAction?: ReactNode;
  readonly renderViewActions?: (
    view: ProgressionView,
    track: ProgressionTrack,
  ) => ReactNode;
  readonly renderDetails?: (selection: ViewSelection) => ReactNode;
}) {
  const firstTrack = system.progressionTracks[0];
  const initialTrack =
    system.progressionTracks.find((item) => item.id === selectedTrackId) ??
    firstTrack;
  const [trackId, setTrackId] = useState(initialTrack?.id ?? "");
  const [view, setView] = useState<ProgressionView>("levels");
  const activeTrackId = selectedSelection?.track.id ?? trackId;
  const track =
    system.progressionTracks.find((item) => item.id === activeTrackId) ??
    firstTrack;
  const activeView =
    selectedSelection && selectedSelection.kind !== "track"
      ? viewForSelection(selectedSelection)
      : view;
  const relatedInteractions = useMemo(
    () =>
      track
        ? (system.trackInteractions ?? []).filter(
            (item) =>
              item.sourceTrackId === track.id ||
              item.targetTrackId === track.id,
          )
        : [],
    [system.trackInteractions, track],
  );
  const [selectionIntent, setSelectionIntent] = useState<ViewSelection | null>(
    () =>
      initialTrack
        ? selectionForView(
            "levels",
            initialTrack,
            (system.trackInteractions ?? []).filter(
              (item) =>
                item.sourceTrackId === initialTrack.id ||
                item.targetTrackId === initialTrack.id,
            ),
          )
        : null,
  );
  const selection = resolveCurrentSelection(
    selectedSelection ?? selectionIntent,
    activeView,
    track,
    relatedInteractions,
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && onClose) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const choose = (nextSelection: ViewSelection) => {
    setSelectionIntent(nextSelection);
    onSelect?.(nextSelection);
  };

  const activateTrack = (nextTrack: ProgressionTrack) => {
    setTrackId(nextTrack.id);
    choose({ kind: "track", track: nextTrack });
  };

  const activateView = (nextView: ProgressionView) => {
    setView(nextView);
    if (track) choose(selectionForView(nextView, track, relatedInteractions));
  };

  const viewCount = (viewId: ProgressionView) => {
    if (!track) return 0;
    if (viewId === "levels") return track.levels.length;
    if (viewId === "metrics") return track.metrics.length;
    if (viewId === "transitions") return track.transitions.length;
    return relatedInteractions.length;
  };

  const shell = (
    <section
      className={`cp-prototype-shell${mode === "embedded" ? " is-embedded" : ""}`}
      role={mode === "preview" ? "dialog" : undefined}
      aria-modal={mode === "preview" ? true : undefined}
      aria-labelledby={mode === "preview" ? "cp-prototype-title" : undefined}
      aria-label={mode === "embedded" ? "成长轨道与境界地图" : undefined}
    >
      {mode === "preview" && (
        <>
          <header className="cp-prototype-header">
            <div>
              <div className="cp-prototype-eyebrow">
                <Sparkles className="h-3.5 w-3.5" />
                交互原型 · 完整模型预览
              </div>
              <h2 id="cp-prototype-title">成长轨道与境界地图</h2>
              <p>
                轨道负责并行成长，境界和阶段承载状态，指标定义门槛，转换与交叉规则负责连接和约束。
              </p>
            </div>
            {onClose && (
              <button
                type="button"
                className="cp-prototype-close"
                onClick={onClose}
                aria-label="关闭原型预览"
                title="关闭原型预览"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </header>

          <div className="cp-prototype-path" aria-label="数据模型路径">
            <span>数据模型</span>
            <strong>并行轨道</strong>
            <ArrowRight className="h-3.5 w-3.5" />
            <strong>境界与阶段</strong>
            <ArrowRight className="h-3.5 w-3.5" />
            <strong>指标与门槛</strong>
            <ArrowRight className="h-3.5 w-3.5" />
            <strong>转换与跨轨规则</strong>
            <em>当前仍为只读，不修改项目数据</em>
          </div>
        </>
      )}

      <div className="cp-prototype-layout">
        <aside className="cp-track-sidebar" aria-label="并行成长轨道">
          <div className="cp-panel-heading">
            <div>
              <span>成长地图</span>
              <strong>并行成长轨道</strong>
            </div>
            <div className="cp-panel-heading-actions">
              <span className="cp-count-badge">
                {system.progressionTracks.length}
              </span>
              {sidebarAction}
            </div>
          </div>
          <p className="cp-panel-note">
            轨道相互并行；轨道内部结构和转换决定境界之间的真实关系。
          </p>
          <div className="cp-track-list">
            {system.progressionTracks.map((item, index) => (
              <button
                type="button"
                key={item.id}
                className={`cp-track-item${item.id === track?.id ? " is-active" : ""}`}
                onClick={() => activateTrack(item)}
                aria-pressed={item.id === track?.id}
              >
                <span className="cp-track-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="cp-track-copy">
                  <strong>{item.name}</strong>
                  <small>
                    {structureLabel(item.structure)} · {item.levels.length}{" "}
                    个境界
                  </small>
                </span>
                <ChevronRight className="cp-track-arrow h-4 w-4" />
              </button>
            ))}
          </div>
          <div className="cp-sidebar-footnote">
            <Route className="h-4 w-4" />
            <span>新增、排序、编辑和删除仍由正式编辑模式负责</span>
          </div>
        </aside>

        <main className="cp-rail-panel" aria-label="当前轨道业务视图">
          {track ? (
            <>
              <div className="cp-rail-heading">
                <div>
                  <span className="cp-section-kicker">当前轨道</span>
                  <h3>{track.name}</h3>
                  <p>{track.summary || "这条轨道尚未填写说明。"}</p>
                </div>
                <div className="cp-rail-heading-actions">
                  <div className="cp-rail-meta">
                    <span>{track.mode || "成长方式未定义"}</span>
                    <strong>{structureLabel(track.structure)}</strong>
                  </div>
                  {railAction}
                </div>
              </div>
              <div
                className="cp-view-tabs"
                role="tablist"
                aria-label="轨道业务视图"
              >
                {viewOptions.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      type="button"
                      role="tab"
                      key={item.id}
                      className={activeView === item.id ? "is-active" : ""}
                      aria-selected={activeView === item.id}
                      onClick={() => activateView(item.id)}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {item.label}
                      <small>{viewCount(item.id)}</small>
                    </button>
                  );
                })}
              </div>
              {renderViewActions && (
                <div className="cp-view-actions" aria-label="当前视图操作">
                  {renderViewActions(activeView, track)}
                </div>
              )}
              <div className="cp-rail-scroll" role="tabpanel">
                {selection && activeView === "levels" && (
                  <LevelMap
                    track={track}
                    selection={selection}
                    onReorderLevels={
                      onReorderLevels
                        ? (activeLevelId, overLevelId) =>
                            onReorderLevels(
                              track.id,
                              activeLevelId,
                              overLevelId,
                            )
                        : undefined
                    }
                    onSelectLevel={(level) =>
                      choose({ kind: "level", track, level })
                    }
                    onSelectStage={(level, stage) =>
                      choose({ kind: "stage", track, level, stage })
                    }
                    onSelectTransition={(transition) => {
                      setView("transitions");
                      choose({ kind: "transition", track, transition });
                    }}
                  />
                )}
                {selection && activeView === "metrics" && (
                  <MetricDirectory
                    track={track}
                    selection={selection}
                    onSelect={(metric) =>
                      choose({ kind: "metric", track, metric })
                    }
                  />
                )}
                {selection && activeView === "transitions" && (
                  <TransitionDirectory
                    track={track}
                    selection={selection}
                    onSelect={(transition) =>
                      choose({ kind: "transition", track, transition })
                    }
                  />
                )}
                {selection && activeView === "interactions" && (
                  <InteractionDirectory
                    system={system}
                    track={track}
                    interactions={relatedInteractions}
                    selection={selection}
                    onSelect={(interaction) =>
                      choose({
                        kind: "interaction",
                        track,
                        interaction,
                      })
                    }
                  />
                )}
              </div>
            </>
          ) : (
            <div className="cp-empty-state">
              <Route className="h-5 w-5" />
              <strong>还没有成长轨道</strong>
              <span>正式编辑器中可先建立一条并行成长轨道。</span>
            </div>
          )}
        </main>

        <aside
          className={`cp-detail-panel${renderDetails ? " has-inline-editor" : ""}`}
          aria-label={renderDetails ? "当前对象编辑" : "当前对象完整详情"}
        >
          {selection ? (
            renderDetails ? (
              renderDetails(selection)
            ) : (
              <SelectionDetails
                system={system}
                selection={selection}
                onEdit={onEdit}
              />
            )
          ) : (
            <div className="cp-empty-state">
              <Activity className="h-5 w-5" />
              <strong>选择一个业务对象</strong>
              <span>右侧会显示当前对象在数据模型中的完整字段。</span>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
  return mode === "preview" ? (
    <div className="cp-prototype-backdrop" role="presentation">
      {shell}
    </div>
  ) : (
    shell
  );
}
