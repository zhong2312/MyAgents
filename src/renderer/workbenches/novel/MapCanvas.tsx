import "ol/ol.css";

import { useEffect, useRef } from "react";
import Feature from "ol/Feature";
import Map from "ol/Map";
import View from "ol/View";
import Collection from "ol/Collection";
import Draw from "ol/interaction/Draw";
import DragPan from "ol/interaction/DragPan";
import Modify from "ol/interaction/Modify";
import Select from "ol/interaction/Select";
import Snap from "ol/interaction/Snap";
import Translate from "ol/interaction/Translate";
import CircleGeometry from "ol/geom/Circle";
import LineString from "ol/geom/LineString";
import Point from "ol/geom/Point";
import Polygon from "ol/geom/Polygon";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import Fill from "ol/style/Fill";
import Stroke from "ol/style/Stroke";
import Style from "ol/style/Style";
import Text from "ol/style/Text";
import CircleStyle from "ol/style/Circle";
import type Geometry from "ol/geom/Geometry";
import type { Coordinate } from "ol/coordinate";

import { type MapDocument, type MapFeature, type MapFeatureKind } from "./mapSchema";

export type MapCanvasTool = "select" | "pan" | MapFeatureKind;

interface MapCanvasProps {
  readonly document: MapDocument;
  readonly tool: MapCanvasTool;
  readonly activeLayerId: string;
  readonly selectedFeatureId: string | null;
  readonly timelineCursor: number | null;
  readonly onSelect: (featureId: string | null) => void;
  readonly onCreate: (feature: MapFeature) => void;
  readonly onGeometryChange: (
    featureId: string,
    points: MapFeature["points"],
    props?: MapFeature["props"],
  ) => void;
}

function pointToCoordinate(point: { x: number; y: number }, canvasHeight: number): Coordinate {
  return [point.x, canvasHeight - point.y];
}

function coordinateToPoint(coordinate: Coordinate, canvasHeight: number): { x: number; y: number } {
  return { x: coordinate[0], y: canvasHeight - coordinate[1] };
}

function pointsFromGeometry(geometry: Geometry, canvasHeight: number): MapFeature["points"] {
  if (geometry instanceof Point) {
    return [coordinateToPoint(geometry.getCoordinates(), canvasHeight)];
  }
  if (geometry instanceof LineString) {
    return geometry.getCoordinates().map((coordinate) => coordinateToPoint(coordinate, canvasHeight));
  }
  if (geometry instanceof Polygon) {
    const ring = geometry.getCoordinates()[0] ?? [];
    const points = ring.slice(0, -1).map((coordinate) => coordinateToPoint(coordinate, canvasHeight));
    return points.length > 0
      ? points
      : ring.map((coordinate) => coordinateToPoint(coordinate, canvasHeight));
  }
  if (geometry instanceof CircleGeometry) {
    return [coordinateToPoint(geometry.getCenter(), canvasHeight)];
  }
  return [];
}

function geometryFromFeature(feature: MapFeature, canvasWidth: number, canvasHeight: number): Geometry {
  const coordinates = feature.points.map((point) => pointToCoordinate(point, canvasHeight));
  if (["marker", "label", "node"].includes(feature.kind)) {
    return new Point(coordinates[0] ?? [canvasWidth / 2, canvasHeight / 2]);
  }
  if (feature.kind === "route") return new LineString(coordinates);
  if (feature.kind === "area") {
    const center = coordinates[0] ?? [canvasWidth / 2, canvasHeight / 2];
    const radius = Number(feature.props.radius ?? 70);
    return new CircleGeometry(center, Number.isFinite(radius) && radius > 0 ? radius : 70);
  }
  const ring = coordinates.length >= 3 ? [...coordinates, coordinates[0]] : coordinates;
  return new Polygon([ring]);
}

function featureStyle(feature: MapFeature, selected: boolean, opacity: number, zIndex: number): Style {
  const color = withOpacity(feature.props.color ?? "#b26d45", opacity);
  const fill = withOpacity(feature.props.fill ?? "#b26d4540", opacity);
  const width = Number(feature.props.lineWidth ?? 2);
  const label = feature.kind === "label" || feature.props.showLabel === "true" ? feature.name : undefined;
  return new Style({
    zIndex,
    image: new CircleStyle({
      radius: selected ? 9 : 7,
      fill: new Fill({ color: feature.kind === "node" ? "#507b88" : color }),
      stroke: new Stroke({ color: selected ? "#fffaf1" : "#423b34", width: selected ? 3 : 1.5 }),
    }),
    fill: new Fill({ color: fill }),
    stroke: new Stroke({ color: selected ? "#c75436" : color, width: selected ? width + 1 : width }),
    text: label
      ? new Text({
          text: feature.name,
          offsetX: 12,
          font: "600 13px system-ui",
          fill: new Fill({ color: "#302c27" }),
          stroke: new Stroke({ color: "#fffaf1cc", width: 4 }),
        })
      : undefined,
  });
}

