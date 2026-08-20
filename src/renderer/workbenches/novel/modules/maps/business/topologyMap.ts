import type { Connection, Edge, Node } from "@xyflow/react";
import dagre from "@dagrejs/dagre";

import {
  MAP_TOPOLOGY_SOURCE_NODE_PROP,
  MAP_TOPOLOGY_TARGET_NODE_PROP,
  type MapDocument,
  type MapFeature,
  type MapProjectionType,
} from "../entities/mapSchema";

export const TOPOLOGY_SOURCE_NODE_PROP = MAP_TOPOLOGY_SOURCE_NODE_PROP;
export const TOPOLOGY_TARGET_NODE_PROP = MAP_TOPOLOGY_TARGET_NODE_PROP;
/** 拓扑节点工具拖放到 XYFlow 画布时使用的稳定数据类型。 */
export const TOPOLOGY_NODE_DRAG_MIME = "application/x-myagents-topology-node";

export const TOPOLOGY_NODE_KIND_OPTIONS = [
  {
    value: "universe",
    label: "宇宙",
    defaultName: "新宇宙",
    color: "#526b87",
  },
  {
    value: "galaxy",
    label: "星系",
    defaultName: "新星系",
    color: "#5e6f9b",
  },
  {
    value: "star-system",
    label: "恒星系",
    defaultName: "新恒星系",
    color: "#8a6f4d",
  },
  {
    value: "world",
    label: "世界",
    defaultName: "新世界",
    color: "#507b88",
  },
  {
    value: "realm",
    label: "位面",
    defaultName: "新位面",
    color: "#75658b",
  },
  {
    value: "planet",
    label: "星球",
    defaultName: "新星球",
    color: "#657b55",
  },
  {
    value: "continent",
    label: "大陆",
    defaultName: "新大陆",
    color: "#718057",
  },
  {
    value: "timeline",
    label: "时间分支",
    defaultName: "新时间分支",
    color: "#8a6651",
  },
  {
    value: "settlement",
    label: "聚落",
    defaultName: "新聚落",
    color: "#9a6a55",
  },
] as const;

export type TopologyNodeKind =
  (typeof TOPOLOGY_NODE_KIND_OPTIONS)[number]["value"];

/** 地图模块读取世界架构空间树时使用的最小结构，不复制设定正文。 */
export interface TopologySettingNodeSource {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly typeId: string;
  readonly order?: number;
}

export interface TopologySettingLevelSource {
  readonly id: string;
  readonly name?: string;
  readonly mapKind?: string;
}

export interface TopologySettingTreeImportResult {
  readonly map: MapDocument;
  readonly importedNodeIds: readonly string[];
  readonly importedRouteIds: readonly string[];
  readonly rootNodeId: string | null;
}

/** 将世界架构层级的地图语义映射到拓扑节点类型。 */
export function topologyNodeKindForSettingMapKind(
  mapKind: string | null | undefined,
  levelName?: string | null,
): TopologyNodeKind {
  const normalizedLevelName = levelName?.trim() ?? "";
  switch (mapKind) {
    case "cosmic-region":
      return "universe";
    case "stellar-region":
      return "star-system";
    case "planet-point":
      return "planet";
    case "settlement-point":
      return /城市|城镇|村|聚落|都城|港口|要塞/u.test(normalizedLevelName)
        ? "settlement"
        : "realm";
    case "geographic-area":
      return /大陆|大洲|洲/u.test(normalizedLevelName) ? "continent" : "world";
    default:
      return "world";
  }
}

export const TOPOLOGY_NODE_STATUS_OPTIONS = [
  { value: "active", label: "活动", color: "#4e7d58" },
  { value: "dormant", label: "休眠", color: "#8a7659" },
  { value: "sealed", label: "封闭", color: "#8b5960" },
  { value: "destroyed", label: "毁灭", color: "#756b67" },
] as const;

export type TopologyNodeStatus =
  (typeof TOPOLOGY_NODE_STATUS_OPTIONS)[number]["value"];

export const TOPOLOGY_ROUTE_RELATION_OPTIONS = [
  { value: "passage", label: "世界通道" },
  { value: "branch", label: "世界分支" },
  { value: "portal", label: "传送门" },
  { value: "rift", label: "界壁裂隙" },
] as const;

export type TopologyRouteRelation =
  (typeof TOPOLOGY_ROUTE_RELATION_OPTIONS)[number]["value"];

export type TopologyRouteDirection = "one-way" | "two-way";

const TOPOLOGY_NODE_KIND_PROP = "topologyNodeKind";
const TOPOLOGY_NODE_STATUS_PROP = "topologyNodeStatus";
export const TOPOLOGY_NODE_LOCKED_PROP = "topologyNodeLocked";
const TOPOLOGY_ROUTE_RELATION_PROP = "topologyRouteRelation";
const TOPOLOGY_ROUTE_DIRECTION_PROP = "topologyRouteDirection";
const TOPOLOGY_LINKED_MAP_PROP = "linkedMapId";

const TOPOLOGY_NODE_KIND_BY_VALUE = new Set<TopologyNodeKind>(
  TOPOLOGY_NODE_KIND_OPTIONS.map((option) => option.value),
);
const TOPOLOGY_NODE_STATUS_BY_VALUE = new Set<TopologyNodeStatus>(
  TOPOLOGY_NODE_STATUS_OPTIONS.map((option) => option.value),
);
const TOPOLOGY_ROUTE_RELATION_BY_VALUE = new Set<TopologyRouteRelation>(
  TOPOLOGY_ROUTE_RELATION_OPTIONS.map((option) => option.value),
);

function topologyOptionLabel<
  T extends { readonly value: string; readonly label: string },
