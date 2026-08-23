import { mapRendererForProjection } from "../business/mapRenderer";
import type {
  MapArtworkStamp,
  MapDocument,
  MapFeature,
  MapSceneRegion,
  MapBrushPointCurve,
  MapSceneLayerKind,
  MapTerrainMaterial,
} from "../entities/mapSchema";
import type {
  MapCanvasSettings,
  MapCanvasTool,
} from "../business/mapCanvasSession";
import OpenLayersMapCanvas from "./OpenLayersMapCanvas";
import XYFlowTopologyCanvas from "./XYFlowTopologyCanvas";
import type { MapComponentPlacementGesture } from "../business/mapComponents";
import type { MapArtworkStampPlacementGesture } from "../business/mapArtworkTransform";
import type {
  TopologyNodeKind,
  TopologyNodeStatus,
  TopologyRouteDirection,
  TopologyRouteRelation,
} from "../business/topologyMap";

interface MapRendererCanvasProps {
  readonly document: MapDocument;
  readonly tool: MapCanvasTool;
  readonly settings?: MapCanvasSettings;
  readonly activeLayerId: string;
  readonly selectedFeatureId: string | null;
  /** 地理画布的临时框选状态；不保存到 MapDocument。 */
  readonly selectedFeatureIds?: readonly string[];
  readonly focusRequest?: number;
  readonly documentRebase?: {
    readonly revision: number;
    readonly translation: { readonly x: number; readonly y: number };
  } | null;
  readonly timelineCursor: number | null;
  readonly onSelect: (featureId: string | null) => void;
  readonly onSelectionChange?: (
    featureIds: readonly string[],
    primaryFeatureId: string | null,
  ) => void;
  readonly onCreateGroup?: (itemIds: readonly string[]) => void;
  readonly onUngroup?: (groupId: string) => void;
  readonly onSetItemsLocked?: (
    itemIds: readonly string[],
    locked: boolean,
  ) => void;
  readonly onCreate: (feature: MapFeature) => void;
  readonly onTopologyNodePlaced?: () => void;
  readonly onComponentDrop: (
    componentId: string,
    point: { readonly x: number; readonly y: number },
    gesture?: MapComponentPlacementGesture,
  ) => void;
  readonly onComponentSurface: (
    componentId: string,
    points: readonly { readonly x: number; readonly y: number }[],
    closed: boolean,
    curve: MapBrushPointCurve,
  ) => void;
  readonly artworkBrushAssetId?: string | null;
  readonly artworkBrushColor?: string | null;
  readonly artworkBrushLayerKind?: MapSceneLayerKind;
  readonly activeStampAssetId?: string | null;
  readonly activePrefabComponentId?: string | null;
  readonly activeTerrainMaterial?: MapTerrainMaterial | null;
  readonly projectArtworkSources?: ReadonlyMap<string, string>;
  readonly topologyLinkedMapNames?: ReadonlyMap<string, string>;
  readonly topologyEntityNames?: ReadonlyMap<string, string>;
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
  readonly onSceneStroke: (
    assetId: string,
    points: readonly { readonly x: number; readonly y: number }[],
  ) => void;
  readonly onSceneErase: (
    points: readonly { readonly x: number; readonly y: number }[],
  ) => void;
  readonly onTerrainStroke: (
    kind: MapSceneRegion["kind"],
    points: readonly { readonly x: number; readonly y: number }[],
  ) => void;
  readonly onTerrainMaterialStroke: (
    material: MapTerrainMaterial,
    points: readonly { readonly x: number; readonly y: number }[],
  ) => void;
  readonly onTerrainMaterialRejected?: () => void;
  readonly onSceneStrokeMove: (
    strokeId: string,
    points: readonly { readonly x: number; readonly y: number }[],
  ) => void;
  readonly onSceneRegionCreate: (
    kind: MapSceneRegion["kind"],
    points: readonly { readonly x: number; readonly y: number }[],
    curve?: MapBrushPointCurve,
  ) => void;
  readonly onSceneRegionMove: (
    regionId: string,
    points: readonly { readonly x: number; readonly y: number }[],
  ) => void;
  readonly onArtworkStampMove: (
    stampId: string,
    point: { readonly x: number; readonly y: number },
  ) => void;
  readonly onArtworkStampTransform: (
    stampId: string,
    patch: Pick<MapArtworkStamp, "rotation" | "scale">,
  ) => void;
  readonly onArtworkStampPlace: (
    assetId: string,
    point: { readonly x: number; readonly y: number },
    gesture?: MapArtworkStampPlacementGesture,
  ) => void;
  readonly onGeometryChange: (
    featureId: string,
    points: MapFeature["points"],
    props?: MapFeature["props"],
  ) => void;
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
  readonly onTopologyDelete?: (featureIds: readonly string[]) => void;
  readonly onTopologyNodeOpen?: (featureId: string) => void;
  readonly onTopologyNodeCreateMap?: (featureId: string) => void;
  readonly onTopologyNodeImportSettingSubtree?: (featureId: string) => void;
  readonly onTopologyNodeDuplicate?: (featureId: string) => void;
  readonly onTopologyNodeDelete?: (featureId: string) => void;
  readonly onTopologyInvalidRouteSelect?: (featureId: string) => void;
  readonly onTopologyError?: (message: string) => void;
  readonly onBatchMove?: (
    featureIds: readonly string[],
    delta: { readonly x: number; readonly y: number },
  ) => void;
}

export default function MapRendererCanvas(props: MapRendererCanvasProps) {
  return mapRendererForProjection(props.document.projectionType) ===
    "geographic" ? (
    <OpenLayersMapCanvas
      document={props.document}
      tool={props.tool}
      settings={props.settings}
      activeLayerId={props.activeLayerId}
      selectedFeatureId={props.selectedFeatureId}
      selectedFeatureIds={props.selectedFeatureIds}
      focusRequest={props.focusRequest}
      documentRebase={props.documentRebase}
      timelineCursor={props.timelineCursor}
      onSelect={props.onSelect}
      onSelectionChange={props.onSelectionChange}
      onCreateGroup={props.onCreateGroup}
      onUngroup={props.onUngroup}
      onSetItemsLocked={props.onSetItemsLocked}
      onCreate={props.onCreate}
      onComponentDrop={props.onComponentDrop}
      onComponentSurface={props.onComponentSurface}
      artworkBrushAssetId={props.artworkBrushAssetId}
      artworkBrushColor={props.artworkBrushColor}
      artworkBrushLayerKind={props.artworkBrushLayerKind}
      activeStampAssetId={props.activeStampAssetId}
      activePrefabComponentId={props.activePrefabComponentId}
      activeTerrainMaterial={props.activeTerrainMaterial}
      projectArtworkSources={props.projectArtworkSources}
      onSceneStroke={props.onSceneStroke}
      onSceneErase={props.onSceneErase}
      onTerrainStroke={props.onTerrainStroke}
      onTerrainMaterialStroke={props.onTerrainMaterialStroke}
      onTerrainMaterialRejected={props.onTerrainMaterialRejected}
      onSceneStrokeMove={props.onSceneStrokeMove}
      onSceneRegionCreate={props.onSceneRegionCreate}
      onSceneRegionMove={props.onSceneRegionMove}
      onArtworkStampMove={props.onArtworkStampMove}
      onArtworkStampTransform={props.onArtworkStampTransform}
      onArtworkStampPlace={props.onArtworkStampPlace}
      onGeometryChange={props.onGeometryChange}
      onBatchMove={props.onBatchMove}
    />
  ) : (
    <XYFlowTopologyCanvas {...props} />
  );
}
