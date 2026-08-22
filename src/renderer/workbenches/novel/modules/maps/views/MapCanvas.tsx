import "ol/ol.css";

import { useEffect, useRef } from "react";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import Feature from "ol/Feature";
import Map from "ol/Map";
import View from "ol/View";
import Collection from "ol/Collection";
import Draw from "ol/interaction/Draw";
import DragPan from "ol/interaction/DragPan";
import DoubleClickZoom from "ol/interaction/DoubleClickZoom";
import Modify from "ol/interaction/Modify";
import MouseWheelZoom from "ol/interaction/MouseWheelZoom";
import PinchZoom from "ol/interaction/PinchZoom";
import Select from "ol/interaction/Select";
import Snap from "ol/interaction/Snap";
import Translate from "ol/interaction/Translate";
import CircleGeometry from "ol/geom/Circle";
import LineString from "ol/geom/LineString";
import Point from "ol/geom/Point";
import Polygon from "ol/geom/Polygon";
import { getCenter } from "ol/extent";
import { platformModifierKeyOnly } from "ol/events/condition";
import VectorLayer from "ol/layer/Vector";
import Projection from "ol/proj/Projection";
import VectorSource from "ol/source/Vector";
import Fill from "ol/style/Fill";
import Icon from "ol/style/Icon";
import Stroke from "ol/style/Stroke";
import Style from "ol/style/Style";
import Text from "ol/style/Text";
import CircleStyle from "ol/style/Circle";
import type Geometry from "ol/geom/Geometry";
import type { Coordinate } from "ol/coordinate";

import { MAP_COMPONENT_DRAG_MIME } from "../business/mapComponents";
import {
  DEFAULT_MAP_CANVAS_SETTINGS,
  type MapCanvasSettings,
  type MapCanvasTool,
} from "../business/mapCanvasSession";
import {
  getMapArtworkAssetVariant,
  getMapArtworkStampAsset,
  mapArtworkVariantIndex,
} from "../business/mapArtwork";
import {
  isMapBackgroundImageVisible,
  mapCanvasBackgroundStyle,
} from "../business/mapBackgrounds";
import { mapFeaturesInRenderOrder } from "../business/mapLayerOrder";
import {
  DEFAULT_MAP_RIVER_PROPS,
  getMapRiverStyle,
  isMapRiverFeature,
  mapRiverWidthAt,
  smoothMapPath,
} from "../business/mapHydrography";
import {
  DEFAULT_MAP_FREEFORM_AREA_PROPS,
  getMapFeatureAreaStyle,
} from "../business/mapFeatureAreaStyle";
import {
  getMapLabelFrameStyle,
  getMapLabelLayout,
  getMapLabelStyle,
  mapLabelText,
  mapFeatureHasLabel,
  mapLabelCanvasFont,
  resolveMapLabelPlacements,
  type MapLabelPlacement,
} from "../business/mapLabels";
import {
  getMapRouteStyle,
  isMapStyledRoute,
  mapRouteStrokeLayers,
} from "../business/mapRoutes";
import {
  isMapBrushPathClosed,
  resampleMapBrushPoints,
} from "../business/mapFeatureShapes";
import { mapBrushCurvePoints } from "../business/mapFeatureShapes";
import {
  isMapFeatureFreeformArea,
  type MapArtworkStamp,
  type MapDocument,
  type MapFeature,
} from "../entities/mapSchema";

// 兼容旧调用方；主渲染链路应从 mapCanvasSession 导入。
export { DEFAULT_MAP_CANVAS_SETTINGS } from "../business/mapCanvasSession";
export type {
  MapCanvasSettings,
  MapCanvasTool,
} from "../business/mapCanvasSession";

interface MapCanvasProps {
  readonly document: MapDocument;
  readonly tool: MapCanvasTool;
  readonly settings?: MapCanvasSettings;
  readonly activeLayerId: string;
  readonly selectedFeatureId: string | null;
  readonly focusRequest?: number;
  readonly timelineCursor: number | null;
  readonly onSelect: (featureId: string | null) => void;
  readonly onCreate: (feature: MapFeature) => void;
  readonly onComponentDrop: (
    componentId: string,
    point: { readonly x: number; readonly y: number },
  ) => void;
  readonly artworkBrushAssetId?: string | null;
  readonly onArtworkStampBrush: (
    assetId: string,
    points: readonly { readonly x: number; readonly y: number }[],
  ) => void;
  readonly onArtworkStampMove: (
    stampId: string,
    point: { readonly x: number; readonly y: number },
  ) => void;
  readonly onGeometryChange: (
    featureId: string,
    points: MapFeature["points"],
    props?: MapFeature["props"],
  ) => void;
}

function pointToCoordinate(
  point: { x: number; y: number },
  canvasHeight: number,
): Coordinate {
  return [point.x, canvasHeight - point.y];
}

function coordinateToPoint(
  coordinate: Coordinate,
  canvasHeight: number,
): { x: number; y: number } {
  return { x: coordinate[0], y: canvasHeight - coordinate[1] };
}

function pointsFromGeometry(
  geometry: Geometry,
  canvasHeight: number,
): MapFeature["points"] {
  if (geometry instanceof Point) {
    return [coordinateToPoint(geometry.getCoordinates(), canvasHeight)];
  }
  if (geometry instanceof LineString) {
    return geometry
      .getCoordinates()
      .map((coordinate) => coordinateToPoint(coordinate, canvasHeight));
  }
  if (geometry instanceof Polygon) {
    const ring = geometry.getCoordinates()[0] ?? [];
    const points = ring
      .slice(0, -1)
      .map((coordinate) => coordinateToPoint(coordinate, canvasHeight));
    return points.length > 0
      ? points
      : ring.map((coordinate) => coordinateToPoint(coordinate, canvasHeight));
  }
  if (geometry instanceof CircleGeometry) {
    return [coordinateToPoint(geometry.getCenter(), canvasHeight)];
  }
  return [];
}

