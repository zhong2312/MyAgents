import {
  Check,
  Clock3,
  CircleDashed,
  Columns2,
  Copy,
  Eye,
  EyeOff,
  Eraser,
  Globe2,
  GitBranch,
  Hand,
  LassoSelect,
  Layers3,
  Lock,
  Loader2,
  LocateFixed,
  GitCompareArrows,
  Maximize2,
  Map as MapIcon,
  MapPin,
  MousePointer2,
  Move,
  Network,
  Paintbrush,
  Plus,
  Route,
  Save,
  Search,
  Type,
  Trash2,
  Unlock,
  X,
  Undo2,
  Redo2,
  Rows2,
  Sparkles,
  ArrowUp,
  ArrowDown,
  Crosshair,
  LandPlot,
  Waves,
} from "lucide-react";
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  ConfirmDialog,
  CustomSelect,
  type WorkbenchProjection,
  type WorkbenchStorage,
} from "@/workbench-sdk";
import MapProposalReview from "./MapProposalReview";
import MapRendererCanvas from "./MapRendererCanvas";
import MapGeneratorDialog, {
  type MapAgentGenerationRequest,
} from "./MapGeneratorDialog";
import MapComponentPalette from "./MapComponentPalette";
import TopologyComponentPalette from "./TopologyComponentPalette";
import {
  DEFAULT_MAP_CANVAS_SETTINGS,
  type MapCanvasSettings,
  type MapCanvasTool,
  type MapAreaShape,
  type MapBrushPointCurve,
} from "../business/mapCanvasSession";
import NarrativeUnsavedChangesGuard from "../../../NarrativeUnsavedChangesGuard";

import WorldMapPrototype from "./WorldMapPrototype";
import {
  createNovelMapRepository,
  validateMapEntityReferences,
  type LoadedMapDocument,
} from "../data-access/mapRepository";
import {
  MAP_PROJECTION_LABELS,
  mapEntityKindSchema,
  type MapDocument,
  type MapIndexEntry,
  type MapEntityKind,
  type MapFeature,
  type MapFeatureKind,
  type MapArtworkLayer,
  type MapArtworkLayerKind,
  type MapArtworkStamp,
  type MapSceneLayer,
  type MapScenePoint,
  type MapSceneRegion,
  type MapSceneStroke,
  type MapTerrainMaterial,
  type MapTerrainStyle,
  type MapBackgroundPreset,
  type MapProjectionType,
  createEmptyMapScene,
  isMapFeatureFreeformArea,
  type MapArtworkProjectAsset,
  type MapSceneLayerKind,
} from "../entities/mapSchema";
import {
  DOMAIN_ENTITY_KIND_LABELS,
  buildDomainIndex,
  type DomainEntityRef,
} from "../../../shared/business/domainIndex";
import { SETTING_LIBRARY_PATHS } from "../../../settingLibraryRepository";
import {
  parseSettingLibraryMeta,
  parseSettingLibrarySpatialTree,
} from "../../../settingLibrarySchema";
import { type TimelineEvent } from "../../../timelineLibrarySchema";
import { createNovelTimelineLibraryRepository } from "../../../timelineLibraryRepository";
import { TIMELINE_INDEX_PATH } from "../../../../../../shared/workbenches/novel/timelineStorage";
import {
  applyGeneratorCandidate,
  type MapGeneratorCandidate,
} from "../business/mapGenerators";
import { mapRendererForProjection } from "../business/mapRenderer";
import {
  arrangeTopologyNodes,
  createTopologyEdgeFeature,
  canEditTopologyNodes,
  createConnectedTopologyNode,
  duplicateTopologyFeatures,
  getTopologyNodeKindOption,
  getTopologyNodeKind,
  getTopologyNodeLocked,
  getTopologyNodeLinkedMapId,
  getTopologyNodeConnections,
  getTopologyNodeAncestors,
  getTopologyNodeStatus,
  getTopologyInvalidRouteDiagnostics,
  getTopologySummary,
  getTopologyRouteDirection,
  getTopologyRouteRelation,
  getTopologyRouteRelationLabel,
  importTopologySettingSubtree,
  moveTopologyNodes,
  reconnectTopologyEdge,
  removeTopologyFeature,
  removeTopologyFeatures,
  insertTopologyNodeOnEdge,
  reverseTopologyEdge,
  TOPOLOGY_NODE_KIND_OPTIONS,
  TOPOLOGY_NODE_DRAG_MIME,
  TOPOLOGY_NODE_STATUS_OPTIONS,
  TOPOLOGY_ROUTE_RELATION_OPTIONS,
  type TopologyNodeKind,
  type TopologyNodeStatus,
  type TopologyRouteDirection,
  type TopologyRouteRelation,
  type TopologySettingLevelSource,
  type TopologySettingNodeSource,
  topologyNodeKindForProjection,
  topologyNodeKindForSettingMapKind,
  topologyAdjacentNodePoint,
  topologyHierarchyAdjacentNodePoint,
  topologyProjectionForNodeKind,
  updateTopologyRoute,
  updateTopologyNodeProps,
} from "../business/topologyMap";
import {
  getMapBackgroundImagePlacement,
  getMapBackgroundPreset,
  MAP_BACKGROUND_PRESETS,
} from "../business/mapBackgrounds";
import {
  MAP_COMPONENT_PRESETS,
  createMapComponentPrefabRegions,
  createMapComponentPrefabFeature,
  createMapComponentSurfaceBrushPoints,
  mapComponentPlacement,
  type MapComponentPlacementGesture,
} from "../business/mapComponents";
import { getMapFeatureAreaStyle } from "../business/mapFeatureAreaStyle";
import {
  addMapArtworkLayer,
  addMapArtworkStamp,
  createMapArtworkLayer,
  createMapArtworkAssetCatalog,
  createMapArtworkStamp,
  findMapArtworkLayer,
  findMapArtworkStamp,
  getMapArtworkAssetVariant,
  mapArtworkVariantIndex,
  moveMapArtworkLayer,
  moveMapArtworkStampToLayer,
  removeMapArtworkLayer,
  removeMapArtworkStamp,
  updateMapArtworkLayer,
  updateMapArtworkStamp,
  type MapArtworkStampAsset,
} from "../business/mapArtwork";
import {
  mapArtworkLayerRenderPhase,
  mapArtworkLayersInPanelOrder,
} from "../business/mapArtworkLayerOrder";
import {
  mapArtworkStampPlacementTransform,
  type MapArtworkStampPlacementGesture,
} from "../business/mapArtworkTransform";
import {
  createMapProjectArtworkAsset,
  loadMapProjectArtworkSources,
  MAP_PROJECT_ARTWORK_MAX_BYTES,
  mapProjectArtworkDataUrl,
  mapProjectArtworkFileName,
  mapProjectArtworkMimeType,
  mapProjectArtworkUsage,
} from "../business/mapProjectArtwork";
import {
  addMapSceneStroke,
  addMapSceneRegion,
  createMapSceneRegion,
  createMapSceneStroke,
  mapSceneHasLandSurface,
  mapSceneHasWaterSurface,
  moveMapSceneLayer,
  removeMapSceneLayer,
  removeMapSceneRegion,
  removeMapSceneStroke,
  sceneLayerIdForKind,
  sceneLayerKindForComponentCategory,
  updateMapSceneRegion,
  updateMapSceneStroke,
  updateMapTerrainStyle,
} from "../business/mapScene";
import { eraseMapSceneContent } from "../business/mapSceneEraser";
import {
  getMapTerrainMaterialPreset,
  MAP_TERRAIN_MATERIAL_PRESETS,
  type MapTerrainMaterialPreset,
} from "../business/mapTerrainMaterials";
import {
  getMapRiverStyle,
  isMapRiverFeature,
  reverseMapRiverFeature,
} from "../business/mapHydrography";
import {
  getMapLabelStyle,
  mapFeatureHasLabel,
  MAP_LABEL_FONT_OPTIONS,
  MAP_LABEL_STYLE_PRESETS,
} from "../business/mapLabels";
import {
  getMapRouteStyle,
  MAP_ROUTE_STYLE_OPTIONS,
} from "../business/mapRoutes";
import {
  expandMapCanvasToContentWithTranslation,
  fitMapCanvasToContentWhenEmpty,
  fitMapCanvasToDefaultContent,
  MAP_CANVAS_CONTENT_PADDING,
  mapDocumentGainedContent,
  mapDocumentHasGeneratorOutput,
} from "../business/mapCanvasBounds";
import {
  canEditMapSelectableItems,
  createMapSelectableGroup,
  duplicateMapSelectableItems,
  expandMapSelectableItemIds,
  moveMapSelectableItems,
  removeMapSelectableItems,
  ungroupMapSelectableItems,
} from "../business/mapSelection";

const FEATURE_KIND_LABELS: Readonly<Record<MapFeatureKind, string>> =
  Object.freeze({
    marker: "标记",
    label: "标签",
    area: "画笔",
    // 历史 polygon 与新画笔共用同一语义和编辑体验。
    polygon: "画笔",
    route: "路线",
    node: "拓扑节点",
  });

const FEATURE_KIND_ICONS: Readonly<Record<MapFeatureKind, typeof MapPin>> =
  Object.freeze({
    marker: MapPin,
    label: Type,
    area: Paintbrush,
    polygon: LassoSelect,
    route: Route,
    node: Network,
  });

const TOOL_LABELS: Readonly<Partial<Record<MapCanvasTool, string>>> =
  Object.freeze({
    select: "选择对象",
    move: "移动对象",
    pan: "平移画布",
    river: "河流画笔",
    "terrain-land": "增加陆地",
    "terrain-water": "切回水域",
    freehand: "自由画笔",
    "terrain-region-land": "勾画陆地区域",
    "terrain-region-water": "勾画水域区域",
    "terrain-prefab": "放置预设区域",
    "terrain-material": "地貌材质",
    "artwork-brush": "素材笔刷",
    "artwork-stamp": "素材印章",
    "component-surface-brush": "表面构件笔刷",
    "component-path-brush": "路径笔刷",
    "scene-eraser": "图层橡皮",
    marker: "标记",
    label: "标签",
    area: "画笔",
    route: "路线笔",
    node: "拓扑节点",
  });

const MAP_AREA_SHAPE_OPTIONS: {
  readonly value: MapAreaShape;
  readonly label: string;
  readonly icon?: ReactNode;
}[] = [
  // 自由画笔放在首项，避免窄窗口或下拉菜单滚动时被规则形状遮住。
  // 选择它会切换到独立的 `freehand` 工具，而不是把手绘轨迹当成多边形。
  { value: "freehand", label: "自由画笔", icon: <Paintbrush className="h-3.5 w-3.5" /> },
  { value: "polygon", label: "多边形" },
  { value: "circle", label: "圆形" },
  { value: "ellipse", label: "椭圆" },
];

const ARTWORK_LAYER_KIND_LABELS: Readonly<Record<MapArtworkLayerKind, string>> =
  Object.freeze({
    terrain: "地貌底稿",
    water: "水面构件",
    relief: "山体地貌",
    vegetation: "植被构件",
    stamp: "独立构件",
    label: "文字标注",
    effect: "特效前景",
  });

type EditableMapLayer = {
  readonly visible: boolean;
  readonly locked: boolean;
};

function isEditableMapLayer(
  layer: EditableMapLayer | undefined,
): layer is EditableMapLayer {
  return Boolean(layer?.visible && !layer.locked);
}

const ARTWORK_RENDER_PHASE_LABELS: Readonly<
  Record<ReturnType<typeof mapArtworkLayerRenderPhase>, string>
> = Object.freeze({
  base: "底稿",
  scene: "场景",
  feature: "要素",
  overlay: "前景",
});

const EMPTY_PROJECT_ARTWORK_ASSETS: readonly MapArtworkProjectAsset[] = [];

type MapHistoryEntry = LoadedMapDocument & {
  /** 从当前快照进入下一个快照时，MapDocument 坐标发生的整体平移。 */
  readonly forwardRebase: MapScenePoint;
};

const ZERO_MAP_REBASE: MapScenePoint = Object.freeze({ x: 0, y: 0 });

function invertMapRebase(translation: MapScenePoint): MapScenePoint {
  return { x: -translation.x, y: -translation.y };
}

function mapHistoryEntry(
  document: LoadedMapDocument,
  forwardRebase: MapScenePoint = ZERO_MAP_REBASE,
): MapHistoryEntry {
  return { ...document, forwardRebase };
}

