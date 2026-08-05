import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  reconnectEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Activity,
  AlertTriangle,
  Atom,
  BookOpen,
  Boxes,
  ChevronRight,
  CircleDot,
  Compass,
  Copy,
  Eye,
  EyeOff,
  FileText,
  FlaskConical,
  GitBranch,
  GripVertical,
  Hexagon,
  Layers3,
  Link2,
  Loader2,
  Maximize2,
  Pencil,
  Plus,
  Route,
  Save,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  Waypoints,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { z } from "zod";

import {
  ConfirmDialog,
  CustomSelect,
  type WorkbenchNavigationGuard,
  type WorkbenchStorage,
} from "@/workbench-sdk";

import {
  abilitySchema,
  constraintSchema,
  crossSystemRelationSchema,
  cultivationMethodSchema,
  cultivationProjectionSchema,
  cultivationSystemSchema,
  formationSchema,
  foundationSchema,
  levelSchema,
  levelSubStageSchema,
  progressionTrackSchema,
  resourceSchema,
  theoryModelSchema,
  transitionSchema,
  worldOriginSchema,
  type Ability,
  type Constraint,
  type CultivationEcology,
  type CultivationOrbStyle,
  type CultivationLevel,
  type CultivationLevelSubStage,
  type CultivationMethod,
  type CultivationResource,
  type CultivationSystem,
  type Formation,
  type Foundation,
  type OperationTopology,
  type ProgressionTrack,
  type ResourceRequirement,
  type MethodCourse,
  type TrackInteraction,
  type TheoryNode,
  type Transition,
  type WorldOrigin,
  type WorldOriginManifestation,
  type WorldOriginRelation,
} from "../../../shared/workbenches/novel/cultivationEcologySchema";
import { createNovelItemLibraryRepository } from "./itemLibraryRepository";
import type { ItemIndexEntry } from "./itemLibrarySchema";
import { parseCharacterLibraryIndex } from "./characterLibrarySchema";
import { createNovelCharacterLibraryRepository } from "./characterLibraryRepository";
import { createCultivationEcologyRepository } from "./cultivationEcologyRepository";
import FormationBackdropArt from "./FormationBackdropArt";
import {
  createDefaultFormationBackdropLayer,
  createFormationBackdropPreset,
  FORMATION_BASE_CANVAS_SIZE,
  FORMATION_BACKDROP_LAYER_LABELS,
  FORMATION_BACKDROP_LAYER_TYPE_OPTIONS,
  FORMATION_BACKDROP_PRESETS,
  FORMATION_BACKDROP_PRESET_OPTIONS,
  FORMATION_BACKDROP_SYMBOL_OPTIONS,
  FORMATION_MAX_RADIUS,
  getFormationCanvasSize,
  type FormationBackdropLayer,
  type FormationBackdropPresetId,
} from "./formationBackdropPresets";
import NarrativeUnsavedChangesGuard from "./NarrativeUnsavedChangesGuard";
import WorldProposalReview from "./WorldProposalReview";
import { createNovelCultivationProposalRepository } from "./cultivationProposalRepository";

function newEcologyId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
import {
  calculateCultivationCompleteness,
  collectCultivationSystemAssetIds as collectSystemAssetIds,
  rebuildCultivationAudits,
} from "./cultivationEcologyAudit";

import "@xyflow/react/dist/style.css";
import "./CultivationEcologyWorkbench.css";

type ModuleId =
  | "overview"
  | "projection"
  | "theory"
  | "progression"
  | "resources"
  | "methods"
  | "abilities"
  | "formations"
  | "assets"
  | "foundations"
  | "transitions"
  | "constraints"
  | "audit";
type Scope = "system" | "origins" | "relations";
type Selection = {
  kind: string;
  id: string;
  parentId?: string;
  parentKind?: string;
  grandParentId?: string;
} | null;

export interface CultivationAiRunRequest {
  readonly sceneId: "cultivation.module";
  readonly label: string;
  readonly prompt: string;
  readonly systemPrompt: string;
}

type CultivationAiTarget = {
  readonly label: string;
  readonly value: Record<string, unknown>;
  readonly apply: (value: Record<string, unknown>) => void;
  readonly schema: z.ZodType;
};

const modules: readonly { id: ModuleId; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "总览", icon: Compass },
  { id: "projection", label: "本源", icon: Sparkles },
  { id: "theory", label: "理论", icon: Atom },
  { id: "progression", label: "成长", icon: Route },
  { id: "resources", label: "资源", icon: FlaskConical },
  { id: "methods", label: "法门", icon: ScrollText },
  { id: "abilities", label: "能力", icon: Zap },
  { id: "formations", label: "阵法", icon: Hexagon },
  { id: "assets", label: "资产", icon: Layers3 },
  { id: "foundations", label: "根基", icon: Target },
  { id: "transitions", label: "跃迁", icon: GitBranch },
  { id: "constraints", label: "约束", icon: ShieldAlert },
  { id: "audit", label: "审查", icon: ShieldCheck },
];

const moduleMeta: Record<
  ModuleId,
  { eyebrow: string; title: string; description: string }
> = {
  overview: {
    eyebrow: "修行体系",
    title: "",
    description:
      "把本源投影、理论节点、法门拓扑、境界、资源、能力和阵法组织在同一套可审查模型中。",
  },
  projection: {
    eyebrow: "体系内部 / 01 本源投影",
    title: "体系本源投影",
    description:
      "声明该体系从哪些世界本源和显化节点中取得力量，以及如何完成本地化翻译。",
  },
  theory: {
    eyebrow: "体系内部 / 02 理论模型",
    title: "理论模型",
    description:
      "理论模型定义体系共有的节点、容器、连接规则和不变量；具体运行线路由法门单独声明。",
  },
  progression: {
    eyebrow: "体系内部 / 03 成长轨道",
    title: "境界层级与数值模型",
    description:
      "一套体系可以有多条成长轨道；每个境界定义突破与退化规则，境界内可继续划分前期、中期、后期等阶段。",
  },
  resources: {
    eyebrow: "体系内部 / 04 资源库",
    title: "修炼资源",
    description:
      "定义能量、材料、环境、知识、权限和替代关系；消耗由境界、境内阶段、法门、能力或阵法明确引用。",
  },
  methods: {
    eyebrow: "体系内部 / 05 修行法门",
    title: "修行法门与运行拓扑",
    description:
      "每一部法门都包含修炼法诀、课程、适用区间和独立的经络、符文或意识运行线路。",
  },
  abilities: {
    eyebrow: "体系内部 / 06 能力库",
    title: "能力库",
    description:
      "统一展示境界自动获得与秘籍修炼获得的能力，并记录功能类型、修炼成本和释放能量消耗。",
  },
  formations: {
    eyebrow: "体系内部 / 07 阵法与部署",
    title: "阵法与部署",
    description:
      "阵法是独立的部署拓扑，引用理论节点、法门、能力和资源，承担放大、控制、防护或仪式功能。",
  },
  assets: {
    eyebrow: "体系内部 / 08 资产索引",
    title: "资产索引",
    description:
      "所有资产只定义一次，再通过境界、境内阶段、法门、能力和阵法建立关联；从任一资产都能回到覆盖对象。",
  },
  foundations: {
    eyebrow: "体系内部 / 09 根基与质量",
    title: "根基与质量",
    description:
      "根骨、血脉、灵魂资质、元素亲和或改造程度会跨多个境界影响速度、质量、上限和突破。",
  },
  transitions: {
    eyebrow: "体系内部 / 10 突破与转换",
    title: "突破与转换",
    description:
      "跃迁是独立的一等对象，记录方法、资源、条件、成功模型、失败语义和不可逆后果。",
  },
  constraints: {
    eyebrow: "体系内部 / 11 体系约束",
    title: "体系约束",
    description:
      "代价、污染、反噬、不可逆后果和世界规则决定修行体系的边界与叙事张力。",
  },
  audit: {
    eyebrow: "体系内部 / 12 审查",
    title: "结构审查",
    description: "定位无效引用、缺失消耗、拓扑断路、境界冲突和跨体系转换风险。",
  },
};

function Button({
  children,
  onClick,
  variant = "secondary",
  disabled,
  title,
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel}
      className={`ce-button ce-button-${variant}`}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  multiline = false,
  placeholder,
  type = "text",
  min,
  max,
  step,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
  type?: "text" | "number";
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="ce-field">
      <span>{label}</span>
      {multiline ? (
        <textarea
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          type={type}
          value={value}
          min={min}
          max={max}
          step={step}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}

function SwitchField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="ce-switch-field">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        className={checked ? "is-checked" : ""}
        onClick={() => onChange(!checked)}
      >
        <i />
      </button>
    </div>
  );
}

// These are editable diagram-art colors, not application-shell theme tokens.
const TOPOLOGY_NODE_PALETTE = [
  "#d946ef",
  "#22d3ee",
  "#f59e0b",
  "#60a5fa",
  "#f43f5e",
  "#34d399",
] as const;
const CULTIVATION_ORB_STYLES: readonly CultivationOrbStyle[] = [
  "plasma",
  "orbit",
  "solar",
  "corona",
  "halo",
  "vortex",
];
const cultivationOrbStyleLabels: Record<CultivationOrbStyle, string> = {
  plasma: "电浆",
  orbit: "轨道",
  solar: "恒星",
  corona: "日冕",
  halo: "光环",
  vortex: "涡旋",
};
const CULTIVATION_ORB_PREVIEW_COLORS = [
  "#22d3ee",
  "#f59e0b",
  "#f43f5e",
  "#f59e0b",
  "#d946ef",
  "#60a5fa",
] as const;

function OrbVisual({
  orbStyle,
  className = "",
}: {
  orbStyle: CultivationOrbStyle;
  className?: string;
}) {
  return (
    <div
      className={`ce-topology-orb ce-orb-style-${orbStyle} ${className}`.trim()}
    >
      <span className="ce-topology-orb-filaments" aria-hidden="true" />
      <span className="ce-topology-orb-core" aria-hidden="true" />
      <span className="ce-orb-structure" aria-hidden="true" />
    </div>
  );
}

function OrbStyleField({
  value,
  onChange,
}: {
  value: CultivationOrbStyle;
  onChange: (value: CultivationOrbStyle) => void;
}) {
  return (
    <fieldset className="ce-orb-style-field">
      <legend>光球风格</legend>
      <div className="ce-orb-style-options">
        {CULTIVATION_ORB_STYLES.map((style, index) => (
          <button
            type="button"
            key={style}
            className={value === style ? "is-active" : ""}
            style={
              {
                "--topology-node-color": CULTIVATION_ORB_PREVIEW_COLORS[index],
              } as CSSProperties
            }
            aria-pressed={value === style}
            title={`${cultivationOrbStyleLabels[style]}光球`}
            onClick={() => onChange(style)}
          >
            <OrbVisual orbStyle={style} className="ce-orb-style-preview" />
            <span>{cultivationOrbStyleLabels[style]}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function topologyNodeColor(
  node: OperationTopology["nodes"][number],
  index: number,
) {
  return (
    node.color ?? TOPOLOGY_NODE_PALETTE[index % TOPOLOGY_NODE_PALETTE.length]
  );
}

function topologyNodeOrbStyle(
  node: OperationTopology["nodes"][number],
  index: number,
): CultivationOrbStyle {
  return (
    node.orbStyle ??
    CULTIVATION_ORB_STYLES[index % CULTIVATION_ORB_STYLES.length]
  );
}

function TopologyColorField({
  value,
  onChange,
  label = "节点颜色",
  allowTransparent = false,
  transparentFallback = TOPOLOGY_NODE_PALETTE[0],
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  allowTransparent?: boolean;
  transparentFallback?: string;
}) {
  const isTransparent = value === "transparent";
  const resolvedValue = /^#[0-9a-f]{6}$/iu.test(value)
    ? value
    : transparentFallback;
  return (
    <fieldset className="ce-topology-color-field">
      <legend>{label}</legend>
      <div className="ce-topology-color-control">
        <input
          type="color"
          value={resolvedValue}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`自定义${label}`}
        />
        <code>
          {isTransparent ? "跟随系统背景" : resolvedValue.toUpperCase()}
        </code>
        {allowTransparent && (
          <Button
            variant="ghost"
            onClick={() =>
              onChange(isTransparent ? transparentFallback : "transparent")
            }
            title={
              isTransparent ? "恢复自定义阵盘底色" : "改为透明并跟随系统背景"
            }
          >
            {isTransparent ? (
              <Eye className="h-3.5 w-3.5" />
            ) : (
              <EyeOff className="h-3.5 w-3.5" />
            )}
            {isTransparent ? "使用自定义底色" : "跟随系统背景"}
          </Button>
        )}
      </div>
      <div className="ce-topology-color-swatches">
        {TOPOLOGY_NODE_PALETTE.map((color) => (
          <button
            type="button"
            key={color}
            className={
              !isTransparent && resolvedValue.toLowerCase() === color
                ? "is-active"
                : ""
            }
            style={{ "--topology-swatch-color": color } as CSSProperties}
            onClick={() => onChange(color)}
            title={color.toUpperCase()}
            aria-label={`使用颜色 ${color.toUpperCase()}`}
            aria-pressed={resolvedValue.toLowerCase() === color}
          />
        ))}
      </div>
    </fieldset>
  );
}

function Section({
  title,
  eyebrow,
  action,
  children,
}: {
  title: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ce-section">
      <div className="ce-section-head">
        <div>
          {eyebrow && <span className="ce-eyebrow">{eyebrow}</span>}
          <h2>{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="ce-empty">
      <CircleDot className="h-5 w-5" />
      <span>{text}</span>
    </div>
  );
}

function getActiveSystem(
  ecology: CultivationEcology,
  id: string | null,
): CultivationSystem | null {
  return (
    ecology.systems.find((system) => system.id === id) ??
    ecology.systems[0] ??
    null
  );
}

function getPageMeta(
  scope: Scope,
  system: CultivationSystem | null,
  module: ModuleId,
) {
  if (scope === "origins")
    return {
      eyebrow: "修行生态 / 项目全局",
      title: "世界本源",
      description:
        "定义世界的本体、分化、法则、能量与载体显化，并查看修行体系如何从中建立投影。",
    };
  if (scope === "relations")
    return {
      eyebrow: "修行生态 / 项目全局",
      title: "跨体系关系",
      description:
        "管理修行体系之间的兼容、克制、转换、依赖、继承、污染与冲突关系。",
    };
  const meta = moduleMeta[module];
  return {
    ...meta,
    title: module === "overview" ? (system?.name ?? "修行体系") : meta.title,
    description:
      module === "overview"
        ? system?.summary || meta.description
        : meta.description,
    eyebrow: system
      ? `${meta.eyebrow}${module === "overview" ? ` / ${system.kind}` : ""}`
      : meta.eyebrow,
  };
}

function getModuleSelection(
  system: CultivationSystem | null,
  module: ModuleId,
): Selection {
  if (!system) return null;
  const systemSelection: Selection = { kind: "system", id: system.id };
  if (
    ["overview", "assets", "foundations", "constraints", "audit"].includes(
      module,
    )
  ) {
    return { kind: module, id: system.id };
  }
  if (module === "projection" || module === "theory") {
    return { kind: module, id: system.id };
  }
  if (module === "progression") {
    const track = system.progressionTracks[0];
    if (track) {
      const transition = track.transitions[0];
      return transition
        ? {
            kind: "transition",
            id: transition.id,
            parentId: track.id,
            parentKind: "track",
          }
        : { kind: "track", id: track.id };
    }
    return systemSelection;
  }
  if (module === "resources") {
    const resource = system.resources[0];
    return resource ? { kind: "resource", id: resource.id } : systemSelection;
  }
  if (module === "methods") {
    const method = system.methods[0];
    return method ? { kind: "method", id: method.id } : systemSelection;
  }
  if (module === "abilities") {
    const ability = system.abilities[0];
    return ability ? { kind: "ability", id: ability.id } : systemSelection;
  }
  if (module === "formations") {
    const formation = system.formations[0];
    return formation
      ? { kind: "formation", id: formation.id }
      : systemSelection;
  }
  const transition = system.transitions[0];
  if (transition) return { kind: "transition", id: transition.id };
  const nestedTrack = system.progressionTracks.find(
    (candidate) => candidate.transitions.length > 0,
  );
  const nestedTransition = nestedTrack?.transitions[0];
  return nestedTransition
    ? {
        kind: "transition",
        id: nestedTransition.id,
        parentId: nestedTrack.id,
        parentKind: "track",
      }
    : systemSelection;
}

function updateById<T extends { id: string }>(
  items: readonly T[],
  id: string,
  update: (item: T) => T,
): T[] {
  return items.map((item) => (item.id === id ? update(item) : item));
}

function removeResourceFromRequirements(
  requirements: readonly ResourceRequirement[],
  resourceId: string,
): ResourceRequirement[] {
  return requirements
    .filter((requirement) => requirement.resourceId !== resourceId)
    .map((requirement) => ({
      ...requirement,
      substituteResourceIds: requirement.substituteResourceIds.filter(
        (id) => id !== resourceId,
      ),
    }));
}

function removeResourceReferences(
  system: CultivationSystem,
  resourceId: string,
): CultivationSystem {
  const clean = (requirements: readonly ResourceRequirement[]) =>
    removeResourceFromRequirements(requirements, resourceId);
  return {
    ...system,
    progressionTracks: system.progressionTracks.map((track) => ({
      ...track,
      levels: track.levels.map((level) => ({
        ...level,
        resourceRequirements: clean(level.resourceRequirements),
        subStages: level.subStages.map((stage) => ({
          ...stage,
          resourceRequirements: clean(stage.resourceRequirements),
        })),
      })),
      transitions: track.transitions.map((transition) => ({
        ...transition,
        resourceRequirements: clean(transition.resourceRequirements),
      })),
    })),
    methods: system.methods.map((method) => ({
      ...method,
      courses: method.courses.map((course) => ({
        ...course,
        resourceRequirements: clean(course.resourceRequirements),
      })),
    })),
    abilities: system.abilities.map((ability) => ({
      ...ability,
      trainingRequirements: {
        ...ability.trainingRequirements,
        resourceRequirements: clean(
          ability.trainingRequirements.resourceRequirements,
        ),
      },
    })),
    formations: system.formations.map((formation) => ({
      ...formation,
      resourceRequirements: clean(formation.resourceRequirements),
    })),
    transitions: system.transitions.map((transition) => ({
      ...transition,
      resourceRequirements: clean(transition.resourceRequirements),
    })),
  };
}

function removeTheoryNodeReferences(
  system: CultivationSystem,
  nodeId: string,
): CultivationSystem {
  return {
    ...system,
    methods: system.methods.map((method) => ({
      ...method,
      operationTopologies: method.operationTopologies.map((topology) => {
        const removedNodeIds = new Set(
          topology.nodes
            .filter((node) => node.theoryNodeId === nodeId)
            .map((node) => node.id),
        );
        return {
          ...topology,
          nodes: topology.nodes.filter((node) => node.theoryNodeId !== nodeId),
          edges: topology.edges.filter(
            (edge) =>
              !removedNodeIds.has(edge.fromNodeId) &&
              !removedNodeIds.has(edge.toNodeId),
          ),
        };
      }),
    })),
    formations: system.formations.map((formation) => ({
      ...formation,
      theoryNodeIds: formation.theoryNodeIds.filter((id) => id !== nodeId),
      nodes: formation.nodes.map((node) =>
        node.theoryNodeId === nodeId ? { ...node, theoryNodeId: null } : node,
      ),
    })),
  };
}

function removeAssetFromCrossSystemRelations(
  ecology: CultivationEcology,
  assetIds: ReadonlySet<string>,
): CultivationEcology {
  return {
    ...ecology,
    crossSystemRelations: ecology.crossSystemRelations.map((relation) => {
      if (!relation.affectedAssetIds?.length) return relation;
      const affectedAssetIds = relation.affectedAssetIds.filter(
        (assetId) => !assetIds.has(assetId),
      );
      return affectedAssetIds.length > 0
        ? { ...relation, affectedAssetIds }
        : { ...relation, affectedAssetIds: undefined };
    }),
  };
}

function removeMethodReferences(
  system: CultivationSystem,
  methodId: string,
): CultivationSystem {
  const topologyIds = new Set(
    system.methods
      .find((method) => method.id === methodId)
      ?.operationTopologies.map((topology) => topology.id) ?? [],
  );
  return {
    ...system,
    progressionTracks: system.progressionTracks.map((track) => ({
      ...track,
      levels: track.levels.map((level) => ({
        ...level,
        methodIds: level.methodIds.filter((id) => id !== methodId),
        subStages: level.subStages.map((stage) => ({
          ...stage,
          methodIds: stage.methodIds.filter((id) => id !== methodId),
        })),
      })),
      transitions: track.transitions.map((transition) => ({
        ...transition,
        methodIds: transition.methodIds.filter((id) => id !== methodId),
      })),
    })),
    abilities: system.abilities.map((ability) => ({
      ...ability,
      scriptureSource:
        ability.scriptureSource?.methodId === methodId
          ? { ...ability.scriptureSource, methodId: null }
          : ability.scriptureSource,
      trainingRequirements: {
        ...ability.trainingRequirements,
        methodIds: ability.trainingRequirements.methodIds.filter(
          (id) => id !== methodId,
        ),
      },
    })),
    formations: system.formations.map((formation) => ({
      ...formation,
      methodIds: formation.methodIds.filter((id) => id !== methodId),
      operationTopologyIds: formation.operationTopologyIds?.filter(
        (id) => !topologyIds.has(id),
      ),
    })),
    transitions: system.transitions.map((transition) => ({
      ...transition,
      methodIds: transition.methodIds.filter((id) => id !== methodId),
    })),
  };
}

function removeAbilityReferences(
  system: CultivationSystem,
  abilityId: string,
): CultivationSystem {
  return {
    ...system,
    progressionTracks: system.progressionTracks.map((track) => ({
      ...track,
      levels: track.levels.map((level) => ({
        ...level,
        naturalAbilityIds: level.naturalAbilityIds.filter(
          (id) => id !== abilityId,
        ),
        subStages: level.subStages.map((stage) => ({
          ...stage,
          naturalAbilityIds: stage.naturalAbilityIds.filter(
            (id) => id !== abilityId,
          ),
        })),
      })),
    })),
    formations: system.formations.map((formation) => ({
      ...formation,
      abilityIds: formation.abilityIds.filter((id) => id !== abilityId),
    })),
  };
}

function removeLevelReferences(
  system: CultivationSystem,
  levelIds: ReadonlySet<string>,
): CultivationSystem {
  const cleanLevel = (id: string | null | undefined) => {
    if (!id || levelIds.has(id)) return null;
    return id;
  };
  return {
    ...system,
    progressionTracks: system.progressionTracks.map((track) => ({
      ...track,
      transitions: track.transitions.map((transition) => ({
        ...transition,
        fromLevelId: cleanLevel(transition.fromLevelId),
        toLevelId: cleanLevel(transition.toLevelId),
      })),
    })),
    resources: system.resources.map((resource) => ({
      ...resource,
      bestLevelId: cleanLevel(resource.bestLevelId),
      usableLevelIds: resource.usableLevelIds.filter((id) => !levelIds.has(id)),
    })),
    methods: system.methods.map((method) => ({
      ...method,
      coverage: {
        startLevelId: cleanLevel(method.coverage.startLevelId),
        stableLimitId: cleanLevel(method.coverage.stableLimitId),
        theoryLimitId: cleanLevel(method.coverage.theoryLimitId),
        absoluteLimitId: cleanLevel(method.coverage.absoluteLimitId),
      },
      courses: method.courses.map((course) => ({
        ...course,
        levelId: cleanLevel(course.levelId),
      })),
    })),
    abilities: system.abilities.map((ability) => ({
      ...ability,
      unlockLevelId: cleanLevel(ability.unlockLevelId),
      cast: {
        ...ability.cast,
        fullPowerLevelId: cleanLevel(ability.cast.fullPowerLevelId),
      },
    })),
    formations: system.formations.map((formation) => ({
      ...formation,
      requiredLevelIds: formation.requiredLevelIds.filter(
        (id) => !levelIds.has(id),
      ),
    })),
    transitions: system.transitions.map((transition) => ({
      ...transition,
      fromLevelId: cleanLevel(transition.fromLevelId),
      toLevelId: cleanLevel(transition.toLevelId),
    })),
  };
}

function removeTrackReferences(
  system: CultivationSystem,
  trackId: string,
): CultivationSystem {
  const track = system.progressionTracks.find((item) => item.id === trackId);
  const levelIds = new Set(track?.levels.map((level) => level.id) ?? []);
  return removeLevelReferences(
    {
      ...system,
      progressionTracks: system.progressionTracks.filter(
        (item) => item.id !== trackId,
      ),
      trackInteractions: (system.trackInteractions ?? []).filter(
        (interaction) =>
          interaction.sourceTrackId !== trackId &&
          interaction.targetTrackId !== trackId,
      ),
      foundations: system.foundations.map((foundation) => ({
        ...foundation,
        affectedTracks: foundation.affectedTracks.filter(
          (id) => id !== trackId,
        ),
      })),
    },
    levelIds,
  );
}

function createSystem(): CultivationSystem {
  const systemId = newEcologyId("system");
  const trackId = newEcologyId("track");
  const levelId = newEcologyId("level");
  return {
    id: systemId,
    name: "新修行体系",
    summary: "",
    kind: "自定义体系",
    terminology: {
      energy: "能量",
      stage: "境界",
      method: "法门",
      ability: "能力",
    },
    projection: {
      originIds: [],
      manifestationIds: [],
      originBindings: [],
      access: "",
      translation: "",
      medium: "",
      attenuation: "",
    },
    theoryModel: {
      statement: "",
      summary: "",
      nodeTypes: [],
      invariants: [],
      validationRules: [],
      nodeCatalog: [],
    },
    progressionTracks: [
      {
        id: trackId,
        name: "主成长轨道",
        summary: "",
        mode: "修炼",
        structure: "ordered",
        metrics: [],
        levels: [
          {
            id: levelId,
            name: "起始境界",
            summary: "",
            order: 0,
            stageType: "境界",
            metricThresholds: [],
            quality: "",
            entryConditions: [],
            maintenanceConditions: [],
            breakthroughConditions: [],
            breakthroughResult: "",
            failureConsequences: [],
            degeneration: "",
            resourceRequirements: [],
            naturalAbilityIds: [],
            methodIds: [],
            subStages: createDefaultLevelSubStages(),
          },
        ],
        transitions: [],
      },
    ],
    trackInteractions: [],
    resources: [],
    methods: [],
    abilities: [],
    formations: [],
    foundations: [],
    transitions: [],
    constraints: [],
    audit: [],
  };
}

function createNode(): TheoryNode {
  return {
    id: newEcologyId("node"),
    name: "新理论节点",
    summary: "",
    kind: "节点",
    role: "",
    capacity: "",
    accessCondition: "",
    invariant: "",
    aliases: [],
  };
}
function createLevel(order: number): CultivationLevel {
  return {
    id: newEcologyId("level"),
    name: `新境界 ${order + 1}`,
    summary: "",
    order,
    stageType: "境界",
    metricThresholds: [],
    quality: "",
    entryConditions: [],
    maintenanceConditions: [],
    breakthroughConditions: [],
    breakthroughResult: "",
    failureConsequences: [],
    degeneration: "",
    resourceRequirements: [],
    naturalAbilityIds: [],
    methodIds: [],
    subStages: createDefaultLevelSubStages(),
  };
}

function createLevelSubStage(order: number): CultivationLevelSubStage {
  return {
    id: newEcologyId("level-stage"),
    name: `新阶段 ${order + 1}`,
    summary: "",
    order,
    metricThresholds: [],
    entryConditions: [],
    completionConditions: [],
    resourceRequirements: [],
    naturalAbilityIds: [],
    methodIds: [],
  };
}

function createDefaultLevelSubStages(): CultivationLevelSubStage[] {
  return ["前期", "中期", "后期"].map((name, order) => ({
    ...createLevelSubStage(order),
    name,
  }));
}
function createTrack(): ProgressionTrack {
  return {
    id: newEcologyId("track"),
    name: "新成长轨道",
    summary: "",
    mode: "修炼",
    structure: "ordered",
    metrics: [],
    levels: [],
    transitions: [],
  };
}
function createTrackInteraction(
  sourceTrackId: string,
  targetTrackId: string,
): TrackInteraction {
  return {
    id: newEcologyId("track-interaction"),
    name: "新轨道交叉规则",
    summary: "",
    sourceTrackId,
    targetTrackId,
    kind: "synchronization",
    rule: "",
    conditions: [],
    consequence: "",
    resourcePolicy: "",
    reversible: true,
  };
}
function createTransition(): Transition {
  return {
    id: newEcologyId("transition"),
    name: "新突破 / 转换",
    summary: "",
    fromLevelId: null,
    toLevelId: null,
    transitionType: "breakthrough",
    methodIds: [],
    conditions: [],
    resourceRequirements: [],
    successRule: "",
    successResult: "",
    failureResult: "",
    permanentConsequence: "",
    reversible: false,
  };
}
function createResource(): CultivationResource {
  return {
    id: newEcologyId("resource"),
    name: "新资源",
    summary: "",
    category: "能量",
    grades: [],
    bestLevelId: null,
    usableLevelIds: [],
    supply: "",
    environment: "",
    conversion: "",
    shortageConsequence: "",
  };
}
function createMethod(): CultivationMethod {
  return {
    id: newEcologyId("method"),
    name: "新修行法门",
    summary: "",
    kind: "修炼法门",
    theoryReference: "",
    script: [],
    formula: "",
    coverage: {
      startLevelId: null,
      stableLimitId: null,
      theoryLimitId: null,
      absoluteLimitId: null,
    },
    effects: {
      speed: "",
      conversion: "",
      quality: "",
      breakthrough: "",
      loss: "",
    },
    compatibility: [],
    risks: [],
    itemIds: [],
    operationTopologies: [],
    courses: [],
  };
}
function createAbility(): Ability {
  return {
    id: newEcologyId("ability"),
    name: "新能力",
    summary: "",
    acquisitionType: "scripture",
    functionType: "support",
    unlockLevelId: null,
    scriptureSource: {
      title: "新秘籍",
      methodId: null,
      itemIds: [],
      summary: "",
    },
    trainingRequirements: {
      conditions: [],
      methodIds: [],
      resourceRequirements: [],
      masteryFormula: "",
    },
    cast: {
      energyLabel: "体系能量",
      amount: "",
      model: "",
      cooldown: "",
      reserve: "",
      sustainedCost: "",
      debtConsequence: "",
      overloadThreshold: "",
      fullPowerLevelId: null,
      releaseCosts: [],
    },
    effect: "",
    amplificationModel: "",
    range: "",
    duration: "",
    limitations: [],
    counters: [],
  };
}

const FORMATION_CANVAS_SIZE = FORMATION_BASE_CANVAS_SIZE;
const FORMATION_CANVAS_CENTER = FORMATION_CANVAS_SIZE / 2;
const FORMATION_ELEMENT_LABELS: Record<
  Formation["nodes"][number]["element"],
  string
> = {
  source: "阵源",
  foundation: "阵基",
  pattern: "阵纹",
  eye: "阵眼",
  domain: "阵域",
  law: "阵则",
};
const FORMATION_ELEMENT_COLORS: Record<
  Formation["nodes"][number]["element"],
  string
> = {
  source: "#d7aa55",
  foundation: "#a87858",
  pattern: "#74aab7",
  eye: "#d9c98f",
  domain: "#8b87b8",
  law: "#b96c62",
};

function formationCanvasPosition(angle: number, radius: number, size: number) {
  const radians = ((angle - 90) * Math.PI) / 180;
  return {
    x: FORMATION_CANVAS_CENTER + Math.cos(radians) * radius - size / 2,
    y: FORMATION_CANVAS_CENTER + Math.sin(radians) * radius - size / 2,
  };
}

function createFormationScaffold(): Pick<
  Formation,
  "design" | "nodes" | "edges"
> {
  const innerRingId = newEcologyId("formation-ring");
  const patternRingId = newEcologyId("formation-ring");
  const domainRingId = newEcologyId("formation-ring");
  const boundaryRingId = newEcologyId("formation-ring");
  const ringSpecs: Formation["design"]["rings"] = [
    {
      id: innerRingId,
      name: "内枢",
      radius: 110,
      style: "double",
      color: "#d9c98f",
      strokeWidth: 2,
      rotation: 0,
      rotating: false,
      runes: "",
      visible: true,
      order: 0,
    },
    {
      id: patternRingId,
      name: "纹环",
      radius: 210,
      style: "runic",
      color: "#74aab7",
      strokeWidth: 1.5,
      rotation: 0,
      rotating: false,
      runes: "道生纹 · 纹生阵 · 气循其理 · 意御其枢 · ",
      visible: true,
      order: 1,
    },
    {
      id: domainRingId,
      name: "域环",
      radius: 320,
      style: "polygon",
      color: "#a87858",
      strokeWidth: 1.5,
      rotation: 30,
      rotating: false,
      runes: "",
      visible: true,
      order: 2,
    },
    {
      id: boundaryRingId,
      name: "天盘",
      radius: 420,
      style: "double",
      color: "#cdbb8c",
      strokeWidth: 3,
      rotation: 0,
      rotating: false,
      runes: "天地为盘 · 万物为子 · 大道为纹 · 人心为眼 · ",
      visible: true,
      order: 3,
    },
  ];
  const nodeSpecs: Array<{
    name: string;
    element: Formation["nodes"][number]["element"];
    ringId: string | null;
    angle: number;
    radius: number;
    glyph: string;
  }> = [
    {
      name: "主阵眼",
      element: "eye",
      ringId: null,
      angle: 0,
      radius: 0,
      glyph: "眼",
    },
    {
      name: "引灵阵源",
      element: "source",
      ringId: boundaryRingId,
      angle: 0,
      radius: 420,
      glyph: "源",
    },
    {
      name: "镇域阵基",
      element: "foundation",
      ringId: domainRingId,
      angle: 72,
      radius: 320,
      glyph: "基",
    },
    {
      name: "周天阵纹",
      element: "pattern",
      ringId: patternRingId,
      angle: 144,
      radius: 210,
      glyph: "纹",
    },
    {
      name: "结界阵域",
      element: "domain",
      ringId: domainRingId,
      angle: 216,
      radius: 320,
      glyph: "域",
    },
    {
      name: "归元阵则",
      element: "law",
      ringId: patternRingId,
      angle: 288,
      radius: 210,
      glyph: "则",
    },
  ];
  const nodes: Formation["nodes"] = nodeSpecs.map((spec) => {
    const size = spec.element === "eye" ? 92 : 72;
    const canvasPosition = formationCanvasPosition(
      spec.angle,
      spec.radius,
      size,
    );
    return {
      id: newEcologyId("formation-node"),
      name: spec.name,
      kind: "阵元",
      role: FORMATION_ELEMENT_LABELS[spec.element],
      theoryNodeId: null,
      position: {
        x: ((canvasPosition.x + size / 2) / FORMATION_CANVAS_SIZE) * 100,
        y: ((canvasPosition.y + size / 2) / FORMATION_CANVAS_SIZE) * 100,
      },
      canvasPosition,
      ringId: spec.ringId,
      angle: spec.angle,
      size,
      color: FORMATION_ELEMENT_COLORS[spec.element],
      glyph: spec.glyph,
      element: spec.element,
      nodeStyle: spec.element === "source" ? "orb" : "seal",
    };
  });
  const edgePairs = [
    [1, 2],
    [2, 3],
    [3, 0],
    [0, 4],
    [4, 5],
    [5, 1],
  ] as const;
  const edges: Formation["edges"] = edgePairs.map(
    ([fromIndex, toIndex], order) => ({
      id: newEcologyId("formation-edge"),
      name: `${nodes[fromIndex].name} · ${nodes[toIndex].name}`,
      fromNodeId: nodes[fromIndex].id,
      toNodeId: nodes[toIndex].id,
      order,
      rule: "",
      flowType: "灵流",
      lineStyle: "bezier",
      color: nodes[fromIndex].color,
      animated: true,
    }),
  );
  return {
    design: {
      layout: "concentric",
      canvasStyle: "mystic",
      ...createFormationBackdropPreset("classic", () =>
        newEcologyId("formation-backdrop"),
      ),
      rings: ringSpecs,
    },
    nodes,
    edges,
  };
}

function createFormation(): Formation {
  const scaffold = createFormationScaffold();
  return {
    id: newEcologyId("formation"),
    name: "新阵法",
    summary: "",
    category: "法阵",
    structure: "network",
    scale: "",
    purpose: "",
    theoryNodeIds: [],
    requiredLevelIds: [],
    methodIds: [],
    operationTopologyIds: [],
    abilityIds: [],
    itemIds: [],
    activationConditions: [],
    resourceRequirements: [],
    activation: "",
    maintenance: "",
    output: "",
    boundary: "",
    risks: [],
    countermeasures: "",
    sixElements: {
      source: "",
      foundation: "",
      pattern: "",
      eye: "",
      domain: "",
      law: "",
    },
    ...scaffold,
  };
}

export default function CultivationEcologyWorkbench({
  storage,
  projectTitle,
  headerActions,
  onAiRun,
  proposalReviewOpen = false,
  onCloseProposalReview,
  registerNavigationGuard,
  isActive = true,
}: {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly headerActions?: ReactNode;
  readonly onAiRun?: (request: CultivationAiRunRequest) => Promise<string>;
  readonly proposalReviewOpen?: boolean;
  readonly onCloseProposalReview?: () => void;
  readonly registerNavigationGuard: (
    guard: WorkbenchNavigationGuard,
  ) => () => void;
  /** 是否为当前激活标签页；从其它标签页切回时刷新外部变更。 */
  readonly isActive?: boolean;
}) {
  const repository = useMemo(
    () => createCultivationEcologyRepository(storage),
    [storage],
  );
  const itemLibraryRepository = useMemo(
    () => createNovelItemLibraryRepository(storage),
    [storage],
  );
  const [ecology, setEcology] = useState<CultivationEcology | null>(null);
  const [content, setContent] = useState("");
  const [activeSystemId, setActiveSystemId] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>("system");
  const [module, setModule] = useState<ModuleId>("overview");
  const [selection, setSelection] = useState<Selection>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [formationEditorId, setFormationEditorId] = useState<string | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [error, setError] = useState("");
  const [itemEntries, setItemEntries] = useState<readonly ItemIndexEntry[]>([]);
  const [itemLibraryLoading, setItemLibraryLoading] = useState(false);
  const [itemLibraryReady, setItemLibraryReady] = useState(false);
  const [itemLibraryError, setItemLibraryError] = useState("");
  const [systemDeleteTarget, setSystemDeleteTarget] = useState<{
    id: string;
    name: string;
    boundCharacterCount?: number;
    boundCharacterPreview?: string;
  } | null>(null);
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    if (!inspectorOpen && !formationEditorId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 输入控件内按 Escape 由控件自身处理，不关闭面板/编辑器。
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      )
        return;
      // formation 编辑器是全屏 dialog，优先关闭；inspector 是侧栏面板。
      if (formationEditorId) setFormationEditorId(null);
      else if (inspectorOpen) setInspectorOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [formationEditorId, inspectorOpen]);

  const reloadEcology = useCallback(async () => {
    setLoading(true);
    setError("");
    setSaveFailed(false);
    try {
      const loaded = await repository.load();
      const result = loaded ?? (await repository.initialize());
      const audited = rebuildCultivationAudits(result.ecology);
      setEcology(audited);
      setContent(result.content);
      setActiveSystemId((current) =>
        audited.systems.some((system) => system.id === current)
          ? current
          : (audited.systems[0]?.id ?? null),
      );
      setSelection((current) =>
        current && audited.systems.some((system) => system.id === current.id)
          ? current
          : audited.systems[0]
            ? { kind: "system", id: audited.systems[0].id }
            : null,
      );
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [repository]);

  const ecologyRef = useRef<CultivationEcology | null>(null);
  useEffect(() => {
    ecologyRef.current = ecology;
  }, [ecology]);

  // 首次挂载或 storage 引用变化时加载；若已有未保存编辑则保留本地修改，避免静默覆盖。
  useEffect(() => {
    if (ecologyRef.current && dirtyRef.current) return;
    void reloadEcology();
  }, [reloadEcology]);
  useEffect(() => {
    let disposed = false;
    if (!storage.isAvailable) {
      setItemLibraryReady(false);
      setItemLibraryError("当前模式无法读取物品库，仍可手动维护物品 ID。");
      return () => {
        disposed = true;
      };
    }
    setItemLibraryLoading(true);
    setItemLibraryError("");
    void itemLibraryRepository
      .load()
      .then((library) => {
        if (disposed) return;
        setItemEntries(library.index.items);
        setItemLibraryReady(true);
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setItemLibraryReady(false);
        setItemLibraryError(
          cause instanceof Error ? cause.message : String(cause),
        );
      })
      .finally(() => {
        if (!disposed) setItemLibraryLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [itemLibraryRepository, storage.isAvailable]);

  const activeSystem = useMemo(
    () => (ecology ? getActiveSystem(ecology, activeSystemId) : null),
    [ecology, activeSystemId],
  );
  const availableItemIds = useMemo(
    () =>
      itemLibraryReady
        ? new Set(itemEntries.map((item) => item.id))
        : undefined,
    [itemEntries, itemLibraryReady],
  );
  const commit = (next: CultivationEcology) => {
    // 审计重建由下方防抖 effect 异步完成，避免每次击键都全量 rebuild。
    setEcology(next);
    setDirty(true);
  };
  const updateSystem = (next: CultivationSystem) => {
    if (!ecology) return;
    const previousSystem = ecology.systems.find(
      (candidate) => candidate.id === next.id,
    );
    const previousIds = previousSystem
      ? collectSystemAssetIds(previousSystem)
      : new Set<string>();
    const nextIds = collectSystemAssetIds(next);
    const removedIds = new Set(
      [...previousIds].filter((assetId) => !nextIds.has(assetId)),
    );
    const nextEcology =
      removedIds.size === 0
        ? ecology
        : removeAssetFromCrossSystemRelations(ecology, removedIds);
    commit({
      ...nextEcology,
      systems: updateById(nextEcology.systems, next.id, () => next),
    });
  };
  const [isAiRunning, setIsAiRunning] = useState(false);
  const getAiTarget = (): CultivationAiTarget | null => {
    const currentEcology = ecology;
    if (!currentEcology) return null;
    const selectedId = selection?.id;
    const selected = <T extends { id: string }>(items: readonly T[]) =>
      items.find((item) => item.id === selectedId) ?? items[0];
    const systemTarget = (
      label: string,
      value: Record<string, unknown>,
      apply: (next: Record<string, unknown>) => void,
      schema: z.ZodType,
    ): CultivationAiTarget => ({ label, value, apply, schema });

    if (scope === "origins") {
      const origin = selected(currentEcology.worldOrigins);
      if (!origin) return null;
      return systemTarget(
        "世界本源",
        origin as unknown as Record<string, unknown>,
        (next) =>
          commit({
            ...currentEcology,
            worldOrigins: updateById(
              currentEcology.worldOrigins,
              origin.id,
              () => next as unknown as WorldOrigin,
            ),
          }),
        worldOriginSchema,
      );
    }
    if (scope === "relations") {
      const relation = selected(currentEcology.crossSystemRelations);
      if (!relation) return null;
      return systemTarget(
        "跨体系关系",
        relation as unknown as Record<string, unknown>,
        (next) =>
          commit({
            ...currentEcology,
            crossSystemRelations: updateById(
              currentEcology.crossSystemRelations,
              relation.id,
              () => next as unknown as typeof relation,
            ),
          }),
        crossSystemRelationSchema,
      );
    }
    if (!activeSystem) return null;
    if (module === "projection")
      return systemTarget(
        "本源投影",
        activeSystem.projection as unknown as Record<string, unknown>,
        (next) =>
          updateSystem({
            ...activeSystem,
            projection: next as typeof activeSystem.projection,
          }),
        cultivationProjectionSchema,
      );
    if (module === "theory")
      return systemTarget(
        "理论模型",
        activeSystem.theoryModel as unknown as Record<string, unknown>,
        (next) =>
          updateSystem({
            ...activeSystem,
            theoryModel: next as typeof activeSystem.theoryModel,
          }),
        theoryModelSchema,
      );

    const target =
      module === "resources"
        ? selected(activeSystem.resources)
        : module === "methods"
          ? selected(activeSystem.methods)
          : module === "abilities"
            ? selected(activeSystem.abilities)
            : module === "formations"
              ? selected(activeSystem.formations)
              : module === "foundations"
                ? selected(activeSystem.foundations)
                : module === "constraints"
                  ? selected(activeSystem.constraints)
                  : module === "transitions"
                    ? selected([
                        ...activeSystem.transitions,
                        ...activeSystem.progressionTracks.flatMap(
                          (track) => track.transitions,
                        ),
                      ])
                    : module === "progression"
                      ? selected([
                          ...activeSystem.progressionTracks,
                          ...activeSystem.progressionTracks.flatMap((track) => [
                            ...track.levels,
                            ...track.levels.flatMap((level) => level.subStages),
                            ...track.transitions,
                          ]),
                        ])
                      : undefined;
    if (target) {
      const targetSchema = (() => {
        if (module !== "progression") {
          if (module === "resources") return resourceSchema;
          if (module === "methods") return cultivationMethodSchema;
          if (module === "abilities") return abilitySchema;
          if (module === "formations") return formationSchema;
          if (module === "foundations") return foundationSchema;
          if (module === "constraints") return constraintSchema;
          return transitionSchema;
        }
        // progression 模块的 target 可能是轨道 / 境界 / 境内阶段 / 跃迁，按 id 归属判断。
        if (
          activeSystem.progressionTracks.some(
            (track) => track.id === target.id,
          )
        )
          return progressionTrackSchema;
        if (
          activeSystem.progressionTracks.some((track) =>
            track.levels.some((level) => level.id === target.id),
          )
        )
          return levelSchema;
        if (
          activeSystem.progressionTracks.some((track) =>
            track.levels.some((level) =>
              level.subStages.some((stage) => stage.id === target.id),
            ),
          )
        )
          return levelSubStageSchema;
        return transitionSchema;
      })();
      return systemTarget(
        moduleMeta[module].title,
        target as unknown as Record<string, unknown>,
        (next) => {
          const replace = <T extends { id: string }>(items: readonly T[]) =>
            updateById(items, target.id, () => next as unknown as T);
          if (module === "resources")
            updateSystem({
              ...activeSystem,
              resources: replace(activeSystem.resources),
            });
          else if (module === "methods")
            updateSystem({
              ...activeSystem,
              methods: replace(activeSystem.methods),
            });
          else if (module === "abilities")
            updateSystem({
              ...activeSystem,
              abilities: replace(activeSystem.abilities),
            });
          else if (module === "formations")
            updateSystem({
              ...activeSystem,
              formations: replace(activeSystem.formations),
            });
          else if (module === "foundations")
            updateSystem({
              ...activeSystem,
              foundations: replace(activeSystem.foundations),
            });
          else if (module === "constraints")
            updateSystem({
              ...activeSystem,
              constraints: replace(activeSystem.constraints),
            });
          else if (module === "transitions") {
            const rootTransitions = replace(activeSystem.transitions);
            const tracks = activeSystem.progressionTracks.map((track) => ({
              ...track,
              transitions: replace(track.transitions),
            }));
            updateSystem({
              ...activeSystem,
              transitions: rootTransitions,
              progressionTracks: tracks,
            });
          } else if (module === "progression") {
            const tracks = activeSystem.progressionTracks.map((track) => ({
              ...track,
              ...(track.id === target.id
                ? (next as unknown as ProgressionTrack)
                : {}),
              levels: updateById(
                track.levels,
                target.id,
                () => next as unknown as CultivationLevel,
              ).map((level) => ({
                ...level,
                subStages: updateById(
                  level.subStages,
                  target.id,
                  () => next as unknown as CultivationLevelSubStage,
                ),
              })),
              transitions: updateById(
                track.transitions,
                target.id,
                () => next as unknown as Transition,
              ),
            }));
            updateSystem({ ...activeSystem, progressionTracks: tracks });
          }
        },
        targetSchema,
      );
    }
    return systemTarget(
      moduleMeta[module].title,
      activeSystem as unknown as Record<string, unknown>,
      (next) => updateSystem(next as unknown as CultivationSystem),
      cultivationSystemSchema,
    );
  };
  const runCultivationAi = async () => {
    if (!onAiRun || isAiRunning) return;
    const target = getAiTarget();
    if (!target) {
      setError("当前模块没有可供 AI 完善的对象");
      return;
    }
    setIsAiRunning(true);
    setError("");
    try {
      const output = await onAiRun({
        sceneId: "cultivation.module",
        label: `AI 完善${target.label}`,
        systemPrompt:
          "你是严谨的中文修行体系编辑。只输出严格 JSON 对象，不要 Markdown 围栏或解释。只能补充当前对象已有字段中的非空文本、数字、布尔值或嵌套对象字段；不得修改 id、名称、稳定引用数组、审查字段、schemaVersion、updatedAt，也不得删除已有内容。",
        prompt: `请完善当前修行模块对象中空缺或明显薄弱的字段。只返回确实需要变化的字段，保留未变化字段不要重复返回。禁止返回数组字段，禁止修改任何 id 或引用关系。\n\n模块：${target.label}\n当前对象：\n${JSON.stringify(target.value, null, 2).slice(0, 24_000)}`,
      });
      let parsed: unknown;
      try {
        const trimmed = output
          .trim()
          .replace(/^```(?:json)?\s*/iu, "")
          .replace(/\s*```$/u, "");
        parsed = JSON.parse(trimmed);
      } catch (cause) {
        throw new Error(
          `AI 完善结果不是有效 JSON：${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("AI 完善结果必须是 JSON 对象");
      const patchValue = parsed as Record<string, unknown>;
      const merge = (
        base: Record<string, unknown>,
        patch: Record<string, unknown>,
      ): Record<string, unknown> => {
        const next = { ...base };
        for (const [key, value] of Object.entries(patch)) {
          if (
            !(key in base) ||
            key === "id" ||
            key === "name" ||
            key === "audit" ||
            key === "schemaVersion" ||
            key === "updatedAt" ||
            Array.isArray(value)
          )
            continue;
          if (
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            base[key] &&
            typeof base[key] === "object" &&
            !Array.isArray(base[key])
          ) {
            next[key] = merge(
              base[key] as Record<string, unknown>,
              value as Record<string, unknown>,
            );
          } else if (
            value !== null &&
            value !== undefined &&
            base[key] !== null &&
            typeof value === typeof base[key] &&
            (typeof value !== "string" || value.trim())
          ) {
            next[key] = value;
          }
        }
        return next;
      };
      const merged = merge(target.value, patchValue);
      if (JSON.stringify(merged) === JSON.stringify(target.value))
        throw new Error("AI 没有返回可应用的字段补全");
      // 过 zod 校验：拒绝 AI 引入的非法枚举、越界数值或结构错误，
      // 避免污染内存导致保存时严格 parse 直接失败。
      const validated = target.schema.safeParse(merged);
      if (!validated.success) {
        const detail = validated.error.issues
          .slice(0, 3)
          .map(
            (issue) =>
              `${issue.path.join(".") || "root"}: ${issue.message}`,
          )
          .join("；");
        throw new Error(`AI 完善结果未通过数据校验：${detail}`);
      }
      target.apply(validated.data as Record<string, unknown>);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsAiRunning(false);
    }
  };
  // 审计重建：防抖 250ms，连续编辑只重建一次；audit 签名不变时不更新状态，
  // 避免 setEcology → effect 再执行 的循环。保存时 repository 会再次重建保证落盘准确。
  useEffect(() => {
    if (!ecology) return;
    const timer = window.setTimeout(() => {
      setEcology((current) => {
        if (!current) return current;
        const next = rebuildCultivationAudits(current, {
          itemIds: availableItemIds,
        });
        const currentAuditSignature = JSON.stringify(
          current.systems.map((system) => system.audit),
        );
        const nextAuditSignature = JSON.stringify(
          next.systems.map((system) => system.audit),
        );
        return currentAuditSignature === nextAuditSignature ? current : next;
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [ecology, availableItemIds]);
  const save = async (): Promise<boolean> => {
    if (!ecology || !dirty) return true;
    setSaving(true);
    setError("");
    try {
      const result = await repository.save(ecology, content);
      setEcology(
        rebuildCultivationAudits(result.ecology, { itemIds: availableItemIds }),
      );
      setContent(result.content);
      setDirty(false);
      setSaveFailed(false);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaveFailed(true);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  // 打开提案审阅前先落盘未保存编辑，避免应用提案后 reload 静默覆盖本地修改。
  useEffect(() => {
    if (!proposalReviewOpen) return;
    if (dirtyRef.current) void saveRef.current();
  }, [proposalReviewOpen]);
  // 组件卸载时兜底保存未保存编辑（防御导航守卫之外的异常卸载路径）。
  useEffect(
    () => () => {
      if (dirtyRef.current) void saveRef.current();
    },
    [],
  );
  // 从其它标签页切回时刷新外部变更，但不覆盖未保存编辑。
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (isActive && !wasActiveRef.current && !dirtyRef.current)
      void reloadEcology();
    wasActiveRef.current = isActive;
  }, [isActive, reloadEcology]);
  const addSystem = () => {
    if (!ecology) return;
    const system = createSystem();
    commit({ ...ecology, systems: [...ecology.systems, system] });
    setActiveSystemId(system.id);
    setScope("system");
    setModule("overview");
    setSelection({ kind: "system", id: system.id });
    setInspectorOpen(true);
    setFormationEditorId(null);
  };
  const requestDeleteSystem = (
    targetSystem: CultivationSystem | null = activeSystem,
  ) => {
    if (!targetSystem) return;
    setSystemDeleteTarget({
      id: targetSystem.id,
      name: targetSystem.name,
    });
  };
  const confirmDeleteSystem = async (confirmedBoundReferences = false) => {
    if (!ecology || !systemDeleteTarget) return;
    const deletedSystemId = systemDeleteTarget.id;
    const deletedSystem = ecology.systems.find(
      (item) => item.id === deletedSystemId,
    );
    // 删除前检查人物库反向引用：删除体系会让人物的 systemId/levelId 悬空，
    // 而人物保存严格要求引用闭合（characterLibraryRepository），会导致后续保存失败。
    if (!confirmedBoundReferences) {
      try {
        const [characterIndexEntry] = await storage.stat([
          "characters/index.json",
        ]);
        if (characterIndexEntry?.exists) {
          const characterFile = await storage.readText("characters/index.json");
          const characterIndex = parseCharacterLibraryIndex(
            characterFile.content,
          );
          const characterRepository = createNovelCharacterLibraryRepository(
            storage,
          );
          const characterRecords = await Promise.all(
            characterIndex.characters.map(async (entry) =>
              (await characterRepository.loadCharacter(entry)).record,
            ),
          );
          const boundCharacters = characterRecords.filter(
            (character) => character.cultivationProfile.systemId === deletedSystemId,
          );
          if (boundCharacters.length > 0) {
            setError("");
            setSystemDeleteTarget({
              ...systemDeleteTarget,
              boundCharacterCount: boundCharacters.length,
              boundCharacterPreview: boundCharacters
                .slice(0, 3)
                .map((character) => character.name)
                .join("、"),
            });
            return;
          }
        }
      } catch (cause) {
        setError(
          `检查人物库引用失败，已取消删除：${cause instanceof Error ? cause.message : String(cause)}`,
        );
        setSystemDeleteTarget(null);
        return;
      }
    }
    const deletedAssetIds = deletedSystem
      ? collectSystemAssetIds(deletedSystem)
      : new Set<string>();
    const nextSystems = ecology.systems.filter(
      (item) => item.id !== deletedSystemId,
    );
    const ecologyWithoutAssets = removeAssetFromCrossSystemRelations(
      ecology,
      deletedAssetIds,
    );
    commit({
      ...ecologyWithoutAssets,
      systems: nextSystems,
      worldOrigins: ecology.worldOrigins.map((origin) => ({
        ...origin,
        canvasPositions: Object.fromEntries(
          Object.entries(origin.canvasPositions ?? {}).filter(
            ([id]) => id !== deletedSystemId,
          ),
        ),
      })),
      crossSystemRelations: ecologyWithoutAssets.crossSystemRelations.filter(
        (item) =>
          item.sourceSystemId !== deletedSystemId &&
          item.targetSystemId !== deletedSystemId,
      ),
    });
    const next = nextSystems[0];
    setActiveSystemId(next?.id ?? null);
    setSelection(next ? { kind: "system", id: next.id } : null);
    setInspectorOpen(false);
    setFormationEditorId(null);
    setSystemDeleteTarget(null);
  };
  const selectAndOpenInspector = (nextSelection: Selection) => {
    setSelection(nextSelection);
    setInspectorOpen(Boolean(nextSelection));
    // inspector 与 formation 编辑器互斥，打开 inspector 时关闭全屏编辑器。
    setFormationEditorId(null);
  };
  const closeInspector = () => setInspectorOpen(false);
  const openModule = (nextModule: ModuleId, nextSelection?: Selection) => {
    setScope("system");
    setModule(nextModule);
    setFormationEditorId(null);
    selectAndOpenInspector(
      nextSelection ?? getModuleSelection(activeSystem, nextModule),
    );
  };
  const openRelations = (nextSelection?: Selection) => {
    setScope("relations");
    setFormationEditorId(null);
    selectAndOpenInspector(nextSelection ?? null);
  };

  if (loading)
    return (
      <div className="ce-loading">
        <Loader2 className="h-5 w-5 animate-spin" />
        正在加载修行生态…
      </div>
    );
  if (!ecology)
    return (
      <div className="ce-loading">
        <AlertTriangle className="h-5 w-5" />
        {error || "修行生态不可用"}
      </div>
    );

  const pageMeta = getPageMeta(scope, activeSystem, module);
  const formationEditor = formationEditorId
    ? activeSystem?.formations.find((item) => item.id === formationEditorId)
    : undefined;
  const aiActionButton = (
    <Button
      variant="ghost"
      disabled={!onAiRun || isAiRunning}
      onClick={() => void runCultivationAi()}
      title={onAiRun ? "使用轻量 AI 完善当前模块" : "轻量 AI 当前不可用"}
      ariaLabel="AI 完善当前模块"
    >
      {isAiRunning ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Sparkles className="h-3.5 w-3.5" />
      )}
      {isAiRunning ? "AI 完善中" : "AI 完善当前模块"}
    </Button>
  );
  return (
    <div className="ce-shell">
      <NarrativeUnsavedChangesGuard
        dirty={dirty}
        label="修炼体系"
        registerNavigationGuard={registerNavigationGuard}
        onSave={save}
      />
      <header className="ce-topbar">
        <div className="ce-brand">
          <span className="ce-brand-mark">
            <Waypoints className="h-4 w-4" />
          </span>
          <div>
            <strong>修炼体系</strong>
            <small>{projectTitle} · 新版修炼体系模型</small>
          </div>
        </div>
        <div className="ce-top-actions">
          {error && <span className="ce-error-text">{error}</span>}
          {saveFailed && (
            <button
              type="button"
              className="ce-reload-button"
              title="放弃本地未保存的修改，从磁盘重新加载修行生态数据"
              onClick={() => void reloadEcology()}
            >
              放弃修改并重新加载
            </button>
          )}
          {headerActions}
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={saving || !dirty}
          >
            <>
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              保存
            </>
          </Button>
        </div>
      </header>
      <div
        className={`ce-body ${scope === "origins" ? "ce-body-no-inspector" : ""}`}
      >
        <aside className="ce-sidebar">
          <div className="ce-sidebar-group">
            <span className="ce-sidebar-label">项目全局</span>
            <button
              type="button"
              className={`ce-nav-item ${scope === "origins" ? "is-active" : ""}`}
              onClick={() => {
                setScope("origins");
                setSelection(null);
                setInspectorOpen(false);
                setFormationEditorId(null);
              }}
            >
              <Sparkles className="h-4 w-4" />
              <span>世界本源</span>
              <span className="ce-sidebar-count">
                {ecology.worldOrigins.length}
              </span>
            </button>
            <button
              type="button"
              className={`ce-nav-item ${scope === "relations" ? "is-active" : ""}`}
              onClick={() => {
                setScope("relations");
                setSelection(null);
                setInspectorOpen(false);
                setFormationEditorId(null);
              }}
            >
              <Link2 className="h-4 w-4" />
              <span>跨体系关系</span>
            </button>
          </div>
          <div className="ce-sidebar-group ce-system-group ce-system-block">
            <div className="ce-sidebar-label-row">
              <span className="ce-sidebar-label">修行体系</span>
              <Button variant="ghost" onClick={addSystem} title="新增修行体系">
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="ce-system-list">
              {ecology.systems.map((system) => (
                <div key={system.id} className="ce-system-entry">
                  <button
                    type="button"
                    className={`ce-system-item ${activeSystemId === system.id && scope === "system" ? "is-active" : ""}`}
                    onClick={() => {
                      setActiveSystemId(system.id);
                      setScope("system");
                      setModule("overview");
                      setSelection({ kind: "system", id: system.id });
                      setInspectorOpen(false);
                      setFormationEditorId(null);
                    }}
                  >
                    <span className="ce-system-icon">
                      <Boxes className="h-3.5 w-3.5 shrink-0" />
                    </span>
                    <span>
                      <strong>{system.name}</strong>
                      <small>
                        {system.kind} · {system.methods.length} 部法门
                      </small>
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 ce-system-arrow" />
                  </button>
                  <div className="ce-system-actions">
                    <button
                      type="button"
                      className="ce-system-action ce-system-edit"
                      title={`编辑体系「${system.name}」`}
                      aria-label={`编辑体系「${system.name}」`}
                      onClick={() => {
                        setActiveSystemId(system.id);
                        setScope("system");
                        setModule("overview");
                        setFormationEditorId(null);
                        selectAndOpenInspector({
                          kind: "system",
                          id: system.id,
                        });
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="ce-system-action ce-system-delete"
                      title={`删除体系「${system.name}」`}
                      aria-label={`删除体系「${system.name}」`}
                      onClick={() => requestDeleteSystem(system)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="ce-sidebar-footer">
            <Activity className="h-3.5 w-3.5" />
            <span>结构审查</span>
            <strong>
              {activeSystem?.audit.filter((item) => !item.resolved).length ?? 0}{" "}
              项待处理
            </strong>
          </div>
        </aside>
        <main className="ce-main">
          {scope === "relations" && (
            <div className="ce-main-header">
              <div>
                <h1>{pageMeta.title}</h1>
                <p>{pageMeta.description}</p>
              </div>
            </div>
          )}
          {scope === "system" && (
            <nav className="ce-module-nav" aria-label="修行体系模块">
              <div className="ce-module-tabs">
                {modules.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      type="button"
                      key={item.id}
                      className={module === item.id ? "is-active" : ""}
                      onClick={() => {
                        setModule(item.id);
                        setSelection(getModuleSelection(activeSystem, item.id));
                        setInspectorOpen(false);
                        setFormationEditorId(null);
                      }}
                      aria-pressed={module === item.id}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {item.label}
                    </button>
                  );
                })}
              </div>
              <div className="ce-module-nav-action">{aiActionButton}</div>
            </nav>
          )}
          <div className="ce-page-stage">
            {(scope === "origins" || scope === "relations") && (
              <div className="flex shrink-0 items-center justify-end gap-2 border-b border-[var(--line-subtle)] px-5 py-2">
                {error && (
                  <span className="mr-auto truncate text-xs text-[var(--danger)]">
                    {error}
                  </span>
                )}
                {aiActionButton}
              </div>
            )}
            <div
              className={`ce-main-scroll ${scope === "origins" ? "ce-main-scroll-world-origin" : ""} ${scope === "system" && module === "overview" ? "ce-main-scroll-overview" : ""}`}
            >
              {scope === "origins" ? (
                <WorldOriginWorkspace
                  ecology={ecology}
                  selection={selection}
                  onChange={commit}
                  onSelect={selectAndOpenInspector}
                />
              ) : scope === "relations" ? (
                <Relations
                  ecology={ecology}
                  onChange={commit}
                  onSelect={selectAndOpenInspector}
                />
              ) : activeSystem ? (
                <SystemModule
                  worldOrigins={ecology.worldOrigins}
                  system={activeSystem}
                  module={module}
                  selection={selection}
                  onChange={updateSystem}
                  onSelect={selectAndOpenInspector}
                  onOpenModule={openModule}
                  onOpenRelations={openRelations}
                  onOpenFormationEditor={(formationId) => {
                    setFormationEditorId(formationId);
                    setInspectorOpen(false);
                  }}
                />
              ) : (
                <Empty text="请先创建一个修行体系" />
              )}
            </div>
            {formationEditor && activeSystem && module === "formations" && (
              <section
                className="ce-formation-editor-layer"
                role="dialog"
                aria-modal="true"
                aria-labelledby="ce-formation-editor-title"
              >
                <header className="ce-formation-editor-header">
                  <div>
                    <span>阵图编辑</span>
                    <h2 id="ce-formation-editor-title">
                      {formationEditor.name}
                    </h2>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() => setFormationEditorId(null)}
                    title="关闭全屏编辑"
                    ariaLabel="关闭全屏编辑"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </header>
                <div className="ce-formation-editor-body">
                  <FormationDesignCanvas
                    system={activeSystem}
                    formation={formationEditor}
                    onChange={updateSystem}
                    onSelect={selectAndOpenInspector}
                  />
                </div>
              </section>
            )}
            {inspectorOpen && selection && (
              <div className="ce-inspector-layer">
                <button
                  type="button"
                  className="ce-inspector-backdrop"
                  aria-label="关闭检查器"
                  onClick={closeInspector}
                />
                <aside
                  className="ce-inspector ce-inspector-drawer"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="ce-inspector-drawer-title"
                >
                  <div className="ce-inspector-drawer-header">
                    <h2 id="ce-inspector-drawer-title">
                      {scope === "origins"
                        ? "本源检查"
                        : scope === "relations"
                          ? "关系检查"
                          : "对象检查"}
                    </h2>
                    <Button
                      variant="ghost"
                      onClick={closeInspector}
                      title="关闭检查器"
                      ariaLabel="关闭检查器"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="ce-inspector-drawer-body">
                    <InspectorV2
                      scope={scope}
                      ecology={ecology}
                      system={activeSystem}
                      selection={selection}
                      onChange={commit}
                      onChangeSystem={updateSystem}
                      onDeleteSystem={requestDeleteSystem}
                      onSelect={selectAndOpenInspector}
                      itemEntries={itemEntries}
                      itemLibraryLoading={itemLibraryLoading}
                      itemLibraryError={itemLibraryError}
                    />
                  </div>
                </aside>
              </div>
            )}
          </div>
        </main>
      </div>
      {systemDeleteTarget && (
        <ConfirmDialog
          title={`删除修行体系「${systemDeleteTarget.name}」`}
          message={
            systemDeleteTarget.boundCharacterCount
              ? `仍有 ${systemDeleteTarget.boundCharacterCount} 位角色（${systemDeleteTarget.boundCharacterPreview}${systemDeleteTarget.boundCharacterCount > 3 ? " 等" : ""}）绑定该体系。删除后这些角色的修行体系引用将失效，后续保存人物时可能需要先解除引用。仍要继续删除吗？`
              : "关联的跨体系关系也将一并删除，且此操作不可撤销。"
          }
          confirmText={
            systemDeleteTarget.boundCharacterCount ? "仍要删除体系" : "删除体系"
          }
          confirmVariant="danger"
          onConfirm={() =>
            void confirmDeleteSystem(
              Boolean(systemDeleteTarget.boundCharacterCount),
            )
          }
          onCancel={() => setSystemDeleteTarget(null)}
        />
      )}
      {proposalReviewOpen && onCloseProposalReview && (
        <WorldProposalReview
          storage={storage}
          projectTitle={projectTitle}
          onClose={onCloseProposalReview}
          repositoryFactory={createNovelCultivationProposalRepository}
          reviewTitle="修行体系提案"
          proposalSubject="修行体系"
          onApplied={() => {
            if (dirtyRef.current) {
              setError(
                "修行体系提案已应用，但存在未保存的本地修改，已保留当前编辑；如要采用提案内容，请先保存或放弃修改后重新加载。",
              );
              return;
            }
            void reloadEcology();
          }}
        />
      )}
    </div>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
  action,
  compact = false,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`ce-page-header${compact ? " ce-page-header-compact" : ""}`}>
      <div>
        {eyebrow && <div className="ce-eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="ce-page-action">{action}</div>}
    </div>
  );
}

function StatStrip({ system }: { system: CultivationSystem }) {
  const stats = [
    { label: "理论节点", value: system.theoryModel.nodeCatalog.length },
    {
      label: "成长境界",
      value: system.progressionTracks.reduce(
        (total, track) => total + track.levels.length,
        0,
      ),
    },
    { label: "修行法门", value: system.methods.length },
    { label: "能力", value: system.abilities.length },
    { label: "阵法", value: system.formations.length },
  ];
  return (
    <div className="ce-stat-strip">
      {stats.map((item) => (
        <div key={item.label}>
          <strong>{item.value}</strong>
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function SystemModule({
  worldOrigins,
  system,
  module,
  selection,
  onChange,
  onSelect,
  onOpenModule,
  onOpenRelations,
  onOpenFormationEditor,
}: {
  worldOrigins: readonly WorldOrigin[];
  system: CultivationSystem;
  module: ModuleId;
  selection: Selection;
  onChange: (system: CultivationSystem) => void;
  onSelect: (selection: Selection) => void;
  onOpenModule: (module: ModuleId, selection?: Selection) => void;
  onOpenRelations: (selection?: Selection) => void;
  onOpenFormationEditor: (formationId: string) => void;
}) {
  if (module === "overview")
    return <Overview system={system} onOpenModule={onOpenModule} />;
  if (module === "projection")
    return (
      <Projection
        worldOrigins={worldOrigins}
        system={system}
        onChange={onChange}
        onSelect={onSelect}
      />
    );
  if (module === "theory")
    return <Theory system={system} onChange={onChange} onSelect={onSelect} />;
  if (module === "progression")
    return (
      <Progression system={system} onChange={onChange} onSelect={onSelect} />
    );
  if (module === "resources")
    return (
      <ResourceDirectory
        system={system}
        onChange={onChange}
        onSelect={onSelect}
      />
    );
  if (module === "methods")
    return (
      <MethodWorkspace
        system={system}
        onChange={onChange}
        onSelect={onSelect}
        selection={selection}
      />
    );
  if (module === "abilities")
    return (
      <AbilityDirectory
        system={system}
        onChange={onChange}
        onSelect={onSelect}
      />
    );
  if (module === "formations")
    return (
      <FormationWorkspace
        system={system}
        onChange={onChange}
        onSelect={onSelect}
        onOpenEditor={onOpenFormationEditor}
      />
    );
  if (module === "assets")
    return <Assets system={system} onOpenModule={onOpenModule} />;
  if (module === "foundations")
    return (
      <FoundationDirectory
        system={system}
        onChange={onChange}
        onSelect={onSelect}
      />
    );
  if (module === "transitions")
    return (
      <TransitionDirectory
        system={system}
        onChange={onChange}
        onSelect={onSelect}
      />
    );
  if (module === "constraints")
    return (
      <ConstraintDirectory
        system={system}
        onChange={onChange}
        onSelect={onSelect}
      />
    );
  return (
    <AuditDirectory
      system={system}
      onOpenModule={onOpenModule}
      onOpenRelations={onOpenRelations}
      onChange={onChange}
    />
  );
}

function Overview({
  system,
  onOpenModule,
}: {
  system: CultivationSystem;
  onOpenModule: (module: ModuleId, selection?: Selection) => void;
}) {
  const completeness = calculateCultivationCompleteness(system);
  return (
    <>
      <PageHeader
        compact
        eyebrow={`修行体系 / ${system.kind}`}
        title={system.name}
        description={
          system.summary ||
          "把本源投影、理论节点、法门拓扑、境界、资源、能力和阵法组织在同一套可审查模型中。"
        }
      />
      <StatStrip system={system} />
      <div className="ce-completeness-card">
        <div>
          <span>结构完整度</span>
          <strong>{completeness}</strong>
          <small>/ 100</small>
        </div>
        <div className="ce-progress">
          <i style={{ width: `${completeness}%` }} />
        </div>
        <Button variant="ghost" onClick={() => onOpenModule("audit")}>
          {system.audit.filter((item) => !item.resolved).length} 项待处理
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="ce-panel-grid">
        <Section
          title="本源投影"
          eyebrow="01 / 接入方式"
          action={
            <Button
              variant="ghost"
              title="打开本源投影"
              onClick={() => onOpenModule("projection")}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          }
        >
          <div className="ce-origin-card">
            <strong>{system.projection.medium || "尚未定义力量载体"}</strong>
            <p>
              {system.projection.translation ||
                "请描述本体系如何把世界本源翻译为可修行的局部模型。"}
            </p>
            <span>{system.projection.access || "未填写接入方式"}</span>
          </div>
        </Section>
        <Section
          title="理论共有结构"
          eyebrow="02 / 法门共同底座"
          action={
            <Button
              variant="ghost"
              title="打开理论模型"
              onClick={() => onOpenModule("theory")}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          }
        >
          <div className="ce-summary-list">
            <div>
              <span>节点库</span>
              <strong>{system.theoryModel.nodeCatalog.length} 个节点</strong>
            </div>
            <div>
              <span>不变量</span>
              <strong>{system.theoryModel.invariants.length} 条</strong>
            </div>
            <div>
              <span>校验规则</span>
              <strong>{system.theoryModel.validationRules.length} 条</strong>
            </div>
          </div>
        </Section>
        <Section title="成长与资产" eyebrow="03 / 反向索引">
          <div className="ce-asset-grid">
            <button type="button" onClick={() => onOpenModule("progression")}>
              <Route />
              <strong>{system.progressionTracks.length} 条成长轨道</strong>
              <small>境界、指标与突破条件</small>
            </button>
            <button type="button" onClick={() => onOpenModule("methods")}>
              <ScrollText />
              <strong>{system.methods.length} 部修行法门</strong>
              <small>法诀、课程与独立运行拓扑</small>
            </button>
            <button type="button" onClick={() => onOpenModule("abilities")}>
              <Zap />
              <strong>{system.abilities.length} 项能力</strong>
              <small>境界自动获得 / 秘籍修炼获得</small>
            </button>
            <button type="button" onClick={() => onOpenModule("formations")}>
              <Hexagon />
              <strong>{system.formations.length} 套阵法</strong>
              <small>阵眼、节点、边界与部署</small>
            </button>
          </div>
        </Section>
        <Section
          title="体系约束"
          eyebrow="04 / 叙事张力"
          action={
            <Button
              variant="ghost"
              title="打开体系约束"
              onClick={() => onOpenModule("constraints")}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          }
        >
          <div className="ce-warning-list">
            {system.constraints.slice(0, 3).map((item) => (
              <div key={item.id}>
                <ShieldAlert className="h-4 w-4" />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.trigger || "未定义触发条件"}</small>
                </span>
              </div>
            ))}
          </div>
          {system.constraints.length === 0 && (
            <Empty text="尚未定义代价、污染或反噬约束" />
          )}
        </Section>
      </div>
    </>
  );
}

function Projection({
  worldOrigins,
  system,
  onChange,
  onSelect,
}: {
  worldOrigins: readonly WorldOrigin[];
  system: CultivationSystem;
  onChange: (system: CultivationSystem) => void;
  onSelect: (selection: Selection) => void;
}) {
  const projection = system.projection;
  const originNames = new Map(worldOrigins.map((item) => [item.id, item.name]));
  const manifestationNames = new Map(
    worldOrigins.flatMap((origin) =>
      origin.manifestations.map((item) => [item.id, item.name] as const),
    ),
  );
  const displayReferences = (
    ids: readonly string[],
    names: ReadonlyMap<string, string>,
  ) =>
    ids.length > 0
      ? ids.map((id) => names.get(id) ?? "已失效引用").join("、")
      : "未引用";
  const set = (key: keyof typeof projection, value: string) =>
    onChange({ ...system, projection: { ...projection, [key]: value } });
  return (
    <>
      <PageHeader
        eyebrow="体系内部 / 01 本源投影"
        title="体系本源投影"
        description="声明该体系从哪些世界本源和显化节点取得力量，以及如何完成本地化翻译。"
        action={
          <Button
            variant="secondary"
            onClick={() => onSelect({ kind: "projection", id: system.id })}
          >
            <Pencil className="h-3.5 w-3.5" />
            编辑投影合同
          </Button>
        }
      />
      <Section title="接入与翻译" eyebrow="投影合同">
        <div className="ce-form-grid">
          <Field
            label="接入方式"
            value={projection.access}
            onChange={(value) => set("access", value)}
            multiline
          />
          <Field
            label="法则翻译"
            value={projection.translation}
            onChange={(value) => set("translation", value)}
            multiline
          />
          <Field
            label="能量 / 权柄载体"
            value={projection.medium}
            onChange={(value) => set("medium", value)}
          />
          <Field
            label="投影衰减与边界"
            value={projection.attenuation}
            onChange={(value) => set("attenuation", value)}
            multiline
          />
        </div>
      </Section>
      <Section title="引用关系" eyebrow="世界本源对象">
        <div className="ce-reference-grid">
          <div>
            <span>世界本源</span>
            <strong>
              {displayReferences(projection.originIds, originNames)}
            </strong>
          </div>
          <div>
            <span>显化节点</span>
            <strong>
              {displayReferences(
                projection.manifestationIds,
                manifestationNames,
              )}
            </strong>
          </div>
        </div>
      </Section>
    </>
  );
}

function Theory({
  system,
  onChange,
  onSelect,
}: {
  system: CultivationSystem;
  onChange: (system: CultivationSystem) => void;
  onSelect: (selection: Selection) => void;
}) {
  const add = () => {
    const item = createNode();
    onChange({
      ...system,
      theoryModel: {
        ...system.theoryModel,
        nodeCatalog: [...system.theoryModel.nodeCatalog, item],
      },
    });
    onSelect({ kind: "theory-node", id: item.id });
  };
  return (
    <>
      <PageHeader
        eyebrow="体系内部 / 02 理论模型"
        title="体系共有结构"
        description="理论模型定义经脉、丹田、关窍、魔网、符文或神经节点等共同结构；具体运行线路必须由法门单独声明。"
        action={
          <>
            <Button
              variant="secondary"
              onClick={() => onSelect({ kind: "theory", id: system.id })}
            >
              <Pencil className="h-3.5 w-3.5" />
              编辑理论模型
            </Button>
            <Button variant="primary" onClick={add}>
              <Plus className="h-3.5 w-3.5" />
              新增理论节点
            </Button>
          </>
        }
      />
      <Section
        title={system.theoryModel.statement || "未命名理论模型"}
        eyebrow="理论陈述"
      >
        <div className="ce-callout">
          <Atom className="h-4 w-4" />
          <p>{system.theoryModel.summary || "尚未填写理论模型说明。"}</p>
        </div>
      </Section>
      <Section
        title="节点库"
        eyebrow={`${system.theoryModel.nodeCatalog.length} 个共有节点`}
      >
        <div className="ce-table-wrap">
          <table className="ce-table">
            <thead>
              <tr>
                <th>节点</th>
                <th>类别</th>
                <th>作用</th>
                <th>不变量</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {system.theoryModel.nodeCatalog.map((item) => (
                <tr key={item.id}>
                  <td>
                    <button
                      type="button"
                      className="ce-table-link"
                      onClick={() =>
                        onSelect({ kind: "theory-node", id: item.id })
                      }
                    >
                      {item.name}
                    </button>
                    <small>{item.id}</small>
                  </td>
                  <td>{item.kind}</td>
                  <td>{item.role}</td>
                  <td>{item.invariant}</td>
                  <td>
                    <CircleDot className="h-3.5 w-3.5 text-[var(--accent-warm)]" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {system.theoryModel.nodeCatalog.length === 0 && (
          <Empty text="理论节点库为空" />
        )}
      </Section>
      <div className="ce-two-column">
        <Section title="结构不变量" eyebrow="运行边界">
          <ul className="ce-bullet-list">
            {system.theoryModel.invariants.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Section>
        <Section title="审查规则" eyebrow="自动校验">
          <ul className="ce-bullet-list">
            {system.theoryModel.validationRules.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Section>
      </div>
    </>
  );
}

function Progression({
  system,
  onChange,
  onSelect,
}: {
  system: CultivationSystem;
  onChange: (system: CultivationSystem) => void;
  onSelect: (selection: Selection) => void;
}) {
  const [trackId, setTrackId] = useState(system.progressionTracks[0]?.id ?? "");
  const [levelInsertAnchor, setLevelInsertAnchor] = useState("end");
  const [interactionTargetTrackId, setInteractionTargetTrackId] = useState("");
  const firstTrackId = system.progressionTracks[0]?.id ?? "";
  const trackExists = system.progressionTracks.some(
    (item) => item.id === trackId,
  );
  const resolvedTrackId = trackExists ? trackId : firstTrackId;
  const track =
    system.progressionTracks.find((item) => item.id === resolvedTrackId) ??
    system.progressionTracks[0];
  const addTrack = () => {
    const item = createTrack();
    onChange({
      ...system,
      progressionTracks: [...system.progressionTracks, item],
    });
    setTrackId(item.id);
    onSelect({ kind: "track", id: item.id });
  };
  if (!track)
    return (
      <>
        <PageHeader
          eyebrow="体系内部 / 03 成长轨道"
          title="境界层级与数值模型"
          description="一套体系可以有多条成长轨道；每个境界定义突破与退化规则，境界内可继续划分前期、中期、后期等阶段。"
          action={
            <Button variant="primary" onClick={addTrack}>
              <Plus className="h-3.5 w-3.5" />
              新增轨道
            </Button>
          }
        />
        <Empty text="尚未建立成长轨道" />
      </>
    );
  const levelInsertOptions =
    track.levels.length === 0
      ? [{ value: "end", label: "创建第一个境界" }]
      : [
          { value: "end", label: "插入到末尾" },
          { value: "start", label: "插入到最前" },
          ...track.levels.slice(0, -1).map((level) => ({
            value: `after:${level.id}`,
            label: `在「${level.name}」之后`,
          })),
        ];
  const resolvedLevelInsertAnchor = levelInsertOptions.some(
    (option) => option.value === levelInsertAnchor,
  )
    ? levelInsertAnchor
    : "end";
  const addLevel = () => {
    const insertionIndex =
      resolvedLevelInsertAnchor === "start"
        ? 0
        : resolvedLevelInsertAnchor.startsWith("after:")
          ? Math.max(
              0,
              track.levels.findIndex(
                (level) =>
                  level.id === resolvedLevelInsertAnchor.slice("after:".length),
              ) + 1,
            )
          : track.levels.length;
    const item = createLevel(insertionIndex);
    const levels = [...track.levels];
    levels.splice(insertionIndex, 0, item);
    onChange({
      ...system,
      progressionTracks: updateById(
        system.progressionTracks,
        track.id,
        (current) => ({
          ...current,
          levels: levels.map((level, order) => ({ ...level, order })),
        }),
      ),
    });
    setLevelInsertAnchor("end");
    onSelect({
      kind: "level",
      id: item.id,
      parentId: track.id,
      parentKind: "track",
    });
  };
  const addSubStage = (level: CultivationLevel) => {
    const item = createLevelSubStage(level.subStages.length);
    onChange({
      ...system,
      progressionTracks: updateById(
        system.progressionTracks,
        track.id,
        (current) => ({
          ...current,
          levels: updateById(current.levels, level.id, (currentLevel) => ({
            ...currentLevel,
            subStages: [...currentLevel.subStages, item],
          })),
        }),
      ),
    });
    onSelect({
      kind: "level-stage",
      id: item.id,
      parentId: level.id,
      parentKind: "level",
      grandParentId: track.id,
    });
  };
  const addMetric = () => {
    const item = {
      id: newEcologyId("metric"),
      name: "新指标",
      summary: "",
      unit: "",
      model: "number" as const,
      direction: "higher-better" as const,
      baseline: "",
    };
    onChange({
      ...system,
      progressionTracks: updateById(
        system.progressionTracks,
        track.id,
        (current) => ({ ...current, metrics: [...current.metrics, item] }),
      ),
    });
    onSelect({
      kind: "metric",
      id: item.id,
      parentId: track.id,
      parentKind: "track",
    });
  };
  const addInteraction = () => {
    if (system.progressionTracks.length < 2) return;
    const targetTrack =
      system.progressionTracks.find(
        (candidate) =>
          candidate.id === interactionTargetTrackId &&
          candidate.id !== track.id,
      ) ??
      system.progressionTracks.find((candidate) => candidate.id !== track.id);
    if (!targetTrack) return;
    const item = createTrackInteraction(track.id, targetTrack.id);
    onChange({
      ...system,
      trackInteractions: [...(system.trackInteractions ?? []), item],
    });
    onSelect({ kind: "track-interaction", id: item.id });
  };
  const addTransition = () => {
    const item = createTransition();
    onChange({
      ...system,
      progressionTracks: updateById(
        system.progressionTracks,
        track.id,
        (current) => ({
          ...current,
          transitions: [...current.transitions, item],
        }),
      ),
    });
    onSelect({
      kind: "transition",
      id: item.id,
      parentId: track.id,
      parentKind: "track",
    });
  };
  return (
    <>
      <PageHeader
        eyebrow="体系内部 / 03 成长轨道"
        title="境界层级与数值模型"
        description="一套体系可以有多条成长轨道；每个境界定义突破与退化规则，境界内可继续划分前期、中期、后期等阶段。"
        action={
          <>
            <Button variant="secondary" onClick={addTrack}>
              <Plus className="h-3.5 w-3.5" />
              新增轨道
            </Button>
            <div className="ce-level-create-control">
              <CustomSelect
                value={resolvedLevelInsertAnchor}
                options={levelInsertOptions}
                onChange={setLevelInsertAnchor}
                ariaLabel="新境界插入位置"
                className="ce-inline-select"
                size="toolbar"
              />
              <Button variant="primary" onClick={addLevel}>
                <Plus className="h-3.5 w-3.5" />
                插入境界
              </Button>
            </div>
          </>
        }
      />
      <div className="ce-tabs">
        {system.progressionTracks.map((item) => (
          <button
            type="button"
            key={item.id}
            className={item.id === track.id ? "is-active" : ""}
            onClick={() => {
              setTrackId(item.id);
              onSelect({ kind: "track", id: item.id });
            }}
          >
            {item.name}
            <small>{item.levels.length} 个境界</small>
          </button>
        ))}
      </div>
      <Section
        title={track.name}
        eyebrow={`${track.mode} · ${track.structure}`}
      >
        <div className="ce-level-rail">
          {track.levels.map((item, index) => (
            <article key={item.id} className="ce-level-card">
              <button
                type="button"
                className="ce-level-card-main"
                onClick={() =>
                  onSelect({
                    kind: "level",
                    id: item.id,
                    parentId: track.id,
                    parentKind: "track",
                  })
                }
              >
                <span className="ce-level-card-head">
                  <span>境界 {String(index + 1).padStart(2, "0")}</span>
                  {index < track.levels.length - 1 && (
                    <ChevronRight className="ce-level-arrow" />
                  )}
                </span>
                <strong>{item.name}</strong>
                <small>
                  {item.quality || "质量未定义"} · {item.subStages.length}{" "}
                  个阶段
                </small>
              </button>
              <div className="ce-level-stage-panel">
                <div className="ce-level-stage-heading">
                  <span>境内阶段</span>
                  <button
                    type="button"
                    title={`为${item.name}新增阶段`}
                    aria-label={`为${item.name}新增阶段`}
                    onClick={() => addSubStage(item)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="ce-level-stage-list">
                  {[...item.subStages]
                    .sort((left, right) => left.order - right.order)
                    .map((stage) => (
                      <button
                        type="button"
                        key={stage.id}
                        title={`编辑${item.name} · ${stage.name}`}
                        onClick={() =>
                          onSelect({
                            kind: "level-stage",
                            id: stage.id,
                            parentId: item.id,
                            parentKind: "level",
                            grandParentId: track.id,
                          })
                        }
                      >
                        {stage.name}
                      </button>
                    ))}
                </div>
                {item.subStages.length === 0 && (
                  <span className="ce-level-stage-empty">尚未划分阶段</span>
                )}
              </div>
            </article>
          ))}
        </div>
        {track.levels.length === 0 && <Empty text="当前轨道尚未建立境界" />}
      </Section>
      <Section
        title="指标定义"
        eyebrow={`${track.metrics.length} 个自定义指标`}
        action={
          <Button variant="secondary" onClick={addMetric}>
            <Plus className="h-3.5 w-3.5" />
            新增指标
          </Button>
        }
      >
        <div className="ce-metric-grid">
          {track.metrics.map((metric) => (
            <button
              type="button"
              key={metric.id}
              onClick={() =>
                onSelect({
                  kind: "metric",
                  id: metric.id,
                  parentId: track.id,
                  parentKind: "track",
                })
              }
            >
              <span>{metric.name}</span>
              <strong>{metric.baseline || "未设置"}</strong>
              <small>
                {metric.unit} · {metric.model}
              </small>
            </button>
          ))}
        </div>
      </Section>
      <Section
        title="突破关系"
        eyebrow={`${track.transitions.length} 条转换`}
        action={
          <Button variant="secondary" onClick={addTransition}>
            <Plus className="h-3.5 w-3.5" />
            新增转换
          </Button>
        }
      >
        <div className="ce-transition-list">
          {track.transitions.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() =>
                onSelect({
                  kind: "transition",
                  id: item.id,
                  parentId: track.id,
                  parentKind: "track",
                })
              }
            >
              <GitBranch className="h-4 w-4" />
              <span>
                <strong>{item.name}</strong>
                <small>{item.successResult || "未定义成功结果"}</small>
              </span>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
        {track.transitions.length === 0 && (
          <Empty text="当前轨道尚未定义转换" />
        )}
      </Section>
      <Section
        title="多轨道交叉规则"
        eyebrow={`${system.trackInteractions?.length ?? 0} 条同步 / 协同 / 竞争规则`}
        action={
          <div className="ce-interaction-create-control">
            <CustomSelect
              value={
                system.progressionTracks.some(
                  (candidate) =>
                    candidate.id === interactionTargetTrackId &&
                    candidate.id !== track.id,
                )
                  ? interactionTargetTrackId
                  : (system.progressionTracks.find(
                      (candidate) => candidate.id !== track.id,
                    )?.id ?? "")
              }
              options={system.progressionTracks
                .filter((candidate) => candidate.id !== track.id)
                .map((candidate) => ({
                  value: candidate.id,
                  label: `目标：${candidate.name}`,
                }))}
              onChange={setInteractionTargetTrackId}
              ariaLabel="轨道交叉规则目标轨道"
              placeholder="选择目标轨道"
              disabled={system.progressionTracks.length < 2}
              className="ce-inline-select"
              size="toolbar"
            />
            <Button
              variant="secondary"
              onClick={addInteraction}
              disabled={system.progressionTracks.length < 2}
              title={
                system.progressionTracks.length < 2
                  ? "至少需要两条成长轨道"
                  : "新增轨道交叉规则"
              }
            >
              <Plus className="h-3.5 w-3.5" />
              新增规则
            </Button>
          </div>
        }
      >
        <div className="ce-transition-list">
          {(system.trackInteractions ?? []).map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() =>
                onSelect({ kind: "track-interaction", id: item.id })
              }
            >
              <GitBranch className="h-4 w-4" />
              <span>
                <strong>{item.name}</strong>
                <small>
                  {item.kind} · {item.rule || "尚未定义规则"}
                </small>
              </span>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
        {(system.trackInteractions?.length ?? 0) === 0 && (
          <Empty
            text={
              system.progressionTracks.length < 2
                ? "建立第二条轨道后才能配置交叉规则"
                : "尚未定义轨道交叉规则"
            }
          />
        )}
      </Section>
    </>
  );
}

function ResourceDirectory({
  system,
  onChange,
  onSelect,
}: {
  system: CultivationSystem;
  onChange: (system: CultivationSystem) => void;
  onSelect: (selection: Selection) => void;
}) {
  const levelNames = new Map(
    system.progressionTracks.flatMap((track) =>
      track.levels.map(
        (level) => [level.id, `${track.name} / ${level.name}`] as const,
      ),
    ),
  );
  const assetReferences = useMemo(() => {
    const references = new Map<string, string[]>();
    const addReference = (resourceId: string, reference: string) => {
      references.set(resourceId, [
        ...(references.get(resourceId) ?? []),
        reference,
      ]);
    };
    system.progressionTracks.forEach((track) => {
      track.levels.forEach((level) => {
        level.resourceRequirements.forEach((requirement) => {
          addReference(requirement.resourceId, `境界 · ${level.name}`);
          requirement.substituteResourceIds.forEach((id) =>
            addReference(id, `境界替代 · ${level.name}`),
          );
        });
        level.subStages.forEach((stage) =>
          stage.resourceRequirements.forEach((requirement) => {
            const label = `${level.name} · ${stage.name}`;
            addReference(requirement.resourceId, `境内阶段 · ${label}`);
            requirement.substituteResourceIds.forEach((id) =>
              addReference(id, `境内阶段替代 · ${label}`),
            );
          }),
        );
      });
      track.transitions.forEach((transition) =>
        transition.resourceRequirements.forEach((requirement) => {
          addReference(requirement.resourceId, `轨道转换 · ${transition.name}`);
          requirement.substituteResourceIds.forEach((id) =>
            addReference(id, `轨道转换替代 · ${transition.name}`),
          );
        }),
      );
    });
    system.methods.forEach((method) =>
      method.courses.forEach((course) =>
        course.resourceRequirements.forEach((requirement) => {
          addReference(requirement.resourceId, `课程 · ${course.title}`);
          requirement.substituteResourceIds.forEach((id) =>
            addReference(id, `课程替代 · ${course.title}`),
          );
        }),
      ),
    );
    system.abilities.forEach((ability) =>
      ability.trainingRequirements.resourceRequirements.forEach(
        (requirement) => {
          addReference(requirement.resourceId, `能力 · ${ability.name}`);
          requirement.substituteResourceIds.forEach((id) =>
            addReference(id, `能力替代 · ${ability.name}`),
          );
        },
      ),
    );
    system.formations.forEach((formation) =>
      formation.resourceRequirements.forEach((requirement) => {
        addReference(requirement.resourceId, `阵法 · ${formation.name}`);
        requirement.substituteResourceIds.forEach((id) =>
          addReference(id, `阵法替代 · ${formation.name}`),
        );
      }),
    );
    system.transitions.forEach((transition) =>
      transition.resourceRequirements.forEach((requirement) => {
        addReference(requirement.resourceId, `转换 · ${transition.name}`);
        requirement.substituteResourceIds.forEach((id) =>
          addReference(id, `转换替代 · ${transition.name}`),
        );
      }),
    );
    return references;
  }, [system]);
  const add = () => {
    const item = createResource();
    onChange({ ...system, resources: [...system.resources, item] });
    onSelect({ kind: "resource", id: item.id });
  };
  return (
    <>
      <PageHeader
        eyebrow="体系内部 / 04 资源库"
        title="修炼资源"
        description="定义能量、材料、环境、知识、权限和替代关系；消耗应由境界、境内阶段、法门、技能或阵法明确引用。"
        action={
          <Button variant="primary" onClick={add}>
            <Plus className="h-3.5 w-3.5" />
            新增资源
          </Button>
        }
      />
      <div className="ce-directory">
        {system.resources.map((item) => (
          <button
            type="button"
            key={item.id}
            onClick={() => onSelect({ kind: "resource", id: item.id })}
          >
            <span className="ce-directory-icon">
              <FlaskConical className="h-4 w-4" />
            </span>
            <span>
              <strong>{item.name}</strong>
              <small>
                {item.category} · 最佳境界{" "}
                {item.bestLevelId
                  ? (levelNames.get(item.bestLevelId) ?? "已失效引用")
                  : "未指定"}
              </small>
              <em>{item.summary || "暂无说明"}</em>
              <small className="ce-directory-references">
                被引用 {assetReferences.get(item.id)?.length ?? 0} 处
              </small>
            </span>
            <ChevronRight className="h-4 w-4" />
          </button>
        ))}
      </div>
      {system.resources.length === 0 && <Empty text="资源库为空" />}
    </>
  );
}

function MethodWorkspace({
  system,
  onChange,
  onSelect,
  selection,
}: {
  system: CultivationSystem;
  onChange: (system: CultivationSystem) => void;
  onSelect: (selection: Selection) => void;
  selection: Selection;
}) {
  const requestedTopologyId =
    selection?.kind === "topology"
      ? selection.id
      : selection?.parentKind === "topology"
        ? (selection.parentId ?? "")
        : "";
  const requestedMethodId =
    selection?.kind === "method"
      ? selection.id
      : (system.methods.find((item) =>
          item.operationTopologies.some(
            (topology) => topology.id === requestedTopologyId,
          ),
        )?.id ?? "");
  const initialMethod =
    system.methods.find((item) => item.id === requestedMethodId) ??
    system.methods[0];
  const [methodId, setMethodId] = useState(initialMethod?.id ?? "");
  const [topologyId, setTopologyId] = useState(
    initialMethod?.operationTopologies.some(
      (item) => item.id === requestedTopologyId,
    )
      ? requestedTopologyId
      : (initialMethod?.operationTopologies[0]?.id ?? ""),
  );
  const method =
    system.methods.find((item) => item.id === methodId) ?? system.methods[0];
  const add = () => {
    const item = createMethod();
    onChange({ ...system, methods: [...system.methods, item] });
    setMethodId(item.id);
    onSelect({ kind: "method", id: item.id });
  };
  if (!method)
    return (
      <>
        <PageHeader
          eyebrow="体系内部 / 05 修行法门"
          title="修行法门"
          description="每一部法门都包含修炼法诀、课程、适用区间和独立的运行拓扑。"
          action={
            <Button variant="primary" onClick={add}>
              <Plus className="h-3.5 w-3.5" />
              新增法门
            </Button>
          }
        />
        <Empty text="尚未建立法门" />
      </>
    );
  const topology =
    method.operationTopologies.find((item) => item.id === topologyId) ??
    method.operationTopologies[0];
  const addTopology = () => {
    const item: OperationTopology = {
      id: newEcologyId("topology"),
      name: "新运行拓扑",
      summary: "",
      nodes: [],
      edges: [],
      cycleRule: "",
      closureRule: "",
      costModel: "",
    };
    onChange({
      ...system,
      methods: updateById(system.methods, method.id, (current) => ({
        ...current,
        operationTopologies: [...current.operationTopologies, item],
      })),
    });
    setTopologyId(item.id);
    onSelect({
      kind: "topology",
      id: item.id,
      parentId: method.id,
      parentKind: "method",
    });
  };
  return (
    <>
      <PageHeader
        eyebrow="体系内部 / 05 修行法门"
        title="修行法门与运行拓扑"
        description="理论模型只提供共有节点；切换法门会切换其独立的经络、符文或意识运行线路。"
        action={
          <Button variant="primary" onClick={add}>
            <Plus className="h-3.5 w-3.5" />
            新增法门
          </Button>
        }
      />
      <div className="ce-method-workspace">
        <div className="ce-method-list">
          <div className="ce-list-title">法门目录</div>
          {system.methods.map((item) => (
            <div
              key={item.id}
              className={`ce-method-list-item ${item.id === method.id ? "is-active" : ""}`}
            >
              <button
                type="button"
                className="ce-method-list-item-trigger"
                aria-pressed={item.id === method.id}
                onClick={() => {
                  setMethodId(item.id);
                  setTopologyId(item.operationTopologies[0]?.id ?? "");
                }}
              >
                <BookOpen className="h-4 w-4" />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.kind}</small>
                </span>
                <em>{item.operationTopologies.length}</em>
              </button>
              <button
                type="button"
                className="ce-method-list-item-edit"
                title={`编辑法门：${item.name}`}
                aria-label={`编辑法门：${item.name}`}
                onClick={() => onSelect({ kind: "method", id: item.id })}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="ce-method-detail">
          <Section title={method.name} eyebrow={method.kind}>
            <div className="ce-callout ce-callout-warm">
              <ScrollText className="h-4 w-4" />
              <p>{method.script.join(" ") || "法诀尚未填写。"}</p>
            </div>
            <div className="ce-method-meta">
              <div>
                <span>理论引用</span>
                <strong>{method.theoryReference || "未关联"}</strong>
              </div>
              <div>
                <span>覆盖区间</span>
                <strong>
                  {method.coverage.startLevelId || "起始"} →{" "}
                  {method.coverage.absoluteLimitId || "未设上限"}
                </strong>
              </div>
              <div>
                <span>成长公式</span>
                <strong>{method.formula || "未填写"}</strong>
              </div>
            </div>
          </Section>
          <Section
            title="法门运行拓扑"
            eyebrow={`${method.operationTopologies.length} 条线路`}
            action={
              <Button variant="secondary" onClick={addTopology}>
                <Plus className="h-3.5 w-3.5" />
                新增拓扑
              </Button>
            }
          >
            <div className="ce-topology-tabs">
              {method.operationTopologies.map((item) => (
                <div
                  key={item.id}
                  className={`ce-topology-tab ${topology?.id === item.id ? "is-active" : ""}`}
                >
                  <button
                    type="button"
                    className="ce-topology-tab-trigger"
                    aria-pressed={topology?.id === item.id}
                    onClick={() => setTopologyId(item.id)}
                  >
                    {item.name}
                    <small>{item.nodes.length} 节点</small>
                  </button>
                  <button
                    type="button"
                    className="ce-topology-tab-edit"
                    title={`编辑拓扑：${item.name}`}
                    aria-label={`编辑拓扑：${item.name}`}
                    onClick={() =>
                      onSelect({
                        kind: "topology",
                        id: item.id,
                        parentId: method.id,
                        parentKind: "method",
                      })
                    }
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            {topology ? (
              <TopologyCard
                system={system}
                method={method}
                topology={topology}
                onChange={onChange}
                onSelect={onSelect}
              />
            ) : (
              <Empty text="此法门尚未定义运行拓扑" />
            )}
          </Section>
        </div>
      </div>
    </>
  );
}

type TopologyCanvasMode = "immersive" | "detail";
type TopologyCanvasNodeData = {
  title: string;
  role: string;
  operation: string;
  order: number;
  color: string;
  orbStyle: CultivationOrbStyle;
  mode: TopologyCanvasMode;
};
type TopologyCanvasNode = Node<TopologyCanvasNodeData, "topologyCanvas">;
type TopologyCanvasEdgeData = {
  edgeId: string;
  name: string;
  routeRule: string;
  loss: string;
};
type TopologyCanvasEdge = Edge<TopologyCanvasEdgeData>;

function topologyNodePosition(index: number, count: number) {
  if (count <= 1) return { x: 360, y: 220 };
  const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
  const radiusX = Math.min(430, Math.max(250, count * 62));
  const radiusY = Math.min(300, Math.max(170, count * 42));
  return {
    x: 460 + Math.cos(angle) * radiusX,
    y: 300 + Math.sin(angle) * radiusY,
  };
}

function topologyHandleToward(
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx >= 0) return dy >= 0 ? "east-south" : "east-north";
    return dy >= 0 ? "west-south" : "west-north";
  }
  if (dy >= 0) return dx >= 0 ? "south-east" : "south-west";
  return dx >= 0 ? "north-east" : "north-west";
}

const TOPOLOGY_HANDLE_POINTS: Array<{
  id: string;
  position: Position;
  style: CSSProperties;
}> = [
  { id: "north-west", position: Position.Top, style: { left: "28%" } },
  { id: "north-east", position: Position.Top, style: { left: "72%" } },
  { id: "east-north", position: Position.Right, style: { top: "28%" } },
  { id: "east-south", position: Position.Right, style: { top: "72%" } },
  { id: "south-east", position: Position.Bottom, style: { left: "72%" } },
  { id: "south-west", position: Position.Bottom, style: { left: "28%" } },
  { id: "west-south", position: Position.Left, style: { top: "72%" } },
  { id: "west-north", position: Position.Left, style: { top: "28%" } },
];

function TopologyCanvasNodeView({
  data,
  selected,
}: NodeProps<TopologyCanvasNode>) {
  const style = { "--topology-node-color": data.color } as CSSProperties;
  return (
    <div
      className={`ce-topology-flow-node is-${data.mode} ${selected ? "is-selected" : ""}`}
      style={style}
      title={`${data.title} · ${data.role}`}
    >
      {data.mode === "immersive" ? (
        <div className="ce-topology-orb-node">
          <OrbVisual orbStyle={data.orbStyle} />
          <strong>{data.title}</strong>
          <small>
            {String(data.order + 1).padStart(2, "0")} ·{" "}
            {data.role || "运行节点"}
          </small>
        </div>
      ) : (
        <div className="ce-topology-detail-node">
          <div className="ce-topology-detail-node-head">
            <span>{String(data.order + 1).padStart(2, "0")}</span>
            <em>{data.role || "运行节点"}</em>
          </div>
          <strong>{data.title}</strong>
          <p>{data.operation || "尚未填写运行操作"}</p>
        </div>
      )}
      {TOPOLOGY_HANDLE_POINTS.map((handle) => (
        <Handle
          key={handle.id}
          id={handle.id}
          type="source"
          position={handle.position}
          style={handle.style}
          isConnectable
          className="ce-topology-flow-handle"
        />
      ))}
    </div>
  );
}

const topologyCanvasNodeTypes = { topologyCanvas: TopologyCanvasNodeView };

function buildTopologyCanvasNodes(
  topology: OperationTopology,
  theoryNames: ReadonlyMap<string, string>,
  mode: TopologyCanvasMode,
): TopologyCanvasNode[] {
  return topology.nodes.map((node, index) => ({
    id: node.id,
    type: "topologyCanvas",
    position:
      node.position ?? topologyNodePosition(index, topology.nodes.length),
    data: {
      title: theoryNames.get(node.theoryNodeId) || node.theoryNodeId,
      role: node.role,
      operation: node.operation,
      order: node.order,
      color: topologyNodeColor(node, index),
      orbStyle: topologyNodeOrbStyle(node, index),
      mode,
    },
    ariaLabel: `拓扑节点：${theoryNames.get(node.theoryNodeId) || node.theoryNodeId}`,
  }));
}

function buildTopologyCanvasEdges(
  topology: OperationTopology,
  theoryNames: ReadonlyMap<string, string>,
  mode: TopologyCanvasMode,
): TopologyCanvasEdge[] {
  const nodeIndex = new Map(
    topology.nodes.map((node, index) => [node.id, index] as const),
  );
  const nodePositions = new Map(
    topology.nodes.map((node, index) => [
      node.id,
      node.position ?? topologyNodePosition(index, topology.nodes.length),
    ]),
  );
  return topology.edges
    .filter(
      (edge) => nodeIndex.has(edge.fromNodeId) && nodeIndex.has(edge.toNodeId),
    )
    .map((edge) => {
      const sourceIndex = nodeIndex.get(edge.fromNodeId) ?? 0;
      const sourceNode = topology.nodes[sourceIndex];
      const color = sourceNode
        ? topologyNodeColor(sourceNode, sourceIndex)
        : TOPOLOGY_NODE_PALETTE[0];
      const sourcePosition = nodePositions.get(edge.fromNodeId) ?? {
        x: 0,
        y: 0,
      };
      const targetPosition = nodePositions.get(edge.toNodeId) ?? {
        x: 1,
        y: 0,
      };
      const targetNode = topology.nodes[nodeIndex.get(edge.toNodeId) ?? -1];
      const edgeName =
        edge.name?.trim() ||
        `${theoryNames.get(sourceNode?.theoryNodeId ?? "") || edge.fromNodeId} → ${theoryNames.get(targetNode?.theoryNodeId ?? "") || edge.toNodeId}`;
      return {
        id: edge.id,
        source: edge.fromNodeId,
        target: edge.toNodeId,
        sourceHandle:
          edge.fromHandleId ??
          topologyHandleToward(sourcePosition, targetPosition),
        targetHandle:
          edge.toHandleId ??
          topologyHandleToward(targetPosition, sourcePosition),
        type: "default",
        animated: mode === "immersive",
        className: `ce-topology-flow-edge is-${mode}`,
        label: edgeName,
        labelStyle: {
          fill:
            mode === "immersive"
              ? "var(--button-primary-text)"
              : "var(--ink-muted)",
          fontSize: "var(--text-xs)",
          fontWeight: 650,
        },
        labelBgStyle: {
          fill: mode === "immersive" ? "#16091a" : "var(--paper-elevated)",
          fillOpacity: 0.94,
          stroke: mode === "immersive" ? color : "var(--line-strong)",
          strokeWidth: 0.6,
        },
        labelBgPadding: [6, 4],
        labelBgBorderRadius: 2,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 16,
          height: 16,
        },
        style: {
          stroke: color,
          strokeWidth: mode === "immersive" ? 2.25 : 1.5,
        },
        data: {
          edgeId: edge.id,
          name: edgeName,
          routeRule: edge.routeRule,
          loss: edge.loss,
        },
      };
    });
}

function TopologyCard({
  system,
  method,
  topology,
  onChange,
  onSelect,
}: {
  system: CultivationSystem;
  method: CultivationMethod;
  topology: OperationTopology;
  onChange: (system: CultivationSystem) => void;
  onSelect: (selection: Selection) => void;
}) {
  const [mode, setMode] = useState<TopologyCanvasMode>("immersive");
  const [connecting, setConnecting] = useState(false);
  const reconnectingEdgeIdRef = useRef<string | null>(null);
  const theoryNames = useMemo(
    () =>
      new Map(
        system.theoryModel.nodeCatalog.map((item) => [item.id, item.name]),
      ),
    [system.theoryModel.nodeCatalog],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<TopologyCanvasNode>(
    buildTopologyCanvasNodes(topology, theoryNames, mode),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<TopologyCanvasEdge>(
    buildTopologyCanvasEdges(topology, theoryNames, mode),
  );
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<
    TopologyCanvasNode,
    TopologyCanvasEdge
  > | null>(null);

  // 画布只随 nodes/edges/theoryNames 内容变化而重建，避免编辑无关字段触发全量重绘。
  const topologyCanvasSignature = JSON.stringify([
    topology.nodes,
    topology.edges,
    theoryNames,
  ]);

  useEffect(() => {
    setNodes(buildTopologyCanvasNodes(topology, theoryNames, mode));
    setEdges(buildTopologyCanvasEdges(topology, theoryNames, mode));
    // 依赖使用内容签名而非对象引用，见 topologyCanvasSignature。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, setEdges, setNodes, topologyCanvasSignature]);

  const updateTopology = (
    update: (current: OperationTopology) => OperationTopology,
  ) => {
    onChange({
      ...system,
      methods: updateById(system.methods, method.id, (item) => ({
        ...item,
        operationTopologies: updateById(
          item.operationTopologies,
          topology.id,
          update,
        ),
      })),
    });
  };

  const topologyNodeName = (nodeId: string) => {
    const node = topology.nodes.find((candidate) => candidate.id === nodeId);
    return node
      ? theoryNames.get(node.theoryNodeId) || node.theoryNodeId
      : nodeId;
  };

  const addNode = () => {
    const theoryNode = system.theoryModel.nodeCatalog[0];
    if (!theoryNode) return;
    const next: OperationTopology["nodes"][number] = {
      id: newEcologyId("topology-node"),
      theoryNodeId: theoryNode.id,
      order: topology.nodes.length,
      role: "运行",
      operation: "",
      color:
        TOPOLOGY_NODE_PALETTE[
          topology.nodes.length % TOPOLOGY_NODE_PALETTE.length
        ],
      orbStyle:
        CULTIVATION_ORB_STYLES[
          topology.nodes.length % CULTIVATION_ORB_STYLES.length
        ],
      position: topologyNodePosition(
        topology.nodes.length,
        topology.nodes.length + 1,
      ),
    };
    updateTopology((current) => ({
      ...current,
      nodes: [...current.nodes, next],
    }));
    onSelect({
      kind: "topology-node",
      id: next.id,
      parentId: topology.id,
      parentKind: "topology",
    });
  };

  const addEdge = () => {
    if (topology.nodes.length < 2) return;
    const next: OperationTopology["edges"][number] = {
      id: newEcologyId("topology-edge"),
      name: `${topologyNodeName(topology.nodes[0].id)} → ${topologyNodeName(topology.nodes[1].id)}`,
      fromNodeId: topology.nodes[0].id,
      toNodeId: topology.nodes[1].id,
      fromHandleId: "east-north",
      toHandleId: "west-north",
      order: topology.edges.length,
      routeRule: "",
      loss: "",
    };
    updateTopology((current) => ({
      ...current,
      edges: [...current.edges, next],
    }));
    onSelect({
      kind: "topology-edge",
      id: next.id,
      parentId: topology.id,
      parentKind: "topology",
    });
  };

  const isValidConnection = (connection: Connection | TopologyCanvasEdge) => {
    if (!connection.source || !connection.target) return false;
    if (connection.source === connection.target) return false;
    return !topology.edges.some(
      (edge) =>
        edge.id !== reconnectingEdgeIdRef.current &&
        edge.fromNodeId === connection.source &&
        edge.toNodeId === connection.target,
    );
  };

  const handleConnect = (connection: Connection) => {
    if (
      !isValidConnection(connection) ||
      !connection.source ||
      !connection.target
    )
      return;
    const next: OperationTopology["edges"][number] = {
      id: newEcologyId("topology-edge"),
      name: `${topologyNodeName(connection.source)} → ${topologyNodeName(connection.target)}`,
      fromNodeId: connection.source,
      toNodeId: connection.target,
      fromHandleId: connection.sourceHandle ?? undefined,
      toHandleId: connection.targetHandle ?? undefined,
      order: topology.edges.length,
      routeRule: "",
      loss: "",
    };
    updateTopology((current) => ({
      ...current,
      edges: [...current.edges, next],
    }));
    onSelect({
      kind: "topology-edge",
      id: next.id,
      parentId: topology.id,
      parentKind: "topology",
    });
  };

  const handleReconnect = (
    oldEdge: TopologyCanvasEdge,
    connection: Connection,
  ) => {
    if (
      !isValidConnection(connection) ||
      !connection.source ||
      !connection.target
    )
      return;
    const edgeId = oldEdge.data?.edgeId ?? oldEdge.id;
    setEdges((current) => reconnectEdge(oldEdge, connection, current));
    updateTopology((current) => ({
      ...current,
      edges: updateById(current.edges, edgeId, (edge) => ({
        ...edge,
        fromNodeId: connection.source as string,
        toNodeId: connection.target as string,
        fromHandleId: connection.sourceHandle ?? undefined,
        toHandleId: connection.targetHandle ?? undefined,
      })),
    }));
  };

  const handleNodeDragStop = (_event: unknown, node: TopologyCanvasNode) => {
    updateTopology((current) => ({
      ...current,
      nodes: updateById(current.nodes, node.id, (currentNode) => ({
        ...currentNode,
        position: node.position,
      })),
    }));
  };

  const handleNodesDelete = (deletedNodes: TopologyCanvasNode[]) => {
    const deletedIds = new Set(deletedNodes.map((node) => node.id));
    updateTopology((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => !deletedIds.has(node.id)),
      edges: current.edges.filter(
        (edge) =>
          !deletedIds.has(edge.fromNodeId) && !deletedIds.has(edge.toNodeId),
      ),
    }));
    onSelect(null);
  };

  const handleEdgesDelete = (deletedEdges: TopologyCanvasEdge[]) => {
    const deletedIds = new Set(deletedEdges.map((edge) => edge.id));
    updateTopology((current) => ({
      ...current,
      edges: current.edges.filter((edge) => !deletedIds.has(edge.id)),
    }));
    onSelect(null);
  };

  const handleLayout = () => {
    const layoutedNodes = nodes.map((node, index) => ({
      ...node,
      position: topologyNodePosition(index, nodes.length),
    }));
    setNodes(layoutedNodes);
    const positions = new Map(
      layoutedNodes.map((node) => [node.id, node.position] as const),
    );
    updateTopology((current) => ({
      ...current,
      nodes: current.nodes.map((node) => ({
        ...node,
        position: positions.get(node.id) ?? node.position,
      })),
    }));
    window.setTimeout(() => flowInstance?.fitView({ padding: 0.18 }), 0);
  };

  return (
    <div className="ce-topology-card">
      <div className="ce-topology-canvas-toolbar">
        <div
          className="ce-topology-view-switch"
          role="group"
          aria-label="运行拓扑视图风格"
        >
          <button
            type="button"
            className={mode === "immersive" ? "is-active" : ""}
            aria-pressed={mode === "immersive"}
            onClick={() => setMode("immersive")}
          >
            <CircleDot className="h-3.5 w-3.5" />
            拟真
          </button>
          <button
            type="button"
            className={mode === "detail" ? "is-active" : ""}
            aria-pressed={mode === "detail"}
            onClick={() => setMode("detail")}
          >
            <FileText className="h-3.5 w-3.5" />
            详细
          </button>
        </div>
        <div className="ce-topology-canvas-stats">
          <span>{topology.nodes.length} 个节点</span>
          <span>{topology.edges.length} 条有向边</span>
        </div>
        <Button variant="ghost" onClick={handleLayout} title="重新排列节点">
          <Route className="h-3.5 w-3.5" />
          环形布局
        </Button>
      </div>
      <div
        className={`ce-topology-flow-surface is-${mode} ${connecting ? "is-connecting" : ""}`}
      >
        <ReactFlow<TopologyCanvasNode, TopologyCanvasEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={topologyCanvasNodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_event, node) =>
            onSelect({
              kind: "topology-node",
              id: node.id,
              parentId: topology.id,
              parentKind: "topology",
            })
          }
          onEdgeClick={(_event, edge) =>
            onSelect({
              kind: "topology-edge",
              id: edge.id,
              parentId: topology.id,
              parentKind: "topology",
            })
          }
          onPaneClick={() =>
            onSelect({
              kind: "topology",
              id: topology.id,
              parentId: method.id,
              parentKind: "method",
            })
          }
          onNodeDragStop={handleNodeDragStop}
          onNodesDelete={handleNodesDelete}
          onEdgesDelete={handleEdgesDelete}
          onConnect={handleConnect}
          onConnectStart={() => setConnecting(true)}
          onConnectEnd={() => setConnecting(false)}
          onReconnect={handleReconnect}
          onReconnectStart={(_event, edge) => {
            reconnectingEdgeIdRef.current = edge.id;
            setConnecting(true);
          }}
          onReconnectEnd={() => {
            reconnectingEdgeIdRef.current = null;
            setConnecting(false);
          }}
          isValidConnection={isValidConnection}
          connectionMode={ConnectionMode.Loose}
          connectionLineType={ConnectionLineType.Bezier}
          connectionRadius={28}
          connectionDragThreshold={0}
          nodesConnectable
          edgesReconnectable
          reconnectRadius={30}
          connectOnClick
          onInit={setFlowInstance}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          minZoom={0.2}
          maxZoom={2}
          snapToGrid
          snapGrid={[20, 20]}
          deleteKeyCode={["Backspace", "Delete"]}
          defaultEdgeOptions={{ type: "default" }}
        >
          <Background
            variant={
              mode === "immersive"
                ? BackgroundVariant.Dots
                : BackgroundVariant.Lines
            }
            gap={mode === "immersive" ? 24 : 20}
            size={1}
            color={mode === "immersive" ? "#44234c" : "var(--line-strong)"}
          />
          <MiniMap
            pannable
            zoomable
            nodeStrokeWidth={3}
            nodeColor={(node) => (node.data as TopologyCanvasNodeData).color}
          />
          <Controls showInteractive={false} />
        </ReactFlow>
        {topology.nodes.length === 0 && (
          <div className="ce-topology-flow-empty">
            <Waypoints className="h-5 w-5" />
            <span>尚未建立运行节点</span>
          </div>
        )}
      </div>
      <div className="ce-topology-rule-grid">
        <div>
          <span>循环规则</span>
          <strong>{topology.cycleRule || "未定义"}</strong>
        </div>
        <div>
          <span>收束规则</span>
          <strong>{topology.closureRule || "未定义"}</strong>
        </div>
        <div>
          <span>消耗模型</span>
          <strong>{topology.costModel || "未定义"}</strong>
        </div>
      </div>
      <div className="ce-topology-footer">
        <span>运行拓扑属于法门，不属于体系顶层</span>
        <Button
          variant="secondary"
          onClick={addNode}
          disabled={system.theoryModel.nodeCatalog.length === 0}
          title={
            system.theoryModel.nodeCatalog.length === 0
              ? "请先在「理论模型」中添加理论节点，再建立运行拓扑"
              : undefined
          }
        >
          <Plus className="h-3.5 w-3.5" />
          添加节点
        </Button>
        <Button
          variant="ghost"
          onClick={addEdge}
          disabled={topology.nodes.length < 2}
          title={topology.nodes.length < 2 ? "至少需要两个节点" : "添加有向边"}
        >
          <GitBranch className="h-3.5 w-3.5" />
          添加流向
        </Button>
      </div>
    </div>
  );
}

function AbilityDirectory({
  system,
  onChange,
  onSelect,
}: {
  system: CultivationSystem;
  onChange: (system: CultivationSystem) => void;
  onSelect: (selection: Selection) => void;
}) {
  const [filter, setFilter] = useState<"all" | Ability["acquisitionType"]>(
    "all",
  );
  const [functionFilter, setFunctionFilter] = useState<
    "all" | Ability["functionType"]
  >("all");
  const add = () => {
    const item = createAbility();
    onChange({ ...system, abilities: [...system.abilities, item] });
    onSelect({ kind: "ability", id: item.id });
  };
  const abilities = system.abilities.filter(
    (item) =>
      (filter === "all" || item.acquisitionType === filter) &&
      (functionFilter === "all" || item.functionType === functionFilter),
  );
  return (
    <>
      <PageHeader
        eyebrow="体系内部 / 06 能力库"
        title="能力库"
        description="能力库统一展示两类能力：达到境界自动解锁，或通过秘籍 / 法门修炼获得。每项能力声明功能类型与释放能量消耗。"
        action={
          <Button variant="primary" onClick={add}>
            <Plus className="h-3.5 w-3.5" />
            新增能力
          </Button>
        }
      />
      <div className="ce-filter-tabs">
        <button
          type="button"
          className={filter === "all" ? "is-active" : ""}
          onClick={() => setFilter("all")}
        >
          全部 <small>{system.abilities.length}</small>
        </button>
        <button
          type="button"
          className={filter === "natural" ? "is-active" : ""}
          onClick={() => setFilter("natural")}
        >
          境界自动获得{" "}
          <small>
            {
              system.abilities.filter(
                (item) => item.acquisitionType === "natural",
              ).length
            }
          </small>
        </button>
        <button
          type="button"
          className={filter === "scripture" ? "is-active" : ""}
          onClick={() => setFilter("scripture")}
        >
          秘籍修炼获得{" "}
          <small>
            {
              system.abilities.filter(
                (item) => item.acquisitionType === "scripture",
              ).length
            }
          </small>
        </button>
        {(["all", "support", "mental", "offensive"] as const).map((value) => (
          <button
            type="button"
            key={value}
            className={functionFilter === value ? "is-active" : ""}
            onClick={() => setFunctionFilter(value)}
          >
            {value === "all"
              ? "全部功能"
              : value === "support"
                ? "辅助类"
                : value === "mental"
                  ? "精神类"
                  : "进攻类"}
          </button>
        ))}
      </div>
      <div className="ce-ability-grid">
        {abilities.map((item) => (
          <button
            type="button"
            key={item.id}
            className="ce-ability-card"
            onClick={() => onSelect({ kind: "ability", id: item.id })}
          >
            <span className={`ce-ability-icon ${item.functionType}`}>
              <Zap className="h-4 w-4" />
            </span>
            <span>
              <div className="ce-card-kicker">
                {item.acquisitionType === "natural"
                  ? "境界自动获得"
                  : "秘籍修炼获得"}{" "}
                ·{" "}
                {item.functionType === "offensive"
                  ? "进攻类 / 能量放大器"
                  : item.functionType === "mental"
                    ? "精神类"
                    : "辅助类"}
              </div>
              <strong>{item.name}</strong>
              <p>{item.effect || item.summary || "尚未填写效果"}</p>
              <small>
                释放消耗：{item.cast.amount || "未定义"} {item.cast.energyLabel}
              </small>
            </span>
            <ChevronRight className="h-4 w-4" />
          </button>
        ))}
      </div>
      {abilities.length === 0 && <Empty text="没有符合条件的能力" />}
    </>
  );
}

type FormationViewMode = "overview" | "canvas";
type FormationDesignerMode = "preview" | "editor";
const MAX_FORMATION_BACKDROP_LAYERS = 48;
type FormationBackdropData = {
  formationId: string;
  design: Formation["design"];
  points: Array<{ ringId: string | null; x: number; y: number }>;
  motionEnabled: boolean;
};
type FormationBackdropNode = Node<FormationBackdropData, "formationBackdrop">;
type FormationCanvasNodeData = {
  title: string;
  kind: string;
  role: string;
  glyph: string;
  color: string;
  size: number;
  element: Formation["nodes"][number]["element"];
  nodeStyle: Formation["nodes"][number]["nodeStyle"];
};
type FormationFlowNode = Node<FormationCanvasNodeData, "formationNode">;
type FormationCanvasNode = FormationBackdropNode | FormationFlowNode;
type FormationCanvasEdgeData = {
  edgeId: string;
  name: string;
  flowType: string;
  rule: string;
};
type FormationCanvasEdge = Edge<FormationCanvasEdgeData>;

function FormationBackdropNodeView({ data }: NodeProps<FormationBackdropNode>) {
  return (
    <FormationBackdropArt
      formationId={data.formationId}
      design={data.design}
      points={data.points}
      motionEnabled={data.motionEnabled}
    />
  );
}

function FormationCanvasNodeView({
  data,
  selected,
}: NodeProps<FormationFlowNode>) {
  const style = {
    "--formation-node-color": data.color,
    "--formation-node-size": `${data.size}px`,
  } as CSSProperties;
  return (
    <div
      className={`ce-formation-flow-node is-${data.nodeStyle} ${selected ? "is-selected" : ""}`}
      style={style}
      title={`${data.title} · ${FORMATION_ELEMENT_LABELS[data.element]}`}
    >
      <div className="ce-formation-node-core">
        <span>{data.glyph || data.title.slice(0, 1)}</span>
        <i aria-hidden="true" />
      </div>
      <strong>{data.title}</strong>
      <small>{FORMATION_ELEMENT_LABELS[data.element]}</small>
      {TOPOLOGY_HANDLE_POINTS.map((handle) => (
        <Handle
          key={handle.id}
          id={handle.id}
          type="source"
          position={handle.position}
          style={handle.style}
          isConnectable
          className="ce-formation-flow-handle"
        />
      ))}
    </div>
  );
}

const formationCanvasNodeTypes = {
  formationBackdrop: FormationBackdropNodeView,
  formationNode: FormationCanvasNodeView,
};

function FormationBackdropLayerRow({
  layer,
  onSelect,
  onToggle,
  onRotationToggle,
}: {
  layer: FormationBackdropLayer;
  onSelect: () => void;
  onToggle: () => void;
  onRotationToggle: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: layer.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  } as CSSProperties;
  return (
    <div
      ref={setNodeRef}
      className={`ce-formation-layer-row ${isDragging ? "is-dragging" : ""}`}
      style={style}
    >
      <button
        type="button"
        className="ce-formation-layer-drag"
        title={`拖动调整${layer.name}层级`}
        aria-label={`拖动调整${layer.name}层级`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="ce-formation-layer-main"
        onClick={onSelect}
      >
        <i style={{ background: layer.color }} />
        <span>{layer.name}</span>
        <small>{FORMATION_BACKDROP_LAYER_LABELS[layer.type]}</small>
      </button>
      <FormationRotationToggle
        name={layer.name}
        checked={layer.rotating}
        onChange={onRotationToggle}
      />
      <button
        type="button"
        className="ce-formation-layer-visibility"
        onClick={onToggle}
        title={layer.visible ? "隐藏底纹" : "显示底纹"}
        aria-label={`${layer.visible ? "隐藏" : "显示"}${layer.name}`}
      >
        {layer.visible ? (
          <Eye className="h-3.5 w-3.5" />
        ) : (
          <EyeOff className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

function FormationRotationToggle({
  name,
  checked,
  onChange,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
}) {
  const action = checked ? "停止" : "开启";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${action}${name}旋转`}
      title={`${action}${name}旋转`}
      className={`ce-formation-rotation-toggle ${checked ? "is-checked" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onChange();
      }}
    >
      <i />
    </button>
  );
}

function formationNodePositionForCanvas(node: Formation["nodes"][number]) {
  if (node.canvasPosition) return node.canvasPosition;
  return {
    x: (node.position.x / 100) * FORMATION_CANVAS_SIZE - node.size / 2,
    y: (node.position.y / 100) * FORMATION_CANVAS_SIZE - node.size / 2,
  };
}

function buildFormationBackdropNode(
  formationId: string,
  design: Formation["design"],
  formationNodes: Formation["nodes"],
  motionEnabled: boolean,
): FormationBackdropNode {
  const canvasSize = getFormationCanvasSize(design);
  const points = formationNodes.map((node) => {
    const position = formationNodePositionForCanvas(node);
    return {
      ringId: node.ringId,
      x: position.x + node.size / 2,
      y: position.y + node.size / 2,
    };
  });
  return {
    id: `formation-backdrop-${formationId}`,
    type: "formationBackdrop",
    position: { x: 0, y: 0 },
    data: {
      formationId,
      design,
      points,
      motionEnabled,
    },
    style: {
      width: canvasSize,
      height: canvasSize,
      zIndex: -1,
      pointerEvents: "none",
    },
    draggable: false,
    selectable: false,
    deletable: false,
    connectable: false,
    focusable: false,
    zIndex: -1,
  };
}

function buildFormationFlowNodes(
  formationNodes: Formation["nodes"],
  canvasSize: number,
): FormationFlowNode[] {
  const canvasOffset = (canvasSize - FORMATION_CANVAS_SIZE) / 2;
  return formationNodes.map<FormationFlowNode>((node) => {
    const position = formationNodePositionForCanvas(node);
    return {
      id: node.id,
      type: "formationNode",
      position: {
        x: position.x + canvasOffset,
        y: position.y + canvasOffset,
      },
      data: {
        title: node.name,
        kind: node.kind,
        role: node.role,
        glyph: node.glyph,
        color: node.color,
        size: node.size,
        element: node.element,
        nodeStyle: node.nodeStyle,
      },
      style: { width: node.size, height: node.size, zIndex: 3 },
      zIndex: 3,
      ariaLabel: `阵元：${node.name}`,
    };
  });
}

function buildFormationCanvasNodes(
  formation: Formation,
  motionEnabled: boolean,
): FormationCanvasNode[] {
  const canvasSize = getFormationCanvasSize(formation.design);
  return [
    buildFormationBackdropNode(
      formation.id,
      formation.design,
      formation.nodes,
      motionEnabled,
    ),
    ...buildFormationFlowNodes(formation.nodes, canvasSize),
  ];
}

function buildFormationCanvasEdges(
  formationEdges: Formation["edges"],
  formationNodes: Formation["nodes"],
): FormationCanvasEdge[] {
  return formationEdges
    .filter(
      (edge) =>
        formationNodes.some((node) => node.id === edge.fromNodeId) &&
        formationNodes.some((node) => node.id === edge.toNodeId),
    )
    .map((edge) => ({
      id: edge.id,
      source: edge.fromNodeId,
      target: edge.toNodeId,
      sourceHandle: edge.fromHandleId,
      targetHandle: edge.toHandleId,
      type: edge.lineStyle === "bezier" ? "default" : edge.lineStyle,
      animated: edge.animated,
      className: "ce-formation-canvas-edge",
      label: edge.name || edge.flowType,
      labelStyle: {
        fill: "var(--button-primary-text)",
        fontSize: "var(--text-xs)",
        fontWeight: 650,
      },
      labelBgStyle: {
        fill: "#100e12",
        fillOpacity: 0.92,
        stroke: edge.color,
        strokeWidth: 0.7,
      },
      labelBgPadding: [7, 4],
      labelBgBorderRadius: 2,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: edge.color,
        width: 17,
        height: 17,
      },
      style: { stroke: edge.color, strokeWidth: 2 },
      zIndex: 2,
      data: {
        edgeId: edge.id,
        name: edge.name,
        flowType: edge.flowType,
        rule: edge.rule,
      },
    }));
}

function FormationDesignCanvas({
  system,
  formation,
  onChange,
  onSelect,
  mode = "editor",
  onOpenEditor,
}: {
  system: CultivationSystem;
  formation: Formation;
  onChange: (system: CultivationSystem) => void;
  onSelect: (selection: Selection) => void;
  mode?: FormationDesignerMode;
  onOpenEditor?: () => void;
}) {
  const editable = mode === "editor";
  const backdropLayerSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const [connecting, setConnecting] = useState(false);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<
    FormationCanvasNode,
    FormationCanvasEdge
  > | null>(null);
  const flowSurfaceRef = useRef<HTMLDivElement>(null);
  const reconnectingEdgeIdRef = useRef<string | null>(null);
  const formationCanvasSize = getFormationCanvasSize(formation.design);
  const [nodes, setNodes, onNodesChange] = useNodesState<FormationCanvasNode>(
    buildFormationCanvasNodes(formation, editable),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<FormationCanvasEdge>(
    buildFormationCanvasEdges(formation.edges, formation.nodes),
  );

  // 画布只随 formation 相关字段内容变化而重建，避免编辑无关字段触发全量重绘。
  const formationDesignSignature = JSON.stringify(formation.design);
  const formationNodesSignature = JSON.stringify(formation.nodes);
  const formationEdgesSignature = JSON.stringify(formation.edges);

  useEffect(() => {
    const backdrop = buildFormationBackdropNode(
      formation.id,
      formation.design,
      formation.nodes,
      editable,
    );
    setNodes((current) => [
      backdrop,
      ...current.filter((node) => node.type === "formationNode"),
    ]);
    // 依赖使用内容签名，见 formationDesignSignature。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, formation.id, formationDesignSignature, setNodes]);

  useEffect(() => {
    const flowNodes = buildFormationFlowNodes(
      formation.nodes,
      formationCanvasSize,
    );
    setNodes((current) => {
      const backdrop = current.find(
        (node): node is FormationBackdropNode =>
          node.type === "formationBackdrop",
      );
      return backdrop ? [backdrop, ...flowNodes] : current;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formationCanvasSize, formationNodesSignature, setNodes]);

  useEffect(() => {
    setEdges(buildFormationCanvasEdges(formation.edges, formation.nodes));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formationEdgesSignature, formationNodesSignature, setEdges]);

  useEffect(() => {
    const surface = flowSurfaceRef.current;
    if (!flowInstance || !surface) return;
    let resizeTimer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        void flowInstance.fitView({ padding: 0.05 });
      }, 120);
    });
    observer.observe(surface);
    return () => {
      observer.disconnect();
      window.clearTimeout(resizeTimer);
    };
  }, [flowInstance]);

  useEffect(() => {
    if (!flowInstance) return;
    const fitTimer = window.setTimeout(() => {
      void flowInstance.fitView({ padding: 0.05 });
    }, 120);
    return () => window.clearTimeout(fitTimer);
  }, [flowInstance, formationCanvasSize]);

  const updateFormation = (update: (current: Formation) => Formation) => {
    onChange({
      ...system,
      formations: updateById(system.formations, formation.id, update),
    });
  };
  const nodeName = (nodeId: string) =>
    formation.nodes.find((node) => node.id === nodeId)?.name || nodeId;
  const sortedBackdropLayers = useMemo(
    () =>
      [...formation.design.backdropLayers].sort(
        (left, right) => left.order - right.order,
      ),
    [formation.design.backdropLayers],
  );
  const applyBackdropPreset = (presetId: FormationBackdropPresetId) => {
    const preset = createFormationBackdropPreset(presetId, () =>
      newEcologyId("formation-backdrop"),
    );
    updateFormation((current) => ({
      ...current,
      design: { ...current.design, ...preset },
    }));
    onSelect(null);
  };
  const addBackdropLayer = () => {
    if (formation.design.backdropLayers.length >= MAX_FORMATION_BACKDROP_LAYERS)
      return;
    const next = createDefaultFormationBackdropLayer(
      "ring",
      newEcologyId("formation-backdrop"),
      formation.design.backdropLayers.length,
      formation.design.palette,
    );
    updateFormation((current) => ({
      ...current,
      design: {
        ...current.design,
        presetId: "custom",
        backdropLayers: [...current.design.backdropLayers, next],
      },
    }));
    onSelect({
      kind: "formation-backdrop-layer",
      id: next.id,
      parentId: formation.id,
      parentKind: "formation",
    });
  };
  const toggleBackdropLayer = (layerId: string) => {
    updateFormation((current) => ({
      ...current,
      design: {
        ...current.design,
        presetId: "custom",
        backdropLayers: updateById(
          current.design.backdropLayers,
          layerId,
          (layer) => ({ ...layer, visible: !layer.visible }),
        ),
      },
    }));
  };
  const toggleBackdropLayerRotation = (layerId: string) => {
    updateFormation((current) => ({
      ...current,
      design: {
        ...current.design,
        presetId: "custom",
        backdropLayers: updateById(
          current.design.backdropLayers,
          layerId,
          (layer) => ({ ...layer, rotating: !layer.rotating }),
        ),
      },
    }));
  };
  const handleBackdropLayerDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    const oldIndex = sortedBackdropLayers.findIndex(
      (layer) => layer.id === event.active.id,
    );
    const newIndex = sortedBackdropLayers.findIndex(
      (layer) => layer.id === event.over?.id,
    );
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(sortedBackdropLayers, oldIndex, newIndex).map(
      (layer, order) => ({ ...layer, order }),
    );
    updateFormation((current) => ({
      ...current,
      design: {
        ...current.design,
        presetId: "custom",
        backdropLayers: next,
      },
    }));
  };
  const isValidConnection = (connection: Connection | FormationCanvasEdge) => {
    if (!connection.source || !connection.target) return false;
    if (connection.source === connection.target) return false;
    return !formation.edges.some(
      (edge) =>
        edge.id !== reconnectingEdgeIdRef.current &&
        edge.fromNodeId === connection.source &&
        edge.toNodeId === connection.target,
    );
  };
  const addRing = () => {
    const lastRadius = Math.max(
      40,
      ...formation.design.rings.map((ring) => ring.radius),
    );
    const next: Formation["design"]["rings"][number] = {
      id: newEcologyId("formation-ring"),
      name: `环层 ${formation.design.rings.length + 1}`,
      radius: Math.min(FORMATION_MAX_RADIUS, lastRadius + 70),
      style: formation.design.rings.length % 2 === 0 ? "runic" : "double",
      color: formation.design.rings.length % 2 === 0 ? "#77aeb9" : "#c7aa69",
      strokeWidth: 1.5,
      rotation: 0,
      rotating: false,
      runes: "道纹流转 · 生生不息 · ",
      visible: true,
      order: formation.design.rings.length,
    };
    updateFormation((current) => ({
      ...current,
      design: {
        ...current.design,
        rings: [...current.design.rings, next],
      },
    }));
    onSelect({
      kind: "formation-ring",
      id: next.id,
      parentId: formation.id,
      parentKind: "formation",
    });
  };
  const toggleRingRotation = (ringId: string) => {
    updateFormation((current) => ({
      ...current,
      design: {
        ...current.design,
        presetId: "custom",
        rings: updateById(current.design.rings, ringId, (ring) => ({
          ...ring,
          rotating: !ring.rotating,
        })),
      },
    }));
  };
  const addNode = () => {
    const elements: Array<Formation["nodes"][number]["element"]> = [
      "source",
      "foundation",
      "pattern",
      "domain",
      "law",
    ];
    const element = elements[formation.nodes.length % elements.length];
    const rings = [...formation.design.rings].sort(
      (left, right) => left.radius - right.radius,
    );
    const ring = rings[formation.nodes.length % Math.max(1, rings.length)];
    const angle = (formation.nodes.length * 47) % 360;
    const size = 72;
    const canvasPosition = formationCanvasPosition(
      angle,
      ring?.radius ?? 180,
      size,
    );
    const theoryNode =
      system.theoryModel.nodeCatalog[
        formation.nodes.length %
          Math.max(1, system.theoryModel.nodeCatalog.length)
      ];
    const next: Formation["nodes"][number] = {
      id: newEcologyId("formation-node"),
      name: `${FORMATION_ELEMENT_LABELS[element]} ${formation.nodes.length + 1}`,
      kind: "阵元",
      role: FORMATION_ELEMENT_LABELS[element],
      theoryNodeId: theoryNode?.id ?? null,
      position: {
        x: ((canvasPosition.x + size / 2) / FORMATION_CANVAS_SIZE) * 100,
        y: ((canvasPosition.y + size / 2) / FORMATION_CANVAS_SIZE) * 100,
      },
      canvasPosition,
      ringId: ring?.id ?? null,
      angle,
      size,
      color: FORMATION_ELEMENT_COLORS[element],
      glyph: FORMATION_ELEMENT_LABELS[element].slice(-1),
      element,
      nodeStyle: "seal",
    };
    updateFormation((current) => ({
      ...current,
      nodes: [...current.nodes, next],
    }));
    onSelect({
      kind: "formation-node",
      id: next.id,
      parentId: formation.id,
      parentKind: "formation",
    });
  };
  const addEdge = () => {
    if (formation.nodes.length < 2) return;
    const source = formation.nodes[0];
    const target = formation.nodes[1];
    const next: Formation["edges"][number] = {
      id: newEcologyId("formation-edge"),
      name: `${source.name} · ${target.name}`,
      fromNodeId: source.id,
      toNodeId: target.id,
      fromHandleId: "east-north",
      toHandleId: "west-north",
      order: formation.edges.length,
      rule: "",
      flowType: "灵流",
      lineStyle: "bezier",
      color: source.color,
      animated: true,
    };
    updateFormation((current) => ({
      ...current,
      edges: [...current.edges, next],
    }));
    onSelect({
      kind: "formation-edge",
      id: next.id,
      parentId: formation.id,
      parentKind: "formation",
    });
  };
  const handleConnect = (connection: Connection) => {
    if (
      !isValidConnection(connection) ||
      !connection.source ||
      !connection.target
    )
      return;
    const source = formation.nodes.find(
      (node) => node.id === connection.source,
    );
    const next: Formation["edges"][number] = {
      id: newEcologyId("formation-edge"),
      name: `${nodeName(connection.source)} · ${nodeName(connection.target)}`,
      fromNodeId: connection.source,
      toNodeId: connection.target,
      fromHandleId: connection.sourceHandle ?? undefined,
      toHandleId: connection.targetHandle ?? undefined,
      order: formation.edges.length,
      rule: "",
      flowType: "灵流",
      lineStyle: "bezier",
      color: source?.color ?? "#d9b86c",
      animated: true,
    };
    updateFormation((current) => ({
      ...current,
      edges: [...current.edges, next],
    }));
    onSelect({
      kind: "formation-edge",
      id: next.id,
      parentId: formation.id,
      parentKind: "formation",
    });
  };
  const handleReconnect = (
    oldEdge: FormationCanvasEdge,
    connection: Connection,
  ) => {
    if (
      !isValidConnection(connection) ||
      !connection.source ||
      !connection.target
    )
      return;
    const edgeId = oldEdge.data?.edgeId ?? oldEdge.id;
    setEdges((current) => reconnectEdge(oldEdge, connection, current));
    updateFormation((current) => ({
      ...current,
      edges: updateById(current.edges, edgeId, (edge) => ({
        ...edge,
        fromNodeId: connection.source as string,
        toNodeId: connection.target as string,
        fromHandleId: connection.sourceHandle ?? undefined,
        toHandleId: connection.targetHandle ?? undefined,
      })),
    }));
  };
  const handleNodeDragStop = (_event: unknown, node: FormationCanvasNode) => {
    if (node.type !== "formationNode") return;
    const source = formation.nodes.find((item) => item.id === node.id);
    if (!source) return;
    const canvasOffset = (formationCanvasSize - FORMATION_CANVAS_SIZE) / 2;
    const logicalPosition = {
      x: node.position.x - canvasOffset,
      y: node.position.y - canvasOffset,
    };
    const centerX = logicalPosition.x + source.size / 2;
    const centerY = logicalPosition.y + source.size / 2;
    const angle =
      ((Math.atan2(
        centerY - FORMATION_CANVAS_CENTER,
        centerX - FORMATION_CANVAS_CENTER,
      ) *
        180) /
        Math.PI +
        90 +
        360) %
      360;
    updateFormation((current) => ({
      ...current,
      nodes: updateById(current.nodes, node.id, (currentNode) => ({
        ...currentNode,
        canvasPosition: logicalPosition,
        position: {
          x: (centerX / FORMATION_CANVAS_SIZE) * 100,
          y: (centerY / FORMATION_CANVAS_SIZE) * 100,
        },
        angle,
      })),
    }));
  };
  const handleNodesDelete = (deletedNodes: FormationCanvasNode[]) => {
    const deletedIds = new Set(
      deletedNodes
        .filter((node) => node.type === "formationNode")
        .map((node) => node.id),
    );
    if (deletedIds.size === 0) return;
    updateFormation((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => !deletedIds.has(node.id)),
      edges: current.edges.filter(
        (edge) =>
          !deletedIds.has(edge.fromNodeId) && !deletedIds.has(edge.toNodeId),
      ),
    }));
    onSelect(null);
  };
  const handleEdgesDelete = (deletedEdges: FormationCanvasEdge[]) => {
    const deletedIds = new Set(deletedEdges.map((edge) => edge.id));
    updateFormation((current) => ({
      ...current,
      edges: current.edges.filter((edge) => !deletedIds.has(edge.id)),
    }));
    onSelect(null);
  };
  const handleLayout = () => {
    const ringGroups = new Map<string | null, Formation["nodes"]>();
    formation.nodes.forEach((node) => {
      const group = ringGroups.get(node.ringId) ?? [];
      group.push(node);
      ringGroups.set(node.ringId, group);
    });
    const ringById = new Map(
      formation.design.rings.map((ring) => [ring.id, ring] as const),
    );
    const nextNodes = formation.nodes.map((node) => {
      if (node.element === "eye") {
        const canvasPosition = formationCanvasPosition(0, 0, node.size);
        return {
          ...node,
          angle: 0,
          ringId: null,
          canvasPosition,
          position: { x: 50, y: 50 },
        };
      }
      const group = ringGroups.get(node.ringId) ?? [];
      const index = Math.max(
        0,
        group.findIndex((item) => item.id === node.id),
      );
      const angle = (index / Math.max(1, group.length)) * 360;
      const radius =
        (node.ringId ? ringById.get(node.ringId)?.radius : undefined) ?? 180;
      const canvasPosition = formationCanvasPosition(angle, radius, node.size);
      return {
        ...node,
        angle,
        canvasPosition,
        position: {
          x: ((canvasPosition.x + node.size / 2) / FORMATION_CANVAS_SIZE) * 100,
          y: ((canvasPosition.y + node.size / 2) / FORMATION_CANVAS_SIZE) * 100,
        },
      };
    });
    updateFormation((current) => ({ ...current, nodes: nextNodes }));
    window.setTimeout(() => flowInstance?.fitView({ padding: 0.05 }), 0);
  };

  return (
    <div className={`ce-formation-designer is-${mode}`}>
      <div className="ce-formation-canvas-toolbar">
        <div className="ce-formation-canvas-stats">
          <span>{formation.design.rings.length} 层阵环</span>
          <span>{formation.nodes.length} 个阵元</span>
          <span>{formation.edges.length} 条流向</span>
        </div>
        {editable && (
          <div
            className="ce-formation-preset-switch"
            role="group"
            aria-label="阵法底图预设"
          >
            {FORMATION_BACKDROP_PRESETS.map((preset) => (
              <button
                type="button"
                key={preset.id}
                className={
                  formation.design.presetId === preset.id ? "is-active" : ""
                }
                onClick={() => applyBackdropPreset(preset.id)}
                title={`${preset.name}：${preset.description}`}
                aria-pressed={formation.design.presetId === preset.id}
              >
                <i
                  style={{
                    background: `linear-gradient(135deg, ${preset.palette.primary}, ${preset.palette.secondary})`,
                  }}
                />
                {preset.name}
              </button>
            ))}
          </div>
        )}
        {editable ? (
          <>
            <Button variant="ghost" onClick={addRing}>
              <Plus className="h-3.5 w-3.5" />
              新增环层
            </Button>
            <Button variant="secondary" onClick={addNode}>
              <Plus className="h-3.5 w-3.5" />
              新增阵元
            </Button>
            <Button
              variant="ghost"
              onClick={addEdge}
              disabled={formation.nodes.length < 2}
              title={
                formation.nodes.length < 2 ? "至少需要两个阵元" : undefined
              }
            >
              <GitBranch className="h-3.5 w-3.5" />
              新增流向
            </Button>
            <Button
              variant="ghost"
              onClick={handleLayout}
              title="按环层自动排列阵元"
            >
              <Route className="h-3.5 w-3.5" />
              同心布局
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onOpenEditor}>
            <Maximize2 className="h-3.5 w-3.5" />
            全屏编辑
          </Button>
        )}
      </div>
      <div
        ref={flowSurfaceRef}
        className={`ce-formation-flow-surface is-${formation.design.canvasStyle} is-${mode} ${connecting ? "is-connecting" : ""}`}
      >
        <ReactFlow<FormationCanvasNode, FormationCanvasEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={formationCanvasNodeTypes}
          onNodesChange={editable ? onNodesChange : undefined}
          onEdgesChange={editable ? onEdgesChange : undefined}
          onNodeClick={
            editable
              ? (_event, node) => {
                  if (node.type !== "formationNode") return;
                  onSelect({
                    kind: "formation-node",
                    id: node.id,
                    parentId: formation.id,
                    parentKind: "formation",
                  });
                }
              : undefined
          }
          onEdgeClick={
            editable
              ? (_event, edge) =>
                  onSelect({
                    kind: "formation-edge",
                    id: edge.id,
                    parentId: formation.id,
                    parentKind: "formation",
                  })
              : undefined
          }
          onNodeDragStop={editable ? handleNodeDragStop : undefined}
          onNodesDelete={editable ? handleNodesDelete : undefined}
          onEdgesDelete={editable ? handleEdgesDelete : undefined}
          onConnect={editable ? handleConnect : undefined}
          onConnectStart={editable ? () => setConnecting(true) : undefined}
          onConnectEnd={editable ? () => setConnecting(false) : undefined}
          onReconnect={editable ? handleReconnect : undefined}
          onReconnectStart={
            editable
              ? (_event, edge) => {
                  reconnectingEdgeIdRef.current = edge.id;
                  setConnecting(true);
                }
              : undefined
          }
          onReconnectEnd={
            editable
              ? () => {
                  reconnectingEdgeIdRef.current = null;
                  setConnecting(false);
                }
              : undefined
          }
          isValidConnection={editable ? isValidConnection : undefined}
          connectionMode={ConnectionMode.Loose}
          connectionLineType={ConnectionLineType.Bezier}
          connectionRadius={30}
          connectionDragThreshold={0}
          nodesDraggable={editable}
          nodesConnectable={editable}
          edgesReconnectable={editable}
          reconnectRadius={30}
          elementsSelectable={editable}
          connectOnClick={editable}
          onInit={setFlowInstance}
          fitView
          fitViewOptions={{ padding: 0.05 }}
          minZoom={0.1}
          maxZoom={2.5}
          snapToGrid
          snapGrid={[10, 10]}
          deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color={
              formation.design.canvasStyle === "mystic" ? "#3f3528" : "#48535b"
            }
          />
          {editable && (
            <MiniMap
              pannable
              zoomable
              nodeStrokeWidth={2}
              nodeColor={(node) =>
                node.type === "formationBackdrop"
                  ? formation.design.backgroundColor
                  : (node.data as FormationCanvasNodeData).color
              }
            />
          )}
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {editable && (
        <div className="ce-formation-object-rail">
          <div className="ce-formation-object-group">
            <div className="ce-formation-object-head">
              <span>底纹</span>
              <button
                type="button"
                onClick={addBackdropLayer}
                disabled={
                  formation.design.backdropLayers.length >=
                  MAX_FORMATION_BACKDROP_LAYERS
                }
                title={
                  formation.design.backdropLayers.length >=
                  MAX_FORMATION_BACKDROP_LAYERS
                    ? `底纹最多 ${MAX_FORMATION_BACKDROP_LAYERS} 层`
                    : "新增底纹"
                }
                aria-label="新增底纹"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            <DndContext
              sensors={backdropLayerSensors}
              onDragEnd={handleBackdropLayerDragEnd}
            >
              <SortableContext
                items={sortedBackdropLayers.map((layer) => layer.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="ce-formation-object-list">
                  {sortedBackdropLayers.map((layer) => (
                    <FormationBackdropLayerRow
                      key={layer.id}
                      layer={layer}
                      onSelect={() =>
                        onSelect({
                          kind: "formation-backdrop-layer",
                          id: layer.id,
                          parentId: formation.id,
                          parentKind: "formation",
                        })
                      }
                      onToggle={() => toggleBackdropLayer(layer.id)}
                      onRotationToggle={() =>
                        toggleBackdropLayerRotation(layer.id)
                      }
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>
          <div className="ce-formation-object-group">
            <div className="ce-formation-object-head">
              <span>阵环</span>
              <button
                type="button"
                onClick={addRing}
                title="新增环层"
                aria-label="新增环层"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="ce-formation-object-list">
              {[...formation.design.rings]
                .sort((left, right) => left.order - right.order)
                .map((ring) => (
                  <div
                    className="ce-formation-layer-row ce-formation-ring-row"
                    key={ring.id}
                  >
                    <button
                      type="button"
                      className="ce-formation-layer-main"
                      onClick={() =>
                        onSelect({
                          kind: "formation-ring",
                          id: ring.id,
                          parentId: formation.id,
                          parentKind: "formation",
                        })
                      }
                    >
                      <i style={{ background: ring.color }} />
                      <span>{ring.name}</span>
                      <small>{ring.radius}px</small>
                    </button>
                    <FormationRotationToggle
                      name={ring.name}
                      checked={ring.rotating}
                      onChange={() => toggleRingRotation(ring.id)}
                    />
                  </div>
                ))}
            </div>
          </div>
          <div className="ce-formation-object-group">
            <div className="ce-formation-object-head">
              <span>阵元</span>
              <button
                type="button"
                onClick={addNode}
                title="新增阵元"
                aria-label="新增阵元"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="ce-formation-object-list">
              {formation.nodes.map((node) => (
                <button
                  type="button"
                  key={node.id}
                  onClick={() =>
                    onSelect({
                      kind: "formation-node",
                      id: node.id,
                      parentId: formation.id,
                      parentKind: "formation",
                    })
                  }
                >
                  <i style={{ background: node.color }} />
                  <span>{node.name}</span>
                  <small>{FORMATION_ELEMENT_LABELS[node.element]}</small>
                </button>
              ))}
            </div>
          </div>
          <div className="ce-formation-object-group">
            <div className="ce-formation-object-head">
              <span>流向</span>
              <button
                type="button"
                onClick={addEdge}
                disabled={formation.nodes.length < 2}
                title="新增流向"
                aria-label="新增流向"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="ce-formation-object-list">
              {formation.edges.map((edge) => (
                <button
                  type="button"
                  key={edge.id}
                  onClick={() =>
                    onSelect({
                      kind: "formation-edge",
                      id: edge.id,
                      parentId: formation.id,
                      parentKind: "formation",
                    })
                  }
                >
                  <i style={{ background: edge.color }} />
                  <span>
                    {edge.name ||
                      `${nodeName(edge.fromNodeId)} · ${nodeName(edge.toNodeId)}`}
                  </span>
                  <small>{edge.flowType}</small>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FormationWorkspace({
  system,
  onChange,
  onSelect,
  onOpenEditor,
}: {
  system: CultivationSystem;
  onChange: (system: CultivationSystem) => void;
  onSelect: (selection: Selection) => void;
  onOpenEditor: (formationId: string) => void;
}) {
  const [formationId, setFormationId] = useState(
    system.formations[0]?.id ?? "",
  );
  const [view, setView] = useState<FormationViewMode>("overview");
  const formation =
    system.formations.find((item) => item.id === formationId) ??
    system.formations[0];
  const add = () => {
    const item = createFormation();
    onChange({ ...system, formations: [...system.formations, item] });
    setFormationId(item.id);
    setView("canvas");
    onSelect({ kind: "formation", id: item.id });
  };
  const addNode = () => {
    if (!formation) return;
    const size = 72;
    const canvasPosition = formationCanvasPosition(
      formation.nodes.length * 45,
      210,
      size,
    );
    const next: Formation["nodes"][number] = {
      id: newEcologyId("formation-node"),
      name: `阵元 ${formation.nodes.length + 1}`,
      kind: "阵元",
      role: "运行",
      theoryNodeId: system.theoryModel.nodeCatalog[0]?.id ?? null,
      position: {
        x: ((canvasPosition.x + size / 2) / FORMATION_CANVAS_SIZE) * 100,
        y: ((canvasPosition.y + size / 2) / FORMATION_CANVAS_SIZE) * 100,
      },
      canvasPosition,
      ringId: formation.design.rings[1]?.id ?? null,
      angle: (formation.nodes.length * 45) % 360,
      size,
      color: FORMATION_ELEMENT_COLORS.pattern,
      glyph: "纹",
      element: "pattern",
      nodeStyle: "seal",
    };
    onChange({
      ...system,
      formations: updateById(system.formations, formation.id, (current) => ({
        ...current,
        nodes: [...current.nodes, next],
      })),
    });
    onSelect({
      kind: "formation-node",
      id: next.id,
      parentId: formation.id,
      parentKind: "formation",
    });
  };
  const addEdge = () => {
    if (!formation || formation.nodes.length < 2) return;
    const source = formation.nodes[0];
    const target = formation.nodes[1];
    const next: Formation["edges"][number] = {
      id: newEcologyId("formation-edge"),
      name: `${source.name} · ${target.name}`,
      fromNodeId: source.id,
      toNodeId: target.id,
      order: formation.edges.length,
      rule: "",
      flowType: "灵流",
      lineStyle: "bezier",
      color: source.color,
      animated: true,
    };
    onChange({
      ...system,
      formations: updateById(system.formations, formation.id, (current) => ({
        ...current,
        edges: [...current.edges, next],
      })),
    });
    onSelect({
      kind: "formation-edge",
      id: next.id,
      parentId: formation.id,
      parentKind: "formation",
    });
  };
  const viewSwitch = (
    <div className="ce-topology-view-switch" role="group" aria-label="阵法视图">
      <button
        type="button"
        className={view === "overview" ? "is-active" : ""}
        aria-pressed={view === "overview"}
        onClick={() => setView("overview")}
      >
        <FileText className="h-3.5 w-3.5" />
        总览
      </button>
      <button
        type="button"
        className={view === "canvas" ? "is-active" : ""}
        aria-pressed={view === "canvas"}
        onClick={() => setView("canvas")}
      >
        <Waypoints className="h-3.5 w-3.5" />
        阵图
      </button>
    </div>
  );
  if (!formation)
    return (
      <>
        <PageHeader
          eyebrow="体系内部 / 07 阵法与部署"
          title="阵法与部署"
          description="阵法是独立的部署拓扑，引用理论节点、法门、能力和资源，承担区域放大、控制、防护或仪式功能。"
          action={
            <Button variant="primary" onClick={add}>
              <Plus className="h-3.5 w-3.5" />
              新增阵法
            </Button>
          }
        />
        <Empty text="尚未建立阵法" />
      </>
    );
  return (
    <>
      <PageHeader
        eyebrow="体系内部 / 07 阵法与部署"
        title="阵法与部署"
        description="以六元结构定义局部法则，通过阵盘骨架、阵元与灵流共同完成可运行的阵法设计。"
        action={
          <Button variant="primary" onClick={add}>
            <Plus className="h-3.5 w-3.5" />
            新增阵法
          </Button>
        }
      />
      <div className="ce-formation-workspace">
        <div className="ce-formation-list">
          {system.formations.map((item) => (
            <div
              key={item.id}
              className={`ce-formation-list-item ${item.id === formation.id ? "is-active" : ""}`}
            >
              <button
                type="button"
                className="ce-formation-list-item-trigger"
                onClick={() => setFormationId(item.id)}
              >
                <Hexagon className="h-4 w-4" />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.category}</small>
                </span>
              </button>
              <button
                type="button"
                className="ce-formation-list-item-edit"
                title={`编辑${item.name}`}
                aria-label={`编辑${item.name}`}
                onClick={() => onSelect({ kind: "formation", id: item.id })}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="ce-formation-detail">
          <Section
            title={formation.name}
            eyebrow={`${formation.structure} · ${formation.scale || "规模未定"}`}
            action={viewSwitch}
          >
            {view === "canvas" ? (
              <FormationDesignCanvas
                system={system}
                formation={formation}
                onChange={onChange}
                onSelect={onSelect}
                mode="preview"
                onOpenEditor={() => onOpenEditor(formation.id)}
              />
            ) : (
              <>
                <div className="ce-formation-overview-actions">
                  <Button variant="secondary" onClick={addNode}>
                    <Plus className="h-3.5 w-3.5" />
                    新增阵元
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={addEdge}
                    disabled={formation.nodes.length < 2}
                    title={
                      formation.nodes.length < 2
                        ? "至少需要两个阵元"
                        : undefined
                    }
                  >
                    <GitBranch className="h-3.5 w-3.5" />
                    新增流向
                  </Button>
                </div>
                <div className="ce-formation-map">
                  <svg
                    className="ce-formation-edges"
                    aria-hidden="true"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                  >
                    <defs>
                      <marker
                        id={`ce-formation-arrow-${formation.id}`}
                        markerWidth="5"
                        markerHeight="5"
                        refX="4"
                        refY="2.5"
                        orient="auto"
                        markerUnits="strokeWidth"
                      >
                        <path
                          d="M 0 0 L 5 2.5 L 0 5 z"
                          fill="var(--accent-warm)"
                        />
                      </marker>
                    </defs>
                    {formation.edges.map((edge) => {
                      const from = formation.nodes.find(
                        (node) => node.id === edge.fromNodeId,
                      );
                      const to = formation.nodes.find(
                        (node) => node.id === edge.toNodeId,
                      );
                      if (!from || !to) return null;
                      return (
                        <line
                          key={edge.id}
                          x1={from.position.x}
                          y1={from.position.y}
                          x2={to.position.x}
                          y2={to.position.y}
                          markerEnd={`url(#ce-formation-arrow-${formation.id})`}
                        />
                      );
                    })}
                  </svg>
                  <div className="ce-formation-center">
                    <Hexagon className="h-8 w-8" />
                    <span>阵眼</span>
                  </div>
                  {formation.nodes.map((node) => (
                    <button
                      type="button"
                      key={node.id}
                      className="ce-formation-node"
                      style={{
                        left: `${node.position.x}%`,
                        top: `${node.position.y}%`,
                      }}
                      onClick={() =>
                        onSelect({
                          kind: "formation-node",
                          id: node.id,
                          parentId: formation.id,
                          parentKind: "formation",
                        })
                      }
                    >
                      <CircleDot className="h-3.5 w-3.5" />
                      <span>{node.name}</span>
                    </button>
                  ))}
                </div>
                <div className="ce-formation-six-grid">
                  {(
                    Object.keys(FORMATION_ELEMENT_LABELS) as Array<
                      keyof Formation["sixElements"]
                    >
                  ).map((key) => (
                    <button
                      type="button"
                      key={key}
                      onClick={() =>
                        onSelect({ kind: "formation", id: formation.id })
                      }
                    >
                      <span>{FORMATION_ELEMENT_LABELS[key]}</span>
                      <strong>{formation.sixElements[key] || "未定义"}</strong>
                    </button>
                  ))}
                </div>
                <div className="ce-formation-meta">
                  <div>
                    <span>用途</span>
                    <strong>{formation.purpose || "未定义"}</strong>
                  </div>
                  <div>
                    <span>激活</span>
                    <strong>{formation.activation || "未定义"}</strong>
                  </div>
                  <div>
                    <span>边界</span>
                    <strong>{formation.boundary || "未定义"}</strong>
                  </div>
                  <div>
                    <span>风险</span>
                    <strong>{formation.risks.join("、") || "未定义"}</strong>
                  </div>
                </div>
                <div className="ce-edge-list">
                  {formation.edges.map((edge) => (
                    <button
                      type="button"
                      key={edge.id}
                      onClick={() =>
                        onSelect({
                          kind: "formation-edge",
                          id: edge.id,
                          parentId: formation.id,
                          parentKind: "formation",
                        })
                      }
                    >
                      <GitBranch className="h-3.5 w-3.5" />
                      <span>{edge.name}</span>
                      <small>{edge.rule || "未定义流向规则"}</small>
                    </button>
                  ))}
                </div>
              </>
            )}
          </Section>
          {view === "overview" && (
            <Section
              title="部署索引"
              eyebrow={`${formation.nodes.length} 个节点 · ${formation.edges.length} 条边`}
            >
              <div className="ce-deployment-list">
                {formation.nodes.map((node) => (
                  <button
                    type="button"
                    key={node.id}
                    onClick={() =>
                      onSelect({
                        kind: "formation-node",
                        id: node.id,
                        parentId: formation.id,
                        parentKind: "formation",
                      })
                    }
                  >
                    <span>{node.name}</span>
                    <small>
                      {FORMATION_ELEMENT_LABELS[node.element]} · {node.role}
                    </small>
                  </button>
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
    </>
  );
}

function Assets({
  system,
  onOpenModule,
}: {
  system: CultivationSystem;
  onOpenModule: (module: ModuleId, selection?: Selection) => void;
}) {
  const references = new Map<string, string[]>();
  const addReference = (id: string, label: string) =>
    references.set(id, [...(references.get(id) ?? []), label]);
  system.progressionTracks.forEach((track) => {
    track.levels.forEach((level) => {
      level.methodIds.forEach((id) => addReference(id, `境界 · ${level.name}`));
      level.naturalAbilityIds.forEach((id) =>
        addReference(id, `境界 · ${level.name}`),
      );
      level.resourceRequirements.forEach((requirement) =>
        addReference(requirement.resourceId, `境界 · ${level.name}`),
      );
      level.subStages.forEach((stage) => {
        const label = `${level.name} · ${stage.name}`;
        stage.methodIds.forEach((id) =>
          addReference(id, `境内阶段 · ${label}`),
        );
        stage.naturalAbilityIds.forEach((id) =>
          addReference(id, `境内阶段 · ${label}`),
        );
        stage.resourceRequirements.forEach((requirement) =>
          addReference(requirement.resourceId, `境内阶段 · ${label}`),
        );
      });
    });
    track.transitions.forEach((transition) => {
      transition.methodIds.forEach((id) =>
        addReference(id, `轨道转换 · ${transition.name}`),
      );
      transition.resourceRequirements.forEach((requirement) =>
        addReference(requirement.resourceId, `轨道转换 · ${transition.name}`),
      );
    });
  });
  system.methods.forEach((method) => {
    method.courses.forEach((course) =>
      course.resourceRequirements.forEach((requirement) =>
        addReference(requirement.resourceId, `课程 · ${course.title}`),
      ),
    );
    method.operationTopologies.forEach((topology) =>
      topology.nodes.forEach((node) =>
        addReference(node.theoryNodeId, `拓扑 · ${topology.name}`),
      ),
    );
  });
  system.abilities.forEach((ability) => {
    ability.trainingRequirements.methodIds.forEach((id) =>
      addReference(id, `能力训练 · ${ability.name}`),
    );
    ability.trainingRequirements.resourceRequirements.forEach((requirement) =>
      addReference(requirement.resourceId, `能力 · ${ability.name}`),
    );
  });
  system.formations.forEach((formation) => {
    formation.theoryNodeIds.forEach((id) =>
      addReference(id, `阵法 · ${formation.name}`),
    );
    formation.methodIds.forEach((id) =>
      addReference(id, `阵法 · ${formation.name}`),
    );
    formation.abilityIds.forEach((id) =>
      addReference(id, `阵法 · ${formation.name}`),
    );
    formation.resourceRequirements.forEach((requirement) =>
      addReference(requirement.resourceId, `阵法 · ${formation.name}`),
    );
  });
  system.transitions.forEach((transition) => {
    transition.methodIds.forEach((id) =>
      addReference(id, `转换 · ${transition.name}`),
    );
    transition.resourceRequirements.forEach((requirement) =>
      addReference(requirement.resourceId, `转换 · ${transition.name}`),
    );
  });
  const groups = [
    {
      type: "理论节点",
      module: "theory" as const,
      kind: "theory-node",
      note: "体系共有结构",
      items: system.theoryModel.nodeCatalog,
    },
    {
      type: "修行法门",
      module: "methods" as const,
      kind: "method",
      note: "法诀、课程、独立拓扑",
      items: system.methods,
    },
    {
      type: "资源",
      module: "resources" as const,
      kind: "resource",
      note: "消耗、供给、替代",
      items: system.resources,
    },
    {
      type: "能力",
      module: "abilities" as const,
      kind: "ability",
      note: "自动解锁、秘籍修炼",
      items: system.abilities,
    },
    {
      type: "阵法",
      module: "formations" as const,
      kind: "formation",
      note: "节点、边、部署边界",
      items: system.formations,
    },
    {
      type: "突破与转换",
      module: "transitions" as const,
      kind: "transition",
      note: "成功、失败、不可逆后果",
      items: system.transitions,
    },
  ];
  return (
    <>
      <PageHeader
        eyebrow="体系内部 / 08 资产索引"
        title="资产索引"
        description="所有资产只定义一次，再通过境界、境内阶段、法门、能力和阵法建立关联；从任一资产都能回到对应成长位置。"
      />
      <Section title="体系资产" eyebrow="反向引用">
        <div className="ce-asset-index">
          {groups.map((group) => (
            <div className="ce-asset-group" key={group.type}>
              <button
                type="button"
                className="ce-asset-group-head"
                onClick={() => onOpenModule(group.module)}
              >
                <span className="ce-index-count">{group.items.length}</span>
                <span>
                  <strong>{group.type}</strong>
                  <small>{group.note}</small>
                </span>
                <ChevronRight className="h-4 w-4" />
              </button>
              <div className="ce-asset-group-items">
                {group.items.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() =>
                      onOpenModule(group.module, {
                        kind: group.kind,
                        id: item.id,
                      })
                    }
                  >
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.id}</small>
                    </span>
                    <em>
                      {references.get(item.id)?.join("、") || "暂无反向引用"}
                    </em>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                ))}
                {group.items.length === 0 && <small>暂无资产</small>}
              </div>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

function FoundationDirectory({
  system,
  onChange,
  onSelect,
}: {
  system: CultivationSystem;
  onChange: (system: CultivationSystem) => void;
  onSelect: (selection: Selection) => void;
}) {
  const add = () => {
    const item: Foundation = {
      id: newEcologyId("foundation"),
      name: "新根基因素",
      summary: "",
      factor: "",
      value: "",
      impact: "",
      affectedTracks: [],
      adjustment: "",
      permanence: "",
    };
    onChange({ ...system, foundations: [...system.foundations, item] });
    onSelect({ kind: "foundation", id: item.id });
  };
  return (
    <>
      <PageHeader
        eyebrow="体系内部 / 09 根基与质量"
        title="根基与质量"
        description="根骨、血脉、灵魂资质、元素亲和或改造程度会跨多个境界影响速度、质量、上限和突破。"
        action={
          <Button variant="primary" onClick={add}>
            <Plus className="h-3.5 w-3.5" />
            新增根基因素
          </Button>
        }
      />
      <div className="ce-directory">
        {system.foundations.map((item) => (
          <button
            type="button"
            key={item.id}
            onClick={() => onSelect({ kind: "foundation", id: item.id })}
          >
            <span className="ce-directory-icon">
              <Target className="h-4 w-4" />
            </span>
            <span>
              <strong>{item.name}</strong>
              <small>
                {item.factor} · 当前值 {item.value}
              </small>
              <em>{item.impact || "尚未描述影响"}</em>
            </span>
            <ChevronRight className="h-4 w-4" />
          </button>
        ))}
      </div>
      {system.foundations.length === 0 && <Empty text="尚未定义根基因素" />}
    </>
  );
}

function TransitionDirectory({
  system,
  onChange,
  onSelect,
}: {
  system: CultivationSystem;
  onChange: (system: CultivationSystem) => void;
  onSelect: (selection: Selection) => void;
}) {
  const nestedTransitions = system.progressionTracks.flatMap((track) =>
    track.transitions.map((transition) => ({ transition, track })),
  );
  const add = () => {
    const item = {
      ...createTransition(),
      transitionType: "conversion" as const,
    };
    onChange({ ...system, transitions: [...system.transitions, item] });
    onSelect({ kind: "transition", id: item.id });
  };
  return (
    <>
      <PageHeader
        eyebrow="体系内部 / 10 突破与转换"
        title="突破与转换"
        description="跃迁是独立的一等对象，记录方法、资源、条件、成功模型、失败语义和不可逆后果。"
        action={
          <Button variant="primary" onClick={add}>
            <Plus className="h-3.5 w-3.5" />
            新增转换
          </Button>
        }
      />
      <div className="ce-transition-list">
        {system.transitions.map((item) => (
          <button
            type="button"
            key={item.id}
            onClick={() => onSelect({ kind: "transition", id: item.id })}
          >
            <GitBranch className="h-4 w-4" />
            <span>
              <strong>{item.name}</strong>
              <small>
                {item.transitionType} · {item.reversible ? "可逆" : "不可逆"}
              </small>
              <em>{item.successResult || "未定义成功结果"}</em>
            </span>
            <ChevronRight className="h-4 w-4" />
          </button>
        ))}
        {nestedTransitions.map(({ transition, track }) => (
          <button
            type="button"
            key={transition.id}
            onClick={() =>
              onSelect({
                kind: "transition",
                id: transition.id,
                parentId: track.id,
                parentKind: "track",
              })
            }
          >
            <GitBranch className="h-4 w-4" />
            <span>
              <strong>{transition.name}</strong>
              <small>
                {track.name} · {transition.transitionType} ·{" "}
                {transition.reversible ? "可逆" : "不可逆"}
              </small>
              <em>{transition.successResult || "未定义成功结果"}</em>
            </span>
            <ChevronRight className="h-4 w-4" />
          </button>
        ))}
      </div>
      {system.transitions.length === 0 && nestedTransitions.length === 0 && (
        <Empty text="尚未定义突破或体系转换" />
      )}
    </>
  );
}

function ConstraintDirectory({
  system,
  onChange,
  onSelect,
}: {
  system: CultivationSystem;
  onChange: (system: CultivationSystem) => void;
  onSelect: (selection: Selection) => void;
}) {
  const add = () => {
    const item: Constraint = {
      id: newEcologyId("constraint"),
      name: "新体系约束",
      summary: "",
      category: "cost",
      trigger: "",
      consequence: "",
      mitigation: "",
      reversible: true,
    };
    onChange({ ...system, constraints: [...system.constraints, item] });
    onSelect({ kind: "constraint", id: item.id });
  };
  return (
    <>
      <PageHeader
        eyebrow="体系内部 / 11 体系约束"
        title="体系约束"
        description="代价、污染、反噬、不可逆后果和世界规则决定修行体系的边界与叙事张力。"
        action={
          <Button variant="primary" onClick={add}>
            <Plus className="h-3.5 w-3.5" />
            新增约束
          </Button>
        }
      />
      <div className="ce-constraint-grid">
        {system.constraints.map((item) => (
          <button
            type="button"
            key={item.id}
            onClick={() => onSelect({ kind: "constraint", id: item.id })}
          >
            <ShieldAlert className="h-4 w-4" />
            <span>
              <strong>{item.name}</strong>
              <small>
                {item.category} · 触发：{item.trigger || "未定义"}
              </small>
              <em>{item.consequence || "未定义后果"}</em>
            </span>
          </button>
        ))}
      </div>
      {system.constraints.length === 0 && <Empty text="尚未定义体系约束" />}
    </>
  );
}

function AuditDirectory({
  system,
  onOpenModule,
  onOpenRelations,
  onChange,
}: {
  system: CultivationSystem;
  onOpenModule: (module: ModuleId, selection?: Selection) => void;
  onOpenRelations: (selection?: Selection) => void;
  onChange: (system: CultivationSystem) => void;
}) {
  const unresolved = system.audit.filter((item) => !item.resolved);
  const completeness = calculateCultivationCompleteness(system);
  return (
    <>
      <PageHeader
        eyebrow="体系内部 / 12 审查"
        title="结构审查"
        description="定位无效引用、缺失消耗、拓扑断路、境界冲突和跨体系转换风险。审查结果可以直接跳回对应模块。"
      />
      <div className="ce-audit-score">
        <div>
          <span>结构完整度</span>
          <strong>{completeness}</strong>
          <small>/ 100</small>
        </div>
        <div className="ce-progress">
          <i style={{ width: `${completeness}%` }} />
        </div>
        <span>{unresolved.length} 项待处理</span>
      </div>
      <div className="ce-audit-list">
        {system.audit.map((item) => (
          <div key={item.id} className={item.resolved ? "is-resolved" : ""}>
            <span className={`ce-severity ce-severity-${item.severity}`}>
              {item.severity === "error"
                ? "错误"
                : item.severity === "warning"
                  ? "警告"
                  : "建议"}
            </span>
            <span>
              <strong>{item.title}</strong>
              <small>{item.message}</small>
              <em>{item.suggestion}</em>
            </span>
            <Button
              variant="ghost"
              onClick={() => {
                if (item.resolved) {
                  onChange({
                    ...system,
                    audit: system.audit.map((candidate) =>
                      candidate.id === item.id
                        ? { ...candidate, resolved: false }
                        : candidate,
                    ),
                  });
                  return;
                }
                if (item.targetType === "relation") {
                  onOpenRelations(
                    item.targetId
                      ? { kind: item.targetType, id: item.targetId }
                      : undefined,
                  );
                  return;
                }
                const target: ModuleId =
                  item.targetType === "formation"
                    ? "formations"
                    : item.targetType === "method" ||
                        item.targetType === "topology"
                      ? "methods"
                      : item.targetType === "level" ||
                          item.targetType === "level-stage" ||
                          item.targetType === "transition"
                        ? "progression"
                        : item.targetType === "resource"
                          ? "resources"
                          : item.targetType === "ability"
                            ? "abilities"
                            : item.targetType === "theory"
                              ? "theory"
                              : item.targetType === "foundation"
                                ? "foundations"
                                : item.targetType === "constraint"
                                  ? "constraints"
                                  : "overview";
                onOpenModule(
                  target,
                  item.targetId
                    ? { kind: item.targetType, id: item.targetId }
                    : undefined,
                );
              }}
            >
              {item.resolved ? "撤销处理" : "定位"}
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
            {!item.resolved && (
              <Button
                variant="ghost"
                title="保留问题记录但暂时隐藏"
                onClick={() =>
                  onChange({
                    ...system,
                    audit: system.audit.map((candidate) =>
                      candidate.id === item.id
                        ? { ...candidate, resolved: true }
                        : candidate,
                    ),
                  })
                }
              >
                标记已处理
              </Button>
            )}
          </div>
        ))}
      </div>
      {system.audit.length === 0 && <Empty text="审查通过，暂无问题记录" />}
    </>
  );
}

const manifestationTypeLabels: Record<
  WorldOriginManifestation["type"],
  string
> = {
  division: "分化",
  law: "法则",
  energy: "能量",
  authority: "权柄",
  information: "信息",
  medium: "介质",
};
const typeOrder: WorldOriginManifestation["type"][] = [
  "division",
  "law",
  "energy",
  "authority",
  "information",
  "medium",
];
const originRelationLabels: Record<WorldOriginRelation["relation"], string> = {
  differentiate: "分化",
  manifest: "显化",
  generate: "生成",
  convert: "转化",
  constrain: "约束",
  project: "投影",
  conflict: "冲突",
};
const worldOriginStatusLabels: Record<WorldOrigin["status"], string> = {
  stable: "稳定",
  fragmented: "分裂",
  incomplete: "待完善",
  unstable: "不稳定",
};
// Status and manifestation colors are editable canvas-art semantics, not shell UI states.
const worldOriginStatusColors: Record<WorldOrigin["status"], string> = {
  stable: "#f59e0b",
  fragmented: "#d946ef",
  incomplete: "#60a5fa",
  unstable: "#f43f5e",
};
const worldOriginStatusOrbStyles: Record<
  WorldOrigin["status"],
  CultivationOrbStyle
> = {
  stable: "solar",
  fragmented: "vortex",
  incomplete: "orbit",
  unstable: "corona",
};
const manifestationTypeColors: Record<
  WorldOriginManifestation["type"],
  string
> = {
  division: "#d946ef",
  law: "#60a5fa",
  energy: "#22d3ee",
  authority: "#f59e0b",
  information: "#34d399",
  medium: "#f43f5e",
};
const manifestationTypeOrbStyles: Record<
  WorldOriginManifestation["type"],
  CultivationOrbStyle
> = {
  division: "vortex",
  law: "orbit",
  energy: "plasma",
  authority: "solar",
  information: "corona",
  medium: "halo",
};

type OriginCanvasNodeData = {
  kind: "origin" | "manifestation" | "system";
  title: string;
  subtitle: string;
  badge: string;
  color: string;
  orbStyle: CultivationOrbStyle;
  connected?: boolean;
};
type OriginCanvasNode = Node<OriginCanvasNodeData, "originCanvas">;
type OriginCanvasEdgeData =
  | { kind: "relation"; relationId: string }
  | { kind: "projection"; systemId: string; sourceId: string };
type OriginCanvasEdge = Edge<OriginCanvasEdgeData>;

function OriginCanvasNodeView({ data, selected }: NodeProps<OriginCanvasNode>) {
  const style = { "--topology-node-color": data.color } as CSSProperties;
  return (
    <div
      className={`ce-origin-flow-node is-${data.kind} ${data.connected ? "is-connected" : ""} ${selected ? "is-selected" : ""}`}
      title={data.subtitle}
      style={style}
    >
      {data.kind === "system" ? (
        <>
          <span className="ce-origin-flow-node-icon">
            <Boxes className="h-4 w-4" />
          </span>
          <span className="ce-origin-flow-node-copy">
            <small>{data.badge}</small>
            <strong>{data.title}</strong>
            <em>{data.subtitle}</em>
          </span>
        </>
      ) : (
        <div className="ce-origin-orb-node">
          <OrbVisual orbStyle={data.orbStyle} className="ce-origin-orb" />
          <strong>{data.title}</strong>
          <small>{data.badge}</small>
        </div>
      )}
      {TOPOLOGY_HANDLE_POINTS.map((handle) => (
        <Handle
          key={handle.id}
          id={handle.id}
          type="source"
          position={handle.position}
          style={handle.style}
          isConnectable
          className="ce-origin-flow-handle"
        />
      ))}
    </div>
  );
}

const originCanvasNodeTypes = { originCanvas: OriginCanvasNodeView };

function buildOriginCanvasNodes(
  origin: WorldOrigin,
  systems: readonly CultivationSystem[],
): OriginCanvasNode[] {
  const positions = origin.canvasPositions ?? {};
  const positionFor = (id: string, fallback: { x: number; y: number }) =>
    positions[id] ?? fallback;
  const nodes: OriginCanvasNode[] = [
    {
      id: origin.id,
      type: "originCanvas",
      position: positionFor(origin.id, { x: 60, y: 300 }),
      data: {
        kind: "origin",
        title: origin.name,
        subtitle:
          origin.ontologyStatement || origin.summary || "本体陈述未定义",
        badge: `${origin.kind} · ${worldOriginStatusLabels[origin.status]}`,
        color: worldOriginStatusColors[origin.status],
        orbStyle: origin.orbStyle ?? worldOriginStatusOrbStyles[origin.status],
      },
      ariaLabel: `世界本源：${origin.name}`,
      deletable: false,
    },
  ];

  const typeCounters = new Map<WorldOriginManifestation["type"], number>();
  origin.manifestations.forEach((manifestation) => {
    const typeIndex = typeOrder.indexOf(manifestation.type);
    const itemIndex = typeCounters.get(manifestation.type) ?? 0;
    typeCounters.set(manifestation.type, itemIndex + 1);
    nodes.push({
      id: manifestation.id,
      type: "originCanvas",
      position: positionFor(manifestation.id, {
        x: 390 + typeIndex * 250,
        y: 70 + itemIndex * 130,
      }),
      data: {
        kind: "manifestation",
        title: manifestation.name,
        subtitle:
          manifestation.summary || manifestation.definition || "显化定义未填写",
        badge: manifestationTypeLabels[manifestation.type],
        color: manifestationTypeColors[manifestation.type],
        orbStyle:
          manifestation.orbStyle ??
          manifestationTypeOrbStyles[manifestation.type],
      },
      ariaLabel: `${manifestationTypeLabels[manifestation.type]}显化：${manifestation.name}`,
      deletable: false,
    });
  });

  const projectionX = 390 + typeOrder.length * 250;
  systems.forEach((system, index) => {
    const sourceCount =
      Number(system.projection.originIds.includes(origin.id)) +
      system.projection.manifestationIds.filter((id) =>
        origin.manifestations.some((item) => item.id === id),
      ).length;
    nodes.push({
      id: system.id,
      type: "originCanvas",
      position: positionFor(system.id, {
        x: projectionX,
        y: 70 + index * 140,
      }),
      data: {
        kind: "system",
        title: system.name,
        subtitle:
          sourceCount > 0
            ? `${sourceCount} 个本源入口 · ${system.projection.access || "接入方式未定义"}`
            : "拖入连线以建立体系投影",
        badge: sourceCount > 0 ? "已接入体系" : "待接入体系",
        color: sourceCount > 0 ? "var(--info)" : "var(--ink-muted)",
        orbStyle: "plasma",
        connected: sourceCount > 0,
      },
      ariaLabel: `修行体系：${system.name}`,
      deletable: false,
    });
  });

  return nodes;
}

function buildOriginCanvasEdges(
  origin: WorldOrigin,
  systems: readonly CultivationSystem[],
): OriginCanvasEdge[] {
  const localNodeIds = new Set([
    origin.id,
    ...origin.manifestations.map((item) => item.id),
  ]);
  const nodePositions = new Map(
    buildOriginCanvasNodes(origin, systems).map(
      (node) => [node.id, node.position] as const,
    ),
  );
  const handleToward = (sourceId: string, targetId: string) => ({
    sourceHandle: topologyHandleToward(
      nodePositions.get(sourceId) ?? { x: 0, y: 0 },
      nodePositions.get(targetId) ?? { x: 1, y: 0 },
    ),
    targetHandle: topologyHandleToward(
      nodePositions.get(targetId) ?? { x: 1, y: 0 },
      nodePositions.get(sourceId) ?? { x: 0, y: 0 },
    ),
  });
  const relationEdges: OriginCanvasEdge[] = origin.relations
    .filter(
      (relation) =>
        localNodeIds.has(relation.sourceId) &&
        localNodeIds.has(relation.targetId),
    )
    .map((relation) => {
      const automaticHandles = handleToward(
        relation.sourceId,
        relation.targetId,
      );
      return {
        id: `relation-${relation.id}`,
        source: relation.sourceId,
        target: relation.targetId,
        sourceHandle: relation.sourceHandleId ?? automaticHandles.sourceHandle,
        targetHandle: relation.targetHandleId ?? automaticHandles.targetHandle,
        type: "smoothstep",
        animated: true,
        className: "ce-origin-flow-edge is-relation",
        label: originRelationLabels[relation.relation],
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--warning)" },
        data: { kind: "relation", relationId: relation.id },
        style: { stroke: "var(--warning)", strokeWidth: 1.8 },
        labelStyle: {
          fill: "var(--ink)",
          fontSize: "var(--text-xs)",
          fontWeight: 650,
        },
        labelBgStyle: { fill: "var(--paper-elevated)", fillOpacity: 0.94 },
        labelBgPadding: [5, 3],
        labelBgBorderRadius: 3,
      };
    });
  const projectionEdges: OriginCanvasEdge[] = [];
  const pushProjectionEdge = (
    system: CultivationSystem,
    sourceId: string,
    label: string,
  ) => {
    const binding = system.projection.originBindings?.find(
      (candidate) => candidate.sourceId === sourceId,
    );
    const automaticHandles = handleToward(sourceId, system.id);
    projectionEdges.push({
      id: `projection-${sourceId}-${system.id}`,
      source: sourceId,
      target: system.id,
      sourceHandle: binding?.sourceHandleId ?? automaticHandles.sourceHandle,
      targetHandle: binding?.targetHandleId ?? automaticHandles.targetHandle,
      type: "smoothstep",
      animated: true,
      className: "ce-origin-flow-edge is-projection",
      label,
      markerEnd: { type: MarkerType.ArrowClosed, color: "var(--info)" },
      data: { kind: "projection", systemId: system.id, sourceId },
      style: {
        stroke: "var(--info)",
        strokeDasharray: "6 5",
        strokeWidth: 1.5,
      },
      labelStyle: {
        fill: "var(--ink)",
        fontSize: "var(--text-xs)",
        fontWeight: 650,
      },
      labelBgStyle: { fill: "var(--paper-elevated)", fillOpacity: 0.94 },
      labelBgPadding: [5, 3],
      labelBgBorderRadius: 3,
    });
  };
  systems.forEach((system) => {
    if (system.projection.originIds.includes(origin.id)) {
      pushProjectionEdge(system, origin.id, "投影");
    }
    origin.manifestations.forEach((manifestation) => {
      if (!system.projection.manifestationIds.includes(manifestation.id))
        return;
      pushProjectionEdge(system, manifestation.id, "接入");
    });
  });
  return [...relationEdges, ...projectionEdges];
}

function WorldOriginCanvasEditor({
  ecology,
  origin,
  onChange,
  onSelect,
  onAddManifestation,
}: {
  ecology: CultivationEcology;
  origin: WorldOrigin;
  onChange: (ecology: CultivationEcology) => void;
  onSelect: (selection: Selection) => void;
  onAddManifestation: (type: WorldOriginManifestation["type"]) => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<OriginCanvasNode>(
    buildOriginCanvasNodes(origin, ecology.systems),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<OriginCanvasEdge>(
    buildOriginCanvasEdges(origin, ecology.systems),
  );
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<
    OriginCanvasNode,
    OriginCanvasEdge
  > | null>(null);
  const reconnectingEdgeRef = useRef<OriginCanvasEdge | null>(null);

  // 画布只随本源结构与体系投影相关内容变化而重建，避免编辑无关字段触发全量重绘。
  const originCanvasSignature = JSON.stringify({
    origin: {
      id: origin.id,
      kind: origin.kind,
      name: origin.name,
      summary: origin.summary,
      ontologyStatement: origin.ontologyStatement,
      orbStyle: origin.orbStyle,
      status: origin.status,
      canvasPositions: origin.canvasPositions,
      manifestations: origin.manifestations,
      relations: origin.relations,
    },
    systems: ecology.systems.map((system) => ({
      id: system.id,
      name: system.name,
      projection: system.projection,
    })),
  });

  useEffect(() => {
    setNodes(buildOriginCanvasNodes(origin, ecology.systems));
    setEdges(buildOriginCanvasEdges(origin, ecology.systems));
    // 依赖使用内容签名，见 originCanvasSignature。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originCanvasSignature, setEdges, setNodes]);

  const localNodeIds = new Set([
    origin.id,
    ...origin.manifestations.map((item) => item.id),
  ]);
  const systemIds = new Set(ecology.systems.map((system) => system.id));
  const nodeName = (id: string) =>
    id === origin.id
      ? origin.name
      : (origin.manifestations.find((item) => item.id === id)?.name ?? id);

  const persistPositions = (nextNodes: readonly OriginCanvasNode[]) => {
    const canvasPositions = Object.fromEntries(
      nextNodes.map((node) => [
        node.id,
        { x: node.position.x, y: node.position.y },
      ]),
    );
    onChange({
      ...ecology,
      worldOrigins: updateById(ecology.worldOrigins, origin.id, (current) => ({
        ...current,
        canvasPositions,
      })),
    });
  };

  const handleAutoLayout = () => {
    const layoutedNodes = buildOriginCanvasNodes(
      { ...origin, canvasPositions: {} },
      ecology.systems,
    );
    setNodes(layoutedNodes);
    persistPositions(layoutedNodes);
    window.setTimeout(() => {
      void flowInstance?.fitView({ padding: 0.16, duration: 240 });
    }, 0);
  };

  const handleNodeDragStop = (_event: unknown, node: OriginCanvasNode) => {
    onChange({
      ...ecology,
      worldOrigins: updateById(ecology.worldOrigins, origin.id, (current) => ({
        ...current,
        canvasPositions: {
          ...(current.canvasPositions ?? {}),
          [node.id]: { x: node.position.x, y: node.position.y },
        },
      })),
    });
  };

  const handleNodeClick = (_event: unknown, node: OriginCanvasNode) => {
    if (node.data.kind === "origin") {
      onSelect({ kind: "world-origin", id: origin.id });
      return;
    }
    if (node.data.kind === "manifestation") {
      onSelect({
        kind: "manifestation",
        id: node.id,
        parentId: origin.id,
        parentKind: "world-origin",
      });
      return;
    }
    onSelect({
      kind: "origin-projection",
      id: node.id,
      parentId: origin.id,
      parentKind: "world-origin",
    });
  };

  const isValidConnection = (connection: Connection | OriginCanvasEdge) => {
    const source = connection.source;
    const target = connection.target;
    if (!source || !target || source === target || !localNodeIds.has(source))
      return false;
    const reconnectingEdge = reconnectingEdgeRef.current;
    if (localNodeIds.has(target)) {
      if (reconnectingEdge?.data?.kind === "projection") return false;
      const reconnectingRelationId =
        reconnectingEdge?.data?.kind === "relation"
          ? reconnectingEdge.data.relationId
          : null;
      return !origin.relations.some(
        (relation) =>
          relation.id !== reconnectingRelationId &&
          relation.sourceId === source &&
          relation.targetId === target,
      );
    }
    if (!systemIds.has(target)) return false;
    if (reconnectingEdge?.data?.kind === "relation") return false;
    const system = ecology.systems.find((candidate) => candidate.id === target);
    if (!system) return false;
    const isCurrentProjection =
      reconnectingEdge?.data?.kind === "projection" &&
      reconnectingEdge.data.systemId === target &&
      reconnectingEdge.data.sourceId === source;
    const alreadyProjected =
      (source === origin.id
        ? system.projection.originIds.includes(source)
        : system.projection.manifestationIds.includes(source)) ||
      (system.projection.originBindings?.some(
        (binding) => binding.sourceId === source,
      ) ??
        false);
    return isCurrentProjection || !alreadyProjected;
  };

  const handleConnect = (connection: Connection) => {
    const source = connection.source;
    const target = connection.target;
    if (!source || !target || !isValidConnection(connection)) return;
    if (systemIds.has(target)) {
      const sourceIsOrigin = source === origin.id;
      onChange({
        ...ecology,
        systems: ecology.systems.map((system) => {
          if (system.id !== target) return system;
          const bindings = system.projection.originBindings ?? [];
          const bindingRole: "primary" | "manifestation" = sourceIsOrigin
            ? "primary"
            : "manifestation";
          return {
            ...system,
            projection: {
              ...system.projection,
              originIds: sourceIsOrigin
                ? [...system.projection.originIds, source]
                : system.projection.originIds,
              manifestationIds: sourceIsOrigin
                ? system.projection.manifestationIds
                : [...system.projection.manifestationIds, source],
              originBindings: bindings.some(
                (binding) => binding.sourceId === source,
              )
                ? bindings
                : [
                    ...bindings,
                    {
                      sourceId: source,
                      sourceHandleId: connection.sourceHandle ?? undefined,
                      targetHandleId: connection.targetHandle ?? undefined,
                      role: bindingRole,
                      purpose: "",
                      weight: "",
                      sideEffects: [],
                    },
                  ],
            },
          };
        }),
      });
      onSelect({
        kind: "origin-projection",
        id: target,
        parentId: origin.id,
        parentKind: "world-origin",
      });
      return;
    }

    const relationType: WorldOriginRelation["relation"] =
      source === origin.id ? "manifest" : "generate";
    const relation: WorldOriginRelation = {
      id: newEcologyId("origin-relation"),
      name: `${nodeName(source)}${originRelationLabels[relationType]}${nodeName(target)}`,
      summary: "",
      sourceId: source,
      targetId: target,
      sourceHandleId: connection.sourceHandle ?? undefined,
      targetHandleId: connection.targetHandle ?? undefined,
      relation: relationType,
      conditions: [],
      cost: "",
      loss: "",
    };
    onChange({
      ...ecology,
      worldOrigins: updateById(ecology.worldOrigins, origin.id, (current) => ({
        ...current,
        relations: [...current.relations, relation],
      })),
    });
    onSelect({
      kind: "origin-relation",
      id: relation.id,
      parentId: origin.id,
      parentKind: "world-origin",
    });
  };

  const handleReconnect = (
    oldEdge: OriginCanvasEdge,
    connection: Connection,
  ) => {
    const source = connection.source;
    const target = connection.target;
    if (!source || !target || !isValidConnection(connection) || !oldEdge.data)
      return;
    setEdges((current) => reconnectEdge(oldEdge, connection, current));

    if (oldEdge.data.kind === "relation") {
      onChange({
        ...ecology,
        worldOrigins: updateById(
          ecology.worldOrigins,
          origin.id,
          (current) => ({
            ...current,
            relations: updateById(
              current.relations,
              oldEdge.data?.kind === "relation" ? oldEdge.data.relationId : "",
              (relation) => ({
                ...relation,
                sourceId: source,
                targetId: target,
                sourceHandleId: connection.sourceHandle ?? undefined,
                targetHandleId: connection.targetHandle ?? undefined,
              }),
            ),
          }),
        ),
      });
      return;
    }

    const oldSystemId = oldEdge.data.systemId;
    const oldSourceId = oldEdge.data.sourceId;
    const oldSystem = ecology.systems.find(
      (system) => system.id === oldSystemId,
    );
    const previousBinding = oldSystem?.projection.originBindings?.find(
      (binding) => binding.sourceId === oldSourceId,
    );
    const sourceIsOrigin = source === origin.id;
    const bindingRole: OriginBinding["role"] = sourceIsOrigin
      ? previousBinding?.role === "secondary"
        ? "secondary"
        : "primary"
      : "manifestation";
    onChange({
      ...ecology,
      systems: ecology.systems.map((system) => {
        const removesOldProjection = system.id === oldSystemId;
        const addsNewProjection = system.id === target;
        if (!removesOldProjection && !addsNewProjection) return system;

        let originIds = system.projection.originIds;
        let manifestationIds = system.projection.manifestationIds;
        let originBindings = system.projection.originBindings ?? [];
        if (removesOldProjection) {
          originIds = originIds.filter((id) => id !== oldSourceId);
          manifestationIds = manifestationIds.filter(
            (id) => id !== oldSourceId,
          );
          originBindings = originBindings.filter(
            (binding) => binding.sourceId !== oldSourceId,
          );
        }
        if (addsNewProjection) {
          originIds = sourceIsOrigin
            ? Array.from(new Set([...originIds, source]))
            : originIds.filter((id) => id !== source);
          manifestationIds = sourceIsOrigin
            ? manifestationIds.filter((id) => id !== source)
            : Array.from(new Set([...manifestationIds, source]));
          originBindings = [
            ...originBindings.filter((binding) => binding.sourceId !== source),
            {
              sourceId: source,
              sourceHandleId: connection.sourceHandle ?? undefined,
              targetHandleId: connection.targetHandle ?? undefined,
              role: bindingRole,
              purpose: previousBinding?.purpose ?? "",
              weight: previousBinding?.weight ?? "",
              sideEffects: previousBinding?.sideEffects ?? [],
            },
          ];
        }
        return {
          ...system,
          projection: {
            ...system.projection,
            originIds,
            manifestationIds,
            originBindings,
          },
        };
      }),
    });
  };

  const handleEdgesDelete = (deletedEdges: OriginCanvasEdge[]) => {
    const relationIds = new Set(
      deletedEdges.flatMap((edge) =>
        edge.data?.kind === "relation" ? [edge.data.relationId] : [],
      ),
    );
    const projectionSources = new Map<string, Set<string>>();
    deletedEdges.forEach((edge) => {
      if (edge.data?.kind !== "projection") return;
      const sources = projectionSources.get(edge.data.systemId) ?? new Set();
      sources.add(edge.data.sourceId);
      projectionSources.set(edge.data.systemId, sources);
    });
    onChange({
      ...ecology,
      worldOrigins: updateById(ecology.worldOrigins, origin.id, (current) => ({
        ...current,
        relations: current.relations.filter(
          (relation) => !relationIds.has(relation.id),
        ),
      })),
      systems: ecology.systems.map((system) => {
        const sources = projectionSources.get(system.id);
        if (!sources) return system;
        return {
          ...system,
          projection: {
            ...system.projection,
            originIds: system.projection.originIds.filter(
              (id) => !sources.has(id),
            ),
            manifestationIds: system.projection.manifestationIds.filter(
              (id) => !sources.has(id),
            ),
            originBindings: system.projection.originBindings?.filter(
              (binding) => !sources.has(binding.sourceId),
            ),
          },
        };
      }),
    });
    onSelect(null);
  };

  const handleEdgeClick = (_event: unknown, edge: OriginCanvasEdge) => {
    if (edge.data?.kind === "relation") {
      onSelect({
        kind: "origin-relation",
        id: edge.data.relationId,
        parentId: origin.id,
        parentKind: "world-origin",
      });
      return;
    }
    if (edge.data?.kind === "projection") {
      onSelect({
        kind: "origin-projection",
        id: edge.data.systemId,
        parentId: origin.id,
        parentKind: "world-origin",
      });
    }
  };

  return (
    <section className="ce-origin-flow-editor" aria-label="世界本源关系画布">
      <div className="ce-origin-flow-toolbar">
        <div className="ce-origin-flow-additions">
          {typeOrder.map((type) => (
            <Button
              key={type}
              variant="ghost"
              onClick={() => onAddManifestation(type)}
              title={`新增${manifestationTypeLabels[type]}显化节点`}
            >
              <Plus className="h-3.5 w-3.5" />
              {manifestationTypeLabels[type]}
            </Button>
          ))}
        </div>
        <Button variant="secondary" onClick={handleAutoLayout}>
          <Route className="h-3.5 w-3.5" />
          自动布局
        </Button>
      </div>
      <div className="ce-origin-flow-surface">
        <ReactFlow<OriginCanvasNode, OriginCanvasEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={originCanvasNodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          onEdgeClick={handleEdgeClick}
          onNodeDragStop={handleNodeDragStop}
          onConnect={handleConnect}
          onReconnect={handleReconnect}
          onReconnectStart={(_event, edge) => {
            reconnectingEdgeRef.current = edge;
          }}
          onReconnectEnd={() => {
            reconnectingEdgeRef.current = null;
          }}
          onEdgesDelete={handleEdgesDelete}
          isValidConnection={isValidConnection}
          connectionMode={ConnectionMode.Loose}
          connectionLineType={ConnectionLineType.Bezier}
          connectionRadius={30}
          connectionDragThreshold={0}
          edgesReconnectable
          reconnectRadius={30}
          connectOnClick
          onInit={setFlowInstance}
          fitView
          fitViewOptions={{ padding: 0.16 }}
          minZoom={0.2}
          maxZoom={1.8}
          snapToGrid
          snapGrid={[20, 20]}
          deleteKeyCode={["Backspace", "Delete"]}
          defaultEdgeOptions={{ type: "smoothstep" }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1.2}
            color="var(--line-strong)"
          />
          <MiniMap
            pannable
            zoomable
            nodeStrokeWidth={3}
            nodeColor={(node) =>
              (node.data as OriginCanvasNodeData).color ?? "var(--ink-muted)"
            }
          />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <div className="ce-origin-flow-legend" aria-hidden="true">
        <span className="is-relation">本源关系</span>
        <span className="is-projection">体系投影</span>
        <small>拖动节点调整位置，从节点右侧连接点拖线到目标节点</small>
      </div>
    </section>
  );
}

function WorldOriginStructureView({
  origin,
  systems,
  onSelect,
  onAddManifestation,
}: {
  origin: WorldOrigin;
  systems: readonly CultivationSystem[];
  onSelect: (selection: Selection) => void;
  onAddManifestation: (type: WorldOriginManifestation["type"]) => void;
}) {
  const byType = new Map(
    typeOrder.map((type) => [
      type,
      origin.manifestations.filter((item) => item.type === type),
    ]),
  );

  return (
    <div className="ce-origin-structure-view">
      <div className="ce-world-origin-layers">
        <div className="ce-world-origin-layer ce-world-origin-layer-ontology">
          <span className="ce-world-origin-layer-label">本体层</span>
          <p>
            {origin.ontologyStatement || origin.summary || "尚未填写本体陈述"}
          </p>
        </div>
        <div className="ce-world-origin-layer">
          <span className="ce-world-origin-layer-label">分化与显化层</span>
          <div className="ce-world-origin-manifestation-grid">
            {typeOrder.map((type) => {
              const items = byType.get(type) ?? [];
              return (
                <div
                  className={`ce-world-origin-type-group type-${type}`}
                  key={type}
                >
                  <div className="ce-world-origin-type-head">
                    <span>{manifestationTypeLabels[type]}</span>
                    <button
                      type="button"
                      onClick={() => onAddManifestation(type)}
                      title={`新增${manifestationTypeLabels[type]}显化节点`}
                      aria-label={`新增${manifestationTypeLabels[type]}显化节点`}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {items.length === 0 ? (
                    <small>未定义</small>
                  ) : (
                    items.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        onClick={() =>
                          onSelect({
                            kind: "manifestation",
                            id: item.id,
                            parentId: origin.id,
                            parentKind: "world-origin",
                          })
                        }
                      >
                        <strong>{item.name}</strong>
                        <small>
                          {item.summary || item.definition || "点击编辑显化"}
                        </small>
                      </button>
                    ))
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="ce-world-origin-layer ce-world-origin-projection-layer">
          <span className="ce-world-origin-layer-label">修行体系投影层</span>
          <div className="ce-world-origin-projections">
            {systems.length === 0 ? (
              <span className="ce-world-origin-muted">
                尚无修行体系接入这个世界本源
              </span>
            ) : (
              systems.map((system) => (
                <button
                  type="button"
                  key={system.id}
                  onClick={() =>
                    onSelect({
                      kind: "origin-projection",
                      id: system.id,
                      parentId: origin.id,
                      parentKind: "world-origin",
                    })
                  }
                >
                  <Boxes className="h-4 w-4" />
                  <span>
                    <strong>{system.name}</strong>
                    <small>
                      {
                        system.projection.manifestationIds.filter((id) =>
                          origin.manifestations.some((item) => item.id === id),
                        ).length
                      }{" "}
                      个显化入口 ·{" "}
                      {system.projection.access || "接入方式未定义"}
                    </small>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
      <div className="ce-world-origin-footer">
        <div>
          <span>作用域</span>
          <strong>{origin.scopes.join("、") || "未定义"}</strong>
        </div>
        <div>
          <span>约束</span>
          <strong>{origin.constraints.length} 条</strong>
        </div>
        <div>
          <span>关系</span>
          <strong>{origin.relations.length} 条</strong>
        </div>
      </div>
      <div className="ce-world-origin-relations">
        <span className="ce-world-origin-relations-title">结构关系</span>
        {origin.relations.map((relation) => (
          <button
            type="button"
            key={relation.id}
            onClick={() =>
              onSelect({
                kind: "origin-relation",
                id: relation.id,
                parentId: origin.id,
                parentKind: "world-origin",
              })
            }
          >
            <span>
              {origin.manifestations.find(
                (item) => item.id === relation.sourceId,
              )?.name || origin.name}
            </span>
            <ChevronRight className="h-3.5 w-3.5" />
            <em>{originRelationLabels[relation.relation]}</em>
            <ChevronRight className="h-3.5 w-3.5" />
            <span>
              {origin.manifestations.find(
                (item) => item.id === relation.targetId,
              )?.name ||
                (relation.targetId === origin.id
                  ? origin.name
                  : relation.targetId)}
            </span>
          </button>
        ))}
        {origin.relations.length === 0 && (
          <span className="ce-world-origin-muted">尚未定义结构关系</span>
        )}
      </div>
    </div>
  );
}

function WorldOriginWorkspace({
  ecology,
  selection,
  onChange,
  onSelect,
}: {
  ecology: CultivationEcology;
  selection: Selection;
  onChange: (ecology: CultivationEcology) => void;
  onSelect: (selection: Selection) => void;
}) {
  const [view, setView] = useState<"overview" | "origin">("overview");
  const [originViewMode, setOriginViewMode] = useState<"structure" | "canvas">(
    "canvas",
  );

  const addOrigin = () => {
    const item: WorldOrigin = {
      id: newEcologyId("world-origin"),
      name: "新世界本源",
      summary: "",
      kind: "复合本源",
      ontologyStatement: "",
      status: "incomplete",
      orbStyle: "orbit",
      scopes: [],
      constraints: [],
      manifestations: [],
      relations: [],
      canvasPositions: {},
    };
    onChange({ ...ecology, worldOrigins: [...ecology.worldOrigins, item] });
    onSelect({ kind: "world-origin", id: item.id });
    setView("origin");
  };
  const addManifestation = (
    origin: WorldOrigin,
    type: WorldOriginManifestation["type"] = "law",
  ) => {
    const item: WorldOriginManifestation = {
      id: newEcologyId("manifestation"),
      name: `新${manifestationTypeLabels[type]}显化节点`,
      summary: "",
      type,
      orbStyle: manifestationTypeOrbStyles[type],
      definition: "",
      sourceId: origin.id,
      scope: "",
      access: "",
      generation: "",
      conversion: "",
      risks: [],
    };
    const relation: WorldOriginRelation = {
      id: newEcologyId("origin-relation"),
      name: `${origin.name}显化${item.name}`,
      summary: "",
      sourceId: origin.id,
      targetId: item.id,
      relation: "manifest",
      conditions: [],
      cost: "",
      loss: "",
    };
    onChange({
      ...ecology,
      worldOrigins: updateById(ecology.worldOrigins, origin.id, (current) => ({
        ...current,
        manifestations: [...current.manifestations, item],
        relations: [...current.relations, relation],
      })),
    });
    onSelect({
      kind: "manifestation",
      id: item.id,
      parentId: origin.id,
      parentKind: "world-origin",
    });
  };
  const systemsUsing = (origin: WorldOrigin) =>
    ecology.systems.filter(
      (system) =>
        system.projection.originIds.includes(origin.id) ||
        system.projection.manifestationIds.some((id) =>
          origin.manifestations.some((item) => item.id === id),
        ),
    );
  const selectedOriginId =
    selection?.kind === "world-origin"
      ? selection.id
      : selection?.parentKind === "world-origin"
        ? selection.parentId
        : undefined;
  const origin =
    ecology.worldOrigins.find(
      (candidate) => candidate.id === selectedOriginId,
    ) ?? ecology.worldOrigins[0];
  const systems = origin ? systemsUsing(origin) : [];
  const auditIssues = (origin ? [origin] : []).flatMap((origin) => {
    const issues: Array<{
      id: string;
      severity: "error" | "warning";
      title: string;
      message: string;
      selection: Selection;
    }> = [];
    if (!origin.ontologyStatement.trim())
      issues.push({
        id: `${origin.id}-ontology`,
        severity: "warning",
        title: "本体陈述未填写",
        message: `${origin.name} 还没有说明世界本源的存在论结构。`,
        selection: { kind: "world-origin", id: origin.id },
      });
    if (origin.scopes.length === 0)
      issues.push({
        id: `${origin.id}-scope`,
        severity: "warning",
        title: "作用域未定义",
        message: `${origin.name} 没有声明在哪些世界、地域或条件下生效。`,
        selection: { kind: "world-origin", id: origin.id },
      });
    origin.manifestations.forEach((manifestation) => {
      if (!manifestation.definition.trim())
        issues.push({
          id: `${manifestation.id}-definition`,
          severity: "warning",
          title: "显化定义缺失",
          message: `${manifestation.name} 还没有定义其如何进入世界。`,
          selection: {
            kind: "manifestation",
            id: manifestation.id,
            parentId: origin.id,
            parentKind: "world-origin",
          },
        });
    });
    origin.relations.forEach((relation) => {
      const nodeIds = new Set([
        origin.id,
        ...origin.manifestations.map((manifestation) => manifestation.id),
      ]);
      if (!nodeIds.has(relation.sourceId) || !nodeIds.has(relation.targetId))
        issues.push({
          id: `${relation.id}-endpoint`,
          severity: "error",
          title: "本源关系端点失效",
          message: `${relation.name} 指向了不存在的本源节点。`,
          selection: {
            kind: "origin-relation",
            id: relation.id,
            parentId: origin.id,
            parentKind: "world-origin",
          },
        });
    });
    return issues;
  });
  const manifestationCount = ecology.worldOrigins.reduce(
    (total, candidate) => total + candidate.manifestations.length,
    0,
  );
  const relationCount = ecology.worldOrigins.reduce(
    (total, candidate) => total + candidate.relations.length,
    0,
  );
  const projectionSystemCount = ecology.systems.filter(
    (system) =>
      system.projection.originIds.length > 0 ||
      system.projection.manifestationIds.length > 0,
  ).length;
  const stableOriginCount = ecology.worldOrigins.filter(
    (candidate) => candidate.status === "stable",
  ).length;
  const openOriginView = () => {
    setView("origin");
    if (!selection && origin) {
      onSelect({ kind: "world-origin", id: origin.id });
    }
  };
  return (
    <div className="ce-world-origin-workspace">
      <div
        className="ce-world-origin-tabbar"
        role="tablist"
        aria-label="世界本源页面"
      >
        <button
          type="button"
          role="tab"
          aria-selected={view === "overview"}
          className={view === "overview" ? "is-active" : ""}
          onClick={() => setView("overview")}
        >
          <Compass className="h-3.5 w-3.5" />
          总览
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "origin"}
          className={view === "origin" ? "is-active" : ""}
          onClick={openOriginView}
        >
          <Sparkles className="h-3.5 w-3.5" />
          本源
        </button>
      </div>
      {view === "overview" ? (
        <section className="ce-world-origin-overview" role="tabpanel">
          <div className="ce-world-origin-overview-head">
            <div>
              <span className="ce-eyebrow">世界本源总览</span>
              <h2>世界的本体、显化与投影</h2>
              <p>
                从整体查看世界本源的定义规模、结构状态，以及修炼体系的接入情况。
              </p>
            </div>
            <Button variant="primary" onClick={openOriginView}>
              <Sparkles className="h-3.5 w-3.5" />
              查看本源
            </Button>
          </div>
          <div className="ce-world-origin-overview-stats">
            <div>
              <span>世界本源</span>
              <strong>{ecology.worldOrigins.length}</strong>
              <small>{stableOriginCount} 个结构稳定</small>
            </div>
            <div>
              <span>显化节点</span>
              <strong>{manifestationCount}</strong>
              <small>分化、法则与能量等表现</small>
            </div>
            <div>
              <span>结构关系</span>
              <strong>{relationCount}</strong>
              <small>本源之间的生成与约束</small>
            </div>
            <div>
              <span>投影体系</span>
              <strong>{projectionSystemCount}</strong>
              <small>已接入修炼体系</small>
            </div>
          </div>
          <div className="ce-world-origin-overview-grid">
            <section className="ce-world-origin-overview-section">
              <div className="ce-world-origin-overview-section-head">
                <div>
                  <span className="ce-eyebrow">本源清单</span>
                  <strong>已定义的世界本源</strong>
                </div>
                <span>{ecology.worldOrigins.length} 个</span>
              </div>
              {ecology.worldOrigins.length === 0 ? (
                <div className="ce-world-origin-overview-empty">
                  尚未建立世界本源，进入“本源”页创建第一个本体定义。
                </div>
              ) : (
                <div className="ce-world-origin-overview-list">
                  {ecology.worldOrigins.map((candidate) => (
                    <button
                      type="button"
                      key={candidate.id}
                      onClick={() => {
                        onSelect({ kind: "world-origin", id: candidate.id });
                        setView("origin");
                      }}
                    >
                      <span className="ce-world-origin-overview-list-icon">
                        <Sparkles className="h-4 w-4" />
                      </span>
                      <span>
                        <strong>{candidate.name}</strong>
                        <small>
                          {candidate.kind} · {candidate.manifestations.length}{" "}
                          个显化
                        </small>
                      </span>
                      <em>
                        {candidate.status === "stable" ? "稳定" : "待完善"}
                      </em>
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  ))}
                </div>
              )}
            </section>
            <section className="ce-world-origin-overview-section ce-world-origin-overview-section-guide">
              <div className="ce-world-origin-overview-section-head">
                <div>
                  <span className="ce-eyebrow">结构阅读</span>
                  <strong>从本体到修行体系</strong>
                </div>
              </div>
              <div className="ce-world-origin-overview-flow">
                <div>
                  <span>01</span>
                  <strong>本体层</strong>
                  <small>定义世界为何存在，以及它的根本陈述。</small>
                </div>
                <ChevronRight className="h-4 w-4" />
                <div>
                  <span>02</span>
                  <strong>显化层</strong>
                  <small>查看法则、能量、信息和载体如何进入世界。</small>
                </div>
                <ChevronRight className="h-4 w-4" />
                <div>
                  <span>03</span>
                  <strong>投影层</strong>
                  <small>确认修炼体系如何翻译并接入这些本源。</small>
                </div>
              </div>
              <button
                type="button"
                className="ce-world-origin-overview-link"
                onClick={openOriginView}
              >
                进入本源结构画布
                <ChevronRight className="h-4 w-4" />
              </button>
            </section>
          </div>
        </section>
      ) : (
        <div className="ce-world-origin-layout">
          <aside className="ce-world-origin-directory">
            <div className="ce-world-origin-directory-head">
              <div>
                <span className="ce-eyebrow">本源目录</span>
                <strong>{ecology.worldOrigins.length} 个世界本源</strong>
              </div>
              <Button variant="ghost" onClick={addOrigin} title="新增世界本源">
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="ce-world-origin-directory-list">
              {ecology.worldOrigins.map((candidate) => {
                const candidateSystems = systemsUsing(candidate);
                return (
                  <button
                    type="button"
                    key={candidate.id}
                    className={candidate.id === origin?.id ? "is-active" : ""}
                    onClick={() =>
                      onSelect({ kind: "world-origin", id: candidate.id })
                    }
                  >
                    <span className="ce-world-origin-directory-icon">
                      <Sparkles className="h-4 w-4" />
                    </span>
                    <span>
                      <strong>{candidate.name}</strong>
                      <small>
                        {candidate.kind} · {candidate.manifestations.length}{" "}
                        个显化
                      </small>
                    </span>
                    <em>{candidateSystems.length}</em>
                  </button>
                );
              })}
            </div>
            {ecology.worldOrigins.length === 0 && (
              <div className="ce-world-origin-directory-empty">
                尚未建立世界本源
              </div>
            )}
          </aside>
          <div className="ce-world-origin-canvas">
            {origin ? (
              <section className="ce-world-origin-panel" key={origin.id}>
                <div className="ce-world-origin-panel-head">
                  <button
                    type="button"
                    className="ce-world-origin-core"
                    onClick={() =>
                      onSelect({ kind: "world-origin", id: origin.id })
                    }
                  >
                    <Sparkles className="h-5 w-5" />
                    <span>
                      <strong>{origin.name}</strong>
                      <small>
                        {origin.kind} ·{" "}
                        {origin.status === "stable"
                          ? "稳定"
                          : origin.status === "incomplete"
                            ? "待完善"
                            : origin.status === "fragmented"
                              ? "分裂"
                              : "不稳定"}
                      </small>
                    </span>
                  </button>
                  <div className="ce-world-origin-panel-actions">
                    <span>{origin.manifestations.length} 个显化</span>
                    <span>{systems.length} 个投影体系</span>
                    <div
                      className="ce-origin-view-switch"
                      role="group"
                      aria-label="本源内容视图"
                    >
                      <button
                        type="button"
                        aria-pressed={originViewMode === "structure"}
                        className={
                          originViewMode === "structure" ? "is-active" : ""
                        }
                        onClick={() => setOriginViewMode("structure")}
                        title="结构视图"
                      >
                        <Layers3 className="h-3.5 w-3.5" />
                        结构
                      </button>
                      <button
                        type="button"
                        aria-pressed={originViewMode === "canvas"}
                        className={
                          originViewMode === "canvas" ? "is-active" : ""
                        }
                        onClick={() => setOriginViewMode("canvas")}
                        title="画布视图"
                      >
                        <Waypoints className="h-3.5 w-3.5" />
                        画布
                      </button>
                    </div>
                    <Button
                      variant="ghost"
                      onClick={() => addManifestation(origin)}
                      title="新增本源显化"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {originViewMode === "structure" ? (
                  <WorldOriginStructureView
                    origin={origin}
                    systems={systems}
                    onSelect={onSelect}
                    onAddManifestation={(type) =>
                      addManifestation(origin, type)
                    }
                  />
                ) : (
                  <WorldOriginCanvasEditor
                    ecology={ecology}
                    origin={origin}
                    onChange={onChange}
                    onSelect={onSelect}
                    onAddManifestation={(type) =>
                      addManifestation(origin, type)
                    }
                  />
                )}
              </section>
            ) : (
              <Empty text="尚未定义世界本源" />
            )}
            {auditIssues.length > 0 && (
              <section className="ce-world-origin-audit">
                <div>
                  <span className="ce-world-origin-layer-label">
                    影响与审查
                  </span>
                  <strong>{auditIssues.length} 项待处理</strong>
                </div>
                <div className="ce-world-origin-audit-list">
                  {auditIssues.slice(0, 6).map((issue) => (
                    <button
                      type="button"
                      key={issue.id}
                      onClick={() => onSelect(issue.selection)}
                    >
                      <span
                        className={`ce-severity ce-severity-${issue.severity}`}
                      >
                        {issue.severity === "error" ? "错误" : "警告"}
                      </span>
                      <span>
                        <strong>{issue.title}</strong>
                        <small>{issue.message}</small>
                      </span>
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Relations({
  ecology,
  onChange,
  onSelect,
}: {
  ecology: CultivationEcology;
  onChange: (ecology: CultivationEcology) => void;
  onSelect: (selection: Selection) => void;
}) {
  const [relationFilter, setRelationFilter] = useState("all");
  const relationTypes = [
    "兼容",
    "克制",
    "转换",
    "依赖",
    "继承",
    "污染",
    "冲突",
  ] as const;
  const add = () => {
    if (ecology.systems.length < 2) return;
    const source = ecology.systems[0]?.id ?? "";
    const target = ecology.systems[1]?.id ?? "";
    const item = {
      id: newEcologyId("relation"),
      name: "新跨体系关系",
      summary: "",
      sourceSystemId: source,
      targetSystemId: target,
      relation: "兼容" as const,
      conversionRule: "",
      conditions: [],
      risk: "",
    };
    onChange({
      ...ecology,
      crossSystemRelations: [...ecology.crossSystemRelations, item],
    });
    onSelect({ kind: "relation", id: item.id });
  };
  const names = new Map(ecology.systems.map((item) => [item.id, item.name]));
  const visibleRelations =
    relationFilter === "all"
      ? ecology.crossSystemRelations
      : ecology.crossSystemRelations.filter(
          (item) => item.relation === relationFilter,
        );
  const connectedSystemCount = new Set(
    ecology.crossSystemRelations.flatMap((item) => [
      item.sourceSystemId,
      item.targetSystemId,
    ]),
  ).size;
  const riskRelationCount = ecology.crossSystemRelations.filter((item) =>
    ["克制", "污染", "冲突"].includes(item.relation),
  ).length;
  return (
    <>
      <PageHeader
        eyebrow="项目全局 / 跨体系"
        title="跨体系关系"
        description="只在这里管理体系之间的兼容、克制、转换、依赖、继承、污染与冲突；体系内部的运行拓扑不属于全局关系。"
        action={
          <Button
            variant="primary"
            onClick={add}
            disabled={ecology.systems.length < 2}
            title={
              ecology.systems.length < 2
                ? "至少需要两个修行体系才能创建跨体系关系"
                : undefined
            }
          >
            <Plus className="h-3.5 w-3.5" />
            新增关系
          </Button>
        }
      />
      <div className="ce-relation-overview" aria-label="跨体系关系概况">
        <div>
          <strong>{ecology.crossSystemRelations.length}</strong>
          <span>关系总数</span>
        </div>
        <div>
          <strong>{connectedSystemCount}</strong>
          <span>已连接体系</span>
        </div>
        <div>
          <strong>{riskRelationCount}</strong>
          <span>风险关系</span>
        </div>
        <div className="ce-relation-filter">
          <span>关系类型</span>
          <CustomSelect
            value={relationFilter}
            options={[
              { value: "all", label: "全部类型" },
              ...relationTypes.map((relation) => ({
                value: relation,
                label: relation,
              })),
            ]}
            onChange={setRelationFilter}
            ariaLabel="筛选跨体系关系类型"
            className="ce-inline-select"
            size="toolbar"
          />
        </div>
      </div>
      <div className="ce-relation-list">
        {visibleRelations.map((item) => (
          <button
            type="button"
            className="ce-relation-row"
            key={item.id}
            aria-label={`查看关系：${item.name}`}
            onClick={() => onSelect({ kind: "relation", id: item.id })}
          >
            <span className="ce-relation-route">
              <span className="ce-relation-system">
                {names.get(item.sourceSystemId) || item.sourceSystemId}
              </span>
              <ChevronRight className="h-3.5 w-3.5" />
              <span className="ce-relation-type">{item.relation}</span>
              <ChevronRight className="h-3.5 w-3.5" />
              <span className="ce-relation-system">
                {names.get(item.targetSystemId) || item.targetSystemId}
              </span>
            </span>
            <span className="ce-relation-summary">
              <strong>{item.name}</strong>
              <small>
                {item.conversionRule || item.summary || "尚未描述转换规则"}
              </small>
            </span>
            <ChevronRight className="ce-relation-open h-4 w-4" />
          </button>
        ))}
      </div>
      {visibleRelations.length === 0 && (
        <Empty
          text={
            ecology.crossSystemRelations.length === 0
              ? "尚未定义跨体系关系"
              : "当前筛选条件下没有关系"
          }
        />
      )}
    </>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="ce-field">
      <span>{label}</span>
      <CustomSelect
        value={value}
        options={[...options]}
        onChange={onChange}
        ariaLabel={label}
        placeholder="未指定"
      />
    </div>
  );
}

/** Multi-select for in-system named objects (methods, abilities, tracks, etc.) */
function SystemMultiSelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: readonly string[];
  options: readonly { value: string; label: string }[];
  onChange: (value: string[]) => void;
}) {
  const names = new Map(options.map((o) => [o.value, o.label]));
  const selected = new Set(value);
  const available = options.filter((o) => !selected.has(o.value));
  return (
    <div className="ce-field ce-item-reference-field">
      <span>{label}</span>
      <div className="ce-item-reference-list">
        {value.map((id) => (
          <span
            className={
              names.has(id) ? "ce-item-chip" : "ce-item-chip is-missing"
            }
            key={id}
          >
            <span>{names.get(id) ?? id}</span>
            <button
              type="button"
              title={`移除 ${names.get(id) ?? id}`}
              aria-label={`移除 ${names.get(id) ?? id}`}
              onClick={() => onChange(value.filter((itemId) => itemId !== id))}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {value.length === 0 && <small>尚未关联</small>}
      </div>
      <CustomSelect
        value=""
        options={available}
        onChange={(id) => {
          if (id && !selected.has(id)) onChange([...value, id]);
        }}
        ariaLabel={`添加${label}`}
        placeholder={available.length > 0 ? `选择${label}` : "无可添加项"}
        disabled={available.length === 0}
      />
    </div>
  );
}

/** Row-based editor for metricThresholds — each entry has a metric select + threshold text */
function MetricThresholdsField({
  label,
  value,
  metrics,
  onChange,
}: {
  label: string;
  value: readonly { metricId: string; threshold: string }[];
  metrics: readonly { id: string; name: string }[];
  onChange: (value: { metricId: string; threshold: string }[]) => void;
}) {
  const names = new Map(metrics.map((m) => [m.id, m.name]));
  const usedIds = new Set(value.map((v) => v.metricId));
  const addable = metrics.filter((m) => !usedIds.has(m.id));
  const updateRow = (
    index: number,
    patch: Partial<{ metricId: string; threshold: string }>,
  ) => {
    const next = value.map((row, i) =>
      i === index ? { ...row, ...patch } : row,
    );
    onChange(next);
  };
  return (
    <div className="ce-field ce-metric-thresholds-field">
      <span>{label}</span>
      {value.map((row, index) => (
        <div key={row.metricId} className="ce-metric-threshold-row">
          <span className="ce-metric-threshold-name">
            {names.get(row.metricId) ?? row.metricId}
          </span>
          <input
            className="ce-metric-threshold-input"
            value={row.threshold}
            placeholder="门槛值"
            aria-label={`${names.get(row.metricId) ?? row.metricId} 门槛`}
            onChange={(event) =>
              updateRow(index, { threshold: event.target.value })
            }
          />
          <button
            type="button"
            className="ce-metric-threshold-remove"
            title="移除"
            aria-label="移除此门槛"
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      {value.length === 0 && <small>尚未设置门槛</small>}
      {addable.length > 0 && (
        <CustomSelect
          value=""
          options={addable.map((m) => ({
            value: m.id,
            label: `${m.name} · ${m.id}`,
          }))}
          onChange={(id) => {
            if (!id) return;
            onChange([...value, { metricId: id, threshold: "" }]);
          }}
          ariaLabel="添加指标门槛"
          placeholder="添加指标门槛"
        />
      )}
    </div>
  );
}

type ResourceGrade = CultivationResource["grades"][number];

function ResourceGradesField({
  value,
  onChange,
}: {
  value: readonly ResourceGrade[];
  onChange: (value: ResourceGrade[]) => void;
}) {
  const update = (id: string, patch: Partial<ResourceGrade>) =>
    onChange(
      value.map((grade) => (grade.id === id ? { ...grade, ...patch } : grade)),
    );
  return (
    <div className="ce-field ce-resource-grades-field">
      <span>品质等级</span>
      {value.map((grade, index) => (
        <div className="ce-resource-grade-row" key={grade.id}>
          <Field
            label={`等级 ${index + 1} 名称`}
            value={grade.name}
            onChange={(name) => update(grade.id, { name })}
          />
          <Field
            label="摘要"
            value={grade.summary}
            onChange={(summary) => update(grade.id, { summary })}
            multiline
          />
          <Field
            label="效果"
            value={grade.effect ?? ""}
            onChange={(effect) => update(grade.id, { effect })}
            multiline
          />
          <Button
            variant="ghost"
            title={`移除品质等级 ${grade.name}`}
            onClick={() =>
              onChange(value.filter((item) => item.id !== grade.id))
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      {value.length === 0 && <small>尚未配置品质等级</small>}
      <Button
        variant="ghost"
        title="添加品质等级"
        onClick={() =>
          onChange([
            ...value,
            {
              id: newEcologyId("grade"),
              name: `品质 ${value.length + 1}`,
              summary: "",
              effect: "",
            },
          ])
        }
      >
        <Plus className="h-3.5 w-3.5" />
        添加品质等级
      </Button>
    </div>
  );
}

function ResourceRequirementsField({
  label,
  value,
  resources,
  defaultPurpose,
  onChange,
}: {
  label: string;
  value: readonly ResourceRequirement[];
  resources: readonly CultivationResource[];
  defaultPurpose: ResourceRequirement["purpose"];
  onChange: (value: ResourceRequirement[]) => void;
}) {
  const names = new Map(
    resources.map((resource) => [resource.id, resource.name]),
  );
  const options = resources.map((resource) => ({
    value: resource.id,
    label: `${resource.name} · ${resource.id}`,
  }));
  const add = (resourceId: string) => {
    if (!resourceId || value.some((item) => item.resourceId === resourceId))
      return;
    onChange([
      ...value,
      {
        resourceId,
        purpose: defaultPurpose,
        quantity: "",
        quality: "",
        consumed: true,
        substituteResourceIds: [],
        missingConsequence: "",
      },
    ]);
  };
  const update = (index: number, patch: Partial<ResourceRequirement>) =>
    onChange(
      value.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    );
  return (
    <div className="ce-field ce-resource-requirements-field">
      <span>{label}</span>
      {value.map((item, index) => (
        <div
          className="ce-resource-requirement-row"
          key={`${item.resourceId}-${index}`}
        >
          <SelectField
            label="资源"
            value={item.resourceId}
            options={resources
              .filter(
                (resource) =>
                  resource.id === item.resourceId ||
                  !value.some(
                    (candidate, candidateIndex) =>
                      candidateIndex !== index &&
                      candidate.resourceId === resource.id,
                  ),
              )
              .map((resource) => ({
                value: resource.id,
                label: `${resource.name} · ${resource.id}`,
              }))}
            onChange={(resourceId) => update(index, { resourceId })}
          />
          <SelectField
            label="用途"
            value={item.purpose}
            options={[
              { value: "train", label: "训练" },
              { value: "breakthrough", label: "突破" },
              { value: "activate", label: "激活" },
              { value: "maintain", label: "维持" },
              { value: "recover", label: "恢复" },
            ]}
            onChange={(purpose) =>
              update(index, {
                purpose: purpose as ResourceRequirement["purpose"],
              })
            }
          />
          <Field
            label="数量"
            value={item.quantity}
            onChange={(quantity) => update(index, { quantity })}
          />
          <Field
            label="品质"
            value={item.quality}
            onChange={(quality) => update(index, { quality })}
          />
          <label className="ce-field ce-checkbox-field">
            <span>是否消耗</span>
            <input
              type="checkbox"
              checked={item.consumed}
              onChange={(event) =>
                update(index, { consumed: event.target.checked })
              }
            />
          </label>
          <SystemMultiSelectField
            label="替代资源"
            value={item.substituteResourceIds}
            options={resources
              .filter((resource) => resource.id !== item.resourceId)
              .map((resource) => ({
                value: resource.id,
                label: `${resource.name} · ${resource.id}`,
              }))}
            onChange={(substituteResourceIds) =>
              update(index, { substituteResourceIds })
            }
          />
          <Field
            label="资源短缺后果"
            value={item.missingConsequence}
            onChange={(missingConsequence) =>
              update(index, { missingConsequence })
            }
            multiline
          />
          <Button
            variant="ghost"
            title={`移除${names.get(item.resourceId) ?? item.resourceId}`}
            onClick={() =>
              onChange(value.filter((_, itemIndex) => itemIndex !== index))
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      {value.length === 0 && <small>尚未配置资源需求</small>}
      <CustomSelect
        value=""
        options={options.filter(
          (option) => !value.some((item) => item.resourceId === option.value),
        )}
        onChange={add}
        ariaLabel={`添加${label}`}
        placeholder="添加资源需求"
        disabled={resources.length === 0}
      />
    </div>
  );
}

type OriginBinding = NonNullable<
  CultivationSystem["projection"]["originBindings"]
>[number];
type ReleaseCost = NonNullable<Ability["cast"]["releaseCosts"]>[number];

function OriginBindingsField({
  value,
  nodes,
  onChange,
}: {
  value: readonly OriginBinding[];
  nodes: readonly { id: string; name: string }[];
  onChange: (value: OriginBinding[]) => void;
}) {
  const add = (sourceId: string) => {
    if (!sourceId || value.some((binding) => binding.sourceId === sourceId))
      return;
    onChange([
      ...value,
      {
        sourceId,
        role: "primary",
        purpose: "",
        weight: "",
        sideEffects: [],
      },
    ]);
  };
  const update = (index: number, patch: Partial<OriginBinding>) =>
    onChange(
      value.map((binding, bindingIndex) =>
        bindingIndex === index ? { ...binding, ...patch } : binding,
      ),
    );
  return (
    <div className="ce-field ce-resource-requirements-field">
      <span>本源语义绑定</span>
      {value.map((binding, index) => (
        <div
          className="ce-resource-requirement-row"
          key={`${binding.sourceId}-${index}`}
        >
          <SelectField
            label="来源节点"
            value={binding.sourceId}
            options={[
              ...(!nodes.some((node) => node.id === binding.sourceId)
                ? [{ value: binding.sourceId, label: binding.sourceId }]
                : []),
              ...nodes.map((node) => ({
                value: node.id,
                label: `${node.name} · ${node.id}`,
              })),
            ]}
            onChange={(sourceId) =>
              update(index, {
                sourceId,
                sourceHandleId: undefined,
                targetHandleId: undefined,
              })
            }
          />
          <SelectField
            label="绑定角色"
            value={binding.role}
            options={[
              { value: "primary", label: "主本源" },
              { value: "secondary", label: "次本源" },
              { value: "manifestation", label: "显化节点" },
            ]}
            onChange={(role) =>
              update(index, { role: role as OriginBinding["role"] })
            }
          />
          <Field
            label="语义用途"
            value={binding.purpose}
            onChange={(purpose) => update(index, { purpose })}
            multiline
          />
          <Field
            label="权重 / 优先级"
            value={binding.weight}
            onChange={(weight) => update(index, { weight })}
          />
          <Field
            label="副作用（一行一条）"
            value={binding.sideEffects.join("\n")}
            onChange={(text) => update(index, { sideEffects: textList(text) })}
            multiline
          />
          <Button
            variant="ghost"
            title="移除本源绑定"
            onClick={() =>
              onChange(
                value.filter((_, bindingIndex) => bindingIndex !== index),
              )
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      {value.length === 0 && <small>尚未配置本源语义绑定</small>}
      <CustomSelect
        value=""
        options={nodes
          .filter(
            (node) => !value.some((binding) => binding.sourceId === node.id),
          )
          .map((node) => ({ value: node.id, label: `添加 ${node.name}` }))}
        onChange={add}
        ariaLabel="添加本源语义绑定"
        placeholder="添加本源语义绑定"
        disabled={nodes.length === 0}
      />
    </div>
  );
}

function ReleaseCostsField({
  value,
  onChange,
}: {
  value: readonly ReleaseCost[];
  onChange: (value: ReleaseCost[]) => void;
}) {
  const update = (index: number, patch: Partial<ReleaseCost>) =>
    onChange(
      value.map((cost, costIndex) =>
        costIndex === index ? { ...cost, ...patch } : cost,
      ),
    );
  return (
    <div className="ce-field ce-resource-requirements-field">
      <span>释放成本</span>
      {value.map((cost, index) => (
        <div
          className="ce-resource-requirement-row"
          key={`${cost.label}-${index}`}
        >
          <Field
            label="成本名称"
            value={cost.label}
            onChange={(label) => update(index, { label })}
          />
          <Field
            label="数量 / 公式"
            value={cost.amount}
            onChange={(amount) => update(index, { amount })}
          />
          <label className="ce-field ce-checkbox-field">
            <span>是否消耗</span>
            <input
              type="checkbox"
              checked={cost.consumed}
              onChange={(event) =>
                update(index, { consumed: event.target.checked })
              }
            />
          </label>
          <Button
            variant="ghost"
            title="移除释放成本"
            onClick={() =>
              onChange(value.filter((_, costIndex) => costIndex !== index))
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      {value.length === 0 && <small>尚未配置额外释放成本</small>}
      <Button
        variant="ghost"
        title="添加释放成本"
        onClick={() =>
          onChange([...value, { label: "新成本", amount: "", consumed: true }])
        }
      >
        <Plus className="h-3.5 w-3.5" />
        添加释放成本
      </Button>
    </div>
  );
}

function CourseEditor({
  value,
  levels,
  resources,
  onChange,
}: {
  value: readonly MethodCourse[];
  levels: readonly CultivationLevel[];
  resources: readonly CultivationResource[];
  onChange: (value: MethodCourse[]) => void;
}) {
  const options = levels.map((level) => ({
    value: level.id,
    label: `${level.name} · ${level.id}`,
  }));
  const add = () =>
    onChange([
      ...value,
      {
        id: newEcologyId("course"),
        levelId: null,
        title: `新课程 ${value.length + 1}`,
        steps: [],
        prerequisites: [],
        resourceRequirements: [],
        passCriteria: "",
        failureRisk: "",
      },
    ]);
  const update = (index: number, patch: Partial<MethodCourse>) =>
    onChange(
      value.map((course, courseIndex) =>
        courseIndex === index ? { ...course, ...patch } : course,
      ),
    );
  return (
    <div className="ce-field ce-course-editor">
      <span>阶段课程</span>
      {value.map((course, index) => (
        <div className="ce-course-row" key={course.id}>
          <div className="ce-course-row-head">
            <strong>{course.title}</strong>
            <Button
              variant="ghost"
              title="删除课程"
              onClick={() =>
                onChange(
                  value.filter((_, courseIndex) => courseIndex !== index),
                )
              }
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Field
            label="课程标题"
            value={course.title}
            onChange={(title) => update(index, { title })}
          />
          <SelectField
            label="对应阶段"
            value={course.levelId ?? ""}
            options={[{ value: "", label: "未指定" }, ...options]}
            onChange={(levelId) => update(index, { levelId: levelId || null })}
          />
          <Field
            label="训练步骤（一行一条）"
            value={course.steps.join("\n")}
            onChange={(text) => update(index, { steps: textList(text) })}
            multiline
          />
          <Field
            label="前置条件（一行一条）"
            value={course.prerequisites.join("\n")}
            onChange={(text) =>
              update(index, { prerequisites: textList(text) })
            }
            multiline
          />
          <ResourceRequirementsField
            label="课程资源需求"
            value={course.resourceRequirements}
            resources={resources}
            defaultPurpose="train"
            onChange={(resourceRequirements) =>
              update(index, { resourceRequirements })
            }
          />
          <Field
            label="通过标准"
            value={course.passCriteria}
            onChange={(passCriteria) => update(index, { passCriteria })}
            multiline
          />
          <Field
            label="失败风险"
            value={course.failureRisk}
            onChange={(failureRisk) => update(index, { failureRisk })}
            multiline
          />
        </div>
      ))}
      {value.length === 0 && <small>尚未配置课程</small>}
      <Button variant="secondary" onClick={add}>
        <Plus className="h-3.5 w-3.5" />
        新增课程
      </Button>
    </div>
  );
}

function ItemIdsField({
  label,
  value,
  entries,
  loading,
  error,
  onChange,
}: {
  label: string;
  value: readonly string[];
  entries: readonly ItemIndexEntry[];
  loading: boolean;
  error: string;
  onChange: (value: string[]) => void;
}) {
  const [manualId, setManualId] = useState("");
  const names = new Map(entries.map((entry) => [entry.id, entry.name]));
  const selected = new Set(value);
  const options = entries
    .filter((entry) => !selected.has(entry.id))
    .map((entry) => ({
      value: entry.id,
      label: `${entry.name} · ${entry.id}`,
    }));
  const add = (id: string) => {
    if (!id || selected.has(id)) return;
    onChange([...value, id]);
  };
  const addManual = () => {
    const id = manualId.trim();
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id) || selected.has(id)) return;
    add(id);
    setManualId("");
  };
  return (
    <div className="ce-field ce-item-reference-field">
      <span>{label}</span>
      <div className="ce-item-reference-list">
        {value.map((id) => (
          <span
            className={
              names.has(id) ? "ce-item-chip" : "ce-item-chip is-missing"
            }
            key={id}
          >
            <span>{names.get(id) ?? id}</span>
            <button
              type="button"
              title={`移除 ${id}`}
              aria-label={`移除 ${id}`}
              onClick={() => onChange(value.filter((itemId) => itemId !== id))}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {value.length === 0 && <small>尚未关联物品</small>}
      </div>
      <CustomSelect
        value=""
        options={options}
        onChange={add}
        ariaLabel={`选择${label}`}
        placeholder={
          loading
            ? "正在加载物品库…"
            : options.length > 0
              ? "从物品库选择"
              : "没有可选物品"
        }
        disabled={loading || options.length === 0}
      />
      <div className="ce-item-manual">
        <input
          value={manualId}
          placeholder="手动输入物品 ID"
          aria-label={`${label}手动 ID`}
          onChange={(event) => setManualId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addManual();
            }
          }}
        />
        <Button
          variant="ghost"
          onClick={addManual}
          disabled={!manualId.trim()}
          title="添加手动物品 ID"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      {error && <small className="ce-item-reference-note">{error}</small>}
      {value.some((id) => !names.has(id)) && (
        <small className="ce-item-reference-note is-warning">
          存在尚未在当前物品索引中找到的 ID，保存不会自动删除它们。
        </small>
      )}
    </div>
  );
}

function textList(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}
function fixedLineValues(value: string, count: number): string[] {
  const lines = value.split("\n").map((item) => item.trim());
  return Array.from({ length: count }, (_, index) => lines[index] ?? "");
}
function boundedNumber(
  value: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
function InspectorV2({
  scope,
  ecology,
  system,
  selection,
  onChange,
  onChangeSystem,
  onDeleteSystem,
  onSelect,
  itemEntries,
  itemLibraryLoading,
  itemLibraryError,
}: {
  scope: Scope;
  ecology: CultivationEcology;
  system: CultivationSystem | null;
  selection: Selection;
  onChange: (ecology: CultivationEcology) => void;
  onChangeSystem: (system: CultivationSystem) => void;
  onDeleteSystem: () => void;
  onSelect?: (selection: Selection) => void;
  itemEntries: readonly ItemIndexEntry[];
  itemLibraryLoading: boolean;
  itemLibraryError: string;
}) {
  const selected = selection?.id ?? "";
  const patchSystem = (patch: Partial<CultivationSystem>) => {
    if (system) onChangeSystem({ ...system, ...patch });
  };
  const listOptions = (items: readonly { id: string; name: string }[]) =>
    items.map((item) => ({
      value: item.id,
      label: `${item.name} · ${item.id}`,
    }));
  const tracks = system?.progressionTracks ?? [];
  const levels =
    system?.progressionTracks.flatMap((track) => track.levels) ?? [];
  const methods = system?.methods ?? [];
  const resources = system?.resources ?? [];
  const abilities = system?.abilities ?? [];
  const theoryNodes = system?.theoryModel.nodeCatalog ?? [];
  const worldOrigins = ecology.worldOrigins;

  if (!selection && scope === "origins")
    return (
      <WorldOriginOverviewInspector ecology={ecology} onSelect={onSelect} />
    );
  if (!selection)
    return (
      <div className="ce-inspector-empty">
        <Atom className="h-5 w-5" />
        <span>选择一个全局对象或修行体系</span>
      </div>
    );

  if (scope === "origins" && selection.kind === "origin-overview")
    return (
      <WorldOriginOverviewInspector ecology={ecology} onSelect={onSelect} />
    );
  if (scope === "origins" && selection.kind === "world-origin") {
    const item = ecology.worldOrigins.find((origin) => origin.id === selected);
    if (!item) return <InspectorMissing />;
    const update = (patch: Partial<WorldOrigin>) =>
      onChange({
        ...ecology,
        worldOrigins: updateById(ecology.worldOrigins, item.id, (current) => ({
          ...current,
          ...patch,
        })),
      });
    const remove = () => {
      const manifestationIds = new Set(
        item.manifestations.map((manifestation) => manifestation.id),
      );
      onChange({
        ...ecology,
        worldOrigins: ecology.worldOrigins.filter(
          (origin) => origin.id !== item.id,
        ),
        systems: ecology.systems.map((candidate) => ({
          ...candidate,
          projection: {
            ...candidate.projection,
            originIds: candidate.projection.originIds.filter(
              (originId) => originId !== item.id,
            ),
            manifestationIds: candidate.projection.manifestationIds.filter(
              (id) => !manifestationIds.has(id),
            ),
            originBindings: candidate.projection.originBindings?.filter(
              (binding) =>
                binding.sourceId !== item.id &&
                !manifestationIds.has(binding.sourceId),
            ),
          },
        })),
      });
      onSelect?.(null);
    };
    const projectedSystemCount = ecology.systems.filter(
      (candidate) =>
        candidate.projection.originIds.includes(item.id) ||
        candidate.projection.manifestationIds.some((id) =>
          item.manifestations.some((manifestation) => manifestation.id === id),
        ),
    ).length;
    const checks = [
      {
        id: "ontology",
        passed: Boolean(item.ontologyStatement.trim()),
        label: "本体陈述已定义",
        missingLabel: "缺少本体陈述",
      },
      {
        id: "scope",
        passed: item.scopes.length > 0,
        label: "作用域已定义",
        missingLabel: "缺少作用域定义",
      },
      {
        id: "manifestation",
        passed:
          item.manifestations.length > 0 &&
          item.manifestations.every((manifestation) =>
            manifestation.definition.trim(),
          ),
        label: "显化节点定义完整",
        missingLabel: "显化节点尚待补全",
      },
    ];
    const pendingCheckCount = checks.filter((check) => !check.passed).length;
    return (
      <div className="ce-inspector-content ce-world-origin-detail-inspector">
        <section className="ce-world-origin-inspector-section">
          <div className="ce-world-origin-inspector-section-head">
            <h3>本源概览</h3>
            <span>{worldOriginStatusLabels[item.status]}</span>
          </div>
          <dl className="ce-world-origin-inspector-summary">
            <div>
              <dt>当前本源</dt>
              <dd>{item.name}</dd>
            </div>
            <div>
              <dt>本源形态</dt>
              <dd>{item.kind}</dd>
            </div>
            <div>
              <dt>显化与关系</dt>
              <dd>
                {item.manifestations.length} / {item.relations.length}
              </dd>
            </div>
            <div>
              <dt>接入体系</dt>
              <dd>{projectedSystemCount}</dd>
            </div>
          </dl>
        </section>
        <section className="ce-world-origin-inspector-section">
          <div className="ce-world-origin-inspector-section-head">
            <h3>结构检查</h3>
            <span
              className={pendingCheckCount === 0 ? "is-complete" : "is-pending"}
            >
              {pendingCheckCount === 0
                ? "已通过"
                : `${pendingCheckCount} 项待补全`}
            </span>
          </div>
          <ul className="ce-world-origin-inspector-checks">
            {checks.map((check) => (
              <li
                key={check.id}
                className={check.passed ? "is-passed" : "is-warning"}
              >
                {check.passed ? (
                  <ShieldCheck className="h-3.5 w-3.5" />
                ) : (
                  <ShieldAlert className="h-3.5 w-3.5" />
                )}
                <span>{check.passed ? check.label : check.missingLabel}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="ce-world-origin-inspector-section ce-world-origin-inspector-edit">
          <div className="ce-world-origin-inspector-section-head">
            <h3>本源信息</h3>
            <span>可编辑</span>
          </div>
          <div className="ce-inspector-form">
            <Field
              label="本源名称"
              value={item.name}
              onChange={(value) => update({ name: value })}
            />
            <Field
              label="本源形态"
              value={item.kind}
              onChange={(value) => update({ kind: value })}
            />
            <SelectField
              label="结构状态"
              value={item.status}
              options={[
                { value: "stable", label: "稳定" },
                { value: "fragmented", label: "分裂" },
                { value: "incomplete", label: "待完善" },
                { value: "unstable", label: "不稳定" },
              ]}
              onChange={(value) =>
                update({ status: value as WorldOrigin["status"] })
              }
            />
            <OrbStyleField
              value={item.orbStyle ?? worldOriginStatusOrbStyles[item.status]}
              onChange={(orbStyle) => update({ orbStyle })}
            />
            <Field
              label="摘要"
              value={item.summary}
              onChange={(value) => update({ summary: value })}
              multiline
            />
            <Field
              label="本体陈述"
              value={item.ontologyStatement}
              onChange={(value) => update({ ontologyStatement: value })}
              multiline
            />
            <Field
              label="作用域（一行一项）"
              value={item.scopes.join("\n")}
              onChange={(value) => update({ scopes: textList(value) })}
              multiline
            />
            <Field
              label="世界约束（一行一条）"
              value={item.constraints.join("\n")}
              onChange={(value) => update({ constraints: textList(value) })}
              multiline
            />
          </div>
        </section>
        <Button variant="danger" onClick={remove}>
          <Trash2 className="h-3.5 w-3.5" />
          删除对象
        </Button>
      </div>
    );
  }
  if (scope === "origins" && selection.kind === "manifestation") {
    const parent =
      ecology.worldOrigins.find((origin) => origin.id === selection.parentId) ??
      ecology.worldOrigins.find((origin) =>
        origin.manifestations.some(
          (manifestation) => manifestation.id === selected,
        ),
      );
    const item = parent?.manifestations.find(
      (manifestation) => manifestation.id === selected,
    );
    if (!parent || !item) return <InspectorMissing />;
    const sourceNodes = [
      { id: parent.id, name: parent.name },
      ...parent.manifestations.filter(
        (manifestation) => manifestation.id !== item.id,
      ),
    ];
    const update = (patch: Partial<WorldOriginManifestation>) =>
      onChange({
        ...ecology,
        worldOrigins: updateById(ecology.worldOrigins, parent.id, (origin) => ({
          ...origin,
          manifestations: updateById(
            origin.manifestations,
            item.id,
            (current) => ({ ...current, ...patch }),
          ),
        })),
      });
    const remove = () =>
      onChange({
        ...ecology,
        worldOrigins: updateById(ecology.worldOrigins, parent.id, (origin) => ({
          ...origin,
          relations: origin.relations.filter(
            (relation) =>
              relation.sourceId !== item.id && relation.targetId !== item.id,
          ),
          manifestations: origin.manifestations
            .filter((manifestation) => manifestation.id !== item.id)
            .map((manifestation) =>
              manifestation.sourceId === item.id
                ? { ...manifestation, sourceId: null }
                : manifestation,
            ),
          canvasPositions: Object.fromEntries(
            Object.entries(origin.canvasPositions ?? {}).filter(
              ([id]) => id !== item.id,
            ),
          ),
        })),
        systems: ecology.systems.map((candidate) => ({
          ...candidate,
          projection: {
            ...candidate.projection,
            manifestationIds: candidate.projection.manifestationIds.filter(
              (id) => id !== item.id,
            ),
            originBindings: candidate.projection.originBindings?.filter(
              (binding) => binding.sourceId !== item.id,
            ),
          },
        })),
      });
    return (
      <InspectorEditor
        title={item.name}
        type={`本源显化 / ${manifestationTypeLabels[item.type]}`}
        onDelete={() => {
          remove();
          onSelect?.(null);
        }}
      >
        <Field
          label="显化名称"
          value={item.name}
          onChange={(value) => update({ name: value })}
        />
        <SelectField
          label="显化类型"
          value={item.type}
          options={Object.entries(manifestationTypeLabels).map(
            ([value, label]) => ({ value, label }),
          )}
          onChange={(value) =>
            update({ type: value as WorldOriginManifestation["type"] })
          }
        />
        <OrbStyleField
          value={item.orbStyle ?? manifestationTypeOrbStyles[item.type]}
          onChange={(orbStyle) => update({ orbStyle })}
        />
        <Field
          label="摘要"
          value={item.summary}
          onChange={(value) => update({ summary: value })}
          multiline
        />
        <Field
          label="定义"
          value={item.definition}
          onChange={(value) => update({ definition: value })}
          multiline
        />
        <SelectField
          label="来源节点"
          value={item.sourceId ?? ""}
          options={[
            { value: "", label: "未指定" },
            ...sourceNodes.map((node) => ({
              value: node.id,
              label: node.name,
            })),
          ]}
          onChange={(value) => update({ sourceId: value || null })}
        />
        <Field
          label="作用域"
          value={item.scope}
          onChange={(value) => update({ scope: value })}
        />
        <Field
          label="接入方式"
          value={item.access}
          onChange={(value) => update({ access: value })}
          multiline
        />
        <Field
          label="生成方式"
          value={item.generation}
          onChange={(value) => update({ generation: value })}
          multiline
        />
        <Field
          label="转化方式"
          value={item.conversion}
          onChange={(value) => update({ conversion: value })}
          multiline
        />
        <Field
          label="风险（一行一条）"
          value={item.risks.join("\n")}
          onChange={(value) => update({ risks: textList(value) })}
          multiline
        />
      </InspectorEditor>
    );
  }
  if (scope === "origins" && selection.kind === "origin-relation") {
    const parent =
      ecology.worldOrigins.find((origin) => origin.id === selection.parentId) ??
      ecology.worldOrigins.find((origin) =>
        origin.relations.some((relation) => relation.id === selected),
      );
    const item = parent?.relations.find((relation) => relation.id === selected);
    if (!parent || !item) return <InspectorMissing />;
    const nodes = [
      { id: parent.id, name: parent.name },
      ...parent.manifestations,
    ];
    const update = (patch: Partial<WorldOriginRelation>) =>
      onChange({
        ...ecology,
        worldOrigins: updateById(ecology.worldOrigins, parent.id, (origin) => ({
          ...origin,
          relations: updateById(origin.relations, item.id, (current) => ({
            ...current,
            ...patch,
          })),
        })),
      });
    return (
      <InspectorEditor
        title={item.name}
        type="本源结构关系"
        onDelete={() => {
          onChange({
            ...ecology,
            worldOrigins: updateById(
              ecology.worldOrigins,
              parent.id,
              (origin) => ({
                ...origin,
                relations: origin.relations.filter(
                  (relation) => relation.id !== item.id,
                ),
              }),
            ),
          });
          onSelect?.(null);
        }}
      >
        <Field
          label="关系名称"
          value={item.name}
          onChange={(value) => update({ name: value })}
        />
        <SelectField
          label="关系类型"
          value={item.relation}
          options={Object.entries(originRelationLabels).map(
            ([value, label]) => ({ value, label }),
          )}
          onChange={(value) =>
            update({ relation: value as WorldOriginRelation["relation"] })
          }
        />
        <SelectField
          label="来源节点"
          value={item.sourceId}
          options={nodes.map((node) => ({ value: node.id, label: node.name }))}
          onChange={(value) =>
            update({ sourceId: value, sourceHandleId: undefined })
          }
        />
        <SelectField
          label="目标节点"
          value={item.targetId}
          options={nodes.map((node) => ({ value: node.id, label: node.name }))}
          onChange={(value) =>
            update({ targetId: value, targetHandleId: undefined })
          }
        />
        <Field
          label="成立条件（一行一条）"
          value={item.conditions.join("\n")}
          onChange={(value) => update({ conditions: textList(value) })}
          multiline
        />
        <Field
          label="代价"
          value={item.cost}
          onChange={(value) => update({ cost: value })}
          multiline
        />
        <Field
          label="损耗与衰减"
          value={item.loss}
          onChange={(value) => update({ loss: value })}
          multiline
        />
      </InspectorEditor>
    );
  }
  if (scope === "origins" && selection.kind === "origin-projection") {
    const item = ecology.systems.find((candidate) => candidate.id === selected);
    if (!item) return <InspectorMissing />;
    return (
      <InspectorEditor title={item.name} type="修行体系本源投影">
        <div className="ce-inspector-facts">
          <div>
            <span>体系类型</span>
            <strong>{item.kind}</strong>
          </div>
          <div>
            <span>显化入口</span>
            <strong>{item.projection.manifestationIds.length}</strong>
          </div>
        </div>
        <Field
          label="接入方式"
          value={item.projection.access}
          onChange={(value) =>
            onChange({
              ...ecology,
              systems: updateById(ecology.systems, item.id, (current) => ({
                ...current,
                projection: { ...current.projection, access: value },
              })),
            })
          }
        />
        <Field
          label="本地化翻译"
          value={item.projection.translation}
          onChange={(value) =>
            onChange({
              ...ecology,
              systems: updateById(ecology.systems, item.id, (current) => ({
                ...current,
                projection: { ...current.projection, translation: value },
              })),
            })
          }
          multiline
        />
        <Field
          label="投影衰减与边界"
          value={item.projection.attenuation}
          onChange={(value) =>
            onChange({
              ...ecology,
              systems: updateById(ecology.systems, item.id, (current) => ({
                ...current,
                projection: { ...current.projection, attenuation: value },
              })),
            })
          }
          multiline
        />
      </InspectorEditor>
    );
  }
  if (!system || selection?.kind === "relation") {
    if (selection?.kind === "relation") {
      const item = ecology.crossSystemRelations.find(
        (relation) => relation.id === selected,
      );
      if (!item) return <InspectorMissing />;
      const update = (patch: Partial<typeof item>) =>
        onChange({
          ...ecology,
          crossSystemRelations: updateById(
            ecology.crossSystemRelations,
            item.id,
            (current) => ({ ...current, ...patch }),
          ),
        });
      const affectedAssetOptions = ecology.systems
        .filter(
          (candidate) =>
            candidate.id === item.sourceSystemId ||
            candidate.id === item.targetSystemId,
        )
        .flatMap((candidate) => [
          ...candidate.theoryModel.nodeCatalog.map((asset) => ({
            value: asset.id,
            label: `${candidate.name} / 理论节点 · ${asset.name}`,
          })),
          ...candidate.resources.map((asset) => ({
            value: asset.id,
            label: `${candidate.name} / 资源 · ${asset.name}`,
          })),
          ...candidate.progressionTracks.flatMap((track) => [
            {
              value: track.id,
              label: `${candidate.name} / 轨道 · ${track.name}`,
            },
            ...track.metrics.map((asset) => ({
              value: asset.id,
              label: `${candidate.name} / 指标 · ${asset.name}`,
            })),
            ...track.levels.flatMap((level) => [
              {
                value: level.id,
                label: `${candidate.name} / 境界 · ${level.name}`,
              },
              ...level.subStages.map((stage) => ({
                value: stage.id,
                label: `${candidate.name} / 境内阶段 · ${level.name} / ${stage.name}`,
              })),
            ]),
            ...track.transitions.map((asset) => ({
              value: asset.id,
              label: `${candidate.name} / 轨道转换 · ${asset.name}`,
            })),
          ]),
          ...candidate.methods.map((asset) => ({
            value: asset.id,
            label: `${candidate.name} / 法门 · ${asset.name}`,
          })),
          ...candidate.abilities.map((asset) => ({
            value: asset.id,
            label: `${candidate.name} / 能力 · ${asset.name}`,
          })),
          ...candidate.formations.map((asset) => ({
            value: asset.id,
            label: `${candidate.name} / 阵法 · ${asset.name}`,
          })),
          ...candidate.foundations.map((asset) => ({
            value: asset.id,
            label: `${candidate.name} / 根基 · ${asset.name}`,
          })),
          ...(candidate.trackInteractions ?? []).map((asset) => ({
            value: asset.id,
            label: `${candidate.name} / 轨道规则 · ${asset.name}`,
          })),
          ...candidate.transitions.map((asset) => ({
            value: asset.id,
            label: `${candidate.name} / 转换 · ${asset.name}`,
          })),
        ]);
      return (
        <InspectorEditor
          title={item.name}
          type="跨体系关系"
          onDelete={() => {
            onChange({
              ...ecology,
              crossSystemRelations: ecology.crossSystemRelations.filter(
                (relation) => relation.id !== item.id,
              ),
            });
            onSelect?.(null);
          }}
        >
          <Field
            label="关系名称"
            value={item.name}
            onChange={(value) => update({ name: value })}
          />
          <SelectField
            label="关系类型"
            value={item.relation}
            options={[
              "兼容",
              "克制",
              "转换",
              "依赖",
              "继承",
              "污染",
              "冲突",
            ].map((value) => ({ value, label: value }))}
            onChange={(value) =>
              update({ relation: value as typeof item.relation })
            }
          />
          <SelectField
            label="源体系"
            value={item.sourceSystemId}
            options={ecology.systems.map((candidate) => ({
              value: candidate.id,
              label: candidate.name,
            }))}
            onChange={(value) => update({ sourceSystemId: value })}
          />
          <SelectField
            label="目标体系"
            value={item.targetSystemId}
            options={ecology.systems.map((candidate) => ({
              value: candidate.id,
              label: candidate.name,
            }))}
            onChange={(value) => update({ targetSystemId: value })}
          />
          <Field
            label="转换规则"
            value={item.conversionRule}
            onChange={(value) => update({ conversionRule: value })}
            multiline
          />
          <Field
            label="条件（一行一条）"
            value={item.conditions.join("\n")}
            onChange={(value) => update({ conditions: textList(value) })}
            multiline
          />
          <Field
            label="风险"
            value={item.risk}
            onChange={(value) => update({ risk: value })}
            multiline
          />
          <Field
            label="转换结果"
            value={item.result ?? ""}
            onChange={(result) => update({ result })}
            multiline
          />
          <SystemMultiSelectField
            label="影响资产"
            value={item.affectedAssetIds ?? []}
            options={affectedAssetOptions}
            onChange={(affectedAssetIds) => update({ affectedAssetIds })}
          />
          <Field
            label="边界"
            value={item.boundary ?? ""}
            onChange={(boundary) => update({ boundary })}
            multiline
          />
        </InspectorEditor>
      );
    }
    return (
      <div className="ce-inspector-empty">
        <Atom className="h-5 w-5" />
        <span>选择一个全局对象或修行体系</span>
      </div>
    );
  }

  if (selection?.kind === "projection")
    return (
      <InspectorEditor title="体系本源投影" type="本源投影">
        <SystemMultiSelectField
          label="关联世界本源"
          value={system.projection.originIds}
          options={listOptions(worldOrigins)}
          onChange={(value) => {
            const allowedManifestationIds = new Set(
              worldOrigins
                .filter((origin) => value.includes(origin.id))
                .flatMap((origin) =>
                  origin.manifestations.map(
                    (manifestation) => manifestation.id,
                  ),
                ),
            );
            const allowedSourceIds = new Set([
              ...value,
              ...allowedManifestationIds,
            ]);
            patchSystem({
              projection: {
                ...system.projection,
                originIds: value,
                manifestationIds: system.projection.manifestationIds.filter(
                  (id) => allowedManifestationIds.has(id),
                ),
                originBindings: system.projection.originBindings?.filter(
                  (binding) => allowedSourceIds.has(binding.sourceId),
                ),
              },
            });
          }}
        />
        <SystemMultiSelectField
          label="关联显化节点"
          value={system.projection.manifestationIds}
          options={listOptions(
            worldOrigins
              .filter((origin) =>
                system.projection.originIds.includes(origin.id),
              )
              .flatMap((origin) => origin.manifestations),
          )}
          onChange={(value) =>
            patchSystem({
              projection: {
                ...system.projection,
                manifestationIds: value.filter((id) =>
                  worldOrigins
                    .filter((origin) =>
                      system.projection.originIds.includes(origin.id),
                    )
                    .some((origin) =>
                      origin.manifestations.some(
                        (manifestation) => manifestation.id === id,
                      ),
                    ),
                ),
              },
            })
          }
        />
        <OriginBindingsField
          value={system.projection.originBindings ?? []}
          nodes={[
            ...worldOrigins
              .filter((origin) =>
                system.projection.originIds.includes(origin.id),
              )
              .map((origin) => ({ id: origin.id, name: origin.name })),
            ...worldOrigins
              .filter((origin) =>
                system.projection.originIds.includes(origin.id),
              )
              .flatMap((origin) =>
                origin.manifestations.map((manifestation) => ({
                  id: manifestation.id,
                  name: manifestation.name,
                })),
              ),
          ]}
          onChange={(originBindings) =>
            patchSystem({
              projection: { ...system.projection, originBindings },
            })
          }
        />
        <Field
          label="接入方式"
          value={system.projection.access}
          onChange={(value) =>
            patchSystem({ projection: { ...system.projection, access: value } })
          }
          multiline
        />
        <Field
          label="法则翻译"
          value={system.projection.translation}
          onChange={(value) =>
            patchSystem({
              projection: { ...system.projection, translation: value },
            })
          }
          multiline
        />
        <Field
          label="能量 / 权柄载体"
          value={system.projection.medium}
          onChange={(value) =>
            patchSystem({ projection: { ...system.projection, medium: value } })
          }
        />
        <Field
          label="投影衰减与边界"
          value={system.projection.attenuation}
          onChange={(value) =>
            patchSystem({
              projection: { ...system.projection, attenuation: value },
            })
          }
          multiline
        />
      </InspectorEditor>
    );
  if (selection?.kind === "theory")
    return (
      <InspectorEditor
        title={system.theoryModel.statement || "理论模型"}
        type="理论模型"
      >
        <Field
          label="理论陈述"
          value={system.theoryModel.statement}
          onChange={(value) =>
            patchSystem({
              theoryModel: { ...system.theoryModel, statement: value },
            })
          }
          multiline
        />
        <Field
          label="模型摘要"
          value={system.theoryModel.summary}
          onChange={(value) =>
            patchSystem({
              theoryModel: { ...system.theoryModel, summary: value },
            })
          }
          multiline
        />
        <Field
          label="节点类型（一行一个）"
          value={system.theoryModel.nodeTypes.join("\n")}
          onChange={(value) =>
            patchSystem({
              theoryModel: {
                ...system.theoryModel,
                nodeTypes: textList(value),
              },
            })
          }
          multiline
        />
        <Field
          label="结构不变量（一行一条）"
          value={system.theoryModel.invariants.join("\n")}
          onChange={(value) =>
            patchSystem({
              theoryModel: {
                ...system.theoryModel,
                invariants: textList(value),
              },
            })
          }
          multiline
        />
        <Field
          label="校验规则（一行一条）"
          value={system.theoryModel.validationRules.join("\n")}
          onChange={(value) =>
            patchSystem({
              theoryModel: {
                ...system.theoryModel,
                validationRules: textList(value),
              },
            })
          }
          multiline
        />
      </InspectorEditor>
    );
  if (
    selection?.kind === "system" ||
    ["overview", "assets", "foundations", "constraints", "audit"].includes(
      selection?.kind ?? "",
    )
  )
    return (
      <div className="ce-inspector-content">
        <div className="ce-inspector-label">当前体系</div>
        <div className="ce-inspector-focus">
          <span className="ce-focus-icon">
            <Atom className="h-4 w-4" />
          </span>
          <div>
            <strong>{system.name}</strong>
            <small>{system.kind}</small>
          </div>
        </div>
        <div className="ce-inspector-rule" />
        <div className="ce-inspector-facts">
          <div>
            <span>理论节点</span>
            <strong>{theoryNodes.length}</strong>
          </div>
          <div>
            <span>成长境界</span>
            <strong>{levels.length}</strong>
          </div>
          <div>
            <span>法门拓扑</span>
            <strong>
              {methods.reduce(
                (total, method) => total + method.operationTopologies.length,
                0,
              )}
            </strong>
          </div>
          <div>
            <span>待审查</span>
            <strong>
              {system.audit.filter((item) => !item.resolved).length}
            </strong>
          </div>
        </div>
        <Section title="体系信息" eyebrow="基础字段">
          <Field
            label="体系名称"
            value={system.name}
            onChange={(value) => patchSystem({ name: value })}
          />
          <Field
            label="体系类型"
            value={system.kind}
            onChange={(value) => patchSystem({ kind: value })}
          />
          <Field
            label="摘要"
            value={system.summary}
            onChange={(value) => patchSystem({ summary: value })}
            multiline
          />
          <Field
            label="能量术语"
            value={system.terminology.energy}
            onChange={(value) =>
              patchSystem({
                terminology: { ...system.terminology, energy: value },
              })
            }
          />
          <Field
            label="境界术语"
            value={system.terminology.stage}
            onChange={(value) =>
              patchSystem({
                terminology: { ...system.terminology, stage: value },
              })
            }
          />
          <Field
            label="法门术语"
            value={system.terminology.method}
            onChange={(value) =>
              patchSystem({
                terminology: { ...system.terminology, method: value },
              })
            }
          />
          <Field
            label="能力术语"
            value={system.terminology.ability}
            onChange={(value) =>
              patchSystem({
                terminology: { ...system.terminology, ability: value },
              })
            }
          />
        </Section>
        <Button variant="danger" onClick={onDeleteSystem}>
          <Trash2 className="h-3.5 w-3.5" />
          删除当前体系
        </Button>
      </div>
    );
  if (selection?.kind === "theory-node") {
    const item = theoryNodes.find((node) => node.id === selected);
    if (!item) return <InspectorMissing />;
    const update = (patch: Partial<TheoryNode>) =>
      patchSystem({
        theoryModel: {
          ...system.theoryModel,
          nodeCatalog: updateById(
            system.theoryModel.nodeCatalog,
            item.id,
            (current) => ({ ...current, ...patch }),
          ),
        },
      });
    return (
      <InspectorEditor
        title={item.name}
        type="理论节点"
        onDelete={() => {
          const next = removeTheoryNodeReferences(system, item.id);
          patchSystem({
            ...next,
            theoryModel: {
              ...next.theoryModel,
              nodeCatalog: next.theoryModel.nodeCatalog.filter(
                (node) => node.id !== item.id,
              ),
            },
          });
          onSelect?.(null);
        }}
      >
        <Field
          label="名称"
          value={item.name}
          onChange={(value) => update({ name: value })}
        />
        <Field
          label="节点类别"
          value={item.kind}
          onChange={(value) => update({ kind: value })}
        />
        <Field
          label="节点摘要"
          value={item.summary}
          onChange={(value) => update({ summary: value })}
          multiline
        />
        <Field
          label="作用"
          value={item.role}
          onChange={(value) => update({ role: value })}
          multiline
        />
        <Field
          label="容量 / 上限"
          value={item.capacity}
          onChange={(value) => update({ capacity: value })}
        />
        <Field
          label="别名（一行一个）"
          value={item.aliases.join("\n")}
          onChange={(value) => update({ aliases: textList(value) })}
          multiline
        />
        <Field
          label="通达条件"
          value={item.accessCondition}
          onChange={(value) => update({ accessCondition: value })}
          multiline
        />
        <Field
          label="结构不变量"
          value={item.invariant}
          onChange={(value) => update({ invariant: value })}
          multiline
        />
      </InspectorEditor>
    );
  }
  if (selection?.kind === "resource") {
    const item = resources.find((resource) => resource.id === selected);
    if (!item) return <InspectorMissing />;
    const update = (patch: Partial<CultivationResource>) =>
      patchSystem({
        resources: updateById(resources, item.id, (current) => ({
          ...current,
          ...patch,
        })),
      });
    return (
      <InspectorEditor
        title={item.name}
        type="资源"
        onDelete={() => {
          const next = removeResourceReferences(system, item.id);
          patchSystem({
            ...next,
            resources: next.resources.filter(
              (resource) => resource.id !== item.id,
            ),
          });
          onSelect?.(null);
        }}
      >
        <Field
          label="名称"
          value={item.name}
          onChange={(value) => update({ name: value })}
        />
        <Field
          label="类别"
          value={item.category}
          onChange={(value) => update({ category: value })}
        />
        <Field
          label="摘要"
          value={item.summary}
          onChange={(value) => update({ summary: value })}
          multiline
        />
        <ResourceGradesField
          value={item.grades}
          onChange={(grades) => update({ grades })}
        />
        <SelectField
          label="最佳适用境界"
          value={item.bestLevelId ?? ""}
          options={[{ value: "", label: "未指定" }, ...listOptions(levels)]}
          onChange={(value) => update({ bestLevelId: value || null })}
        />
        <SystemMultiSelectField
          label="可用境界"
          value={item.usableLevelIds}
          options={listOptions(levels)}
          onChange={(value) => update({ usableLevelIds: value })}
        />
        <Field
          label="供给与来源"
          value={item.supply}
          onChange={(value) => update({ supply: value })}
          multiline
        />
        <Field
          label="适用环境"
          value={item.environment}
          onChange={(value) => update({ environment: value })}
        />
        <Field
          label="转化规则"
          value={item.conversion}
          onChange={(value) => update({ conversion: value })}
          multiline
        />
        <Field
          label="短缺后果"
          value={item.shortageConsequence}
          onChange={(value) => update({ shortageConsequence: value })}
          multiline
        />
      </InspectorEditor>
    );
  }
  if (selection?.kind === "method") {
    const item = methods.find((method) => method.id === selected);
    if (!item) return <InspectorMissing />;
    const update = (patch: Partial<CultivationMethod>) =>
      patchSystem({
        methods: updateById(methods, item.id, (current) => ({
          ...current,
          ...patch,
        })),
      });
    return (
      <InspectorEditor
        title={item.name}
        type="修行法门"
        onDelete={() => {
          const next = removeMethodReferences(system, item.id);
          patchSystem({
            ...next,
            methods: next.methods.filter((method) => method.id !== item.id),
          });
          onSelect?.(null);
        }}
      >
        <Field
          label="法门名称"
          value={item.name}
          onChange={(value) => update({ name: value })}
        />
        <Field
          label="法门摘要"
          value={item.summary}
          onChange={(value) => update({ summary: value })}
          multiline
        />
        <Field
          label="法门类型"
          value={item.kind}
          onChange={(value) => update({ kind: value })}
        />
        <Field
          label="理论引用"
          value={item.theoryReference}
          onChange={(value) => update({ theoryReference: value })}
          multiline
        />
        <Field
          label="修炼法诀（一行一步）"
          value={item.script.join("\n")}
          onChange={(value) => update({ script: textList(value) })}
          multiline
        />
        <Field
          label="成长公式"
          value={item.formula}
          onChange={(value) => update({ formula: value })}
          multiline
        />
        <Field
          label="覆盖境界 ID（起始 / 稳定 / 理论 / 绝对）"
          value={[
            item.coverage.startLevelId,
            item.coverage.stableLimitId,
            item.coverage.theoryLimitId,
            item.coverage.absoluteLimitId,
          ]
            .map((value) => value ?? "")
            .join("\n")}
          onChange={(value) => {
            const [
              startLevelId = "",
              stableLimitId = "",
              theoryLimitId = "",
              absoluteLimitId = "",
            ] = fixedLineValues(value, 4);
            update({
              coverage: {
                startLevelId: startLevelId || null,
                stableLimitId: stableLimitId || null,
                theoryLimitId: theoryLimitId || null,
                absoluteLimitId: absoluteLimitId || null,
              },
            });
          }}
          multiline
        />
        <Field
          label="成长效果（速度 / 转化 / 质量 / 突破 / 损耗）"
          value={Object.values(item.effects).join("\n")}
          onChange={(value) => {
            const [
              speed = "",
              conversion = "",
              quality = "",
              breakthrough = "",
              loss = "",
            ] = value.split("\n");
            update({
              effects: { speed, conversion, quality, breakthrough, loss },
            });
          }}
          multiline
        />
        <Field
          label="兼容条件（一行一条）"
          value={item.compatibility.join("\n")}
          onChange={(value) => update({ compatibility: textList(value) })}
          multiline
        />
        <Field
          label="风险（一行一条）"
          value={item.risks.join("\n")}
          onChange={(value) => update({ risks: textList(value) })}
          multiline
        />
        <ItemIdsField
          label="关联物品库物品"
          value={item.itemIds}
          entries={itemEntries}
          loading={itemLibraryLoading}
          error={itemLibraryError}
          onChange={(itemIds) => update({ itemIds })}
        />
        <CourseEditor
          value={item.courses}
          levels={levels}
          resources={system.resources}
          onChange={(courses) => update({ courses })}
        />
      </InspectorEditor>
    );
  }
  if (selection?.kind === "topology") {
    const method = methods.find((item) =>
      item.operationTopologies.some((topology) => topology.id === selected),
    );
    const item = method?.operationTopologies.find(
      (topology) => topology.id === selected,
    );
    if (!method || !item) return <InspectorMissing />;
    const update = (patch: Partial<OperationTopology>) =>
      patchSystem({
        methods: updateById(methods, method.id, (current) => ({
          ...current,
          operationTopologies: updateById(
            current.operationTopologies,
            item.id,
            (topology) => ({ ...topology, ...patch }),
          ),
        })),
      });
    return (
      <InspectorEditor
        title={item.name}
        type="法门运行拓扑"
        onDelete={() => {
          patchSystem({
            methods: updateById(methods, method.id, (current) => ({
              ...current,
              operationTopologies: current.operationTopologies.filter(
                (topology) => topology.id !== item.id,
              ),
            })),
            formations: system.formations.map((formation) => ({
              ...formation,
              operationTopologyIds: formation.operationTopologyIds?.filter(
                (topologyId) => topologyId !== item.id,
              ),
            })),
          });
          onSelect?.(null);
        }}
      >
        <Field
          label="拓扑名称"
          value={item.name}
          onChange={(value) => update({ name: value })}
        />
        <Field
          label="拓扑说明"
          value={item.summary}
          onChange={(value) => update({ summary: value })}
          multiline
        />
        <Field
          label="循环规则"
          value={item.cycleRule}
          onChange={(value) => update({ cycleRule: value })}
        />
        <Field
          label="收束规则"
          value={item.closureRule}
          onChange={(value) => update({ closureRule: value })}
        />
        <Field
          label="消耗模型"
          value={item.costModel}
          onChange={(value) => update({ costModel: value })}
          multiline
        />
      </InspectorEditor>
    );
  }
  if (selection?.kind === "topology-node") {
    const method = methods.find((candidate) =>
      candidate.operationTopologies.some(
        (topology) => topology.id === selection.parentId,
      ),
    );
    const topology = method?.operationTopologies.find(
      (candidate) => candidate.id === selection.parentId,
    );
    const item = topology?.nodes.find((node) => node.id === selected);
    if (!method || !topology || !item) return <InspectorMissing />;
    const update = (patch: Partial<typeof item>) =>
      patchSystem({
        methods: updateById(methods, method.id, (current) => ({
          ...current,
          operationTopologies: updateById(
            current.operationTopologies,
            topology.id,
            (currentTopology) => ({
              ...currentTopology,
              nodes: updateById(
                currentTopology.nodes,
                item.id,
                (currentNode) => ({ ...currentNode, ...patch }),
              ),
            }),
          ),
        })),
      });
    return (
      <InspectorEditor
        title={
          theoryNodes.find((node) => node.id === item.theoryNodeId)?.name ??
          item.id
        }
        type="拓扑节点"
        onDelete={() => {
          patchSystem({
            methods: updateById(methods, method.id, (current) => ({
              ...current,
              operationTopologies: updateById(
                current.operationTopologies,
                topology.id,
                (currentTopology) => ({
                  ...currentTopology,
                  nodes: currentTopology.nodes.filter(
                    (node) => node.id !== item.id,
                  ),
                  edges: currentTopology.edges.filter(
                    (edge) =>
                      edge.fromNodeId !== item.id && edge.toNodeId !== item.id,
                  ),
                }),
              ),
            })),
          });
          onSelect?.(null);
        }}
      >
        <SelectField
          label="理论节点"
          value={item.theoryNodeId}
          options={listOptions(theoryNodes)}
          onChange={(value) => update({ theoryNodeId: value })}
        />
        <Field
          label="节点顺序"
          value={String(item.order)}
          onChange={(value) =>
            update({
              order: boundedNumber(
                value,
                0,
                Number.MAX_SAFE_INTEGER,
                item.order,
              ),
            })
          }
          type="number"
          min={0}
          step={1}
        />
        <Field
          label="节点角色"
          value={item.role}
          onChange={(value) => update({ role: value })}
        />
        <Field
          label="运行操作"
          value={item.operation}
          onChange={(value) => update({ operation: value })}
          multiline
        />
        <TopologyColorField
          value={topologyNodeColor(
            item,
            Math.max(
              0,
              topology.nodes.findIndex((node) => node.id === item.id),
            ),
          )}
          onChange={(color) => update({ color })}
        />
        <OrbStyleField
          value={topologyNodeOrbStyle(
            item,
            Math.max(
              0,
              topology.nodes.findIndex((node) => node.id === item.id),
            ),
          )}
          onChange={(orbStyle) => update({ orbStyle })}
        />
      </InspectorEditor>
    );
  }
  if (selection?.kind === "topology-edge") {
    const method = methods.find((candidate) =>
      candidate.operationTopologies.some(
        (topology) => topology.id === selection.parentId,
      ),
    );
    const topology = method?.operationTopologies.find(
      (candidate) => candidate.id === selection.parentId,
    );
    const item = topology?.edges.find((edge) => edge.id === selected);
    if (!method || !topology || !item) return <InspectorMissing />;
    const update = (patch: Partial<typeof item>) =>
      patchSystem({
        methods: updateById(methods, method.id, (current) => ({
          ...current,
          operationTopologies: updateById(
            current.operationTopologies,
            topology.id,
            (currentTopology) => ({
              ...currentTopology,
              edges: updateById(
                currentTopology.edges,
                item.id,
                (currentEdge) => ({ ...currentEdge, ...patch }),
              ),
            }),
          ),
        })),
      });
    const edgeNodeName = (nodeId: string) => {
      const node = topology.nodes.find((candidate) => candidate.id === nodeId);
      return node
        ? theoryNodes.find((theoryNode) => theoryNode.id === node.theoryNodeId)
            ?.name || node.id
        : nodeId;
    };
    const fallbackName = `${edgeNodeName(item.fromNodeId)} → ${edgeNodeName(item.toNodeId)}`;
    return (
      <InspectorEditor
        title={item.name?.trim() || fallbackName}
        type="拓扑流向"
        onDelete={() => {
          patchSystem({
            methods: updateById(methods, method.id, (current) => ({
              ...current,
              operationTopologies: updateById(
                current.operationTopologies,
                topology.id,
                (currentTopology) => ({
                  ...currentTopology,
                  edges: currentTopology.edges.filter(
                    (edge) => edge.id !== item.id,
                  ),
                }),
              ),
            })),
          });
          onSelect?.(null);
        }}
      >
        <Field
          label="连线名称"
          value={item.name ?? ""}
          placeholder={fallbackName}
          onChange={(name) => update({ name })}
        />
        <SelectField
          label="起点节点"
          value={item.fromNodeId}
          options={topology.nodes.map((node) => ({
            value: node.id,
            label:
              theoryNodes.find(
                (theoryNode) => theoryNode.id === node.theoryNodeId,
              )?.name ?? node.id,
          }))}
          onChange={(value) =>
            update({ fromNodeId: value, fromHandleId: undefined })
          }
        />
        <SelectField
          label="终点节点"
          value={item.toNodeId}
          options={topology.nodes.map((node) => ({
            value: node.id,
            label:
              theoryNodes.find(
                (theoryNode) => theoryNode.id === node.theoryNodeId,
              )?.name ?? node.id,
          }))}
          onChange={(value) =>
            update({ toNodeId: value, toHandleId: undefined })
          }
        />
        <Field
          label="顺序"
          value={String(item.order)}
          onChange={(value) =>
            update({
              order: boundedNumber(
                value,
                0,
                Number.MAX_SAFE_INTEGER,
                item.order,
              ),
            })
          }
          type="number"
          min={0}
          step={1}
        />
        <Field
          label="流向规则"
          value={item.routeRule}
          onChange={(value) => update({ routeRule: value })}
          multiline
        />
        <Field
          label="损耗"
          value={item.loss}
          onChange={(value) => update({ loss: value })}
        />
      </InspectorEditor>
    );
  }
  if (selection?.kind === "ability") {
    const item = abilities.find((ability) => ability.id === selected);
    if (!item) return <InspectorMissing />;
    const update = (patch: Partial<Ability>) =>
      patchSystem({
        abilities: updateById(abilities, item.id, (current) => ({
          ...current,
          ...patch,
        })),
      });
    return (
      <InspectorEditor
        title={item.name}
        type={
          item.acquisitionType === "natural"
            ? "境界自动获得能力"
            : "秘籍修炼能力"
        }
        onDelete={() => {
          const next = removeAbilityReferences(system, item.id);
          patchSystem({
            ...next,
            abilities: next.abilities.filter(
              (ability) => ability.id !== item.id,
            ),
          });
          onSelect?.(null);
        }}
      >
        <Field
          label="能力名称"
          value={item.name}
          onChange={(value) => update({ name: value })}
        />
        <Field
          label="摘要"
          value={item.summary}
          onChange={(value) => update({ summary: value })}
          multiline
        />
        <SelectField
          label="功能类型"
          value={item.functionType}
          options={[
            { value: "support", label: "辅助类" },
            { value: "mental", label: "精神类" },
            { value: "offensive", label: "进攻类" },
          ]}
          onChange={(value) =>
            update({ functionType: value as Ability["functionType"] })
          }
        />
        <SelectField
          label="获取方式"
          value={item.acquisitionType}
          options={[
            { value: "natural", label: "境界突破自动解锁" },
            { value: "scripture", label: "秘籍修炼获得" },
          ]}
          onChange={(value) => {
            if (value === "scripture") {
              // Switching to scripture: ensure scriptureSource is non-null.
              // Preserves previously entered data if user toggled away and back.
              update({
                acquisitionType: "scripture",
                scriptureSource: item.scriptureSource ?? {
                  title: item.name,
                  methodId: null,
                  itemIds: [],
                  summary: "",
                },
              });
            } else {
              // Switching to natural: only change acquisitionType, keep
              // scriptureSource intact so it survives a round-trip toggle.
              update({ acquisitionType: value as Ability["acquisitionType"] });
            }
          }}
        />
        <SelectField
          label="解锁境界"
          value={item.unlockLevelId ?? ""}
          options={[{ value: "", label: "未指定" }, ...listOptions(levels)]}
          onChange={(value) => update({ unlockLevelId: value || null })}
        />
        <Field
          label="能力效果"
          value={item.effect}
          onChange={(value) => update({ effect: value })}
          multiline
        />
        <Field
          label="释放能量类型"
          value={item.cast.energyLabel}
          onChange={(value) =>
            update({ cast: { ...item.cast, energyLabel: value } })
          }
        />
        <Field
          label="单次释放消耗"
          value={item.cast.amount}
          onChange={(value) =>
            update({ cast: { ...item.cast, amount: value } })
          }
        />
        <Field
          label="释放模型 / 公式"
          value={item.cast.model}
          onChange={(value) => update({ cast: { ...item.cast, model: value } })}
          multiline
        />
        <Field
          label="冷却 / 恢复"
          value={item.cast.cooldown}
          onChange={(value) =>
            update({ cast: { ...item.cast, cooldown: value } })
          }
        />
        <Field
          label="最低储备"
          value={item.cast.reserve ?? ""}
          onChange={(reserve) => update({ cast: { ...item.cast, reserve } })}
        />
        <Field
          label="持续消耗"
          value={item.cast.sustainedCost ?? ""}
          onChange={(sustainedCost) =>
            update({ cast: { ...item.cast, sustainedCost } })
          }
        />
        <Field
          label="欠费结果"
          value={item.cast.debtConsequence ?? ""}
          onChange={(debtConsequence) =>
            update({ cast: { ...item.cast, debtConsequence } })
          }
          multiline
        />
        <Field
          label="过载阈值"
          value={item.cast.overloadThreshold ?? ""}
          onChange={(overloadThreshold) =>
            update({ cast: { ...item.cast, overloadThreshold } })
          }
        />
        <SelectField
          label="完整发挥境界"
          value={item.cast.fullPowerLevelId ?? ""}
          options={[{ value: "", label: "未指定" }, ...listOptions(levels)]}
          onChange={(fullPowerLevelId) =>
            update({
              cast: {
                ...item.cast,
                fullPowerLevelId: fullPowerLevelId || null,
              },
            })
          }
        />
        <ReleaseCostsField
          value={item.cast.releaseCosts ?? []}
          onChange={(releaseCosts) =>
            update({ cast: { ...item.cast, releaseCosts } })
          }
        />
        <Field
          label="作用范围"
          value={item.range}
          onChange={(value) => update({ range: value })}
        />
        <Field
          label="持续时间"
          value={item.duration}
          onChange={(value) => update({ duration: value })}
        />
        <Field
          label="训练条件（一行一条）"
          value={item.trainingRequirements.conditions.join("\n")}
          onChange={(value) =>
            update({
              trainingRequirements: {
                ...item.trainingRequirements,
                conditions: textList(value),
              },
            })
          }
          multiline
        />
        <SystemMultiSelectField
          label="训练法门"
          value={item.trainingRequirements.methodIds}
          options={listOptions(methods)}
          onChange={(methodIds) =>
            update({
              trainingRequirements: {
                ...item.trainingRequirements,
                methodIds,
              },
            })
          }
        />
        <ResourceRequirementsField
          label="训练资源需求"
          value={item.trainingRequirements.resourceRequirements}
          resources={system.resources}
          defaultPurpose="train"
          onChange={(resourceRequirements) =>
            update({
              trainingRequirements: {
                ...item.trainingRequirements,
                resourceRequirements,
              },
            })
          }
        />
        <Field
          label="掌握判定公式"
          value={item.trainingRequirements.masteryFormula}
          onChange={(value) =>
            update({
              trainingRequirements: {
                ...item.trainingRequirements,
                masteryFormula: value,
              },
            })
          }
          multiline
        />
        <Field
          label="进攻能力放大模型"
          value={item.amplificationModel}
          onChange={(value) => update({ amplificationModel: value })}
          multiline
        />
        <Field
          label="限制（一行一条）"
          value={item.limitations.join("\n")}
          onChange={(value) => update({ limitations: textList(value) })}
          multiline
        />
        <Field
          label="反制方式（一行一条）"
          value={item.counters.join("\n")}
          onChange={(value) => update({ counters: textList(value) })}
          multiline
        />
        {item.acquisitionType === "scripture" && item.scriptureSource && (
          <>
            <Field
              label="秘籍标题"
              value={item.scriptureSource.title}
              onChange={(value) =>
                update({
                  scriptureSource: { ...item.scriptureSource!, title: value },
                })
              }
            />
            <ItemIdsField
              label="秘籍来源物品库物品"
              value={item.scriptureSource.itemIds}
              entries={itemEntries}
              loading={itemLibraryLoading}
              error={itemLibraryError}
              onChange={(itemIds) =>
                update({
                  scriptureSource: { ...item.scriptureSource!, itemIds },
                })
              }
            />
            <SelectField
              label="来源法门"
              value={item.scriptureSource.methodId ?? ""}
              options={[
                { value: "", label: "未指定" },
                ...listOptions(methods),
              ]}
              onChange={(value) =>
                update({
                  scriptureSource: {
                    ...item.scriptureSource!,
                    methodId: value || null,
                  },
                })
              }
            />
            <Field
              label="秘籍说明"
              value={item.scriptureSource.summary}
              onChange={(value) =>
                update({
                  scriptureSource: { ...item.scriptureSource!, summary: value },
                })
              }
              multiline
            />
          </>
        )}
      </InspectorEditor>
    );
  }
  if (selection?.kind === "track") {
    const item = system.progressionTracks.find(
      (track) => track.id === selected,
    );
    if (!item) return <InspectorMissing />;
    const update = (patch: Partial<ProgressionTrack>) =>
      patchSystem({
        progressionTracks: updateById(
          system.progressionTracks,
          item.id,
          (current) => ({ ...current, ...patch }),
        ),
      });
    return (
      <InspectorEditor
        title={item.name}
        type="成长轨道"
        onDelete={() => {
          patchSystem(removeTrackReferences(system, item.id));
          onSelect?.(null);
        }}
      >
        <Field
          label="轨道名称"
          value={item.name}
          onChange={(value) => update({ name: value })}
        />
        <Field
          label="轨道摘要"
          value={item.summary}
          onChange={(value) => update({ summary: value })}
          multiline
        />
        <Field
          label="成长模式"
          value={item.mode}
          onChange={(value) => update({ mode: value })}
        />
        <SelectField
          label="结构"
          value={item.structure}
          options={[
            { value: "ordered", label: "有序" },
            { value: "branching", label: "分支" },
            { value: "cyclic", label: "循环" },
            { value: "free", label: "自由" },
          ]}
          onChange={(value) =>
            update({ structure: value as ProgressionTrack["structure"] })
          }
        />
      </InspectorEditor>
    );
  }
  if (selection?.kind === "track-interaction") {
    const item = (system.trackInteractions ?? []).find(
      (interaction) => interaction.id === selected,
    );
    if (!item) return <InspectorMissing />;
    const update = (patch: Partial<TrackInteraction>) =>
      patchSystem({
        trackInteractions: (system.trackInteractions ?? []).map(
          (interaction) =>
            interaction.id === item.id
              ? { ...interaction, ...patch }
              : interaction,
        ),
      });
    return (
      <InspectorEditor
        title={item.name}
        type="多轨道交叉规则"
        onDelete={() => {
          patchSystem({
            trackInteractions: (system.trackInteractions ?? []).filter(
              (interaction) => interaction.id !== item.id,
            ),
          });
          onSelect?.(null);
        }}
      >
        <Field
          label="规则名称"
          value={item.name}
          onChange={(name) => update({ name })}
        />
        <Field
          label="摘要"
          value={item.summary}
          onChange={(summary) => update({ summary })}
          multiline
        />
        <SelectField
          label="源轨道"
          value={item.sourceTrackId}
          options={listOptions(system.progressionTracks)}
          onChange={(sourceTrackId) => update({ sourceTrackId })}
        />
        <SelectField
          label="目标轨道"
          value={item.targetTrackId}
          options={listOptions(system.progressionTracks)}
          onChange={(targetTrackId) => update({ targetTrackId })}
        />
        <SelectField
          label="规则类型"
          value={item.kind}
          options={[
            { value: "synchronization", label: "同步约束" },
            { value: "synergy", label: "协同效应" },
            { value: "imbalance", label: "失衡惩罚" },
            { value: "cross-breakthrough", label: "跨轨道突破" },
            { value: "resource-competition", label: "资源竞争" },
            { value: "dependency", label: "依赖" },
          ]}
          onChange={(kind) =>
            update({ kind: kind as TrackInteraction["kind"] })
          }
        />
        <Field
          label="规则"
          value={item.rule}
          onChange={(rule) => update({ rule })}
          multiline
        />
        <Field
          label="条件（一行一条）"
          value={item.conditions.join("\n")}
          onChange={(text) => update({ conditions: textList(text) })}
          multiline
        />
        <Field
          label="结果 / 惩罚"
          value={item.consequence}
          onChange={(consequence) => update({ consequence })}
          multiline
        />
        <Field
          label="资源分配策略"
          value={item.resourcePolicy}
          onChange={(resourcePolicy) => update({ resourcePolicy })}
          multiline
        />
        <SelectField
          label="是否可逆"
          value={item.reversible ? "true" : "false"}
          options={[
            { value: "true", label: "可逆" },
            { value: "false", label: "不可逆" },
          ]}
          onChange={(value) => update({ reversible: value === "true" })}
        />
      </InspectorEditor>
    );
  }
  if (selection?.kind === "metric") {
    const track =
      system.progressionTracks.find(
        (candidate) => candidate.id === selection.parentId,
      ) ??
      system.progressionTracks.find((candidate) =>
        candidate.metrics.some((metric) => metric.id === selected),
      );
    const item = track?.metrics.find((metric) => metric.id === selected);
    if (!track || !item) return <InspectorMissing />;
    const update = (patch: Partial<typeof item>) =>
      patchSystem({
        progressionTracks: updateById(
          system.progressionTracks,
          track.id,
          (current) => ({
            ...current,
            metrics: updateById(current.metrics, item.id, (metric) => ({
              ...metric,
              ...patch,
            })),
          }),
        ),
      });
    return (
      <InspectorEditor
        title={item.name}
        type="成长指标"
        onDelete={() => {
          patchSystem({
            progressionTracks: updateById(
              system.progressionTracks,
              track.id,
              (current) => ({
                ...current,
                metrics: current.metrics.filter(
                  (metric) => metric.id !== item.id,
                ),
                levels: current.levels.map((level) => ({
                  ...level,
                  metricThresholds: level.metricThresholds.filter(
                    (threshold) => threshold.metricId !== item.id,
                  ),
                  subStages: level.subStages.map((stage) => ({
                    ...stage,
                    metricThresholds: stage.metricThresholds.filter(
                      (threshold) => threshold.metricId !== item.id,
                    ),
                  })),
                })),
              }),
            ),
          });
          onSelect?.(null);
        }}
      >
        <Field
          label="指标名称"
          value={item.name}
          onChange={(value) => update({ name: value })}
        />
        <Field
          label="摘要"
          value={item.summary}
          onChange={(value) => update({ summary: value })}
          multiline
        />
        <Field
          label="单位"
          value={item.unit}
          onChange={(value) => update({ unit: value })}
        />
        <SelectField
          label="数值模型"
          value={item.model}
          options={[
            { value: "number", label: "数值" },
            { value: "range", label: "区间" },
            { value: "formula", label: "公式" },
            { value: "descriptive", label: "描述" },
          ]}
          onChange={(value) => update({ model: value as typeof item.model })}
        />
        <SelectField
          label="方向"
          value={item.direction}
          options={[
            { value: "higher-better", label: "越高越好" },
            { value: "lower-better", label: "越低越好" },
            { value: "neutral", label: "中性" },
          ]}
          onChange={(value) =>
            update({ direction: value as typeof item.direction })
          }
        />
        <Field
          label="基线"
          value={item.baseline}
          onChange={(value) => update({ baseline: value })}
        />
      </InspectorEditor>
    );
  }
  if (selection?.kind === "level-stage") {
    const track =
      system.progressionTracks.find(
        (candidate) => candidate.id === selection.grandParentId,
      ) ??
      system.progressionTracks.find((candidate) =>
        candidate.levels.some((level) =>
          level.subStages.some((stage) => stage.id === selected),
        ),
      );
    const level =
      track?.levels.find((candidate) => candidate.id === selection.parentId) ??
      track?.levels.find((candidate) =>
        candidate.subStages.some((stage) => stage.id === selected),
      );
    const item = level?.subStages.find((stage) => stage.id === selected);
    if (!track || !level || !item) return <InspectorMissing />;
    const update = (patch: Partial<CultivationLevelSubStage>) =>
      patchSystem({
        progressionTracks: updateById(
          system.progressionTracks,
          track.id,
          (current) => ({
            ...current,
            levels: updateById(current.levels, level.id, (currentLevel) => ({
              ...currentLevel,
              subStages: updateById(
                currentLevel.subStages,
                item.id,
                (stage) => ({ ...stage, ...patch }),
              ),
            })),
          }),
        ),
      });
    return (
      <InspectorEditor
        title={item.name}
        type={`境内阶段 / ${level.name}`}
        onDelete={() => {
          patchSystem({
            progressionTracks: updateById(
              system.progressionTracks,
              track.id,
              (current) => ({
                ...current,
                levels: updateById(
                  current.levels,
                  level.id,
                  (currentLevel) => ({
                    ...currentLevel,
                    subStages: currentLevel.subStages
                      .filter((stage) => stage.id !== item.id)
                      .map((stage, order) => ({ ...stage, order })),
                  }),
                ),
              }),
            ),
          });
          onSelect?.({
            kind: "level",
            id: level.id,
            parentId: track.id,
            parentKind: "track",
          });
        }}
      >
        <Field
          label="阶段名称"
          value={item.name}
          onChange={(name) => update({ name })}
        />
        <Field
          label="阶段顺序"
          value={String(item.order)}
          type="number"
          min={0}
          step={1}
          onChange={(value) =>
            update({
              order: boundedNumber(
                value,
                0,
                Number.MAX_SAFE_INTEGER,
                item.order,
              ),
            })
          }
        />
        <Field
          label="阶段摘要"
          value={item.summary}
          onChange={(summary) => update({ summary })}
          multiline
        />
        <MetricThresholdsField
          label="阶段指标门槛"
          value={item.metricThresholds}
          metrics={track.metrics}
          onChange={(metricThresholds) => update({ metricThresholds })}
        />
        <Field
          label="进入条件（一行一条）"
          value={item.entryConditions.join("\n")}
          onChange={(value) => update({ entryConditions: textList(value) })}
          multiline
        />
        <Field
          label="完成条件（一行一条）"
          value={item.completionConditions.join("\n")}
          onChange={(value) =>
            update({ completionConditions: textList(value) })
          }
          multiline
        />
        <ResourceRequirementsField
          label="阶段资源需求"
          value={item.resourceRequirements}
          resources={system.resources}
          defaultPurpose="train"
          onChange={(resourceRequirements) => update({ resourceRequirements })}
        />
        <SystemMultiSelectField
          label="阶段自然能力"
          value={item.naturalAbilityIds}
          options={listOptions(abilities)}
          onChange={(naturalAbilityIds) => update({ naturalAbilityIds })}
        />
        <SystemMultiSelectField
          label="阶段可用法门"
          value={item.methodIds}
          options={listOptions(methods)}
          onChange={(methodIds) => update({ methodIds })}
        />
      </InspectorEditor>
    );
  }
  if (selection?.kind === "level") {
    const track =
      system.progressionTracks.find(
        (candidate) => candidate.id === selection.parentId,
      ) ??
      system.progressionTracks.find((candidate) =>
        candidate.levels.some((level) => level.id === selected),
      );
    const item = track?.levels.find((level) => level.id === selected);
    if (!track || !item) return <InspectorMissing />;
    const update = (patch: Partial<CultivationLevel>) =>
      patchSystem({
        progressionTracks: updateById(
          system.progressionTracks,
          track.id,
          (current) => ({
            ...current,
            levels: updateById(current.levels, item.id, (level) => ({
              ...level,
              ...patch,
            })),
          }),
        ),
      });
    const insertLevel = (position: "before" | "after") => {
      const currentIndex = track.levels.findIndex(
        (level) => level.id === item.id,
      );
      if (currentIndex < 0) return;
      const insertionIndex = currentIndex + (position === "after" ? 1 : 0);
      const nextLevel = createLevel(insertionIndex);
      const levels = [...track.levels];
      levels.splice(insertionIndex, 0, nextLevel);
      patchSystem({
        progressionTracks: updateById(
          system.progressionTracks,
          track.id,
          (current) => ({
            ...current,
            levels: levels.map((level, order) => ({ ...level, order })),
          }),
        ),
      });
      onSelect?.({
        kind: "level",
        id: nextLevel.id,
        parentId: track.id,
        parentKind: "track",
      });
    };
    return (
      <InspectorEditor
        title={item.name}
        type="成长境界"
        onDelete={() => {
          const next = removeLevelReferences(system, new Set([item.id]));
          patchSystem({
            ...next,
            progressionTracks: updateById(
              next.progressionTracks,
              track.id,
              (current) => ({
                ...current,
                levels: current.levels.filter((level) => level.id !== item.id),
              }),
            ),
          });
          onSelect?.(null);
        }}
      >
        <div
          className="ce-inspector-insert-actions"
          role="group"
          aria-label="插入成长境界"
        >
          <Button variant="secondary" onClick={() => insertLevel("before")}>
            <Plus className="h-3.5 w-3.5" />
            前插境界
          </Button>
          <Button variant="secondary" onClick={() => insertLevel("after")}>
            <Plus className="h-3.5 w-3.5" />
            后插境界
          </Button>
        </div>
        <Field
          label="境界名称"
          value={item.name}
          onChange={(value) => update({ name: value })}
        />
        <Field
          label="境界顺序"
          value={String(item.order)}
          onChange={(value) =>
            update({
              order: boundedNumber(
                value,
                0,
                Number.MAX_SAFE_INTEGER,
                item.order,
              ),
            })
          }
          type="number"
          min={0}
          step={1}
        />
        <Field
          label="境界类型"
          value={item.stageType}
          onChange={(value) => update({ stageType: value })}
        />
        <Field
          label="境界摘要"
          value={item.summary}
          onChange={(value) => update({ summary: value })}
          multiline
        />
        <Field
          label="境界质量"
          value={item.quality}
          onChange={(value) => update({ quality: value })}
        />
        <MetricThresholdsField
          label="指标门槛"
          value={item.metricThresholds}
          metrics={track.metrics}
          onChange={(value) => update({ metricThresholds: value })}
        />
        <Field
          label="进入条件（一行一条）"
          value={item.entryConditions.join("\n")}
          onChange={(value) => update({ entryConditions: textList(value) })}
          multiline
        />
        <Field
          label="维持条件（一行一条）"
          value={item.maintenanceConditions.join("\n")}
          onChange={(value) =>
            update({ maintenanceConditions: textList(value) })
          }
          multiline
        />
        <Field
          label="突破条件（一行一条）"
          value={item.breakthroughConditions.join("\n")}
          onChange={(value) =>
            update({ breakthroughConditions: textList(value) })
          }
          multiline
        />
        <Field
          label="突破结果"
          value={item.breakthroughResult}
          onChange={(value) => update({ breakthroughResult: value })}
          multiline
        />
        <Field
          label="失败后果（一行一条）"
          value={item.failureConsequences.join("\n")}
          onChange={(value) => update({ failureConsequences: textList(value) })}
          multiline
        />
        <Field
          label="境界退化"
          value={item.degeneration}
          onChange={(value) => update({ degeneration: value })}
          multiline
        />
        <ResourceRequirementsField
          label="境界资源需求"
          value={item.resourceRequirements}
          resources={system.resources}
          defaultPurpose="breakthrough"
          onChange={(resourceRequirements) => update({ resourceRequirements })}
        />
        <SystemMultiSelectField
          label="自然能力"
          value={item.naturalAbilityIds}
          options={listOptions(abilities)}
          onChange={(value) => update({ naturalAbilityIds: value })}
        />
        <SystemMultiSelectField
          label="可用法门"
          value={item.methodIds}
          options={listOptions(methods)}
          onChange={(value) => update({ methodIds: value })}
        />
      </InspectorEditor>
    );
  }
  if (selection?.kind === "formation") {
    const item = system.formations.find(
      (formation) => formation.id === selected,
    );
    if (!item) return <InspectorMissing />;
    const update = (patch: Partial<Formation>) =>
      patchSystem({
        formations: updateById(system.formations, item.id, (current) => ({
          ...current,
          ...patch,
        })),
      });
    const applyBackdropPreset = (value: string) => {
      if (value === "custom") {
        update({ design: { ...item.design, presetId: "custom" } });
        return;
      }
      const preset = createFormationBackdropPreset(
        value as FormationBackdropPresetId,
        () => newEcologyId("formation-backdrop"),
      );
      update({ design: { ...item.design, ...preset } });
    };
    const updateBackdropDesign = (
      patch: Partial<
        Pick<Formation["design"], "backgroundColor" | "palette" | "effects">
      >,
    ) =>
      update({
        design: { ...item.design, ...patch, presetId: "custom" },
      });
    const backdropColorFallback =
      FORMATION_BACKDROP_PRESETS.find(
        (preset) => preset.id === item.design.presetId,
      )?.backgroundColor ?? FORMATION_BACKDROP_PRESETS[0].backgroundColor;
    return (
      <InspectorEditor
        title={item.name}
        type="阵法与部署"
        onDelete={() => {
          patchSystem({
            formations: system.formations.filter(
              (formation) => formation.id !== item.id,
            ),
          });
          onSelect?.(null);
        }}
      >
        <Field
          label="阵法名称"
          value={item.name}
          onChange={(value) => update({ name: value })}
        />
        <Field
          label="摘要"
          value={item.summary}
          onChange={(value) => update({ summary: value })}
          multiline
        />
        <Field
          label="类别"
          value={item.category}
          onChange={(value) => update({ category: value })}
        />
        <SelectField
          label="结构"
          value={item.structure}
          options={[
            { value: "planar", label: "平面" },
            { value: "spatial", label: "空间" },
            { value: "network", label: "网络" },
            { value: "mobile", label: "移动" },
            { value: "embedded", label: "嵌入" },
          ]}
          onChange={(value) =>
            update({ structure: value as Formation["structure"] })
          }
        />
        <SelectField
          label="阵图布局"
          value={item.design.layout}
          options={[
            { value: "free", label: "自由布局" },
            { value: "radial", label: "放射布局" },
            { value: "concentric", label: "同心布局" },
          ]}
          onChange={(value) =>
            update({
              design: {
                ...item.design,
                layout: value as Formation["design"]["layout"],
              },
            })
          }
        />
        <SelectField
          label="底图预设"
          value={item.design.presetId}
          options={FORMATION_BACKDROP_PRESET_OPTIONS}
          onChange={applyBackdropPreset}
        />
        <SelectField
          label="阵盘风格"
          value={item.design.canvasStyle}
          options={[
            { value: "mystic", label: "玄纹拟真" },
            { value: "technical", label: "结构详图" },
          ]}
          onChange={(value) =>
            update({
              design: {
                ...item.design,
                canvasStyle: value as Formation["design"]["canvasStyle"],
              },
            })
          }
        />
        <TopologyColorField
          label="阵盘底色"
          value={item.design.backgroundColor}
          allowTransparent
          transparentFallback={backdropColorFallback}
          onChange={(backgroundColor) =>
            updateBackdropDesign({ backgroundColor })
          }
        />
        <TopologyColorField
          label="底纹主色"
          value={item.design.palette.primary}
          onChange={(primary) =>
            updateBackdropDesign({
              palette: { ...item.design.palette, primary },
            })
          }
        />
        <TopologyColorField
          label="底纹辅色"
          value={item.design.palette.secondary}
          onChange={(secondary) =>
            updateBackdropDesign({
              palette: { ...item.design.palette, secondary },
            })
          }
        />
        <TopologyColorField
          label="底纹强调色"
          value={item.design.palette.accent}
          onChange={(accent) =>
            updateBackdropDesign({
              palette: { ...item.design.palette, accent },
            })
          }
        />
        <TopologyColorField
          label="发光颜色"
          value={item.design.palette.glow}
          onChange={(glow) =>
            updateBackdropDesign({
              palette: { ...item.design.palette, glow },
            })
          }
        />
        <Field
          label="发光强度"
          value={String(item.design.effects.glowStrength)}
          onChange={(value) =>
            updateBackdropDesign({
              effects: {
                ...item.design.effects,
                glowStrength: boundedNumber(
                  value,
                  0,
                  1,
                  item.design.effects.glowStrength,
                ),
              },
            })
          }
          type="number"
          min={0}
          max={1}
          step={0.05}
        />
        <Field
          label="整体线条透明度"
          value={String(item.design.effects.lineOpacity)}
          onChange={(value) =>
            updateBackdropDesign({
              effects: {
                ...item.design.effects,
                lineOpacity: boundedNumber(
                  value,
                  0.15,
                  1,
                  item.design.effects.lineOpacity,
                ),
              },
            })
          }
          type="number"
          min={0.15}
          max={1}
          step={0.05}
        />
        <SelectField
          label="底纹动效"
          value={item.design.effects.motion}
          options={[
            { value: "still", label: "静止" },
            { value: "rotate", label: "缓慢旋转" },
            { value: "pulse", label: "灵光呼吸" },
          ]}
          onChange={(value) =>
            updateBackdropDesign({
              effects: {
                ...item.design.effects,
                motion: value as Formation["design"]["effects"]["motion"],
              },
            })
          }
        />
        <Field
          label="用途"
          value={item.purpose}
          onChange={(value) => update({ purpose: value })}
          multiline
        />
        <Field
          label="规模"
          value={item.scale}
          onChange={(scale) => update({ scale })}
        />
        <Field
          label="阵源：能量从何而来"
          value={item.sixElements.source}
          onChange={(source) =>
            update({ sixElements: { ...item.sixElements, source } })
          }
          multiline
        />
        <Field
          label="阵基：能量依附于何物"
          value={item.sixElements.foundation}
          onChange={(foundation) =>
            update({ sixElements: { ...item.sixElements, foundation } })
          }
          multiline
        />
        <Field
          label="阵纹：能量如何流动"
          value={item.sixElements.pattern}
          onChange={(pattern) =>
            update({ sixElements: { ...item.sixElements, pattern } })
          }
          multiline
        />
        <Field
          label="阵眼：谁来控制"
          value={item.sixElements.eye}
          onChange={(eye) =>
            update({ sixElements: { ...item.sixElements, eye } })
          }
          multiline
        />
        <Field
          label="阵域：影响范围"
          value={item.sixElements.domain}
          onChange={(domain) =>
            update({ sixElements: { ...item.sixElements, domain } })
          }
          multiline
        />
        <Field
          label="阵则：局部覆写规则"
          value={item.sixElements.law}
          onChange={(law) =>
            update({ sixElements: { ...item.sixElements, law } })
          }
          multiline
        />
        <Field
          label="反制措施"
          value={item.countermeasures}
          onChange={(countermeasures) => update({ countermeasures })}
          multiline
        />
        <SystemMultiSelectField
          label="引用法门运行拓扑"
          value={item.operationTopologyIds ?? []}
          options={methods.flatMap((method) =>
            method.operationTopologies.map((topology) => ({
              value: topology.id,
              label: `${method.name} · ${topology.name}`,
            })),
          )}
          onChange={(operationTopologyIds) => update({ operationTopologyIds })}
        />
        <SystemMultiSelectField
          label="理论节点"
          value={item.theoryNodeIds}
          options={listOptions(theoryNodes)}
          onChange={(theoryNodeIds) => update({ theoryNodeIds })}
        />
        <SystemMultiSelectField
          label="所需境界"
          value={item.requiredLevelIds}
          options={listOptions(levels)}
          onChange={(requiredLevelIds) => update({ requiredLevelIds })}
        />
        <SystemMultiSelectField
          label="关联法门"
          value={item.methodIds}
          options={listOptions(methods)}
          onChange={(methodIds) => update({ methodIds })}
        />
        <SystemMultiSelectField
          label="关联能力"
          value={item.abilityIds}
          options={listOptions(abilities)}
          onChange={(abilityIds) => update({ abilityIds })}
        />
        <ResourceRequirementsField
          label="阵法资源需求"
          value={item.resourceRequirements}
          resources={system.resources}
          defaultPurpose="activate"
          onChange={(resourceRequirements) => update({ resourceRequirements })}
        />
        <ItemIdsField
          label="阵法关联物品库物品"
          value={item.itemIds}
          entries={itemEntries}
          loading={itemLibraryLoading}
          error={itemLibraryError}
          onChange={(itemIds) => update({ itemIds })}
        />
        <Field
          label="激活条件（一行一条）"
          value={item.activationConditions.join("\n")}
          onChange={(value) =>
            update({ activationConditions: textList(value) })
          }
          multiline
        />
        <Field
          label="激活方式"
          value={item.activation}
          onChange={(activation) => update({ activation })}
          multiline
        />
        <Field
          label="维护规则"
          value={item.maintenance}
          onChange={(value) => update({ maintenance: value })}
          multiline
        />
        <Field
          label="输出"
          value={item.output}
          onChange={(value) => update({ output: value })}
          multiline
        />
        <Field
          label="边界"
          value={item.boundary}
          onChange={(value) => update({ boundary: value })}
          multiline
        />
        <Field
          label="风险（一行一条）"
          value={item.risks.join("\n")}
          onChange={(value) => update({ risks: textList(value) })}
          multiline
        />
      </InspectorEditor>
    );
  }
  if (selection?.kind === "formation-backdrop-layer") {
    const formation = system.formations.find(
      (candidate) => candidate.id === selection.parentId,
    );
    const item = formation?.design.backdropLayers.find(
      (layer) => layer.id === selected,
    );
    if (!formation || !item) return <InspectorMissing />;
    const update = (patch: Partial<FormationBackdropLayer>) =>
      patchSystem({
        formations: updateById(system.formations, formation.id, (current) => ({
          ...current,
          design: {
            ...current.design,
            presetId: "custom",
            backdropLayers: updateById(
              current.design.backdropLayers,
              item.id,
              (layer) => ({ ...layer, ...patch }),
            ),
          },
        })),
      });
    const countMaximum =
      item.type === "ring"
        ? 8
        : item.type === "star"
          ? 32
          : item.type === "arc-petals"
            ? 12
            : item.type === "ornament-ring"
              ? 32
              : 96;
    const countLabel =
      item.type === "ring"
        ? "环线数量"
        : item.type === "star"
          ? "星芒数量"
          : item.type === "radial-rays"
            ? "射线数量"
            : item.type === "arc-petals"
              ? "弧阵数量"
              : "饰件数量";
    const hasCount = [
      "ring",
      "star",
      "radial-rays",
      "arc-petals",
      "ornament-ring",
    ].includes(item.type);
    const canDuplicate =
      formation.design.backdropLayers.length < MAX_FORMATION_BACKDROP_LAYERS;
    return (
      <InspectorEditor
        title={item.name}
        type="阵法底纹"
        onDelete={() => {
          patchSystem({
            formations: updateById(
              system.formations,
              formation.id,
              (current) => ({
                ...current,
                design: {
                  ...current.design,
                  presetId: "custom",
                  backdropLayers: current.design.backdropLayers
                    .filter((layer) => layer.id !== item.id)
                    .sort((left, right) => left.order - right.order)
                    .map((layer, order) => ({ ...layer, order })),
                },
              }),
            ),
          });
          onSelect?.(null);
        }}
      >
        <Button
          variant="secondary"
          disabled={!canDuplicate}
          title={
            canDuplicate
              ? "复制当前底纹"
              : `底纹最多 ${MAX_FORMATION_BACKDROP_LAYERS} 层`
          }
          onClick={() => {
            if (!canDuplicate) return;
            const duplicate: FormationBackdropLayer = {
              ...item,
              id: newEcologyId("formation-backdrop"),
              name: `${item.name} 副本`,
              order: formation.design.backdropLayers.length,
            };
            patchSystem({
              formations: updateById(
                system.formations,
                formation.id,
                (current) => ({
                  ...current,
                  design: {
                    ...current.design,
                    presetId: "custom",
                    backdropLayers: [
                      ...current.design.backdropLayers,
                      duplicate,
                    ],
                  },
                }),
              ),
            });
            onSelect?.({
              kind: "formation-backdrop-layer",
              id: duplicate.id,
              parentId: formation.id,
              parentKind: "formation",
            });
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          复制底纹
        </Button>
        <Field
          label="底纹名称"
          value={item.name}
          onChange={(name) => update({ name })}
        />
        <SelectField
          label="底纹类型"
          value={item.type}
          options={FORMATION_BACKDROP_LAYER_TYPE_OPTIONS}
          onChange={(value) =>
            update({ type: value as FormationBackdropLayer["type"] })
          }
        />
        <Field
          label={item.type === "radial-rays" ? "外半径" : "基准半径"}
          value={String(item.radius)}
          onChange={(value) =>
            update({
              radius: boundedNumber(
                value,
                20,
                FORMATION_MAX_RADIUS,
                item.radius,
              ),
            })
          }
          type="number"
          min={20}
          max={FORMATION_MAX_RADIUS}
          step={1}
        />
        {item.type === "radial-rays" && (
          <Field
            label="内半径"
            value={String(item.innerRadius)}
            onChange={(value) =>
              update({
                innerRadius: boundedNumber(
                  value,
                  0,
                  Math.min(FORMATION_MAX_RADIUS, item.radius),
                  item.innerRadius,
                ),
              })
            }
            type="number"
            min={0}
            max={Math.min(FORMATION_MAX_RADIUS, item.radius)}
            step={1}
          />
        )}
        {hasCount && (
          <Field
            label={countLabel}
            value={String(item.count)}
            onChange={(value) =>
              update({
                count: Math.round(
                  boundedNumber(value, 1, countMaximum, item.count),
                ),
              })
            }
            type="number"
            min={1}
            max={countMaximum}
            step={1}
          />
        )}
        {item.type === "ring" && (
          <Field
            label="环线间距"
            value={String(item.spacing)}
            onChange={(value) =>
              update({
                spacing: boundedNumber(value, 0, 48, item.spacing),
              })
            }
            type="number"
            min={0}
            max={48}
            step={1}
          />
        )}
        {item.type === "polygon" && (
          <>
            <Field
              label="多边形边数"
              value={String(item.sides)}
              onChange={(value) =>
                update({
                  sides: Math.round(boundedNumber(value, 3, 24, item.sides)),
                })
              }
              type="number"
              min={3}
              max={24}
              step={1}
            />
            <Field
              label="顶点跨步"
              value={String(item.step)}
              onChange={(value) =>
                update({
                  step: Math.round(
                    boundedNumber(
                      value,
                      1,
                      Math.min(12, item.sides - 1),
                      item.step,
                    ),
                  ),
                })
              }
              type="number"
              min={1}
              max={Math.min(12, item.sides - 1)}
              step={1}
            />
          </>
        )}
        {item.type === "star" && (
          <Field
            label="内外半径比例"
            value={String(item.innerRatio)}
            onChange={(value) =>
              update({
                innerRatio: boundedNumber(value, 0.08, 0.92, item.innerRatio),
              })
            }
            type="number"
            min={0.08}
            max={0.92}
            step={0.02}
          />
        )}
        {item.type === "arc-petals" && (
          <Field
            label="弧线曲率"
            value={String(item.curvature)}
            onChange={(value) =>
              update({
                curvature: boundedNumber(value, 0.1, 1.5, item.curvature),
              })
            }
            type="number"
            min={0.1}
            max={1.5}
            step={0.05}
          />
        )}
        {item.type === "rune-band" && (
          <>
            <Field
              label="环绕铭文"
              value={item.text}
              onChange={(text) => update({ text })}
              multiline
            />
            <Field
              label="铭文重复次数"
              value={String(item.repeat)}
              onChange={(value) =>
                update({
                  repeat: Math.round(boundedNumber(value, 1, 16, item.repeat)),
                })
              }
              type="number"
              min={1}
              max={16}
              step={1}
            />
          </>
        )}
        {(item.type === "ornament-ring" || item.type === "core-symbol") && (
          <SelectField
            label="图腾符号"
            value={item.symbol}
            options={FORMATION_BACKDROP_SYMBOL_OPTIONS}
            onChange={(value) =>
              update({
                symbol: value as FormationBackdropLayer["symbol"],
              })
            }
          />
        )}
        <Field
          label="旋转角度"
          value={String(item.rotation)}
          onChange={(value) =>
            update({ rotation: boundedNumber(value, -360, 360, item.rotation) })
          }
          type="number"
          min={-360}
          max={360}
          step={1}
        />
        <SwitchField
          label="旋转动效"
          checked={item.rotating}
          onChange={(rotating) => update({ rotating })}
        />
        <Field
          label="线条宽度"
          value={String(item.strokeWidth)}
          onChange={(value) =>
            update({
              strokeWidth: boundedNumber(value, 0.5, 8, item.strokeWidth),
            })
          }
          type="number"
          min={0.5}
          max={8}
          step={0.5}
        />
        <Field
          label="图层透明度"
          value={String(item.opacity)}
          onChange={(value) =>
            update({ opacity: boundedNumber(value, 0.05, 1, item.opacity) })
          }
          type="number"
          min={0.05}
          max={1}
          step={0.05}
        />
        <TopologyColorField
          label="图层主色"
          value={item.color}
          onChange={(color) => update({ color })}
        />
        <TopologyColorField
          label="图层辅色"
          value={item.secondaryColor}
          onChange={(secondaryColor) => update({ secondaryColor })}
        />
        <SelectField
          label="显示状态"
          value={item.visible ? "visible" : "hidden"}
          options={[
            { value: "visible", label: "显示" },
            { value: "hidden", label: "隐藏" },
          ]}
          onChange={(value) => update({ visible: value === "visible" })}
        />
      </InspectorEditor>
    );
  }
  if (selection?.kind === "formation-ring") {
    const formation = system.formations.find(
      (candidate) => candidate.id === selection.parentId,
    );
    const item = formation?.design.rings.find((ring) => ring.id === selected);
    if (!formation || !item) return <InspectorMissing />;
    const update = (patch: Partial<typeof item>) =>
      patchSystem({
        formations: updateById(system.formations, formation.id, (current) => ({
          ...current,
          design: {
            ...current.design,
            rings: updateById(current.design.rings, item.id, (ring) => ({
              ...ring,
              ...patch,
            })),
          },
        })),
      });
    return (
      <InspectorEditor
        title={item.name}
        type="阵法环层"
        onDelete={() => {
          patchSystem({
            formations: updateById(
              system.formations,
              formation.id,
              (current) => ({
                ...current,
                design: {
                  ...current.design,
                  rings: current.design.rings.filter(
                    (ring) => ring.id !== item.id,
                  ),
                },
                nodes: current.nodes.map((node) =>
                  node.ringId === item.id ? { ...node, ringId: null } : node,
                ),
              }),
            ),
          });
          onSelect?.(null);
        }}
      >
        <Field
          label="环层名称"
          value={item.name}
          onChange={(name) => update({ name })}
        />
        <SelectField
          label="环层样式"
          value={item.style}
          options={[
            { value: "solid", label: "单实线" },
            { value: "double", label: "双重环" },
            { value: "dashed", label: "断续环" },
            { value: "runic", label: "符文环" },
            { value: "polygon", label: "多边环" },
          ]}
          onChange={(value) =>
            update({
              style: value as Formation["design"]["rings"][number]["style"],
            })
          }
        />
        <Field
          label="半径"
          value={String(item.radius)}
          onChange={(value) =>
            update({
              radius: boundedNumber(
                value,
                40,
                FORMATION_MAX_RADIUS,
                item.radius,
              ),
            })
          }
          type="number"
          min={40}
          max={FORMATION_MAX_RADIUS}
          step={1}
        />
        <Field
          label="线宽"
          value={String(item.strokeWidth)}
          onChange={(value) =>
            update({
              strokeWidth: boundedNumber(value, 0.5, 12, item.strokeWidth),
            })
          }
          type="number"
          min={0.5}
          max={12}
          step={0.5}
        />
        <Field
          label="旋转角度"
          value={String(item.rotation)}
          onChange={(value) =>
            update({ rotation: boundedNumber(value, -360, 360, item.rotation) })
          }
          type="number"
          min={-360}
          max={360}
          step={1}
        />
        <SwitchField
          label="旋转动效"
          checked={item.rotating}
          onChange={(rotating) => update({ rotating })}
        />
        <TopologyColorField
          label="环层颜色"
          value={item.color}
          onChange={(color) => update({ color })}
        />
        <Field
          label="符文铭文"
          value={item.runes}
          onChange={(runes) => update({ runes })}
          multiline
        />
        <SelectField
          label="显示状态"
          value={item.visible ? "visible" : "hidden"}
          options={[
            { value: "visible", label: "显示" },
            { value: "hidden", label: "隐藏" },
          ]}
          onChange={(value) => update({ visible: value === "visible" })}
        />
        <Field
          label="层级顺序"
          value={String(item.order)}
          onChange={(value) =>
            update({
              order: boundedNumber(
                value,
                0,
                Number.MAX_SAFE_INTEGER,
                item.order,
              ),
            })
          }
          type="number"
          min={0}
          step={1}
        />
      </InspectorEditor>
    );
  }
  if (selection?.kind === "formation-node") {
    const formation = system.formations.find(
      (candidate) => candidate.id === selection.parentId,
    );
    const item = formation?.nodes.find((node) => node.id === selected);
    if (!formation || !item) return <InspectorMissing />;
    const update = (patch: Partial<typeof item>) =>
      patchSystem({
        formations: updateById(system.formations, formation.id, (current) => ({
          ...current,
          nodes: updateById(current.nodes, item.id, (node) => ({
            ...node,
            ...patch,
          })),
        })),
      });
    return (
      <InspectorEditor
        title={item.name}
        type="阵法节点"
        onDelete={() => {
          patchSystem({
            formations: updateById(
              system.formations,
              formation.id,
              (current) => ({
                ...current,
                nodes: current.nodes.filter((node) => node.id !== item.id),
                edges: current.edges.filter(
                  (edge) =>
                    edge.fromNodeId !== item.id && edge.toNodeId !== item.id,
                ),
              }),
            ),
          });
          onSelect?.(null);
        }}
      >
        <Field
          label="节点名称"
          value={item.name}
          onChange={(value) => update({ name: value })}
        />
        <Field
          label="节点类型"
          value={item.kind}
          onChange={(value) => update({ kind: value })}
        />
        <Field
          label="节点作用"
          value={item.role}
          onChange={(value) => update({ role: value })}
        />
        <SelectField
          label="六元角色"
          value={item.element}
          options={(
            Object.keys(FORMATION_ELEMENT_LABELS) as Array<
              Formation["nodes"][number]["element"]
            >
          ).map((value) => ({
            value,
            label: FORMATION_ELEMENT_LABELS[value],
          }))}
          onChange={(value) =>
            update({
              element: value as Formation["nodes"][number]["element"],
            })
          }
        />
        <SelectField
          label="所属环层"
          value={item.ringId ?? ""}
          options={[
            { value: "", label: "不归环 / 自由阵元" },
            ...formation.design.rings.map((ring) => ({
              value: ring.id,
              label: ring.name,
            })),
          ]}
          onChange={(value) => {
            const ring = formation.design.rings.find(
              (candidate) => candidate.id === value,
            );
            const canvasPosition = formationCanvasPosition(
              item.angle,
              ring?.radius ?? 0,
              item.size,
            );
            update({
              ringId: value || null,
              canvasPosition,
              position: {
                x:
                  ((canvasPosition.x + item.size / 2) / FORMATION_CANVAS_SIZE) *
                  100,
                y:
                  ((canvasPosition.y + item.size / 2) / FORMATION_CANVAS_SIZE) *
                  100,
              },
            });
          }}
        />
        <SelectField
          label="阵元样式"
          value={item.nodeStyle}
          options={[
            { value: "seal", label: "印章" },
            { value: "orb", label: "光球" },
            { value: "sigil", label: "符印" },
          ]}
          onChange={(value) =>
            update({
              nodeStyle: value as Formation["nodes"][number]["nodeStyle"],
            })
          }
        />
        <Field
          label="阵元符号"
          value={item.glyph}
          onChange={(glyph) => update({ glyph: glyph.slice(0, 4) })}
        />
        <TopologyColorField
          label="阵元颜色"
          value={item.color}
          onChange={(color) => update({ color })}
        />
        <SelectField
          label="理论节点"
          value={item.theoryNodeId ?? ""}
          options={[
            { value: "", label: "未关联" },
            ...listOptions(theoryNodes),
          ]}
          onChange={(value) => update({ theoryNodeId: value || null })}
        />
        <Field
          label="阵元尺寸"
          value={String(item.size)}
          onChange={(value) => {
            const size = boundedNumber(value, 36, 140, item.size);
            const currentPosition = formationNodePositionForCanvas(item);
            const centerX = currentPosition.x + item.size / 2;
            const centerY = currentPosition.y + item.size / 2;
            update({
              size,
              canvasPosition: {
                x: centerX - size / 2,
                y: centerY - size / 2,
              },
            });
          }}
          type="number"
          min={36}
          max={140}
          step={2}
        />
        <Field
          label="环上角度"
          value={String(item.angle)}
          onChange={(value) => {
            const angle = boundedNumber(value, -360, 360, item.angle);
            const radius = item.ringId
              ? (formation.design.rings.find((ring) => ring.id === item.ringId)
                  ?.radius ?? 0)
              : 0;
            const canvasPosition = formationCanvasPosition(
              angle,
              radius,
              item.size,
            );
            update({
              angle,
              canvasPosition,
              position: {
                x:
                  ((canvasPosition.x + item.size / 2) / FORMATION_CANVAS_SIZE) *
                  100,
                y:
                  ((canvasPosition.y + item.size / 2) / FORMATION_CANVAS_SIZE) *
                  100,
              },
            });
          }}
          type="number"
          min={-360}
          max={360}
          step={1}
        />
        <Field
          label="位置 X（百分比）"
          value={String(item.position.x)}
          onChange={(value) => {
            const x = boundedNumber(value, 0, 100, item.position.x);
            update({
              position: { ...item.position, x },
              canvasPosition: {
                x: (x / 100) * FORMATION_CANVAS_SIZE - item.size / 2,
                y: formationNodePositionForCanvas(item).y,
              },
            });
          }}
          type="number"
          min={0}
          max={100}
          step={0.1}
        />
        <Field
          label="位置 Y（百分比）"
          value={String(item.position.y)}
          onChange={(value) => {
            const y = boundedNumber(value, 0, 100, item.position.y);
            update({
              position: { ...item.position, y },
              canvasPosition: {
                x: formationNodePositionForCanvas(item).x,
                y: (y / 100) * FORMATION_CANVAS_SIZE - item.size / 2,
              },
            });
          }}
          type="number"
          min={0}
          max={100}
          step={0.1}
        />
      </InspectorEditor>
    );
  }
  if (selection?.kind === "formation-edge") {
    const formation = system.formations.find(
      (candidate) => candidate.id === selection.parentId,
    );
    const item = formation?.edges.find((edge) => edge.id === selected);
    if (!formation || !item) return <InspectorMissing />;
    const update = (patch: Partial<typeof item>) =>
      patchSystem({
        formations: updateById(system.formations, formation.id, (current) => ({
          ...current,
          edges: updateById(current.edges, item.id, (edge) => ({
            ...edge,
            ...patch,
          })),
        })),
      });
    return (
      <InspectorEditor
        title={item.name || item.id}
        type="阵法流向"
        onDelete={() => {
          patchSystem({
            formations: updateById(
              system.formations,
              formation.id,
              (current) => ({
                ...current,
                edges: current.edges.filter((edge) => edge.id !== item.id),
              }),
            ),
          });
          onSelect?.(null);
        }}
      >
        <Field
          label="流向名称"
          value={item.name}
          onChange={(name) => update({ name })}
        />
        <Field
          label="流动介质"
          value={item.flowType}
          onChange={(flowType) => update({ flowType })}
        />
        <SelectField
          label="起点阵元"
          value={item.fromNodeId}
          options={formation.nodes.map((node) => ({
            value: node.id,
            label: node.name,
          }))}
          onChange={(value) => update({ fromNodeId: value })}
        />
        <SelectField
          label="终点阵元"
          value={item.toNodeId}
          options={formation.nodes.map((node) => ({
            value: node.id,
            label: node.name,
          }))}
          onChange={(value) => update({ toNodeId: value })}
        />
        <SelectField
          label="起点触点"
          value={item.fromHandleId ?? ""}
          options={[
            { value: "", label: "自动选择" },
            ...TOPOLOGY_HANDLE_POINTS.map((handle) => ({
              value: handle.id,
              label: handle.id,
            })),
          ]}
          onChange={(value) => update({ fromHandleId: value || undefined })}
        />
        <SelectField
          label="终点触点"
          value={item.toHandleId ?? ""}
          options={[
            { value: "", label: "自动选择" },
            ...TOPOLOGY_HANDLE_POINTS.map((handle) => ({
              value: handle.id,
              label: handle.id,
            })),
          ]}
          onChange={(value) => update({ toHandleId: value || undefined })}
        />
        <SelectField
          label="连线样式"
          value={item.lineStyle}
          options={[
            { value: "bezier", label: "贝塞尔曲线" },
            { value: "smoothstep", label: "圆角折线" },
            { value: "straight", label: "直线" },
          ]}
          onChange={(value) =>
            update({
              lineStyle: value as Formation["edges"][number]["lineStyle"],
            })
          }
        />
        <SelectField
          label="流动动画"
          value={item.animated ? "animated" : "static"}
          options={[
            { value: "animated", label: "流动" },
            { value: "static", label: "静止" },
          ]}
          onChange={(value) => update({ animated: value === "animated" })}
        />
        <TopologyColorField
          label="流向颜色"
          value={item.color}
          onChange={(color) => update({ color })}
        />
        <Field
          label="顺序"
          value={String(item.order)}
          onChange={(value) =>
            update({
              order: boundedNumber(
                value,
                0,
                Number.MAX_SAFE_INTEGER,
                item.order,
              ),
            })
          }
          type="number"
          min={0}
          step={1}
        />
        <Field
          label="流向规则"
          value={item.rule}
          onChange={(value) => update({ rule: value })}
          multiline
        />
      </InspectorEditor>
    );
  }
  if (selection?.kind === "transition") {
    const track = system.progressionTracks.find((candidate) =>
      candidate.transitions.some((transition) => transition.id === selected),
    );
    const topLevel = system.transitions.find(
      (transition) => transition.id === selected,
    );
    const item =
      topLevel ??
      track?.transitions.find((transition) => transition.id === selected);
    if (!item) return <InspectorMissing />;
    const update = (patch: Partial<Transition>) => {
      if (topLevel)
        patchSystem({
          transitions: updateById(system.transitions, item.id, (current) => ({
            ...current,
            ...patch,
          })),
        });
      else if (track)
        patchSystem({
          progressionTracks: updateById(
            system.progressionTracks,
            track.id,
            (current) => ({
              ...current,
              transitions: updateById(
                current.transitions,
                item.id,
                (currentTransition) => ({ ...currentTransition, ...patch }),
              ),
            }),
          ),
        });
    };
    const remove = () => {
      if (topLevel)
        patchSystem({
          transitions: system.transitions.filter(
            (transition) => transition.id !== item.id,
          ),
        });
      else if (track)
        patchSystem({
          progressionTracks: updateById(
            system.progressionTracks,
            track.id,
            (current) => ({
              ...current,
              transitions: current.transitions.filter(
                (transition) => transition.id !== item.id,
              ),
            }),
          ),
        });
      onSelect?.(null);
    };
    return (
      <InspectorEditor title={item.name} type="突破与转换" onDelete={remove}>
        <Field
          label="名称"
          value={item.name}
          onChange={(value) => update({ name: value })}
        />
        <SelectField
          label="类型"
          value={item.transitionType}
          options={[
            { value: "breakthrough", label: "突破" },
            { value: "conversion", label: "转换" },
            { value: "awakening", label: "觉醒" },
            { value: "degeneration", label: "退化" },
          ]}
          onChange={(value) =>
            update({ transitionType: value as Transition["transitionType"] })
          }
        />
        <SelectField
          label="起始境界"
          value={item.fromLevelId ?? ""}
          options={[{ value: "", label: "未指定" }, ...listOptions(levels)]}
          onChange={(value) => update({ fromLevelId: value || null })}
        />
        <SelectField
          label="目标境界"
          value={item.toLevelId ?? ""}
          options={[{ value: "", label: "未指定" }, ...listOptions(levels)]}
          onChange={(value) => update({ toLevelId: value || null })}
        />
        <Field
          label="条件（一行一条）"
          value={item.conditions.join("\n")}
          onChange={(value) => update({ conditions: textList(value) })}
          multiline
        />
        <ResourceRequirementsField
          label="突破资源需求"
          value={item.resourceRequirements}
          resources={system.resources}
          defaultPurpose="breakthrough"
          onChange={(resourceRequirements) => update({ resourceRequirements })}
        />
        <Field
          label="成功规则"
          value={item.successRule}
          onChange={(value) => update({ successRule: value })}
          multiline
        />
        <Field
          label="成功结果"
          value={item.successResult}
          onChange={(value) => update({ successResult: value })}
          multiline
        />
        <Field
          label="失败结果"
          value={item.failureResult}
          onChange={(value) => update({ failureResult: value })}
          multiline
        />
        <Field
          label="不可逆后果"
          value={item.permanentConsequence}
          onChange={(value) => update({ permanentConsequence: value })}
          multiline
        />
        <Field
          label="质量继承"
          value={item.qualityInheritance ?? ""}
          onChange={(qualityInheritance) => update({ qualityInheritance })}
          multiline
        />
        <Field
          label="退化状态"
          value={item.degenerationState ?? ""}
          onChange={(degenerationState) => update({ degenerationState })}
          multiline
        />
        <SelectField
          label="是否可逆"
          value={item.reversible ? "true" : "false"}
          options={[
            { value: "true", label: "可逆" },
            { value: "false", label: "不可逆" },
          ]}
          onChange={(value) => update({ reversible: value === "true" })}
        />
        <SystemMultiSelectField
          label="相关法门"
          value={item.methodIds}
          options={listOptions(methods)}
          onChange={(value) => update({ methodIds: value })}
        />
      </InspectorEditor>
    );
  }
  if (selection?.kind === "foundation") {
    const item = system.foundations.find((f) => f.id === selected);
    if (!item) return <InspectorMissing />;
    const update = (patch: Partial<Foundation>) =>
      patchSystem({
        foundations: updateById(system.foundations, item.id, (current) => ({
          ...current,
          ...patch,
        })),
      });
    return (
      <InspectorEditor
        title={item.name}
        type="修炼根基"
        onDelete={() => {
          patchSystem({
            foundations: system.foundations.filter((f) => f.id !== item.id),
          });
          onSelect?.(null);
        }}
      >
        <Field
          label="名称"
          value={item.name}
          onChange={(value) => update({ name: value })}
        />
        <Field
          label="摘要"
          value={item.summary}
          onChange={(value) => update({ summary: value })}
          multiline
        />
        <Field
          label="影响因素"
          value={item.factor}
          onChange={(value) => update({ factor: value })}
        />
        <Field
          label="当前值"
          value={item.value}
          onChange={(value) => update({ value: value })}
        />
        <Field
          label="对修炼的影响"
          value={item.impact}
          onChange={(value) => update({ impact: value })}
          multiline
        />
        <SystemMultiSelectField
          label="影响的修炼轨迹"
          value={item.affectedTracks}
          options={listOptions(tracks)}
          onChange={(value) => update({ affectedTracks: value })}
        />
        <Field
          label="调整方式"
          value={item.adjustment}
          onChange={(value) => update({ adjustment: value })}
          multiline
        />
        <Field
          label="持久性说明"
          value={item.permanence}
          onChange={(value) => update({ permanence: value })}
          multiline
        />
      </InspectorEditor>
    );
  }
  if (selection?.kind === "constraint") {
    const item = system.constraints.find((c) => c.id === selected);
    if (!item) return <InspectorMissing />;
    const update = (patch: Partial<Constraint>) =>
      patchSystem({
        constraints: updateById(system.constraints, item.id, (current) => ({
          ...current,
          ...patch,
        })),
      });
    return (
      <InspectorEditor
        title={item.name}
        type="修炼约束"
        onDelete={() => {
          patchSystem({
            constraints: system.constraints.filter((c) => c.id !== item.id),
          });
          onSelect?.(null);
        }}
      >
        <Field
          label="名称"
          value={item.name}
          onChange={(value) => update({ name: value })}
        />
        <Field
          label="摘要"
          value={item.summary}
          onChange={(value) => update({ summary: value })}
          multiline
        />
        <SelectField
          label="约束类别"
          value={item.category}
          options={[
            { value: "cost", label: "代价" },
            { value: "pollution", label: "污染" },
            { value: "backlash", label: "反噬" },
            { value: "world-rule", label: "世界规则" },
            { value: "identity", label: "身份限制" },
            { value: "irreversible", label: "不可逆" },
          ]}
          onChange={(value) =>
            update({ category: value as Constraint["category"] })
          }
        />
        <Field
          label="触发条件"
          value={item.trigger}
          onChange={(value) => update({ trigger: value })}
          multiline
        />
        <Field
          label="后果"
          value={item.consequence}
          onChange={(value) => update({ consequence: value })}
          multiline
        />
        <Field
          label="缓解措施"
          value={item.mitigation}
          onChange={(value) => update({ mitigation: value })}
          multiline
        />
        <Field
          label="作用对象"
          value={item.target ?? ""}
          onChange={(target) => update({ target })}
        />
        <Field
          label="解除方式"
          value={item.releaseMethod ?? ""}
          onChange={(releaseMethod) => update({ releaseMethod })}
          multiline
        />
        <Field
          label="叙事提示"
          value={item.narrativePrompt ?? ""}
          onChange={(narrativePrompt) => update({ narrativePrompt })}
          multiline
        />
        <SelectField
          label="是否可逆"
          value={item.reversible ? "true" : "false"}
          options={[
            { value: "true", label: "可逆" },
            { value: "false", label: "不可逆" },
          ]}
          onChange={(value) => update({ reversible: value === "true" })}
        />
      </InspectorEditor>
    );
  }
  return <InspectorMissing />;
}

function WorldOriginOverviewInspector({
  ecology,
  onSelect,
}: {
  ecology: CultivationEcology;
  onSelect?: (selection: Selection) => void;
}) {
  const manifestationCount = ecology.worldOrigins.reduce(
    (total, origin) => total + origin.manifestations.length,
    0,
  );
  const relationCount = ecology.worldOrigins.reduce(
    (total, origin) => total + origin.relations.length,
    0,
  );
  const projectionCount = ecology.systems.filter(
    (system) =>
      system.projection.originIds.length > 0 ||
      system.projection.manifestationIds.length > 0,
  ).length;
  return (
    <div className="ce-inspector-content">
      <div className="ce-inspector-label">世界本源工作台</div>
      <div className="ce-inspector-focus">
        <span className="ce-focus-icon">
          <Sparkles className="h-4 w-4" />
        </span>
        <div>
          <strong>结构总览</strong>
          <small>世界本源不是单一能量，而是一套展开关系</small>
        </div>
      </div>
      <div className="ce-inspector-rule" />
      <div className="ce-inspector-facts">
        <div>
          <span>本源</span>
          <strong>{ecology.worldOrigins.length}</strong>
        </div>
        <div>
          <span>显化</span>
          <strong>{manifestationCount}</strong>
        </div>
        <div>
          <span>关系</span>
          <strong>{relationCount}</strong>
        </div>
        <div>
          <span>投影体系</span>
          <strong>{projectionCount}</strong>
        </div>
      </div>
      <div className="ce-origin-inspector-guide">
        <span>画布阅读顺序</span>
        <strong>本体 → 分化 / 显化 → 投影</strong>
        <p>选中节点后，在这里编辑其定义、作用域、接入方式、约束与关系。</p>
      </div>
      <div className="ce-origin-inspector-shortcuts">
        <button
          type="button"
          onClick={() =>
            onSelect?.(
              ecology.worldOrigins[0]
                ? { kind: "world-origin", id: ecology.worldOrigins[0].id }
                : null,
            )
          }
        >
          <Sparkles className="h-4 w-4" />
          <span>打开第一个世界本源</span>
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() =>
            onSelect?.(
              ecology.worldOrigins[0]?.manifestations[0]
                ? {
                    kind: "manifestation",
                    id: ecology.worldOrigins[0].manifestations[0].id,
                    parentId: ecology.worldOrigins[0].id,
                    parentKind: "world-origin",
                  }
                : null,
            )
          }
        >
          <Waypoints className="h-4 w-4" />
          <span>查看第一个显化节点</span>
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function InspectorEditor({
  title,
  type,
  children,
  onDelete,
}: {
  title: string;
  type: string;
  children: ReactNode;
  onDelete?: () => void;
}) {
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  return (
    <>
      <div className="ce-inspector-content">
        <div className="ce-inspector-label">{type}</div>
        <div className="ce-inspector-focus">
          <span className="ce-focus-icon">
            <FileText className="h-4 w-4" />
          </span>
          <div>
            <strong>{title}</strong>
            <small>{type}</small>
          </div>
        </div>
        <div className="ce-inspector-rule" />
        <div className="ce-inspector-form">{children}</div>
        {onDelete && (
          <Button variant="danger" onClick={() => setDeleteConfirmOpen(true)}>
            <Trash2 className="h-3.5 w-3.5" />
            删除对象
          </Button>
        )}
      </div>
      {deleteConfirmOpen && onDelete && (
        <ConfirmDialog
          title={`删除「${title}」`}
          message={`确认删除「${title}」？此操作不可撤销。`}
          confirmText="删除对象"
          confirmVariant="danger"
          onConfirm={() => {
            setDeleteConfirmOpen(false);
            onDelete();
          }}
          onCancel={() => setDeleteConfirmOpen(false)}
        />
      )}
    </>
  );
}
function InspectorMissing() {
  return (
    <div className="ce-inspector-empty">
      <AlertTriangle className="h-5 w-5" />
      <span>对象不存在或已被删除</span>
    </div>
  );
}