export function geometryFromFeature(
  feature: MapFeature,
  canvasWidth: number,
  canvasHeight: number,
): Geometry {
  const closed =
    feature.kind === "area" || feature.props.closed === "true";
  const renderedPoints =
    feature.props.curve === "arc"
      ? mapBrushCurvePoints(feature.points, "arc", closed)
      : feature.points;
  const coordinates = renderedPoints.map((point) =>
    pointToCoordinate(point, canvasHeight),
  );
  if (["marker", "label", "node"].includes(feature.kind)) {
    return new Point(coordinates[0] ?? [canvasWidth / 2, canvasHeight / 2]);
  }
  if (feature.kind === "route") {
    return new LineString(
      closed && coordinates.length > 1
        ? [...coordinates, coordinates[0]!]
        : coordinates,
    );
  }
  if (feature.kind === "area") {
    // 只有明确保存 radius 的旧版圆形要素才继续使用 CircleGeometry。
    // 自由画笔、画笔多边形以及弧线闭合区域必须保留真实边界，否则
    // OpenLayers 兼容画布会把它们全部退化成圆形，用户无法看到自由轮廓。
    const radius = Number(feature.props.radius);
    if (Number.isFinite(radius) && radius > 0 && coordinates.length <= 1) {
      const center = coordinates[0] ?? [canvasWidth / 2, canvasHeight / 2];
      return new CircleGeometry(center, radius);
    }
    const ring =
      coordinates.length >= 3 ? [...coordinates, coordinates[0]!] : coordinates;
    return new Polygon([ring]);
  }
  const ring =
    coordinates.length >= 3 ? [...coordinates, coordinates[0]] : coordinates;
  return new Polygon([ring]);
}

