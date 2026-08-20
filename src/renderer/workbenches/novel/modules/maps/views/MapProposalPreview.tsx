import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import type { CSSProperties, PointerEvent, WheelEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  getMapArtworkStampAsset,
  getMapArtworkAssetVariant,
  mapArtworkVariantIndex,
} from "../business/mapArtwork";
import {
  mapArtworkLayersInRenderOrder,
  type MapArtworkRenderPhase,
} from "../business/mapArtworkLayerOrder";
import {
  getMapBackgroundImagePlacement,
  getMapBackgroundPreset,
  isMapBackgroundImageVisible,
  mapCanvasBackgroundStyle,
} from "../business/mapBackgrounds";
import { smoothMapPath } from "../business/mapHydrography";
import { getMapTerrainMaterialPreset } from "../business/mapTerrainMaterials";
import { mapArtworkStampRenderSize } from "../business/mapArtworkTransform";
import { renderMapDocumentToCanvas } from "./mapSceneExporter";
import { isMapFeatureFreeformArea } from "../entities/mapSchema";
import type {
  MapDocument,
  MapFeature,
  MapScenePoint,
  MapSceneRegion,
  MapSceneStroke,
} from "../entities/mapSchema";

type MapProposalPreviewProps = {
  readonly map: MapDocument;
  readonly className?: string;
};

type PreviewViewport = {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
};

type PreviewDrag = {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
};

const DEFAULT_PREVIEW_VIEWPORT: PreviewViewport = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
};
const MIN_PREVIEW_SCALE = 0.5;
const MAX_PREVIEW_SCALE = 4;

function clampPreviewScale(value: number): number {
  return Math.max(MIN_PREVIEW_SCALE, Math.min(MAX_PREVIEW_SCALE, value));
}

