import { mapRendererForProjection } from "../business/mapRenderer";
import type {
  MapArtworkStamp,
  MapDocument,
  MapFeature,
  MapSceneRegion,
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
  readonly onCreate: (feature: MapFeature) => void;
  readonly onComponentDrop: (
    componentId: string,
    point: { readonly x: number; readonly y: number },
    gesture?: MapComponentPlacementGesture,
  ) => void;
  readonly artworkBrushAssetId?: string | null;
  readonly artworkBrushColor?: string | null;
  readonly artworkBrushLayerKind?: MapSceneLayerKind;
  readonly activeStampAssetId?: string | null;
  readonly activePrefabComponentId?: string | null;
  readonly activeTerrainMaterial?: MapTerrainMaterial | null;
  readonly projectArtworkSources?: ReadonlyMap<string, string>;
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
  readonly onSceneStrokeMove: (
    strokeId: string,
    points: readonly { readonly x: number; readonly y: number }[],
  ) => void;
  readonly onSceneRegionCreate: (
    kind: MapSceneRegion["kind"],
    points: readonly { readonly x: number; readonly y: number }[],
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
  readonly onTopologyNodeMove: (
    featureId: string,
    point: { readonly x: number; readonly y: number },
  ) => void;
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
      onCreate={props.onCreate}
      onComponentDrop={props.onComponentDrop}
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