function featureStyle(
  feature: MapFeature,
  selected: boolean,
  opacity: number,
  zIndex: number,
  canvasHeight: number,
  labelPlacement?: MapLabelPlacement,
): Style | Style[] {
  // 兼容画布也必须消费与主场景相同的曲线事实。历史要素没有 curve
  // 时保留旧的平滑策略；显式选择直线或弧线时不再静默退化。
  const pathPoints = feature.props.curve
    ? mapBrushCurvePoints(
        feature.points,
        feature.props.curve === "arc" ? "arc" : "line",
      )
    : smoothMapPath(feature.points);
  if (isMapRiverFeature(feature)) {
    const riverStyle = getMapRiverStyle(feature);
    const smoothed = pathPoints;
    const styles: Style[] = [];
    smoothed.slice(1).forEach((point, index) => {
      const progress = (index + 1) / (smoothed.length - 1);
      const width = mapRiverWidthAt(riverStyle, progress);
      const geometry = new LineString([
        pointToCoordinate(smoothed[index]!, canvasHeight),
        pointToCoordinate(point, canvasHeight),
      ]);
      styles.push(
        new Style({
          geometry,
          zIndex: zIndex * 10,
          stroke: new Stroke({
            color: selected
              ? "#c75436"
              : withOpacity(riverStyle.bankColor, opacity * 0.78),
            width: width + riverStyle.bankWidth * 2 + (selected ? 2 : 0),
            lineCap: "round",
            lineJoin: "round",
          }),
        }),
        new Style({
          geometry,
          zIndex: zIndex * 10 + 1,
          stroke: new Stroke({
            color: withOpacity(riverStyle.color, opacity),
            width,
            lineCap: "round",
            lineJoin: "round",
          }),
        }),
        new Style({
          geometry,
          zIndex: zIndex * 10 + 2,
          stroke: new Stroke({
            color: withOpacity(riverStyle.highlightColor, opacity * 0.38),
            width: Math.max(0.5, width * 0.18),
            lineCap: "round",
            lineJoin: "round",
          }),
        }),
      );
    });
    if (
      mapFeatureHasLabel(feature) &&
      labelPlacement?.visible !== false &&
      smoothed.length > 0
    ) {
      const labelStyle = getMapLabelStyle(feature);
      const labelLayout =
        labelPlacement?.layout ?? getMapLabelLayout(feature, smoothed);
      styles.push(
        new Style({
          geometry: new Point(
            pointToCoordinate(labelLayout.anchor, canvasHeight),
          ),
          zIndex: zIndex * 10 + 3,
          text: new Text({
            text: feature.name,
            offsetX: labelPlacement ? 0 : labelStyle.offsetX,
            offsetY: labelPlacement ? 0 : labelStyle.offsetY,
            rotation:
              ((labelStyle.rotation + labelLayout.pathRotation) * Math.PI) /
              180,
            font: mapLabelCanvasFont(labelStyle),
            fill: new Fill({ color: labelStyle.color }),
            stroke:
              labelStyle.haloWidth > 0
                ? new Stroke({
                    color: labelStyle.haloColor,
                    width: labelStyle.haloWidth,
                  })
                : undefined,
          }),
        }),
      );
    }
    return styles;
  }
  if (isMapStyledRoute(feature)) {
    const routeStyle = getMapRouteStyle(feature)!;
    const smoothed = pathPoints;
    const geometry = new LineString(
      smoothed.map((point) => pointToCoordinate(point, canvasHeight)),
    );
    const styles = mapRouteStrokeLayers(routeStyle).map(
      (layer, index) =>
        new Style({
          geometry,
          zIndex: zIndex * 10 + index,
          stroke: new Stroke({
            color: withOpacity(layer.color, opacity),
            width: layer.width,
            lineDash: layer.dash ? [...layer.dash] : undefined,
            lineCap: "round",
            lineJoin: "round",
          }),
        }),
    );
    if (
      mapFeatureHasLabel(feature) &&
      labelPlacement?.visible !== false &&
      smoothed.length > 0
    ) {
      const labelStyle = getMapLabelStyle(feature);
      const labelLayout =
        labelPlacement?.layout ?? getMapLabelLayout(feature, smoothed);
      styles.push(
        new Style({
          geometry: new Point(
            pointToCoordinate(labelLayout.anchor, canvasHeight),
          ),
          zIndex: zIndex * 10 + styles.length,
          text: new Text({
            text: feature.name,
            offsetX: labelPlacement ? 0 : labelStyle.offsetX,
            offsetY: labelPlacement ? 0 : labelStyle.offsetY,
            rotation:
              ((labelStyle.rotation + labelLayout.pathRotation) * Math.PI) /
              180,
            font: mapLabelCanvasFont(labelStyle),
            fill: new Fill({ color: labelStyle.color }),
            stroke:
              labelStyle.haloWidth > 0
                ? new Stroke({
                    color: labelStyle.haloColor,
                    width: labelStyle.haloWidth,
                  })
                : undefined,
          }),
        }),
      );
    }
    return styles;
  }
  const terrain = feature.props.terrain;
  const color = withOpacity(
    feature.props.color ??
      (terrain === "river"
        ? "#4b87a0"
        : terrain === "mountain"
          ? "#746657"
          : "#b26d45"),
    opacity,
  );
  const isArea = isMapFeatureFreeformArea(feature.kind);
  const areaStyle = isArea ? getMapFeatureAreaStyle(feature) : null;
  const fill = withOpacity(
    areaStyle?.fill ?? (terrain === "region" ? "#c9675540" : "#b26d4540"),
    opacity * (areaStyle?.opacity ?? 1),
  );
  const parsedWidth = Number(feature.props.lineWidth ?? 2);
  const width =
    terrain === "mountain"
      ? Math.max(1.5, Math.min(parsedWidth, 3))
      : terrain === "river"
        ? Math.max(1.5, Math.min(parsedWidth, 2.5))
        : parsedWidth;
  const label =
    mapFeatureHasLabel(feature) && labelPlacement?.visible !== false
      ? feature.name
      : undefined;
  const labelStyle = label ? getMapLabelStyle(feature) : null;
  const labelFrame = labelStyle ? getMapLabelFrameStyle(labelStyle) : null;
  const labelLayout = label
    ? (labelPlacement?.layout ?? getMapLabelLayout(feature))
    : null;
  const componentAsset =
    feature.kind === "marker"
      ? getMapArtworkStampAsset(feature.props.component ?? "")
      : undefined;
  const componentVariant = componentAsset
    ? getMapArtworkAssetVariant(
        componentAsset,
        mapArtworkVariantIndex(componentAsset, feature.id),
      )
    : undefined;
  const componentScale = componentVariant
    ? Math.min(
        0.5,
        58 / Math.max(componentVariant.width, componentVariant.height),
      )
    : 1;
  const componentSize = componentVariant
    ? Math.max(componentVariant.width, componentVariant.height) * componentScale
    : 0;
  const symbol = {
    peaks: "▲ ▲ ▲",
    forest: "♣ ♣",
    star: "✦",
    planet: "◉",
    "ringed-planet": "◎",
    moon: "◐",
    portal: "◇",
    volcano: "▲",
    waterfall: "≋",
    city: "●",
    capital: "◆",
    fortress: "▣",
    faction: "◆",
    "secret-realm": "◇",
    ruins: "▤",
    temple: "⌂",
    resource: "✧",
  }[feature.props.symbol ?? ""];
  const pointRadius =
    feature.props.symbol === "capital"
      ? 9
      : feature.props.symbol === "star" ||
          feature.props.symbol === "ringed-planet"
        ? 8
        : feature.props.symbol === "city"
          ? 6
          : selected
            ? 9
            : 7;
  const visual = new Style({
    zIndex,
    image: componentVariant
      ? new Icon({
          src: componentVariant.imageSrc,
          anchor: [0.5, 0.5],
          anchorXUnits: "fraction",
          anchorYUnits: "fraction",
          opacity,
          scale: componentScale,
        })
      : ["marker", "node"].includes(feature.kind)
        ? new CircleStyle({
            radius: pointRadius,
            fill: new Fill({
              color: feature.kind === "node" ? "#507b88" : color,
            }),
            stroke: new Stroke({
              color: selected ? "#fffaf1" : "#423b34",
              width: selected ? 3 : 1.5,
            }),
          })
        : undefined,
    fill: new Fill({ color: fill }),
    stroke: new Stroke({
      color: selected ? "#c75436" : color,
      width: selected ? width + 1 : width,
      lineDash:
        terrain === "mountain"
          ? [8, 5]
          : terrain === "region"
            ? [5, 4]
            : undefined,
    }),
    text: label
      ? new Text({
          text: mapLabelText(feature.name, labelStyle!),
          offsetX: labelPlacement ? 0 : (labelStyle?.offsetX ?? 0),
          offsetY: labelPlacement ? 0 : (labelStyle?.offsetY ?? 0),
          rotation:
            (((labelStyle?.rotation ?? 0) + (labelLayout?.pathRotation ?? 0)) *
              Math.PI) /
            180,
          font: labelStyle ? mapLabelCanvasFont(labelStyle) : undefined,
          fill: new Fill({ color: labelStyle?.color ?? "#302c27" }),
          stroke:
            (labelStyle?.haloWidth ?? 0) > 0
              ? new Stroke({
                  color: labelStyle?.haloColor ?? "#fffaf1",
                  width: labelStyle?.haloWidth ?? 0,
                })
              : undefined,
          backgroundFill: labelFrame
            ? new Fill({ color: labelFrame.fill })
            : undefined,
          backgroundStroke: labelFrame
            ? new Stroke({
                color: labelFrame.stroke,
                width: labelFrame.lineWidth,
              })
            : undefined,
          padding: labelFrame
            ? [
                labelStyle!.fontSize * 0.32,
                labelStyle!.fontSize * 0.4,
                labelStyle!.fontSize * 0.32,
                labelStyle!.fontSize * 0.4,
              ]
            : undefined,
        })
      : symbol && !componentAsset
        ? new Text({
            text: symbol,
            font: "700 13px system-ui",
            fill: new Fill({ color: "#4d443a" }),
          })
        : undefined,
  });
  if (!selected || !componentAsset) return visual;
  return [
    visual,
    new Style({
      zIndex: zIndex + 1,
      image: new CircleStyle({
        radius: Math.max(14, componentSize / 2 + 6),
        fill: new Fill({ color: "rgba(199,84,54,0.08)" }),
        stroke: new Stroke({ color: "#c75436", width: 2.5 }),
      }),
    }),
  ];
}