>(options: readonly T[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

export function getTopologyNodeKindOption(kind: TopologyNodeKind) {
  return (
    TOPOLOGY_NODE_KIND_OPTIONS.find((option) => option.value === kind) ??
    TOPOLOGY_NODE_KIND_OPTIONS[1]
  );
}

export function topologyNodeKindForProjection(
  projectionType: MapProjectionType,
): TopologyNodeKind {
  switch (projectionType) {
    case "multiverse":
      return "universe";
    case "parallel":
      return "timeline";
    case "planet":
      return "planet";
    default:
      return "world";
  }
}

/**
 * 从拓扑节点下钻新建地图时使用的默认投影。节点类型与地图投影保持一一
 * 对应，避免在世界节点下意外创建不匹配的画布类型。
 */
export function topologyProjectionForNodeKind(
  kind: TopologyNodeKind,
): MapProjectionType {
  switch (kind) {
    case "universe":
    case "galaxy":
    case "star-system":
      return "multiverse";
    case "timeline":
      return "parallel";
    case "planet":
      return "planet";
    case "continent":
    case "settlement":
    case "world":
    case "realm":
      return "continent";
  }
}

export function getTopologyNodeKind(
  feature: Pick<MapFeature, "props">,
): TopologyNodeKind {
  const value = feature.props[TOPOLOGY_NODE_KIND_PROP];
  return value && TOPOLOGY_NODE_KIND_BY_VALUE.has(value as TopologyNodeKind)
    ? (value as TopologyNodeKind)
    : "world";
}

export function getTopologyNodeKindLabel(
  feature: Pick<MapFeature, "props">,
): string {
  return topologyOptionLabel(
    TOPOLOGY_NODE_KIND_OPTIONS,
    getTopologyNodeKind(feature),
  );
}

export function getTopologyNodeStatus(
  feature: Pick<MapFeature, "props">,
): TopologyNodeStatus {
  const value = feature.props[TOPOLOGY_NODE_STATUS_PROP];
  return value && TOPOLOGY_NODE_STATUS_BY_VALUE.has(value as TopologyNodeStatus)
    ? (value as TopologyNodeStatus)
    : "active";
}

export function getTopologyNodeStatusOption(status: TopologyNodeStatus) {
  return (
    TOPOLOGY_NODE_STATUS_OPTIONS.find((option) => option.value === status) ??
    TOPOLOGY_NODE_STATUS_OPTIONS[0]
  );
}

export function getTopologyNodeStatusLabel(
  feature: Pick<MapFeature, "props">,
): string {
  return getTopologyNodeStatusOption(getTopologyNodeStatus(feature)).label;
}

/** 节点锁定是节点自身的编辑状态，不等同于所属地图图层锁定。 */
export function getTopologyNodeLocked(
  feature: Pick<MapFeature, "props">,
): boolean {
  return feature.props[TOPOLOGY_NODE_LOCKED_PROP] === "true";
}

export function getTopologyNodeLinkedMapId(
  feature: Pick<MapFeature, "props">,
): string | null {
  return feature.props[TOPOLOGY_LINKED_MAP_PROP]?.trim() || null;
}

export function getTopologyRouteRelation(
  feature: Pick<MapFeature, "props">,
): TopologyRouteRelation {
  const value = feature.props[TOPOLOGY_ROUTE_RELATION_PROP];
  return value &&
    TOPOLOGY_ROUTE_RELATION_BY_VALUE.has(value as TopologyRouteRelation)
    ? (value as TopologyRouteRelation)
    : "passage";
}

export function getTopologyRouteRelationLabel(
  relation: TopologyRouteRelation,
): string {
  return topologyOptionLabel(TOPOLOGY_ROUTE_RELATION_OPTIONS, relation);
}

export function getTopologyRouteDirection(
  feature: Pick<MapFeature, "props">,
): TopologyRouteDirection {
  return feature.props[TOPOLOGY_ROUTE_DIRECTION_PROP] === "one-way"
    ? "one-way"
    : "two-way";
}

/**
 * 拓扑通道标签是路线事实的展示属性。缺失时兼容旧地图并默认显示，只有
 * 明确写入 `false` 才隐藏；画布和 PNG 导出必须共用这条规则。
 */
export function topologyRouteLabelVisible(
  feature: Pick<MapFeature, "props">,
): boolean {
  return feature.props.showLabel !== "false";
}

/** 拓扑节点名称标签与路线标签使用同一份兼容语义。 */
export function topologyNodeLabelVisible(
  feature: Pick<MapFeature, "props">,
): boolean {
  return feature.props.showLabel !== "false";
}

export function topologyNodeProps(
  patch: Partial<{
    readonly kind: TopologyNodeKind;
    readonly status: TopologyNodeStatus;
    readonly locked: boolean;
    readonly linkedMapId: string | null;
  }>,
): Record<string, string> {
  const props: Record<string, string> = {};
  if (patch.kind) props[TOPOLOGY_NODE_KIND_PROP] = patch.kind;
  if (patch.status) props[TOPOLOGY_NODE_STATUS_PROP] = patch.status;
  if (patch.locked !== undefined) {
    props[TOPOLOGY_NODE_LOCKED_PROP] = String(patch.locked);
  }
  if (patch.linkedMapId) props[TOPOLOGY_LINKED_MAP_PROP] = patch.linkedMapId;
  return props;
}

/** 节点元数据更新需要支持解除关联，因此由业务层集中处理 props 的删除语义。 */
export function updateTopologyNodeProps(
  current: Readonly<Record<string, string>>,
  patch: Partial<{
    readonly kind: TopologyNodeKind;
    readonly status: TopologyNodeStatus;
    readonly locked: boolean;
    readonly linkedMapId: string | null;
  }>,
): Record<string, string> {
  const props = { ...current };
  if (patch.kind) props[TOPOLOGY_NODE_KIND_PROP] = patch.kind;
  if (patch.status) props[TOPOLOGY_NODE_STATUS_PROP] = patch.status;
  if (patch.locked !== undefined) {
    props[TOPOLOGY_NODE_LOCKED_PROP] = String(patch.locked);
  }
  if (Object.hasOwn(patch, "linkedMapId")) {
    const linkedMapId = patch.linkedMapId?.trim();
    if (linkedMapId) props[TOPOLOGY_LINKED_MAP_PROP] = linkedMapId;
    else delete props[TOPOLOGY_LINKED_MAP_PROP];
  }
  return props;
}

export function topologyRouteProps(
  patch: Partial<{
    readonly relation: TopologyRouteRelation;
    readonly direction: TopologyRouteDirection;
  }>,
): Record<string, string> {
  const props: Record<string, string> = {};
  if (patch.relation) props[TOPOLOGY_ROUTE_RELATION_PROP] = patch.relation;
  if (patch.direction) props[TOPOLOGY_ROUTE_DIRECTION_PROP] = patch.direction;
  return props;
}

/**
 * 拓扑通道的唯一性由端点、关系和方向共同决定。双向通道的端点无序，
 * 单向通道的端点有序；这个规则必须由创建、重连、反转和检查器编辑共同
 * 使用，不能只在画布拖线时校验。
 */
export function hasDuplicateTopologyRoute(
  document: MapDocument,
  input: {
    readonly sourceNodeId: string;
    readonly targetNodeId: string;
    readonly relation: TopologyRouteRelation;
    readonly direction: TopologyRouteDirection;
    readonly ignoreRouteId?: string;
  },
): boolean {
  return document.features.some((feature) => {
    if (
      feature.kind !== "route" ||
      feature.id === input.ignoreRouteId ||
      getTopologyRouteRelation(feature) !== input.relation ||
      getTopologyRouteDirection(feature) !== input.direction
    ) {
      return false;
    }
    const sourceNodeId = feature.props[TOPOLOGY_SOURCE_NODE_PROP];
    const targetNodeId = feature.props[TOPOLOGY_TARGET_NODE_PROP];
    if (!sourceNodeId || !targetNodeId) return false;
    return input.direction === "two-way"
      ? (sourceNodeId === input.sourceNodeId &&
          targetNodeId === input.targetNodeId) ||
          (sourceNodeId === input.targetNodeId &&
            targetNodeId === input.sourceNodeId)
      : sourceNodeId === input.sourceNodeId &&
          targetNodeId === input.targetNodeId;
  });
}

/** 原子更新通道的关系或方向，供检查器与其它编辑入口共享。 */
export function updateTopologyRoute(
  document: MapDocument,
  routeId: string,
  patch: Partial<{
    readonly relation: TopologyRouteRelation;
    readonly direction: TopologyRouteDirection;
  }>,
): MapDocument | null {
  const route = topologyFeatureById(document, routeId, "route");
  if (!route || topologyRouteHasLockedEndpoint(document, route)) return null;
  const layer = document.layers.find(
    (candidate) => candidate.id === route.layerId,
  );
  if (!layer?.visible || layer.locked) return null;
  const sourceNodeId = route.props[TOPOLOGY_SOURCE_NODE_PROP];
  const targetNodeId = route.props[TOPOLOGY_TARGET_NODE_PROP];
  if (
    !sourceNodeId ||
    !targetNodeId ||
    !canConnectTopologyNodes(document, sourceNodeId, targetNodeId)
  ) {
    return null;
  }
  const relation = patch.relation ?? getTopologyRouteRelation(route);
  const direction = patch.direction ?? getTopologyRouteDirection(route);
  if (
    relation === "branch" &&
    direction === "one-way" &&
    topologyBranchRouteWouldCycle(
      document,
      sourceNodeId,
      targetNodeId,
      route.id,
    )
  ) {
    return null;
  }
  if (
    hasDuplicateTopologyRoute(document, {
      sourceNodeId,
      targetNodeId,
      relation,
      direction,
      ignoreRouteId: route.id,
    })
  ) {
    return null;
  }
  if (
    relation === getTopologyRouteRelation(route) &&
    direction === getTopologyRouteDirection(route)
  ) {
    return document;
  }
  return {
    ...document,
    features: document.features.map((feature) =>
      feature.id === route.id
        ? {
            ...feature,
            name: TOPOLOGY_ROUTE_RELATION_OPTIONS.some(
              (option) => option.label === route.name,
            )
              ? getTopologyRouteRelationLabel(relation)
              : route.name,
            props: {
              ...feature.props,
              ...topologyRouteProps({ relation, direction }),
            },
          }
        : feature,
    ),
  };
}

export interface TopologyNodeData extends Record<string, unknown> {
  readonly label: string;
  readonly showLabel: boolean;
  readonly description: string;
  readonly color: string;
  readonly kind: TopologyNodeKind;
  readonly kindLabel: string;
  readonly status: TopologyNodeStatus;
  readonly statusLabel: string;
  readonly linkedMapId: string | null;
  readonly linkedMapName?: string | null;
  readonly linkedEntityName?: string | null;
  /** 关联的世界架构节点 id；仅从 MapFeature.entityRef 派生。 */
  readonly settingRefId: string | null;
  readonly nodeLocked: boolean;
  readonly connectionCount: number;
  readonly incomingCount: number;
  readonly outgoingCount: number;
  /** branch + one-way 关系中的直接父节点数量。 */
  readonly parentCount: number;
  /** branch + one-way 关系中的直接子节点数量。 */
  readonly childCount: number;
  /** 从层级根到当前节点的祖先 id，不包含当前节点。 */
  readonly ancestorIds: readonly string[];
  /** 祖先节点名称路径；仅由 branch + one-way 路线派生。 */
  readonly ancestorPath: string;
  /** branch + one-way 关系中的全部后代数量，用于层级画布折叠提示。 */
  readonly descendantCount: number;
  /** 仅由拓扑画布维护的视图状态，不写入 MapDocument。 */
  readonly collapsed?: boolean;
  readonly feature: MapFeature;
  readonly locked: boolean;
}

export type TopologyNode = Node<TopologyNodeData>;
export interface TopologyEdgeData extends Record<string, unknown> {
  readonly relation: TopologyRouteRelation;
  readonly direction: TopologyRouteDirection;
}

export type TopologyEdge = Edge<TopologyEdgeData>;

export interface TopologySummary {
  readonly nodeCount: number;
  readonly routeCount: number;
  readonly connectedNodeCount: number;
  readonly isolatedNodeCount: number;
  readonly invalidRouteCount: number;
}

export type TopologyInvalidRouteReason =
  | "missing-source"
  | "missing-target"
  | "hidden-source"
  | "hidden-target"
  | "self-loop"
  | "duplicate-route"
  | "branch-cycle";

export interface TopologyInvalidRouteDiagnostic {
  readonly route: MapFeature;
  readonly sourceNodeId: string | null;
  readonly targetNodeId: string | null;
  readonly reason: TopologyInvalidRouteReason;
  readonly reasonLabel: string;
}

export type TopologyNodeRouteDirection = "incoming" | "outgoing" | "two-way";

export interface TopologyNodeRouteReference {
  readonly route: MapFeature;
  readonly direction: TopologyNodeRouteDirection;
}

/**
 * 拓扑画布的点选规则。React Flow 的节点和边是受控状态，不能把 Shift
 * 多选交给内部临时状态，否则父组件回写 MapDocument 后下一次点击会丢失
 * 之前的选区。该纯函数同时服务节点和通道，保证点击语义一致。
 */
export function toggleTopologySelection(
  currentIds: readonly string[],
  featureId: string,
  additive: boolean,
): { readonly ids: readonly string[]; readonly primaryId: string | null } {
  const current = [...new Set(currentIds)];
  if (!additive) {
    return { ids: [featureId], primaryId: featureId };
  }
  const next = current.includes(featureId)
    ? current.filter((id) => id !== featureId)
    : [...current, featureId];
  return { ids: next, primaryId: next.at(-1) ?? null };
}

/**
 * 返回一个节点在世界架构分支中的全部后代。
 *
 * 只有 `branch + one-way` 才是层级事实；普通世界通道、传送门和裂隙不
 * 应被折叠操作误认为父子关系。结果按首次遍历顺序稳定返回，并过滤掉
 * 当前时间切片或图层不可见、端点失效的路线。
 */
export function getTopologyNodeDescendants(
  document: MapDocument,
  nodeId: string,
  timelineCursor: number | null = null,
): readonly string[] {
  const descendantsByNode = topologyBranchDescendants(document, timelineCursor);
  return descendantsByNode.get(nodeId) ?? [];
}

/**
 * 返回当前节点在拓扑层级分支中的祖先路径（根节点在前）。
 *
 * 拓扑允许普通通道与层级分支并存，因此只有 `branch + one-way` 才能
 * 参与祖先推导。一个节点若存在多个父分支，沿 MapDocument 中首次出现的
 * 有效路线取一条稳定路径；多父关系仍会由 `parentCount` 完整统计，并不
 * 会被这个展示路径伪装成单一事实。
 */
export function getTopologyNodeAncestors(
  document: MapDocument,
  nodeId: string,
  timelineCursor: number | null = null,
): readonly string[] {
  const visibleIds = visibleFeatureIds(document, timelineCursor);
  const invalidRouteIds = new Set(
    getTopologyInvalidRouteDiagnostics(document, timelineCursor).map(
      (diagnostic) => diagnostic.route.id,
    ),
  );
  const nodeIds = new Set(
    document.features
      .filter(
        (feature) => feature.kind === "node" && visibleIds.has(feature.id),
      )
      .map((feature) => feature.id),
  );
  if (!nodeIds.has(nodeId)) return [];

  const parentByChild = topologyBranchParentByChildFromRoutes(
    nodeIds,
    document.features.filter(
      (route) =>
        route.kind === "route" &&
        visibleIds.has(route.id) &&
        !invalidRouteIds.has(route.id),
    ),
  );

  const ancestors: string[] = [];
  const visited = new Set<string>([nodeId]);
  let parent = parentByChild.get(nodeId);
  while (parent && !visited.has(parent)) {
    visited.add(parent);
    ancestors.unshift(parent);
    parent = parentByChild.get(parent);
  }
  return ancestors;
}

function topologyBranchDescendants(
  document: MapDocument,
  timelineCursor: number | null,
): ReadonlyMap<string, readonly string[]> {
  const visibleIds = visibleFeatureIds(document, timelineCursor);
  const invalidRouteIds = new Set(
    getTopologyInvalidRouteDiagnostics(document, timelineCursor).map(
      (diagnostic) => diagnostic.route.id,
    ),
  );
  const nodeIds = new Set(
    document.features
      .filter(
        (feature) => feature.kind === "node" && visibleIds.has(feature.id),
      )
      .map((feature) => feature.id),
  );
  if (nodeIds.size === 0) return new Map();

  const routes = document.features.filter(
    (route) =>
      route.kind === "route" &&
      visibleIds.has(route.id) &&
      !invalidRouteIds.has(route.id),
  );
  return topologyBranchDescendantsFromRoutes(nodeIds, routes);
}

function topologyBranchDescendantsFromRoutes(
  nodeIds: ReadonlySet<string>,
  routes: readonly MapFeature[],
): ReadonlyMap<string, readonly string[]> {
  const childrenByParent = new Map<string, string[]>();
  for (const route of routes) {
    if (
      route.kind !== "route" ||
      getTopologyRouteRelation(route) !== "branch" ||
      getTopologyRouteDirection(route) !== "one-way"
    ) {
      continue;
    }
    const source = route.props[TOPOLOGY_SOURCE_NODE_PROP];
    const target = route.props[TOPOLOGY_TARGET_NODE_PROP];
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) {
      continue;
    }
    const children = childrenByParent.get(source) ?? [];
    children.push(target);
    childrenByParent.set(source, children);
  }

  const result = new Map<string, readonly string[]>();
  for (const rootNodeId of nodeIds) {
    const descendants: string[] = [];
    const pending = [...(childrenByParent.get(rootNodeId) ?? [])];
    const visited = new Set<string>([rootNodeId]);
    while (pending.length > 0) {
      const current = pending.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      descendants.push(current);
      for (const child of childrenByParent.get(current) ?? []) {
        if (!visited.has(child)) pending.push(child);
      }
    }
    result.set(rootNodeId, descendants);
  }
  return result;
}

/** 按路线出现顺序为每个层级子节点保留第一条有效父分支。 */
function topologyBranchParentByChildFromRoutes(
  nodeIds: ReadonlySet<string>,
  routes: readonly MapFeature[],
): ReadonlyMap<string, string> {
  const parentByChild = new Map<string, string>();
  for (const route of routes) {
    if (
      route.kind !== "route" ||
      getTopologyRouteRelation(route) !== "branch" ||
      getTopologyRouteDirection(route) !== "one-way"
    ) {
      continue;
    }
    const source = route.props[TOPOLOGY_SOURCE_NODE_PROP];
    const target = route.props[TOPOLOGY_TARGET_NODE_PROP];
    if (
      !source ||
      !target ||
      !nodeIds.has(source) ||
      !nodeIds.has(target) ||
      parentByChild.has(target)
    ) {
      continue;
    }
    parentByChild.set(target, source);
  }
  return parentByChild;
}

/** 节点级编辑权限，供移动、复制、删除、布局等入口共用。 */
export function canEditTopologyNodes(
  document: MapDocument,
  nodeIds: readonly string[],
): boolean {
  const ids = [...new Set(nodeIds)];
  return (
    ids.length > 0 &&
    ids.every((nodeId) => {
      const node = document.features.find(
        (feature) => feature.id === nodeId && feature.kind === "node",
      );
      if (!node || getTopologyNodeLocked(node)) return false;
      const layer = document.layers.find((entry) => entry.id === node.layerId);
      return Boolean(layer?.visible && !layer.locked);
    })
  );
}

/**
 * 返回当前时间切片中某个节点的有效连接。
 *
 * 画布渲染、拓扑统计和节点检查器必须共享同一套可见性与端点校验，
 * 否则隐藏图层、时间切片或旧数据中的悬空路线会继续出现在检查器里，
 * 让作者误以为节点仍然连通。路线只返回一次，双向路线用 `two-way`
 * 表达，避免检查器把同一条路线计数两次。
 */
export function getTopologyNodeConnections(
  document: MapDocument,
  nodeId: string,
  timelineCursor: number | null = null,
): {
  readonly connectionCount: number;
  readonly incomingCount: number;
  readonly outgoingCount: number;
  readonly parentCount: number;
  readonly childCount: number;
  readonly routes: readonly TopologyNodeRouteReference[];
} {
  const visibleIds = visibleFeatureIds(document, timelineCursor);
  const invalidRouteIds = new Set(
    getTopologyInvalidRouteDiagnostics(document, timelineCursor).map(
      (diagnostic) => diagnostic.route.id,
    ),
  );
  const nodeIds = new Set(
    document.features
      .filter(
        (feature) => feature.kind === "node" && visibleIds.has(feature.id),
      )
      .map((feature) => feature.id),
  );
  if (!nodeIds.has(nodeId)) {
    return {
      connectionCount: 0,
      incomingCount: 0,
      outgoingCount: 0,
      parentCount: 0,
      childCount: 0,
      routes: [],
    };
  }

  const routes: TopologyNodeRouteReference[] = [];
  let incomingCount = 0;
  let outgoingCount = 0;
  let parentCount = 0;
  let childCount = 0;
  for (const route of document.features) {
    if (
      route.kind !== "route" ||
      !visibleIds.has(route.id) ||
      invalidRouteIds.has(route.id)
    ) {
      continue;
    }
    const source = route.props[TOPOLOGY_SOURCE_NODE_PROP];
    const target = route.props[TOPOLOGY_TARGET_NODE_PROP];
    if (
      !source ||
      !target ||
      source === target ||
      !nodeIds.has(source) ||
      !nodeIds.has(target) ||
      (source !== nodeId && target !== nodeId)
    ) {
      continue;
    }
    const direction = getTopologyRouteDirection(route);
    if (direction === "two-way") {
      incomingCount += 1;
      outgoingCount += 1;
      routes.push({ route, direction: "two-way" });
    } else if (source === nodeId) {
      outgoingCount += 1;
      routes.push({ route, direction: "outgoing" });
    } else {
      incomingCount += 1;
      routes.push({ route, direction: "incoming" });
    }
    if (
      getTopologyRouteRelation(route) === "branch" &&
      getTopologyRouteDirection(route) === "one-way"
    ) {
      if (source === nodeId) childCount += 1;
      if (target === nodeId) parentCount += 1;
    }
  }
  return {
    connectionCount: routes.length,
    incomingCount,
    outgoingCount,
    parentCount,
    childCount,
    routes,
  };
}

type TopologyPortId = "top" | "right" | "bottom" | "left";
type TopologySourceHandleId = `source-port-${TopologyPortId}`;
type TopologyTargetHandleId = `target-port-${TopologyPortId}`;

function topologyPortsBetween(
  source: { readonly x: number; readonly y: number },
  target: { readonly x: number; readonly y: number },
): {
  readonly source: TopologySourceHandleId;
  readonly target: TopologyTargetHandleId;
} {
  const deltaX = target.x - source.x;
  const deltaY = target.y - source.y;
  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    return deltaX >= 0
      ? { source: "source-port-right", target: "target-port-left" }
      : { source: "source-port-left", target: "target-port-right" };
  }
  return deltaY >= 0
    ? { source: "source-port-bottom", target: "target-port-top" }
    : { source: "source-port-top", target: "target-port-bottom" };
}