function newTopologyItemId(prefix: "node" | "route"): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function newMapObjectGroupId(): string {
  return `group-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

type TopologySettingOption = TopologySettingNodeSource & {
  readonly label: string;
  readonly typeName: string;
  readonly mapKind: string | undefined;
};

type TopologySettingTree = {
  readonly nodes: readonly TopologySettingNodeSource[];
  readonly levelTypes: readonly TopologySettingLevelSource[];
  readonly options: readonly TopologySettingOption[];
};

const EMPTY_TOPOLOGY_SETTING_TREE: TopologySettingTree = Object.freeze({
  nodes: [],
  levelTypes: [],
  options: [],
});

function buildTopologySettingTree(
  nodes: readonly TopologySettingNodeSource[],
  levelTypes: readonly TopologySettingLevelSource[],
): TopologySettingTree {
  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  const levelById = new Map(
    levelTypes.map((level) => [level.id, level] as const),
  );
  const pathById = new Map<string, string>();
  const getPath = (nodeId: string): string => {
    const cached = pathById.get(nodeId);
    if (cached) return cached;
    const path: string[] = [];
    const visited = new Set<string>();
    let current = nodesById.get(nodeId);
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      path.unshift(current.name);
      current = current.parentId ? nodesById.get(current.parentId) : undefined;
    }
    const result = path.join(" / ");
    pathById.set(nodeId, result);
    return result;
  };
  const options = [...nodes]
    .sort(
      (left, right) =>
        (left.order ?? 0) - (right.order ?? 0) ||
        left.name.localeCompare(right.name, "zh-CN") ||
        left.id.localeCompare(right.id),
    )
    .map((node) => {
      const level = levelById.get(node.typeId);
      const path = getPath(node.id);
      return {
        ...node,
        label: level?.name ? `${path} · ${level.name}` : path,
        typeName: level?.name ?? node.typeId,
        mapKind: level?.mapKind,
      };
    });
  return { nodes: [...nodes], levelTypes: [...levelTypes], options };
}

async function imageDimensions(file: File): Promise<{
  readonly width: number;
  readonly height: number;
}> {
  const source = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
          reject(new Error("图片没有可用的像素尺寸"));
          return;
        }
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      };
      image.onerror = () => reject(new Error("图片无法由地图画布读取"));
      image.src = source;
    });
  } finally {
    URL.revokeObjectURL(source);
  }
}

function artworkDisplayName(assetId: string, name?: string): string {
  return name?.trim() || assetId;
}

interface MapEditorProps {
  readonly storage: WorkbenchStorage;
  readonly projection?: WorkbenchProjection;
  readonly projectTitle: string;
  readonly isActive: boolean;
  readonly quickCreateRequest?: {
    readonly kind: "map";
    readonly token: number;
  } | null;
  readonly focus?: DomainEntityRef | null;
  readonly agentAvailable?: boolean;
  readonly agentLaunching?: boolean;
  readonly onLaunchMapAgent?: (
    request: MapAgentGenerationRequest,
  ) => Promise<void>;
  readonly registerNavigationGuard?: Parameters<
    typeof NarrativeUnsavedChangesGuard
  >[0]["registerNavigationGuard"];
}

export default function MapEditor({
  storage,
  projection,
  projectTitle,
  isActive,
  quickCreateRequest,
  focus,
  agentAvailable = false,
  agentLaunching = false,
  onLaunchMapAgent,
  registerNavigationGuard,
}: MapEditorProps) {
  const repository = useMemo(
    () => createNovelMapRepository(storage),
    [storage],
  );
  const [tab, setTab] = useState<"tree" | "maps">("maps");
  const [maps, setMaps] = useState<readonly MapIndexEntry[]>([]);
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
  const [doc, setDoc] = useState<LoadedMapDocument | null>(null);
  const [documentRebase, setDocumentRebase] = useState<{
    readonly revision: number;
    readonly translation: MapScenePoint;
  } | null>(null);
  // Canvas / DnD 回调可能发生在 React 下一次渲染之前；这里始终保存当前草稿，
  // 避免“画布已经出现新大陆，但保存仍拿到上一个文档快照”的竞态。
  const docRef = useRef<LoadedMapDocument | null>(null);
  const documentRebaseRevisionRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(
    null,
  );
  /** 多选是两类画布共享的会话状态，不写入 MapDocument。 */
  const [selectedFeatureIds, setSelectedFeatureIds] = useState<
    readonly string[]
  >([]);
  // 画布连续操作和全局键盘事件都可能发生在 React 下一帧提交之前；保留
  // 选区镜像，保证 Shift 追加后立即按方向键仍作用于完整选区。
  const selectedFeatureIdsRef = useRef<readonly string[]>([]);
  const primarySelectedFeatureIdRef = useRef<string | null>(null);
  const multiSelectionUpdateRef = useRef(false);
  const [deleteMapTarget, setDeleteMapTarget] = useState<string | null>(null);
  const [deleteArtworkLayerTarget, setDeleteArtworkLayerTarget] = useState<{
    readonly layerId: string;
    readonly targetLayerId: string;
  } | null>(null);
  const [entityOptions, setEntityOptions] = useState<DomainEntityRef[]>([]);
  const [topologySettingTree, setTopologySettingTree] =
    useState<TopologySettingTree>(EMPTY_TOPOLOGY_SETTING_TREE);
  const topologySettingTreeRef = useRef<TopologySettingTree>(
    EMPTY_TOPOLOGY_SETTING_TREE,
  );
  const [topologyImportRootId, setTopologyImportRootId] = useState("");
  /** 拓扑画布筛选仅作用于视图，不能改变 MapDocument 的事实集合。 */
  const [topologyQuery, setTopologyQuery] = useState("");
  const [history, setHistory] = useState<MapHistoryEntry[]>([]);
  const [future, setFuture] = useState<MapHistoryEntry[]>([]);
  const [newMapOpen, setNewMapOpen] = useState(false);
  const [newMapName, setNewMapName] = useState("");
  const [newMapProjection, setNewMapProjection] =
    useState<MapProjectionType>("continent");
  /** 新地图由拓扑节点发起时，创建成功后必须回写这个节点的 linkedMapId。 */
  const [newMapLinkNodeId, setNewMapLinkNodeId] = useState<string | null>(null);
  const quickCreateHandledRef = useRef<number | null>(null);
  const [proposalReviewOpen, setProposalReviewOpen] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [tool, setTool] = useState<MapCanvasTool>("select");
  const [canvasSettings, setCanvasSettings] = useState<MapCanvasSettings>(
    DEFAULT_MAP_CANVAS_SETTINGS,
  );
  const [artworkBrushAssetId, setArtworkBrushAssetId] = useState<string | null>(
    null,
  );
  /** 当前笔刷的会话色；真正的地图事实仍写入每条 MapSceneStroke。 */
  const [artworkBrushColor, setArtworkBrushColor] = useState<string | null>(
    null,
  );
  const [artworkBrushLayerKind, setArtworkBrushLayerKind] =
    useState<MapSceneLayerKind>("vegetation");
  const [activeStampAssetId, setActiveStampAssetId] = useState<string | null>(
    null,
  );
  const [activeComponentId, setActiveComponentId] = useState<string | null>(
    null,
  );
  const [activeTerrainMaterial, setActiveTerrainMaterial] =
    useState<MapTerrainMaterial | null>(null);
  const [activeTopologyNodeKind, setActiveTopologyNodeKind] =
    useState<TopologyNodeKind>("world");
  const [activeTopologyNodeName, setActiveTopologyNodeName] = useState("");
  const [activeTopologyNodeStatus, setActiveTopologyNodeStatus] =
    useState<TopologyNodeStatus>("active");
  const [activeTopologyRouteRelation, setActiveTopologyRouteRelation] =
    useState<TopologyRouteRelation>("passage");
  const [activeTopologyRouteDirection, setActiveTopologyRouteDirection] =
    useState<TopologyRouteDirection>("two-way");
  const [activeTopologyLinkedMapId, setActiveTopologyLinkedMapId] = useState<
    string | null
  >(null);
  const [activeTopologyEntityRef, setActiveTopologyEntityRef] =
    useState<MapFeature["entityRef"]>(null);
  const [activeLayerId, setActiveLayerId] = useState("layer-main");
  /** 当前绘图图层只属于编辑会话；笔刷和橡皮的写入目标由此确定。 */
  const [activeSceneLayerId, setActiveSceneLayerId] = useState("scene-terrain");
  const [activeArtworkLayerId, setActiveArtworkLayerId] =
    useState("artwork-stamps");
  const [timelineEvents, setTimelineEvents] = useState<
    readonly TimelineEvent[]
  >([]);
  const [timelineCursor, setTimelineCursor] = useState<number | null>(null);
  const [featureQuery, setFeatureQuery] = useState("");
  const [focusRequest, setFocusRequest] = useState(0);
  const [projectArtworkSources, setProjectArtworkSources] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const projectArtworkInputRef = useRef<HTMLInputElement>(null);
  // 素材文件只在 MapDocument 已成功提交后清理。按地图分桶，避免切换地图时
  // 把另一张尚未保存地图仍在引用的素材误删。
  const pendingProjectArtworkRemovalsRef = useRef(
    new Map<string, Set<string>>(),
  );

  const activeComponent = activeComponentId
    ? (MAP_COMPONENT_PRESETS.find(
        (component) => component.id === activeComponentId,
      ) ?? null)
    : null;
  const topologyLinkedMapNames = useMemo(
    () => new Map(maps.map((map) => [map.id, map.name] as const)),
    [maps],
  );
  const topologySettingOptions = useMemo(() => {
    if (topologySettingTree.options.length > 0) {
      return topologySettingTree.options;
    }
    return entityOptions
      .filter((entity) => entity.kind === "setting")
      .map((entity) => ({
        id: entity.id,
        parentId: null,
        name: entity.name,
        typeId: "setting",
        label: entity.name,
        typeName: "设定",
        mapKind: undefined,
      }));
  }, [entityOptions, topologySettingTree.options]);
  const topologySettingById = useMemo(
    () => new Map(topologySettingOptions.map((option) => [option.id, option])),
    [topologySettingOptions],
  );
  const topologyEntityNames = useMemo(() => {
    const names = new Map(
      entityOptions.map(
        (entity) => [`${entity.kind}:${entity.id}`, entity.name] as const,
      ),
    );
    for (const setting of topologySettingOptions) {
      names.set(`setting:${setting.id}`, setting.label);
    }
    return names;
  }, [entityOptions, topologySettingOptions]);

  const chooseTool = useCallback((nextTool: MapCanvasTool) => {
    setTool(nextTool);
    // 独立的自由画笔入口不再受上一次区域形状选择影响；切入时明确
    // 使用手绘轨迹，圆形和椭圆仍可从“画笔形状”下拉框主动选择。
    if (nextTool === "freehand") {
      setCanvasSettings((current) =>
        current.areaShape === "freehand"
          ? current
          : { ...current, areaShape: "freehand" },
      );
    }
    // 节点工具会在画布空白处直接创建事实；清除筛选可避免新节点
    // 因为名称不匹配而刚创建就从视图中消失。
    if (nextTool === "node") setTopologyQuery("");
    setActiveComponentId(null);
    if (nextTool !== "artwork-brush") setArtworkBrushAssetId(null);
    if (nextTool !== "artwork-stamp") setActiveStampAssetId(null);
    if (nextTool !== "terrain-material") setActiveTerrainMaterial(null);
  }, []);

  /** 形状决定画笔的落图语义，切换时必须同步切换实际绘制工具。 */
  const chooseAreaShape = useCallback(
    (areaShape: MapAreaShape) => {
      setCanvasSettings((current) =>
        current.areaShape === areaShape ? current : { ...current, areaShape },
      );
      chooseTool(areaShape === "freehand" ? "freehand" : "area");
    },
    [chooseTool],
  );

  const chooseBrushCurve = useCallback((curve: MapBrushPointCurve) => {
    setCanvasSettings((current) =>
      current.brushPointCurve === curve
        ? current
        : { ...current, brushPointCurve: curve },
    );
  }, []);

  const replaceDoc = useCallback((next: LoadedMapDocument | null) => {
    docRef.current = next;
    setDocumentRebase(null);
    setDoc(next);
  }, []);

  const applyDocumentRebase = useCallback((translation: MapScenePoint) => {
    if (translation.x === 0 && translation.y === 0) return;
    documentRebaseRevisionRef.current += 1;
    setDocumentRebase({
      revision: documentRebaseRevisionRef.current,
      translation,
    });
  }, []);

  useEffect(() => {
    primarySelectedFeatureIdRef.current = selectedFeatureId;
    if (multiSelectionUpdateRef.current) {
      multiSelectionUpdateRef.current = false;
      return;
    }
    const next = selectedFeatureId ? [selectedFeatureId] : [];
    selectedFeatureIdsRef.current = next;
    setSelectedFeatureIds(next);
  }, [selectedFeatureId]);

  const updateMapSelection = useCallback(
    (ids: readonly string[], primaryId: string | null) => {
      const next = [...new Set(ids)];
      const primary =
        primaryId && next.includes(primaryId)
          ? primaryId
          : (next.at(-1) ?? null);
      const current = selectedFeatureIdsRef.current;
      if (
        primary === primarySelectedFeatureIdRef.current &&
        current.length === next.length &&
        current.every((id, index) => id === next[index])
      ) {
        return;
      }
      // React 对相同 state 值不会触发 effect；只有主选择会变化时才需要
      // 跳过下一次同步，避免 Shift 取消非主对象后遗留过期标记。
      multiSelectionUpdateRef.current =
        primary !== primarySelectedFeatureIdRef.current;
      primarySelectedFeatureIdRef.current = primary;
      selectedFeatureIdsRef.current = next;
      setSelectedFeatureIds(next);
      setSelectedFeatureId(primary);
    },
    [],
  );

  const updateTopologyQuery = useCallback(
    (value: string) => {
      setTopologyQuery(value);
      // 筛选会改变画布上的可见对象；清掉旧选区，避免后续复制、删除
      // 继续作用于已经被筛掉的节点或通道。
      if (value.trim()) updateMapSelection([], null);
    },
    [updateMapSelection],
  );

  useEffect(() => {
    multiSelectionUpdateRef.current = false;
    primarySelectedFeatureIdRef.current = null;
    selectedFeatureIdsRef.current = [];
    setSelectedFeatureIds([]);
  }, [doc?.map.id]);

  const loadMaps = useCallback(async () => {
    try {
      const index = await repository.loadIndex();
      setMaps(index.index.maps);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [repository]);

  useEffect(() => {
    if (!isActive) return;
    void loadMaps();
  }, [isActive, loadMaps]);

  useEffect(() => {
    if (
      !isActive ||
      quickCreateRequest?.kind !== "map" ||
      quickCreateHandledRef.current === quickCreateRequest.token
    ) {
      return;
    }
    quickCreateHandledRef.current = quickCreateRequest.token;
    setNewMapName("");
    setNewMapProjection("continent");
    setNewMapLinkNodeId(null);
    setNewMapOpen(true);
  }, [isActive, quickCreateRequest]);

  // 实体选项（T11 引用校验的数据源）
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    void buildDomainIndex(storage, projection).then((index) => {
      if (!cancelled) {
        setEntityOptions(
          index.entities.filter(
            (entity) => mapEntityKindSchema.safeParse(entity.kind).success,
          ),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isActive, projection, storage]);

  // 拓扑节点只保存 setting id；空间树和层级类型作为可重建的 UI 索引读取，
  // 这样检查器可以显示完整父子路径，并支持按范围导入节点而不复制设定正文。
  useEffect(() => {
    if (!isActive) return;
    // 切换项目或工作台时先清空上一项目的空间树；异步读取期间不能继续
    // 把旧项目的设定显示为当前拓扑节点可选项。
    setTopologySettingTree(EMPTY_TOPOLOGY_SETTING_TREE);
    let cancelled = false;
    void storage
      .stat([SETTING_LIBRARY_PATHS.spatialTree, SETTING_LIBRARY_PATHS.meta])
      .then(async (infos) => {
        if (infos.some((info) => !info?.exists || info.kind !== "file")) {
          return EMPTY_TOPOLOGY_SETTING_TREE;
        }
        const [treeFile, metaFile] = await Promise.all([
          storage.readText(SETTING_LIBRARY_PATHS.spatialTree),
          storage.readText(SETTING_LIBRARY_PATHS.meta),
        ]);
        const tree = parseSettingLibrarySpatialTree(treeFile.content);
        const meta = parseSettingLibraryMeta(metaFile.content);
        return buildTopologySettingTree(tree.nodes, meta.levelTypes);
      })
      .then((tree) => {
        if (!cancelled) setTopologySettingTree(tree);
      })
      .catch(() => {
        if (!cancelled) setTopologySettingTree(EMPTY_TOPOLOGY_SETTING_TREE);
      });
    return () => {
      cancelled = true;
    };
  }, [isActive, storage]);

  useEffect(() => {
    topologySettingTreeRef.current = topologySettingTree;
  }, [topologySettingTree]);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    void storage
      .stat([TIMELINE_INDEX_PATH])
      .then(async ([info]) => {
        if (!info?.exists || info.kind !== "file")
          return { events: [] as readonly TimelineEvent[] };
        const timeline =
          await createNovelTimelineLibraryRepository(storage).load();
        return { events: timeline.library.events };
      })
      .then((result) => {
        if (!cancelled) setTimelineEvents(result.events);
      })
      .catch(() => {
        if (!cancelled) setTimelineEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isActive, storage]);

  const openMap = useCallback(
    async (mapId: string) => {
      setError(null);
      try {
        const loaded = await repository.loadMap(mapId);
        // 历史地图、Agent 提案和外部导入都可能携带超出旧尺寸的坐标。
        // 打开时重新计算一次边界，保证画布尺寸仍然覆盖全部事实；若尺寸
        // 发生变化，把原记录放入撤销栈，作者可以直接保存或撤销这次修复。
        const expansion = expandMapCanvasToContentWithTranslation(
          fitMapCanvasToDefaultContent(loaded.map),
        );
        const normalizedMap = expansion.map;
        const normalized =
          normalizedMap === loaded.map
            ? loaded
            : { ...loaded, map: normalizedMap };
        replaceDoc(normalized);
        applyDocumentRebase(expansion.translation);
        setSelectedMapId(mapId);
        if (
          mapRendererForProjection(normalizedMap.projectionType) === "topology"
        ) {
          // 拓扑节点模板属于当前地图投影的编辑上下文。切换多元宇宙和
          // 平行世界时重置为对应语义，避免沿用上一张地图的“世界”默认值。
          setActiveTopologyNodeKind(
            topologyNodeKindForProjection(normalizedMap.projectionType),
          );
        }
        if (mapDocumentHasGeneratorOutput(normalized.map)) {
          // Agent / Azgaar 提案可能保留完整底图矩形，不能按 SVG 内部像素
          // 裁切；首次打开仍按可编辑生成要素构图，避免默认视角只显示空海域。
          setFocusRequest((request) => request + 1);
        }
        setSelectedFeatureId(null);
        setActiveTopologyLinkedMapId(null);
        setActiveTopologyEntityRef(null);
        setTopologyImportRootId("");
        setTopologyQuery("");
        chooseTool("select");
        setArtworkBrushLayerKind("vegetation");
        setActiveSceneLayerId("scene-terrain");
        setActiveLayerId(normalized.map.layers[0]?.id ?? "layer-main");
        setActiveArtworkLayerId(
          findMapArtworkLayer(normalized.map.artwork)?.id ?? "artwork-stamps",
        );
        setFeatureQuery("");
        setHistory(
          normalizedMap === loaded.map
            ? []
            : [mapHistoryEntry(loaded, expansion.translation)],
        );
        setFuture([]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [applyDocumentRebase, chooseTool, replaceDoc, repository],
  );

  useEffect(() => {
    if (!isActive || focus?.kind !== "map" || focus.id === selectedMapId) {
      return;
    }
    void openMap(focus.id);
  }, [focus, isActive, openMap, selectedMapId]);

  const createMap = useCallback(async () => {
    const id = `map-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const sourceDocument = newMapLinkNodeId ? docRef.current : null;
    const linkedNode = sourceDocument?.map.features.find(
      (feature) => feature.id === newMapLinkNodeId && feature.kind === "node",
    );
    if (newMapLinkNodeId && (!sourceDocument || !linkedNode)) {
      setError("关联的拓扑节点已不存在，无法创建关联地图。");
      setNewMapLinkNodeId(null);
      return;
    }
    try {
      const created = await repository.createMap({
        id,
        name: newMapName.trim() || "未命名地图",
        projectionType: newMapProjection,
      });
      if (sourceDocument && linkedNode) {
        const linkedSourceMap: MapDocument = {
          ...sourceDocument.map,
          features: sourceDocument.map.features.map((feature) =>
            feature.id === linkedNode.id
              ? {
                  ...feature,
                  props: updateTopologyNodeProps(feature.props, {
                    linkedMapId: created.map.id,
                  }),
                }
              : feature,
          ),
        };
        try {
          await repository.saveMap(sourceDocument, linkedSourceMap);
        } catch (linkCause) {
          const cleaned = await repository.deleteMap(created.map.id).then(
            () => true,
            () => false,
          );
          if (!cleaned) {
            throw new Error(
              `关联拓扑节点失败；已创建“${created.map.name}”，请在节点属性中手动关联。`,
              { cause: linkCause },
            );
          }
          throw linkCause;
        }
      }
      setNewMapOpen(false);
      setNewMapName("");
      setNewMapLinkNodeId(null);
      await loadMaps();
      await openMap(created.map.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [
    loadMaps,
    newMapLinkNodeId,
    newMapName,
    newMapProjection,
    openMap,
    repository,
  ]);

  const beginMapCreation = useCallback(() => {
    setNewMapName("");
    setNewMapProjection("continent");
    setNewMapLinkNodeId(null);
    setNewMapOpen(true);
  }, []);

  const currentMapId = doc?.map.id ?? null;
  const backgroundPlacement = useMemo(() => {
    const canvas = doc?.map.canvas;
    if (!canvas?.backgroundImage) return null;
    if (canvas.backgroundImagePlacement) return canvas.backgroundImagePlacement;
    if (
      typeof canvas.backgroundImageWidth !== "number" ||
      typeof canvas.backgroundImageHeight !== "number"
    ) {
      return null;
    }
    return getMapBackgroundImagePlacement(
      canvas,
      canvas.backgroundImageWidth,
      canvas.backgroundImageHeight,
    );
  }, [doc]);
  const currentProjectArtwork = useMemo(
    () => doc?.map.artwork.assets ?? EMPTY_PROJECT_ARTWORK_ASSETS,
    [doc?.map.artwork.assets],
  );

  useEffect(() => {
    if (!doc) return;
    setActiveArtworkLayerId(
      (currentLayerId) =>
        findMapArtworkLayer(doc.map.artwork, currentLayerId)?.id ??
        findMapArtworkLayer(doc.map.artwork)?.id ??
        "artwork-stamps",
    );
  }, [doc]);

  useEffect(() => {
    if (!doc) return;
    const scene = doc.map.scene ?? createEmptyMapScene();
    setActiveSceneLayerId((currentLayerId) =>
      scene.layers.some((layer) => layer.id === currentLayerId)
        ? currentLayerId
        : (scene.layers.find((layer) => layer.id === "scene-terrain")?.id ??
          scene.layers[0]?.id ??
          "scene-terrain"),
    );
  }, [doc]);

  useEffect(() => {
    if (!currentMapId) {
      setProjectArtworkSources(new Map());
      return undefined;
    }
    let cancelled = false;
    setProjectArtworkSources(new Map());
    void loadMapProjectArtworkSources(storage, currentProjectArtwork).then(
      (sources) => {
        if (!cancelled) setProjectArtworkSources(sources);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [currentMapId, currentProjectArtwork, storage]);

  const artworkCatalog = useMemo(
    () =>
      doc
        ? createMapArtworkAssetCatalog(doc.map.artwork, projectArtworkSources)
        : null,
    [doc, projectArtworkSources],
  );
  const projectArtworkAssets = useMemo(
    () =>
      doc
        ? doc.map.artwork.assets.flatMap((asset) => {
            const resolved = artworkCatalog?.get(asset.id);
            return resolved ? [resolved] : [];
          })
        : [],
    [artworkCatalog, doc],
  );
  const projectArtworkUsage = useMemo(
    () =>
      doc ? mapProjectArtworkUsage(doc.map.artwork, doc.map.scene) : new Map(),
    [doc],
  );

  const mutateDoc = useCallback(
    (mutator: (map: MapDocument) => MapDocument) => {
      const current = docRef.current;
      if (!current) return;
      const expansion = expandMapCanvasToContentWithTranslation(
        fitMapCanvasToContentWhenEmpty(current.map, mutator(current.map)),
      );
      const nextMap = expansion.map;
      if (nextMap === current.map) return;
      const shouldFocusNewContent = mapDocumentGainedContent(
        current.map,
        nextMap,
      );
      const next: LoadedMapDocument = {
        map: nextMap,
        content: current.content,
      };
      docRef.current = next;
      setHistory((previous) => [
        ...previous.slice(-49),
        mapHistoryEntry(current, expansion.translation),
      ]);
      setFuture([]);
      applyDocumentRebase(expansion.translation);
      setDoc(next);
      // 仅在空地图首次获得真实内容时构图。之后放置、移动或绘制时不改变
      // 作者已经调好的相机，避免连续创作过程中出现突然跳镜。
      if (shouldFocusNewContent) {
        setFocusRequest((request) => request + 1);
      }
    },
    [applyDocumentRebase],
  );

  const undo = useCallback(() => {
    const current = docRef.current;
    const previous = history.at(-1);
    if (!current || !previous) return;
    replaceDoc(previous);
    setHistory((entries) => entries.slice(0, -1));
    setFuture((entries) => [
      ...entries,
      mapHistoryEntry(current, previous.forwardRebase),
    ]);
    applyDocumentRebase(invertMapRebase(previous.forwardRebase));
    setSelectedFeatureId(null);
  }, [applyDocumentRebase, history, replaceDoc]);

  const redo = useCallback(() => {
    const current = docRef.current;
    const next = future.at(-1);
    if (!current || !next) return;
    replaceDoc(next);
    setFuture((entries) => entries.slice(0, -1));
    setHistory((entries) => [
      ...entries,
      mapHistoryEntry(current, next.forwardRebase),
    ]);
    applyDocumentRebase(next.forwardRebase);
    setSelectedFeatureId(null);
  }, [applyDocumentRebase, future, replaceDoc]);

  const nudgeSelection = useCallback(
    (deltaX: number, deltaY: number) => {
      const selectionIds = [
        ...new Set(
          selectedFeatureIdsRef.current.length > 0
            ? selectedFeatureIdsRef.current
            : [selectedFeatureId].filter((id): id is string => Boolean(id)),
        ),
      ];
      const currentMap = docRef.current?.map;
      if (
        currentMap &&
        mapRendererForProjection(currentMap.projectionType) === "topology"
      ) {
        const topologyNodeIds = selectionIds.filter((id) =>
          currentMap.features.some(
            (feature) => feature.id === id && feature.kind === "node",
          ),
        );
        if (topologyNodeIds.length === 0) {
          setError("拓扑连线由两端世界节点决定，请移动或重连节点。");
          return;
        }
        if (!canEditTopologyNodes(currentMap, topologyNodeIds)) {
          setError("选区包含锁定、隐藏或不存在的拓扑节点，无法移动。");
          return;
        }
        mutateDoc((map) =>
          moveTopologyNodes(
            map,
            topologyNodeIds.flatMap((nodeId) => {
              const point = map.features.find(
                (feature) => feature.id === nodeId && feature.kind === "node",
              )?.points[0];
              return point
                ? [
                    {
                      id: nodeId,
                      point: {
                        x: point.x + deltaX,
                        y: point.y + deltaY,
                      },
                    },
                  ]
                : [];
            }),
          ),
        );
        return;
      }
      if (selectionIds.length > 1) {
        if (
          !currentMap ||
          !canEditMapSelectableItems(currentMap, selectionIds)
        ) {
          setError("选区包含隐藏、锁定或不存在的对象，无法批量移动。");
          return;
        }
        mutateDoc((map) =>
          moveMapSelectableItems(map, selectionIds, {
            x: deltaX,
            y: deltaY,
          }),
        );
        return;
      }
      if (!selectedFeatureId) return;
      mutateDoc((map) => {
        let changed = false;
        const features = map.features.map((feature) => {
          if (feature.id !== selectedFeatureId) return feature;
          const layer = map.layers.find((item) => item.id === feature.layerId);
          if (!layer?.visible || layer.locked) return feature;
          changed = true;
          return {
            ...feature,
            points: feature.points.map((point) => ({
              x: point.x + deltaX,
              y: point.y + deltaY,
            })),
          };
        });
        const artwork = {
          ...map.artwork,
          layers: map.artwork.layers.map((layer) => ({
            ...layer,
            stamps: layer.stamps.map((stamp) => {
              if (stamp.id !== selectedFeatureId) return stamp;
              if (!layer.visible || layer.locked) return stamp;
              changed = true;
              return {
                ...stamp,
                x: stamp.x + deltaX,
                y: stamp.y + deltaY,
              };
            }),
          })),
        };
        const scene = map.scene
          ? {
              ...map.scene,
              layers: map.scene.layers.map((layer) => ({
                ...layer,
                strokes: layer.strokes.map((stroke) => {
                  if (stroke.id !== selectedFeatureId) return stroke;
                  if (!layer.visible || layer.locked) return stroke;
                  changed = true;
                  return {
                    ...stroke,
                    points: stroke.points.map((point) => ({
                      x: point.x + deltaX,
                      y: point.y + deltaY,
                    })),
                  };
                }),
                regions: layer.regions.map((region) => {
                  if (region.id !== selectedFeatureId) return region;
                  if (!layer.visible || layer.locked) return region;
                  changed = true;
                  return {
                    ...region,
                    points: region.points.map((point) => ({
                      x: point.x + deltaX,
                      y: point.y + deltaY,
                    })),
                  };
                }),
              })),
            }
          : map.scene;
        return changed ? { ...map, features, artwork, scene } : map;
      });
    },
    [mutateDoc, selectedFeatureId],
  );

  const duplicateSelectedMapItems = useCallback(
    (itemIds?: readonly string[]) => {
      const ids = [
        ...new Set(
          itemIds && itemIds.length > 0
            ? itemIds
            : selectedFeatureIds.length > 0
              ? selectedFeatureIds
              : [selectedFeatureId].filter((id): id is string => Boolean(id)),
        ),
      ];
      if (ids.length === 0) return false;

      const currentMap = docRef.current?.map;
      if (!currentMap || !canEditMapSelectableItems(currentMap, ids)) {
        setError("选区包含隐藏、锁定或不支持复制的对象。");
        return false;
      }
      const topologyNodeIds = ids.filter((id) =>
        currentMap.features.some(
          (feature) => feature.id === id && feature.kind === "node",
        ),
      );
      if (
        mapRendererForProjection(currentMap.projectionType) === "topology" &&
        topologyNodeIds.length > 0 &&
        !canEditTopologyNodes(currentMap, topologyNodeIds)
      ) {
        setError("选区包含锁定、隐藏或不存在的拓扑节点，无法复制。");
        return false;
      }

      let duplicatedIds: readonly string[] = [];
      mutateDoc((map) => {
        const duplication =
          mapRendererForProjection(map.projectionType) === "topology"
            ? duplicateTopologyFeatures(map, ids)
            : duplicateMapSelectableItems(map, ids);
        duplicatedIds = duplication.duplicatedIds;
        return duplication.map;
      });
      if (duplicatedIds.length === 0) return false;

      updateMapSelection(duplicatedIds, duplicatedIds.at(-1) ?? null);
      chooseTool("select");
      setError(null);
      return true;
    },
    [
      chooseTool,
      mutateDoc,
      selectedFeatureId,
      selectedFeatureIds,
      updateMapSelection,
    ],
  );

  const finalizeProjectArtworkRemovals = useCallback(
    async (map: MapDocument): Promise<readonly string[]> => {
      const pending = pendingProjectArtworkRemovalsRef.current.get(map.id);
      if (!pending?.size) return [];

      const retainedPaths = new Set(
        map.artwork.assets.map((asset) => asset.path),
      );
      const failures: string[] = [];
      for (const path of [...pending]) {
        // 用户可能已经撤销删除；重新出现在刚保存文档中的素材不得清理。
        if (retainedPaths.has(path)) {
          pending.delete(path);
          continue;
        }
        try {
          await storage.remove(path, { permanent: true });
          pending.delete(path);
        } catch {
          failures.push(path);
        }
      }
      if (pending.size === 0) {
        pendingProjectArtworkRemovalsRef.current.delete(map.id);
      }
      return failures;
    },
    [storage],
  );

  const save = useCallback(async (): Promise<boolean> => {
    const current = docRef.current;
    if (!current) return false;
    setSaving(true);
    setError(null);
    try {
      // T11：保存前校验实体引用存在性
      const idsByKind: Record<MapEntityKind, Set<string>> = {
        character: new Set(),
        event: new Set(),
        location: new Set(),
        faction: new Set(),
        item: new Set(),
        setting: new Set(),
      };
      for (const ref of entityOptions) {
        if (ref.kind in idsByKind)
          idsByKind[ref.kind as MapEntityKind].add(ref.id);
      }
      const errors = await validateMapEntityReferences(
        storage,
        current.map,
        idsByKind,
      );
      if (errors.length > 0) {
        setError(errors.join("；"));
        return false;
      }
      const saved = await repository.saveMap(current, current.map);
      const cleanupFailures = await finalizeProjectArtworkRemovals(saved.map);
      replaceDoc(saved);
      setHistory([]);
      setFuture([]);
      await loadMaps();
      if (cleanupFailures.length > 0) {
        setError(
          `地图已保存，但 ${cleanupFailures.length} 个已移除素材文件未能清理；它们不会再出现在素材库中。`,
        );
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  }, [
    entityOptions,
    finalizeProjectArtworkRemovals,
    loadMaps,
    replaceDoc,
    repository,
    storage,
  ]);

  useEffect(() => {
    if (!isActive || tab !== "maps") return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      if (!event.ctrlKey && !event.metaKey) {
        const key = event.key.toLocaleLowerCase("en-US");
        if (
          selectedFeatureId &&
          ["arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)
        ) {
          event.preventDefault();
          const distance = event.shiftKey ? 10 : 1;
          nudgeSelection(
            key === "arrowleft"
              ? -distance
              : key === "arrowright"
                ? distance
                : 0,
            key === "arrowup" ? -distance : key === "arrowdown" ? distance : 0,
          );
          return;
        }
        const shortcuts: Readonly<Partial<Record<string, MapCanvasTool>>> = {
          v: "select",
          m: "move",
          h: "pan",
          f: "freehand",
          l: "terrain-land",
          w: "terrain-water",
          e: "scene-eraser",
          r: "route",
        };
        const nextTool =
          key === "b" && artworkBrushAssetId
            ? ("artwork-brush" as const)
            : key === "m" && activeTerrainMaterial
              ? ("terrain-material" as const)
              : shortcuts[key];
        const sceneLayers = doc?.map.scene?.layers ?? [];
        const canLand = Boolean(
          sceneLayers.find((layer) => layer.id === "scene-terrain")?.visible &&
            !sceneLayers.find((layer) => layer.id === "scene-terrain")?.locked,
        );
        const canWater = Boolean(
          sceneLayers.find((layer) => layer.id === "scene-terrain")?.visible &&
            !sceneLayers.find((layer) => layer.id === "scene-terrain")?.locked,
        );
        const activeMaterialSurface = activeTerrainMaterial
          ? getMapTerrainMaterialPreset(activeTerrainMaterial).surface
          : null;
        const canMaterial = Boolean(
          doc &&
            ((activeMaterialSurface === "land" &&
              canLand &&
              mapSceneHasLandSurface(doc.map.scene ?? createEmptyMapScene())) ||
              (activeMaterialSurface === "water" &&
                canWater &&
                mapSceneHasWaterSurface(
                  doc.map.scene ?? createEmptyMapScene(),
                ))),
        );
        const canErase = Boolean(
          sceneLayers.find((layer) => layer.id === activeSceneLayerId)
            ?.visible &&
            !sceneLayers.find((layer) => layer.id === activeSceneLayerId)
              ?.locked,
        );
        if (
          nextTool &&
          (nextTool !== "terrain-land" || canLand) &&
          (nextTool !== "terrain-water" || canWater) &&
          (nextTool !== "terrain-material" ||
            (canMaterial && Boolean(activeTerrainMaterial))) &&
          (nextTool !== "scene-eraser" || canErase)
        ) {
          event.preventDefault();
          chooseTool(nextTool);
        }
        return;
      }
      const key = event.key.toLocaleLowerCase("en-US");
      if (key === "d") {
        if (selectedFeatureId) {
          event.preventDefault();
          duplicateSelectedMapItems();
        }
        return;
      }
      if (key === "s") {
        event.preventDefault();
        if (!saving) void save();
        return;
      }
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (key === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeSceneLayerId,
    activeTerrainMaterial,
    artworkBrushAssetId,
    chooseTool,
    doc,
    duplicateSelectedMapItems,
    isActive,
    nudgeSelection,
    redo,
    save,
    saving,
    selectedFeatureId,
    tab,
    undo,
  ]);

  const createFeature = useCallback(
    (feature: MapFeature) => {
      // 新建闭合区域统一写入 area；polygon 仅允许作为旧 MapDocument 的读兼容值。
      const normalizedFeature =
        feature.kind === "polygon"
          ? { ...feature, kind: "area" as const }
          : feature;
      const componentFeature =
        activeComponent &&
        (mapComponentPlacement(activeComponent) === "path" ||
          mapComponentPlacement(activeComponent) === "overlay") &&
        activeComponent.drawKind === normalizedFeature.kind
          ? {
              ...normalizedFeature,
              name: `未命名${activeComponent.name}`,
              props: {
                ...normalizedFeature.props,
                ...activeComponent.props,
              },
              description: activeComponent.description,
            }
          : normalizedFeature;
      const currentMap = docRef.current?.map;
      const targetLayer = currentMap?.layers.find(
        (layer) => layer.id === componentFeature.layerId,
      );
      if (!isEditableMapLayer(targetLayer)) {
        setError("当前绘图层已隐藏或锁定。无法创建地图要素。");
        return;
      }
      mutateDoc((map) => ({
        ...map,
        features: [...map.features, componentFeature],
      }));
      updateMapSelection([componentFeature.id], componentFeature.id);
      if (activeComponent) chooseTool("select");
    },
    [activeComponent, chooseTool, mutateDoc, updateMapSelection],
  );

  const insertComponent = useCallback(
    (
      component: (typeof MAP_COMPONENT_PRESETS)[number],
      anchor?: { readonly x: number; readonly y: number },
      gesture?: MapComponentPlacementGesture,
    ) => {
      if (!doc) return;
      const targetAnchor = anchor ?? {
        x: doc.map.canvas.width / 2,
        y: doc.map.canvas.height / 2,
      };
      const placement = mapComponentPlacement(component);
      if (placement === "terrain-prefab" && component.terrainPrefab) {
        const scene = doc.map.scene ?? createEmptyMapScene();
        const sceneLayerId =
          component.terrainPrefab.kind === "land"
            ? "scene-terrain"
            : "scene-water";
        const sceneLayer = scene.layers.find(
          (layer) => layer.id === sceneLayerId,
        );
        if (!sceneLayer?.visible || sceneLayer.locked) return;
        const id = `region-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        mutateDoc((map) => {
          const currentScene = map.scene ?? createEmptyMapScene();
          const currentLayer = currentScene.layers.find(
            (layer) => layer.id === sceneLayerId,
          );
          if (!currentLayer?.visible || currentLayer.locked) return map;
          const regions = createMapComponentPrefabRegions({
            component,
            id,
            layerId: currentLayer.id,
            anchor: targetAnchor,
            canvas: map.canvas,
            gesture,
          });
          return {
            ...map,
            scene: regions.reduce(
              (current, region) => addMapSceneRegion(current, region),
              currentScene,
            ),
          };
        });
        setSelectedFeatureId(id);
        chooseTool("select");
        return;
      }
      const activeLayer = doc.map.layers.find(
        (layer) => layer.id === activeLayerId,
      );
      if (!activeLayer?.visible || activeLayer.locked) return;
      const id = `feature-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      mutateDoc((map) => ({
        ...map,
        features: [
          ...map.features,
          createMapComponentPrefabFeature({
            component,
            id,
            layerId: activeLayerId,
            anchor: targetAnchor,
            canvas: map.canvas,
            gesture,
          }),
        ],
      }));
      setSelectedFeatureId(id);
      chooseTool("select");
    },
    [activeLayerId, chooseTool, doc, mutateDoc],
  );

  const pickArtworkStamp = useCallback(
    (assetId: string) => {
      const asset = artworkCatalog?.get(assetId);
      if (!doc || !asset) return;
      const artworkLayer = findMapArtworkLayer(
        doc.map.artwork,
        activeArtworkLayerId,
      );
      if (!artworkLayer?.visible || artworkLayer.locked) {
        setError("当前素材图层已隐藏或锁定。");
        return;
      }
      setArtworkBrushAssetId(null);
      setActiveComponentId(null);
      setActiveStampAssetId(asset.id);
      setSelectedFeatureId(null);
      setTool("artwork-stamp");
    },
    [activeArtworkLayerId, artworkCatalog, doc],
  );

  const activateComponent = useCallback(
    (component: (typeof MAP_COMPONENT_PRESETS)[number]) => {
      if (!doc) return;
      const placement = mapComponentPlacement(component);
      if (placement === "stamp") {
        pickArtworkStamp(component.id);
        return;
      }
      if (placement === "terrain-prefab" || placement === "path") {
        if (placement === "terrain-prefab") {
          const scene = doc.map.scene ?? createEmptyMapScene();
          const sceneLayerId =
            component.terrainPrefab?.kind === "water"
              ? "scene-water"
              : "scene-terrain";
          const sceneLayer = scene.layers.find(
            (layer) => layer.id === sceneLayerId,
          );
          if (!sceneLayer?.visible || sceneLayer.locked) {
            setError("当前地形图层已隐藏或锁定。");
            return;
          }
        } else {
          const activeLayer = doc.map.layers.find(
            (layer) => layer.id === activeLayerId,
          );
          if (!activeLayer?.visible || activeLayer.locked) {
            setError("当前绘图层已隐藏或锁定。无法放置路径构件。");
            return;
          }
        }
        setArtworkBrushAssetId(null);
        setActiveStampAssetId(null);
        setActiveTerrainMaterial(null);
        setActiveComponentId(component.id);
        setSelectedFeatureId(null);
        // 路径构件的主卡就是连续路径笔刷；只有拖入画布时才走一次性
        // 预制件落图。此前这里无论构件类型都进入 terrain-prefab，
        // 导致点击路径构件后只能放置固定短线，弧线/触点设置也不会生效。
        setTool(placement === "path" ? "component-path-brush" : "terrain-prefab");
        return;
      }
      const activeLayer = doc.map.layers.find(
        (layer) => layer.id === activeLayerId,
      );
      if (!activeLayer?.visible || activeLayer.locked) {
        setError("当前绘图层已隐藏或锁定。");
        return;
      }
      setArtworkBrushAssetId(null);
      setActiveStampAssetId(null);
      setActiveTerrainMaterial(null);
      setActiveComponentId(component.id);
      setSelectedFeatureId(null);
      const isFreehandArea =
        component.drawKind === "area" || component.drawKind === "polygon";
      // 普通“画笔”构件的契约是自由手绘。不能沿用用户上一次选择的
      // 圆形/椭圆形状，否则组件入口会悄悄退化成规则几何，用户会看到
      // “只有多边形、圆形、椭圆，没有自由画笔”的混合状态。
      if (isFreehandArea) {
        setCanvasSettings((current) =>
          current.areaShape === "freehand"
            ? current
            : { ...current, areaShape: "freehand" },
        );
        setTool("freehand");
      } else {
        setTool(component.drawKind);
      }
    },
    [activeLayerId, doc, pickArtworkStamp],
  );

  /**
   * 连续表面笔刷只用于疆域等覆盖层。大陆和水域预设必须经
   * `terrain-prefab` 放置，保留其自身轮廓而不是把手势扩成一条带。
   */
  const paintComponentSurface = useCallback(
    (
      componentId: string,
      points: readonly MapScenePoint[],
      closed: boolean,
      curve: MapBrushPointCurve,
    ) => {
      const current = docRef.current;
      const component = MAP_COMPONENT_PRESETS.find(
        (candidate) => candidate.id === componentId,
      );
      if (!current || !component || component.interaction !== "surface") {
        return;
      }
      const width = Math.max(24, Math.min(4096, canvasSettings.brushSize));
      const placement = mapComponentPlacement(component);
      if (placement !== "overlay") return;
      const targetLayer = current.map.layers.find(
        (candidate) => candidate.id === activeLayerId,
      );
      if (!targetLayer?.visible || targetLayer.locked) {
        setError("当前绘图层已隐藏或锁定。无法绘制疆域覆盖层。");
        return;
      }
      const areaPoints = createMapComponentSurfaceBrushPoints({
        points,
        width,
        closed,
      });
      if (areaPoints.length < 3) return;
      const featureId = `surface-${componentId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const feature: MapFeature = {
        id: featureId,
        kind: "area",
        name: `未命名${component.name}`,
        entityRef: null,
        layerId: activeLayerId,
        points: areaPoints,
        timeFrom: null,
        timeTo: null,
        props: {
          ...component.props,
          freehand: "true",
          closed: "true",
          curve,
        },
        description: component.description,
      };
      mutateDoc((map) => ({
        ...map,
        features: [...map.features, feature],
      }));
      setSelectedFeatureId(featureId);
    },
    [activeLayerId, canvasSettings.brushSize, mutateDoc],
  );

  const activatePathBrush = useCallback(
    (component: (typeof MAP_COMPONENT_PRESETS)[number]) => {
      if (!doc || mapComponentPlacement(component) !== "path") return;
      const activeLayer = doc.map.layers.find(
        (layer) => layer.id === activeLayerId,
      );
      if (!activeLayer?.visible || activeLayer.locked) {
        setError("当前绘图层已隐藏或锁定。无法使用路径笔刷。");
        return;
      }
      setArtworkBrushAssetId(null);
      setActiveStampAssetId(null);
      setActiveTerrainMaterial(null);
      setActiveComponentId(component.id);
      setSelectedFeatureId(null);
      setTool("component-path-brush");
    },
    [activeLayerId, doc],
  );

  const placeArtworkStamp = useCallback(
    (
      assetId: string,
      anchor: { readonly x: number; readonly y: number },
      gesture?: MapArtworkStampPlacementGesture,
    ) => {
      if (!doc) return;
      const asset = artworkCatalog?.get(assetId);
      if (!asset) return;
      const artworkLayer = findMapArtworkLayer(
        doc.map.artwork,
        activeArtworkLayerId,
      );
      if (!artworkLayer?.visible || artworkLayer.locked) {
        setError("当前素材图层已隐藏或锁定。");
        return;
      }
      const id = `stamp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const variant = mapArtworkVariantIndex(asset, id);
      const artworkVariant = getMapArtworkAssetVariant(asset, variant);
      const placement = mapArtworkStampPlacementTransform({
        anchor,
        defaultScale: canvasSettings.stampScale,
        variant: artworkVariant,
        gesture,
      });
      mutateDoc((map) => {
        const currentArtworkLayer = findMapArtworkLayer(
          map.artwork,
          activeArtworkLayerId,
        );
        if (!currentArtworkLayer?.visible || currentArtworkLayer.locked) {
          return map;
        }
        return {
          ...map,
          artwork: addMapArtworkStamp(
            map.artwork,
            createMapArtworkStamp({
              id,
              layerId: currentArtworkLayer.id,
              assetId,
              variant,
              x: Math.round(placement.x),
              y: Math.round(placement.y),
              scale: placement.scale,
              rotation: placement.rotation,
              opacity: canvasSettings.stampOpacity,
            }),
          ),
        };
      });
      setSelectedFeatureId(id);
    },
    [
      activeArtworkLayerId,
      canvasSettings.stampOpacity,
      canvasSettings.stampScale,
      doc,
      mutateDoc,
      artworkCatalog,
    ],
  );

  const activateArtworkBrush = useCallback(
    (assetId: string) => {
      const asset = artworkCatalog?.get(assetId);
      if (!doc || !asset?.brush) return;
      const scene = doc.map.scene ?? createEmptyMapScene();
      const targetLayerKind = asset.component
        ? sceneLayerKindForComponentCategory(asset.component.category)
        : artworkBrushLayerKind;
      const sceneLayerId = sceneLayerIdForKind(targetLayerKind);
      const sceneLayer = scene.layers.find(
        (layer) => layer.id === sceneLayerId,
      );
      if (!sceneLayer?.visible || sceneLayer.locked) return;
      setArtworkBrushLayerKind(targetLayerKind);
      setActiveSceneLayerId(sceneLayer.id);
      setActiveComponentId(null);
      setArtworkBrushAssetId(asset.id);
      setArtworkBrushColor(asset.component ? asset.color : null);
      setSelectedFeatureId(null);
      setTool("artwork-brush");
    },
    [artworkBrushLayerKind, artworkCatalog, doc],
  );

  const appendArtworkBrushStroke = useCallback(
    (input: {
      readonly asset: MapArtworkStampAsset;
      readonly points: readonly { readonly x: number; readonly y: number }[];
      readonly layerKind: MapSceneLayerKind;
      readonly color: string;
    }) => {
      if (!input.asset.brush || input.points.length === 0) return;
      const strokePoints = input.points.map((point) => ({ ...point }));
      const sceneLayerId = sceneLayerIdForKind(input.layerKind);
      mutateDoc((map) => {
        const scene = map.scene ?? createEmptyMapScene();
        const sceneLayer = scene.layers.find(
          (layer) => layer.id === sceneLayerId,
        );
        if (!sceneLayer?.visible || sceneLayer.locked) {
          return map;
        }
        const stroke = createMapSceneStroke({
          id: `stroke-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
          layerId: sceneLayer.id,
          brushAssetId: input.asset.id,
          curve: canvasSettings.brushPointCurve,
          points: strokePoints,
          color: input.color,
          width: Math.max(12, Math.min(8192, canvasSettings.brushSize)),
          spacing: Math.max(2, Math.min(2048, canvasSettings.brushSpacing)),
          scatter: canvasSettings.brushScatter,
          opacity: canvasSettings.brushOpacity,
        });
        return {
          ...map,
          scene: addMapSceneStroke(scene, stroke),
        };
      });
      setSelectedFeatureId(null);
    },
    [canvasSettings, mutateDoc],
  );

  const paintSceneStroke = useCallback(
    (
      assetId: string,
      points: readonly { readonly x: number; readonly y: number }[],
    ) => {
      if (!doc || points.length === 0) return;
      const asset = artworkCatalog?.get(assetId);
      if (!asset?.brush) return;
      appendArtworkBrushStroke({
        asset,
        points,
        layerKind: asset.component
          ? sceneLayerKindForComponentCategory(asset.component.category)
          : artworkBrushLayerKind,
        color: asset.component
          ? (artworkBrushColor ?? asset.color)
          : asset.color,
      });
    },
    [
      appendArtworkBrushStroke,
      artworkBrushColor,
      artworkBrushLayerKind,
      artworkCatalog,
      doc,
    ],
  );

  const dropArtworkBrush = useCallback(
    (assetId: string, point: MapScenePoint): boolean => {
      if (!doc) return false;
      const asset = artworkCatalog?.get(assetId);
      if (!asset?.brush) return false;
      appendArtworkBrushStroke({
        asset,
        points: [point],
        layerKind: asset.component
          ? sceneLayerKindForComponentCategory(asset.component.category)
          : artworkBrushLayerKind,
        // 拖入资产库即等价于刚选择该素材后的首个落点，使用素材默认颜色。
        color: asset.color,
      });
      return true;
    },
    [appendArtworkBrushStroke, artworkBrushLayerKind, artworkCatalog, doc],
  );

  const importProjectArtwork = useCallback(
    async (files: readonly File[]) => {
      const current = docRef.current;
      if (!current) return;
      const mapId = current.map.id;
      const failures: string[] = [];
      let importedAssetId: string | null = null;

      for (const file of files) {
        const mimeType = mapProjectArtworkMimeType(file);
        if (!mimeType) {
          failures.push(`${file.name}：仅支持 PNG、JPG 和 WebP`);
          continue;
        }
        if (file.size <= 0 || file.size > MAP_PROJECT_ARTWORK_MAX_BYTES) {
          failures.push(`${file.name}：素材必须大于 0 且不超过 12 MB`);
          continue;
        }
        try {
          const [content, dimensions] = await Promise.all([
            file.arrayBuffer(),
            imageDimensions(file),
          ]);
          const latest = docRef.current;
          if (!latest || latest.map.id !== mapId) {
            throw new Error("当前地图已切换，未写入素材");
          }
          const id = `asset-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
          const asset = createMapProjectArtworkAsset({
            mapId,
            id,
            name: file.name,
            mimeType,
            width: dimensions.width,
            height: dimensions.height,
          });
          await storage.createBinary(asset.path, content, {
            createParents: true,
          });
          if (docRef.current?.map.id !== mapId) {
            await storage.remove(asset.path, { permanent: true });
            throw new Error("当前地图已切换，未写入素材");
          }
          mutateDoc((map) => {
            if (map.id !== mapId) return map;
            return {
              ...map,
              artwork: {
                ...map.artwork,
                assets: [...map.artwork.assets, asset],
              },
            };
          });
          setProjectArtworkSources((previous) => {
            const next = new Map(previous);
            next.set(id, mapProjectArtworkDataUrl(mimeType, content));
            return next;
          });
          importedAssetId = id;
        } catch (cause) {
          failures.push(
            `${file.name}：${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }

      if (importedAssetId) {
        setArtworkBrushAssetId(null);
        setActiveStampAssetId(importedAssetId);
        setSelectedFeatureId(null);
        setTool("artwork-stamp");
      }
      setError(failures.length > 0 ? failures.join("；") : null);
    },
    [mutateDoc, storage],
  );

  const renameProjectArtwork = useCallback(
    (assetId: string, name: string) => {
      const normalizedName = mapProjectArtworkFileName(name);
      mutateDoc((map) => {
        let changed = false;
        const assets = map.artwork.assets.map((asset) => {
          if (asset.id !== assetId || asset.name === normalizedName) {
            return asset;
          }
          changed = true;
          return { ...asset, name: normalizedName };
        });
        return changed ? { ...map, artwork: { ...map.artwork, assets } } : map;
      });
      setError(null);
    },
    [mutateDoc],
  );

  const removeProjectArtwork = useCallback(
    (assetId: string) => {
      const current = docRef.current;
      if (!current) return;
      const asset = current.map.artwork.assets.find(
        (item) => item.id === assetId,
      );
      if (!asset) return;
      const usage = mapProjectArtworkUsage(
        current.map.artwork,
        current.map.scene,
      ).get(asset.id);
      if ((usage?.total ?? 0) > 0) {
        setError(
          `素材“${asset.name}”仍被 ${usage?.stamps ?? 0} 个印章和 ${usage?.brushStrokes ?? 0} 条笔触使用，删除这些引用后才能移除素材。`,
        );
        return;
      }
      mutateDoc((map) => ({
        ...map,
        artwork: {
          ...map.artwork,
          assets: map.artwork.assets.filter((item) => item.id !== asset.id),
        },
      }));
      const pending =
        pendingProjectArtworkRemovalsRef.current.get(current.map.id) ??
        new Set<string>();
      pending.add(asset.path);
      pendingProjectArtworkRemovalsRef.current.set(current.map.id, pending);
      setProjectArtworkSources((previous) => {
        const next = new Map(previous);
        next.delete(asset.id);
        return next;
      });
      if (artworkBrushAssetId === asset.id) {
        setArtworkBrushAssetId(null);
        setArtworkBrushColor(null);
      }
      if (activeStampAssetId === asset.id) {
        setActiveStampAssetId(null);
        setTool("select");
      }
      setError(null);
    },
    [activeStampAssetId, artworkBrushAssetId, mutateDoc],
  );

  const handleProjectArtworkInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      if (files.length > 0) void importProjectArtwork(files);
    },
    [importProjectArtwork],
  );

  const eraseSceneStroke = useCallback(
    (points: readonly { readonly x: number; readonly y: number }[]) => {
      if (!doc || points.length === 0) return;
      const strokePoints = points.map((point) => ({ ...point }));
      mutateDoc((map) => {
        const scene = map.scene ?? createEmptyMapScene();
        const sceneLayer = scene.layers.find(
          (layer) => layer.id === activeSceneLayerId,
        );
        if (!sceneLayer?.visible || sceneLayer.locked) return map;
        return {
          ...map,
          scene: eraseMapSceneContent(scene, {
            layerId: sceneLayer.id,
            points: strokePoints,
            curve: canvasSettings.brushPointCurve,
            width: Math.max(12, Math.min(8192, canvasSettings.brushSize)),
          }),
        };
      });
      setSelectedFeatureId(null);
    },
    [
      activeSceneLayerId,
      canvasSettings.brushPointCurve,
      canvasSettings.brushSize,
      doc,
      mutateDoc,
    ],
  );

  const paintTerrainStroke = useCallback(
    (
      kind: MapSceneRegion["kind"],
      points: readonly { readonly x: number; readonly y: number }[],
    ) => {
      if (!doc || points.length === 0) return;
      const strokePoints = points.map((point) => ({ ...point }));
      mutateDoc((map) => {
        const scene = map.scene ?? createEmptyMapScene();
        const sceneLayer = scene.layers.find(
          (layer) => layer.id === "scene-terrain",
        );
        if (!sceneLayer?.visible || sceneLayer.locked) return map;
        const isWater = kind === "water";
        const stroke = createMapSceneStroke({
          id: `terrain-${isWater ? "lower" : "raise"}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
          layerId: sceneLayer.id,
          tool: isWater ? "erase" : "paint",
          brushAssetId: null,
          shape: canvasSettings.terrainBrushShape,
          curve: canvasSettings.brushPointCurve,
          points: strokePoints,
          color: isWater
            ? scene.terrainStyle.shallowWaterColor
            : scene.terrainStyle.landColor,
          width: Math.max(12, Math.min(8192, canvasSettings.brushSize)),
          spacing: Math.max(2, Math.min(2048, canvasSettings.brushSpacing)),
          scatter: 0,
          opacity: 1,
        });
        return {
          ...map,
          scene: addMapSceneStroke(scene, stroke),
        };
      });
      setSelectedFeatureId(null);
    },
    [
      canvasSettings.brushSize,
      canvasSettings.brushSpacing,
      canvasSettings.brushPointCurve,
      canvasSettings.terrainBrushShape,
      doc,
      mutateDoc,
    ],
  );

  const activateTerrainMaterial = useCallback(
    (material: MapTerrainMaterialPreset) => {
      if (!doc) return;
      const scene = doc.map.scene ?? createEmptyMapScene();
      const targetLayerId =
        material.surface === "water" ? "scene-water" : "scene-terrain";
      const targetLayer = scene.layers.find(
        (layer) => layer.id === targetLayerId,
      );
      if (!targetLayer?.visible || targetLayer.locked) return;
      const hasTargetSurface =
        material.surface === "water"
          ? mapSceneHasWaterSurface(scene)
          : mapSceneHasLandSurface(scene);
      if (!hasTargetSurface) {
        setError(
          material.surface === "water"
            ? "请先绘制或勾画水域，再在水面上叠加浅海或深海材质。"
            : "请先绘制或勾画陆地，再在陆地上叠加地貌材质。",
        );
        return;
      }
      setArtworkBrushAssetId(null);
      setActiveStampAssetId(null);
      setActiveComponentId(null);
      setActiveTerrainMaterial(material.id);
      setActiveSceneLayerId(targetLayer.id);
      setSelectedFeatureId(null);
      setTool("terrain-material");
    },
    [doc],
  );

  const paintTerrainMaterialStroke = useCallback(
    (
      material: MapTerrainMaterial,
      points: readonly { readonly x: number; readonly y: number }[],
    ) => {
      if (!doc || points.length === 0) return;
      const strokePoints = points.map((point) => ({ ...point }));
      const preset = getMapTerrainMaterialPreset(material);
      const currentScene = doc.map.scene ?? createEmptyMapScene();
      const hasTargetSurface =
        preset.surface === "water"
          ? mapSceneHasWaterSurface(currentScene)
          : mapSceneHasLandSurface(currentScene);
      if (!hasTargetSurface) {
        setError(
          preset.surface === "water"
            ? "当前没有可混合材质的水域。请先绘制水域。"
            : "当前没有可混合材质的陆地。请先绘制陆地。",
        );
        return;
      }
      mutateDoc((map) => {
        const scene = map.scene ?? createEmptyMapScene();
        const targetLayer = scene.layers.find(
          (layer) =>
            layer.id ===
            (preset.surface === "water" ? "scene-water" : "scene-terrain"),
        );
        if (!targetLayer?.visible || targetLayer.locked) return map;
        const stroke = createMapSceneStroke({
          id: `material-${material}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
          layerId: targetLayer.id,
          terrainMaterial: material,
          shape: canvasSettings.terrainBrushShape,
          curve: canvasSettings.brushPointCurve,
          points: strokePoints,
          color: preset.color,
          width: Math.max(12, Math.min(8192, canvasSettings.brushSize)),
          spacing: Math.max(2, Math.min(2048, canvasSettings.brushSpacing)),
          scatter: 0,
          opacity: canvasSettings.brushOpacity,
        });
        return {
          ...map,
          scene: addMapSceneStroke(scene, stroke),
        };
      });
      setSelectedFeatureId(null);
    },
    [canvasSettings, doc, mutateDoc],
  );

  const removeSceneStroke = useCallback(
    (strokeId: string) => {
      const currentMap = docRef.current?.map;
      const layer = currentMap?.scene?.layers.find((candidate) =>
        candidate.strokes.some((stroke) => stroke.id === strokeId),
      );
      if (!isEditableMapLayer(layer)) {
        setError("当前地形图层已隐藏或锁定。无法删除笔触。");
        return;
      }
      mutateDoc((map) => ({
        ...map,
        scene: removeMapSceneStroke(
          map.scene ?? createEmptyMapScene(),
          strokeId,
        ),
      }));
      setSelectedFeatureId(null);
    },
    [mutateDoc],
  );

  const updateSceneStroke = useCallback(
    (
      strokeId: string,
      patch: Partial<
        Pick<
          MapSceneStroke,
          | "color"
          | "curve"
          | "opacity"
          | "points"
          | "scatter"
          | "shape"
          | "spacing"
          | "width"
        >
      >,
    ) => {
      const currentMap = docRef.current?.map;
      const layer = currentMap?.scene?.layers.find((candidate) =>
        candidate.strokes.some((stroke) => stroke.id === strokeId),
      );
      if (!isEditableMapLayer(layer)) {
        setError("当前地形图层已隐藏或锁定。无法修改笔触。");
        return;
      }
      mutateDoc((map) => ({
        ...map,
        scene: updateMapSceneStroke(
          map.scene ?? createEmptyMapScene(),
          strokeId,
          patch,
        ),
      }));
    },
    [mutateDoc],
  );

  const moveSceneStroke = useCallback(
    (
      strokeId: string,
      points: readonly { readonly x: number; readonly y: number }[],
    ) => {
      const currentMap = docRef.current?.map;
      const layer = currentMap?.scene?.layers.find((candidate) =>
        candidate.strokes.some((stroke) => stroke.id === strokeId),
      );
      if (!isEditableMapLayer(layer)) {
        setError("当前地形图层已隐藏或锁定。无法移动笔触。");
        return;
      }
      mutateDoc((map) => ({
        ...map,
        scene: updateMapSceneStroke(
          map.scene ?? createEmptyMapScene(),
          strokeId,
          {
            points: points.map((point) => ({ ...point })),
          },
        ),
      }));
    },
    [mutateDoc],
  );

  const createSceneRegion = useCallback(
    (
      kind: MapSceneRegion["kind"],
      points: readonly { readonly x: number; readonly y: number }[],
      curve: MapSceneRegion["curve"] = canvasSettings.brushPointCurve,
    ) => {
      if (points.length < 3) return;
      const regionId = `region-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const layerId = kind === "land" ? "scene-terrain" : "scene-water";
      mutateDoc((map) => {
        const scene = map.scene ?? createEmptyMapScene();
        const layer = scene.layers.find((item) => item.id === layerId);
        if (!layer?.visible || layer.locked) return map;
        const regionPoints = points.map((point) => ({ ...point }));
        return {
          ...map,
          scene: addMapSceneRegion(
            scene,
            createMapSceneRegion({
              id: regionId,
              layerId: layer.id,
              kind,
              points: regionPoints,
              curve,
            }),
          ),
        };
      });
      setSelectedFeatureId(regionId);
    },
    [canvasSettings.brushPointCurve, mutateDoc],
  );

  const removeSceneRegion = useCallback(
    (regionId: string) => {
      const currentMap = docRef.current?.map;
      const layer = currentMap?.scene?.layers.find((candidate) =>
        candidate.regions.some((region) => region.id === regionId),
      );
      if (!isEditableMapLayer(layer)) {
        setError("当前地形图层已隐藏或锁定。无法删除区域。");
        return;
      }
      mutateDoc((map) => ({
        ...map,
        scene: removeMapSceneRegion(
          map.scene ?? createEmptyMapScene(),
          regionId,
        ),
      }));
      setSelectedFeatureId(null);
    },
    [mutateDoc],
  );

  const updateSceneRegion = useCallback(
    (
      regionId: string,
      patch: Partial<
        Pick<
          MapSceneRegion,
          | "edgeColor"
          | "edgeWidth"
          | "fill"
          | "opacity"
          | "points"
          | "curve"
          | "texture"
          | "terrainMaterial"
        >
      >,
    ) => {
      const currentMap = docRef.current?.map;
      const layer = currentMap?.scene?.layers.find((candidate) =>
        candidate.regions.some((region) => region.id === regionId),
      );
      if (!isEditableMapLayer(layer)) {
        setError("当前地形图层已隐藏或锁定。无法修改区域。");
        return;
      }
      mutateDoc((map) => ({
        ...map,
        scene: updateMapSceneRegion(
          map.scene ?? createEmptyMapScene(),
          regionId,
          patch,
        ),
      }));
    },
    [mutateDoc],
  );

  const moveSceneRegion = useCallback(
    (
      regionId: string,
      points: readonly { readonly x: number; readonly y: number }[],
    ) => {
      const currentMap = docRef.current?.map;
      const layer = currentMap?.scene?.layers.find((candidate) =>
        candidate.regions.some((region) => region.id === regionId),
      );
      if (!isEditableMapLayer(layer)) {
        setError("当前地形图层已隐藏或锁定。无法移动区域。");
        return;
      }
      mutateDoc((map) => ({
        ...map,
        scene: updateMapSceneRegion(
          map.scene ?? createEmptyMapScene(),
          regionId,
          {
            points: points.map((point) => ({ ...point })),
          },
        ),
      }));
    },
    [mutateDoc],
  );

  const focusFeature = useCallback(
    (feature: MapFeature) => {
      setActiveLayerId(feature.layerId);
      updateMapSelection([feature.id], feature.id);
      chooseTool("select");
      setFocusRequest((request) => request + 1);
    },
    [chooseTool, updateMapSelection],
  );

  const isDirty = Boolean(doc && history.length > 0);

  const updateFeature = useCallback(
    (featureId: string, patch: Partial<MapFeature>) => {
      const currentMap = docRef.current?.map;
      const feature = currentMap?.features.find(
        (item) => item.id === featureId,
      );
      const layer = currentMap?.layers.find(
        (item) => item.id === feature?.layerId,
      );
      if (!isEditableMapLayer(layer)) {
        setError("当前绘图层已隐藏或锁定。无法修改地图要素。");
        return;
      }
      mutateDoc((map) => ({
        ...map,
        features: map.features.map((feature) =>
          feature.id === featureId ? { ...feature, ...patch } : feature,
        ),
      }));
    },
    [mutateDoc],
  );

  /** 将普通自由画笔提升为场景区域，保留原几何与可见样式。 */
  const promoteFreeformArea = useCallback(
    (
      featureId: string,
      kind: MapSceneRegion["kind"],
      terrainMaterial: MapTerrainMaterial | null = null,
    ) => {
      const currentMap = docRef.current?.map;
      const feature = currentMap?.features.find(
        (candidate) => candidate.id === featureId,
      );
      if (!currentMap || !feature || !isMapFeatureFreeformArea(feature.kind)) {
        setError("只有自由画笔区域可以转为地形区域。");
        return;
      }
      const sourceLayer = currentMap.layers.find(
        (layer) => layer.id === feature.layerId,
      );
      const scene = currentMap.scene ?? createEmptyMapScene();
      const targetLayerId = kind === "land" ? "scene-terrain" : "scene-water";
      const targetLayer = scene.layers.find(
        (layer) => layer.id === targetLayerId,
      );
      if (
        !isEditableMapLayer(sourceLayer) ||
        !isEditableMapLayer(targetLayer)
      ) {
        setError("源图层或目标地形图层已隐藏或锁定，无法转换区域。");
        return;
      }
      if (
        terrainMaterial &&
        getMapTerrainMaterialPreset(terrainMaterial).surface !== kind
      ) {
        setError("附加材质必须与目标区域的陆地或水域表面一致。");
        return;
      }
      const areaStyle = getMapFeatureAreaStyle(feature);
      const regionId = `region-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const region = createMapSceneRegion({
        id: regionId,
        layerId: targetLayer.id,
        kind,
        points: feature.points,
        fill: areaStyle.fill,
        opacity: areaStyle.opacity,
        edgeColor:
          feature.props.color ?? (kind === "land" ? "#5c5038" : "#2f6377"),
        edgeWidth: Math.max(
          0.75,
          Math.min(256, Number(feature.props.lineWidth ?? 2) || 2),
        ),
        curve: feature.props.curve === "line" ? "line" : "arc",
        terrainMaterial,
      });
      mutateDoc((map) => {
        const currentScene = map.scene ?? createEmptyMapScene();
        const nextScene = addMapSceneRegion(currentScene, region);
        if (nextScene === currentScene) return map;
        return {
          ...map,
          features: map.features.filter(
            (candidate) => candidate.id !== featureId,
          ),
          scene: nextScene,
          groups: map.groups
            ?.map((group) =>
              group.itemIds.includes(featureId)
                ? {
                    ...group,
                    itemIds: group.itemIds.map((itemId) =>
                      itemId === featureId ? regionId : itemId,
                    ),
                  }
                : group,
            )
            .filter((group) => group.itemIds.length >= 2),
        };
      });
      setActiveSceneLayerId(targetLayer.id);
      updateMapSelection([regionId], regionId);
      chooseTool("select");
    },
    [chooseTool, mutateDoc, updateMapSelection],
  );

  const duplicateFeature = useCallback(
    (featureId: string) => {
      duplicateSelectedMapItems([featureId]);
    },
    [duplicateSelectedMapItems],
  );

  const moveFeatureToLayer = useCallback(
    (featureId: string, layerId: string) => {
      const currentMap = docRef.current?.map;
      const source = currentMap?.features.find(
        (feature) => feature.id === featureId,
      );
      const sourceLayer = currentMap?.layers.find(
        (layer) => layer.id === source?.layerId,
      );
      const targetLayer = currentMap?.layers.find(
        (layer) => layer.id === layerId,
      );
      if (
        !source ||
        !isEditableMapLayer(sourceLayer) ||
        !isEditableMapLayer(targetLayer)
      ) {
        setError("源图层或目标图层已隐藏或锁定。无法移动地图要素。");
        return;
      }
      if (source.kind === "node" && getTopologyNodeLocked(source)) {
        setError("当前拓扑节点已锁定，无法移动所属图层。");
        return;
      }
      mutateDoc((map) => ({
        ...map,
        features: map.features.map((feature) =>
          feature.id === featureId ? { ...feature, layerId } : feature,
        ),
      }));
      setActiveLayerId(layerId);
    },
    [mutateDoc],
  );

  const updateGeometry = useCallback(
    (
      featureId: string,
      points: MapFeature["points"],
      props?: MapFeature["props"],
    ) => {
      const currentMap = docRef.current?.map;
      const feature = currentMap?.features.find(
        (item) => item.id === featureId,
      );
      const layer = currentMap?.layers.find(
        (item) => item.id === feature?.layerId,
      );
      if (!isEditableMapLayer(layer)) {
        setError("当前绘图层已隐藏或锁定。无法修改地图几何。");
        return;
      }
      mutateDoc((map) => ({
        ...map,
        features: map.features.map((feature) =>
          feature.id === featureId
            ? {
                ...feature,
                points,
                props: props ? { ...feature.props, ...props } : feature.props,
              }
            : feature,
        ),
      }));
    },
    [mutateDoc],
  );

  const updateArtworkStampPosition = useCallback(
    (stampId: string, point: { readonly x: number; readonly y: number }) => {
      const currentMap = docRef.current?.map;
      const layer = currentMap?.artwork.layers.find((candidate) =>
        candidate.stamps.some((stamp) => stamp.id === stampId),
      );
      if (!isEditableMapLayer(layer)) {
        setError("当前素材图层已隐藏或锁定。无法移动印章。");
        return;
      }
      mutateDoc((map) => ({
        ...map,
        artwork: updateMapArtworkStamp(map.artwork, stampId, {
          x: Math.round(point.x),
          y: Math.round(point.y),
        }),
      }));
    },
    [mutateDoc],
  );

  const updateArtworkStamp = useCallback(
    (
      stampId: string,
      patch: Partial<Omit<MapArtworkStamp, "id" | "layerId">>,
    ) => {
      const currentMap = docRef.current?.map;
      const layer = currentMap?.artwork.layers.find((candidate) =>
        candidate.stamps.some((stamp) => stamp.id === stampId),
      );
      if (!isEditableMapLayer(layer)) {
        setError("当前素材图层已隐藏或锁定。无法修改印章。");
        return;
      }
      mutateDoc((map) => ({
        ...map,
        artwork: updateMapArtworkStamp(map.artwork, stampId, patch),
      }));
    },
    [mutateDoc],
  );

  const removeArtworkStamp = useCallback(
    (stampId: string) => {
      const currentMap = docRef.current?.map;
      const layer = currentMap?.artwork.layers.find((candidate) =>
        candidate.stamps.some((stamp) => stamp.id === stampId),
      );
      if (!isEditableMapLayer(layer)) {
        setError("当前素材图层已隐藏或锁定。无法删除印章。");
        return;
      }
      mutateDoc((map) => ({
        ...map,
        artwork: removeMapArtworkStamp(map.artwork, stampId),
      }));
      setSelectedFeatureId(null);
    },
    [mutateDoc],
  );

  const updateTopologyNodePositions = useCallback(
    (
      moves: readonly {
        readonly id: string;
        readonly point: { readonly x: number; readonly y: number };
      }[],
    ) => {
      const currentMap = docRef.current?.map;
      const invalidMove = moves.find((move) => {
        const feature = currentMap?.features.find(
          (item) => item.id === move.id && item.kind === "node",
        );
        const layer = currentMap?.layers.find(
          (item) => item.id === feature?.layerId,
        );
        return !feature || !isEditableMapLayer(layer);
      });
      if (
        !currentMap ||
        invalidMove ||
        !canEditTopologyNodes(
          currentMap,
          moves.map((move) => move.id),
        )
      ) {
        setError("选区包含隐藏、锁定或不存在的拓扑节点，无法移动。");
        return;
      }
      mutateDoc((map) => moveTopologyNodes(map, moves));
      setError(null);
    },
    [mutateDoc],
  );

  const createConnectedTopologyNodeFromSelection = useCallback(
    (
      direction: "incoming" | "outgoing",
      anchorFeatureId: string | null = selectedFeatureId,
      routeTemplate: Partial<{
        readonly relation: TopologyRouteRelation;
        readonly direction: TopologyRouteDirection;
      }> = {},
      placement: "sequence" | "hierarchy" = "sequence",
    ) => {
      const currentMap = docRef.current?.map;
      const anchor = currentMap?.features.find(
        (feature) => feature.id === anchorFeatureId && feature.kind === "node",
      );
      if (!currentMap || !anchor?.points[0]) {
        setError("请先选择一个拓扑节点，再创建相邻节点。");
        return;
      }
      const layer = currentMap.layers.find(
        (candidate) => candidate.id === anchor.layerId,
      );
      if (!isEditableMapLayer(layer)) {
        setError("当前拓扑节点所在图层已隐藏或锁定，无法创建相邻节点。");
        return;
      }
      if (getTopologyNodeLocked(anchor)) {
        setError("当前拓扑节点已锁定，无法创建相邻节点。");
        return;
      }
      const linkedMap = maps.find(
        (map) =>
          map.id === activeTopologyLinkedMapId && map.id !== currentMap.id,
      );
      const entity = activeTopologyEntityRef
        ? entityOptions.find(
            (candidate) =>
              candidate.kind === activeTopologyEntityRef.kind &&
              candidate.id === activeTopologyEntityRef.id,
          )
        : undefined;
      const setting =
        activeTopologyEntityRef?.kind === "setting"
          ? topologySettingById.get(activeTopologyEntityRef.id)
          : undefined;
      const nodeId = newTopologyItemId("node");
      const edgeId = newTopologyItemId("route");
      const point =
        placement === "hierarchy"
          ? topologyHierarchyAdjacentNodePoint(
              currentMap,
              anchor.id,
              direction === "incoming" ? "parent" : "child",
            )
          : topologyAdjacentNodePoint(currentMap, anchor.id, direction);
      if (!point) {
        setError("当前节点没有有效坐标，无法创建相邻节点。");
        return;
      }
      let createdNodeId: string | null = null;
      mutateDoc((map) => {
        const result = createConnectedTopologyNode(map, {
          anchorNodeId: anchor.id,
          nodeId,
          edgeId,
          direction,
          point,
          node: {
            kind: activeTopologyNodeKind,
            status: activeTopologyNodeStatus,
            name:
              activeTopologyNodeName.trim() ||
              (linkedMap?.name ??
                setting?.name ??
                entity?.name ??
                getTopologyNodeKindOption(activeTopologyNodeKind).defaultName),
            color: getTopologyNodeKindOption(activeTopologyNodeKind).color,
            linkedMapId: linkedMap?.id ?? null,
            entityRef: activeTopologyEntityRef,
          },
          relation: routeTemplate.relation ?? activeTopologyRouteRelation,
          routeDirection:
            routeTemplate.direction ?? activeTopologyRouteDirection,
        });
        if (!result) return map;
        createdNodeId = result.nodeId;
        return result.map;
      });
      if (createdNodeId) {
        updateMapSelection([createdNodeId], createdNodeId);
        chooseTool("select");
        setError(null);
      }
    },
    [
      activeTopologyEntityRef,
      activeTopologyLinkedMapId,
      activeTopologyNodeKind,
      activeTopologyNodeName,
      activeTopologyNodeStatus,
      activeTopologyRouteDirection,
      activeTopologyRouteRelation,
      chooseTool,
      entityOptions,
      maps,
      mutateDoc,
      selectedFeatureId,
      topologySettingById,
      updateMapSelection,
    ],
  );

  const insertTopologyNodeFromSelection = useCallback(() => {
    const currentMap = docRef.current?.map;
    const edge = currentMap?.features.find(
      (feature) => feature.id === selectedFeatureId && feature.kind === "route",
    );
    if (!currentMap || !edge) {
      setError("请先选择一条拓扑通道，再插入节点。");
      return;
    }
    const layer = currentMap.layers.find(
      (candidate) => candidate.id === edge.layerId,
    );
    if (!isEditableMapLayer(layer)) {
      setError("当前拓扑通道所在图层已隐藏或锁定，无法插入节点。");
      return;
    }
    const linkedMap = maps.find(
      (map) => map.id === activeTopologyLinkedMapId && map.id !== currentMap.id,
    );
    const entity = activeTopologyEntityRef
      ? entityOptions.find(
          (candidate) =>
            candidate.kind === activeTopologyEntityRef.kind &&
            candidate.id === activeTopologyEntityRef.id,
        )
      : undefined;
    const setting =
      activeTopologyEntityRef?.kind === "setting"
        ? topologySettingById.get(activeTopologyEntityRef.id)
        : undefined;
    const nodeId = newTopologyItemId("node");
    const trailingEdgeId = newTopologyItemId("route");
    let createdNodeId: string | null = null;
    mutateDoc((map) => {
      const result = insertTopologyNodeOnEdge(map, {
        edgeId: edge.id,
        nodeId,
        trailingEdgeId,
        node: {
          kind: activeTopologyNodeKind,
          status: activeTopologyNodeStatus,
          name:
            activeTopologyNodeName.trim() ||
            (linkedMap?.name ??
              setting?.name ??
              entity?.name ??
              getTopologyNodeKindOption(activeTopologyNodeKind).defaultName),
          color: getTopologyNodeKindOption(activeTopologyNodeKind).color,
          linkedMapId: linkedMap?.id ?? null,
          entityRef: activeTopologyEntityRef,
        },
      });
      if (!result) return map;
      createdNodeId = result.nodeId;
      return result.map;
    });
    if (createdNodeId) {
      updateMapSelection([createdNodeId], createdNodeId);
      chooseTool("select");
      setError(null);
    }
  }, [
    activeTopologyEntityRef,
    activeTopologyLinkedMapId,
    activeTopologyNodeKind,
    activeTopologyNodeName,
    activeTopologyNodeStatus,
    chooseTool,
    entityOptions,
    maps,
    mutateDoc,
    selectedFeatureId,
    topologySettingById,
    updateMapSelection,
  ]);

  const createConnectedTopologyNodeFromCanvas = useCallback(
    (featureId: string, direction: "incoming" | "outgoing") => {
      createConnectedTopologyNodeFromSelection(direction, featureId);
    },
    [createConnectedTopologyNodeFromSelection],
  );

  const createHierarchyTopologyNodeFromSelection = useCallback(
    (
      direction: "incoming" | "outgoing",
      anchorFeatureId: string | null = selectedFeatureId,
    ) => {
      createConnectedTopologyNodeFromSelection(
        direction,
        anchorFeatureId,
        { relation: "branch", direction: "one-way" },
        "hierarchy",
      );
    },
    [createConnectedTopologyNodeFromSelection, selectedFeatureId],
  );

  const createHierarchyTopologyNodeFromCanvas = useCallback(
    (featureId: string, direction: "incoming" | "outgoing") => {
      createHierarchyTopologyNodeFromSelection(direction, featureId);
    },
    [createHierarchyTopologyNodeFromSelection],
  );

  /**
   * 多选节点后直接建立当前关系模板的通道。选择顺序就是单向通道的来源
   * 与目标顺序；双向通道仍由业务层按无序端点做重复检查。这个入口与画布
   * 点选/端口拖拽共用 createTopologyEdgeFeature，不能绕开拓扑事实约束。
   */
  const connectSelectedTopologyNodes = useCallback(
    (nodeIds: readonly string[]) => {
      const [sourceNodeId, targetNodeId] = nodeIds;
      const currentMap = docRef.current?.map;
      const activeLayer = currentMap?.layers.find(
        (layer) => layer.id === activeLayerId,
      );
      if (
        !currentMap ||
        !sourceNodeId ||
        !targetNodeId ||
        !isEditableMapLayer(activeLayer)
      ) {
        setError("请选择两个可连接的拓扑节点，并确保当前图层可编辑。");
        return;
      }

      const routeId = newTopologyItemId("route");
      let createdRouteId: string | null = null;
      mutateDoc((map) => {
        const route = createTopologyEdgeFeature({
          id: routeId,
          layerId: activeLayer.id,
          connection: { source: sourceNodeId, target: targetNodeId },
          document: map,
          relation: activeTopologyRouteRelation,
          direction: activeTopologyRouteDirection,
        });
        if (!route) return map;
        createdRouteId = route.id;
        return { ...map, features: [...map.features, route] };
      });
      if (!createdRouteId) {
        setError("所选节点不可连接，或当前关系的通道已经存在。");
        return;
      }
      updateMapSelection([createdRouteId], createdRouteId);
      chooseTool("select");
      setError(null);
    },
    [
      activeLayerId,
      activeTopologyRouteDirection,
      activeTopologyRouteRelation,
      chooseTool,
      mutateDoc,
      updateMapSelection,
    ],
  );

  const toggleTopologyNodeLock = useCallback(
    (featureId: string, locked: boolean) => {
      const currentMap = docRef.current?.map;
      const feature = currentMap?.features.find(
        (item) => item.id === featureId && item.kind === "node",
      );
      const layer = currentMap?.layers.find(
        (item) => item.id === feature?.layerId,
      );
      if (!feature || !isEditableMapLayer(layer)) {
        setError("当前拓扑节点所在图层已隐藏或锁定，无法修改节点锁定状态。");
        return;
      }
      mutateDoc((map) => ({
        ...map,
        features: map.features.map((item) =>
          item.id === featureId
            ? {
                ...item,
                props: updateTopologyNodeProps(item.props, { locked }),
              }
            : item,
        ),
      }));
      setError(null);
    },
    [mutateDoc],
  );

  const reverseSelectedTopologyRoute = useCallback(() => {
    if (!selectedFeatureId) return;
    const currentMap = docRef.current?.map;
    const feature = currentMap?.features.find(
      (candidate) =>
        candidate.id === selectedFeatureId && candidate.kind === "route",
    );
    const layer = currentMap?.layers.find(
      (candidate) => candidate.id === feature?.layerId,
    );
    if (!currentMap || !feature || !isEditableMapLayer(layer)) {
      setError("当前拓扑通道不可编辑。");
      return;
    }
    const next = reverseTopologyEdge(currentMap, feature.id);
    if (!next) {
      setError("通道端点无效、图层不可编辑或反转后会产生重复关系。");
      return;
    }
    mutateDoc((map) => reverseTopologyEdge(map, feature.id) ?? map);
    setError(null);
  }, [mutateDoc, selectedFeatureId]);

  const openTopologyNodeMap = useCallback(
    (featureId: string) => {
      const feature = docRef.current?.map.features.find(
        (item) => item.id === featureId && item.kind === "node",
      );
      const linkedMapId = feature ? getTopologyNodeLinkedMapId(feature) : null;
      if (!linkedMapId) {
        setError("当前拓扑节点尚未关联地图。");
        return;
      }
      if (!maps.some((map) => map.id === linkedMapId)) {
        setError(`关联地图“${linkedMapId}”不存在，请在节点检查器中解除关联。`);
        return;
      }
      void openMap(linkedMapId);
    },
    [maps, openMap],
  );

  const selectTopologyInvalidRoute = useCallback(
    (featureId: string) => {
      const currentMap = docRef.current?.map;
      const feature = currentMap?.features.find(
        (item) => item.id === featureId && item.kind === "route",
      );
      if (!currentMap || !feature) return;
      setActiveLayerId(feature.layerId);
      updateMapSelection([feature.id], feature.id);
      chooseTool("select");
      setError(
        getTopologyInvalidRouteDiagnostics(currentMap).find(
          (diagnostic) => diagnostic.route.id === feature.id,
        )?.reasonLabel ?? "该通道端点无效，请重新选择端点或删除通道。",
      );
    },
    [chooseTool, updateMapSelection],
  );

  const beginTopologyNodeMapCreation = useCallback((featureId: string) => {
    const feature = docRef.current?.map.features.find(
      (item) => item.id === featureId && item.kind === "node",
    );
    if (!feature) return;
    const kind = getTopologyNodeKind(feature);
    setNewMapName(feature.name);
    setNewMapProjection(topologyProjectionForNodeKind(kind));
    setNewMapLinkNodeId(feature.id);
    setNewMapOpen(true);
  }, []);

  const reconnectTopologyRoute = useCallback(
    (featureId: string, sourceNodeId: string, targetNodeId: string) => {
      const currentMap = docRef.current?.map;
      const feature = currentMap?.features.find(
        (item) => item.id === featureId && item.kind === "route",
      );
      const layer = currentMap?.layers.find(
        (item) => item.id === feature?.layerId,
      );
      if (!currentMap || !feature || !isEditableMapLayer(layer)) {
        setError("当前拓扑图层已隐藏或锁定。无法重连通道。");
        return;
      }
      const next = reconnectTopologyEdge(currentMap, featureId, {
        sourceNodeId,
        targetNodeId,
      });
      if (!next) {
        setError("通道需要连接两个不同且存在的世界节点，且不能产生重复关系。");
        return;
      }
      mutateDoc(
        (map) =>
          reconnectTopologyEdge(map, featureId, {
            sourceNodeId,
            targetNodeId,
          }) ?? map,
      );
    },
    [mutateDoc],
  );

  const updateTopologyRouteFromInspector = useCallback(
    (
      featureId: string,
      patch: Partial<{
        readonly relation: TopologyRouteRelation;
        readonly direction: TopologyRouteDirection;
      }>,
    ) => {
      const currentMap = docRef.current?.map;
      const next = currentMap
        ? updateTopologyRoute(currentMap, featureId, patch)
        : null;
      if (!next) {
        setError("通道关系或方向会产生重复连接，未修改。");
        return;
      }
      mutateDoc(() => next);
      setError(null);
    },
    [mutateDoc],
  );

  const autoLayoutTopology = useCallback(
    (direction: "horizontal" | "vertical") => {
      const currentMap = docRef.current?.map;
      const nodeIds =
        currentMap?.features
          .filter((feature) => feature.kind === "node")
          .map((feature) => feature.id) ?? [];
      if (!currentMap || nodeIds.length < 2) {
        setError("至少需要两个拓扑节点才能自动布局。");
        return;
      }
      if (
        !canEditMapSelectableItems(currentMap, nodeIds) ||
        !canEditTopologyNodes(currentMap, nodeIds)
      ) {
        setError("自动布局需要所有拓扑节点所在图层可见且未锁定。");
        return;
      }
      mutateDoc((map) => arrangeTopologyNodes(map, direction));
      setError(null);
      setFocusRequest((request) => request + 1);
    },
    [mutateDoc],
  );

  const importTopologyNodesFromWorldArchitecture = useCallback(() => {
    const currentMap = docRef.current?.map;
    const activeLayer = currentMap?.layers.find(
      (layer) => layer.id === activeLayerId,
    );
    if (!currentMap || !isEditableMapLayer(activeLayer)) {
      setError("当前拓扑图层已隐藏或锁定，无法导入世界架构。");
      return;
    }
    if (!topologyImportRootId || topologySettingTree.nodes.length === 0) {
      setError("请先选择一个世界架构节点。");
      return;
    }
    let importedNodeIds: readonly string[] = [];
    let importedRouteIds: readonly string[] = [];
    let rootNodeId: string | null = null;
    mutateDoc((map) => {
      const result = importTopologySettingSubtree(map, {
        rootSettingId: topologyImportRootId,
        settingNodes: topologySettingTree.nodes,
        levelTypes: topologySettingTree.levelTypes,
        layerId: activeLayer.id,
      });
      importedNodeIds = result.importedNodeIds;
      importedRouteIds = result.importedRouteIds;
      rootNodeId = result.rootNodeId;
      return result.map;
    });
    if (importedNodeIds.length === 0 && importedRouteIds.length === 0) {
      setError("所选世界架构范围已完整存在于当前拓扑中。");
      return;
    }
    if (rootNodeId) {
      updateMapSelection([rootNodeId], rootNodeId);
      setFocusRequest((request) => request + 1);
    }
    chooseTool("select");
    setError(null);
  }, [
    activeLayerId,
    chooseTool,
    mutateDoc,
    topologyImportRootId,
    topologySettingTree,
    updateMapSelection,
  ]);

  const importTopologySettingSubtreeFromNode = useCallback(
    (featureId: string) => {
      const currentMap = docRef.current?.map;
      const node = currentMap?.features.find(
        (feature) => feature.id === featureId && feature.kind === "node",
      );
      if (!currentMap || !node) {
        setError("当前拓扑节点已不存在，无法导入世界架构子树。");
        return;
      }
      if (node.entityRef?.kind !== "setting") {
        setError("当前节点尚未关联世界架构设定，无法导入子树。");
        return;
      }
      const layer = currentMap.layers.find(
        (candidate) => candidate.id === node.layerId,
      );
      if (!isEditableMapLayer(layer)) {
        setError("当前拓扑节点所在图层已隐藏或锁定，无法导入世界架构。");
        return;
      }
      const settingTree = topologySettingTreeRef.current;
      if (settingTree.nodes.length === 0) {
        setError("当前项目没有可读取的世界架构空间树。");
        return;
      }

      let importedNodeIds: readonly string[] = [];
      let importedRouteIds: readonly string[] = [];
      let rootNodeId: string | null = null;
      mutateDoc((map) => {
        const result = importTopologySettingSubtree(map, {
          rootSettingId: node.entityRef!.id,
          settingNodes: settingTree.nodes,
          levelTypes: settingTree.levelTypes,
          layerId: node.layerId,
        });
        importedNodeIds = result.importedNodeIds;
        importedRouteIds = result.importedRouteIds;
        rootNodeId = result.rootNodeId;
        return result.map;
      });
      if (importedNodeIds.length === 0 && importedRouteIds.length === 0) {
        setError("该世界架构范围已完整存在于当前拓扑中。");
        return;
      }
      updateMapSelection(
        rootNodeId ? [rootNodeId] : [featureId],
        rootNodeId ?? featureId,
      );
      setFocusRequest((request) => request + 1);
      chooseTool("select");
      setError(null);
    },
    [chooseTool, mutateDoc, updateMapSelection],
  );

  const moveSelectableMapItems = useCallback(
    (
      itemIds: readonly string[],
      delta: { readonly x: number; readonly y: number },
    ) => {
      const ids = [...new Set(itemIds)];
      if (ids.length === 0 || (delta.x === 0 && delta.y === 0)) return;
      const currentMap = docRef.current?.map;
      if (!currentMap || !canEditMapSelectableItems(currentMap, ids)) {
        setError("选区包含隐藏、锁定或不存在的对象，无法批量移动。");
        return;
      }
      mutateDoc((map) => moveMapSelectableItems(map, ids, delta));
    },
    [mutateDoc],
  );

  const createMapObjectGroup = useCallback(
    (itemIds: readonly string[]) => {
      const currentMap = docRef.current?.map;
      if (!currentMap) return;
      const ids = expandMapSelectableItemIds(currentMap, itemIds);
      if (ids.length < 2) {
        setError("至少选择两个地图对象后才能组合。");
        return;
      }
      if (!canEditMapSelectableItems(currentMap, ids)) {
        setError("组合包含隐藏、锁定或不存在的对象，无法组合。");
        return;
      }
      const groupId = newMapObjectGroupId();
      mutateDoc((map) =>
        createMapSelectableGroup(map, {
          id: groupId,
          name: "组合",
          itemIds: ids,
        }),
      );
      updateMapSelection(ids, ids.at(-1) ?? null);
      chooseTool("select");
      setError(null);
    },
    [chooseTool, mutateDoc, updateMapSelection],
  );

  const ungroupMapObject = useCallback(
    (groupId: string) => {
      const currentMap = docRef.current?.map;
      const group = currentMap?.groups?.find(
        (candidate) => candidate.id === groupId,
      );
      if (!currentMap || !group) return;
      mutateDoc((map) => ungroupMapSelectableItems(map, groupId));
      updateMapSelection(group.itemIds, group.itemIds.at(-1) ?? null);
      setError(null);
    },
    [mutateDoc, updateMapSelection],
  );

  const removeSelectableMapItems = useCallback(
    (itemIds: readonly string[]) => {
      const ids = [...new Set(itemIds)];
      if (ids.length === 0) return false;
      const currentMap = docRef.current?.map;
      if (!currentMap || !canEditMapSelectableItems(currentMap, ids)) {
        setError("选区包含隐藏、锁定或不存在的对象，无法批量删除。");
        return false;
      }
      const topologyNodeIds = ids.filter((id) =>
        currentMap.features.some(
          (feature) => feature.id === id && feature.kind === "node",
        ),
      );
      if (
        mapRendererForProjection(currentMap.projectionType) === "topology" &&
        topologyNodeIds.length > 0 &&
        !canEditTopologyNodes(currentMap, topologyNodeIds)
      ) {
        setError("选区包含锁定、隐藏或不存在的拓扑节点，无法删除。");
        return false;
      }
      const nextMap =
        mapRendererForProjection(currentMap.projectionType) === "topology"
          ? removeTopologyFeatures(currentMap, ids)
          : removeMapSelectableItems(currentMap, ids);
      if (nextMap === currentMap) {
        setError("选区包含锁定通道的拓扑节点，解锁关联节点后才能删除。");
        return false;
      }
      mutateDoc(() => nextMap);
      updateMapSelection([], null);
      return true;
    },
    [mutateDoc, updateMapSelection],
  );

  // React Flow 删除节点时可能随后再次发出关联边的删除事件。过滤掉已经
  // 由节点级联删除的事实，避免第二个事件被误报为“对象不存在”。
  const removeTopologyCanvasItems = useCallback(
    (itemIds: readonly string[]) => {
      const currentMap = docRef.current?.map;
      if (!currentMap) return;
      const existingIds = itemIds.filter((id) =>
        currentMap.features.some((feature) => feature.id === id),
      );
      if (existingIds.length > 0) removeSelectableMapItems(existingIds);
    },
    [removeSelectableMapItems],
  );

  const updateCanvas = useCallback(
    (patch: Partial<MapDocument["canvas"]>) => {
      mutateDoc((map) => ({ ...map, canvas: { ...map.canvas, ...patch } }));
    },
    [mutateDoc],
  );

  const updateBackgroundPlacement = useCallback(
    (
      patch: Partial<
        NonNullable<MapDocument["canvas"]["backgroundImagePlacement"]>
      >,
    ) => {
      const currentMap = docRef.current?.map;
      if (!currentMap) return;
      const canvas = currentMap.canvas;
      const width = canvas.backgroundImageWidth;
      const height = canvas.backgroundImageHeight;
      const placement =
        canvas.backgroundImagePlacement ??
        (typeof width === "number" && typeof height === "number"
          ? getMapBackgroundImagePlacement(canvas, width, height)
          : null);
      if (!placement) return;
      updateCanvas({
        backgroundImagePlacement: {
          ...placement,
          source: "author",
          ...patch,
        },
      });
    },
    [updateCanvas],
  );

  const importBackground = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      const mimeType = mapProjectArtworkMimeType(file);
      if (!mimeType) {
        setError("底图仅支持 PNG、JPG 和 WebP。");
        return;
      }
      if (file.size <= 0 || file.size > MAP_PROJECT_ARTWORK_MAX_BYTES) {
        setError("底图文件不能超过 12 MB。");
        return;
      }
      const current = docRef.current;
      if (!current) return;
      const extension =
        mimeType === "image/png"
          ? "png"
          : mimeType === "image/jpeg"
            ? "jpg"
            : "webp";
      const path = `world/maps/assets/${current.map.id}/background/background-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}.${extension}`;
      try {
        const [content, dimensions] = await Promise.all([
          file.arrayBuffer(),
          imageDimensions(file),
        ]);
        await storage.createBinary(path, content, { createParents: true });
        if (docRef.current?.map.id !== current.map.id) {
          await storage.remove(path, { permanent: true });
          throw new Error("当前地图已切换，未写入底图");
        }
        // 底图是地图内容而非 CSS 外观。初次导入便用其真实像素尺寸建立
        // 世界坐标矩形，并预留四边继续创作的空间；之后自动延展不会把
        // 底图重新缩放到新的导出尺寸。
        const width = Math.max(
          current.map.canvas.width,
          dimensions.width + MAP_CANVAS_CONTENT_PADDING * 2,
        );
        const height = Math.max(
          current.map.canvas.height,
          dimensions.height + MAP_CANVAS_CONTENT_PADDING * 2,
        );
        updateCanvas({
          width,
          height,
          backgroundAssetPath: path,
          backgroundImage: mapProjectArtworkDataUrl(mimeType, content),
          backgroundImageWidth: dimensions.width,
          backgroundImageHeight: dimensions.height,
          backgroundImagePlacement: {
            x: (width - dimensions.width) / 2,
            y: (height - dimensions.height) / 2,
            width: dimensions.width,
            height: dimensions.height,
          },
        });
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [storage, updateCanvas],
  );

  const removeFeature = useCallback(
    (featureId: string) => {
      const currentMap = docRef.current?.map;
      const feature = currentMap?.features.find(
        (item) => item.id === featureId,
      );
      const layer = currentMap?.layers.find(
        (item) => item.id === feature?.layerId,
      );
      if (!isEditableMapLayer(layer)) {
        setError("当前绘图层已隐藏或锁定。无法删除地图要素。");
        return;
      }
      if (
        feature?.kind === "node" &&
        !canEditTopologyNodes(currentMap!, [featureId])
      ) {
        setError("当前拓扑节点已锁定，无法删除。");
        return;
      }
      const nextMap =
        mapRendererForProjection(currentMap!.projectionType) === "topology"
          ? removeTopologyFeature(currentMap!, featureId)
          : {
              ...currentMap!,
              features: currentMap!.features.filter(
                (candidate) => candidate.id !== featureId,
              ),
            };
      if (nextMap === currentMap) {
        setError("该拓扑要素关联锁定通道，解锁关联节点后才能删除。");
        return;
      }
      mutateDoc(() => nextMap);
      setSelectedFeatureId(null);
    },
    [mutateDoc],
  );

  const updateLayer = useCallback(
    (layerId: string, patch: Partial<MapDocument["layers"][number]>) => {
      mutateDoc((map) => ({
        ...map,
        layers: map.layers.map((layer) =>
          layer.id === layerId ? { ...layer, ...patch } : layer,
        ),
      }));
    },
    [mutateDoc],
  );

  const addLayer = useCallback(() => {
    const id = `layer-${Date.now().toString(36)}`;
    mutateDoc((map) => ({
      ...map,
      layers: [
        ...map.layers,
        {
          id,
          name: `图层 ${map.layers.length + 1}`,
          visible: true,
          locked: false,
          opacity: 1,
        },
      ],
    }));
    setActiveLayerId(id);
  }, [mutateDoc]);

  const updateSceneLayer = useCallback(
    (
      layerId: string,
      patch: Partial<
        Pick<MapSceneLayer, "name" | "visible" | "locked" | "opacity">
      >,
    ) => {
      mutateDoc((map) => {
        const scene = map.scene ?? createEmptyMapScene();
        return {
          ...map,
          scene: {
            ...scene,
            layers: scene.layers.map((layer) =>
              layer.id === layerId ? { ...layer, ...patch } : layer,
            ),
          },
        };
      });
    },
    [mutateDoc],
  );

  const moveSceneLayer = useCallback(
    (layerId: string, direction: -1 | 1) => {
      mutateDoc((map) => ({
        ...map,
        scene: moveMapSceneLayer(
          map.scene ?? createEmptyMapScene(),
          layerId,
          direction,
        ),
      }));
    },
    [mutateDoc],
  );

  const removeSceneLayer = useCallback(
    (layerId: string) => {
      const scene = doc?.map.scene ?? createEmptyMapScene();
      const layer = scene.layers.find((item) => item.id === layerId);
      if (!layer) return;
      if (layer.id === "scene-terrain" || layer.id === "scene-water") {
        setError("海陆基础层不能删除。");
        return;
      }
      const hasContent = layer.regions.length > 0 || layer.strokes.length > 0;
      if (hasContent && !layer.id.startsWith("scene-generator-")) {
        setError("当前绘图层仍包含内容，请先移动或删除区域和笔触。");
        return;
      }
      mutateDoc((map) => ({
        ...map,
        scene: removeMapSceneLayer(map.scene ?? createEmptyMapScene(), layerId),
      }));
      if (activeSceneLayerId === layerId) {
        setActiveSceneLayerId(
          scene.layers.find((item) => item.id !== layerId)?.id ??
            "scene-terrain",
        );
      }
    },
    [activeSceneLayerId, doc, mutateDoc],
  );

  const updateTerrainStyle = useCallback(
    (patch: Partial<MapTerrainStyle>) => {
      mutateDoc((map) => ({
        ...map,
        scene: updateMapTerrainStyle(map.scene ?? createEmptyMapScene(), patch),
      }));
    },
    [mutateDoc],
  );

  const removeLayer = useCallback(
    (layerId: string) => {
      if (!doc || doc.map.layers.length <= 1) {
        setError("地图至少需要保留一个图层。");
        return;
      }
      if (doc.map.features.some((feature) => feature.layerId === layerId)) {
        setError("当前图层仍包含地图要素，请先移动或删除这些要素。");
        return;
      }
      mutateDoc((map) => ({
        ...map,
        layers: map.layers.filter((layer) => layer.id !== layerId),
      }));
      setActiveLayerId(
        doc.map.layers.find((layer) => layer.id !== layerId)?.id ??
          "layer-main",
      );
    },
    [doc, mutateDoc],
  );

  const moveLayer = useCallback(
    (layerId: string, direction: -1 | 1) => {
      mutateDoc((map) => {
        const index = map.layers.findIndex((layer) => layer.id === layerId);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= map.layers.length) return map;
        const layers = [...map.layers];
        [layers[index], layers[target]] = [layers[target], layers[index]];
        return { ...map, layers };
      });
    },
    [mutateDoc],
  );

  const updateArtworkLayer = useCallback(
    (
      layerId: string,
      patch: Partial<
        Pick<
          MapArtworkLayer,
          "name" | "kind" | "visible" | "locked" | "opacity"
        >
      >,
    ) => {
      mutateDoc((map) => ({
        ...map,
        artwork: updateMapArtworkLayer(map.artwork, layerId, patch),
      }));
    },
    [mutateDoc],
  );

  const addArtworkLayer = useCallback(() => {
    const id = `artwork-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    mutateDoc((map) => ({
      ...map,
      artwork: addMapArtworkLayer(
        map.artwork,
        createMapArtworkLayer({
          id,
          name: `素材层 ${map.artwork.layers.length + 1}`,
        }),
      ),
    }));
    setActiveArtworkLayerId(id);
  }, [mutateDoc]);

  const moveArtworkLayer = useCallback(
    (layerId: string, direction: -1 | 1) => {
      mutateDoc((map) => ({
        ...map,
        artwork: moveMapArtworkLayer(map.artwork, layerId, direction),
      }));
    },
    [mutateDoc],
  );

  const deleteArtworkLayer = useCallback(
    (layerId: string, targetLayerId: string) => {
      mutateDoc((map) => ({
        ...map,
        artwork: removeMapArtworkLayer(map.artwork, layerId, targetLayerId),
      }));
      setActiveArtworkLayerId(targetLayerId);
      setError(null);
    },
    [mutateDoc],
  );

  const requestRemoveArtworkLayer = useCallback(
    (layerId: string) => {
      if (!doc || doc.map.artwork.layers.length <= 1) {
        setError("地图至少需要保留一个素材图层。");
        return;
      }
      const index = doc.map.artwork.layers.findIndex(
        (layer) => layer.id === layerId,
      );
      const layer = doc.map.artwork.layers[index];
      const targetLayer =
        doc.map.artwork.layers[index + 1] ?? doc.map.artwork.layers[index - 1];
      if (!layer || !targetLayer) return;
      if (layer.stamps.length > 0) {
        setDeleteArtworkLayerTarget({
          layerId: layer.id,
          targetLayerId: targetLayer.id,
        });
        return;
      }
      deleteArtworkLayer(layer.id, targetLayer.id);
    },
    [deleteArtworkLayer, doc],
  );

  const moveArtworkStampToArtworkLayer = useCallback(
    (stampId: string, targetLayerId: string) => {
      if (!doc) return;
      const sourceLayer = doc.map.artwork.layers.find((layer) =>
        layer.stamps.some((stamp) => stamp.id === stampId),
      );
      const targetLayer = findMapArtworkLayer(doc.map.artwork, targetLayerId);
      if (
        !sourceLayer?.visible ||
        sourceLayer.locked ||
        !targetLayer?.visible ||
        targetLayer.locked
      ) {
        setError("隐藏或锁定的素材图层不能移动印章。");
        return;
      }
      mutateDoc((map) => ({
        ...map,
        artwork: moveMapArtworkStampToLayer(
          map.artwork,
          stampId,
          targetLayerId,
        ),
      }));
      setActiveArtworkLayerId(targetLayerId);
      setError(null);
    },
    [doc, mutateDoc],
  );

  const selectedFeature = doc?.map.features.find(
    (feature) => feature.id === selectedFeatureId,
  );
  const selectedRiverStyle =
    selectedFeature && isMapRiverFeature(selectedFeature)
      ? getMapRiverStyle(selectedFeature)
      : null;
  const selectedRouteStyle = selectedFeature
    ? getMapRouteStyle(selectedFeature)
    : null;
  const selectedAreaStyle =
    selectedFeature && isMapFeatureFreeformArea(selectedFeature.kind)
      ? getMapFeatureAreaStyle(selectedFeature)
      : null;
  /** 自由画笔只有首尾闭合后才具备“区域”语义；普通画笔区域与历史区域视为已闭合。 */
  const selectedFreehandAreaClosed = Boolean(
    selectedFeature &&
      (!isMapFeatureFreeformArea(selectedFeature.kind) ||
        selectedFeature.props.freehand !== "true" ||
        selectedFeature.props.closed === "true"),
  );
  const selectedLabelStyle =
    selectedFeature && mapFeatureHasLabel(selectedFeature)
      ? getMapLabelStyle(selectedFeature)
      : null;
  const selectedTopologyNode =
    doc &&
    mapRendererForProjection(doc.map.projectionType) === "topology" &&
    selectedFeature?.kind === "node"
      ? {
          kind: getTopologyNodeKind(selectedFeature),
          showLabel: selectedFeature.props.showLabel !== "false",
          status: getTopologyNodeStatus(selectedFeature),
          locked: getTopologyNodeLocked(selectedFeature),
          linkedMapId: getTopologyNodeLinkedMapId(selectedFeature),
          entityRef: selectedFeature.entityRef,
          settingRef:
            selectedFeature.entityRef?.kind === "setting"
              ? selectedFeature.entityRef
              : null,
          ...getTopologyNodeConnections(
            doc.map,
            selectedFeature.id,
            timelineCursor,
          ),
          ancestorPath: getTopologyNodeAncestors(
            doc.map,
            selectedFeature.id,
            timelineCursor,
          )
            .map(
              (ancestorId) =>
                doc.map.features.find((feature) => feature.id === ancestorId)
                  ?.name ?? ancestorId,
            )
            .join(" / "),
        }
      : null;
  const selectedTopologyRoute =
    doc &&
    mapRendererForProjection(doc.map.projectionType) === "topology" &&
    selectedFeature?.kind === "route"
      ? {
          relation: getTopologyRouteRelation(selectedFeature),
          direction: getTopologyRouteDirection(selectedFeature),
          showLabel: selectedFeature.props.showLabel !== "false",
          sourceNodeId: selectedFeature.props.sourceNodeId ?? "",
          targetNodeId: selectedFeature.props.targetNodeId ?? "",
        }
      : null;
  const selectedTopologyNodeRoutes =
    selectedTopologyNode && selectedFeature
      ? selectedTopologyNode.routes.map(({ route, direction }) => {
          const sourceId = route.props.sourceNodeId;
          const targetId = route.props.targetNodeId;
          const source = doc!.map.features.find(
            (feature) => feature.id === sourceId && feature.kind === "node",
          );
          const target = doc!.map.features.find(
            (feature) => feature.id === targetId && feature.kind === "node",
          );
          return {
            route,
            sourceName: source?.name ?? "缺失节点",
            targetName: target?.name ?? "缺失节点",
            direction,
          } as const;
        })
      : [];
  const selectedTopologyLinkedMap = selectedTopologyNode?.linkedMapId
    ? maps.find((map) => map.id === selectedTopologyNode.linkedMapId)
    : undefined;
  const selectedTopologySetting = selectedTopologyNode?.settingRef
    ? topologySettingById.get(selectedTopologyNode.settingRef.id)
    : undefined;
  const selectedTopologyEntity = selectedTopologyNode?.entityRef
    ? entityOptions.find(
        (entity) =>
          entity.kind === selectedTopologyNode.entityRef?.kind &&
          entity.id === selectedTopologyNode.entityRef?.id,
      )
    : undefined;
  const topologyNodeOptions = (doc?.map.features ?? [])
    .filter((feature) => feature.kind === "node")
    .map((feature) => ({ value: feature.id, label: feature.name }));
  const topologySettingSelectOptions = topologySettingOptions.map(
    (setting) => ({
      value: `setting:${setting.id}`,
      label: setting.label,
    }),
  );
  const topologyEntitySelectOptions = entityOptions
    .filter((entity) => entity.kind !== "setting")
    .map((entity) => ({
      value: `${entity.kind}:${entity.id}`,
      label: `${entity.name}（${DOMAIN_ENTITY_KIND_LABELS[entity.kind]}）`,
    }));
  const topologyImportSelectOptions = topologySettingOptions.map((setting) => ({
    value: setting.id,
    label: setting.label,
  }));
  const selectedArtworkStamp = doc
    ? findMapArtworkStamp(doc.map.artwork, selectedFeatureId ?? "")
    : undefined;
  const selectedArtworkLayer =
    doc && selectedArtworkStamp
      ? findMapArtworkLayer(doc.map.artwork, selectedArtworkStamp.layerId)
      : undefined;
  const selectedArtworkAsset = selectedArtworkStamp
    ? artworkCatalog?.get(selectedArtworkStamp.assetId)
    : undefined;
  const selectedArtworkVariant =
    selectedArtworkStamp && selectedArtworkAsset
      ? getMapArtworkAssetVariant(
          selectedArtworkAsset,
          selectedArtworkStamp.variant,
        )
      : undefined;
  const selectedSceneStroke = doc?.map.scene?.layers
    .flatMap((layer) => layer.strokes)
    .find((stroke) => stroke.id === selectedFeatureId);
  const selectedSceneRegion = doc?.map.scene?.layers
    .flatMap((layer) => layer.regions)
    .find((region) => region.id === selectedFeatureId);
  const selectedSceneLayer = selectedSceneStroke
    ? doc?.map.scene?.layers.find(
        (layer) => layer.id === selectedSceneStroke.layerId,
      )
    : selectedSceneRegion
      ? doc?.map.scene?.layers.find(
          (layer) => layer.id === selectedSceneRegion.layerId,
        )
      : undefined;
  useEffect(() => {
    if (selectedSceneLayer) setActiveSceneLayerId(selectedSceneLayer.id);
  }, [selectedSceneLayer]);
  const selectedSceneStrokeIsTerrainShape = Boolean(
    selectedSceneStroke &&
      selectedSceneStroke.brushAssetId === null &&
      selectedSceneStroke.terrainMaterial === null &&
      (selectedSceneLayer?.kind === "terrain" ||
        selectedSceneStroke.tool === "erase"),
  );
  const selectedSceneStrokeIsArtworkBrush = Boolean(
    selectedSceneStroke?.brushAssetId,
  );
  const selectedSceneStrokeMaterial = selectedSceneStroke?.terrainMaterial
    ? getMapTerrainMaterialPreset(selectedSceneStroke.terrainMaterial)
    : null;

  const removeSelectedItem = useCallback(() => {
    if (!selectedFeatureId) return;
    if (selectedFeatureIds.length > 1) {
      removeSelectableMapItems(selectedFeatureIds);
      return;
    }
    if (selectedFeature) {
      removeFeature(selectedFeature.id);
      return;
    }
    if (selectedArtworkStamp) {
      removeArtworkStamp(selectedArtworkStamp.id);
      return;
    }
    if (selectedSceneRegion) {
      removeSceneRegion(selectedSceneRegion.id);
      return;
    }
    if (selectedSceneStroke) {
      removeSceneStroke(selectedSceneStroke.id);
    }
  }, [
    removeArtworkStamp,
    removeFeature,
    removeSelectableMapItems,
    removeSceneRegion,
    removeSceneStroke,
    selectedArtworkStamp,
    selectedFeature,
    selectedFeatureId,
    selectedFeatureIds,
    selectedSceneRegion,
    selectedSceneStroke,
  ]);

  useEffect(() => {
    if (!isActive || tab !== "maps") return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.closest("input, textarea, select, [contenteditable='true']") ||
          target.closest(".react-flow"))
      ) {
        return;
      }
      if (
        selectedFeatureId &&
        !event.ctrlKey &&
        !event.metaKey &&
        (event.key === "Delete" || event.key === "Backspace")
      ) {
        event.preventDefault();
        removeSelectedItem();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isActive, removeSelectedItem, selectedFeatureId, tab]);

  const activeArtworkBrushAsset = artworkBrushAssetId
    ? artworkCatalog?.get(artworkBrushAssetId)
    : undefined;
  const activeArtworkBrushColor = activeArtworkBrushAsset?.component
    ? (artworkBrushColor ?? activeArtworkBrushAsset.color)
    : null;
  const activeTopologyLinkedMap = maps.find(
    (map) => map.id === activeTopologyLinkedMapId && map.id !== doc?.map.id,
  );
  const activeTopologyNodeOption = getTopologyNodeKindOption(
    activeTopologyNodeKind,
  );
  const activeTopologyEntity = activeTopologyEntityRef
    ? entityOptions.find(
        (entity) =>
          entity.kind === activeTopologyEntityRef.kind &&
          entity.id === activeTopologyEntityRef.id,
      )
    : undefined;
  const activeTopologySetting =
    activeTopologyEntityRef?.kind === "setting"
      ? topologySettingById.get(activeTopologyEntityRef.id)
      : undefined;
  const topologyNodeTemplate = {
    kind: activeTopologyNodeKind,
    status: activeTopologyNodeStatus,
    name:
      activeTopologyNodeName.trim() ||
      (activeTopologyLinkedMap?.name ??
        activeTopologySetting?.name ??
        activeTopologyEntity?.name ??
        activeTopologyNodeOption.defaultName),
    color: activeTopologyNodeOption.color,
    linkedMapId: activeTopologyLinkedMap?.id ?? null,
    entityRef: activeTopologyEntityRef,
  } as const;
  const topologyRouteTemplate = {
    relation: activeTopologyRouteRelation,
    direction: activeTopologyRouteDirection,
  } as const;
  const selectTopologyNodePreset = useCallback(
    (kind: TopologyNodeKind) => {
      const kindChanged = kind !== activeTopologyNodeKind;
      setActiveTopologyNodeKind(kind);
      // 同类型预设只是切回放置工具，必须保留作者刚刚配置的名称、关联
      // 地图和世界架构；这与将同一预设拖入画布的行为保持一致。只有
      // 节点类型实际变化时才清除不再匹配的关联模板。
      if (kindChanged) {
        setActiveTopologyNodeName("");
        setActiveTopologyLinkedMapId(null);
        setActiveTopologyEntityRef(null);
      }
      chooseTool("node");
    },
    [activeTopologyNodeKind, chooseTool],
  );
  const selectTopologyRoutePreset = useCallback(
    (relation: TopologyRouteRelation, direction: TopologyRouteDirection) => {
      setActiveTopologyRouteRelation(relation);
      setActiveTopologyRouteDirection(direction);
      chooseTool("route");
    },
    [chooseTool],
  );
  const rendererKind = doc
    ? mapRendererForProjection(doc.map.projectionType)
    : null;
  const topologySummary =
    doc && rendererKind === "topology"
      ? getTopologySummary(doc.map, timelineCursor)
      : null;
  const sceneLayers = doc
    ? (doc.map.scene ?? createEmptyMapScene()).layers
    : [];
  const terrainStyle = doc
    ? (doc.map.scene ?? createEmptyMapScene()).terrainStyle
    : null;
  const activeSceneLayer = sceneLayers.find(
    (layer) => layer.id === activeSceneLayerId,
  );
  const canPaintScene = sceneLayers.some(
    (layer) => layer.visible && !layer.locked,
  );
  const canEraseSceneLayer = Boolean(
    activeSceneLayer?.visible && !activeSceneLayer.locked,
  );
  const canDrawFeature = Boolean(
    doc?.map.layers.find((layer) => layer.id === activeLayerId)?.visible &&
      !doc?.map.layers.find((layer) => layer.id === activeLayerId)?.locked,
  );
  const canDrawLand = Boolean(
    sceneLayers.find((layer) => layer.id === "scene-terrain")?.visible &&
      !sceneLayers.find((layer) => layer.id === "scene-terrain")?.locked,
  );
  const canDrawWater = Boolean(
    sceneLayers.find((layer) => layer.id === "scene-terrain")?.visible &&
      !sceneLayers.find((layer) => layer.id === "scene-terrain")?.locked,
  );
  const canPaintWaterMaterial = Boolean(
    sceneLayers.find((layer) => layer.id === "scene-water")?.visible &&
      !sceneLayers.find((layer) => layer.id === "scene-water")?.locked,
  );
  const canPaintTerrainMaterial = Boolean(
    doc &&
      ((canDrawLand &&
        mapSceneHasLandSurface(doc.map.scene ?? createEmptyMapScene())) ||
        (canPaintWaterMaterial &&
          mapSceneHasWaterSurface(doc.map.scene ?? createEmptyMapScene()))),
  );
  const terrainMaterialAvailability = {
    land: Boolean(
      canDrawLand &&
        doc &&
        mapSceneHasLandSurface(doc.map.scene ?? createEmptyMapScene()),
    ),
    water: Boolean(
      canPaintWaterMaterial &&
        doc &&
        mapSceneHasWaterSurface(doc.map.scene ?? createEmptyMapScene()),
    ),
  } as const;
  const visibleFeatureKinds: readonly Exclude<MapFeatureKind, "polygon">[] =
    rendererKind === "topology"
      ? ["node", "route"]
      : (["marker", "label", "route"] as const);
  const selectedTopologyNodeIds = useMemo(
    () =>
      rendererKind === "topology" && doc
        ? selectedFeatureIds.filter((featureId) =>
            doc.map.features.some(
              (feature) => feature.id === featureId && feature.kind === "node",
            ),
          )
        : [],
    [doc, rendererKind, selectedFeatureIds],
  );
  const listedFeatures = useMemo(() => {
    if (!doc) return [];
    const query = featureQuery.trim().toLocaleLowerCase("zh-CN");
    if (!query) {
      return doc.map.features.filter(
        (feature) => feature.layerId === activeLayerId,
      );
    }
    return doc.map.features.filter((feature) => {
      const layerName =
        doc.map.layers.find((layer) => layer.id === feature.layerId)?.name ??
        "";
      return [
        feature.name,
        feature.description,
        layerName,
        FEATURE_KIND_LABELS[feature.kind],
        ...Object.values(feature.props),
      ]
        .join(" ")
        .toLocaleLowerCase("zh-CN")
        .includes(query);
    });
  }, [activeLayerId, doc, featureQuery]);

  const applyGeneratedCandidate = useCallback(
    (candidate: MapGeneratorCandidate) => {
      mutateDoc((map) => applyGeneratorCandidate(map, candidate));
      setGeneratorOpen(false);
      setSelectedFeatureId(null);
      chooseTool("select");
      // 生成结果的范围通常小于自动延展后的世界画布；进入成图视角，避免
      // 作者先看到一整片空海域而误以为生成失败。
      setFocusRequest((request) => request + 1);
    },
    [chooseTool, mutateDoc],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
      <NarrativeUnsavedChangesGuard
        dirty={isDirty}
        label="地图"
        registerNavigationGuard={
          registerNavigationGuard ?? (() => () => undefined)
        }
        onSave={save}
      />
      <input
        ref={projectArtworkInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        multiple
        className="hidden"
        aria-label="导入项目地图素材"
        onChange={handleProjectArtworkInput}
      />
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--line)] px-5">
        <MapIcon className="h-4 w-4 text-[var(--accent-warm)]" />
        <h1 className="text-sm font-semibold">世界地图</h1>
        <span className="text-xs text-[var(--ink-muted)]">{projectTitle}</span>
        <div className="ml-4 flex h-8 items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] p-1">
          <button
            type="button"
            onClick={() => setTab("maps")}
            className={`h-6 rounded px-2 text-xs ${tab === "maps" ? "bg-[var(--accent-warm)] text-white" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
          >
            地图编辑
          </button>
          <button
            type="button"
            onClick={() => setTab("tree")}
            className={`h-6 rounded px-2 text-xs ${tab === "tree" ? "bg-[var(--accent-warm)] text-white" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
          >
            空间节点树
          </button>
        </div>
        {tab === "maps" && doc && (
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={undo}
              disabled={history.length === 0}
              title="撤销（Ctrl+Z）"
              className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] disabled:opacity-35"
            >
              <Undo2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={future.length === 0}
              title="重做（Ctrl+Shift+Z / Ctrl+Y）"
              className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] disabled:opacity-35"
            >
              <Redo2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setProposalReviewOpen(true)}
              title="审阅 AI 提交的地图提案"
              className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            >
              <GitCompareArrows className="h-4 w-4" />
              <span className="max-lg:hidden">审阅提案</span>
            </button>
            {rendererKind === "geographic" && (
              <button
                type="button"
                onClick={() => setGeneratorOpen(true)}
                title="让 Agent 读取世界设定并调用 Azgaar，或使用手工导入和离线草图"
                className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              >
                <Sparkles className="h-4 w-4" />
                <span className="max-xl:hidden">生成地图</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !isDirty}
              title="保存地图（Ctrl+S）"
              className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-3 text-sm font-medium text-white hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {isDirty ? "保存" : "已保存"}
            </button>
          </div>
        )}
      </div>
      {error && (
        <div className="shrink-0 border-b border-[var(--line-subtle)] bg-[var(--error-bg)] px-5 py-2 text-sm text-[var(--error)]">
          {error}
        </div>
      )}

      {tab === "tree" ? (
        <WorldMapPrototype
          storage={storage}
          projectTitle={projectTitle}
          isActive={isActive}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-52 shrink-0 flex-col border-r border-[var(--line-subtle)]">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--line-subtle)] px-3">
              <span className="text-xs font-medium text-[var(--ink-muted)]">
                地图库
              </span>
              <button
                type="button"
                onClick={beginMapCreation}
                title="新建地图"
                className="flex h-6 w-6 items-center justify-center rounded text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {maps.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-[var(--ink-muted)]">
                  暂无地图，点击右上角新建
                </p>
              )}
              {maps.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => void openMap(entry.id)}
                  className={`mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm ${
                    selectedMapId === entry.id
                      ? "bg-[var(--accent-warm-subtle)]"
                      : "hover:bg-[var(--hover-bg)]"
                  }`}
                >
                  <MapIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <span
                    role="button"
                    title="删除地图"
                    onClick={(event) => {
                      event.stopPropagation();
                      setDeleteMapTarget(entry.id);
                    }}
                    className="shrink-0 rounded p-1 text-[var(--ink-subtle)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                  >
                    <Trash2 className="h-3 w-3" />
                  </span>
                </button>
              ))}
            </div>
            {doc && (
              <>
                <div className="flex h-9 shrink-0 items-center justify-between border-t border-[var(--line-subtle)] px-3 text-xs text-[var(--ink-muted)]">
                  <span className="flex items-center">
                    <Layers3 className="mr-1.5 h-3.5 w-3.5" /> 图层
                  </span>
                  <button
                    type="button"
                    title="新建图层"
                    onClick={addLayer}
                    className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--hover-bg)]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="max-h-56 shrink-0 overflow-y-auto border-t border-[var(--line-subtle)] p-2">
                  {doc.map.layers.map((layer) => (
                    <div
                      key={layer.id}
                      onClick={() => setActiveLayerId(layer.id)}
                      className={`mb-1 rounded-md border px-2 py-1.5 text-xs ${activeLayerId === layer.id ? "border-[var(--accent-warm)] bg-[var(--accent-warm-subtle)]" : "border-transparent hover:bg-[var(--hover-bg)]"}`}
                    >
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          title={layer.visible ? "隐藏图层" : "显示图层"}
                          onClick={(event) => {
                            event.stopPropagation();
                            updateLayer(layer.id, { visible: !layer.visible });
                          }}
                          className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)]"
                        >
                          {layer.visible ? (
                            <Eye className="h-3.5 w-3.5" />
                          ) : (
                            <EyeOff className="h-3.5 w-3.5" />
                          )}
                        </button>
                        <input
                          value={layer.name}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            updateLayer(layer.id, { name: event.target.value })
                          }
                          className="min-w-0 flex-1 bg-transparent outline-none"
                          aria-label={`图层名称：${layer.name}`}
                        />
                        <button
                          type="button"
                          title={layer.locked ? "解锁图层" : "锁定图层"}
                          onClick={(event) => {
                            event.stopPropagation();
                            updateLayer(layer.id, { locked: !layer.locked });
                          }}
                          className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)]"
                        >
                          {layer.locked ? (
                            <Lock className="h-3.5 w-3.5" />
                          ) : (
                            <Unlock className="h-3.5 w-3.5" />
                          )}
                        </button>
                        <button
                          type="button"
                          title="上移图层"
                          aria-label={`上移图层：${layer.name}`}
                          disabled={doc.map.layers.indexOf(layer) === 0}
                          onClick={(event) => {
                            event.stopPropagation();
                            moveLayer(layer.id, -1);
                          }}
                          className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)] disabled:opacity-30"
                        >
                          <ArrowUp className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          title="下移图层"
                          aria-label={`下移图层：${layer.name}`}
                          disabled={
                            doc.map.layers.indexOf(layer) ===
                            doc.map.layers.length - 1
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            moveLayer(layer.id, 1);
                          }}
                          className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)] disabled:opacity-30"
                        >
                          <ArrowDown className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          title="删除图层"
                          onClick={(event) => {
                            event.stopPropagation();
                            removeLayer(layer.id);
                          }}
                          className="rounded p-1 text-[var(--ink-subtle)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {activeLayerId === layer.id && (
                        <label className="mt-1.5 flex items-center gap-2 px-1 text-xs text-[var(--ink-muted)]">
                          透明度
                          <input
                            type="range"
                            min={0.1}
                            max={1}
                            step={0.1}
                            value={layer.opacity}
                            onChange={(event) =>
                              updateLayer(layer.id, {
                                opacity: Number(event.target.value),
                              })
                            }
                            className="min-w-0 flex-1"
                          />
                          {Math.round(layer.opacity * 100)}%
                        </label>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex h-9 shrink-0 items-center justify-between border-t border-[var(--line-subtle)] px-3 text-xs text-[var(--ink-muted)]">
                  <span className="flex items-center">
                    <Layers3 className="mr-1.5 h-3.5 w-3.5" /> 素材图层
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="text-[var(--ink-subtle)]">
                      {doc.map.artwork.layers.reduce(
                        (count, layer) => count + layer.stamps.length,
                        0,
                      )}
                    </span>
                    <button
                      type="button"
                      title="新建素材图层"
                      aria-label="新建素材图层"
                      onClick={addArtworkLayer}
                      className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--hover-bg)]"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
                <div className="max-h-56 shrink-0 overflow-y-auto border-t border-[var(--line-subtle)] p-2">
                  {mapArtworkLayersInPanelOrder(doc.map.artwork).map(
                    (layer) => {
                      const layerIndex = doc.map.artwork.layers.indexOf(layer);
                      const isActiveArtworkLayer =
                        activeArtworkLayerId === layer.id;
                      const phase = mapArtworkLayerRenderPhase(layer.kind);
                      return (
                        <div
                          key={layer.id}
                          onClick={() => setActiveArtworkLayerId(layer.id)}
                          className={`mb-1 rounded-md border px-2 py-1.5 text-xs ${isActiveArtworkLayer ? "border-[var(--accent-warm)] bg-[var(--accent-warm-subtle)]" : "border-transparent hover:bg-[var(--hover-bg)]"}`}
                        >
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              title={
                                layer.visible ? "隐藏素材图层" : "显示素材图层"
                              }
                              aria-label={
                                (layer.visible ? "隐藏" : "显示") +
                                "素材图层：" +
                                layer.name
                              }
                              onClick={(event) => {
                                event.stopPropagation();
                                updateArtworkLayer(layer.id, {
                                  visible: !layer.visible,
                                });
                              }}
                              className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)]"
                            >
                              {layer.visible ? (
                                <Eye className="h-3.5 w-3.5" />
                              ) : (
                                <EyeOff className="h-3.5 w-3.5" />
                              )}
                            </button>
                            <input
                              value={layer.name}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) =>
                                updateArtworkLayer(layer.id, {
                                  name: event.target.value,
                                })
                              }
                              className="min-w-0 flex-1 bg-transparent outline-none"
                              aria-label={`素材图层名称：${layer.name}`}
                            />
                            <span
                              title={`合成阶段：${ARTWORK_RENDER_PHASE_LABELS[phase]}`}
                              className="shrink-0 text-xs text-[var(--ink-subtle)]"
                            >
                              {ARTWORK_RENDER_PHASE_LABELS[phase]}
                            </span>
                            <button
                              type="button"
                              title={
                                layer.locked ? "解锁素材图层" : "锁定素材图层"
                              }
                              aria-label={
                                (layer.locked ? "解锁" : "锁定") +
                                "素材图层：" +
                                layer.name
                              }
                              onClick={(event) => {
                                event.stopPropagation();
                                updateArtworkLayer(layer.id, {
                                  locked: !layer.locked,
                                });
                              }}
                              className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)]"
                            >
                              {layer.locked ? (
                                <Lock className="h-3.5 w-3.5" />
                              ) : (
                                <Unlock className="h-3.5 w-3.5" />
                              )}
                            </button>
                            <button
                              type="button"
                              title="上移素材图层"
                              aria-label={`上移素材图层：${layer.name}`}
                              disabled={
                                layerIndex === doc.map.artwork.layers.length - 1
                              }
                              onClick={(event) => {
                                event.stopPropagation();
                                moveArtworkLayer(layer.id, 1);
                              }}
                              className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)] disabled:opacity-30"
                            >
                              <ArrowUp className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              title="下移素材图层"
                              aria-label={`下移素材图层：${layer.name}`}
                              disabled={layerIndex === 0}
                              onClick={(event) => {
                                event.stopPropagation();
                                moveArtworkLayer(layer.id, -1);
                              }}
                              className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)] disabled:opacity-30"
                            >
                              <ArrowDown className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              title="删除素材图层"
                              aria-label={`删除素材图层：${layer.name}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                requestRemoveArtworkLayer(layer.id);
                              }}
                              className="rounded p-1 text-[var(--ink-subtle)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          {isActiveArtworkLayer && (
                            <div className="mt-1.5 space-y-1.5 px-1 text-xs text-[var(--ink-muted)]">
                              <CustomSelect
                                value={layer.kind}
                                options={Object.entries(
                                  ARTWORK_LAYER_KIND_LABELS,
                                ).map(([value, label]) => ({ value, label }))}
                                onChange={(kind) =>
                                  updateArtworkLayer(layer.id, {
                                    kind: kind as MapArtworkLayerKind,
                                  })
                                }
                                ariaLabel={`素材图层类型：${layer.name}`}
                                size="sm"
                              />
                              <label className="flex items-center gap-2">
                                透明度
                                <input
                                  type="range"
                                  min={0}
                                  max={1}
                                  step={0.05}
                                  value={layer.opacity}
                                  onChange={(event) =>
                                    updateArtworkLayer(layer.id, {
                                      opacity: Number(event.target.value),
                                    })
                                  }
                                  className="min-w-0 flex-1"
                                />
                                {Math.round(layer.opacity * 100)}%
                              </label>
                            </div>
                          )}
                        </div>
                      );
                    },
                  )}
                </div>
                <div className="flex h-9 shrink-0 items-center justify-between border-t border-[var(--line-subtle)] px-3 text-xs text-[var(--ink-muted)]">
                  <span className="flex items-center">
                    <Paintbrush className="mr-1.5 h-3.5 w-3.5" /> 绘图层
                  </span>
                  <span className="text-[var(--ink-subtle)]">
                    {sceneLayers.reduce(
                      (count, layer) => count + layer.regions.length,
                      0,
                    )}{" "}
                    区域 ·{" "}
                    {sceneLayers.reduce(
                      (count, layer) => count + layer.strokes.length,
                      0,
                    )}{" "}
                    笔触
                  </span>
                </div>
                <div className="max-h-64 shrink-0 overflow-y-auto border-t border-[var(--line-subtle)] p-2">
                  {[...sceneLayers].reverse().map((layer) => {
                    const sceneLayerIndex = sceneLayers.indexOf(layer);
                    const baseLayer =
                      layer.id === "scene-terrain" ||
                      layer.id === "scene-water";
                    const firstOverlayIndex = sceneLayers.findIndex(
                      (candidate) =>
                        candidate.id !== "scene-terrain" &&
                        candidate.id !== "scene-water",
                    );
                    return (
                      <div
                        key={layer.id}
                        className={`mb-1 rounded-md border px-2 py-1.5 text-xs ${activeSceneLayerId === layer.id ? "border-[var(--accent-warm)] bg-[var(--accent-warm-subtle)]" : "border-transparent hover:bg-[var(--hover-bg)]"}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            title={layer.visible ? "隐藏绘图层" : "显示绘图层"}
                            aria-label={
                              (layer.visible ? "隐藏" : "显示") +
                              "绘图层：" +
                              layer.name
                            }
                            onClick={() =>
                              updateSceneLayer(layer.id, {
                                visible: !layer.visible,
                              })
                            }
                            className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)]"
                          >
                            {layer.visible ? (
                              <Eye className="h-3.5 w-3.5" />
                            ) : (
                              <EyeOff className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            title={
                              activeSceneLayerId === layer.id
                                ? "当前绘图层"
                                : "设为当前绘图层"
                            }
                            aria-label={`选择绘图层：${layer.name}`}
                            aria-pressed={activeSceneLayerId === layer.id}
                            onClick={() => setActiveSceneLayerId(layer.id)}
                            className={`rounded p-1 hover:bg-[var(--paper-elevated)] ${activeSceneLayerId === layer.id ? "text-[var(--accent-warm)]" : "text-[var(--ink-subtle)]"}`}
                          >
                            {activeSceneLayerId === layer.id ? (
                              <Check className="h-3.5 w-3.5" />
                            ) : (
                              <CircleDashed className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <input
                            value={layer.name}
                            onChange={(event) =>
                              updateSceneLayer(layer.id, {
                                name: event.target.value,
                              })
                            }
                            className="min-w-0 flex-1 bg-transparent outline-none"
                            aria-label={"绘图层名称：" + layer.name}
                          />
                          <button
                            type="button"
                            title={layer.locked ? "解锁绘图层" : "锁定绘图层"}
                            aria-label={
                              (layer.locked ? "解锁" : "锁定") +
                              "绘图层：" +
                              layer.name
                            }
                            onClick={() =>
                              updateSceneLayer(layer.id, {
                                locked: !layer.locked,
                              })
                            }
                            className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)]"
                          >
                            {layer.locked ? (
                              <Lock className="h-3.5 w-3.5" />
                            ) : (
                              <Unlock className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            title="上移绘图层"
                            aria-label={`上移绘图层：${layer.name}`}
                            disabled={
                              baseLayer ||
                              sceneLayerIndex === sceneLayers.length - 1
                            }
                            onClick={() => moveSceneLayer(layer.id, 1)}
                            className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)] disabled:opacity-30"
                          >
                            <ArrowUp className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            title="下移绘图层"
                            aria-label={`下移绘图层：${layer.name}`}
                            disabled={
                              baseLayer || sceneLayerIndex === firstOverlayIndex
                            }
                            onClick={() => moveSceneLayer(layer.id, -1)}
                            className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)] disabled:opacity-30"
                          >
                            <ArrowDown className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            title="删除绘图层"
                            aria-label={`删除绘图层：${layer.name}`}
                            disabled={baseLayer}
                            onClick={() => removeSceneLayer(layer.id)}
                            className="rounded p-1 text-[var(--ink-subtle)] hover:bg-[var(--error-bg)] hover:text-[var(--error)] disabled:opacity-30"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <label className="mt-1.5 flex items-center gap-2 px-1 text-xs text-[var(--ink-muted)]">
                          透明度
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={layer.opacity}
                            onChange={(event) =>
                              updateSceneLayer(layer.id, {
                                opacity: Number(event.target.value),
                              })
                            }
                            className="min-w-0 flex-1"
                          />
                          {Math.round(layer.opacity * 100)}%
                        </label>
                      </div>
                    );
                  })}
                </div>
                <div className="flex h-9 shrink-0 items-center justify-between border-t border-[var(--line-subtle)] px-3 text-xs text-[var(--ink-muted)]">
                  <span>要素 · {doc.map.features.length}</span>
                  <span>{listedFeatures.length}</span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--line-subtle)] p-2">
                  <label className="mb-2 flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2 focus-within:border-[var(--accent-warm)]">
                    <Search className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
                    <input
                      value={featureQuery}
                      onChange={(event) => setFeatureQuery(event.target.value)}
                      placeholder="搜索要素"
                      aria-label="搜索地图要素"
                      className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-[var(--ink-subtle)]"
                    />
                    {featureQuery && (
                      <button
                        type="button"
                        onClick={() => setFeatureQuery("")}
                        title="清空搜索"
                        aria-label="清空要素搜索"
                        className="grid h-5 w-5 place-items-center rounded text-[var(--ink-subtle)] hover:bg-[var(--hover-bg)]"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </label>
                  {listedFeatures.length === 0 && (
                    <p className="px-2 py-3 text-center text-xs text-[var(--ink-subtle)]">
                      未找到要素
                    </p>
                  )}
                  {listedFeatures.map((feature) => {
                    const Icon = FEATURE_KIND_ICONS[feature.kind];
                    const layerName = doc.map.layers.find(
                      (layer) => layer.id === feature.layerId,
                    )?.name;
                    return (
                      <div
                        key={feature.id}
                        className={`mb-1 flex w-full items-center gap-1 rounded-md pr-1 text-xs ${selectedFeatureId === feature.id ? "bg-[var(--hover-bg)] text-[var(--ink)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setActiveLayerId(feature.layerId);
                            updateMapSelection([feature.id], feature.id);
                            chooseTool("select");
                          }}
                          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                        >
                          <Icon className="h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">
                            {feature.name}
                          </span>
                          {feature.layerId !== activeLayerId && layerName && (
                            <span className="max-w-16 truncate text-[var(--ink-subtle)]">
                              {layerName}
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => focusFeature(feature)}
                          title="定位到要素"
                          aria-label={`定位到要素：${feature.name}`}
                          className="grid h-6 w-6 shrink-0 place-items-center rounded text-[var(--ink-subtle)] hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)]"
                        >
                          <LocateFixed className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </aside>

          <main className="flex min-w-0 flex-1 flex-col">
            {!doc ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-[var(--ink-muted)]">
                <Globe2 className="h-8 w-8 text-[var(--ink-subtle)]" />
                <p>选择左侧地图或新建一张地图</p>
              </div>
            ) : (
              <>
                <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-1 border-b border-[var(--line-subtle)] bg-[var(--paper-elevated)] px-3 py-1.5">
                  <span className="mr-1 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-subtle)]">
                    导航
                  </span>
                  <button
                    type="button"
                    onClick={() => chooseTool("select")}
                    title="选择、框选和编辑对象；Shift 点击重叠对象可逐层追加选择"
                    className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-xs ${tool === "select" ? "bg-[var(--ink)] text-[var(--paper)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                  >
                    <MousePointer2 className="h-3.5 w-3.5" />
                    选择
                  </button>
                  <button
                    type="button"
                    onClick={() => chooseTool("move")}
                    title="拖动已选对象；拖动未选对象会先选中再移动"
                    className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-xs ${tool === "move" ? "bg-[var(--ink)] text-[var(--paper)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                  >
                    <Move className="h-3.5 w-3.5" />
                    移动
                  </button>
                  <button
                    type="button"
                    onClick={() => chooseTool("pan")}
                    title="平移画布，不移动元素"
                    className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-xs ${tool === "pan" ? "bg-[var(--ink)] text-[var(--paper)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                  >
                    <Hand className="h-3.5 w-3.5" />
                    平移
                  </button>
                  {rendererKind === "geographic" && (
                    <>
                      <span className="mx-1 h-5 w-px bg-[var(--line-subtle)]" />
                      <span className="mr-1 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-subtle)]">
                        地形
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveSceneLayerId("scene-terrain");
                          chooseTool("terrain-land");
                        }}
                        disabled={!canDrawLand}
                        title="像画笔一样增加陆地，松开后自动生成海岸与浅滩"
                        aria-label="绘制陆地"
                        className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-xs disabled:cursor-not-allowed disabled:opacity-35 ${tool === "terrain-land" ? "bg-[var(--accent-warm)] text-white" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                      >
                        <LandPlot className="h-3.5 w-3.5" />
                        陆地
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveSceneLayerId("scene-terrain");
                          chooseTool("terrain-water");
                        }}
                        disabled={!canDrawWater}
                        title="像画笔一样切回水域，可雕刻海湾、湖泊与海峡"
                        aria-label="绘制水域"
                        className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-xs disabled:cursor-not-allowed disabled:opacity-35 ${tool === "terrain-water" ? "bg-[var(--accent-warm)] text-white" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                      >
                        <Waves className="h-3.5 w-3.5" />
                        水域
                      </button>
                      <button
                        type="button"
                        onClick={() => chooseAreaShape("freehand")}
                        disabled={!canDrawFeature}
                        title="自由绘制线条或闭合轮廓（F）；闭合后可在右侧转换为陆地、水域或附加材质区域"
                        aria-label="自由画笔"
                        aria-pressed={tool === "freehand"}
                        className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-xs disabled:cursor-not-allowed disabled:opacity-35 ${tool === "freehand" ? "bg-[var(--accent-warm)] text-white" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                      >
                        <Paintbrush className="h-3.5 w-3.5" />
                        自由画笔
                      </button>
                      <button
                        type="button"
                        onClick={() => chooseTool("river")}
                        disabled={!canDrawFeature}
                        title="沿轨迹绘制带源头和河口渐宽效果的河流"
                        aria-label="河流画笔"
                        className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-xs disabled:cursor-not-allowed disabled:opacity-35 ${tool === "river" ? "bg-[var(--accent-warm)] text-white" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                      >
                        <Waves className="h-3.5 w-3.5" />
                        河流画笔
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveSceneLayerId("scene-terrain");
                          chooseTool("terrain-region-land");
                        }}
                        disabled={!canDrawLand}
                        title="拖动勾画不规则大陆边界，松开后落为连续陆地区域"
                        aria-label="勾画陆地区域"
                        className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-xs disabled:cursor-not-allowed disabled:opacity-35 ${tool === "terrain-region-land" ? "bg-[var(--accent-warm)] text-white" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                      >
                        <LandPlot className="h-3.5 w-3.5" />
                        勾画陆地
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveSceneLayerId("scene-water");
                          chooseTool("terrain-region-water");
                        }}
                        disabled={!canDrawWater}
                        title="拖动勾画湖泊、内海或海峡边界，松开后落为水域区域"
                        aria-label="勾画水域区域"
                        className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-xs disabled:cursor-not-allowed disabled:opacity-35 ${tool === "terrain-region-water" ? "bg-[var(--accent-warm)] text-white" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                      >
                        <Waves className="h-3.5 w-3.5" />
                        勾画水域
                      </button>
                      <button
                        type="button"
                        onClick={() => chooseTool("scene-eraser")}
                        disabled={!canEraseSceneLayer}
                        title={`擦除当前绘图层“${activeSceneLayer?.name ?? "未选择"}”中命中的笔触`}
                        aria-label={`擦除当前绘图层：${activeSceneLayer?.name ?? "未选择"}`}
                        className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-xs disabled:cursor-not-allowed disabled:opacity-35 ${tool === "scene-eraser" ? "bg-[var(--accent-warm)] text-white" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                      >
                        <Eraser className="h-3.5 w-3.5" />
                        擦除
                      </button>
                      {artworkBrushAssetId && (
                        <button
                          type="button"
                          onClick={() => chooseTool("artwork-brush")}
                          title="沿轨迹连续盖印当前素材"
                          aria-label="当前素材笔刷"
                          className={`flex h-8 max-w-44 items-center gap-1.5 truncate rounded-md px-2 text-xs ${tool === "artwork-brush" ? "bg-[var(--accent-warm)] text-white" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                        >
                          <Paintbrush className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">
                            笔刷 ·{" "}
                            {artworkDisplayName(
                              artworkBrushAssetId,
                              artworkCatalog?.get(artworkBrushAssetId)?.name,
                            )}
                          </span>
                        </button>
                      )}
                    </>
                  )}
                  {rendererKind === "geographic" && activeStampAssetId && (
                    <button
                      type="button"
                      onClick={() => chooseTool("artwork-stamp")}
                      title="在画布上移动预览并放置当前素材"
                      aria-label="当前素材放置工具"
                      className={`flex h-8 max-w-44 items-center gap-1.5 truncate rounded-md px-2 text-xs ${tool === "artwork-stamp" ? "bg-[var(--accent-warm)] text-white" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                    >
                      <Crosshair className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">
                        放置 ·{" "}
                        {artworkDisplayName(
                          activeStampAssetId,
                          artworkCatalog?.get(activeStampAssetId)?.name,
                        )}
                      </span>
                    </button>
                  )}
                  <span className="mx-1 h-5 w-px bg-[var(--line-subtle)]" />
                  {visibleFeatureKinds.map((kind) =>
                    (() => {
                      const label =
                        kind === "area" ? "自由画笔" : FEATURE_KIND_LABELS[kind];
                      const Icon = FEATURE_KIND_ICONS[kind];
                      const activeLayer = doc.map.layers.find(
                        (layer) => layer.id === activeLayerId,
                      );
                      return (
                        <button
                          key={kind}
                          type="button"
                          draggable={kind === "node" && !activeLayer?.locked}
                          onClick={() =>
                            kind === "area"
                              ? chooseAreaShape("freehand")
                              : chooseTool(kind)
                          }
                          onDragStart={(event) => {
                            if (kind !== "node") return;
                            event.dataTransfer.effectAllowed = "copy";
                            event.dataTransfer.setData(
                              TOPOLOGY_NODE_DRAG_MIME,
                              "create",
                            );
                          }}
                          disabled={!activeLayer?.visible || activeLayer.locked}
                          title={
                            kind === "area"
                              ? "创建可编辑的标注区域；陆地和水域请使用地形工具"
                              : kind === "node"
                                ? `绘制${label}；点击画布创建，或拖到画布直接放置`
                                : `绘制${label}`
                          }
                          aria-label={`绘制${label}`}
                          className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-xs disabled:cursor-not-allowed disabled:opacity-35 ${tool === kind || (kind === "area" && tool === "freehand") ? "bg-[var(--accent-warm)] text-white" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"}`}
                        >
                          <Icon className="h-3.5 w-3.5" />+ {label}
                        </button>
                      );
                    })(),
                  )}
                  {rendererKind === "topology" && (
                    <div className="ml-1 flex min-w-0 items-center gap-2 border-l border-[var(--line-subtle)] pl-2">
                      <label
                        className="relative flex h-8 w-44 shrink-0 items-center"
                        title="按节点名称、世界设定路径或关联地图筛选拓扑"
                      >
                        <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-[var(--ink-subtle)]" />
                        <input
                          value={topologyQuery}
                          onChange={(event) =>
                            updateTopologyQuery(event.target.value)
                          }
                          placeholder="筛选拓扑节点"
                          aria-label="筛选拓扑节点"
                          className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)] pl-7 pr-7 text-xs text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]"
                        />
                        {topologyQuery && (
                          <button
                            type="button"
                            onClick={() => updateTopologyQuery("")}
                            title="清除拓扑筛选"
                            aria-label="清除拓扑筛选"
                            className="absolute right-1 grid h-6 w-6 place-items-center rounded text-[var(--ink-subtle)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </label>
                      <span className="shrink-0 text-xs text-[var(--ink-subtle)]">
                        新节点
                      </span>
                      <input
                        value={activeTopologyNodeName}
                        onChange={(event) => {
                          setActiveTopologyNodeName(event.target.value);
                          chooseTool("node");
                        }}
                        placeholder={activeTopologyNodeOption.defaultName}
                        aria-label="新建拓扑节点名称"
                        title="指定新节点名称；留空时按关联地图或设定名称生成"
                        className="h-8 w-28 shrink-0 rounded border border-[var(--line)] bg-[var(--paper-elevated)] px-2 text-xs text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]"
                      />
                      <CustomSelect
                        value={activeTopologyNodeKind}
                        options={TOPOLOGY_NODE_KIND_OPTIONS.map((option) => ({
                          value: option.value,
                          label: option.label,
                        }))}
                        onChange={(kind) => {
                          setActiveTopologyNodeKind(kind as TopologyNodeKind);
                          chooseTool("node");
                        }}
                        ariaLabel="新建拓扑节点类型"
                        className="w-28"
                        size="toolbar"
                      />
                      <CustomSelect
                        value={activeTopologyLinkedMap?.id ?? ""}
                        options={[
                          { value: "", label: "不关联地图" },
                          ...maps
                            .filter((map) => map.id !== doc.map.id)
                            .map((map) => ({
                              value: map.id,
                              label: map.name,
                              suffix: MAP_PROJECTION_LABELS[map.projectionType],
                            })),
                        ]}
                        onChange={(mapId) => {
                          const linkedMap = maps.find(
                            (map) => map.id === mapId,
                          );
                          setActiveTopologyLinkedMapId(linkedMap?.id ?? null);
                          if (linkedMap) {
                            setActiveTopologyNodeKind(
                              topologyNodeKindForProjection(
                                linkedMap.projectionType,
                              ),
                            );
                          }
                          chooseTool("node");
                        }}
                        ariaLabel="新建拓扑节点关联地图"
                        className="w-40"
                        popoverMinWidth={220}
                        size="toolbar"
                        showSelectedSuffix
                      />
                      <CustomSelect
                        value={
                          activeTopologyEntityRef
                            ? `${activeTopologyEntityRef.kind}:${activeTopologyEntityRef.id}`
                            : ""
                        }
                        options={[
                          { value: "", label: "不关联设定或实体" },
                          ...topologySettingSelectOptions,
                          ...entityOptions
                            .filter((entity) => entity.kind !== "setting")
                            .map((entity) => ({
                              value: `${entity.kind}:${entity.id}`,
                              label: `${entity.name}（${DOMAIN_ENTITY_KIND_LABELS[entity.kind]}）`,
                            })),
                        ]}
                        onChange={(value) => {
                          const separator = value.indexOf(":");
                          const kind =
                            separator > 0 ? value.slice(0, separator) : "";
                          const id =
                            separator > 0 ? value.slice(separator + 1) : "";
                          const setting =
                            kind === "setting"
                              ? topologySettingById.get(id)
                              : undefined;
                          const entity = entityOptions.find(
                            (candidate) =>
                              candidate.kind === kind && candidate.id === id,
                          );
                          const hasKnownEntity = Boolean(setting || entity);
                          setActiveTopologyEntityRef(
                            hasKnownEntity
                              ? {
                                  kind: kind as MapEntityKind,
                                  id,
                                }
                              : null,
                          );
                          if (setting) {
                            setActiveTopologyNodeKind(
                              topologyNodeKindForSettingMapKind(
                                setting.mapKind,
                                setting.typeName,
                              ),
                            );
                          }
                          chooseTool("node");
                        }}
                        ariaLabel="新建拓扑节点关联设定或实体"
                        className="w-40"
                        popoverMinWidth={220}
                        size="toolbar"
                      />
                      <CustomSelect
                        value={activeTopologyNodeStatus}
                        options={TOPOLOGY_NODE_STATUS_OPTIONS.map((option) => ({
                          value: option.value,
                          label: option.label,
                        }))}
                        onChange={(status) => {
                          setActiveTopologyNodeStatus(
                            status as TopologyNodeStatus,
                          );
                          chooseTool("node");
                        }}
                        ariaLabel="新建拓扑节点状态"
                        className="w-20"
                        size="toolbar"
                      />
                      <span className="mx-1 h-5 w-px bg-[var(--line-subtle)]" />
                      <span className="shrink-0 text-xs text-[var(--ink-subtle)]">
                        新通道
                      </span>
                      <CustomSelect
                        value={activeTopologyRouteRelation}
                        options={TOPOLOGY_ROUTE_RELATION_OPTIONS.map(
                          (option) => ({
                            value: option.value,
                            label: option.label,
                          }),
                        )}
                        onChange={(relation) => {
                          setActiveTopologyRouteRelation(
                            relation as TopologyRouteRelation,
                          );
                          chooseTool("route");
                        }}
                        ariaLabel="新建拓扑通道关系"
                        className="w-24"
                        size="toolbar"
                      />
                      <CustomSelect
                        value={activeTopologyRouteDirection}
                        options={[
                          { value: "two-way", label: "双向" },
                          { value: "one-way", label: "单向" },
                        ]}
                        onChange={(direction) => {
                          setActiveTopologyRouteDirection(
                            direction as TopologyRouteDirection,
                          );
                          chooseTool("route");
                        }}
                        ariaLabel="新建拓扑通道方向"
                        className="w-16"
                        size="toolbar"
                      />
                      {selectedTopologyNodeIds.length === 2 && (
                        <button
                          type="button"
                          onClick={() =>
                            connectSelectedTopologyNodes(
                              selectedTopologyNodeIds,
                            )
                          }
                          disabled={!canDrawFeature}
                          title={`按选择顺序连接两个节点；当前为${activeTopologyRouteDirection === "one-way" ? "单向" : "双向"}${TOPOLOGY_ROUTE_RELATION_OPTIONS.find((option) => option.value === activeTopologyRouteRelation)?.label ?? "通道"}`}
                          aria-label="连接已选拓扑节点"
                          className="grid h-8 w-8 shrink-0 place-items-center rounded text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-35"
                        >
                          <Route className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => autoLayoutTopology("horizontal")}
                        title="按通道关系从左到右自动排列拓扑节点"
                        aria-label="拓扑节点横向自动布局"
                        className="grid h-8 w-8 shrink-0 place-items-center rounded text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                      >
                        <Columns2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => autoLayoutTopology("vertical")}
                        title="按通道关系从上到下自动排列拓扑节点"
                        aria-label="拓扑节点纵向自动布局"
                        className="grid h-8 w-8 shrink-0 place-items-center rounded text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                      >
                        <Rows2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setFocusRequest((request) => request + 1)
                        }
                        title="适配当前拓扑内容到画布视图"
                        aria-label="适配拓扑内容"
                        className="grid h-8 w-8 shrink-0 place-items-center rounded text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                      >
                        <Maximize2 className="h-3.5 w-3.5" />
                      </button>
                      <span className="mx-1 h-5 w-px bg-[var(--line-subtle)]" />
                      <CustomSelect
                        value={topologyImportRootId}
                        options={[
                          {
                            value: "",
                            label:
                              topologySettingOptions.length > 0
                                ? "选择架构范围"
                                : "暂无世界架构",
                          },
                          ...topologyImportSelectOptions,
                        ]}
                        onChange={setTopologyImportRootId}
                        ariaLabel="拓扑导入世界架构范围"
                        className="w-44"
                        popoverMinWidth={300}
                        size="toolbar"
                      />
                      <button
                        type="button"
                        onClick={importTopologyNodesFromWorldArchitecture}
                        disabled={
                          !topologyImportRootId ||
                          topologySettingTree.nodes.length === 0
                        }
                        title="导入所选世界架构节点及其后代，并建立父子通道"
                        aria-label="从世界架构导入拓扑节点"
                        className="flex h-8 shrink-0 items-center gap-1 rounded px-2 text-xs text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        <Network className="h-3.5 w-3.5" />
                        导入架构
                      </button>
                    </div>
                  )}
                  {rendererKind === "geographic" && (
                    <div className="ml-1 flex min-w-[245px] items-center gap-2 border-l border-[var(--line-subtle)] pl-2 text-xs text-[var(--ink-muted)]">
                      <label
                        className="flex shrink-0 items-center gap-1.5"
                        title="将对象和绘制顶点吸附到网格"
                      >
                        <input
                          type="checkbox"
                          checked={canvasSettings.snapEnabled}
                          onChange={(event) =>
                            setCanvasSettings((current) => ({
                              ...current,
                              snapEnabled: event.target.checked,
                            }))
                          }
                          aria-label="启用网格吸附"
                        />
                        吸附
                      </label>
                      {canvasSettings.snapEnabled && (
                        <CustomSelect
                          value={String(canvasSettings.snapGrid)}
                          options={[16, 24, 32, 48, 64, 96].map((grid) => ({
                            value: String(grid),
                            label: `${grid}px`,
                          }))}
                          onChange={(value) =>
                            setCanvasSettings((current) => ({
                              ...current,
                              snapGrid: Number(value),
                            }))
                          }
                          ariaLabel="吸附网格大小"
                          size="toolbar"
                        />
                      )}
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="text-[var(--ink-subtle)]">形状</span>
                        <CustomSelect
                          value={canvasSettings.areaShape}
                          options={MAP_AREA_SHAPE_OPTIONS}
                          onChange={(areaShape) =>
                            chooseAreaShape(areaShape as MapAreaShape)
                          }
                          ariaLabel="画笔形状"
                          size="toolbar"
                          disabled={!canDrawFeature}
                        />
                      </div>
                      <span className="font-medium text-[var(--ink)]">
                        {activeComponent
                          ? `预制件 · ${activeComponent.name}`
                          : tool === "terrain-material" && activeTerrainMaterial
                            ? getMapTerrainMaterialPreset(activeTerrainMaterial)
                                .name
                            : (TOOL_LABELS[tool] ?? "工具")}
                      </span>
                      {(tool === "area" ||
                        tool === "freehand" ||
                        tool === "route" ||
                        tool === "river" ||
                        tool === "component-path-brush" ||
                        tool === "artwork-brush") && (
                        <>
                          <label
                            className="flex items-center gap-1"
                            title="沿笔画均匀重采样的触点数量"
                          >
                            <span className="text-[var(--ink-subtle)]">
                              触点
                            </span>
                            <input
                              type="number"
                              min={3}
                              max={96}
                              step={1}
                              value={canvasSettings.brushPointCount}
                              onChange={(event) =>
                                setCanvasSettings((current) => ({
                                  ...current,
                                  brushPointCount: Math.max(
                                    3,
                                    Math.min(
                                      96,
                                      Number(event.target.value) ||
                                        current.brushPointCount,
                                    ),
                                  ),
                                }))
                              }
                              aria-label="画笔触点数量"
                              className="w-12 rounded border border-[var(--line-subtle)] bg-transparent px-1.5 py-1 text-center"
                            />
                          </label>
                          <CustomSelect
                            value={canvasSettings.brushPointCurve}
                            options={[
                              { value: "line", label: "直线触点" },
                              { value: "arc", label: "弧线触点" },
                            ]}
                            onChange={(value) =>
                              chooseBrushCurve(value as MapBrushPointCurve)
                            }
                            ariaLabel="画笔触点调整方式"
                            size="toolbar"
                          />
                        </>
                      )}
                      {(tool === "scene-eraser" ||
                        tool === "terrain-land" ||
                        tool === "terrain-water" ||
                        tool === "terrain-material" ||
                        tool === "terrain-region-land" ||
                        tool === "terrain-region-water") && (
                        <>
                          <CustomSelect
                            value={canvasSettings.brushPointCurve}
                            options={[
                              { value: "line", label: "直线触点" },
                              { value: "arc", label: "弧线触点" },
                            ]}
                            onChange={(value) =>
                              chooseBrushCurve(value as MapBrushPointCurve)
                            }
                            ariaLabel="路径触点调整方式"
                            size="toolbar"
                          />
                          <label
                            className="flex items-center gap-1"
                            title="沿笔画均匀分布触点的间距"
                          >
                            <span className="text-[var(--ink-subtle)]">
                              间距
                            </span>
                            <input
                              type="range"
                              min={4}
                              max={512}
                              step={4}
                              value={canvasSettings.brushSpacing}
                              onChange={(event) =>
                                setCanvasSettings((current) => ({
                                  ...current,
                                  brushSpacing: Number(event.target.value),
                                }))
                              }
                              className="w-14"
                              aria-label="路径触点间距"
                            />
                            <span className="w-7 text-right text-[var(--ink-subtle)]">
                              {Math.round(canvasSettings.brushSpacing)}
                            </span>
                          </label>
                        </>
                      )}
                      {(tool === "artwork-brush" ||
                        tool === "scene-eraser" ||
                        tool === "terrain-land" ||
                        tool === "terrain-water" ||
                        tool === "terrain-material") && (
                        <label
                          className="flex items-center gap-1"
                          title="笔刷大小"
                        >
                          <span className="text-[var(--ink-subtle)]">大小</span>
                          <input
                            type="range"
                            min={16}
                            max={360}
                            step={4}
                            value={canvasSettings.brushSize}
                            onChange={(event) =>
                              setCanvasSettings((current) => ({
                                ...current,
                                brushSize: Number(event.target.value),
                              }))
                            }
                            className="w-16"
                            aria-label="笔刷大小"
                          />
                          <span className="w-7 text-right text-[var(--ink-subtle)]">
                            {Math.round(canvasSettings.brushSize)}
                          </span>
                        </label>
                      )}
                      {(tool === "scene-eraser" ||
                        tool === "terrain-land" ||
                        tool === "terrain-water" ||
                        tool === "terrain-material") && (
                        <CustomSelect
                          value={canvasSettings.terrainBrushShape}
                          options={[
                            { value: "round", label: "圆形笔锋" },
                            { value: "organic", label: "有机笔锋" },
                          ]}
                          onChange={(value) =>
                            setCanvasSettings((current) => ({
                              ...current,
                              terrainBrushShape:
                                value as MapSceneStroke["shape"],
                            }))
                          }
                          ariaLabel="地形笔锋"
                          size="toolbar"
                        />
                      )}
                      {tool === "artwork-brush" && (
                        <>
                          {activeArtworkBrushColor && (
                            <label
                              className="flex items-center gap-1"
                              title="内置素材会以此颜色实时预览；落笔后颜色保存到该笔触"
                            >
                              <span className="text-[var(--ink-subtle)]">
                                颜色
                              </span>
                              <input
                                type="color"
                                value={activeArtworkBrushColor}
                                onChange={(event) =>
                                  setArtworkBrushColor(event.target.value)
                                }
                                aria-label="素材笔刷颜色"
                                className="h-6 w-7 cursor-pointer rounded border border-[var(--line-subtle)] bg-transparent p-0.5"
                              />
                            </label>
                          )}
                          <CustomSelect
                            value={artworkBrushLayerKind}
                            options={sceneLayers
                              .filter((layer) => layer.visible && !layer.locked)
                              .map((layer) => ({
                                value: layer.kind,
                                label: layer.name,
                              }))}
                            onChange={(value) =>
                              setArtworkBrushLayerKind(
                                value as MapSceneLayerKind,
                              )
                            }
                            ariaLabel="素材笔刷目标图层"
                            size="toolbar"
                          />
                          <label
                            className="flex items-center gap-1"
                            title="素材密度：间距越小，沿笔触落下的素材越密"
                          >
                            <span className="text-[var(--ink-subtle)]">
                              间距
                            </span>
                            <input
                              type="range"
                              min={4}
                              max={512}
                              step={4}
                              value={canvasSettings.brushSpacing}
                              onChange={(event) =>
                                setCanvasSettings((current) => ({
                                  ...current,
                                  brushSpacing: Number(event.target.value),
                                }))
                              }
                              className="w-14"
                              aria-label="素材笔刷间距"
                            />
                            <span className="w-7 text-right text-[var(--ink-subtle)]">
                              {Math.round(canvasSettings.brushSpacing)}
                            </span>
                          </label>
                          <label
                            className="flex items-center gap-1"
                            title="素材密度：提高散布会在笔触两侧生成更多辅助素材"
                          >
                            <span className="text-[var(--ink-subtle)]">
                              散布
                            </span>
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.05}
                              value={canvasSettings.brushScatter}
                              onChange={(event) =>
                                setCanvasSettings((current) => ({
                                  ...current,
                                  brushScatter: Number(event.target.value),
                                }))
                              }
                              className="w-14"
                              aria-label="素材笔刷散布"
                            />
                            <span className="w-8 text-right text-[var(--ink-subtle)]">
                              {Math.round(canvasSettings.brushScatter * 100)}%
                            </span>
                          </label>
                        </>
                      )}
                      {tool === "artwork-stamp" && (
                        <label
                          className="flex items-center gap-1"
                          title="素材缩放"
                        >
                          <span className="text-[var(--ink-subtle)]">缩放</span>
                          <input
                            type="range"
                            min={0.2}
                            max={4}
                            step={0.05}
                            value={canvasSettings.stampScale}
                            onChange={(event) =>
                              setCanvasSettings((current) => ({
                                ...current,
                                stampScale: Number(event.target.value),
                              }))
                            }
                            className="w-14"
                            aria-label="素材缩放"
                          />
                          <span className="w-7 text-right text-[var(--ink-subtle)]">
                            {canvasSettings.stampScale.toFixed(1)}
                          </span>
                        </label>
                      )}
                      {(tool === "artwork-brush" ||
                        tool === "artwork-stamp" ||
                        tool === "terrain-material") && (
                        <label
                          className="flex items-center gap-1"
                          title="工具不透明度"
                        >
                          <span className="text-[var(--ink-subtle)]">
                            不透明
                          </span>
                          <input
                            type="range"
                            min={0.1}
                            max={1}
                            step={0.05}
                            value={
                              tool === "artwork-stamp"
                                ? canvasSettings.stampOpacity
                                : canvasSettings.brushOpacity
                            }
                            onChange={(event) => {
                              const value = Number(event.target.value);
                              setCanvasSettings((current) =>
                                tool === "artwork-stamp"
                                  ? { ...current, stampOpacity: value }
                                  : { ...current, brushOpacity: value },
                              );
                            }}
                            className="w-14"
                            aria-label="工具不透明度"
                          />
                        </label>
                      )}
                    </div>
                  )}
                  <div className="ml-auto flex items-center gap-1.5 text-xs text-[var(--ink-subtle)]">
                    <Clock3 className="h-3.5 w-3.5" />
                    <CustomSelect
                      value={
                        timelineCursor === null ? "all" : String(timelineCursor)
                      }
                      options={[
                        { value: "all", label: "全部时间" },
                        ...timelineEvents.map((event) => ({
                          value: String(event.sortKey),
                          label: `${event.timeLabel} · ${event.title}`,
                        })),
                      ]}
                      onChange={(value) =>
                        setTimelineCursor(
                          value === "all" ? null : Number(value),
                        )
                      }
                      ariaLabel="时间切片"
                      size="toolbar"
                    />
                  </div>
                </div>
                <div className="flex min-h-0 flex-1">
                  {rendererKind === "geographic" && (
                    <MapComponentPalette
                      orientation="vertical"
                      disabled={!canPaintScene}
                      terrainMaterialDisabled={!canPaintTerrainMaterial}
                      terrainMaterialAvailability={terrainMaterialAvailability}
                      onInsert={activateComponent}
                      onPick={(component) => pickArtworkStamp(component.id)}
                      onBrush={(component) =>
                        component.interaction === "scatter"
                          ? activateArtworkBrush(component.id)
                          : component.interaction === "path"
                            ? activatePathBrush(component)
                          : component.interaction === "surface" &&
                              mapComponentPlacement(component) === "overlay"
                            ? (() => {
                                const layer = doc?.map.layers.find(
                                  (candidate) => candidate.id === activeLayerId,
                                );
                                if (!layer?.visible || layer.locked) {
                                  setError("当前绘图层已隐藏或锁定。");
                                  return;
                                }
                                setArtworkBrushAssetId(null);
                                setActiveStampAssetId(null);
                                setActiveTerrainMaterial(null);
                                setActiveComponentId(component.id);
                                setSelectedFeatureId(null);
                                setTool("component-surface-brush");
                              })()
                            : activateComponent(component)
                      }
                      onTerrainMaterial={activateTerrainMaterial}
                      projectArtworkAssets={projectArtworkAssets}
                      projectArtworkUsage={projectArtworkUsage}
                      onImportProjectArtwork={() =>
                        projectArtworkInputRef.current?.click()
                      }
                      onPickProjectArtwork={pickArtworkStamp}
                      onBrushProjectArtwork={activateArtworkBrush}
                      onRenameProjectArtwork={renameProjectArtwork}
                      onRemoveProjectArtwork={removeProjectArtwork}
                      activeBrushAssetId={artworkBrushAssetId}
                      activeStampAssetId={activeStampAssetId}
                      activeComponentId={activeComponentId}
                      activeTerrainMaterial={activeTerrainMaterial}
                      activeToolLabel={
                        activeComponent
                          ? `预制件 · ${activeComponent.name}`
                          : tool === "terrain-material" && activeTerrainMaterial
                            ? `材质 · ${getMapTerrainMaterialPreset(activeTerrainMaterial).name}`
                            : TOOL_LABELS[tool]
                      }
                    />
                  )}
                  {rendererKind === "topology" && topologySummary && (
                    <TopologyComponentPalette
                      disabled={!canDrawFeature}
                      nodeCount={topologySummary.nodeCount}
                      routeCount={topologySummary.routeCount}
                      isolatedNodeCount={topologySummary.isolatedNodeCount}
                      invalidRouteCount={topologySummary.invalidRouteCount}
                      activeNodeKind={activeTopologyNodeKind}
                      activeRouteRelation={activeTopologyRouteRelation}
                      activeRouteDirection={activeTopologyRouteDirection}
                      topologyNodeTemplate={topologyNodeTemplate}
                      onNodePreset={selectTopologyNodePreset}
                      onRoutePreset={selectTopologyRoutePreset}
                    />
                  )}
                  <div className="min-h-0 min-w-0 flex-1 bg-[#d8d1c3] p-3">
                    <div className="h-full overflow-hidden rounded-md border border-[#746b6038] bg-[#f3f0e8] shadow-[0_12px_32px_rgba(55,47,39,0.12)]">
                      <MapRendererCanvas
                        document={doc.map}
                        tool={tool}
                        settings={canvasSettings}
                        activeLayerId={activeLayerId}
                        selectedFeatureId={selectedFeatureId}
                        selectedFeatureIds={selectedFeatureIds}
                        focusRequest={focusRequest}
                        documentRebase={documentRebase}
                        timelineCursor={timelineCursor}
                        onSelect={setSelectedFeatureId}
                        onSelectionChange={updateMapSelection}
                        onCreateGroup={createMapObjectGroup}
                        onUngroup={ungroupMapObject}
                        onCreate={createFeature}
                        onTopologyNodePlaced={() => chooseTool("select")}
                        artworkBrushAssetId={artworkBrushAssetId}
                        artworkBrushColor={activeArtworkBrushColor}
                        artworkBrushLayerKind={artworkBrushLayerKind}
                        activeStampAssetId={activeStampAssetId}
                        activePrefabComponentId={
                          activeComponent &&
                          (mapComponentPlacement(activeComponent) ===
                            "terrain-prefab" ||
                            mapComponentPlacement(activeComponent) === "path" ||
                            mapComponentPlacement(activeComponent) === "overlay")
                            ? activeComponent.id
                            : null
                        }
                        activeTerrainMaterial={activeTerrainMaterial}
                        projectArtworkSources={projectArtworkSources}
                        topologyLinkedMapNames={topologyLinkedMapNames}
                        topologyEntityNames={topologyEntityNames}
                        topologyQuery={topologyQuery}
                        topologyNodeTemplate={topologyNodeTemplate}
                        topologyRouteTemplate={topologyRouteTemplate}
                        onSceneStroke={paintSceneStroke}
                        onSceneErase={eraseSceneStroke}
                        onTerrainStroke={paintTerrainStroke}
                        onTerrainMaterialStroke={paintTerrainMaterialStroke}
                        onTerrainMaterialRejected={() =>
                          setError(
                            activeTerrainMaterial &&
                              getMapTerrainMaterialPreset(activeTerrainMaterial)
                                .surface === "water"
                              ? "浅海和深海材质只能绘制在已有水域上。"
                              : "地貌材质只能绘制在陆地上。",
                          )
                        }
                        onSceneStrokeMove={moveSceneStroke}
                        onSceneRegionCreate={createSceneRegion}
                        onSceneRegionMove={moveSceneRegion}
                        onComponentSurface={paintComponentSurface}
                        onComponentDrop={(componentId, point, gesture) => {
                          const component = MAP_COMPONENT_PRESETS.find(
                            (item) => item.id === componentId,
                          );
                          if (
                            component &&
                            mapComponentPlacement(component) ===
                              "terrain-prefab"
                          ) {
                            insertComponent(component, point, gesture);
                            return;
                          }
                          if (
                            component &&
                            mapComponentPlacement(component) === "path"
                          ) {
                            insertComponent(component, point, gesture);
                            return;
                          }
                          if (
                            component &&
                            mapComponentPlacement(component) === "overlay"
                          ) {
                            insertComponent(component, point, gesture);
                            return;
                          }
                          if (dropArtworkBrush(componentId, point)) {
                            chooseTool("select");
                            return;
                          }
                          if (component) {
                            placeArtworkStamp(component.id, point);
                            chooseTool("select");
                            return;
                          }
                          if (
                            doc.map.artwork.assets.some(
                              (asset) => asset.id === componentId,
                            )
                          ) {
                            placeArtworkStamp(componentId, point);
                            chooseTool("select");
                          }
                        }}
                        onArtworkStampMove={updateArtworkStampPosition}
                        onArtworkStampTransform={updateArtworkStamp}
                        onArtworkStampPlace={placeArtworkStamp}
                        onGeometryChange={updateGeometry}
                        onTopologyNodesMove={updateTopologyNodePositions}
                        onTopologyEdgeReconnect={reconnectTopologyRoute}
                        onTopologyNodeAdjacent={
                          createConnectedTopologyNodeFromCanvas
                        }
                        onTopologyNodeHierarchyAdjacent={
                          createHierarchyTopologyNodeFromCanvas
                        }
                        onTopologyNodeLockToggle={toggleTopologyNodeLock}
                        onTopologyDelete={removeTopologyCanvasItems}
                        onTopologyNodeOpen={openTopologyNodeMap}
                        onTopologyNodeCreateMap={beginTopologyNodeMapCreation}
                        onTopologyNodeImportSettingSubtree={
                          importTopologySettingSubtreeFromNode
                        }
                        onTopologyNodeDuplicate={(featureId) => {
                          duplicateSelectedMapItems([featureId]);
                        }}
                        onTopologyNodeDelete={(featureId) => {
                          removeTopologyCanvasItems([featureId]);
                        }}
                        onTopologyInvalidRouteSelect={
                          selectTopologyInvalidRoute
                        }
                        onTopologyError={setError}
                        onBatchMove={moveSelectableMapItems}
                      />
                    </div>
                  </div>
                </div>
              </>
            )}
          </main>

          <aside className="flex w-64 shrink-0 flex-col border-l border-[var(--line-subtle)] max-lg:hidden">
            <div className="flex h-9 shrink-0 items-center border-b border-[var(--line-subtle)] px-3 text-xs text-[var(--ink-muted)]">
              <span>要素检查器</span>
              {(selectedFeature ||
                selectedArtworkStamp ||
                selectedSceneRegion ||
                selectedSceneStroke) && (
                <div className="ml-auto flex items-center gap-1">
                  {selectedFeature ? (
                    <>
                      <button
                        type="button"
                        onClick={() => focusFeature(selectedFeature)}
                        title="定位到要素"
                        aria-label="定位到当前要素"
                        className="grid h-7 w-7 place-items-center rounded text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                      >
                        <LocateFixed className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => duplicateFeature(selectedFeature.id)}
                        title="复制要素"
                        aria-label="复制当前要素"
                        className="grid h-7 w-7 place-items-center rounded text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : selectedArtworkStamp ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setTool("select");
                          setFocusRequest((request) => request + 1);
                        }}
                        title="定位到素材"
                        aria-label="定位到当前素材"
                        className="grid h-7 w-7 place-items-center rounded text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                      >
                        <LocateFixed className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          duplicateSelectedMapItems([selectedArtworkStamp.id])
                        }
                        title="复制素材印章"
                        aria-label="复制当前素材印章"
                        className="grid h-7 w-7 place-items-center rounded text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : selectedSceneRegion ? (
                    <button
                      type="button"
                      onClick={() => removeSceneRegion(selectedSceneRegion.id)}
                      title="删除地形区域"
                      aria-label="删除当前地形区域"
                      className="grid h-7 w-7 place-items-center rounded text-[var(--error)] hover:bg-[var(--error-bg)]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : selectedSceneStroke ? (
                    <button
                      type="button"
                      onClick={() => removeSceneStroke(selectedSceneStroke.id)}
                      title="删除绘图笔触"
                      aria-label="删除当前绘图笔触"
                      className="grid h-7 w-7 place-items-center rounded text-[var(--error)] hover:bg-[var(--error-bg)]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setTool("select");
                        setFocusRequest((request) => request + 1);
                      }}
                      title="定位到素材"
                      aria-label="定位到当前素材"
                      className="grid h-7 w-7 place-items-center rounded text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                    >
                      <LocateFixed className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}
            </div>
            {!selectedFeature &&
            !selectedArtworkStamp &&
            !selectedSceneRegion &&
            !selectedSceneStroke ? (
              <div
                key="map-settings-inspector"
                className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-xs"
              >
                <p className="leading-5 text-[var(--ink-muted)]">
                  {rendererKind === "topology"
                    ? "创建世界节点，再用路线工具连接分支或宇宙通道。"
                    : "点击画布上的要素查看与编辑；工具栏可添加要素。地图级设置在这里统一管理。"}
                </p>
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    画布尺寸
                  </span>
                  <div className="mb-2 rounded border border-[var(--line-subtle)] bg-[var(--paper-elevated)] px-2 py-1.5 text-xs leading-4 text-[var(--ink-subtle)]">
                    自动延展：内容接近任一边缘时，画布会向对应方向扩展并保留继续创作的边缘留白。删除内容不会自动缩小画布。
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="number"
                      min={320}
                      value={doc?.map.canvas.width ?? 1600}
                      onChange={(event) =>
                        updateCanvas({
                          width: Math.max(
                            320,
                            Number(event.target.value) || 1600,
                          ),
                        })
                      }
                      aria-label="画布宽度"
                      className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2 py-1.5"
                    />
                    <input
                      type="number"
                      min={240}
                      value={doc?.map.canvas.height ?? 1000}
                      onChange={(event) =>
                        updateCanvas({
                          height: Math.max(
                            240,
                            Number(event.target.value) || 1000,
                          ),
                        })
                      }
                      aria-label="画布高度"
                      className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2 py-1.5"
                    />
                  </div>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="col-span-2 block">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      画布背景
                    </span>
                    <CustomSelect
                      value={doc?.map.canvas.backgroundPreset ?? "parchment"}
                      options={MAP_BACKGROUND_PRESETS.map((preset) => ({
                        value: preset.id,
                        label: preset.name,
                      }))}
                      onChange={(value) => {
                        const preset = getMapBackgroundPreset(
                          value as MapBackgroundPreset,
                        );
                        updateCanvas({
                          backgroundPreset: preset.id,
                          backgroundColor: preset.color,
                        });
                      }}
                      ariaLabel="画布背景"
                      size="sm"
                    />
                    <span className="mt-1 block leading-4 text-[var(--ink-subtle)]">
                      {
                        getMapBackgroundPreset(doc?.map.canvas.backgroundPreset)
                          .description
                      }
                    </span>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      底色
                    </span>
                    <input
                      type="color"
                      value={doc?.map.canvas.backgroundColor ?? "#f3f0e8"}
                      onChange={(event) =>
                        updateCanvas({ backgroundColor: event.target.value })
                      }
                      className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]"
                    />
                  </label>
                  <label className="flex items-end gap-2 pb-1.5 text-[var(--ink-muted)]">
                    <input
                      type="checkbox"
                      checked={doc?.map.canvas.showGrid ?? true}
                      onChange={(event) =>
                        updateCanvas({ showGrid: event.target.checked })
                      }
                    />
                    显示网格
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    叠加底图
                  </span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                    onChange={(event) =>
                      void importBackground(event.target.files?.[0])
                    }
                    className="block w-full text-xs text-[var(--ink-muted)]"
                  />
                  {doc?.map.canvas.backgroundImage && (
                    <label className="mt-2 flex items-center gap-2 text-xs text-[var(--ink-muted)]">
                      <input
                        type="checkbox"
                        checked={
                          doc.map.canvas.backgroundImageVisible !== false
                        }
                        onChange={(event) =>
                          updateCanvas({
                            backgroundImageVisible: event.target.checked,
                          })
                        }
                      />
                      显示底图参考层
                    </label>
                  )}
                  {doc?.map.canvas.backgroundImage && (
                    <button
                      type="button"
                      onClick={() =>
                        updateCanvas({
                          backgroundImage: null,
                          backgroundAssetPath: null,
                          backgroundImageWidth: undefined,
                          backgroundImageHeight: undefined,
                          backgroundImagePlacement: undefined,
                        })
                      }
                      className="mt-2 rounded border border-[var(--line)] px-2 py-1 text-xs text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                    >
                      移除底图
                    </button>
                  )}
                </label>
                {doc?.map.canvas.backgroundImage && (
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      底图透明度 ·{" "}
                      {Math.round(
                        (doc.map.canvas.backgroundOpacity ?? 1) * 100,
                      )}
                      %
                    </span>
                    <input
                      type="range"
                      min={0.1}
                      max={1}
                      step={0.05}
                      value={doc.map.canvas.backgroundOpacity ?? 1}
                      onChange={(event) =>
                        updateCanvas({
                          backgroundOpacity: Number(event.target.value),
                        })
                      }
                      className="w-full"
                    />
                  </label>
                )}
                {doc?.map.canvas.backgroundImage && backgroundPlacement && (
                  <div className="rounded-md border border-[var(--line-subtle)] bg-[var(--paper-elevated)] p-2">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[var(--ink-muted)]">底图变换</span>
                      <span className="text-xs text-[var(--ink-subtle)]">
                        世界坐标
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {(
                        [
                          ["x", "横坐标"],
                          ["y", "纵坐标"],
                          ["width", "宽度"],
                          ["height", "高度"],
                        ] as const
                      ).map(([key, label]) => (
                        <label key={key} className="block">
                          <span className="mb-1 block text-xs text-[var(--ink-subtle)]">
                            {label}
                          </span>
                          <input
                            type="number"
                            step={key === "width" || key === "height" ? 1 : 0.5}
                            min={
                              key === "width" || key === "height"
                                ? 1
                                : undefined
                            }
                            value={
                              Math.round(backgroundPlacement[key] * 10) / 10
                            }
                            onChange={(event) => {
                              const parsed = Number(event.target.value);
                              if (!Number.isFinite(parsed)) return;
                              const value =
                                key === "width" || key === "height"
                                  ? Math.max(1, parsed)
                                  : parsed;
                              updateBackgroundPlacement({ [key]: value });
                            }}
                            aria-label={`底图${label}`}
                            className="w-full rounded border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-xs"
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {rendererKind === "geographic" && terrainStyle && (
                  <div className="-mx-4 border-t border-[var(--line-subtle)] px-4 pt-3">
                    <span className="mb-2 block font-medium text-[var(--ink)]">
                      地形成图
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          陆地材质
                        </span>
                        <input
                          type="color"
                          value={terrainStyle.landColor}
                          onChange={(event) =>
                            updateTerrainStyle({
                              landColor: event.target.value,
                            })
                          }
                          aria-label="陆地材质颜色"
                          className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          海洋材质
                        </span>
                        <input
                          type="color"
                          value={terrainStyle.waterColor}
                          onChange={(event) =>
                            updateTerrainStyle({
                              waterColor: event.target.value,
                            })
                          }
                          aria-label="海洋材质颜色"
                          className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          浅滩颜色
                        </span>
                        <input
                          type="color"
                          value={terrainStyle.shallowWaterColor}
                          onChange={(event) =>
                            updateTerrainStyle({
                              shallowWaterColor: event.target.value,
                            })
                          }
                          aria-label="浅滩颜色"
                          className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          海岸沙滩
                        </span>
                        <input
                          type="color"
                          value={terrainStyle.beachColor}
                          onChange={(event) =>
                            updateTerrainStyle({
                              beachColor: event.target.value,
                            })
                          }
                          aria-label="海岸沙滩颜色"
                          className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          海岸描线
                        </span>
                        <input
                          type="color"
                          value={terrainStyle.coastColor}
                          onChange={(event) =>
                            updateTerrainStyle({
                              coastColor: event.target.value,
                            })
                          }
                          aria-label="海岸描线颜色"
                          className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]"
                        />
                      </label>
                    </div>
                    <label className="mt-3 block">
                      <span className="mb-1 block text-[var(--ink-muted)]">
                        纹理强度 ·{" "}
                        {Math.round(terrainStyle.textureStrength * 100)}%
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={terrainStyle.textureStrength}
                        onChange={(event) =>
                          updateTerrainStyle({
                            textureStrength: Number(event.target.value),
                          })
                        }
                        aria-label="地形纹理强度"
                        className="w-full"
                      />
                    </label>
                    <label className="mt-3 block">
                      <span className="mb-1 block text-[var(--ink-muted)]">
                        海岸宽度 · {terrainStyle.coastWidth.toFixed(1)}
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={24}
                        step={0.5}
                        value={terrainStyle.coastWidth}
                        onChange={(event) =>
                          updateTerrainStyle({
                            coastWidth: Number(event.target.value),
                          })
                        }
                        aria-label="海岸线宽度"
                        className="w-full"
                      />
                    </label>
                    <label className="mt-3 block">
                      <span className="mb-1 block text-[var(--ink-muted)]">
                        浅滩宽度 · {terrainStyle.shelfWidth.toFixed(1)}
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={48}
                        step={1}
                        value={terrainStyle.shelfWidth}
                        onChange={(event) =>
                          updateTerrainStyle({
                            shelfWidth: Number(event.target.value),
                          })
                        }
                        aria-label="浅滩宽度"
                        className="w-full"
                      />
                    </label>
                  </div>
                )}
              </div>
            ) : selectedSceneRegion ? (
              <div
                key="scene-region-inspector"
                className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-xs"
              >
                <div>
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    地形区域
                  </span>
                  <span className="block rounded-md bg-[var(--paper-inset)] px-2.5 py-1.5 font-medium">
                    {selectedSceneRegion.kind === "land"
                      ? "陆地区域"
                      : "水域区域"}
                  </span>
                </div>
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    所属绘图层
                  </span>
                  <span className="block rounded-md bg-[var(--paper-inset)] px-2.5 py-1.5">
                    {selectedSceneLayer?.name ?? selectedSceneRegion.layerId}
                  </span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      填充颜色
                    </span>
                    <input
                      type="color"
                      value={
                        /^#[0-9a-f]{6}$/iu.test(selectedSceneRegion.fill)
                          ? selectedSceneRegion.fill
                          : "#b8ad7d"
                      }
                      onChange={(event) =>
                        updateSceneRegion(selectedSceneRegion.id, {
                          fill: event.target.value,
                        })
                      }
                      aria-label="地形区域填充颜色"
                      className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      边线颜色
                    </span>
                    <input
                      type="color"
                      value={
                        /^#[0-9a-f]{6}$/iu.test(selectedSceneRegion.edgeColor)
                          ? selectedSceneRegion.edgeColor
                          : "#5c5038"
                      }
                      onChange={(event) =>
                        updateSceneRegion(selectedSceneRegion.id, {
                          edgeColor: event.target.value,
                        })
                      }
                      aria-label="地形区域边线颜色"
                      className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]"
                    />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      边线宽度
                    </span>
                    <input
                      type="number"
                      min={0.5}
                      max={256}
                      step={0.5}
                      value={selectedSceneRegion.edgeWidth}
                      onChange={(event) =>
                        updateSceneRegion(selectedSceneRegion.id, {
                          edgeWidth: Math.max(
                            0.5,
                            Math.min(
                              256,
                              Number(event.target.value) ||
                                selectedSceneRegion.edgeWidth,
                            ),
                          ),
                        })
                      }
                      aria-label="地形区域边线宽度"
                      className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      顶点
                    </span>
                    <span className="block rounded-md bg-[var(--paper-inset)] px-2.5 py-1.5">
                      {selectedSceneRegion.points.length}
                    </span>
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    轮廓触点
                  </span>
                  <CustomSelect
                    value={selectedSceneRegion.curve ?? "arc"}
                    options={[
                      { value: "line", label: "直线触点" },
                      { value: "arc", label: "弧线触点" },
                    ]}
                    onChange={(value) =>
                      updateSceneRegion(selectedSceneRegion.id, {
                        curve: value as MapSceneRegion["curve"],
                      })
                    }
                    ariaLabel="地形区域轮廓触点"
                    size="sm"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    纹理
                  </span>
                  <CustomSelect
                    value={selectedSceneRegion.texture}
                    options={[
                      { value: "paper-land", label: "陆地纸张肌理" },
                      { value: "water-ripple", label: "水面波纹" },
                      { value: "territory-hatch", label: "疆域斜线纹理" },
                      { value: "administrative-grid", label: "行政区网格" },
                      { value: "stellar-domain", label: "星际疆域星点" },
                    ]}
                    onChange={(value) =>
                      updateSceneRegion(selectedSceneRegion.id, {
                        texture: value as MapSceneRegion["texture"],
                      })
                    }
                    ariaLabel="地形区域纹理"
                    size="sm"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    附加材质
                  </span>
                  <CustomSelect
                    value={selectedSceneRegion.terrainMaterial ?? ""}
                    options={[
                      { value: "", label: "无附加材质" },
                      ...MAP_TERRAIN_MATERIAL_PRESETS.filter(
                        (preset) => preset.surface === selectedSceneRegion.kind,
                      ).map((preset) => ({
                        value: preset.id,
                        label: preset.name,
                      })),
                    ]}
                    onChange={(value) =>
                      updateSceneRegion(selectedSceneRegion.id, {
                        terrainMaterial: value
                          ? (value as MapTerrainMaterial)
                          : null,
                      })
                    }
                    ariaLabel="地形区域附加材质"
                    size="sm"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    透明度 · {Math.round(selectedSceneRegion.opacity * 100)}%
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={selectedSceneRegion.opacity}
                    onChange={(event) =>
                      updateSceneRegion(selectedSceneRegion.id, {
                        opacity: Number(event.target.value),
                      })
                    }
                    aria-label="地形区域透明度"
                    className="w-full"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => removeSceneRegion(selectedSceneRegion.id)}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-[var(--error)] hover:bg-[var(--error-bg)]"
                >
                  <Trash2 className="h-3.5 w-3.5" /> 删除区域
                </button>
              </div>
            ) : selectedSceneStroke ? (
              <div
                key="scene-stroke-inspector"
                className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-xs"
              >
                <div>
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    绘图笔触
                  </span>
                  <span className="block rounded-md bg-[var(--paper-inset)] px-2.5 py-1.5 font-medium">
                    {selectedSceneStrokeMaterial
                      ? `${selectedSceneStrokeMaterial.name}材质笔触`
                      : selectedSceneStrokeIsTerrainShape
                        ? selectedSceneStroke.tool === "erase"
                          ? "切回水域笔触"
                          : "增加陆地笔触"
                        : selectedSceneStroke.tool === "erase"
                          ? "擦除笔触"
                          : "素材笔触"}
                  </span>
                </div>
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    所属绘图层
                  </span>
                  <span className="block rounded-md bg-[var(--paper-inset)] px-2.5 py-1.5">
                    {selectedSceneLayer?.name ?? selectedSceneStroke.layerId}
                  </span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      笔触宽度
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={8192}
                      step={1}
                      value={Math.round(selectedSceneStroke.width)}
                      onChange={(event) =>
                        updateSceneStroke(selectedSceneStroke.id, {
                          width: Math.max(
                            1,
                            Math.min(
                              8192,
                              Number(event.target.value) ||
                                selectedSceneStroke.width,
                            ),
                          ),
                        })
                      }
                      aria-label="笔触宽度"
                      className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      采样点
                    </span>
                    <span className="block rounded-md bg-[var(--paper-inset)] px-2.5 py-1.5">
                      {selectedSceneStroke.points.length}
                    </span>
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    中心线
                  </span>
                  <CustomSelect
                    value={selectedSceneStroke.curve ?? "line"}
                    options={[
                      { value: "line", label: "直线触点" },
                      { value: "arc", label: "弧线触点" },
                    ]}
                    onChange={(value) =>
                      updateSceneStroke(selectedSceneStroke.id, {
                        curve: value as NonNullable<MapSceneStroke["curve"]>,
                      })
                    }
                    ariaLabel="笔触中心线"
                    size="sm"
                  />
                </label>
                {(selectedSceneStrokeIsTerrainShape ||
                  selectedSceneStrokeMaterial) && (
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      地形笔锋
                    </span>
                    <CustomSelect
                      value={selectedSceneStroke.shape}
                      options={[
                        { value: "round", label: "圆形笔锋" },
                        { value: "organic", label: "有机笔锋" },
                      ]}
                      onChange={(value) =>
                        updateSceneStroke(selectedSceneStroke.id, {
                          shape: value as MapSceneStroke["shape"],
                        })
                      }
                      ariaLabel="地形笔锋"
                      size="sm"
                    />
                  </label>
                )}
                {selectedSceneStrokeIsArtworkBrush && (
                  <div className="space-y-3 border-y border-[var(--line-subtle)] py-3">
                    <span className="block text-[var(--ink-muted)]">
                      素材密度
                    </span>
                    <label className="block">
                      <span className="mb-1 block text-[var(--ink-muted)]">
                        盖印间距 · {Math.round(selectedSceneStroke.spacing)} px
                      </span>
                      <input
                        type="range"
                        min={4}
                        max={2048}
                        step={4}
                        value={selectedSceneStroke.spacing}
                        onChange={(event) =>
                          updateSceneStroke(selectedSceneStroke.id, {
                            spacing: Number(event.target.value),
                          })
                        }
                        aria-label="素材笔刷盖印间距"
                        className="w-full"
                      />
                      <span className="mt-1 block leading-4 text-[var(--ink-subtle)]">
                        间距越小，素材越密集。
                      </span>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[var(--ink-muted)]">
                        侧向散布 ·{" "}
                        {Math.round(selectedSceneStroke.scatter * 100)}%
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={selectedSceneStroke.scatter}
                        onChange={(event) =>
                          updateSceneStroke(selectedSceneStroke.id, {
                            scatter: Number(event.target.value),
                          })
                        }
                        aria-label="素材笔刷侧向散布"
                        className="w-full"
                      />
                      <span className="mt-1 block leading-4 text-[var(--ink-subtle)]">
                        散布越高，素材越会沿笔触两侧形成自然片区。
                      </span>
                    </label>
                  </div>
                )}
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    笔触颜色
                  </span>
                  <input
                    type="color"
                    value={
                      /^#[0-9a-f]{6}$/iu.test(selectedSceneStroke.color)
                        ? selectedSceneStroke.color
                        : "#8b6b4a"
                    }
                    disabled={selectedSceneStroke.tool === "erase"}
                    onChange={(event) =>
                      updateSceneStroke(selectedSceneStroke.id, {
                        color: event.target.value,
                      })
                    }
                    aria-label="笔触颜色"
                    className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)] disabled:opacity-50"
                  />
                </label>
                {!selectedSceneStrokeIsTerrainShape && (
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      透明度 · {Math.round(selectedSceneStroke.opacity * 100)}%
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={selectedSceneStroke.opacity}
                      onChange={(event) =>
                        updateSceneStroke(selectedSceneStroke.id, {
                          opacity: Number(event.target.value),
                        })
                      }
                      aria-label="笔触透明度"
                      className="w-full"
                    />
                  </label>
                )}
                <button
                  type="button"
                  onClick={() => removeSceneStroke(selectedSceneStroke.id)}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-[var(--error)] hover:bg-[var(--error-bg)]"
                >
                  <Trash2 className="h-3.5 w-3.5" /> 删除笔触
                </button>
              </div>
            ) : selectedArtworkStamp ? (
              <div
                key="artwork-stamp-inspector"
                className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-xs"
              >
                <div>
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    素材印章
                  </span>
                  <span className="block rounded-md bg-[var(--paper-inset)] px-2.5 py-1.5 font-medium">
                    {artworkDisplayName(
                      selectedArtworkStamp.assetId,
                      selectedArtworkAsset?.name,
                    )}
                  </span>
                  {selectedArtworkAsset?.component?.description && (
                    <span className="mt-1 block leading-4 text-[var(--ink-subtle)]">
                      {selectedArtworkAsset.component.description}
                    </span>
                  )}
                </div>
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    所属素材图层
                  </span>
                  <CustomSelect
                    value={selectedArtworkStamp.layerId}
                    options={(doc?.map.artwork.layers ?? [])
                      .filter(
                        (layer) =>
                          layer.id === selectedArtworkStamp.layerId ||
                          (layer.visible && !layer.locked),
                      )
                      .map((layer) => ({
                        value: layer.id,
                        label: layer.name,
                      }))}
                    onChange={(layerId) =>
                      moveArtworkStampToArtworkLayer(
                        selectedArtworkStamp.id,
                        layerId,
                      )
                    }
                    ariaLabel="所属素材图层"
                    size="sm"
                  />
                  {selectedArtworkLayer && (
                    <span className="mt-1 block text-[var(--ink-subtle)]">
                      {ARTWORK_LAYER_KIND_LABELS[selectedArtworkLayer.kind]} ·{" "}
                      {
                        ARTWORK_RENDER_PHASE_LABELS[
                          mapArtworkLayerRenderPhase(selectedArtworkLayer.kind)
                        ]
                      }
                    </span>
                  )}
                </label>
                {selectedArtworkAsset &&
                  selectedArtworkAsset.variants.length > 1 && (
                    <div>
                      <span className="mb-1.5 block text-[var(--ink-muted)]">
                        素材变体 · {(selectedArtworkVariant?.index ?? 0) + 1} /
                        {selectedArtworkAsset.variants.length}
                      </span>
                      <div className="grid grid-cols-4 gap-1.5">
                        {selectedArtworkAsset.variants.map((variant) => (
                          <button
                            key={variant.cacheKey}
                            type="button"
                            onClick={() =>
                              updateArtworkStamp(selectedArtworkStamp.id, {
                                variant: variant.index,
                              })
                            }
                            title={`使用素材变体 ${variant.index + 1}`}
                            aria-label={`使用素材变体 ${variant.index + 1}`}
                            className={`grid aspect-square min-w-0 place-items-center overflow-hidden rounded-md border bg-[var(--paper-elevated)] p-1 transition-colors ${variant.index === selectedArtworkVariant?.index ? "border-[var(--accent-warm)] bg-[var(--hover-bg)]" : "border-[var(--line)] hover:bg-[var(--hover-bg)]"}`}
                          >
                            <img
                              src={variant.imageSrc}
                              alt=""
                              draggable={false}
                              className="h-full w-full object-contain"
                            />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      缩放
                    </span>
                    <input
                      type="number"
                      min={0.05}
                      max={20}
                      step={0.05}
                      value={selectedArtworkStamp.scale ?? 1}
                      onChange={(event) =>
                        updateArtworkStamp(selectedArtworkStamp.id, {
                          scale: Math.max(
                            0.05,
                            Math.min(20, Number(event.target.value) || 1),
                          ),
                        })
                      }
                      aria-label="素材缩放"
                      className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      旋转角度
                    </span>
                    <input
                      type="number"
                      min={-360}
                      max={360}
                      step={1}
                      value={selectedArtworkStamp.rotation ?? 0}
                      onChange={(event) =>
                        updateArtworkStamp(selectedArtworkStamp.id, {
                          rotation: Number(event.target.value) || 0,
                        })
                      }
                      aria-label="素材旋转角度"
                      className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none"
                    />
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    透明度 · {Math.round(selectedArtworkStamp.opacity * 100)}%
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={selectedArtworkStamp.opacity ?? 1}
                    onChange={(event) =>
                      updateArtworkStamp(selectedArtworkStamp.id, {
                        opacity: Number(event.target.value),
                      })
                    }
                    aria-label="素材透明度"
                    className="w-full"
                  />
                </label>
                <div className="flex flex-wrap gap-3 text-[var(--ink-muted)]">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedArtworkStamp.flipX ?? false}
                      onChange={(event) =>
                        updateArtworkStamp(selectedArtworkStamp.id, {
                          flipX: event.target.checked,
                        })
                      }
                    />
                    水平翻转
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedArtworkStamp.flipY ?? false}
                      onChange={(event) =>
                        updateArtworkStamp(selectedArtworkStamp.id, {
                          flipY: event.target.checked,
                        })
                      }
                    />
                    垂直翻转
                  </label>
                </div>
                <button
                  type="button"
                  onClick={() => removeArtworkStamp(selectedArtworkStamp.id)}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-[var(--error)] hover:bg-[var(--error-bg)]"
                >
                  <Trash2 className="h-3.5 w-3.5" /> 删除素材
                </button>
              </div>
            ) : selectedFeature ? (
              <div
                key="feature-inspector"
                className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-xs"
              >
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    名称
                  </span>
                  <input
                    value={selectedFeature.name}
                    onChange={(event) =>
                      updateFeature(selectedFeature.id, {
                        name: event.target.value,
                      })
                    }
                    className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none focus:border-[var(--accent-warm)]"
                  />
                </label>
                {selectedTopologyNode && (
                  <section className="space-y-3 border-y border-[var(--line-subtle)] py-3">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-[var(--ink)]">
                        世界节点
                      </span>
                      <span
                        className="text-[var(--ink-subtle)]"
                        title={`入 ${selectedTopologyNode.incomingCount} / 出 ${selectedTopologyNode.outgoingCount}`}
                      >
                        {selectedTopologyNode.connectionCount} 条通道
                      </span>
                    </div>
                    <div className="text-xs text-[var(--ink-subtle)]">
                      入 {selectedTopologyNode.incomingCount} · 出{" "}
                      {selectedTopologyNode.outgoingCount} · 父{" "}
                      {selectedTopologyNode.parentCount} · 子{" "}
                      {selectedTopologyNode.childCount}
                    </div>
                    {selectedTopologyNode.ancestorPath && (
                      <div
                        className="truncate rounded bg-[var(--paper-inset)] px-2 py-1 text-xs text-[var(--ink-subtle)]"
                        title={`层级路径：${selectedTopologyNode.ancestorPath}`}
                      >
                        层级路径：{selectedTopologyNode.ancestorPath}
                      </div>
                    )}
                    <label className="block">
                      <span className="mb-1 block text-[var(--ink-muted)]">
                        节点说明
                      </span>
                      <textarea
                        value={selectedFeature.description}
                        onChange={(event) =>
                          updateFeature(selectedFeature.id, {
                            description: event.target.value,
                          })
                        }
                        rows={3}
                        placeholder="记录节点在世界架构中的作用、边界或叙事备注"
                        aria-label="拓扑节点说明"
                        className="w-full resize-y rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none focus:border-[var(--accent-warm)]"
                      />
                    </label>
                    <label className="flex items-center gap-2 text-[var(--ink-muted)]">
                      <input
                        type="checkbox"
                        checked={selectedTopologyNode.showLabel}
                        onChange={(event) =>
                          updateFeature(selectedFeature.id, {
                            props: {
                              ...selectedFeature.props,
                              showLabel: String(event.target.checked),
                            },
                          })
                        }
                        aria-label="显示拓扑节点标签"
                      />
                      显示节点标签
                    </label>
                    {selectedTopologyNodeRoutes.length > 0 && (
                      <div className="space-y-1">
                        <span className="block text-[var(--ink-muted)]">
                          关联通道
                        </span>
                        <div className="max-h-32 space-y-1 overflow-y-auto">
                          {selectedTopologyNodeRoutes.map(
                            ({ route, sourceName, targetName, direction }) => (
                              <button
                                key={route.id}
                                type="button"
                                onClick={() => {
                                  setActiveLayerId(route.layerId);
                                  updateMapSelection([route.id], route.id);
                                  chooseTool("select");
                                }}
                                className="flex w-full items-center gap-1.5 rounded border border-[var(--line-subtle)] px-2 py-1.5 text-left text-[var(--ink-muted)] hover:border-[var(--accent-warm)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                                aria-label={`打开拓扑通道：${route.name}`}
                              >
                                <span className="min-w-0 flex-1 truncate">
                                  {direction === "outgoing"
                                    ? "出 · "
                                    : direction === "incoming"
                                      ? "入 · "
                                      : "双向 · "}
                                  {sourceName} → {targetName}
                                </span>
                                <span className="shrink-0 text-[var(--ink-subtle)]">
                                  {getTopologyRouteRelationLabel(
                                    getTopologyRouteRelation(route),
                                  )}
                                </span>
                              </button>
                            ),
                          )}
                        </div>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          X 坐标
                        </span>
                        <input
                          type="number"
                          step={1}
                          value={Math.round(selectedFeature.points[0]?.x ?? 0)}
                          onChange={(event) => {
                            const point = selectedFeature.points[0] ?? {
                              x: 0,
                              y: 0,
                            };
                            updateTopologyNodePositions([
                              {
                                id: selectedFeature.id,
                                point: {
                                  x: Number(event.target.value) || 0,
                                  y: point.y,
                                },
                              },
                            ]);
                          }}
                          aria-label="拓扑节点 X 坐标"
                          className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none focus:border-[var(--accent-warm)]"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          Y 坐标
                        </span>
                        <input
                          type="number"
                          step={1}
                          value={Math.round(selectedFeature.points[0]?.y ?? 0)}
                          onChange={(event) => {
                            const point = selectedFeature.points[0] ?? {
                              x: 0,
                              y: 0,
                            };
                            updateTopologyNodePositions([
                              {
                                id: selectedFeature.id,
                                point: {
                                  x: point.x,
                                  y: Number(event.target.value) || 0,
                                },
                              },
                            ]);
                          }}
                          aria-label="拓扑节点 Y 坐标"
                          className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none focus:border-[var(--accent-warm)]"
                        />
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          节点类型
                        </span>
                        <CustomSelect
                          value={selectedTopologyNode.kind}
                          options={TOPOLOGY_NODE_KIND_OPTIONS.map((option) => ({
                            value: option.value,
                            label: option.label,
                          }))}
                          onChange={(kind) =>
                            updateFeature(selectedFeature.id, {
                              props: updateTopologyNodeProps(
                                selectedFeature.props,
                                { kind: kind as TopologyNodeKind },
                              ),
                            })
                          }
                          ariaLabel="拓扑节点类型"
                          size="sm"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          节点颜色
                        </span>
                        <input
                          type="color"
                          value={selectedFeature.props.color ?? "#507b88"}
                          onChange={(event) =>
                            updateFeature(selectedFeature.id, {
                              props: {
                                ...selectedFeature.props,
                                color: event.target.value,
                              },
                            })
                          }
                          aria-label="拓扑节点颜色"
                          className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]"
                        />
                      </label>
                    </div>
                    <label className="block">
                      <span className="mb-1 block text-[var(--ink-muted)]">
                        节点状态
                      </span>
                      <CustomSelect
                        value={selectedTopologyNode.status}
                        options={TOPOLOGY_NODE_STATUS_OPTIONS.map((option) => ({
                          value: option.value,
                          label: option.label,
                        }))}
                        onChange={(status) =>
                          updateFeature(selectedFeature.id, {
                            props: updateTopologyNodeProps(
                              selectedFeature.props,
                              { status: status as TopologyNodeStatus },
                            ),
                          })
                        }
                        ariaLabel="拓扑节点状态"
                        size="sm"
                      />
                    </label>
                    <label className="flex items-center gap-2 text-[var(--ink-muted)]">
                      <input
                        type="checkbox"
                        checked={selectedTopologyNode.locked}
                        onChange={(event) =>
                          toggleTopologyNodeLock(
                            selectedFeature.id,
                            event.target.checked,
                          )
                        }
                        aria-label="锁定拓扑节点"
                      />
                      锁定节点位置和连线
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[var(--ink-muted)]">
                        关联地图
                      </span>
                      <CustomSelect
                        value={selectedTopologyNode.linkedMapId ?? ""}
                        options={[
                          { value: "", label: "（未关联地图）" },
                          ...(selectedTopologyNode.linkedMapId &&
                          !selectedTopologyLinkedMap
                            ? [
                                {
                                  value: selectedTopologyNode.linkedMapId,
                                  label: `（失效关联：${selectedTopologyNode.linkedMapId}）`,
                                },
                              ]
                            : []),
                          ...maps
                            .filter((map) => map.id !== doc?.map.id)
                            .map((map) => ({
                              value: map.id,
                              label: `${map.name}（${MAP_PROJECTION_LABELS[map.projectionType]}）`,
                            })),
                        ]}
                        onChange={(linkedMapId) =>
                          updateFeature(selectedFeature.id, {
                            props: updateTopologyNodeProps(
                              selectedFeature.props,
                              { linkedMapId: linkedMapId || null },
                            ),
                          })
                        }
                        ariaLabel="关联地图"
                        size="sm"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[var(--ink-muted)]">
                        关联设定或实体
                      </span>
                      <CustomSelect
                        value={
                          selectedTopologyNode.entityRef
                            ? `${selectedTopologyNode.entityRef.kind}:${selectedTopologyNode.entityRef.id}`
                            : ""
                        }
                        options={[
                          { value: "", label: "（未关联设定或实体）" },
                          ...(selectedTopologyNode.entityRef &&
                          !selectedTopologyEntity &&
                          !selectedTopologySetting
                            ? [
                                {
                                  value: `${selectedTopologyNode.entityRef.kind}:${selectedTopologyNode.entityRef.id}`,
                                  label: `（失效关联：${selectedTopologyNode.entityRef.id}）`,
                                },
                              ]
                            : []),
                          ...topologySettingSelectOptions,
                          ...topologyEntitySelectOptions,
                        ]}
                        onChange={(value) => {
                          const separator = value.indexOf(":");
                          if (separator <= 0) {
                            updateFeature(selectedFeature.id, {
                              entityRef: null,
                            });
                            return;
                          }
                          const kind = value.slice(0, separator);
                          const id = value.slice(separator + 1);
                          if (
                            kind !== "setting" &&
                            !entityOptions.some(
                              (entity) =>
                                entity.kind === kind && entity.id === id,
                            )
                          ) {
                            return;
                          }
                          updateFeature(selectedFeature.id, {
                            entityRef: {
                              kind: kind as MapEntityKind,
                              id,
                            },
                          });
                        }}
                        ariaLabel="拓扑节点关联设定或实体"
                        size="sm"
                      />
                      {selectedTopologyNode.settingRef &&
                        topologySettingById.get(
                          selectedTopologyNode.settingRef.id,
                        ) && (
                          <p className="mt-1 text-xs text-[var(--ink-subtle)]">
                            架构路径：
                            {
                              topologySettingById.get(
                                selectedTopologyNode.settingRef.id,
                              )!.label
                            }
                          </p>
                        )}
                      {selectedTopologyNode.entityRef?.kind !== "setting" &&
                        selectedTopologyEntity && (
                          <p className="mt-1 text-xs text-[var(--ink-subtle)]">
                            {
                              DOMAIN_ENTITY_KIND_LABELS[
                                selectedTopologyEntity.kind
                              ]
                            }
                            ：{selectedTopologyEntity.name}
                          </p>
                        )}
                    </label>
                    {!selectedTopologyNode.linkedMapId && (
                      <button
                        type="button"
                        onClick={() => {
                          beginTopologyNodeMapCreation(selectedFeature.id);
                        }}
                        title="按当前节点类型新建子地图，并自动关联回这个节点"
                        className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                      >
                        <Plus className="h-3.5 w-3.5" /> 新建关联地图
                      </button>
                    )}
                    {selectedTopologyNode.linkedMapId && (
                      <button
                        type="button"
                        disabled={
                          !maps.some(
                            (map) =>
                              map.id === selectedTopologyNode.linkedMapId,
                          )
                        }
                        onClick={() =>
                          void openMap(selectedTopologyNode.linkedMapId!)
                        }
                        className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <Globe2 className="h-3.5 w-3.5" />
                        打开关联地图
                      </button>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          createConnectedTopologyNodeFromSelection("incoming")
                        }
                        title="使用顶部的新节点与新通道设置，在当前节点左侧创建前置节点"
                        className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-[var(--line)] px-2 text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                      >
                        <Plus className="h-3.5 w-3.5" /> 前置节点
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          createConnectedTopologyNodeFromSelection("outgoing")
                        }
                        title="使用顶部的新节点与新通道设置，在当前节点右侧创建后继节点"
                        className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-[var(--line)] px-2 text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                      >
                        <Plus className="h-3.5 w-3.5" /> 后继节点
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          createHierarchyTopologyNodeFromCanvas(
                            selectedFeature.id,
                            "incoming",
                          )
                        }
                        title="创建一个以当前节点为子节点的父级分支"
                        className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-[var(--line)] px-2 text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                      >
                        <GitBranch className="h-3.5 w-3.5 rotate-180" /> 父节点
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          createHierarchyTopologyNodeFromCanvas(
                            selectedFeature.id,
                            "outgoing",
                          )
                        }
                        title="创建当前节点的子级分支"
                        className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-[var(--line)] px-2 text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                      >
                        <GitBranch className="h-3.5 w-3.5" /> 子节点
                      </button>
                    </div>
                  </section>
                )}
                {selectedTopologyRoute && (
                  <section className="space-y-3 border-y border-[var(--line-subtle)] py-3">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-[var(--ink)]">
                        {getTopologyRouteRelationLabel(
                          selectedTopologyRoute.relation,
                        )}
                      </span>
                      <span className="text-[var(--ink-subtle)]">
                        端点决定线路位置
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          来源节点
                        </span>
                        <CustomSelect
                          value={selectedTopologyRoute.sourceNodeId}
                          options={topologyNodeOptions}
                          onChange={(sourceNodeId) =>
                            reconnectTopologyRoute(
                              selectedFeature.id,
                              sourceNodeId,
                              selectedTopologyRoute.targetNodeId,
                            )
                          }
                          ariaLabel="拓扑来源节点"
                          size="sm"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          目标节点
                        </span>
                        <CustomSelect
                          value={selectedTopologyRoute.targetNodeId}
                          options={topologyNodeOptions}
                          onChange={(targetNodeId) =>
                            reconnectTopologyRoute(
                              selectedFeature.id,
                              selectedTopologyRoute.sourceNodeId,
                              targetNodeId,
                            )
                          }
                          ariaLabel="拓扑目标节点"
                          size="sm"
                        />
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          通道关系
                        </span>
                        <CustomSelect
                          value={selectedTopologyRoute.relation}
                          options={TOPOLOGY_ROUTE_RELATION_OPTIONS.map(
                            (option) => ({
                              value: option.value,
                              label: option.label,
                            }),
                          )}
                          onChange={(relation) => {
                            updateTopologyRouteFromInspector(
                              selectedFeature.id,
                              { relation: relation as TopologyRouteRelation },
                            );
                          }}
                          ariaLabel="拓扑通道关系"
                          size="sm"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          行进方向
                        </span>
                        <CustomSelect
                          value={selectedTopologyRoute.direction}
                          options={[
                            { value: "two-way", label: "双向" },
                            { value: "one-way", label: "单向" },
                          ]}
                          onChange={(direction) =>
                            updateTopologyRouteFromInspector(
                              selectedFeature.id,
                              {
                                direction: direction as TopologyRouteDirection,
                              },
                            )
                          }
                          ariaLabel="拓扑行进方向"
                          size="sm"
                        />
                      </label>
                    </div>
                    <label className="flex items-center gap-2 text-[var(--ink-muted)]">
                      <input
                        type="checkbox"
                        checked={selectedTopologyRoute.showLabel}
                        onChange={(event) =>
                          updateFeature(selectedFeature.id, {
                            props: {
                              ...selectedFeature.props,
                              showLabel: String(event.target.checked),
                            },
                          })
                        }
                        aria-label="显示拓扑通道标签"
                      />
                      显示通道标签
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          通道颜色
                        </span>
                        <input
                          type="color"
                          value={selectedFeature.props.color ?? "#8e6044"}
                          onChange={(event) =>
                            updateFeature(selectedFeature.id, {
                              props: {
                                ...selectedFeature.props,
                                color: event.target.value,
                              },
                            })
                          }
                          aria-label="拓扑通道颜色"
                          className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          线宽
                        </span>
                        <input
                          type="number"
                          min={1}
                          max={24}
                          step={1}
                          value={selectedFeature.props.lineWidth ?? "2"}
                          onChange={(event) =>
                            updateFeature(selectedFeature.id, {
                              props: {
                                ...selectedFeature.props,
                                lineWidth: String(
                                  Math.max(
                                    1,
                                    Math.min(
                                      24,
                                      Number(event.target.value) || 2,
                                    ),
                                  ),
                                ),
                              },
                            })
                          }
                          aria-label="拓扑通道线宽"
                          className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none"
                        />
                      </label>
                    </div>
                    <label className="flex items-center gap-2 text-[var(--ink-muted)]">
                      <input
                        type="checkbox"
                        checked={selectedFeature.props.animated === "true"}
                        onChange={(event) =>
                          updateFeature(selectedFeature.id, {
                            props: {
                              ...selectedFeature.props,
                              animated: String(event.target.checked),
                            },
                          })
                        }
                      />
                      动态通道
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={reverseSelectedTopologyRoute}
                        title="交换通道的来源节点和目标节点"
                        className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-[var(--line)] px-2 text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                      >
                        <GitCompareArrows className="h-3.5 w-3.5" /> 反转方向
                      </button>
                      <button
                        type="button"
                        onClick={insertTopologyNodeFromSelection}
                        title="在当前通道中点插入一个新节点，并将通道拆成两段"
                        className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-[var(--line)] px-2 text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                      >
                        <Plus className="h-3.5 w-3.5" /> 插入节点
                      </button>
                    </div>
                  </section>
                )}
                {selectedFeature.kind !== "node" &&
                  !selectedTopologyRoute &&
                  (!selectedRouteStyle ||
                    selectedRouteStyle.id === "plain") && (
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          {selectedRiverStyle ? "水色" : "线条颜色"}
                        </span>
                        <input
                          type="color"
                          value={selectedFeature.props.color ?? "#b26d45"}
                          onChange={(event) =>
                            updateFeature(selectedFeature.id, {
                              props: {
                                ...selectedFeature.props,
                                color: event.target.value,
                              },
                            })
                          }
                          className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]"
                        />
                      </label>
                      {selectedRiverStyle ? (
                        <label className="block">
                          <span className="mb-1 block text-[var(--ink-muted)]">
                            岸线色
                          </span>
                          <input
                            type="color"
                            value={selectedRiverStyle.bankColor}
                            onChange={(event) =>
                              updateFeature(selectedFeature.id, {
                                props: {
                                  ...selectedFeature.props,
                                  bankColor: event.target.value,
                                },
                              })
                            }
                            aria-label="河流岸线颜色"
                            className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]"
                          />
                        </label>
                      ) : (
                        <label className="block">
                          <span className="mb-1 block text-[var(--ink-muted)]">
                            线宽
                          </span>
                          <input
                            type="number"
                            min={1}
                            max={12}
                            value={selectedFeature.props.lineWidth ?? "2"}
                            onChange={(event) =>
                              updateFeature(selectedFeature.id, {
                                props: {
                                  ...selectedFeature.props,
                                  lineWidth: String(
                                    Math.max(
                                      1,
                                      Math.min(
                                        12,
                                        Number(event.target.value) || 2,
                                      ),
                                    ),
                                  ),
                                },
                              })
                            }
                            className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none"
                          />
                        </label>
                      )}
                    </div>
                  )}
                {(selectedFeature.kind === "area" ||
                  selectedFeature.kind === "route") && (
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      中心线
                    </span>
                    <CustomSelect
                      value={
                        selectedFeature.props.curve === "arc" ? "arc" : "line"
                      }
                      options={[
                        { value: "line", label: "直线触点" },
                        { value: "arc", label: "弧线触点" },
                      ]}
                      onChange={(value) =>
                        updateFeature(selectedFeature.id, {
                          props: {
                            ...selectedFeature.props,
                            curve: value,
                          },
                        })
                      }
                      ariaLabel="要素中心线"
                      size="sm"
                    />
                  </label>
                )}
                {selectedAreaStyle && (
                  <section className="space-y-2 border-y border-[var(--line-subtle)] py-3">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-[var(--ink)]">
                        画笔填充
                      </span>
                      <span className="text-[var(--ink-subtle)]">
                        {Math.round(selectedAreaStyle.opacity * 100)}%
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          填充颜色
                        </span>
                        <input
                          type="color"
                          value={selectedAreaStyle.fill}
                          onChange={(event) =>
                            updateFeature(selectedFeature.id, {
                              props: {
                                ...selectedFeature.props,
                                fill: event.target.value,
                              },
                            })
                          }
                          aria-label="画笔填充颜色"
                          className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          填充透明度
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={
                            Math.round(selectedAreaStyle.opacity * 20) / 20
                          }
                          onChange={(event) =>
                            updateFeature(selectedFeature.id, {
                              props: {
                                ...selectedFeature.props,
                                fillOpacity: event.target.value,
                              },
                            })
                          }
                          aria-label="画笔填充透明度"
                          className="mt-2 w-full accent-[var(--accent-warm)]"
                        />
                      </label>
                    </div>
                  </section>
                )}
                {selectedAreaStyle &&
                  isMapFeatureFreeformArea(selectedFeature.kind) &&
                  selectedFreehandAreaClosed && (
                    <section className="space-y-2 border-b border-[var(--line-subtle)] pb-3">
                      <div>
                        <span className="font-medium text-[var(--ink)]">
                          画笔结果处理
                        </span>
                        <span className="mt-1 block text-[var(--ink-subtle)]">
                          将闭合画笔转为可合成的陆地、水域或带材质区域。
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            promoteFreeformArea(selectedFeature.id, "land")
                          }
                          className="flex h-8 items-center justify-center gap-1 rounded-md border border-[var(--line)] px-2 text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                        >
                          <LandPlot className="h-3.5 w-3.5" /> 设为陆地
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            promoteFreeformArea(selectedFeature.id, "water")
                          }
                          className="flex h-8 items-center justify-center gap-1 rounded-md border border-[var(--line)] px-2 text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                        >
                          <Waves className="h-3.5 w-3.5" /> 设为水域
                        </button>
                      </div>
                      <CustomSelect
                        value=""
                        options={[
                          { value: "", label: "附加材质并转为区域" },
                          ...MAP_TERRAIN_MATERIAL_PRESETS.map((preset) => ({
                            value: preset.id,
                            label: `${preset.name} · ${preset.surface === "land" ? "陆地" : "水域"}`,
                          })),
                        ]}
                        onChange={(value) => {
                          if (!value) return;
                          const material = value as MapTerrainMaterial;
                          promoteFreeformArea(
                            selectedFeature.id,
                            getMapTerrainMaterialPreset(material).surface,
                            material,
                          );
                        }}
                        ariaLabel="画笔区域附加材质"
                        size="sm"
                      />
                    </section>
                  )}
                {selectedRiverStyle && (
                  <div className="space-y-2 border-y border-[var(--line-subtle)] py-3">
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          源头宽度
                        </span>
                        <input
                          type="number"
                          min={0.5}
                          max={64}
                          step={0.5}
                          value={selectedRiverStyle.sourceWidth}
                          onChange={(event) => {
                            const sourceWidth = Math.max(
                              0.5,
                              Math.min(64, Number(event.target.value) || 0.5),
                            );
                            updateFeature(selectedFeature.id, {
                              props: {
                                ...selectedFeature.props,
                                sourceWidth: String(sourceWidth),
                                mouthWidth: String(
                                  Math.max(
                                    sourceWidth,
                                    selectedRiverStyle.mouthWidth,
                                  ),
                                ),
                              },
                            });
                          }}
                          aria-label="河流源头宽度"
                          className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          河口宽度
                        </span>
                        <input
                          type="number"
                          min={selectedRiverStyle.sourceWidth}
                          max={96}
                          step={0.5}
                          value={selectedRiverStyle.mouthWidth}
                          onChange={(event) =>
                            updateFeature(selectedFeature.id, {
                              props: {
                                ...selectedFeature.props,
                                mouthWidth: String(
                                  Math.max(
                                    selectedRiverStyle.sourceWidth,
                                    Math.min(
                                      96,
                                      Number(event.target.value) ||
                                        selectedRiverStyle.sourceWidth,
                                    ),
                                  ),
                                ),
                              },
                            })
                          }
                          aria-label="河流河口宽度"
                          className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none"
                        />
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        updateFeature(
                          selectedFeature.id,
                          reverseMapRiverFeature(selectedFeature),
                        )
                      }
                      className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                    >
                      <GitCompareArrows className="h-3.5 w-3.5 rotate-90" />
                      反转源头与河口
                    </button>
                  </div>
                )}
                {selectedRouteStyle && (
                  <section className="space-y-3 border-y border-[var(--line-subtle)] py-3">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-[var(--ink)]">
                        路线外观
                      </span>
                      <span className="text-[var(--ink-subtle)]">
                        {selectedRouteStyle.id === "plain"
                          ? "单线"
                          : `${selectedRouteStyle.width}px`}
                      </span>
                    </div>
                    <CustomSelect
                      value={selectedRouteStyle.id}
                      options={MAP_ROUTE_STYLE_OPTIONS.map((option) => ({
                        value: option.id,
                        label: option.name,
                      }))}
                      onChange={(routeStyle) =>
                        updateFeature(selectedFeature.id, {
                          props: {
                            ...selectedFeature.props,
                            routeStyle,
                            terrain:
                              routeStyle === "wall"
                                ? "wall"
                                : routeStyle === "border"
                                  ? "border"
                                  : routeStyle === "road" ||
                                      routeStyle === "paved" ||
                                      routeStyle === "trail"
                                    ? "road"
                                    : (selectedFeature.props.terrain ?? ""),
                          },
                        })
                      }
                      ariaLabel="路线样式"
                      size="sm"
                    />
                    {selectedRouteStyle.id !== "plain" && (
                      <div className="grid grid-cols-2 gap-2">
                        <label className="block">
                          <span className="mb-1 block text-[var(--ink-muted)]">
                            主体颜色
                          </span>
                          <input
                            type="color"
                            value={selectedRouteStyle.color}
                            onChange={(event) =>
                              updateFeature(selectedFeature.id, {
                                props: {
                                  ...selectedFeature.props,
                                  routeColor: event.target.value,
                                },
                              })
                            }
                            aria-label="路线主体颜色"
                            className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]"
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[var(--ink-muted)]">
                            边缘颜色
                          </span>
                          <input
                            type="color"
                            value={selectedRouteStyle.casingColor}
                            onChange={(event) =>
                              updateFeature(selectedFeature.id, {
                                props: {
                                  ...selectedFeature.props,
                                  routeCasingColor: event.target.value,
                                },
                              })
                            }
                            aria-label="路线边缘颜色"
                            className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]"
                          />
                        </label>
                        <label className="col-span-2 block">
                          <span className="mb-1 flex justify-between text-[var(--ink-muted)]">
                            <span>主体宽度</span>
                            <span>{selectedRouteStyle.width}px</span>
                          </span>
                          <input
                            type="range"
                            min={1}
                            max={64}
                            step={0.5}
                            value={selectedRouteStyle.width}
                            onChange={(event) =>
                              updateFeature(selectedFeature.id, {
                                props: {
                                  ...selectedFeature.props,
                                  routeWidth: event.target.value,
                                },
                              })
                            }
                            aria-label="路线主体宽度"
                            className="w-full accent-[var(--accent-warm)]"
                          />
                        </label>
                      </div>
                    )}
                  </section>
                )}
                <label className="flex items-center gap-2 text-[var(--ink-muted)]">
                  <input
                    type="checkbox"
                    checked={
                      selectedFeature.props.showLabel === "true" ||
                      selectedFeature.kind === "label"
                    }
                    disabled={selectedFeature.kind === "label"}
                    onChange={(event) =>
                      updateFeature(selectedFeature.id, {
                        props: {
                          ...selectedFeature.props,
                          showLabel: String(event.target.checked),
                        },
                      })
                    }
                  />
                  显示名称
                </label>
                {selectedLabelStyle && (
                  <section className="space-y-3 border-y border-[var(--line-subtle)] py-3">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-[var(--ink)]">
                        标签排版
                      </span>
                      <span className="text-[var(--ink-subtle)]">
                        {selectedLabelStyle.fontSize}px
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {MAP_LABEL_STYLE_PRESETS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() =>
                            updateFeature(selectedFeature.id, {
                              props: {
                                ...selectedFeature.props,
                                ...preset.props,
                                showLabel: "true",
                              },
                            })
                          }
                          aria-label={`应用${preset.name}标签样式`}
                          className="h-8 rounded-md border border-[var(--line)] px-2 text-left text-[var(--ink-muted)] hover:border-[var(--accent-warm)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                        >
                          {preset.name}
                        </button>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          字体
                        </span>
                        <CustomSelect
                          value={selectedLabelStyle.fontId}
                          options={MAP_LABEL_FONT_OPTIONS.map((option) => ({
                            value: option.id,
                            label: option.name,
                          }))}
                          onChange={(labelFont) =>
                            updateFeature(selectedFeature.id, {
                              props: {
                                ...selectedFeature.props,
                                labelFont,
                              },
                            })
                          }
                          ariaLabel="标签字体"
                          size="sm"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          字号
                        </span>
                        <input
                          type="number"
                          min={8}
                          max={96}
                          value={selectedLabelStyle.fontSize}
                          onChange={(event) =>
                            updateFeature(selectedFeature.id, {
                              props: {
                                ...selectedFeature.props,
                                labelSize: String(
                                  Math.max(
                                    8,
                                    Math.min(
                                      96,
                                      Number(event.target.value) || 8,
                                    ),
                                  ),
                                ),
                              },
                            })
                          }
                          aria-label="标签字号"
                          className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none focus:border-[var(--accent-warm)]"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          字重
                        </span>
                        <CustomSelect
                          value={String(selectedLabelStyle.fontWeight)}
                          options={[
                            { value: "400", label: "常规" },
                            { value: "600", label: "半粗" },
                            { value: "700", label: "粗体" },
                          ]}
                          onChange={(labelWeight) =>
                            updateFeature(selectedFeature.id, {
                              props: {
                                ...selectedFeature.props,
                                labelWeight,
                              },
                            })
                          }
                          ariaLabel="标签字重"
                          size="sm"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          旋转角度
                        </span>
                        <input
                          type="number"
                          min={-180}
                          max={180}
                          value={selectedLabelStyle.rotation}
                          onChange={(event) =>
                            updateFeature(selectedFeature.id, {
                              props: {
                                ...selectedFeature.props,
                                labelRotation: String(
                                  Math.max(
                                    -180,
                                    Math.min(
                                      180,
                                      Number(event.target.value) || 0,
                                    ),
                                  ),
                                ),
                              },
                            })
                          }
                          aria-label="标签旋转角度"
                          className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none focus:border-[var(--accent-warm)]"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          文字颜色
                        </span>
                        <input
                          type="color"
                          value={selectedLabelStyle.color}
                          onChange={(event) =>
                            updateFeature(selectedFeature.id, {
                              props: {
                                ...selectedFeature.props,
                                labelColor: event.target.value,
                              },
                            })
                          }
                          aria-label="标签文字颜色"
                          className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          描边颜色
                        </span>
                        <input
                          type="color"
                          value={selectedLabelStyle.haloColor}
                          onChange={(event) =>
                            updateFeature(selectedFeature.id, {
                              props: {
                                ...selectedFeature.props,
                                labelHaloColor: event.target.value,
                              },
                            })
                          }
                          aria-label="标签描边颜色"
                          className="h-8 w-full rounded border border-[var(--line)] bg-[var(--paper-elevated)]"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          水平偏移
                        </span>
                        <input
                          type="number"
                          min={-800}
                          max={800}
                          value={selectedLabelStyle.offsetX}
                          onChange={(event) =>
                            updateFeature(selectedFeature.id, {
                              props: {
                                ...selectedFeature.props,
                                labelOffsetX: String(
                                  Math.max(
                                    -800,
                                    Math.min(
                                      800,
                                      Number(event.target.value) || 0,
                                    ),
                                  ),
                                ),
                              },
                            })
                          }
                          aria-label="标签水平偏移"
                          className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none focus:border-[var(--accent-warm)]"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[var(--ink-muted)]">
                          垂直偏移
                        </span>
                        <input
                          type="number"
                          min={-800}
                          max={800}
                          value={selectedLabelStyle.offsetY}
                          onChange={(event) =>
                            updateFeature(selectedFeature.id, {
                              props: {
                                ...selectedFeature.props,
                                labelOffsetY: String(
                                  Math.max(
                                    -800,
                                    Math.min(
                                      800,
                                      Number(event.target.value) || 0,
                                    ),
                                  ),
                                ),
                              },
                            })
                          }
                          aria-label="标签垂直偏移"
                          className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none focus:border-[var(--accent-warm)]"
                        />
                      </label>
                    </div>
                    <label className="block">
                      <span className="mb-1 flex justify-between text-[var(--ink-muted)]">
                        <span>描边宽度</span>
                        <span>{selectedLabelStyle.haloWidth}px</span>
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={12}
                        step={0.5}
                        value={selectedLabelStyle.haloWidth}
                        onChange={(event) =>
                          updateFeature(selectedFeature.id, {
                            props: {
                              ...selectedFeature.props,
                              labelHaloWidth: event.target.value,
                            },
                          })
                        }
                        aria-label="标签描边宽度"
                        className="w-full accent-[var(--accent-warm)]"
                      />
                    </label>
                    <div className="flex flex-wrap gap-x-4 gap-y-2 text-[var(--ink-muted)]">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedLabelStyle.italic}
                          onChange={(event) =>
                            updateFeature(selectedFeature.id, {
                              props: {
                                ...selectedFeature.props,
                                labelItalic: String(event.target.checked),
                              },
                            })
                          }
                        />
                        斜体
                      </label>
                      {selectedFeature.kind === "route" && (
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selectedLabelStyle.followPath}
                            onChange={(event) =>
                              updateFeature(selectedFeature.id, {
                                props: {
                                  ...selectedFeature.props,
                                  labelFollowPath: String(event.target.checked),
                                },
                              })
                            }
                          />
                          沿路线方向
                        </label>
                      )}
                    </div>
                  </section>
                )}
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    类型
                  </span>
                  <span className="block rounded-md bg-[var(--paper-inset)] px-2.5 py-1.5">
                    {FEATURE_KIND_LABELS[selectedFeature.kind]}
                  </span>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    所属图层
                  </span>
                  <CustomSelect
                    value={selectedFeature.layerId}
                    options={(doc?.map.layers ?? []).map((layer) => ({
                      value: layer.id,
                      label: layer.name,
                    }))}
                    onChange={(layerId) =>
                      moveFeatureToLayer(selectedFeature.id, layerId)
                    }
                    ariaLabel="所属图层"
                    size="sm"
                  />
                </label>
                <div className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    关联实体（派生）
                  </span>
                  {selectedFeature.entityRef ? (
                    <span className="block rounded-md bg-[var(--paper-inset)] px-2.5 py-1.5">
                      {entityOptions.find(
                        (option) =>
                          option.id === selectedFeature.entityRef?.id &&
                          option.kind === selectedFeature.entityRef?.kind,
                      )?.name ?? selectedFeature.entityRef.id}
                      <span className="ml-1 text-[var(--ink-subtle)]">
                        ({selectedFeature.entityRef.kind})
                      </span>
                    </span>
                  ) : (
                    <span className="block rounded-md bg-[var(--paper-inset)] px-2.5 py-1.5 text-[var(--ink-muted)]">
                      未关联实体
                    </span>
                  )}
                </div>
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    修改关联实体
                  </span>
                  <CustomSelect
                    value={
                      selectedFeature.entityRef
                        ? `${selectedFeature.entityRef.kind}:${selectedFeature.entityRef.id}`
                        : ""
                    }
                    options={[
                      { value: "", label: "（不关联）" },
                      ...entityOptions.map((option) => ({
                        value: `${option.kind}:${option.id}`,
                        label: `${option.name}（${option.kind}）`,
                      })),
                    ]}
                    onChange={(value) => {
                      const [kind, id] = value.split(":");
                      const entity = entityOptions.find(
                        (option) => option.kind === kind && option.id === id,
                      );
                      updateFeature(selectedFeature.id, {
                        entityRef: entity
                          ? {
                              kind: entity.kind as MapEntityKind,
                              id: entity.id,
                            }
                          : null,
                      });
                    }}
                    ariaLabel="关联实体"
                    size="sm"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      时间起点
                    </span>
                    <input
                      type="number"
                      value={selectedFeature.timeFrom ?? ""}
                      onChange={(event) =>
                        updateFeature(selectedFeature.id, {
                          timeFrom:
                            event.target.value === ""
                              ? null
                              : Number(event.target.value),
                        })
                      }
                      placeholder="长期或未知"
                      className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[var(--ink-muted)]">
                      时间终点
                    </span>
                    <input
                      type="number"
                      value={selectedFeature.timeTo ?? ""}
                      onChange={(event) =>
                        updateFeature(selectedFeature.id, {
                          timeTo:
                            event.target.value === ""
                              ? null
                              : Number(event.target.value),
                        })
                      }
                      placeholder="长期或未知"
                      className="w-full rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none"
                    />
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1 block text-[var(--ink-muted)]">
                    说明
                  </span>
                  <textarea
                    value={selectedFeature.description}
                    onChange={(event) =>
                      updateFeature(selectedFeature.id, {
                        description: event.target.value,
                      })
                    }
                    rows={3}
                    className="w-full resize-none rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 outline-none"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => removeFeature(selectedFeature.id)}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-[var(--error)] hover:bg-[var(--error-bg)]"
                >
                  <Trash2 className="h-3.5 w-3.5" /> 删除要素
                </button>
              </div>
            ) : null}
          </aside>
        </div>
      )}

      {newMapOpen && (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center bg-black/30 px-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setNewMapOpen(false);
              setNewMapLinkNodeId(null);
            }
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createMap();
            }}
            className="w-full max-w-sm rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xl"
          >
            <h2 className="text-base font-semibold">新建地图</h2>
            <label className="mt-4 block text-sm">
              <span className="mb-1 block text-[var(--ink-muted)]">名称</span>
              <input
                value={newMapName}
                onChange={(event) => setNewMapName(event.target.value)}
                autoFocus
                placeholder="例如：九州全图"
                className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm outline-none focus:border-[var(--accent-warm)]"
              />
            </label>
            <label className="mt-3 block text-sm">
              <span className="mb-1 block text-[var(--ink-muted)]">
                投影类型
              </span>
              <CustomSelect
                value={newMapProjection}
                options={Object.entries(MAP_PROJECTION_LABELS).map(
                  ([value, label]) => ({ value, label }),
                )}
                onChange={(value) =>
                  setNewMapProjection(value as MapProjectionType)
                }
                ariaLabel="投影类型"
                size="sm"
              />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setNewMapOpen(false);
                  setNewMapLinkNodeId(null);
                }}
                className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
              >
                取消
              </button>
              <button
                type="submit"
                className="flex items-center gap-1.5 rounded-md bg-[var(--accent-warm)] px-3 py-1.5 text-sm font-medium text-white"
              >
                <Check className="h-3.5 w-3.5" /> 创建
              </button>
            </div>
          </form>
        </div>
      )}

      {proposalReviewOpen && (
        <MapProposalReview
          storage={storage}
          projectTitle={projectTitle}
          onApplied={() => void loadMaps()}
          onClose={() => setProposalReviewOpen(false)}
        />
      )}
      {generatorOpen && doc && (
        <MapGeneratorDialog
          document={doc.map}
          activeLayerId={activeLayerId}
          storage={storage}
          projectTitle={projectTitle}
          agentAvailable={agentAvailable && Boolean(onLaunchMapAgent)}
          agentLaunching={agentLaunching}
          onLaunchAgent={async (request) => {
            if (!onLaunchMapAgent) {
              throw new Error("MyAgents Agent Session 当前不可用");
            }
            await onLaunchMapAgent(request);
          }}
          onApply={applyGeneratedCandidate}
          onClose={() => setGeneratorOpen(false)}
        />
      )}
      {deleteArtworkLayerTarget && doc && (
        <ConfirmDialog
          title="删除素材图层"
          message={`“${findMapArtworkLayer(doc.map.artwork, deleteArtworkLayerTarget.layerId)?.name ?? deleteArtworkLayerTarget.layerId}”中的 ${findMapArtworkLayer(doc.map.artwork, deleteArtworkLayerTarget.layerId)?.stamps.length ?? 0} 个素材印章会转移到“${findMapArtworkLayer(doc.map.artwork, deleteArtworkLayerTarget.targetLayerId)?.name ?? deleteArtworkLayerTarget.targetLayerId}”，确定删除吗？`}
          confirmText="转移并删除"
          confirmVariant="danger"
          onConfirm={() => {
            deleteArtworkLayer(
              deleteArtworkLayerTarget.layerId,
              deleteArtworkLayerTarget.targetLayerId,
            );
            setDeleteArtworkLayerTarget(null);
          }}
          onCancel={() => setDeleteArtworkLayerTarget(null)}
        />
      )}
      {deleteMapTarget && (
        <ConfirmDialog
          title="删除地图"
          message={`确定要删除地图“${maps.find((entry) => entry.id === deleteMapTarget)?.name ?? deleteMapTarget}”吗？其记录文件会被移除。`}
          confirmText="删除"
          confirmVariant="danger"
          onConfirm={() => {
            void (async () => {
              try {
                await repository.deleteMap(deleteMapTarget);
                if (selectedMapId === deleteMapTarget) {
                  replaceDoc(null);
                  setSelectedMapId(null);
                }
                await loadMaps();
              } catch (cause) {
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
              } finally {
                setDeleteMapTarget(null);
              }
            })();
          }}
          onCancel={() => setDeleteMapTarget(null)}
        />
      )}
    </div>
  );
}