function artworkStyle(
  stamp: MapArtworkStamp,
  selected: boolean,
  layerOpacity: number,
  zIndex: number,
): Style | Style[] {
  const asset = getMapArtworkStampAsset(stamp.assetId);
  const opacity = layerOpacity * stamp.opacity;
  if (!asset) {
    return new Style({
      zIndex: zIndex + 100,
      image: new CircleStyle({
        radius: 14,
        fill: new Fill({ color: withOpacity("#8b6b4a", opacity * 0.24) }),
        stroke: new Stroke({
          color: selected ? "#c75436" : withOpacity("#8b6b4a", opacity),
          width: selected ? 2.5 : 1,
        }),
      }),
      text: new Text({
        text: "✦",
        font: "700 20px serif",
        fill: new Fill({ color: withOpacity("#8b6b4a", opacity) }),
      }),
    });
  }

  const variant = getMapArtworkAssetVariant(asset, stamp.variant);
  // 素材按最长边归一化，保证山脉、城市和大陆不会因为原始 SVG 尺寸不同而失衡。
  const baseScale = Math.min(1, 150 / Math.max(variant.width, variant.height));
  const scale = baseScale * Math.max(0.05, stamp.scale);
  const image = new Icon({
    src: variant.imageSrc,
    anchor: [0.5, 0.5],
    anchorXUnits: "fraction",
    anchorYUnits: "fraction",
    opacity,
    rotation: (stamp.rotation * Math.PI) / 180,
    scale: [(stamp.flipX ? -1 : 1) * scale, (stamp.flipY ? -1 : 1) * scale],
  });
  const artwork = new Style({
    zIndex: zIndex + 100,
    image,
  });
  if (!selected) return artwork;
  return [
    artwork,
    new Style({
      zIndex: zIndex + 101,
      image: new CircleStyle({
        radius: Math.max(
          14,
          Math.max(variant.width, variant.height) * scale * 0.52,
        ),
        fill: new Fill({ color: "rgba(199,84,54,0.08)" }),
        stroke: new Stroke({ color: "#c75436", width: 2.5 }),
      }),
    }),
  ];
}