function withOpacity(color: string, opacity: number): string {
  const normalized = color.trim();
  if (!/^#[0-9a-f]{6,8}$/iu.test(normalized)) return color;
  const hex = normalized.slice(1);
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return `rgba(${red},${green},${blue},${Math.max(0, Math.min(1, alpha * opacity))})`;
}

function mapFeature(feature: MapFeature, canvasWidth: number, canvasHeight: number): Feature<Geometry> {
  const mapped = new Feature({ geometry: geometryFromFeature(feature, canvasWidth, canvasHeight) });
  mapped.setId(feature.id);
  mapped.set("mapFeatureId", feature.id);
  mapped.set("mapFeature", feature);
  return mapped;
}

export default function MapCanvas({
  document,
  tool,
  activeLayerId,
  selectedFeatureId,
  timelineCursor,
  onSelect,
  onCreate,
  onGeometryChange,
}: MapCanvasProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const sourceRef = useRef<VectorSource<Feature<Geometry>> | null>(null);
  const layerRef = useRef<VectorLayer<VectorSource<Feature<Geometry>>> | null>(null);
  const selectRef = useRef<Select | null>(null);
  const editableFeaturesRef = useRef<Collection<Feature<Geometry>> | null>(null);
  const selectedIdRef = useRef(selectedFeatureId);
  const documentRef = useRef(document);
  const viewSizeRef = useRef(`${document.canvas.width}x${document.canvas.height}`);
  selectedIdRef.current = selectedFeatureId;
  documentRef.current = document;

  useEffect(() => {
    if (!elementRef.current) return undefined;
    const source = new VectorSource<Feature<Geometry>>();
    const editableFeatures = new Collection<Feature<Geometry>>();
    const initialDocument = documentRef.current;
    const vector = new VectorLayer({
      source,
      style: (feature) => {
        const value = feature.get("mapFeature") as MapFeature | undefined;
        if (!value) return undefined;
        const layer = documentRef.current.layers.find((item) => item.id === value.layerId);
        const zIndex = layer
          ? documentRef.current.layers.findIndex((item) => item.id === layer.id) + 1
          : 0;
        return featureStyle(value, value.id === selectedIdRef.current, layer?.opacity ?? 1, zIndex);
      },
    });
    const map = new Map({
      target: elementRef.current,
      layers: [vector],
      view: new View({
        center: [initialDocument.canvas.width / 2, initialDocument.canvas.height / 2],
        zoom: 0,
        minZoom: -3,
        maxZoom: 5,
        extent: [0, 0, initialDocument.canvas.width, initialDocument.canvas.height],
      }),
      controls: [],
    });
    const select = new Select({
      hitTolerance: 6,
      filter: (feature) => {
        const value = feature.get("mapFeature") as MapFeature | undefined;
        return value
          ? !documentRef.current.layers.find((layer) => layer.id === value.layerId)?.locked
          : false;
      },
    });
    select.on("select", (event) => {
      const feature = event.selected[0];
      onSelect(feature ? String(feature.getId()) : null);
    });
    map.addInteraction(select);
    const dragPan = map.getInteractions().getArray().find((interaction) => interaction instanceof DragPan);
    if (dragPan) dragPan.setActive(true);
    const translate = new Translate({ features: select.getFeatures() });
    translate.on("translateend", (event) => {
      event.features.forEach((feature) => {
        const id = feature.get("mapFeatureId");
        const geometry = feature.getGeometry();
        if (typeof id === "string" && geometry) {
          onGeometryChange(id, pointsFromGeometry(geometry, documentRef.current.canvas.height));
        }
      });
    });
    map.addInteraction(translate);
    const modify = new Modify({ features: editableFeatures });
    modify.on("modifyend", (event) => {
      event.features.forEach((feature) => {
        const id = feature.get("mapFeatureId");
        const geometry = feature.getGeometry();
        if (typeof id === "string" && geometry) {
          onGeometryChange(
            id,
            pointsFromGeometry(geometry, documentRef.current.canvas.height),
            geometry instanceof CircleGeometry
              ? { radius: String(Math.max(1, Math.round(geometry.getRadius()))) }
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
    const viewport = map.getTargetElement().querySelector<HTMLElement>(".ol-viewport");
    if (viewport) viewport.style.zIndex = "1";
    return () => {
      map.setTarget(undefined);
      mapRef.current = null;
      sourceRef.current = null;
      layerRef.current = null;
      selectRef.current = null;
      editableFeaturesRef.current = null;
    };
  }, [onGeometryChange, onSelect]);

  useEffect(() => {
    const source = sourceRef.current;
    const map = mapRef.current;
    if (!source || !map) return;
    source.clear();
    editableFeaturesRef.current?.clear();
    selectRef.current?.getFeatures().clear();
    const features = document.features
      .filter((feature) => {
        const layer = document.layers.find((item) => item.id === feature.layerId);
        if (!layer?.visible) return false;
        if (timelineCursor === null) return true;
        return (
          (feature.timeFrom === null || timelineCursor >= feature.timeFrom) &&
          (feature.timeTo === null || timelineCursor <= feature.timeTo)
        );
      })
      .map((feature) => mapFeature(feature, document.canvas.width, document.canvas.height));
    source.addFeatures(features);
    features.forEach((feature) => {
      const value = feature.get("mapFeature") as MapFeature | undefined;
      const layer = value
        ? document.layers.find((item) => item.id === value.layerId)
        : undefined;
      if (layer && !layer.locked) editableFeaturesRef.current?.push(feature);
    });
    const selected = features.find((feature) => String(feature.getId()) === selectedIdRef.current);
    if (selected) selectRef.current?.getFeatures().push(selected);
    const viewSize = `${document.canvas.width}x${document.canvas.height}`;
    if (viewSizeRef.current !== viewSize) {
      map.setView(
        new View({
          center: [document.canvas.width / 2, document.canvas.height / 2],
          zoom: 0,
          minZoom: -3,
          maxZoom: 5,
          extent: [0, 0, document.canvas.width, document.canvas.height],
        }),
      );
      map.getView().fit([0, 0, document.canvas.width, document.canvas.height], { duration: 0 });
      viewSizeRef.current = viewSize;
    }
    layerRef.current?.changed();
  }, [document, timelineCursor]);

  useEffect(() => {
    const map = mapRef.current;
    const source = sourceRef.current;
    if (!map || !source) return;
    map.getInteractions().forEach((interaction) => {
      if (interaction instanceof DragPan) interaction.setActive(tool === "pan");
      if (interaction instanceof Select || interaction instanceof Modify || interaction instanceof Translate) {
        interaction.setActive(tool === "select");
      }
    });
    map.getInteractions().forEach((interaction) => {
      if (interaction instanceof Draw) map.removeInteraction(interaction);
    });
    if (tool === "select" || tool === "pan") {
      map.getTargetElement().style.cursor = tool === "pan" ? "grab" : "default";
      return;
    }
    const drawType = tool === "marker" || tool === "label" || tool === "node" ? "Point" : tool === "route" ? "LineString" : tool === "polygon" ? "Polygon" : "Circle";
    const draw = new Draw({ source, type: drawType, stopClick: true });
    draw.on("drawend", (event) => {
      const geometry = event.feature.getGeometry();
      if (!geometry) return;
      const points = pointsFromGeometry(geometry, documentRef.current.canvas.height);
      const feature: MapFeature = {
        id: `feature-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        kind: tool,
        name: tool === "marker" ? "新地点" : tool === "label" ? "新标签" : tool === "area" ? "新区域" : tool === "polygon" ? "新区域" : tool === "route" ? "新路线" : "新节点",
        entityRef: null,
        layerId: activeLayerId,
        points: points.length > 0
          ? points
          : [{ x: documentRef.current.canvas.width / 2, y: documentRef.current.canvas.height / 2 }],
        timeFrom: null,
        timeTo: null,
        props:
          tool === "area" && geometry instanceof CircleGeometry
            ? { radius: String(Math.max(1, Math.round(geometry.getRadius()))) }
            : {},
        description: "",
      };
      onCreate(feature);
      source.removeFeature(event.feature);
    });
    map.addInteraction(draw);
    return () => {
      map.removeInteraction(draw);
    };
  }, [activeLayerId, onCreate, tool]);

  useEffect(() => {
    layerRef.current?.changed();
  }, [selectedFeatureId, document.layers]);

  return (
    <div
      ref={elementRef}
      className="map-canvas relative h-full min-h-0 w-full overflow-hidden"
      style={{ backgroundColor: document.canvas.backgroundColor }}
      aria-label="地图设计画布"
    >
      {document.canvas.backgroundImage && (
        <div
          className="pointer-events-none absolute inset-0 z-0 bg-center bg-no-repeat bg-contain"
          style={{
            backgroundImage: `url(${document.canvas.backgroundImage})`,
            opacity: document.canvas.backgroundOpacity ?? 1,
          }}
          aria-hidden="true"
        />
      )}
      {document.canvas.showGrid && <div className="pointer-events-none absolute inset-0 z-[2] opacity-45 [background-image:linear-gradient(#8b806f22_1px,transparent_1px),linear-gradient(90deg,#8b806f22_1px,transparent_1px)] [background-size:32px_32px]" />}
      <div className="pointer-events-none absolute bottom-3 left-3 rounded border border-[#7f736633] bg-[#fffaf1cc] px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-[#6e6256]">world canvas / {document.projectionType}</div>
    </div>
  );
}