function topologyRouteDasharray(relation: TopologyRouteRelation): string {
  switch (relation) {
    case "branch":
      return "8 5";
    case "portal":
      return "3 4";
    case "rift":
      return "12 4 3 4";
    default:
      return "none";
  }
}

function isVisibleAt(
  feature: MapFeature,
  timelineCursor: number | null,
): boolean {
  if (timelineCursor === null) return true;
  return (
    (feature.timeFrom === null || timelineCursor >= feature.timeFrom) &&
    (feature.timeTo === null || timelineCursor <= feature.timeTo)
  );
}

function visibleFeatureIds(
  document: MapDocument,
  timelineCursor: number | null,
): ReadonlySet<string> {
  const visibleLayers = new Set(
    document.layers.filter((layer) => layer.visible).map((layer) => layer.id),
  );
  return new Set(
    document.features
      .filter(
        (feature) =>
          visibleLayers.has(feature.layerId) &&
          isVisibleAt(feature, timelineCursor),
      )
      .map((feature) => feature.id),
  );
}

function topologyInvalidRouteReasonLabel(
  reason: TopologyInvalidRouteReason,
): string {
  switch (reason) {
    case "missing-source":
      return "缺少来源节点";
    case "missing-target":
      return "缺少目标节点";
    case "hidden-source":
      return "来源节点不可见";
    case "hidden-target":
      return "目标节点不可见";
    case "self-loop":
      return "不能连接自身";
    case "duplicate-route":
      return "重复通道关系";
    case "branch-cycle":
      return "分支关系形成环路";
  }
}

