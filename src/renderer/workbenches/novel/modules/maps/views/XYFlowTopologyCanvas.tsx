import "@xyflow/react/dist/style.css";

import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Copy,
  Download,
  ExternalLink,
  GitBranch,
  Globe2,
  GripVertical,
  LandPlot,
  Landmark,
  LoaderCircle,
  Lock,
  ListCollapse,
  ListTree,
  MoreHorizontal,
  Orbit,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ViewportPortal,
  type Connection,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import {
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  buildTopologyElements,
  canConnectTopologyNodes,
  createTopologyEdgeFeature,
  createTopologyNodeFeature,
  getTopologySummary,
  getTopologyInvalidRouteDiagnostics,
  getTopologyNodeKindOption,
  getTopologyNodeDescendants,
  getTopologyNodeStatusOption,
  toggleTopologySelection,
  TOPOLOGY_NODE_KIND_OPTIONS,
  TOPOLOGY_NODE_STATUS_OPTIONS,
  TOPOLOGY_NODE_DRAG_MIME,
  type TopologyNodeKind,
  type TopologyNodeStatus,
  type TopologyRouteDirection,
  type TopologyRouteRelation,
  type TopologyEdge,
  type TopologyNode,
} from "../business/topologyMap";
import { mapCanvasBackgroundStyle } from "../business/mapBackgrounds";
import type { MapDocument, MapFeature } from "../entities/mapSchema";
import type { MapCanvasTool } from "../business/mapCanvasSession";
import { downloadMapDocumentPng } from "./mapSceneExporter";

interface XYFlowTopologyCanvasProps {
  readonly document: MapDocument;
  readonly tool: MapCanvasTool;
  readonly activeLayerId: string;
  readonly selectedFeatureId: string | null;
  readonly selectedFeatureIds?: readonly string[];
  readonly focusRequest?: number;
  /** 左上扩展时 MapDocument 的坐标重定位，用于保持当前视口稳定。 */
  readonly documentRebase?: {
    readonly revision: number;
    readonly translation: { readonly x: number; readonly y: number };
  } | null;
  readonly timelineCursor: number | null;
  /** 项目素材 URL；导出器使用同一份素材解析结果。 */
  readonly projectArtworkSources?: ReadonlyMap<string, string>;
  readonly topologyLinkedMapNames?: ReadonlyMap<string, string>;
  readonly topologyEntityNames?: ReadonlyMap<string, string>;
  /** 仅用于画布视图筛选，不改变 MapDocument 中的拓扑事实。 */
  readonly topologyQuery?: string;
  readonly topologyNodeTemplate?: {
    readonly kind: TopologyNodeKind;
    readonly status: TopologyNodeStatus;
    readonly name: string;
    readonly color: string;
    readonly linkedMapId: string | null;
    readonly entityRef: MapFeature["entityRef"];
  };
  readonly topologyRouteTemplate?: {
    readonly relation: TopologyRouteRelation;
    readonly direction: TopologyRouteDirection;
  };
  readonly onSelect: (featureId: string | null) => void;
  readonly onSelectionChange?: (
    featureIds: readonly string[],
    primaryFeatureId: string | null,
  ) => void;
  readonly onCreate: (feature: MapFeature) => void;
  /** 拖放预设完成一次放置后退出连续节点工具；空白点击创建不触发。 */
  readonly onTopologyNodePlaced?: () => void;
  readonly onTopologyNodesMove: (
    moves: readonly {
      readonly id: string;
      readonly point: { readonly x: number; readonly y: number };
    }[],
  ) => void;
  readonly onTopologyEdgeReconnect?: (
    featureId: string,
    sourceNodeId: string,
    targetNodeId: string,
  ) => void;
  readonly onTopologyNodeAdjacent?: (
    featureId: string,
    direction: "incoming" | "outgoing",
  ) => void;
  readonly onTopologyNodeHierarchyAdjacent?: (
    featureId: string,
    direction: "incoming" | "outgoing",
  ) => void;
  readonly onTopologyNodeLockToggle?: (
    featureId: string,
    locked: boolean,
  ) => void;
  /** React Flow 删除动作必须回写 MapDocument，不能只删除受控画布状态。 */
  readonly onTopologyDelete?: (featureIds: readonly string[]) => void;
  readonly onTopologyNodeOpen?: (featureId: string) => void;
  readonly onTopologyNodeCreateMap?: (featureId: string) => void;
  /** 从节点已关联的世界架构范围继续补齐拓扑子树。 */
  readonly onTopologyNodeImportSettingSubtree?: (featureId: string) => void;
  /** 节点卡片内的快捷操作仍由宿主按 MapDocument 规则执行。 */
  readonly onTopologyNodeDuplicate?: (featureId: string) => void;
  readonly onTopologyNodeDelete?: (featureId: string) => void;
  /** 选择无法渲染的路线，交由检查器提供修复或删除入口。 */
  readonly onTopologyInvalidRouteSelect?: (featureId: string) => void;
  readonly onTopologyError?: (message: string) => void;
}

function renderTopologyNodeIcon(kind: TopologyNode["data"]["kind"]) {
  switch (kind) {
    case "universe":
      return <Orbit className="h-4 w-4" />;
    case "galaxy":
      return <Sparkles className="h-4 w-4" />;
    case "star-system":
      return <Orbit className="h-4 w-4" />;
    case "realm":
      return <Sparkles className="h-4 w-4" />;
    case "planet":
      return <CircleDot className="h-4 w-4" />;
    case "continent":
      return <LandPlot className="h-4 w-4" />;
    case "settlement":
      return <Landmark className="h-4 w-4" />;
    case "timeline":
      return <GitBranch className="h-4 w-4" />;
    default:
      return <Globe2 className="h-4 w-4" />;
  }
}

