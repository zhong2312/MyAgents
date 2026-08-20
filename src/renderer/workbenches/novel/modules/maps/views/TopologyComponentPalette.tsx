import {
  ArrowRight,
  CircleDot,
  GitBranch,
  Globe2,
  LandPlot,
  Landmark,
  Orbit,
  Route,
  Sparkles,
} from "lucide-react";
import { memo, useState } from "react";


import {
  TOPOLOGY_NODE_DRAG_MIME,
  TOPOLOGY_NODE_KIND_OPTIONS,
  type TopologyNodeKind,
  type TopologyRouteDirection,
  type TopologyRouteRelation,
} from "../business/topologyMap";

const NODE_ICONS: Readonly<
  Record<TopologyNodeKind, typeof Globe2>
> = {
  universe: Orbit,
  galaxy: Sparkles,
  "star-system": Orbit,
  world: Globe2,
  realm: Sparkles,
  planet: CircleDot,
  continent: LandPlot,
  timeline: GitBranch,
  settlement: Landmark,
};

const ROUTE_PRESETS: readonly {
  readonly relation: TopologyRouteRelation;
  readonly direction: TopologyRouteDirection;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    relation: "passage",
    direction: "two-way",
    label: "世界通道",
    hint: "双向",
  },
  {
    relation: "branch",
    direction: "one-way",
    label: "世界分支",
    hint: "单向层级",
  },
  {
    relation: "portal",
    direction: "two-way",
    label: "传送门",
    hint: "双向",
  },
  {
    relation: "rift",
    direction: "one-way",
    label: "界壁裂隙",
    hint: "单向",
  },
];

const PRIMARY_NODE_KINDS: readonly TopologyNodeKind[] = [
  "universe",
  "world",
  "planet",
  "continent",
];

interface TopologyComponentPaletteProps {
  readonly disabled: boolean;
  readonly nodeCount: number;
  readonly routeCount: number;
  readonly isolatedNodeCount: number;
  readonly invalidRouteCount: number;
  readonly activeNodeKind: TopologyNodeKind;
  readonly activeRouteRelation: TopologyRouteRelation;
  readonly activeRouteDirection: TopologyRouteDirection;
  /** 当前工具栏配置；拖放节点必须与点击放置使用同一份模板语义。 */
  readonly topologyNodeTemplate?: {
    readonly kind: TopologyNodeKind;
    readonly status: "active" | "dormant" | "sealed" | "destroyed";
    readonly name: string;
    readonly color: string;
    readonly linkedMapId: string | null;
    readonly entityRef: {
      readonly kind: "character" | "event" | "location" | "faction" | "item" | "setting";
      readonly id: string;
    } | null;
  };
  readonly onNodePreset: (kind: TopologyNodeKind) => void;
  readonly onRoutePreset: (
    relation: TopologyRouteRelation,
    direction: TopologyRouteDirection,
  ) => void;
}

function NodeIcon({ kind }: { readonly kind: TopologyNodeKind }) {
  const Icon = NODE_ICONS[kind];
  return <Icon className="h-4 w-4" />;
}