function topologyRouteIdentity(
  route: Pick<MapFeature, "props">,
): string | null {
  const source = route.props[TOPOLOGY_SOURCE_NODE_PROP];
  const target = route.props[TOPOLOGY_TARGET_NODE_PROP];
  if (!source || !target) return null;
  const direction = getTopologyRouteDirection(route);
  const endpoints =
    direction === "two-way" ? [source, target].sort() : [source, target];
  return [
    getTopologyRouteRelation(route),
    direction,
    endpoints[0],
    endpoints[1],
  ].join("|");
}

/**
 * 分支关系表达空间树的父子方向，不能把目标节点再次连回来源节点。
 * 该检查只针对 `branch + one-way`，普通世界通道和双向分支仍允许形成
 * 环状交通网络。`ignoreRouteId` 用于重连、反转和属性编辑时排除原路线。
 */
function topologyBranchRouteWouldCycle(
  document: MapDocument,
  sourceNodeId: string,
  targetNodeId: string,
  ignoreRouteId?: string,
  visibleRouteIds?: ReadonlySet<string>,
): boolean {
  if (sourceNodeId === targetNodeId) return true;
  const nodeIds = new Set(
    document.features
      .filter((feature) => feature.kind === "node")
      .map((feature) => feature.id),
  );
  if (!nodeIds.has(sourceNodeId) || !nodeIds.has(targetNodeId)) return true;
  const adjacency = new Map<string, string[]>();
  for (const route of document.features) {
    if (
      route.kind !== "route" ||
      route.id === ignoreRouteId ||
      (visibleRouteIds && !visibleRouteIds.has(route.id)) ||
      getTopologyRouteRelation(route) !== "branch" ||
      getTopologyRouteDirection(route) !== "one-way"
    ) {
      continue;
    }
    const source = route.props[TOPOLOGY_SOURCE_NODE_PROP];
    const target = route.props[TOPOLOGY_TARGET_NODE_PROP];
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) {
      continue;
    }
    const targets = adjacency.get(source) ?? [];
    targets.push(target);
    adjacency.set(source, targets);
  }
  const pending = [targetNodeId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === sourceNodeId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) pending.push(next);
    }
  }
  return false;
}

/**
 * 返回当前时间切片中无法渲染的路线，并保留足够的端点信息供检查器修复。
 * 这类路线不能静默从画布消失：旧地图、隐藏图层或时间切片都可能暂时造成
 * 悬空引用，作者必须能够定位并删除或重新选择端点。
 */
export function getTopologyInvalidRouteDiagnostics(
  document: MapDocument,
  timelineCursor: number | null = null,
): readonly TopologyInvalidRouteDiagnostic[] {
  const visibleIds = visibleFeatureIds(document, timelineCursor);
  const nodesById = new Map(
    document.features
      .filter((feature) => feature.kind === "node")
      .map((feature) => [feature.id, feature] as const),
  );
  const visibleNodeIds = new Set(
    document.features
      .filter(
        (feature) => feature.kind === "node" && visibleIds.has(feature.id),
      )
      .map((feature) => feature.id),
  );
  const diagnostics: TopologyInvalidRouteDiagnostic[] = [];
  const routeIdentities = new Set<string>();
  for (const route of document.features) {
    if (route.kind !== "route" || !visibleIds.has(route.id)) {
      continue;
    }
    const sourceNodeId = route.props[TOPOLOGY_SOURCE_NODE_PROP] ?? null;
    const targetNodeId = route.props[TOPOLOGY_TARGET_NODE_PROP] ?? null;
    let reason: TopologyInvalidRouteReason | null = null;
    if (!sourceNodeId || !nodesById.has(sourceNodeId)) {
      reason = "missing-source";
    } else if (!targetNodeId || !nodesById.has(targetNodeId)) {
      reason = "missing-target";
    } else if (sourceNodeId === targetNodeId) {
      reason = "self-loop";
    } else if (!visibleNodeIds.has(sourceNodeId)) {
      reason = "hidden-source";
    } else if (!visibleNodeIds.has(targetNodeId)) {
      reason = "hidden-target";
    } else {
      const identity = topologyRouteIdentity(route);
      if (identity && routeIdentities.has(identity)) {
        reason = "duplicate-route";
      } else if (
        getTopologyRouteRelation(route) === "branch" &&
        getTopologyRouteDirection(route) === "one-way" &&
        topologyBranchRouteWouldCycle(
          document,
          sourceNodeId,
          targetNodeId,
          route.id,
          visibleIds,
        )
      ) {
        reason = "branch-cycle";
      }
      if (identity) routeIdentities.add(identity);
    }
    if (reason) {
      diagnostics.push({
        route,
        sourceNodeId,
        targetNodeId,
        reason,
        reasonLabel: topologyInvalidRouteReasonLabel(reason),
      });
    }
  }
  return diagnostics;
}

export function buildTopologyElements(
  document: MapDocument,
  timelineCursor: number | null,
): {
  readonly nodes: readonly TopologyNode[];
  readonly edges: readonly TopologyEdge[];
} {
  const visibleIds = visibleFeatureIds(document, timelineCursor);
  const visibleRoutes = document.features.filter(
    (feature) => feature.kind === "route" && visibleIds.has(feature.id),
  );
  const invalidRouteIds = new Set(
    getTopologyInvalidRouteDiagnostics(document, timelineCursor).map(
      (diagnostic) => diagnostic.route.id,
    ),
  );
  const visibleNodes = document.features.filter(
    (feature) => feature.kind === "node" && visibleIds.has(feature.id),
  );
  const nodeIds = new Set(visibleNodes.map((node) => node.id));
  // 连接统计与渲染必须使用同一组有效通道。旧地图可能保留已经删除的
  // 端点引用；如果先统计再过滤，节点卡片会显示“有连接”而画布没有对应
  // 线路，检查器与实际拓扑便会失去一致性。
  const validVisibleRoutes = visibleRoutes.filter((route) => {
    const source = route.props[TOPOLOGY_SOURCE_NODE_PROP];
    const target = route.props[TOPOLOGY_TARGET_NODE_PROP];
    return Boolean(
      !invalidRouteIds.has(route.id) &&
        source &&
        target &&
        source !== target &&
        nodeIds.has(source) &&
        nodeIds.has(target),
    );
  });
  const descendantIdsByNode = topologyBranchDescendantsFromRoutes(
    nodeIds,
    validVisibleRoutes,
  );
  const parentByChild = topologyBranchParentByChildFromRoutes(
    nodeIds,
    validVisibleRoutes,
  );
  const nodeNames = new Map(
    visibleNodes.map((node) => [node.id, node.name] as const),
  );
  const ancestorIdsByNode = new Map<string, readonly string[]>();
  for (const node of visibleNodes) {
    const ancestors: string[] = [];
    const visited = new Set<string>([node.id]);
    let parent = parentByChild.get(node.id);
    while (parent && !visited.has(parent)) {
      visited.add(parent);
      ancestors.unshift(parent);
      parent = parentByChild.get(parent);
    }
    ancestorIdsByNode.set(node.id, ancestors);
  }
  const connectionMetrics = new Map<
    string,
    {
      incoming: number;
      outgoing: number;
      total: number;
      parents: number;
      children: number;
    }
  >();
  for (const route of validVisibleRoutes) {
    const source = route.props[TOPOLOGY_SOURCE_NODE_PROP];
    const target = route.props[TOPOLOGY_TARGET_NODE_PROP];
    const direction = getTopologyRouteDirection(route);
    if (source) {
      const metric = connectionMetrics.get(source) ?? {
        incoming: 0,
        outgoing: 0,
        total: 0,
        parents: 0,
        children: 0,
      };
      metric.outgoing += 1;
      metric.total += 1;
      if (direction === "two-way") metric.incoming += 1;
      if (
        getTopologyRouteRelation(route) === "branch" &&
        direction === "one-way"
      ) {
        metric.children += 1;
      }
      connectionMetrics.set(source, metric);
    }
    if (target) {
      const metric = connectionMetrics.get(target) ?? {
        incoming: 0,
        outgoing: 0,
        total: 0,
        parents: 0,
        children: 0,
      };
      metric.incoming += 1;
      metric.total += 1;
      if (direction === "two-way") metric.outgoing += 1;
      if (
        getTopologyRouteRelation(route) === "branch" &&
        direction === "one-way"
      ) {
        metric.parents += 1;
      }
      connectionMetrics.set(target, metric);
    }
  }
  const nodes = visibleNodes.map<TopologyNode>((feature) => {
    const layer = document.layers.find((entry) => entry.id === feature.layerId);
    const point = feature.points[0] ?? { x: 0, y: 0 };
    const status = getTopologyNodeStatus(feature);
    const nodeLocked = getTopologyNodeLocked(feature);
    const metrics = connectionMetrics.get(feature.id) ?? {
      incoming: 0,
      outgoing: 0,
      total: 0,
      parents: 0,
      children: 0,
    };
    const ancestorIds = ancestorIdsByNode.get(feature.id) ?? [];
    return {
      id: feature.id,
      position: point,
      type: "topology-world",
      draggable: !layer?.locked && !nodeLocked,
      // 节点卡片内的快捷按钮、连线端口和拖动动作职责分离；只有标题栏
      // 的拖动手柄负责移动，避免点击按钮时触发节点位移。
      dragHandle: ".topology-node-drag-handle",
      // 锁定图层仍应能选中查看节点；编辑能力由 draggable/connectable
      // 控制，避免“锁定后整张拓扑无法检查”的死角。
      selectable: true,
      connectable: Boolean(layer?.visible && !layer.locked && !nodeLocked),
      data: {
        label: feature.name,
        showLabel: topologyNodeLabelVisible(feature),
        description: feature.description,
        color: feature.props.color ?? "#507b88",
        kind: getTopologyNodeKind(feature),
        kindLabel: getTopologyNodeKindLabel(feature),
        status,
        statusLabel: getTopologyNodeStatusLabel(feature),
        linkedMapId: getTopologyNodeLinkedMapId(feature),
        settingRefId:
          feature.entityRef?.kind === "setting" ? feature.entityRef.id : null,
        nodeLocked,
        connectionCount: metrics.total,
        incomingCount: metrics.incoming,
        outgoingCount: metrics.outgoing,
        parentCount: metrics.parents,
        childCount: metrics.children,
        ancestorIds,
        ancestorPath: ancestorIds
          .map((ancestorId) => nodeNames.get(ancestorId) ?? ancestorId)
          .join(" / "),
        descendantCount: descendantIdsByNode.get(feature.id)?.length ?? 0,
        feature,
        locked: Boolean(layer?.locked || nodeLocked),
      },
      style: {
        opacity: (layer?.opacity ?? 1) * (status === "destroyed" ? 0.62 : 1),
        width: 176,
        height: 104,
      },
    };
  });
  const nodePoints = new Map(
    nodes.map((node) => [node.id, node.position] as const),
  );
  const edges = validVisibleRoutes.flatMap<TopologyEdge>((feature) => {
    const source = feature.props[TOPOLOGY_SOURCE_NODE_PROP];
    const target = feature.props[TOPOLOGY_TARGET_NODE_PROP];
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) {
      return [];
    }
    const layer = document.layers.find((entry) => entry.id === feature.layerId);
    const relation = getTopologyRouteRelation(feature);
    const direction = getTopologyRouteDirection(feature);
    const ports = topologyPortsBetween(
      nodePoints.get(source)!,
      nodePoints.get(target)!,
    );
    const parsedLineWidth = Number(feature.props.lineWidth ?? 2);
    return [
      {
        id: feature.id,
        source,
        target,
        sourceHandle: ports.source,
        targetHandle: ports.target,
        label: topologyRouteLabelVisible(feature) ? feature.name : undefined,
        data: {
          relation,
          direction,
        },
        // 与节点一致：锁定通道可查看、不可重连；删除/属性修改仍由
        // MapEditor 的图层契约拒绝。
        selectable: true,
        reconnectable: Boolean(
          layer?.visible &&
            !layer.locked &&
            !getTopologyNodeLocked(
              visibleNodes.find((node) => node.id === source)!,
            ) &&
            !getTopologyNodeLocked(
              visibleNodes.find((node) => node.id === target)!,
            ),
        ),
        animated: feature.props.animated === "true",
        type: relation === "branch" ? "smoothstep" : "default",
        style: {
          stroke: feature.props.color ?? "#8e6044",
          strokeWidth:
            Number.isFinite(parsedLineWidth) && parsedLineWidth > 0
              ? parsedLineWidth
              : 2,
          strokeDasharray: topologyRouteDasharray(relation),
          opacity: layer?.opacity ?? 1,
        },
      },
    ];
  });
  return { nodes, edges };
}