function TopologyWorldNode({
  data,
  selected,
  connectionStart = false,
  routeToolActive = false,
  onTopologyNodeAdjacent,
  onTopologyNodeHierarchyAdjacent,
  onTopologyNodeLockToggle,
  onTopologyNodeOpen,
  onTopologyNodeCreateMap,
  onTopologyNodeImportSettingSubtree,
  onTopologyNodeDuplicate,
  onTopologyNodeDelete,
  onTopologyNodeCollapse,
}: NodeProps<TopologyNode> & {
  readonly connectionStart?: boolean;
  readonly routeToolActive?: boolean;
  readonly onTopologyNodeAdjacent?: (
    featureId: string,
    direction: "incoming" | "outgoing",
  ) => void;
  readonly onTopologyNodeHierarchyAdjacent?: (
    featureId: string,
    direction: "incoming" | "outgoing",
  ) => void;
  readonly onTopologyNodeLockToggle?: (
    featureId: string,
    locked: boolean,
  ) => void;
  readonly onTopologyNodeOpen?: (featureId: string) => void;
  readonly onTopologyNodeCreateMap?: (featureId: string) => void;
  readonly onTopologyNodeImportSettingSubtree?: (featureId: string) => void;
  readonly onTopologyNodeDuplicate?: (featureId: string) => void;
  readonly onTopologyNodeDelete?: (featureId: string) => void;
  readonly onTopologyNodeCollapse?: (featureId: string) => void;
}) {
  const handles = [
    { id: "top", position: Position.Top },
    { id: "right", position: Position.Right },
    { id: "bottom", position: Position.Bottom },
    { id: "left", position: Position.Left },
  ] as const;
  const statusOption = getTopologyNodeStatusOption(data.status);
  const [showMoreActions, setShowMoreActions] = useState(false);
  return (
    <div
      role="group"
      aria-label={`${data.kindLabel}节点：${data.label}`}
      className={`group relative h-[104px] min-w-44 overflow-visible rounded-md border bg-[#fffaf1] px-3 py-2.5 shadow-[0_3px_12px_rgba(55,47,39,0.12)] transition-[border-color,box-shadow] ${connectionStart ? "border-[var(--accent-warm)] ring-2 ring-[var(--accent-warm)]/35" : selected ? "border-[var(--accent-warm)] ring-2 ring-[var(--accent-warm)]/20" : "border-[#746b604d]"}`}
      style={{ borderLeftColor: data.color, borderLeftWidth: 4 }}
    >
      {handles.map((handle) => (
        <Handle
          key={`source-${handle.id}`}
          id={`source-port-${handle.id}`}
          type="source"
          position={handle.position}
          title="拖动创建或重连通道"
          style={{ zIndex: 2 }}
          className={`!h-2.5 !w-2.5 !border-2 !border-[#fffaf1] !bg-[#746b60] transition-opacity ${routeToolActive ? "!opacity-100" : "!opacity-55 group-hover:!opacity-100"}`}
        />
      ))}
      {handles.map((handle) => (
        <Handle
          key={`target-${handle.id}`}
          id={`target-port-${handle.id}`}
          type="target"
          position={handle.position}
          title="连接到此端点"
          style={{ zIndex: 1 }}
          className={`!pointer-events-auto !h-3 !w-3 transition-opacity ${routeToolActive ? "!border-2 !border-[#fffaf1] !bg-[#c75436] !opacity-100" : "!border-0 !bg-transparent !opacity-0 group-hover:!opacity-100"}`}
        />
      ))}
      <div
        className="topology-node-drag-handle flex min-w-0 cursor-grab items-center gap-2 active:cursor-grabbing"
        title="拖动此处移动节点"
      >
        <GripVertical
          aria-hidden="true"
          className="h-4 w-3 shrink-0 text-[#a69a8b]"
        />
        <span
          className="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-white"
          style={{ backgroundColor: data.color }}
        >
          {renderTopologyNodeIcon(data.kind)}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-[#42392f]">
            {data.showLabel ? data.label : data.kindLabel}
          </span>
          <span className="block truncate text-xs text-[#756a5d]">
            {data.kindLabel}
            {data.ancestorPath ? ` · ${data.ancestorPath}` : ""}
            {data.linkedMapId
              ? ` · ${data.linkedMapName ?? "关联地图已失效"}`
              : ""}
          </span>
          {data.linkedEntityName && (
            <span className="block truncate text-xs text-[#8b755c]">
              关联 · {data.linkedEntityName}
            </span>
          )}
          {data.description && (
            <span className="block truncate text-xs text-[#9a8b7c]">
              {data.description}
            </span>
          )}
        </span>
        <span
          className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-[#756a5d]"
          title={`节点状态：${data.statusLabel}`}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: statusOption.color }}
          />
          {data.statusLabel}
        </span>
      </div>
      <div className="relative z-10 mt-2 flex flex-wrap items-center justify-between gap-y-1 border-t border-[#746b6020] pt-1.5 text-xs text-[#85796b]">
        <span>
          {connectionStart
            ? "已选起点 · 点击目标节点"
            : `${data.connectionCount} 条 · 入 ${data.incomingCount} / 出 ${data.outgoingCount}`}
        </span>
        {!connectionStart && (data.parentCount > 0 || data.childCount > 0) && (
          <span title="父子分支关系">
            父 {data.parentCount} · 子 {data.childCount}
          </span>
        )}
        <span className="flex items-center gap-0.5">
          {!connectionStart && data.descendantCount > 0 && (
            <button
              type="button"
              className="nodrag nopan grid h-5 w-5 place-items-center rounded text-[#756a5d] hover:bg-[#746b6018] hover:text-[#42392f]"
              title={data.collapsed ? "展开全部子节点" : "折叠全部子节点"}
              aria-label={`${data.label}${data.collapsed ? "展开全部子节点" : "折叠全部子节点"}`}
              onClick={(event) => {
                event.stopPropagation();
                onTopologyNodeCollapse?.(data.feature.id);
              }}
            >
              {data.collapsed ? (
                <ChevronRight className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
            </button>
          )}
          {!data.locked && (
            <>
              <button
                type="button"
                className="nodrag nopan grid h-5 w-5 place-items-center rounded text-[#756a5d] hover:bg-[#746b6018] hover:text-[#42392f]"
                title="创建前置节点"
                aria-label={`${data.label}创建前置节点`}
                onClick={(event) => {
                  event.stopPropagation();
                  onTopologyNodeAdjacent?.(data.feature.id, "incoming");
                }}
              >
                <ArrowLeft className="h-3 w-3" />
              </button>
              <button
                type="button"
                className="nodrag nopan grid h-5 w-5 place-items-center rounded text-[#756a5d] hover:bg-[#746b6018] hover:text-[#42392f]"
                title="创建后继节点"
                aria-label={`${data.label}创建后继节点`}
                onClick={(event) => {
                  event.stopPropagation();
                  onTopologyNodeAdjacent?.(data.feature.id, "outgoing");
                }}
              >
                <ArrowRight className="h-3 w-3" />
              </button>
              <button
                type="button"
                className="nodrag nopan grid h-5 w-5 place-items-center rounded text-[#756a5d] hover:bg-[#746b6018] hover:text-[#42392f]"
                title="创建子节点"
                aria-label={`${data.label}创建子节点`}
                onClick={(event) => {
                  event.stopPropagation();
                  onTopologyNodeHierarchyAdjacent?.(
                    data.feature.id,
                    "outgoing",
                  );
                }}
              >
                <GitBranch className="h-3 w-3" />
              </button>
              <button
                type="button"
                className="nodrag nopan grid h-5 w-5 place-items-center rounded text-[#756a5d] hover:bg-[#746b6018] hover:text-[#42392f]"
                title="创建父节点"
                aria-label={`${data.label}创建父节点`}
                onClick={(event) => {
                  event.stopPropagation();
                  onTopologyNodeHierarchyAdjacent?.(
                    data.feature.id,
                    "incoming",
                  );
                }}
              >
                <GitBranch className="h-3 w-3 rotate-180" />
              </button>
            </>
          )}
          <button
            type="button"
            className="nodrag nopan grid h-5 w-5 place-items-center rounded text-[#756a5d] hover:bg-[#746b6018] hover:text-[#42392f] disabled:cursor-not-allowed disabled:opacity-40"
            disabled={data.locked && !data.nodeLocked}
            title={
              data.locked && !data.nodeLocked
                ? "所属图层已锁定"
                : data.nodeLocked
                  ? "解锁节点"
                  : "锁定节点"
            }
            aria-label={`${data.label}${data.nodeLocked ? "解锁节点" : "锁定节点"}`}
            onClick={(event) => {
              event.stopPropagation();
              onTopologyNodeLockToggle?.(data.feature.id, !data.nodeLocked);
            }}
          >
            <Lock
              className={`h-3 w-3 ${data.nodeLocked ? "text-[var(--accent-warm)]" : ""}`}
            />
          </button>
          <div className="relative">
            <button
              type="button"
              className="nodrag nopan grid h-5 w-5 place-items-center rounded text-[#756a5d] hover:bg-[#746b6018] hover:text-[#42392f]"
              title="更多节点操作"
              aria-label={`${data.label}更多节点操作`}
              aria-expanded={showMoreActions}
              onClick={(event) => {
                event.stopPropagation();
                setShowMoreActions((current) => !current);
              }}
            >
              <MoreHorizontal className="h-3 w-3" />
            </button>
            {showMoreActions && (
              <div
                className="nodrag nopan absolute bottom-6 right-0 z-30 min-w-44 rounded-md border border-[#746b604d] bg-[#fffaf1] p-1.5 shadow-[0_6px_18px_rgba(55,47,39,0.2)]"
                role="menu"
                aria-label={`${data.label}更多操作`}
                onClick={(event) => event.stopPropagation()}
              >
                {data.linkedMapId && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!data.linkedMapName}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[#51483e] hover:bg-[#746b6018] disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => {
                      setShowMoreActions(false);
                      onTopologyNodeOpen?.(data.feature.id);
                    }}
                  >
                    <ExternalLink className="h-3 w-3" />
                    打开关联地图
                  </button>
                )}
                {data.settingRefId && !data.locked && (
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[#51483e] hover:bg-[#746b6018]"
                    onClick={() => {
                      setShowMoreActions(false);
                      onTopologyNodeImportSettingSubtree?.(data.feature.id);
                    }}
                  >
                    <ListTree className="h-3 w-3" />
                    补齐世界架构子树
                  </button>
                )}
                {!data.locked && !data.linkedMapId && (
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[#51483e] hover:bg-[#746b6018]"
                    onClick={() => {
                      setShowMoreActions(false);
                      onTopologyNodeCreateMap?.(data.feature.id);
                    }}
                  >
                    <Plus className="h-3 w-3" />
                    新建关联地图
                  </button>
                )}
                {!data.locked && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[#51483e] hover:bg-[#746b6018]"
                      onClick={() => {
                        setShowMoreActions(false);
                        onTopologyNodeDuplicate?.(data.feature.id);
                      }}
                    >
                      <Copy className="h-3 w-3" />
                      复制节点
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[#9d4735] hover:bg-[#c7543618]"
                      onClick={() => {
                        setShowMoreActions(false);
                        onTopologyNodeDelete?.(data.feature.id);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                      删除节点及关联通道
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </span>
      </div>
    </div>
  );
}

function nextFeatureId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function isTopologyNodeDrag(event: DragEvent<HTMLDivElement>): boolean {
  const types = event.dataTransfer?.types;
  // `DataTransfer.types` 在旧版 Chromium / WebView 中可能是
  // DOMStringList，而不是带 includes 的数组；统一转成数组后再判断，避免
  // 拖放入口只在部分运行时失效。读取自定义 payload 作为第二重校验，兼容
  // 浏览器在 dragover 阶段不暴露类型列表的实现。
  const typeList =
    typeof types === "string" ? [types] : types ? Array.from(types) : [];
  return Boolean(
    typeList.some((type) => type === TOPOLOGY_NODE_DRAG_MIME) ||
      event.dataTransfer?.getData(TOPOLOGY_NODE_DRAG_MIME) === "create",
  );
}

function topologyNodeDropTemplate(
  event: DragEvent<HTMLDivElement>,
  fallback: XYFlowTopologyCanvasProps["topologyNodeTemplate"],
): NonNullable<XYFlowTopologyCanvasProps["topologyNodeTemplate"]> {
  const raw = event.dataTransfer?.getData(TOPOLOGY_NODE_DRAG_MIME) ?? "";
  if (!raw || raw === "create") {
    return (
      fallback ?? {
        kind: "world",
        status: "active",
        name: "新世界",
        color: "#507b88",
        linkedMapId: null,
        entityRef: null,
      }
    );
  }
  try {
    const payload = JSON.parse(raw) as Partial<
      NonNullable<XYFlowTopologyCanvasProps["topologyNodeTemplate"]>
    >;
    const template = fallback ?? {
      kind: "world" as const,
      status: "active" as const,
      name: "新世界",
      color: "#507b88",
      linkedMapId: null,
      entityRef: null,
    };
    const kind = TOPOLOGY_NODE_KIND_OPTIONS.some(
      (option) => option.value === payload.kind,
    )
      ? (payload.kind as TopologyNodeKind)
      : template.kind;
    const status = TOPOLOGY_NODE_STATUS_OPTIONS.some(
      (option) => option.value === payload.status,
    )
      ? (payload.status as TopologyNodeStatus)
      : template.status;
    const payloadKindChanged = kind !== template.kind;
    return {
      ...template,
      ...payload,
      kind,
      status,
      // 拖放预设只在切换节点类型时重置关联信息；同类型拖放必须保留
      // 工具栏已经配置的名称、状态、地图和世界架构，保证点击与拖放
      // 两条入口写入完全一致的 MapFeature 语义。
      name:
        payload.name?.trim() && !payloadKindChanged
          ? payload.name.trim()
          : payloadKindChanged
            ? getTopologyNodeKindOption(kind).defaultName
            : template.name,
      linkedMapId: payloadKindChanged
        ? null
        : (payload.linkedMapId ?? template.linkedMapId),
      entityRef: payloadKindChanged
        ? null
        : (payload.entityRef ?? template.entityRef),
    };
  } catch {
    return (
      fallback ?? {
        kind: "world",
        status: "active",
        name: "新世界",
        color: "#507b88",
        linkedMapId: null,
        entityRef: null,
      }
    );
  }
}

export default function XYFlowTopologyCanvas({
  document,
  tool,
  activeLayerId,
  selectedFeatureId,
  selectedFeatureIds = [],
  focusRequest = 0,
  documentRebase = null,
  timelineCursor,
  projectArtworkSources,
  topologyLinkedMapNames,
  topologyEntityNames,
  topologyQuery = "",
  topologyNodeTemplate,
  topologyRouteTemplate,
  onSelect,
  onSelectionChange,
  onCreate,
  onTopologyNodePlaced,
  onTopologyNodesMove,
  onTopologyEdgeReconnect,
  onTopologyNodeAdjacent,
  onTopologyNodeHierarchyAdjacent,
  onTopologyNodeLockToggle,
  onTopologyDelete,
  onTopologyNodeOpen,
  onTopologyNodeCreateMap,
  onTopologyNodeImportSettingSubtree,
  onTopologyNodeDuplicate,
  onTopologyNodeDelete,
  onTopologyInvalidRouteSelect,
  onTopologyError,
}: XYFlowTopologyCanvasProps) {
  const instanceRef = useRef<ReactFlowInstance<
    TopologyNode,
    TopologyEdge
  > | null>(null);
  const appliedDocumentRebaseRevisionRef = useRef(0);
  const fittedDocumentIdRef = useRef<string | null>(null);
  const collapsedDocumentIdRef = useRef(document.id);
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const allElements = useMemo(
    () => buildTopologyElements(document, timelineCursor),
    [document, timelineCursor],
  );
  const filteredElements = useMemo(() => {
    const query = topologyQuery.trim().toLocaleLowerCase("zh-CN");
    if (!query) return allElements;

    const matches = (value: unknown) =>
      typeof value === "string" &&
      value.toLocaleLowerCase("zh-CN").includes(query);
    const matchingNodeIds = new Set(
      allElements.nodes
        .filter((node) =>
          [
            node.data.label,
            node.data.kindLabel,
            node.data.linkedMapId
              ? topologyLinkedMapNames?.get(node.data.linkedMapId)
              : null,
            node.data.feature.entityRef
              ? topologyEntityNames?.get(
                  `${node.data.feature.entityRef.kind}:${node.data.feature.entityRef.id}`,
                )
              : null,
            node.data.feature.description,
            node.data.ancestorPath,
          ].some(matches),
        )
        .map((node) => node.id),
    );
    const matchingEdgeIds = new Set(
      allElements.edges
        .filter(
          (edge) =>
            matches(edge.label) ||
            matchingNodeIds.has(edge.source) ||
            matchingNodeIds.has(edge.target),
        )
        .map((edge) => edge.id),
    );
    const visibleNodeIds = new Set(
      allElements.edges
        .filter((edge) => matchingEdgeIds.has(edge.id))
        .flatMap((edge) => [edge.source, edge.target]),
    );
    for (const nodeId of matchingNodeIds) visibleNodeIds.add(nodeId);
    return {
      nodes: allElements.nodes.filter((node) => visibleNodeIds.has(node.id)),
      edges: allElements.edges.filter(
        (edge) =>
          matchingEdgeIds.has(edge.id) &&
          visibleNodeIds.has(edge.source) &&
          visibleNodeIds.has(edge.target),
      ),
    };
  }, [allElements, topologyEntityNames, topologyLinkedMapNames, topologyQuery]);
  const collapsedDescendantIds = useMemo(() => {
    if (topologyQuery.trim()) return new Set<string>();
    const hidden = new Set<string>();
    for (const nodeId of collapsedNodeIds) {
      for (const descendantId of getTopologyNodeDescendants(
        document,
        nodeId,
        timelineCursor,
      )) {
        hidden.add(descendantId);
      }
    }
    return hidden;
  }, [collapsedNodeIds, document, timelineCursor, topologyQuery]);
  const elements = useMemo(() => {
    if (collapsedDescendantIds.size === 0) {
      return filteredElements;
    }
    const visibleNodeIds = new Set(
      filteredElements.nodes
        .filter((node) => !collapsedDescendantIds.has(node.id))
        .map((node) => node.id),
    );
    return {
      nodes: filteredElements.nodes
        .filter((node) => visibleNodeIds.has(node.id))
        .map((node) => ({
          ...node,
          data: {
            ...node.data,
            collapsed: collapsedNodeIds.has(node.id),
          },
        })),
      edges: filteredElements.edges.filter(
        (edge) =>
          visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
      ),
    };
  }, [collapsedDescendantIds, collapsedNodeIds, filteredElements]);
  useEffect(() => {
    if (collapsedDocumentIdRef.current !== document.id) {
      collapsedDocumentIdRef.current = document.id;
      setCollapsedNodeIds(new Set());
      return;
    }
    const expandableIds = new Set(
      allElements.nodes
        .filter((node) => node.data.descendantCount > 0)
        .map((node) => node.id),
    );
    setCollapsedNodeIds((current) => {
      const next = new Set(
        [...current].filter((nodeId) => expandableIds.has(nodeId)),
      );
      return next.size === current.size ? current : next;
    });
  }, [allElements.nodes, document.id]);
  const topologySummary = useMemo(
    () => getTopologySummary(document, timelineCursor),
    [document, timelineCursor],
  );
  const invalidRouteDiagnostics = useMemo(
    () => getTopologyInvalidRouteDiagnostics(document, timelineCursor),
    [document, timelineCursor],
  );
  const expandableTopologyNodeIds = useMemo(
    () =>
      allElements.nodes
        .filter((node) => node.data.descendantCount > 0)
        .map((node) => node.id),
    [allElements.nodes],
  );
  const activeLayer = document.layers.find(
    (layer) => layer.id === activeLayerId,
  );
  const canEditLayer = Boolean(activeLayer?.visible && !activeLayer.locked);
  /**
   * 端口是独立于节点本体的连线手势：选择工具负责常规选中和移动，但
   * 从端口开始的拖动仍然应能创建或重连通道。此前这里只允许 route 工具，
   * 导致卡片上可见的端口在选择工具中成为“假入口”。
   */
  const topologyConnectionGestureEnabled =
    tool === "route" || tool === "select";
  const [nodes, setNodes, onNodesChange] = useNodesState<TopologyNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<TopologyEdge>([]);
  /** 路线工具支持点选起点再点选终点，端口拖拽仍保留为并行操作。 */
  const [connectionStartNodeId, setConnectionStartNodeId] = useState<
    string | null
  >(null);
  /** 鼠标拖动由 drag-stop 一次性提交；方向键没有 drag-stop 事件。 */
  const topologyNodeDraggingRef = useRef(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [isNodeDropTarget, setIsNodeDropTarget] = useState(false);
  // React Flow 的选区是短暂视图状态，但地图编辑器的批量操作以
  // MapDocument 对应的受控选区为准。保留一份同步引用，让连续 Shift
  // 点击不必等待父组件下一次渲染。
  const selectedIdsRef = useRef<readonly string[]>([]);
  // React Flow 在自定义 onNodeClick 之前会先更新自己的临时选区，并在
  // effect 中异步触发 onSelectionChange。普通点击的最终选区由
  // MapDocument 决定，因此要忽略那一次与宿主意图冲突的内部回调；随后
  // 受控 nodes 回写的相同选区仍会正常通过。框选并不设置此标记。
  const pendingHostSelectionRef = useRef<readonly string[] | null>(null);
  const applyDocumentRebase = useCallback(
    (rebase: XYFlowTopologyCanvasProps["documentRebase"]): void => {
      if (
        !rebase ||
        rebase.revision <= appliedDocumentRebaseRevisionRef.current
      ) {
        return;
      }
      const instance = instanceRef.current;
      if (!instance) return;
      const viewport = instance.getViewport();
      void instance.setViewport({
        x: viewport.x - rebase.translation.x * viewport.zoom,
        y: viewport.y - rebase.translation.y * viewport.zoom,
        zoom: viewport.zoom,
      });
      appliedDocumentRebaseRevisionRef.current = rebase.revision;
    },
    [],
  );

  const fitDocumentBounds = useCallback(() => {
    const instance = instanceRef.current;
    if (!instance || fittedDocumentIdRef.current === document.id) return;
    void instance.fitBounds(
      {
        x: 0,
        y: 0,
        width: Math.max(1, document.canvas.width),
        height: Math.max(1, document.canvas.height),
      },
      { padding: 0.08 },
    );
    fittedDocumentIdRef.current = document.id;
  }, [document.canvas.height, document.canvas.width, document.id]);

  useEffect(() => {
    const selectedIds = new Set(
      selectedFeatureIds.length > 0
        ? selectedFeatureIds
        : selectedFeatureId
          ? [selectedFeatureId]
          : [],
    );
    selectedIdsRef.current = [...selectedIds];
    setNodes(
      elements.nodes.map((node) => ({
        ...node,
        // 路线工具的节点点击是连线起点/终点选择，不应进入 React Flow
        // 的普通选区状态；否则 onSelectionChange 与受控 MapDocument 镜像
        // 会互相触发更新。节点组件仍会因为 onNodeClick 保持可点击。
        selectable: tool === "route" ? false : node.selectable,
        draggable: tool === "route" ? false : node.draggable,
        selected: selectedIds.has(node.id),
        data: {
          ...node.data,
          linkedMapName: node.data.linkedMapId
            ? (topologyLinkedMapNames?.get(node.data.linkedMapId) ?? null)
            : null,
          linkedEntityName: node.data.feature.entityRef
            ? (topologyEntityNames?.get(
                `${node.data.feature.entityRef.kind}:${node.data.feature.entityRef.id}`,
              ) ?? null)
            : null,
        },
      })),
    );
    setEdges(
      elements.edges.map((edge) => {
        const color = String(edge.style?.stroke ?? "#8e6044");
        const direction = edge.data?.direction;
        return {
          ...edge,
          selectable: tool === "route" ? false : edge.selectable,
          selected: selectedIds.has(edge.id),
          markerEnd:
            direction === "one-way" || direction === "two-way"
              ? { type: MarkerType.ArrowClosed, color }
              : undefined,
          markerStart:
            direction === "two-way"
              ? { type: MarkerType.ArrowClosed, color }
              : undefined,
          labelStyle: { fill: color, fontSize: 11, fontWeight: 600 },
          labelBgStyle: { fill: "#fffaf1", fillOpacity: 0.92 },
          labelBgPadding: [4, 2] as [number, number],
        };
      }),
    );
  }, [
    elements,
    selectedFeatureId,
    selectedFeatureIds,
    setEdges,
    setNodes,
    tool,
    topologyLinkedMapNames,
    topologyEntityNames,
  ]);

  useEffect(() => {
    if (tool !== "route") setConnectionStartNodeId(null);
  }, [tool]);

  useEffect(() => {
    const cancelConnection = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !connectionStartNodeId) return;
      event.preventDefault();
      setConnectionStartNodeId(null);
    };
    window.addEventListener("keydown", cancelConnection);
    return () => window.removeEventListener("keydown", cancelConnection);
  }, [connectionStartNodeId]);

  useEffect(() => {
    applyDocumentRebase(documentRebase);
  }, [applyDocumentRebase, documentRebase]);

  useEffect(() => {
    fitDocumentBounds();
  }, [fitDocumentBounds]);

  useEffect(() => {
    if (focusRequest === 0) return;
    if (
      selectedFeatureId &&
      nodes.some((node) => node.id === selectedFeatureId)
    ) {
      void instanceRef.current?.fitView({
        nodes: [{ id: selectedFeatureId }],
        padding: 0.6,
        duration: 180,
        maxZoom: 1.5,
      });
      return;
    }
    void instanceRef.current?.fitBounds(
      {
        x: 0,
        y: 0,
        width: Math.max(1, document.canvas.width),
        height: Math.max(1, document.canvas.height),
      },
      { padding: 0.08, duration: 180 },
    );
  }, [
    document.canvas.height,
    document.canvas.width,
    focusRequest,
    nodes,
    selectedFeatureId,
  ]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<TopologyNode>[]) => {
      onNodesChange(changes);
      if (topologyNodeDraggingRef.current) return;

      // React Flow 的方向键移动会产生 dragging=false 的 position change，
      // 但不会触发 onNodeDragStop。这里把已结算坐标写回 MapDocument，保证
      // 节点和关联通道在保存、刷新后仍保持一致。
      const moves = changes
        .filter(
          (
            change,
          ): change is Extract<
            NodeChange<TopologyNode>,
            { type: "position" }
          > =>
            change.type === "position" &&
            change.dragging === false &&
            Boolean(change.position),
        )
        .map((change) => ({
          id: change.id,
          point: {
            x: Math.round(change.position!.x),
            y: Math.round(change.position!.y),
          },
        }))
        .filter((move) => {
          const current = document.features.find(
            (feature) => feature.id === move.id && feature.kind === "node",
          )?.points[0];
          return Boolean(
            current &&
              (current.x !== move.point.x || current.y !== move.point.y),
          );
        });
      if (moves.length > 0) onTopologyNodesMove(moves);
    },
    [document.features, onNodesChange, onTopologyNodesMove],
  );

  const handleConnect = (connection: Connection) => {
    if (!topologyConnectionGestureEnabled) return;
    if (!canEditLayer) {
      onTopologyError?.("当前拓扑图层已隐藏或锁定，无法创建通道。");
      return;
    }
    const feature = createTopologyEdgeFeature({
      id: nextFeatureId("feature"),
      layerId: activeLayerId,
      connection,
      document,
      relation: topologyRouteTemplate?.relation,
      direction: topologyRouteTemplate?.direction,
    });
    if (feature) {
      onCreate(feature);
      setConnectionStartNodeId(null);
    } else {
      onTopologyError?.("通道无效或已存在相同关系，未创建重复通道。");
    }
  };

  const handleNodeDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isTopologyNodeDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setIsNodeDropTarget(true);
  }, []);

  const handleNodeDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const nextTarget = event.relatedTarget;
      if (
        nextTarget instanceof Node &&
        event.currentTarget.contains(nextTarget)
      ) {
        return;
      }
      setIsNodeDropTarget(false);
    },
    [],
  );

  const handleNodeDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!isTopologyNodeDrag(event)) return;
      event.preventDefault();
      // ReactFlow 位于外层容器内部，两处都需要监听 drop 才能兼容不同
      // 版本的事件转发，但同一事件只能落一个节点。阻止冒泡把创建动作
      // 收敛为一次，避免拖放时悄悄产生重复拓扑事实。
      event.stopPropagation();
      setIsNodeDropTarget(false);
      if (!canEditLayer) {
        onTopologyError?.("当前拓扑图层已隐藏或锁定，无法放置节点。");
        return;
      }
      const point = instanceRef.current?.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      }) ?? { x: event.clientX, y: event.clientY };
      onCreate(
        createTopologyNodeFeature({
          id: nextFeatureId("feature"),
          layerId: activeLayerId,
          point,
          ...topologyNodeDropTemplate(event, topologyNodeTemplate),
        }),
      );
      onTopologyNodePlaced?.();
    },
    [
      activeLayerId,
      canEditLayer,
      onCreate,
      onTopologyNodePlaced,
      onTopologyError,
      topologyNodeTemplate,
    ],
  );

  const handleRouteNodeClick = useCallback(
    (nodeId: string, locked: boolean): boolean => {
      if (!canEditLayer) {
        onTopologyError?.("当前拓扑图层已隐藏或锁定，无法创建通道。");
        return false;
      }
      if (locked) {
        onTopologyError?.("当前节点或所属图层已锁定，无法作为通道端点。");
        return false;
      }
      const sourceNodeId = connectionStartNodeId;
      if (!sourceNodeId) {
        setConnectionStartNodeId(nodeId);
        return true;
      }
      if (sourceNodeId === nodeId) {
        setConnectionStartNodeId(null);
        return true;
      }
      const feature = createTopologyEdgeFeature({
        id: nextFeatureId("feature"),
        layerId: activeLayerId,
        connection: { source: sourceNodeId, target: nodeId },
        document,
        relation: topologyRouteTemplate?.relation,
        direction: topologyRouteTemplate?.direction,
      });
      if (feature) onCreate(feature);
      else {
        onTopologyError?.("通道无效或已存在相同关系，未创建重复通道。");
      }
      setConnectionStartNodeId(null);
      return true;
    },
    [
      activeLayerId,
      canEditLayer,
      connectionStartNodeId,
      document,
      onCreate,
      onTopologyError,
      topologyRouteTemplate?.direction,
      topologyRouteTemplate?.relation,
    ],
  );

  const nodeTypes = useMemo(
    () =>
      ({
        "topology-world": (nodeProps: NodeProps<TopologyNode>) => (
          <TopologyWorldNode
            {...nodeProps}
            connectionStart={nodeProps.id === connectionStartNodeId}
            routeToolActive={topologyConnectionGestureEnabled && canEditLayer}
            onTopologyNodeAdjacent={onTopologyNodeAdjacent}
            onTopologyNodeHierarchyAdjacent={onTopologyNodeHierarchyAdjacent}
            onTopologyNodeLockToggle={onTopologyNodeLockToggle}
            onTopologyNodeOpen={onTopologyNodeOpen}
            onTopologyNodeCreateMap={onTopologyNodeCreateMap}
            onTopologyNodeImportSettingSubtree={
              onTopologyNodeImportSettingSubtree
            }
            onTopologyNodeDuplicate={onTopologyNodeDuplicate}
            onTopologyNodeDelete={onTopologyNodeDelete}
            onTopologyNodeCollapse={(featureId) => {
              setCollapsedNodeIds((current) => {
                const next = new Set(current);
                if (next.has(featureId)) next.delete(featureId);
                else next.add(featureId);
                return next;
              });
            }}
          />
        ),
      }) satisfies NodeTypes,
    [
      canEditLayer,
      connectionStartNodeId,
      onTopologyNodeAdjacent,
      onTopologyNodeHierarchyAdjacent,
      onTopologyNodeLockToggle,
      onTopologyNodeCreateMap,
      onTopologyNodeImportSettingSubtree,
      onTopologyNodeDuplicate,
      onTopologyNodeDelete,
      onTopologyNodeOpen,
      topologyConnectionGestureEnabled,
    ],
  );

  const handleSelectionChange = useCallback(
    ({
      nodes: selectedNodes,
      edges: selectedEdges,
    }: {
      readonly nodes: readonly TopologyNode[];
      readonly edges: readonly TopologyEdge[];
    }) => {
      const ids = [
        ...selectedNodes.map((node) => node.id),
        ...selectedEdges.map((edge) => edge.id),
      ];
      const pendingHostSelection = pendingHostSelectionRef.current;
      if (pendingHostSelection) {
        const matchesHostSelection =
          ids.length === pendingHostSelection.length &&
          ids.every((id) => pendingHostSelection.includes(id));
        if (!matchesHostSelection) {
          // 节点点击先由 React Flow 内部选中最后一个元素，再由宿主按
          // Shift/Ctrl 规则写入完整选区。不能让前者覆盖后者。
          pendingHostSelectionRef.current = null;
          return;
        }
        pendingHostSelectionRef.current = null;
      }
      selectedIdsRef.current = ids;
      if (onSelectionChange) onSelectionChange(ids, ids.at(-1) ?? null);
      else onSelect(ids.at(-1) ?? null);
    },
    [onSelect, onSelectionChange],
  );

  const setTopologySelection = useCallback(
    (ids: readonly string[], primaryId: string | null) => {
      const next = [...new Set(ids)];
      const primary =
        primaryId && next.includes(primaryId)
          ? primaryId
          : (next.at(-1) ?? null);
      selectedIdsRef.current = next;
      if (onSelectionChange) onSelectionChange(next, primary);
      else onSelect(primary);
    },
    [onSelect, onSelectionChange],
  );

  const handleFeatureClick = useCallback(
    (
      featureId: string,
      event: {
        readonly shiftKey?: boolean;
        readonly ctrlKey?: boolean;
        readonly metaKey?: boolean;
      },
    ) => {
      const selection = toggleTopologySelection(
        selectedIdsRef.current,
        featureId,
        Boolean(event.shiftKey || event.ctrlKey || event.metaKey),
      );
      pendingHostSelectionRef.current = selection.ids;
      setTopologySelection(selection.ids, selection.primaryId);
    },
    [setTopologySelection],
  );

  // 筛选和折叠只改变画布视图，不应留下指向不可见事实的批量选区。
  const visibleElementIds = useMemo(
    () =>
      new Set([
        ...elements.nodes.map((node) => node.id),
        ...elements.edges.map((edge) => edge.id),
      ]),
    [elements],
  );
  useEffect(() => {
    const current = selectedIdsRef.current;
    const next = current.filter((id) => visibleElementIds.has(id));
    if (next.length === current.length) return;
    setTopologySelection(
      next,
      selectedFeatureId && next.includes(selectedFeatureId)
        ? selectedFeatureId
        : (next.at(-1) ?? null),
    );
  }, [selectedFeatureId, setTopologySelection, visibleElementIds]);

  const handleCanvasKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      if (event.key === "Escape") {
        if (connectionStartNodeId) setConnectionStartNodeId(null);
        if (selectedIdsRef.current.length > 0) {
          event.preventDefault();
          setTopologySelection([], null);
        }
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLocaleLowerCase("en-US") === "a"
      ) {
        const ids = [
          ...elements.nodes.map((node) => node.id),
          ...elements.edges.map((edge) => edge.id),
        ];
        if (ids.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          setTopologySelection(ids, ids.at(-1) ?? null);
        }
      }
    },
    [connectionStartNodeId, elements, setTopologySelection],
  );

  const exportMap = useCallback(async () => {
    if (isExporting) return;
    setIsExporting(true);
    setExportError(null);
    try {
      await downloadMapDocumentPng(
        document,
        timelineCursor,
        projectArtworkSources,
      );
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsExporting(false);
    }
  }, [document, isExporting, projectArtworkSources, timelineCursor]);

  return (
    <div
      className="relative h-full min-h-0 w-full overflow-hidden"
      style={mapCanvasBackgroundStyle(document.canvas)}
      aria-label="世界拓扑画布"
      tabIndex={0}
      onKeyDownCapture={handleCanvasKeyDown}
      onDragOver={handleNodeDragOver}
      onDragLeave={handleNodeDragLeave}
      onDrop={handleNodeDrop}
    >
      <ReactFlow<TopologyNode, TopologyEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onDragOver={handleNodeDragOver}
        onDrop={handleNodeDrop}
        onInit={(instance) => {
          instanceRef.current = instance;
          fitDocumentBounds();
          applyDocumentRebase(documentRebase);
        }}
        onNodeClick={(event, node) => {
          if (tool === "route") {
            // 节点点击和空白画布点击的语义互斥：前者推进两段式连线，
            // 后者才取消已选起点。否则 React Flow 冒泡会在同一手势中
            // 先设置再清空起点，作者看不到任何连线状态。
            if (handleRouteNodeClick(node.id, node.data.locked)) {
              event.stopPropagation();
            }
            return;
          }
          // 选择节点时立即同步宿主选区。不能只依赖 React Flow 的内部
          // selection state，因为节点/边在这里是受控镜像；显式处理 Shift
          // 和 Ctrl/Cmd 追加选择后，批量移动、复制、删除使用同一份事实。
          handleFeatureClick(node.id, event);
          // 选区由上面的 MapDocument 镜像负责提交；阻止事件继续冒泡到
          // React Flow 的默认节点选区处理，避免 Shift 多选先写入两个节点
          // 又被内部回调按最后一个节点覆盖。
          event.stopPropagation();
        }}
        onEdgeClick={(event, edge) => {
          // 节点工具只限制“空白处创建节点”，不应阻断已有通道的检查。
          // 否则作者切换到节点工具后无法打开路线检查器，只能先切换选择工具。
          if (tool !== "route") {
            handleFeatureClick(edge.id, event);
            event.stopPropagation();
          }
        }}
        onNodeDoubleClick={(_, node) => {
          if (tool === "route") return;
          setTopologySelection([node.id], node.id);
          // 双击未关联地图的节点仍应只是打开检查器；只有存在关联地图
          // 时才执行跨地图打开，避免把正常编辑手势误报成错误。
          if (node.data.linkedMapId) onTopologyNodeOpen?.(node.id);
        }}
        onSelectionChange={handleSelectionChange}
        onPaneClick={(event) => {
          if (tool === "node" && canEditLayer) {
            const point = instanceRef.current?.screenToFlowPosition({
              x: event.clientX,
              y: event.clientY,
            });
            if (point) {
              onCreate(
                createTopologyNodeFeature({
                  id: nextFeatureId("feature"),
                  layerId: activeLayerId,
                  point,
                  kind: topologyNodeTemplate?.kind,
                  status: topologyNodeTemplate?.status,
                  name: topologyNodeTemplate?.name,
                  color: topologyNodeTemplate?.color,
                  linkedMapId: topologyNodeTemplate?.linkedMapId,
                  entityRef: topologyNodeTemplate?.entityRef,
                }),
              );
            }
            return;
          }
          if (tool === "route") setConnectionStartNodeId(null);
          // React Flow 的 pane click 不会自动清理宿主编辑器的多选镜像。
          // 两套选区若不同时清空，删除/复制/方向键会继续作用于已经不可见
          // 的旧选区。
          setTopologySelection([], null);
        }}
        onNodeDragStart={() => {
          topologyNodeDraggingRef.current = true;
        }}
        onNodeDragStop={(_, node, draggedNodes) => {
          topologyNodeDraggingRef.current = false;
          const movedNodes = draggedNodes.length > 0 ? draggedNodes : [node];
          const moves = movedNodes
            .map((movedNode) => ({
              id: movedNode.id,
              point: {
                x: Math.round(movedNode.position.x),
                y: Math.round(movedNode.position.y),
              },
            }))
            .filter((move) => {
              const current = document.features.find(
                (feature) => feature.id === move.id && feature.kind === "node",
              )?.points[0];
              return (
                current &&
                (current.x !== move.point.x || current.y !== move.point.y)
              );
            });
          if (moves.length > 0) onTopologyNodesMove(moves);
        }}
        onConnectStart={(_, params) => {
          if (topologyConnectionGestureEnabled && canEditLayer) {
            setConnectionStartNodeId(params.nodeId ?? null);
          }
        }}
        onConnectEnd={() => {
          // 有效连接会在 onConnect 中清理；无效拖线也必须结束起点状态，
          // 否则下一次点选会误把旧起点当作当前起点。
          setConnectionStartNodeId(null);
        }}
        onConnect={handleConnect}
        onReconnect={(edge, connection) => {
          if (
            !topologyConnectionGestureEnabled ||
            !connection.source ||
            !connection.target ||
            !onTopologyEdgeReconnect
          ) {
            return;
          }
          onTopologyEdgeReconnect(
            edge.id,
            connection.source,
            connection.target,
          );
        }}
        onNodesDelete={(deletedNodes) => {
          onTopologyDelete?.(deletedNodes.map((node) => node.id));
        }}
        onEdgesDelete={(deletedEdges) => {
          onTopologyDelete?.(deletedEdges.map((edge) => edge.id));
        }}
        isValidConnection={(connection) =>
          canConnectTopologyNodes(
            document,
            connection.source,
            connection.target,
          )
        }
        connectionMode={ConnectionMode.Loose}
        // 选择工具也允许拖动节点，保持拓扑图的常规图编辑习惯；框选仍
        // 只发生在空白画布上，移动工具则继续用于明确的批量移动语义。
        // 节点工具负责“空白处创建节点”，但不应让已存在节点变成不可移动；
        // 在节点卡片上拖动不会触发 pane click，因此不会误创建新事实。
        nodesDraggable={tool === "move" || tool === "select" || tool === "node"}
        nodesConnectable={topologyConnectionGestureEnabled && canEditLayer}
        edgesReconnectable={topologyConnectionGestureEnabled && canEditLayer}
        elementsSelectable={tool === "select" || tool === "move"}
        // 与地理画布保持一致：显式平移工具允许左键拖动；其它工具仍可用
        // 中键导航，空格临时平移由 React Flow 的 panActivationKeyCode 处理。
        panOnDrag={tool === "pan" ? true : [1]}
        panActivationKeyCode="Space"
        autoPanOnNodeDrag={
          tool === "move" || tool === "select" || tool === "node"
        }
        autoPanSpeed={20}
        // 移动工具与选择工具都支持在空白处框选节点。移动工具的语义是
        // “框选后直接拖动”，而不是只能逐个点选；否则画布底部提示的
        // 批量移动入口实际上无法触发多选。
        selectionOnDrag={tool === "select" || tool === "move"}
        // 删除仍由 MapEditor 的回调写入 MapDocument；React Flow 只负责
        // 触发删除事件，避免受控 nodes/edges 与事实源脱节。
        deleteKeyCode={["Backspace", "Delete"]}
        minZoom={0.2}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        colorMode="light"
        className={
          tool === "node"
            ? "cursor-crosshair"
            : tool === "route"
              ? "cursor-cell"
              : ""
        }
      >
        <ViewportPortal>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 box-border border border-[#746b6080]"
            style={{
              width: Math.max(1, document.canvas.width),
              height: Math.max(1, document.canvas.height),
            }}
          />
        </ViewportPortal>
        {document.canvas.showGrid && (
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1.5}
            color="#8b806f55"
          />
        )}
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => String(node.data.color)}
          maskColor="rgba(245, 240, 229, 0.72)"
          className="!border !border-[#746b6038] !bg-[#fffaf1]"
        />
        <Controls
          showInteractive={false}
          className="!border !border-[#746b6038] !bg-[#fffaf1] !shadow-none"
        />
      </ReactFlow>
      <div className="pointer-events-none absolute right-3 top-3 z-10 flex flex-col items-end gap-1">
        <div className="pointer-events-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() =>
              setCollapsedNodeIds(new Set(expandableTopologyNodeIds))
            }
            disabled={expandableTopologyNodeIds.length === 0}
            title="折叠全部拓扑子节点"
            aria-label="折叠全部拓扑子节点"
            className="grid h-8 w-8 place-items-center rounded-md border border-[#746b6038] bg-[#fffaf1] text-[#51483e] shadow-sm hover:bg-[#eee8dc] disabled:cursor-not-allowed disabled:opacity-45"
          >
            <ListCollapse className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setCollapsedNodeIds(new Set())}
            disabled={collapsedNodeIds.size === 0}
            title="展开全部拓扑子节点"
            aria-label="展开全部拓扑子节点"
            className="grid h-8 w-8 place-items-center rounded-md border border-[#746b6038] bg-[#fffaf1] text-[#51483e] shadow-sm hover:bg-[#eee8dc] disabled:cursor-not-allowed disabled:opacity-45"
          >
            <ListTree className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => void exportMap()}
            disabled={isExporting}
            title={`导出高清 PNG（${Math.round(document.canvas.width)} × ${Math.round(document.canvas.height)}）`}
            aria-label="导出高清 PNG"
            className="grid h-8 w-8 place-items-center rounded-md border border-[#746b6038] bg-[#fffaf1] text-[#51483e] shadow-sm hover:bg-[#eee8dc] disabled:cursor-wait disabled:opacity-55"
          >
            {isExporting ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
          </button>
        </div>
        {exportError && (
          <span
            role="status"
            className="max-w-56 rounded border border-[#c7543638] bg-[#fffaf1ee] px-2 py-1 text-right text-xs text-[#9d4735]"
          >
            {exportError}
          </span>
        )}
        {invalidRouteDiagnostics.length > 0 && (
          <div className="pointer-events-auto mt-1 w-64 rounded-md border border-[#c47a4738] bg-[#fffaf1ee] p-2 text-xs text-[#6e6256] shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-[#9d4735]">
                拓扑诊断 {invalidRouteDiagnostics.length} 条
              </span>
              <span className="text-xs text-[#9d6b35]">未显示在线路层</span>
            </div>
            <div className="mt-1.5 space-y-1">
              {invalidRouteDiagnostics.slice(0, 5).map((diagnostic) => (
                <button
                  key={diagnostic.route.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded border border-[#c47a4728] px-2 py-1 text-left hover:border-[#c47a4770] hover:bg-[#c47a4710]"
                  title="打开通道检查器以重新选择端点或删除通道"
                  aria-label={`检查无效通道：${diagnostic.route.name}`}
                  onClick={() => {
                    onTopologyInvalidRouteSelect?.(diagnostic.route.id);
                    if (!onTopologyInvalidRouteSelect) {
                      onSelect(diagnostic.route.id);
                    }
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-[#51483e]">
                    {diagnostic.route.name}
                  </span>
                  <span className="shrink-0 text-xs text-[#9d6b35]">
                    {diagnostic.reasonLabel}
                  </span>
                </button>
              ))}
            </div>
            {invalidRouteDiagnostics.length > 5 && (
              <p className="mt-1 text-xs text-[#9d6b35]">
                还有 {invalidRouteDiagnostics.length - 5} 条，请先处理当前清单。
              </p>
            )}
          </div>
        )}
      </div>
      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded-md border border-[#746b6038] bg-[#fffaf1dd] px-3 py-2 text-xs text-[#6e6256]">
            选择“拓扑节点”，设置节点类型后点击画布创建
          </p>
        </div>
      )}
      {isNodeDropTarget && (
        <div
          className="pointer-events-none absolute inset-3 z-20 grid place-items-center rounded-lg border-2 border-dashed border-[var(--accent-warm)] bg-[var(--accent-warm)]/10"
          role="status"
        >
          <span className="rounded-md border border-[var(--accent-warm)] bg-[var(--paper-elevated)] px-3 py-2 text-xs font-medium text-[var(--ink)] shadow-sm">
            松开以放置拓扑节点
          </span>
        </div>
      )}
      <div className="pointer-events-none absolute bottom-3 left-3 rounded border border-[#7f736633] bg-[#fffaf1cc] px-2 py-1 text-xs text-[#6e6256]">
        {tool === "route"
          ? connectionStartNodeId
            ? "已选择起点；点击目标节点创建通道，或从端口拖到目标节点"
            : "点击起点再点击目标节点创建通道；也可从节点端口拖动连接"
          : tool === "select"
            ? "拖动节点标题移动；从节点端口拖动可创建或重连通道"
            : tool === "move"
              ? "拖动节点或框选多个节点，关联通道会同步更新"
              : document.projectionType === "multiverse"
                ? `多元宇宙拓扑 · ${getTopologyNodeKindOption(topologyNodeTemplate?.kind ?? "world").label}`
                : "平行世界分支"}
      </div>
      {topologyQuery.trim() && (
        <div
          className="pointer-events-none absolute bottom-11 left-3 rounded border border-[#7f736633] bg-[#fffaf1cc] px-2 py-1 text-xs text-[#6e6256]"
          role="status"
        >
          筛选结果：{nodes.length} 个节点 · {edges.length} 条通道
        </div>
      )}
      <div
        className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-2 rounded border border-[#7f736633] bg-[#fffaf1cc] px-2 py-1 text-xs text-[#6e6256]"
        aria-label="拓扑统计"
      >
        <span>
          节点 {topologySummary.nodeCount} · 通道 {topologySummary.routeCount}
        </span>
        {topologySummary.isolatedNodeCount > 0 && (
          <span className="text-[#9d6b35]">
            孤立 {topologySummary.isolatedNodeCount}
          </span>
        )}
        {topologySummary.invalidRouteCount > 0 && (
          <span className="text-[#9d4735]">
            无效通道 {topologySummary.invalidRouteCount}
          </span>
        )}
      </div>
    </div>
  );
}