function TopologyComponentPalette({
  disabled,
  nodeCount,
  routeCount,
  isolatedNodeCount,
  invalidRouteCount,
  activeNodeKind,
  activeRouteRelation,
  activeRouteDirection,
  topologyNodeTemplate,
  onNodePreset,
  onRoutePreset,
}: TopologyComponentPaletteProps) {
  const [showMoreNodeKinds, setShowMoreNodeKinds] = useState(false);
  const nodePresetOptions = TOPOLOGY_NODE_KIND_OPTIONS.filter(
    (option) =>
      // 平行世界图默认使用“时间分支”，它不在常用四类中。当前激活的
      // 类型必须始终可见，否则刚切换到对应投影时构件库看起来像少了
      // 当前节点入口，只能先展开“更多类型”才能继续编辑。
      PRIMARY_NODE_KINDS.includes(option.value) ||
      option.value === activeNodeKind ||
      showMoreNodeKinds,
  );
  return (
    <aside
      className="map-asset-dock flex w-[218px] shrink-0 flex-col border-r border-[var(--line-subtle)] bg-[var(--paper)]"
      aria-label="拓扑构件库"
    >
      <div className="shrink-0 border-b border-[var(--line-subtle)] px-3 py-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold tracking-wide text-[var(--ink)]">
            拓扑构件
          </span>
          <span className="text-xs text-[var(--ink-subtle)]">拖放或点击</span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1.5 text-xs text-[var(--ink-muted)]">
          <span className="rounded border border-[var(--line-subtle)] px-2 py-1">
            节点 {nodeCount}
          </span>
          <span className="rounded border border-[var(--line-subtle)] px-2 py-1">
            通道 {routeCount}
          </span>
          <span
            className={`rounded border px-2 py-1 ${isolatedNodeCount > 0 ? "border-[var(--accent-warm)] text-[var(--accent-warm)]" : "border-[var(--line-subtle)]"}`}
          >
            孤立 {isolatedNodeCount}
          </span>
          <span
            className={`rounded border px-2 py-1 ${invalidRouteCount > 0 ? "border-[var(--error)] text-[var(--error)]" : "border-[var(--line-subtle)]"}`}
          >
            诊断 {invalidRouteCount}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
        <div className="mb-2 px-1 text-xs font-medium text-[var(--ink-muted)]">
          节点预设
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {nodePresetOptions.map((option) => {
            const active = activeNodeKind === option.value;
            return (
              <button
                key={option.value}
                type="button"
                draggable={!disabled}
                disabled={disabled}
                aria-label={`放置${option.label}节点`}
                title={`点击进入${option.label}节点放置；拖入画布直接创建`}
                onClick={() => onNodePreset(option.value)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "copy";
                  const configuredForPreset =
                    topologyNodeTemplate?.kind === option.value
                      ? topologyNodeTemplate
                      : null;
                  event.dataTransfer.setData(
                    TOPOLOGY_NODE_DRAG_MIME,
                    JSON.stringify({
                      kind: option.value,
                      status: configuredForPreset?.status ?? "active",
                      name:
                        configuredForPreset?.name.trim() || option.defaultName,
                      color: option.color,
                      linkedMapId: configuredForPreset?.linkedMapId ?? null,
                      entityRef: configuredForPreset?.entityRef ?? null,
                    }),
                  );
                }}
                className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-md border px-1 py-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${active ? "border-[var(--accent-warm)] bg-[var(--accent-warm-subtle)] text-[var(--ink)]" : "border-[var(--line-subtle)] text-[var(--ink-muted)] hover:border-[var(--accent-warm)] hover:bg-[var(--hover-bg)]"}`}
              >
                <span
                  className="grid h-6 w-6 place-items-center rounded text-white"
                  style={{ backgroundColor: option.color }}
                >
                  <NodeIcon kind={option.value} />
                </span>
                {option.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          disabled={disabled}
          aria-label={
            showMoreNodeKinds
              ? "收起更多拓扑节点类型"
              : "展开更多拓扑节点类型"
          }
          onClick={() => setShowMoreNodeKinds((current) => !current)}
          className="mt-2 h-8 w-full rounded-md border border-[var(--line-subtle)] text-xs text-[var(--ink-muted)] hover:border-[var(--accent-warm)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-35"
        >
          {showMoreNodeKinds ? "收起更多类型" : "更多节点类型"}
        </button>
        <div className="mb-2 mt-4 flex items-center justify-between px-1 text-xs font-medium text-[var(--ink-muted)]">
          <span>关系预设</span>
          <Route className="h-3.5 w-3.5" />
        </div>
        <div className="space-y-1.5">
          {ROUTE_PRESETS.map((preset) => {
            const active =
              activeRouteRelation === preset.relation &&
              activeRouteDirection === preset.direction;
            return (
              <button
                key={`${preset.relation}-${preset.direction}`}
                type="button"
                disabled={disabled}
                aria-label={`使用${preset.label}`}
                title={`选择${preset.label}，然后点击两个节点或拖动端口创建`}
                onClick={() =>
                  onRoutePreset(preset.relation, preset.direction)
                }
                className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${active ? "border-[var(--accent-warm)] bg-[var(--accent-warm-subtle)] text-[var(--ink)]" : "border-[var(--line-subtle)] text-[var(--ink-muted)] hover:border-[var(--accent-warm)] hover:bg-[var(--hover-bg)]"}`}
              >
                <span className="grid h-6 w-6 place-items-center rounded bg-[var(--paper-elevated)]">
                  {preset.relation === "branch" ? (
                    <GitBranch className="h-3.5 w-3.5" />
                  ) : (
                    <ArrowRight className="h-3.5 w-3.5" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{preset.label}</span>
                  <span className="block text-xs text-[var(--ink-subtle)]">
                    {preset.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-4 border-t border-[var(--line-subtle)] px-1 pt-3 text-xs leading-5 text-[var(--ink-subtle)]">
          节点拖入画布会直接写入文档；通道必须连接两个已有节点。选中节点后可关联地图、设定和层级关系。
        </p>
      </div>
    </aside>
  );
}

export default memo(TopologyComponentPalette);