export function createTopologyNodeFeature(input: {
  readonly id: string;
  readonly layerId: string;
  readonly point: { readonly x: number; readonly y: number };
  readonly kind?: TopologyNodeKind;
  readonly status?: TopologyNodeStatus;
  readonly locked?: boolean;
  readonly name?: string;
  readonly color?: string;
  readonly linkedMapId?: string | null;
  readonly entityRef?: MapFeature["entityRef"];
}): MapFeature {
  const kind = input.kind ?? "world";
  const status = input.status ?? "active";
  const option = getTopologyNodeKindOption(kind);
  return {
    id: input.id,
    kind: "node",
    name: input.name?.trim() || option.defaultName,
    entityRef: input.entityRef ?? null,
    layerId: input.layerId,
    points: [{ x: input.point.x, y: input.point.y }],
    timeFrom: null,
    timeTo: null,
    props: {
      color: input.color ?? option.color,
      showLabel: "true",
      ...topologyNodeProps({
        kind,
        status,
        locked: input.locked === true ? true : undefined,
        linkedMapId: input.linkedMapId,
      }),
    },
    description: "",
  };
}

export type TopologyConnectedNodeDirection = "incoming" | "outgoing";

export type TopologyHierarchyNodeDirection = "parent" | "child";

/**
 * 为从节点工具栏创建的前置/后继节点计算一个可读的默认落点。
 *
 * 拓扑节点不是自由散布的地图标记：连续点击“前置/后继”应当形成一列
 * 可继续编辑的节点，而不是把所有新节点压在同一个坐标上。这里仅根据
 * 当前事实源中的节点矩形做确定性避让，不保存额外布局状态。
 */
export function topologyAdjacentNodePoint(
  document: MapDocument,
  anchorNodeId: string,
  direction: TopologyConnectedNodeDirection,
): { readonly x: number; readonly y: number } | null {
  const anchor = topologyFeatureById(document, anchorNodeId, "node");
  const anchorPoint = anchor?.points[0];
  if (!anchorPoint) return null;

  const x = anchorPoint.x + (direction === "incoming" ? -280 : 280);
  const occupied = document.features
    .filter((feature) => feature.kind === "node" && feature.id !== anchorNodeId)
    .map((feature) => feature.points[0])
    .filter((point): point is { x: number; y: number } => Boolean(point));

  // 节点卡片默认约 176 × 104，留出约 16px 视觉间距；只向下扩展，保证
  // 连续创建的顺序稳定且不会因为已有节点数量变化而随机跳动。
  const step = 136;
  for (let index = 0; index < 4096; index += 1) {
    const candidate = { x, y: anchorPoint.y + index * step };
    const overlaps = occupied.some(
      (point) =>
        Math.abs(point.x - candidate.x) < 176 &&
        Math.abs(point.y - candidate.y) < 104,
    );
    if (!overlaps) return candidate;
  }
  return { x, y: anchorPoint.y };
}

/**
 * 为层级父子节点计算垂直落点。父节点在上方、子节点在下方；同一层的
 * 后续节点向右展开，避免把层级关系误画成普通的左右行进链。
 */
export function topologyHierarchyAdjacentNodePoint(
  document: MapDocument,
  anchorNodeId: string,
  direction: TopologyHierarchyNodeDirection,
): { readonly x: number; readonly y: number } | null {
  const anchor = topologyFeatureById(document, anchorNodeId, "node");
  const anchorPoint = anchor?.points[0];
  if (!anchorPoint) return null;

  const occupied = document.features
    .filter((feature) => feature.kind === "node" && feature.id !== anchorNodeId)
    .map((feature) => feature.points[0])
    .filter((point): point is { x: number; y: number } => Boolean(point));
  const y = anchorPoint.y + (direction === "parent" ? -192 : 192);
  const step = 208;
  for (let index = 0; index < 4096; index += 1) {
    const candidate = {
      x: anchorPoint.x + index * step,
      y,
    };
    const overlaps = occupied.some(
      (point) =>
        Math.abs(point.x - candidate.x) < 176 &&
        Math.abs(point.y - candidate.y) < 104,
    );
    if (!overlaps) return candidate;
  }
  return { x: anchorPoint.x, y };
}

export interface TopologyNodeTemplate {
  readonly kind?: TopologyNodeKind;
  readonly status?: TopologyNodeStatus;
  readonly locked?: boolean;
  readonly name?: string;
  readonly color?: string;
  readonly linkedMapId?: string | null;
  readonly entityRef?: MapFeature["entityRef"];
}

function topologyFeatureById(
  document: MapDocument,
  featureId: string,
  kind: MapFeature["kind"],
): MapFeature | null {
  return (
    document.features.find(
      (feature) => feature.id === featureId && feature.kind === kind,
    ) ?? null
  );
}

function topologyRouteHasLockedEndpoint(
  document: MapDocument,
  route: MapFeature,
): boolean {
  if (route.kind !== "route") return false;
  const endpointIds = [
    route.props[TOPOLOGY_SOURCE_NODE_PROP],
    route.props[TOPOLOGY_TARGET_NODE_PROP],
  ];
  return endpointIds.some((endpointId) => {
    const node = endpointId
      ? topologyFeatureById(document, endpointId, "node")
      : null;
    return Boolean(node && getTopologyNodeLocked(node));
  });
}

/**
 * 从已有节点直接创建前置或后继节点。节点和通道必须在同一个 MapDocument
 * 变更中落盘，避免出现只有节点或只有连线的半成品拓扑。
 */
export function createConnectedTopologyNode(
  document: MapDocument,
  input: {
    readonly anchorNodeId: string;
    readonly nodeId: string;
    readonly edgeId: string;
    readonly direction: TopologyConnectedNodeDirection;
    readonly point: { readonly x: number; readonly y: number };
    readonly node?: TopologyNodeTemplate;
    readonly relation?: TopologyRouteRelation;
    readonly routeDirection?: TopologyRouteDirection;
  },
): {
  readonly map: MapDocument;
  readonly nodeId: string;
  readonly edgeId: string;
} | null {
  if (
    document.features.some(
      (feature) => feature.id === input.nodeId || feature.id === input.edgeId,
    )
  ) {
    return null;
  }
  const anchor = topologyFeatureById(document, input.anchorNodeId, "node");
  if (!anchor) return null;
  if (getTopologyNodeLocked(anchor)) return null;
  const anchorLayer = document.layers.find(
    (layer) => layer.id === anchor.layerId,
  );
  if (!anchorLayer?.visible || anchorLayer.locked) return null;

  const node = createTopologyNodeFeature({
    id: input.nodeId,
    layerId: anchor.layerId,
    point: input.point,
    ...input.node,
  });
  const withNode = { ...document, features: [...document.features, node] };
  const connection =
    input.direction === "incoming"
      ? { source: node.id, target: anchor.id }
      : { source: anchor.id, target: node.id };
  const edge = createTopologyEdgeFeature({
    id: input.edgeId,
    layerId: anchor.layerId,
    connection,
    document: withNode,
    relation: input.relation,
    direction: input.routeDirection,
  });
  if (!edge) return null;
  return {
    map: { ...withNode, features: [...withNode.features, edge] },
    nodeId: node.id,
    edgeId: edge.id,
  };
}