function withOpacity(color: string, opacity: number): string {
  const normalized = color.trim();
  if (!/^#[0-9a-f]{6,8}$/iu.test(normalized)) return color;
  const hex = normalized.slice(1);
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const alpha =
    hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return `rgba(${red},${green},${blue},${Math.max(0, Math.min(1, alpha * opacity))})`;
}

function mapFeature(
  feature: MapFeature,
  canvasWidth: number,
  canvasHeight: number,
): Feature<Geometry> {
  const mapped = new Feature({
    geometry: geometryFromFeature(feature, canvasWidth, canvasHeight),
  });
  mapped.setId(feature.id);
  mapped.set("mapFeatureId", feature.id);
  mapped.set("mapFeature", feature);
  return mapped;
}

function mapArtworkFeature(
  stamp: MapArtworkStamp,
  canvasHeight: number,
): Feature<Geometry> {
  const mapped = new Feature({
    geometry: new Point(pointToCoordinate(stamp, canvasHeight)),
  });
  mapped.setId(stamp.id);
  mapped.set("mapArtworkStampId", stamp.id);
  mapped.set("mapArtworkStamp", stamp);
  return mapped;
}

export function createMapView(canvas: MapDocument["canvas"]): View {
  const projection = new Projection({
    code: `myagents-map-${canvas.width}x${canvas.height}`,
    units: "pixels",
    extent: [0, 0, canvas.width, canvas.height],
  });
  return new View({
    projection,
    center: [canvas.width / 2, canvas.height / 2],
    zoom: 0,
    minZoom: -4,
    maxZoom: 8,
  });
}

function fitMapToCanvas(
  map: Map,
  canvas: MapDocument["canvas"],
  duration = 0,
): boolean {
  map.updateSize();
  const size = map.getSize();
  if (!size || size[0] <= 0 || size[1] <= 0) return false;
  map.getView().fit([0, 0, canvas.width, canvas.height], {
    duration,
    padding: [28, 28, 28, 28],
  });
  return true;
}

function featureStyleCacheKey(
  feature: MapFeature,
  selected: boolean,
  opacity: number,
  zIndex: number,
): string {
  return JSON.stringify([
    feature.id,
    feature.kind,
    feature.name,
    feature.props,
    selected,
    opacity,
    zIndex,
  ]);
}

export default function MapCanvas({
  document,
  tool,
  settings = DEFAULT_MAP_CANVAS_SETTINGS,
  activeLayerId,
  selectedFeatureId,
  focusRequest = 0,
  timelineCursor,
  onSelect,
  onCreate,
  onComponentDrop,
  artworkBrushAssetId = null,
  onArtworkStampBrush,
  onArtworkStampMove,
  onGeometryChange,
}: MapCanvasProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const sourceRef = useRef<VectorSource<Feature<Geometry>> | null>(null);
  const layerRef = useRef<VectorLayer<VectorSource<Feature<Geometry>>> | null>(
    null,
  );
  const selectRef = useRef<Select | null>(null);
  const editableFeaturesRef = useRef<Collection<Feature<Geometry>> | null>(
    null,
  );
  const selectedIdRef = useRef(selectedFeatureId);
  const toolRef = useRef(tool);
  const documentRef = useRef(document);
  const styleCacheRef = useRef<globalThis.Map<string, Style | Style[]>>(
    new globalThis.Map(),
  );
  const viewSizeRef = useRef<string | null>(null);
  const labelPlacementsRef = useRef<ReadonlyMap<string, MapLabelPlacement>>(
    new globalThis.Map(),
  );

  useEffect(() => {
    selectedIdRef.current = selectedFeatureId;
    toolRef.current = tool;
    documentRef.current = document;
    const zoom = 2 ** (mapRef.current?.getView().getZoom() ?? 0);
    labelPlacementsRef.current = resolveMapLabelPlacements(document.features, {
      zoom,
    });
  }, [document, selectedFeatureId, tool]);

  useEffect(() => {
    if (!elementRef.current) return undefined;
    const source = new VectorSource<Feature<Geometry>>();
    const editableFeatures = new Collection<Feature<Geometry>>();
    const initialDocument = documentRef.current;
    const vector = new VectorLayer({
      source,
      style: (feature) => {
        const stamp = feature.get("mapArtworkStamp") as
          | MapArtworkStamp
          | undefined;
        if (stamp) {
          const layer = documentRef.current.artwork.layers.find(
            (item) => item.id === stamp.layerId,
          );
          if (!layer) return undefined;
          const selected = stamp.id === selectedIdRef.current;
          const zIndex = documentRef.current.artwork.layers.findIndex(
            (item) => item.id === layer.id,
          );
          const cacheKey = JSON.stringify([
            "artwork",
            stamp,
            selected,
            layer.opacity,
            zIndex,
          ]);
          const cached = styleCacheRef.current.get(cacheKey);
          if (cached) return cached;
          const style = artworkStyle(stamp, selected, layer.opacity, zIndex);
          styleCacheRef.current.set(cacheKey, style);
          return style;
        }
        const value = feature.get("mapFeature") as MapFeature | undefined;
        if (!value) return undefined;
        const layer = documentRef.current.layers.find(
          (item) => item.id === value.layerId,
        );
        const zIndex = layer
          ? documentRef.current.layers.findIndex(
              (item) => item.id === layer.id,
            ) + 1
          : 0;
        const selected = value.id === selectedIdRef.current;
        const opacity = layer?.opacity ?? 1;
        const cacheKey = featureStyleCacheKey(value, selected, opacity, zIndex);
        const cached = styleCacheRef.current.get(cacheKey);
        if (cached) return cached;
        const style = featureStyle(
          value,
          selected,
          opacity,
          zIndex,
          documentRef.current.canvas.height,
          labelPlacementsRef.current.get(value.id),
        );
        styleCacheRef.current.set(cacheKey, style);
        return style;
      },
    });
    const dragPan = new DragPan();
    const map = new Map({
      target: elementRef.current,
      layers: [vector],
      view: createMapView(initialDocument.canvas),
      interactions: new Collection([
        dragPan,
        new MouseWheelZoom({ duration: 120, maxDelta: 1 }),
        new DoubleClickZoom({ duration: 120 }),
        new PinchZoom({ duration: 120 }),
      ]),
      controls: [],
    });
    // OpenLayers 的视图缩放是对数刻度；标签服务使用线性显示比例。缩放
    // 停止后才清空样式缓存，避免平移或滚轮每一帧重复计算静态标签层。
    const labelLayoutRefreshKey = map.on("moveend", () => {
      const zoom = 2 ** (map.getView().getZoom() ?? 0);
      labelPlacementsRef.current = resolveMapLabelPlacements(
        documentRef.current.features,
        { zoom },
      );
      styleCacheRef.current.clear();
      vector.changed();
    });
    const select = new Select({
      hitTolerance: 6,
      filter: (feature) => {
        const stamp = feature.get("mapArtworkStamp") as
          | MapArtworkStamp
          | undefined;
        if (stamp) {
          const layer = documentRef.current.artwork.layers.find(
            (item) => item.id === stamp.layerId,
          );
          return Boolean(layer?.visible && !layer.locked);
        }
        const value = feature.get("mapFeature") as MapFeature | undefined;
        return value
          ? !documentRef.current.layers.find(
              (layer) => layer.id === value.layerId,
            )?.locked
          : false;
      },
    });
    select.on("select", (event) => {
      const feature = event.selected[0];
      onSelect(feature ? String(feature.getId()) : null);
    });
    map.addInteraction(select);
    dragPan.setActive(true);
    const translate = new Translate({
      layers: [vector],
      hitTolerance: 8,
      filter: (feature) => {
        const stamp = feature.get("mapArtworkStamp") as
          | MapArtworkStamp
          | undefined;
        if (stamp) {
          const layer = documentRef.current.artwork.layers.find(
            (item) => item.id === stamp.layerId,
          );
          return Boolean(layer?.visible && !layer.locked);
        }
        const value = feature.get("mapFeature") as MapFeature | undefined;
        const layer = value
          ? documentRef.current.layers.find((item) => item.id === value.layerId)
          : undefined;
        return Boolean(layer?.visible && !layer.locked);
      },
    });
    translate.on("translatestart", (event) => {
      const feature = event.features.getArray()[0];
      const id =
        feature?.get("mapFeatureId") ?? feature?.get("mapArtworkStampId");
      if (typeof id === "string") onSelect(id);
      const viewport = map
        .getTargetElement()
        .querySelector<HTMLElement>(".ol-viewport");
      if (viewport) viewport.style.cursor = "grabbing";
    });
    translate.on("translateend", (event) => {
      event.features.forEach((feature) => {
        const stamp = feature.get("mapArtworkStamp") as
          | MapArtworkStamp
          | undefined;
        const id = feature.get("mapFeatureId");
        const geometry = feature.getGeometry();
        if (typeof id === "string" && geometry) {
          onGeometryChange(
            id,
            pointsFromGeometry(geometry, documentRef.current.canvas.height),
          );
        } else if (stamp && geometry) {
          const point = pointsFromGeometry(
            geometry,
            documentRef.current.canvas.height,
          )[0];
          if (point) onArtworkStampMove(stamp.id, point);
        }
      });
      const viewport = map
        .getTargetElement()
        .querySelector<HTMLElement>(".ol-viewport");
      if (viewport) viewport.style.cursor = "grab";
    });
    map.addInteraction(translate);
    const modify = new Modify({
      features: editableFeatures,
      condition: platformModifierKeyOnly,
    });
    modify.on("modifyend", (event) => {
      event.features.forEach((feature) => {
        const stamp = feature.get("mapArtworkStamp") as
          | MapArtworkStamp
          | undefined;
        const id = feature.get("mapFeatureId");
        const geometry = feature.getGeometry();
        if (stamp && geometry) {
          const point = pointsFromGeometry(
            geometry,
            documentRef.current.canvas.height,
          )[0];
          if (point) onArtworkStampMove(stamp.id, point);
        } else if (typeof id === "string" && geometry) {
          onGeometryChange(
            id,
            pointsFromGeometry(geometry, documentRef.current.canvas.height),
            geometry instanceof CircleGeometry
              ? {
                  radius: String(Math.max(1, Math.round(geometry.getRadius()))),
                }
              : undefined,
          );
        }
      });
    });
    map.addInteraction(modify);
    const snap = new Snap({ source });
    map.addInteraction(snap);
    mapRef.current = map;
    sourceRef.current = source;
    layerRef.current = vector;
    selectRef.current = select;
    editableFeaturesRef.current = editableFeatures;
    const viewport = map
      .getTargetElement()
      .querySelector<HTMLElement>(".ol-viewport");
    if (viewport) {
      viewport.style.zIndex = "1";
      viewport.style.cursor = "grab";
    }
    const pointerMoveKey = map.on("pointermove", (event) => {
      if (
        (toolRef.current !== "select" && toolRef.current !== "move") ||
        !viewport
      ) {
        return;
      }
      const hit = map.forEachFeatureAtPixel(
        event.pixel,
        (feature) => {
          const stamp = feature.get("mapArtworkStamp") as
            | MapArtworkStamp
            | undefined;
          if (stamp) {
            const artworkLayer = documentRef.current.artwork.layers.find(
              (item) => item.id === stamp.layerId,
            );
            return Boolean(artworkLayer?.visible && !artworkLayer.locked);
          }
          const value = feature.get("mapFeature") as MapFeature | undefined;
          const layer = value
            ? documentRef.current.layers.find(
                (item) => item.id === value.layerId,
              )
            : undefined;
          return Boolean(layer?.visible && !layer.locked);
        },
        { hitTolerance: 8, layerFilter: (layer) => layer === vector },
      );
      viewport.style.cursor = hit
        ? toolRef.current === "move"
          ? "grab"
          : "pointer"
        : "default";
    });
    const resizeTarget = elementRef.current;
    const updateMapSize = () => map.updateSize();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateMapSize);
    resizeObserver?.observe(resizeTarget);
    window.addEventListener("resize", updateMapSize);
    const animationFrame = window.requestAnimationFrame(() => {
      if (viewSizeRef.current !== null) return;
      if (fitMapToCanvas(map, documentRef.current.canvas)) {
        viewSizeRef.current = `${documentRef.current.canvas.width}x${documentRef.current.canvas.height}`;
      }
    });
    return () => {
      window.cancelAnimationFrame(animationFrame);
      map.un("pointermove", pointerMoveKey.listener);
      map.un("moveend", labelLayoutRefreshKey.listener);
      window.removeEventListener("resize", updateMapSize);
      resizeObserver?.disconnect();
      map.setTarget(undefined);
      mapRef.current = null;
      sourceRef.current = null;
      layerRef.current = null;
      selectRef.current = null;
      editableFeaturesRef.current = null;
    };
  }, [onArtworkStampMove, onGeometryChange, onSelect]);

  useEffect(() => {
    const source = sourceRef.current;
    const map = mapRef.current;
    if (!source || !map) return;
    styleCacheRef.current.clear();
    source.clear();
    editableFeaturesRef.current?.clear();
    selectRef.current?.getFeatures().clear();
    const semanticFeatures = mapFeaturesInRenderOrder(document)
      .filter((feature) => {
        const layer = document.layers.find(
          (item) => item.id === feature.layerId,
        );
        if (!layer?.visible) return false;
        if (timelineCursor === null) return true;
        return (
          (feature.timeFrom === null || timelineCursor >= feature.timeFrom) &&
          (feature.timeTo === null || timelineCursor <= feature.timeTo)
        );
      })
      .map((feature) =>
        mapFeature(feature, document.canvas.width, document.canvas.height),
      );
    const artworkFeatures = document.artwork.layers
      .filter((layer) => layer.visible)
      .flatMap((layer) =>
        layer.stamps.map((stamp) =>
          mapArtworkFeature(stamp, document.canvas.height),
        ),
      );
    const features = [...semanticFeatures, ...artworkFeatures];
    source.addFeatures(features);
    features.forEach((feature) => {
      const stamp = feature.get("mapArtworkStamp") as
        | MapArtworkStamp
        | undefined;
      if (stamp) {
        const layer = document.artwork.layers.find(
          (item) => item.id === stamp.layerId,
        );
        if (layer && !layer.locked) editableFeaturesRef.current?.push(feature);
        return;
      }
      const value = feature.get("mapFeature") as MapFeature | undefined;
      const layer = value
        ? document.layers.find((item) => item.id === value.layerId)
        : undefined;
      if (layer && !layer.locked) editableFeaturesRef.current?.push(feature);
    });
    const selected = features.find(
      (feature) => String(feature.getId()) === selectedIdRef.current,
    );
    if (selected) selectRef.current?.getFeatures().push(selected);
    const viewSize = `${document.canvas.width}x${document.canvas.height}`;
    if (viewSizeRef.current !== viewSize) {
      map.setView(createMapView(document.canvas));
      if (fitMapToCanvas(map, document.canvas)) viewSizeRef.current = viewSize;
    }
    layerRef.current?.changed();
  }, [document, timelineCursor]);

  useEffect(() => {
    const map = mapRef.current;
    const source = sourceRef.current;
    if (!map || !source) return;
    map.getInteractions().forEach((interaction) => {
      if (interaction instanceof DragPan) interaction.setActive(tool === "pan");
      if (interaction instanceof Select || interaction instanceof Modify) {
        interaction.setActive(tool === "select");
      }
      if (interaction instanceof Translate)
        interaction.setActive(tool === "move");
      if (interaction instanceof Snap) {
        interaction.setActive(
          tool !== "select" &&
            tool !== "move" &&
            tool !== "pan" &&
            tool !== "artwork-brush" &&
            tool !== "artwork-stamp" &&
            tool !== "component-path-brush" &&
            tool !== "scene-eraser" &&
            tool !== "terrain-land" &&
            tool !== "terrain-water" &&
            tool !== "terrain-region-land" &&
            tool !== "terrain-region-water" &&
            tool !== "terrain-prefab" &&
            tool !== "terrain-material" &&
            tool !== "freehand" &&
            tool !== "route" &&
            tool !== "river",
        );
      }
    });
    map.getInteractions().forEach((interaction) => {
      if (interaction instanceof Draw) map.removeInteraction(interaction);
    });
    if (tool === "select" || tool === "move" || tool === "pan") {
      const cursor = tool === "pan" || tool === "move" ? "grab" : "default";
      map.getTargetElement().style.cursor = cursor;
      const viewport = map
        .getTargetElement()
        .querySelector<HTMLElement>(".ol-viewport");
      if (viewport) viewport.style.cursor = cursor;
      if (tool === "pan") return;
      return;
    }
    // 地形区域由 Canvas 场景渲染器处理，旧 OpenLayers 视图不能把它当 MapFeature 绘制。
    if (
      tool === "scene-eraser" ||
      tool === "artwork-stamp" ||
      tool === "component-path-brush" ||
      tool === "terrain-land" ||
      tool === "terrain-water" ||
      tool === "terrain-region-land" ||
      tool === "terrain-region-water" ||
      tool === "terrain-prefab" ||
      tool === "terrain-material"
    )
      return;
    if (tool === "artwork-brush") {
      const viewport = map
        .getTargetElement()
        .querySelector<HTMLElement>(".ol-viewport");
      if (viewport) viewport.style.cursor = "crosshair";
      const points: { x: number; y: number }[] = [];
      let painting = false;
      const appendPoint = (coordinate: Coordinate) => {
        const point = coordinateToPoint(
          coordinate,
          documentRef.current.canvas.height,
        );
        const previous = points[points.length - 1];
        if (
          !previous ||
          Math.hypot(point.x - previous.x, point.y - previous.y) >= 48
        ) {
          points.push(point);
        }
      };
      const viewportElement = map.getViewport();
      const pointerDown = (event: PointerEvent) => {
        if (!artworkBrushAssetId) return;
        event.preventDefault();
        painting = true;
        points.length = 0;
        viewportElement.setPointerCapture(event.pointerId);
        appendPoint(map.getEventCoordinate(event));
      };
      const pointerMove = (event: PointerEvent) => {
        if (!painting) return;
        event.preventDefault();
        appendPoint(map.getEventCoordinate(event));
      };
      const pointerUp = (event: PointerEvent) => {
        if (!painting) return;
        event.preventDefault();
        painting = false;
        if (artworkBrushAssetId && points.length > 0) {
          onArtworkStampBrush(artworkBrushAssetId, [...points]);
        }
        points.length = 0;
        if (viewportElement.hasPointerCapture(event.pointerId)) {
          viewportElement.releasePointerCapture(event.pointerId);
        }
      };
      viewportElement.addEventListener("pointerdown", pointerDown);
      viewportElement.addEventListener("pointermove", pointerMove);
      viewportElement.addEventListener("pointerup", pointerUp);
      viewportElement.addEventListener("pointercancel", pointerUp);
      return () => {
        viewportElement.removeEventListener("pointerdown", pointerDown);
        viewportElement.removeEventListener("pointermove", pointerMove);
        viewportElement.removeEventListener("pointerup", pointerUp);
        viewportElement.removeEventListener("pointercancel", pointerUp);
      };
    }
    const usesFreehandArea =
      tool === "freehand" ||
      (tool === "area" && settings.areaShape === "freehand");
    const drawType =
      tool === "marker" || tool === "label" || tool === "node"
        ? "Point"
        : tool === "route" || tool === "river" || usesFreehandArea
          ? "LineString"
          : tool === "area"
            ? "Polygon"
            : "Circle";
    const draw = new Draw({
      source,
      type: drawType,
      stopClick: true,
      // 河流、道路、山脉等路线沿鼠标轨迹连续取样，手感接近 Wonderdraft 笔刷。
      freehand: tool === "route" || tool === "river" || usesFreehandArea,
    });
    draw.on("drawend", (event) => {
      const geometry = event.feature.getGeometry();
      if (!geometry) return;
      const points = pointsFromGeometry(
        geometry,
        documentRef.current.canvas.height,
      );
      const id = `feature-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const safePoints =
        points.length > 0
          ? points
          : [
              {
                x: documentRef.current.canvas.width / 2,
                y: documentRef.current.canvas.height / 2,
              },
            ];
      const freehandClosed =
        usesFreehandArea && isMapBrushPathClosed(safePoints);
      const normalizedPoints =
        (usesFreehandArea || tool === "route" || tool === "river") &&
        safePoints.length > 1
          ? resampleMapBrushPoints(
              safePoints,
              settings.brushPointCount,
              settings.brushPointCurve,
              freehandClosed,
            )
          : safePoints;
      const kind: MapFeature["kind"] = usesFreehandArea
        ? freehandClosed
          ? "area"
          : "route"
        : tool === "river"
          ? "route"
          : tool === "component-surface-brush"
            ? "area"
            : tool;
      const curveProps: Record<string, string> =
        kind === "area" || kind === "route"
          ? { curve: settings.brushPointCurve }
          : {};
      const feature: MapFeature = {
        id,
        kind,
        name:
          tool === "marker"
            ? "新地点"
            : tool === "label"
              ? "新标签"
              : tool === "river"
                ? "新河流"
                : usesFreehandArea
                  ? "自由画笔"
                  : tool === "area"
                    ? "新区域"
                    : tool === "route"
                      ? "新路线"
                      : "新节点",
        entityRef: null,
        layerId: activeLayerId,
        points: normalizedPoints,
        timeFrom: null,
        timeTo: null,
        props:
          tool === "river"
            ? { ...DEFAULT_MAP_RIVER_PROPS, ...curveProps }
            : usesFreehandArea
              ? {
                  ...(freehandClosed ? DEFAULT_MAP_FREEFORM_AREA_PROPS : {}),
                  freehand: "true",
                  closed: freehandClosed ? "true" : "false",
                  ...curveProps,
                }
              : kind === "area"
                ? {
                    ...DEFAULT_MAP_FREEFORM_AREA_PROPS,
                    ...curveProps,
                    ...(geometry instanceof CircleGeometry
                      ? {
                          radius: String(
                            Math.max(1, Math.round(geometry.getRadius())),
                          ),
                        }
                      : {}),
                  }
                : curveProps,
        description: "",
      };
      onCreate(feature);
      source.removeFeature(event.feature);
    });
    map.addInteraction(draw);
    return () => {
      map.removeInteraction(draw);
    };
  }, [
    activeLayerId,
    artworkBrushAssetId,
    onArtworkStampBrush,
    onCreate,
    settings.areaShape,
    settings.brushPointCount,
    settings.brushPointCurve,
    tool,
  ]);

  useEffect(() => {
    layerRef.current?.changed();
  }, [selectedFeatureId, document.layers]);

  useEffect(() => {
    if (focusRequest === 0 || !selectedFeatureId) return;
    const map = mapRef.current;
    const feature = sourceRef.current?.getFeatureById(selectedFeatureId);
    const geometry = feature?.getGeometry();
    if (!map || !geometry) return;
    const extent = geometry.getExtent();
    const width = extent[2] - extent[0];
    const height = extent[3] - extent[1];
    const view = map.getView();
    if (width < 1 && height < 1) {
      view.animate({
        center: getCenter(extent),
        zoom: Math.max(view.getZoom() ?? 0, 5),
        duration: 180,
      });
      return;
    }
    view.fit(extent, {
      duration: 180,
      maxZoom: 5,
      padding: [72, 72, 72, 72],
    });
  }, [focusRequest, selectedFeatureId]);

  const adjustZoom = (delta: number) => {
    const map = mapRef.current;
    if (!map) return;
    const view = map.getView();
    view.setZoom((view.getZoom() ?? 0) + delta);
  };

  const fitCanvas = () => {
    const map = mapRef.current;
    if (map) fitMapToCanvas(map, documentRef.current.canvas, 120);
  };

  return (
    <div
      ref={elementRef}
      className="map-canvas relative h-full min-h-0 w-full overflow-hidden"
      style={mapCanvasBackgroundStyle(document.canvas)}
      aria-label="地图设计画布"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(MAP_COMPONENT_DRAG_MIME)) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        const componentId = event.dataTransfer.getData(MAP_COMPONENT_DRAG_MIME);
        const map = mapRef.current;
        if (!componentId || !map) return;
        event.preventDefault();
        const size = map.getSize();
        const coordinate =
          size && size[0] > 0 && size[1] > 0
            ? map.getEventCoordinate(event.nativeEvent)
            : [document.canvas.width / 2, document.canvas.height / 2];
        onComponentDrop(
          componentId,
          coordinateToPoint(coordinate, document.canvas.height),
        );
      }}
    >
      {document.canvas.backgroundImage &&
        isMapBackgroundImageVisible(document.canvas) && (
          <div
            className="pointer-events-none absolute inset-0 z-0 bg-center bg-no-repeat bg-contain"
            style={{
              backgroundImage: `url(${document.canvas.backgroundImage})`,
              opacity: document.canvas.backgroundOpacity ?? 1,
            }}
            aria-hidden="true"
          />
        )}
      {document.canvas.showGrid && (
        <div className="pointer-events-none absolute inset-0 z-[2] opacity-45 [background-image:linear-gradient(#8b806f22_1px,transparent_1px),linear-gradient(90deg,#8b806f22_1px,transparent_1px)] [background-size:32px_32px]" />
      )}
      <div className="absolute right-3 top-3 z-10 flex flex-col overflow-hidden rounded-md border border-[#746b6038] bg-[#fffaf1] shadow-sm">
        <button
          type="button"
          onClick={() => adjustZoom(1)}
          title="放大地图"
          aria-label="放大地图"
          className="grid h-8 w-8 place-items-center text-[#51483e] hover:bg-[#eee8dc]"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => adjustZoom(-1)}
          title="缩小地图"
          aria-label="缩小地图"
          className="grid h-8 w-8 place-items-center border-t border-[#746b6038] text-[#51483e] hover:bg-[#eee8dc]"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={fitCanvas}
          title="适配画布"
          aria-label="适配画布"
          className="grid h-8 w-8 place-items-center border-t border-[#746b6038] text-[#51483e] hover:bg-[#eee8dc]"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </div>
      <div className="pointer-events-none absolute bottom-3 left-3 rounded border border-[#7f736633] bg-[#fffaf1cc] px-2 py-1 text-xs uppercase tracking-[0.18em] text-[#6e6256]">
        world canvas / {document.projectionType}
      </div>
    </div>
  );
}