function pointsToPath(points: readonly MapScenePoint[], close = false): string {
  if (points.length === 0) return "";
  const path = points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`,
    )
    .join(" ");
  return close ? `${path} Z` : path;
}

function featurePath(feature: MapFeature): string {
  const points =
    feature.kind === "route" ? smoothMapPath(feature.points) : feature.points;
  return pointsToPath(points, isMapFeatureFreeformArea(feature.kind));
}

function regionPath(region: MapSceneRegion): string {
  return pointsToPath(region.points, true);
}

function strokePath(stroke: MapSceneStroke): string {
  return pointsToPath(stroke.points);
}

function featureLabelAnchor(feature: MapFeature): MapScenePoint | null {
  if (feature.points.length === 0) return null;
  if (feature.points.length === 1) return feature.points[0]!;
  const total = feature.points.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 },
  );
  return {
    x: total.x / feature.points.length,
    y: total.y / feature.points.length,
  };
}

function layerOpacity(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value!)) : 1;
}

function featureStrokeWidth(feature: MapFeature): number {
  const value = Number.parseFloat(
    feature.props.lineWidth ??
      feature.props.routeWidth ??
      feature.props.sourceWidth ??
      "2",
  );
  return Number.isFinite(value) ? Math.max(0.5, value) : 2;
}

function terrainStrokeColor(stroke: MapSceneStroke): string {
  if (stroke.terrainMaterial) {
    return getMapTerrainMaterialPreset(stroke.terrainMaterial).color;
  }
  return stroke.color;
}

function backgroundStyle(map: MapDocument): CSSProperties {
  const preset = getMapBackgroundPreset(map.canvas.backgroundPreset);
  const style = mapCanvasBackgroundStyle(map.canvas);
  return {
    backgroundColor: style.backgroundColor ?? preset.color,
    backgroundImage: style.backgroundImage,
    backgroundSize: style.backgroundSize,
  };
}

function PreviewBackground({ map }: { readonly map: MapDocument }) {
  if (!map.canvas.backgroundImage || !isMapBackgroundImageVisible(map.canvas)) {
    return null;
  }
  const width = map.canvas.backgroundImageWidth ?? map.canvas.width;
  const height = map.canvas.backgroundImageHeight ?? map.canvas.height;
  const placement =
    map.canvas.backgroundImagePlacement ??
    getMapBackgroundImagePlacement(map.canvas, width, height);
  if (!placement) return null;
  return (
    <image
      href={map.canvas.backgroundImage}
      x={placement.x}
      y={placement.y}
      width={placement.width}
      height={placement.height}
      opacity={map.canvas.backgroundOpacity ?? 1}
      preserveAspectRatio="none"
    />
  );
}

function PreviewScene({ map }: { readonly map: MapDocument }) {
  return (
    <>
      {map.scene?.layers.map((layer) => {
        if (!layer.visible) return null;
        const opacity = layerOpacity(layer.opacity);
        return (
          <g key={layer.id} opacity={opacity}>
            {layer.regions.map((region) => (
              <path
                key={region.id}
                d={regionPath(region)}
                fill={region.fill}
                fillOpacity={region.opacity}
                stroke={region.edgeColor}
                strokeWidth={Math.max(0.6, region.edgeWidth)}
                strokeLinejoin="round"
              />
            ))}
            {layer.strokes.map((stroke) => {
              if (stroke.tool === "erase") return null;
              return (
                <path
                  key={stroke.id}
                  d={strokePath(stroke)}
                  fill="none"
                  stroke={terrainStrokeColor(stroke)}
                  strokeWidth={Math.max(1, stroke.width)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={stroke.opacity}
                />
              );
            })}
          </g>
        );
      })}
    </>
  );
}

function PreviewFeatures({ map }: { readonly map: MapDocument }) {
  return (
    <>
      {map.features.map((feature) => {
        const layer = map.layers.find(
          (candidate) => candidate.id === feature.layerId,
        );
        if (!layer?.visible) return null;
        const opacity = layerOpacity(layer.opacity);
        const path = featurePath(feature);
        const isShape = isMapFeatureFreeformArea(feature.kind);
        const isPoint =
          feature.kind === "marker" ||
          feature.kind === "label" ||
          feature.kind === "node";
        const anchor = featureLabelAnchor(feature);
        const markerAsset =
          feature.kind === "marker"
            ? getMapArtworkStampAsset(feature.props.component ?? "")
            : null;
        const markerVariant = markerAsset
          ? getMapArtworkAssetVariant(
              markerAsset,
              mapArtworkVariantIndex(markerAsset, feature.id),
            )
          : null;
        const markerWidth = markerVariant
          ? Math.min(
              72,
              Math.max(
                30,
                Math.max(markerVariant.width, markerVariant.height) * 0.42,
              ),
            )
          : 0;
        const markerHeight = markerVariant
          ? (markerWidth * markerVariant.height) / markerVariant.width
          : 0;
        const showLabel =
          feature.kind === "label" || feature.props.showLabel === "true";
        return (
          <g key={feature.id} opacity={opacity}>
            {!isPoint && path && (
              <path
                d={path}
                fill={isShape ? (feature.props.fill ?? "#b8ad7d88") : "none"}
                stroke={feature.props.color ?? "#655540"}
                strokeWidth={featureStrokeWidth(feature)}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            {isPoint && anchor && markerVariant ? (
              <image
                href={markerVariant.imageSrc}
                x={anchor.x - markerWidth / 2}
                y={anchor.y - markerHeight / 2}
                width={markerWidth}
                height={markerHeight}
                preserveAspectRatio="none"
              />
            ) : isPoint && anchor ? (
              <circle
                cx={anchor.x}
                cy={anchor.y}
                r={Math.max(4, feature.kind === "node" ? 6 : 4)}
                fill={feature.props.color ?? "#7c684f"}
                stroke="#fffaf1"
                strokeWidth={2}
              />
            ) : null}
            {showLabel && anchor && feature.name && (
              <text
                x={anchor.x}
                y={anchor.y - 8}
                fill={feature.props.labelColor ?? "#453a32"}
                fontSize={Math.max(10, Number(feature.props.labelSize ?? 14))}
                textAnchor="middle"
                paintOrder="stroke"
                stroke="#fffaf1"
                strokeWidth={3}
                strokeOpacity={0.82}
              >
                {feature.name}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
}

function PreviewArtwork({
  map,
  phase,
}: {
  readonly map: MapDocument;
  readonly phase: MapArtworkRenderPhase;
}) {
  return (
    <>
      {mapArtworkLayersInRenderOrder(map.artwork, phase).map((layer) => {
        if (!layer.visible) return null;
        const opacity = layerOpacity(layer.opacity);
        return layer.stamps.map((stamp) => {
          const asset = getMapArtworkStampAsset(stamp.assetId);
          const variant = asset
            ? getMapArtworkAssetVariant(asset, stamp.variant)
            : null;
          if (!variant) {
            return (
              <circle
                key={stamp.id}
                cx={stamp.x}
                cy={stamp.y}
                r={Math.max(4, 10 * stamp.scale)}
                fill="#7c684f"
                opacity={opacity * stamp.opacity}
              />
            );
          }
          const size = mapArtworkStampRenderSize(stamp, variant);
          return (
            <image
              key={stamp.id}
              href={variant.imageSrc}
              x={stamp.x - size.width / 2}
              y={stamp.y - size.height / 2}
              width={size.width}
              height={size.height}
              opacity={opacity * stamp.opacity}
              preserveAspectRatio="none"
              transform={`rotate(${stamp.rotation} ${stamp.x} ${stamp.y})`}
            />
          );
        });
      })}
    </>
  );
}

export default function MapProposalPreview({
  map,
  className = "",
}: MapProposalPreviewProps) {
  const [viewport, setViewport] = useState<PreviewViewport>(
    DEFAULT_PREVIEW_VIEWPORT,
  );
  const [rasterPreview, setRasterPreview] = useState<{
    readonly mapId: string;
    readonly src: string;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<PreviewDrag | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    void renderMapDocumentToCanvas(map, null, undefined, { maxEdge: 960 })
      .then((canvas) => {
        if (disposed) return;
        try {
          setRasterPreview({
            mapId: map.id,
            src: canvas.toDataURL("image/png"),
          });
        } catch {
          // SVG 兼容预览仍可展示，不能让浏览器的 Canvas 编码限制阻断候选审阅。
        }
      })
      .catch(() => {
        // 旧版 WebView 或无 Canvas 环境继续使用下方 SVG 预览。
      });
    return () => {
      disposed = true;
    };
  }, [map]);

  const zoomAt = useCallback(
    (factor: number, anchorX: number, anchorY: number) => {
      setViewport((current) => {
        const scale = clampPreviewScale(current.scale * factor);
        if (scale === current.scale) return current;
        const ratio = scale / current.scale;
        return {
          scale,
          offsetX: anchorX - (anchorX - current.offsetX) * ratio,
          offsetY: anchorY - (anchorY - current.offsetY) * ratio,
        };
      });
    },
    [],
  );

  const resetViewport = useCallback(() => {
    setViewport(DEFAULT_PREVIEW_VIEWPORT);
  }, []);

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    zoomAt(
      event.deltaY < 0 ? 1.12 : 0.89,
      event.clientX - bounds.left,
      event.clientY - bounds.top,
    );
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.clientX;
    const deltaY = event.clientY - drag.clientY;
    if (deltaX === 0 && deltaY === 0) return;
    dragRef.current = {
      pointerId: drag.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    setViewport((current) => ({
      ...current,
      offsetX: current.offsetX + deltaX,
      offsetY: current.offsetY + deltaY,
    }));
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsDragging(false);
    dragRef.current = null;
  };

  return (
    <div
      className={`overflow-hidden rounded-md border border-[var(--line-subtle)] bg-[var(--paper-inset)] ${className}`}
      aria-label={`地图候选预览：${map.name}`}
      aria-roledescription="可缩放地图预览"
      role="region"
    >
      <div
        ref={viewportRef}
        className="relative aspect-[16/10] min-h-40 overflow-hidden"
        data-map-proposal-viewport="true"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          ...backgroundStyle(map),
          cursor: isDragging ? "grabbing" : "grab",
          touchAction: "none",
        }}
      >
        {rasterPreview?.mapId === map.id ? (
          <img
            src={rasterPreview.src}
            alt=""
            data-map-proposal-raster="true"
            draggable={false}
            className="absolute left-0 top-0 h-full w-full object-contain"
            style={{
              transform: `translate(${viewport.offsetX}px, ${viewport.offsetY}px) scale(${viewport.scale})`,
              transformOrigin: "0 0",
            }}
          />
        ) : (
          <svg
            viewBox={`0 0 ${map.canvas.width} ${map.canvas.height}`}
            className="absolute left-0 top-0 h-full w-full"
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
            style={{
              transform: `translate(${viewport.offsetX}px, ${viewport.offsetY}px) scale(${viewport.scale})`,
              transformOrigin: "0 0",
            }}
          >
            <PreviewBackground map={map} />
            <PreviewArtwork map={map} phase="base" />
            <PreviewScene map={map} />
            <PreviewArtwork map={map} phase="scene" />
            <PreviewFeatures map={map} />
            <PreviewArtwork map={map} phase="feature" />
            <PreviewArtwork map={map} phase="overlay" />
          </svg>
        )}
        <div
          className="absolute right-2 top-2 z-10 flex overflow-hidden rounded-md border border-[#746b6038] bg-[#fffaf1ee] shadow-sm"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              const bounds = viewportRef.current?.getBoundingClientRect();
              zoomAt(
                1.2,
                bounds ? bounds.width / 2 : 0,
                bounds ? bounds.height / 2 : 0,
              );
            }}
            title="放大候选地图"
            aria-label="放大候选地图"
            className="grid h-8 w-8 place-items-center text-[#51483e] hover:bg-[#eee8dc]"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              const bounds = viewportRef.current?.getBoundingClientRect();
              zoomAt(
                0.84,
                bounds ? bounds.width / 2 : 0,
                bounds ? bounds.height / 2 : 0,
              );
            }}
            title="缩小候选地图"
            aria-label="缩小候选地图"
            className="grid h-8 w-8 place-items-center border-l border-[#746b6038] text-[#51483e] hover:bg-[#eee8dc]"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              resetViewport();
            }}
            title="适配候选地图"
            aria-label="适配候选地图"
            className="grid h-8 w-8 place-items-center border-l border-[#746b6038] text-[#51483e] hover:bg-[#eee8dc]"
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-[var(--line-subtle)] px-2.5 py-1.5 text-xs text-[var(--ink-muted)]">
        <span className="truncate">
          {getMapBackgroundPreset(map.canvas.backgroundPreset).name}
        </span>
        <span className="shrink-0 tabular-nums">
          {Math.round(map.canvas.width)} × {Math.round(map.canvas.height)}
        </span>
      </div>
    </div>
  );
}