function topologyImportedFeatureId(
  prefix: string,
  sourceId: string,
  occupiedIds: Set<string>,
): string {
  const base = `${prefix}-${sourceId}`;
  let candidate = base;
  let suffix = 2;
  while (occupiedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  occupiedIds.add(candidate);
  return candidate;
}

/**
 * 将世界架构空间树的一个子树投影为拓扑节点和父子通道。
 *
 * 该操作只补齐缺失节点，不覆盖作者已经调整过的节点名称、颜色、状态或
 * 地图关联；同一空间节点再次导入时也不会重复创建节点或通道。布局仍由
 * 作者显式触发“自动布局”，避免导入行为悄悄改变已有拓扑坐标。
 */
export function importTopologySettingSubtree(
  document: MapDocument,
  input: {
    readonly rootSettingId: string;
    readonly settingNodes: readonly TopologySettingNodeSource[];
    readonly levelTypes?: readonly TopologySettingLevelSource[];
    readonly layerId: string;
  },
): TopologySettingTreeImportResult {
  const targetLayer = document.layers.find(
    (layer) => layer.id === input.layerId,
  );
  if (!targetLayer || !targetLayer.visible || targetLayer.locked) {
    return {
      map: document,
      importedNodeIds: [],
      importedRouteIds: [],
      rootNodeId: null,
    };
  }
  const sourceById = new Map(
    input.settingNodes.map((node) => [node.id, node] as const),
  );
  const root = sourceById.get(input.rootSettingId);
  if (!root) {
    return {
      map: document,
      importedNodeIds: [],
      importedRouteIds: [],
      rootNodeId: null,
    };
  }

  const childrenByParent = new Map<string, TopologySettingNodeSource[]>();
  for (const node of input.settingNodes) {
    if (!node.parentId || !sourceById.has(node.parentId)) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort(
      (left, right) =>
        (left.order ?? 0) - (right.order ?? 0) ||
        left.name.localeCompare(right.name, "zh-CN") ||
        left.id.localeCompare(right.id),
    );
  }

  const covered = new Set<string>();
  const pending = [root.id];
  const orderedSources: TopologySettingNodeSource[] = [];
  while (pending.length > 0) {
    const id = pending.shift()!;
    if (covered.has(id)) continue;
    const node = sourceById.get(id);
    if (!node) continue;
    covered.add(id);
    orderedSources.push(node);
    for (const child of childrenByParent.get(id) ?? []) pending.push(child.id);
  }

  const levelById = new Map(
    (input.levelTypes ?? []).map((level) => [level.id, level] as const),
  );
  const existingNodeBySettingId = new Map<string, MapFeature>();
  for (const feature of document.features) {
    if (feature.kind !== "node" || feature.entityRef?.kind !== "setting") {
      continue;
    }
    if (!existingNodeBySettingId.has(feature.entityRef.id)) {
      existingNodeBySettingId.set(feature.entityRef.id, feature);
    }
  }

  const occupiedIds = new Set(document.features.map((feature) => feature.id));
  const nodeIdBySettingId = new Map<string, string>();
  for (const source of orderedSources) {
    nodeIdBySettingId.set(
      source.id,
      existingNodeBySettingId.get(source.id)?.id ??
        topologyImportedFeatureId("topology-node", source.id, occupiedIds),
    );
  }

  const importedNodes: MapFeature[] = [];
  const importedNodeIds: string[] = [];
  for (const source of orderedSources) {
    if (existingNodeBySettingId.has(source.id)) continue;
    const nodeId = nodeIdBySettingId.get(source.id)!;
    importedNodes.push(
      createTopologyNodeFeature({
        id: nodeId,
        layerId: input.layerId,
        // 初次导入就按空间树深度分层，避免几十个节点堆在同一条横线上。
        // 后续仍可由作者显式触发 dagre 自动布局；这里不移动已有节点。
        point: (() => {
          let depth = 0;
          let parentId = source.parentId;
          while (parentId) {
            depth += 1;
            parentId = sourceById.get(parentId)?.parentId ?? null;
          }
          const sameDepthIndex = orderedSources
            .slice(0, orderedSources.indexOf(source))
            .filter((candidate) => {
              let candidateDepth = 0;
              let candidateParentId = candidate.parentId;
              while (candidateParentId) {
                candidateDepth += 1;
                candidateParentId =
                  sourceById.get(candidateParentId)?.parentId ?? null;
              }
              return candidateDepth === depth;
            }).length;
          return {
            x: 160 + depth * 280,
            y: 160 + sameDepthIndex * 136,
          };
        })(),
        kind: topologyNodeKindForSettingMapKind(
          levelById.get(source.typeId)?.mapKind,
          levelById.get(source.typeId)?.name,
        ),
        name: source.name,
        entityRef: { kind: "setting", id: source.id },
      }),
    );
    importedNodeIds.push(nodeId);
  }

  const nodesAfterImport = [...document.features, ...importedNodes];
  const importedRoutes: MapFeature[] = [];
  const importedRouteIds: string[] = [];
  for (const source of orderedSources) {
    if (!source.parentId || !nodeIdBySettingId.has(source.parentId)) continue;
    const sourceNodeId = nodeIdBySettingId.get(source.parentId)!;
    const targetNodeId = nodeIdBySettingId.get(source.id)!;
    // 导入的是父子分支关系；同端点的普通世界通道不能阻止作者补上
    // 分支事实，不同关系允许并存。
    const importDocument = {
      ...document,
      features: [...nodesAfterImport, ...importedRoutes],
    };
    const route = createTopologyEdgeFeature({
      id: topologyImportedFeatureId("topology-route", source.id, occupiedIds),
      layerId: input.layerId,
      connection: { source: sourceNodeId, target: targetNodeId },
      document: importDocument,
      relation: "branch",
      direction: "one-way",
    });
    if (!route) continue;
    importedRoutes.push(route);
    importedRouteIds.push(route.id);
  }

  if (importedNodes.length === 0 && importedRoutes.length === 0) {
    return {
      map: document,
      importedNodeIds: [],
      importedRouteIds: [],
      rootNodeId: nodeIdBySettingId.get(root.id) ?? null,
    };
  }
  return {
    map: {
      ...document,
      features: [...document.features, ...importedNodes, ...importedRoutes],
    },
    importedNodeIds,
    importedRouteIds,
    rootNodeId: nodeIdBySettingId.get(root.id) ?? null,
  };
}

/**
 * 在一条通道中间插入节点。保留原通道 id 作为前半段，并复制其全部展示与
 * 业务属性到后半段；两段的端点引用和绘制控制点会一起重建。
 */
export function insertTopologyNodeOnEdge(
  document: MapDocument,
  input: {
    readonly edgeId: string;
    readonly nodeId: string;
    readonly trailingEdgeId: string;
    readonly node?: TopologyNodeTemplate;
  },
): {
  readonly map: MapDocument;
  readonly nodeId: string;
  readonly edgeIds: readonly [string, string];
} | null {
  if (
    document.features.some(
      (feature) =>
        feature.id === input.nodeId || feature.id === input.trailingEdgeId,
    )
  ) {
    return null;
  }
  const edge = topologyFeatureById(document, input.edgeId, "route");
  if (!edge) return null;
  if (topologyRouteHasLockedEndpoint(document, edge)) return null;
  const edgeLayer = document.layers.find((layer) => layer.id === edge.layerId);
  if (!edgeLayer?.visible || edgeLayer.locked) return null;
  const sourceNodeId = edge.props[TOPOLOGY_SOURCE_NODE_PROP];
  const targetNodeId = edge.props[TOPOLOGY_TARGET_NODE_PROP];
  const source = sourceNodeId
    ? topologyFeatureById(document, sourceNodeId, "node")
    : null;
  const target = targetNodeId
    ? topologyFeatureById(document, targetNodeId, "node")
    : null;
  const sourcePoint = source?.points[0];
  const targetPoint = target?.points[0];
  if (!source || !target || !sourcePoint || !targetPoint) return null;
  if (getTopologyNodeLocked(source) || getTopologyNodeLocked(target)) {
    return null;
  }

  const node = createTopologyNodeFeature({
    id: input.nodeId,
    layerId: edge.layerId,
    point: {
      x: Math.round((sourcePoint.x + targetPoint.x) / 2),
      y: Math.round((sourcePoint.y + targetPoint.y) / 2),
    },
    ...input.node,
  });
  const leadingEdge: MapFeature = {
    ...edge,
    points: [sourcePoint, node.points[0]!],
    props: {
      ...edge.props,
      [TOPOLOGY_SOURCE_NODE_PROP]: source.id,
      [TOPOLOGY_TARGET_NODE_PROP]: node.id,
    },
  };
  const trailingEdge: MapFeature = {
    ...edge,
    id: input.trailingEdgeId,
    points: [node.points[0]!, targetPoint],
    props: {
      ...edge.props,
      [TOPOLOGY_SOURCE_NODE_PROP]: node.id,
      [TOPOLOGY_TARGET_NODE_PROP]: target.id,
    },
  };
  return {
    map: {
      ...document,
      features: document.features.flatMap((feature) =>
        feature.id === edge.id ? [leadingEdge, node, trailingEdge] : [feature],
      ),
    },
    nodeId: node.id,
    edgeIds: [leadingEdge.id, trailingEdge.id],
  };
}

export function createTopologyEdgeFeature(input: {
  readonly id: string;
  readonly layerId: string;
  readonly connection: Pick<Connection, "source" | "target">;
  readonly document: MapDocument;
  readonly relation?: TopologyRouteRelation;
  readonly direction?: TopologyRouteDirection;
}): MapFeature | null {
  const { source, target } = input.connection;
  if (!canConnectTopologyNodes(input.document, source, target)) return null;
  const routeLayer = input.document.layers.find(
    (layer) => layer.id === input.layerId,
  );
  if (!routeLayer?.visible || routeLayer.locked) return null;
  const sourceFeature = input.document.features.find(
    (feature) => feature.id === source && feature.kind === "node",
  );
  const targetFeature = input.document.features.find(
    (feature) => feature.id === target && feature.kind === "node",
  );
  if (!sourceFeature || !targetFeature) return null;
  const relation = input.relation ?? "passage";
  const direction = input.direction ?? "two-way";
  if (
    relation === "branch" &&
    direction === "one-way" &&
    topologyBranchRouteWouldCycle(input.document, source, target)
  ) {
    return null;
  }
  // 同一组端点、关系和方向只允许存在一条事实。不同关系（例如世界通道
  // 与传送门）仍可并存；这样既避免误拖端口产生重复线路，也保留拓扑多重
  // 关系的表达能力。
  if (
    hasDuplicateTopologyRoute(input.document, {
      sourceNodeId: source,
      targetNodeId: target,
      relation,
      direction,
    })
  ) {
    return null;
  }
  return {
    id: input.id,
    kind: "route",
    name: getTopologyRouteRelationLabel(relation),
    entityRef: null,
    layerId: input.layerId,
    points: [sourceFeature.points[0]!, targetFeature.points[0]!],
    timeFrom: null,
    timeTo: null,
    props: {
      color: "#8e6044",
      lineWidth: "2",
      showLabel: "true",
      [TOPOLOGY_SOURCE_NODE_PROP]: source,
      [TOPOLOGY_TARGET_NODE_PROP]: target,
      ...topologyRouteProps({ relation, direction }),
    },
    description: "",
  };
}

export type TopologyLayoutDirection = "horizontal" | "vertical";

/**
 * 根据通道方向重排世界节点。布局只负责计算节点坐标，路线端点仍由
 * moveTopologyNodes 统一重建，保证 MapDocument 中不存在第二份线路事实。
 */
export function arrangeTopologyNodes(
  document: MapDocument,
  direction: TopologyLayoutDirection = "horizontal",
): MapDocument {
  const nodes = document.features.filter(
    (feature) => feature.kind === "node" && feature.points[0],
  );
  if (nodes.length < 2) return document;
  if (
    !canEditTopologyNodes(
      document,
      nodes.map((node) => node.id),
    )
  ) {
    return document;
  }

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({
    rankdir: direction === "horizontal" ? "LR" : "TB",
    nodesep: 72,
    ranksep: 128,
    marginx: 96,
    marginy: 96,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) {
    graph.setNode(node.id, { width: 176, height: 104 });
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const invalidRouteIds = new Set(
    getTopologyInvalidRouteDiagnostics(document).map(
      (diagnostic) => diagnostic.route.id,
    ),
  );
  for (const route of document.features) {
    if (
      route.kind !== "route" ||
      invalidRouteIds.has(route.id) ||
      !document.layers.some(
        (layer) => layer.id === route.layerId && layer.visible && !layer.locked,
      )
    ) {
      continue;
    }
    const source = route.props[TOPOLOGY_SOURCE_NODE_PROP];
    const target = route.props[TOPOLOGY_TARGET_NODE_PROP];
    if (source && target && nodeIds.has(source) && nodeIds.has(target)) {
      graph.setEdge(source, target);
    }
  }

  dagre.layout(graph);
  return moveTopologyNodes(
    document,
    nodes.map((node) => {
      const layout = graph.node(node.id);
      return {
        id: node.id,
        point: {
          x: Math.round(layout.x - layout.width / 2),
          y: Math.round(layout.y - layout.height / 2),
        },
      };
    }),
  );
}

export function canConnectTopologyNodes(
  document: MapDocument,
  sourceNodeId: string | null | undefined,
  targetNodeId: string | null | undefined,
): boolean {
  if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) {
    return false;
  }
  const nodes = document.features.filter((feature) => feature.kind === "node");
  const source = nodes.find((node) => node.id === sourceNodeId);
  const target = nodes.find((node) => node.id === targetNodeId);
  if (!source || !target) return false;
  const sourceLayer = document.layers.find(
    (layer) => layer.id === source.layerId,
  );
  const targetLayer = document.layers.find(
    (layer) => layer.id === target.layerId,
  );
  return Boolean(
    !getTopologyNodeLocked(source) &&
      !getTopologyNodeLocked(target) &&
      sourceLayer?.visible &&
      !sourceLayer.locked &&
      targetLayer?.visible &&
      !targetLayer.locked,
  );
}

/**
 * 统计当前时间切片中可见的拓扑事实。无效路线不计入连通节点，方便在
 * 设计器中直接发现悬空或自环数据，而不是把它们误报为有效连接。
 */
export function getTopologySummary(
  document: MapDocument,
  timelineCursor: number | null = null,
): TopologySummary {
  const visibleIds = visibleFeatureIds(document, timelineCursor);
  const nodes = document.features.filter(
    (feature) => feature.kind === "node" && visibleIds.has(feature.id),
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  const connectedNodeIds = new Set<string>();
  let routeCount = 0;
  const invalidRouteIds = new Set(
    getTopologyInvalidRouteDiagnostics(document, timelineCursor).map(
      (diagnostic) => diagnostic.route.id,
    ),
  );
  for (const route of document.features) {
    if (
      route.kind !== "route" ||
      !visibleIds.has(route.id) ||
      invalidRouteIds.has(route.id)
    ) {
      continue;
    }
    const source = route.props[TOPOLOGY_SOURCE_NODE_PROP];
    const target = route.props[TOPOLOGY_TARGET_NODE_PROP];
    if (
      !source ||
      !target ||
      source === target ||
      !nodeIds.has(source) ||
      !nodeIds.has(target)
    ) {
      // 诊断函数已经按同一套可见性、端点和自环规则分类；这里跳过无效
      // 路线只统计可渲染连接，避免两处规则分叉。
      continue;
    }
    routeCount += 1;
    connectedNodeIds.add(source);
    connectedNodeIds.add(target);
  }
  return {
    nodeCount: nodes.length,
    routeCount,
    connectedNodeCount: connectedNodeIds.size,
    isolatedNodeCount: Math.max(0, nodes.length - connectedNodeIds.size),
    invalidRouteCount: invalidRouteIds.size,
  };
}

export function moveTopologyNodes(
  document: MapDocument,
  moves: readonly {
    readonly id: string;
    readonly point: { readonly x: number; readonly y: number };
  }[],
): MapDocument {
  const nextPoints = new Map(
    document.features
      .filter((feature) => feature.kind === "node" && feature.points[0])
      .map((feature) => [feature.id, feature.points[0]!] as const),
  );
  let changed = false;
  for (const move of moves) {
    // XYFlow 的测量阶段在画布尚未完成布局时可能给出 NaN；这类坐标
    // 不是可持久化的地图事实，必须在唯一事实源入口拒绝，而不是把坏值
    // 继续同步到关联路线和画布边界。
    if (!Number.isFinite(move.point.x) || !Number.isFinite(move.point.y)) {
      continue;
    }
    const feature = document.features.find(
      (candidate) => candidate.id === move.id && candidate.kind === "node",
    );
    if (
      !feature ||
      getTopologyNodeLocked(feature) ||
      !document.layers.some(
        (layer) =>
          layer.id === feature.layerId && layer.visible && !layer.locked,
      )
    ) {
      continue;
    }
    const current = nextPoints.get(move.id);
    if (!current) continue;
    if (current.x !== move.point.x || current.y !== move.point.y)
      changed = true;
    nextPoints.set(move.id, { x: move.point.x, y: move.point.y });
  }
  if (!changed) return document;

  return {
    ...document,
    features: document.features.map((feature) => {
      if (feature.kind === "node") {
        const point = nextPoints.get(feature.id);
        return point ? { ...feature, points: [point] } : feature;
      }
      if (feature.kind !== "route") return feature;
      const sourceId = feature.props[TOPOLOGY_SOURCE_NODE_PROP];
      const targetId = feature.props[TOPOLOGY_TARGET_NODE_PROP];
      const source = sourceId ? nextPoints.get(sourceId) : undefined;
      const target = targetId ? nextPoints.get(targetId) : undefined;
      return source && target
        ? { ...feature, points: [source, target] }
        : feature;
    }),
  };
}

export function moveTopologyNode(
  document: MapDocument,
  nodeId: string,
  point: { readonly x: number; readonly y: number },
): MapDocument {
  return moveTopologyNodes(document, [{ id: nodeId, point }]);
}

/**
 * 重连拓扑路线时，端点引用与用于渲染的两个控制点必须原子更新，防止出现
 * 视觉线路仍指向旧世界但 props 已经改变的半更新状态。
 */
export function reconnectTopologyEdge(
  document: MapDocument,
  edgeId: string,
  endpoints: {
    readonly sourceNodeId: string;
    readonly targetNodeId: string;
  },
): MapDocument | null {
  const edge = document.features.find(
    (feature) => feature.id === edgeId && feature.kind === "route",
  );
  if (
    !edge ||
    topologyRouteHasLockedEndpoint(document, edge) ||
    !canConnectTopologyNodes(
      document,
      endpoints.sourceNodeId,
      endpoints.targetNodeId,
    )
  ) {
    return null;
  }
  const edgeLayer = document.layers.find((layer) => layer.id === edge.layerId);
  if (!edgeLayer?.visible || edgeLayer.locked) return null;
  const source = document.features.find(
    (feature) =>
      feature.id === endpoints.sourceNodeId && feature.kind === "node",
  );
  const target = document.features.find(
    (feature) =>
      feature.id === endpoints.targetNodeId && feature.kind === "node",
  );
  if (!source?.points[0] || !target?.points[0]) return null;
  const relation = getTopologyRouteRelation(edge);
  const direction = getTopologyRouteDirection(edge);
  if (
    relation === "branch" &&
    direction === "one-way" &&
    topologyBranchRouteWouldCycle(document, source.id, target.id, edge.id)
  ) {
    return null;
  }
  if (
    hasDuplicateTopologyRoute(document, {
      sourceNodeId: source.id,
      targetNodeId: target.id,
      relation,
      direction,
      ignoreRouteId: edge.id,
    })
  ) {
    return null;
  }
  return {
    ...document,
    features: document.features.map((feature) =>
      feature.id === edge.id
        ? {
            ...feature,
            points: [source.points[0]!, target.points[0]!],
            props: {
              ...feature.props,
              [TOPOLOGY_SOURCE_NODE_PROP]: source.id,
              [TOPOLOGY_TARGET_NODE_PROP]: target.id,
            },
          }
        : feature,
    ),
  };
}

/** 原子反转通道的来源 / 目标；双向通道也保留反转结果，便于布局和统计稳定。 */
export function reverseTopologyEdge(
  document: MapDocument,
  edgeId: string,
): MapDocument | null {
  const edge = topologyFeatureById(document, edgeId, "route");
  if (!edge) return null;
  const sourceId = edge.props[TOPOLOGY_SOURCE_NODE_PROP];
  const targetId = edge.props[TOPOLOGY_TARGET_NODE_PROP];
  if (!sourceId || !targetId || sourceId === targetId) return null;
  const source = topologyFeatureById(document, sourceId, "node");
  const target = topologyFeatureById(document, targetId, "node");
  if (!source?.points[0] || !target?.points[0]) return null;
  const edgeLayer = document.layers.find((layer) => layer.id === edge.layerId);
  if (
    !edgeLayer?.visible ||
    edgeLayer.locked ||
    !canConnectTopologyNodes(document, target.id, source.id)
  ) {
    return null;
  }
  const relation = getTopologyRouteRelation(edge);
  const direction = getTopologyRouteDirection(edge);
  if (
    relation === "branch" &&
    direction === "one-way" &&
    topologyBranchRouteWouldCycle(document, target.id, source.id, edge.id)
  ) {
    return null;
  }
  if (
    hasDuplicateTopologyRoute(document, {
      sourceNodeId: target.id,
      targetNodeId: source.id,
      relation,
      direction,
      ignoreRouteId: edge.id,
    })
  ) {
    return null;
  }
  return {
    ...document,
    features: document.features.map((feature) =>
      feature.id === edge.id
        ? {
            ...feature,
            points: [target.points[0]!, source.points[0]!],
            props: {
              ...feature.props,
              [TOPOLOGY_SOURCE_NODE_PROP]: target.id,
              [TOPOLOGY_TARGET_NODE_PROP]: source.id,
            },
          }
        : feature,
    ),
  };
}

export function removeTopologyFeature(
  document: MapDocument,
  featureId: string,
): MapDocument {
  return removeTopologyFeatures(document, [featureId]);
}

export function removeTopologyFeatures(
  document: MapDocument,
  featureIds: readonly string[],
): MapDocument {
  const removedIds = new Set(featureIds);
  if (removedIds.size === 0) return document;
  const removedNodeIds = new Set(
    document.features
      .filter(
        (feature) => removedIds.has(feature.id) && feature.kind === "node",
      )
      .map((feature) => feature.id),
  );
  if (
    [...removedNodeIds].some((nodeId) => {
      const node = topologyFeatureById(document, nodeId, "node");
      return Boolean(node && getTopologyNodeLocked(node));
    })
  ) {
    return document;
  }
  // 直接删除路线也必须遵守端点锁定；否则作者可以绕过“锁定节点不可
  // 改变连接”的约束，单独删掉它的通道。
  if (
    document.features.some(
      (feature) =>
        feature.kind === "route" &&
        removedIds.has(feature.id) &&
        topologyRouteHasLockedEndpoint(document, feature),
    )
  ) {
    return document;
  }
  // 删除节点必须与级联路线保持原子性。若关联路线触及另一个锁定节点，
  // 不能只保留路线而删除端点，否则会产生无法通过 schema 校验的悬空事实。
  // 这种情况下整体拒绝删除，作者解锁关联节点或路线后再操作。
  for (const feature of document.features) {
    if (feature.kind !== "route") continue;
    const sourceId = feature.props[TOPOLOGY_SOURCE_NODE_PROP];
    const targetId = feature.props[TOPOLOGY_TARGET_NODE_PROP];
    const touchesRemovedNode =
      (sourceId && removedNodeIds.has(sourceId)) ||
      (targetId && removedNodeIds.has(targetId));
    if (
      touchesRemovedNode &&
      topologyRouteHasLockedEndpoint(document, feature)
    ) {
      return document;
    }
  }
  for (const feature of document.features) {
    if (
      feature.kind === "route" &&
      (removedNodeIds.has(feature.props[TOPOLOGY_SOURCE_NODE_PROP] ?? "") ||
        removedNodeIds.has(feature.props[TOPOLOGY_TARGET_NODE_PROP] ?? ""))
    ) {
      removedIds.add(feature.id);
    }
  }
  // 到这里所有被级联删除的路线都已确认没有锁定端点；保留路线会造成
  // 端点悬空，因此不再做“部分删除”的降级。
  if (!document.features.some((feature) => removedIds.has(feature.id))) {
    return document;
  }
  return {
    ...document,
    features: document.features.filter(
      (feature) => !removedIds.has(feature.id),
    ),
  };
}

function nextTopologyDuplicateId(
  sourceId: string,
  occupiedIds: Set<string>,
): string {
  const base = `${sourceId}-copy`;
  let candidate = base;
  let suffix = 2;
  while (occupiedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  occupiedIds.add(candidate);
  return candidate;
}

export function duplicateTopologyFeatures(
  document: MapDocument,
  featureIds: readonly string[],
  offset: { readonly x: number; readonly y: number } = { x: 18, y: 18 },
): { readonly map: MapDocument; readonly duplicatedIds: readonly string[] } {
  const selectedIds = new Set(featureIds);
  if (selectedIds.size === 0) return { map: document, duplicatedIds: [] };

  const selectedNodeIds = new Set(
    document.features
      .filter(
        (feature) => selectedIds.has(feature.id) && feature.kind === "node",
      )
      .map((feature) => feature.id),
  );
  if (
    [...selectedNodeIds].some((nodeId) => {
      const node = topologyFeatureById(document, nodeId, "node");
      return Boolean(node && getTopologyNodeLocked(node));
    })
  ) {
    return { map: document, duplicatedIds: [] };
  }
  // 复制一组节点时保留组内连线；锁定图层的路线不被隐式修改。
  for (const feature of document.features) {
    if (feature.kind !== "route") continue;
    const layer = document.layers.find((entry) => entry.id === feature.layerId);
    if (layer?.locked) continue;
    const source = feature.props[TOPOLOGY_SOURCE_NODE_PROP];
    const target = feature.props[TOPOLOGY_TARGET_NODE_PROP];
    if (
      source &&
      target &&
      selectedNodeIds.has(source) &&
      selectedNodeIds.has(target)
    ) {
      selectedIds.add(feature.id);
    }
  }
  for (const feature of document.features) {
    if (
      feature.kind === "route" &&
      selectedIds.has(feature.id) &&
      (topologyRouteHasLockedEndpoint(document, feature) ||
        !document.layers.some(
          (layer) =>
            layer.id === feature.layerId && layer.visible && !layer.locked,
        ))
    ) {
      return { map: document, duplicatedIds: [] };
    }
  }

  const occupiedIds = new Set(document.features.map((feature) => feature.id));
  const duplicateIdsBySource = new Map<string, string>();
  for (const feature of document.features) {
    if (
      selectedIds.has(feature.id) &&
      (feature.kind === "node" || feature.kind === "route")
    ) {
      duplicateIdsBySource.set(
        feature.id,
        nextTopologyDuplicateId(feature.id, occupiedIds),
      );
    }
  }
  if (duplicateIdsBySource.size === 0) {
    return { map: document, duplicatedIds: [] };
  }

  // 通道的事实身份由端点、关系和方向共同决定。单独复制一条通道会
  // 产生与原通道完全相同的拓扑事实，随后只能被诊断为重复路线；只有
  // 当通道两端都在本次复制的节点集合中时，才有明确的副本端点可重映射。
  for (const feature of [...selectedIds]) {
    const source = document.features.find((item) => item.id === feature);
    if (source?.kind !== "route") continue;
    const sourceNodeId = source.props[TOPOLOGY_SOURCE_NODE_PROP];
    const targetNodeId = source.props[TOPOLOGY_TARGET_NODE_PROP];
    if (
      !sourceNodeId ||
      !targetNodeId ||
      !duplicateIdsBySource.has(sourceNodeId) ||
      !duplicateIdsBySource.has(targetNodeId)
    ) {
      selectedIds.delete(feature);
      duplicateIdsBySource.delete(feature);
    }
  }
  if (duplicateIdsBySource.size === 0) {
    return { map: document, duplicatedIds: [] };
  }

  const duplicatedNodePoints = new Map<string, { x: number; y: number }>();
  for (const feature of document.features) {
    if (feature.kind !== "node") continue;
    const duplicateId = duplicateIdsBySource.get(feature.id);
    const point = feature.points[0];
    if (duplicateId && point) {
      duplicatedNodePoints.set(duplicateId, {
        x: point.x + offset.x,
        y: point.y + offset.y,
      });
    }
  }
  const originalNodePoints = new Map(
    document.features
      .filter((feature) => feature.kind === "node" && feature.points[0])
      .map((feature) => [feature.id, feature.points[0]!] as const),
  );

  const duplicateFeature = (feature: MapFeature): MapFeature | null => {
    const duplicateId = duplicateIdsBySource.get(feature.id);
    if (!duplicateId) return null;
    if (feature.kind === "node") {
      return {
        ...feature,
        id: duplicateId,
        name: `${feature.name} 副本`,
        entityRef: feature.entityRef ? { ...feature.entityRef } : null,
        points: [duplicatedNodePoints.get(duplicateId) ?? feature.points[0]!],
        props: { ...feature.props },
      };
    }

    const sourceId = feature.props[TOPOLOGY_SOURCE_NODE_PROP]!;
    const targetId = feature.props[TOPOLOGY_TARGET_NODE_PROP]!;
    const duplicatedSourceId = duplicateIdsBySource.get(sourceId) ?? sourceId;
    const duplicatedTargetId = duplicateIdsBySource.get(targetId) ?? targetId;
    const sourcePoint =
      duplicatedNodePoints.get(duplicatedSourceId) ??
      originalNodePoints.get(duplicatedSourceId);
    const targetPoint =
      duplicatedNodePoints.get(duplicatedTargetId) ??
      originalNodePoints.get(duplicatedTargetId);
    if (!sourcePoint || !targetPoint) return null;
    return {
      ...feature,
      id: duplicateId,
      name: `${feature.name} 副本`,
      entityRef: feature.entityRef ? { ...feature.entityRef } : null,
      points: [sourcePoint, targetPoint],
      props: {
        ...feature.props,
        [TOPOLOGY_SOURCE_NODE_PROP]: duplicatedSourceId,
        [TOPOLOGY_TARGET_NODE_PROP]: duplicatedTargetId,
      },
    };
  };

  const duplicatedFeatures: MapFeature[] = [];
  const features = document.features.flatMap((feature) => {
    const duplicate = duplicateFeature(feature);
    if (duplicate) duplicatedFeatures.push(duplicate);
    return duplicate ? [feature, duplicate] : [feature];
  });
  return {
    map: { ...document, features },
    duplicatedIds: duplicatedFeatures.map((feature) => feature.id),
  };
}
