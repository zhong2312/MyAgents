import type { MapArtworkAssetVariant } from "./mapArtwork";
import type { MapArtworkStamp, MapScenePoint } from "../entities/mapSchema";

export type MapArtworkStampTransform = Pick<
  MapArtworkStamp,
  "rotation" | "scale" | "x" | "y"
>;

/**
 * 从工具栏选择素材后，在画布上拖出成品印章的放置手势。
 * 起点和终点都是 MapDocument 的世界坐标，不携带屏幕坐标或相机状态。
 */
export type MapArtworkStampPlacementGesture = {
  readonly start: MapScenePoint;
  readonly end: MapScenePoint;
};

export type MapArtworkStampSize = {
  readonly width: number;
  readonly height: number;
};

export type MapArtworkTransformHandleId =
  | "scale-north-west"
  | "scale-north-east"
  | "scale-south-east"
  | "scale-south-west"
  | "rotate";

export type MapArtworkTransformHandle = {
  readonly id: MapArtworkTransformHandleId;
  readonly point: MapScenePoint;
};

const MIN_STAMP_SCALE = 0.05;
const MAX_STAMP_SCALE = 20;
const ROTATE_HANDLE_OFFSET_PX = 28;
const HANDLE_HIT_RADIUS_PX = 11;
const PLACEMENT_DRAG_THRESHOLD = 8;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function distance(a: MapScenePoint, b: MapScenePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalizeRotation(rotation: number): number {
  let normalized = rotation;
  while (normalized > 180) normalized -= 360;
  while (normalized <= -180) normalized += 360;
  return normalized;
}

function rotateLocalPoint(
  local: MapScenePoint,
  center: MapScenePoint,
  rotation: number,
): MapScenePoint {
  const radians = (rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: center.x + local.x * cosine - local.y * sine,
    y: center.y + local.x * sine + local.y * cosine,
  };
}

export function mapArtworkStampRenderSize(
  stamp: Pick<MapArtworkStamp, "scale">,
  variant: Pick<MapArtworkAssetVariant, "height" | "width">,
): MapArtworkStampSize {
  const baseScale = Math.min(1, 150 / Math.max(variant.width, variant.height));
  const scale =
    baseScale * clamp(stamp.scale, MIN_STAMP_SCALE, MAX_STAMP_SCALE);
  return {
    width: variant.width * scale,
    height: variant.height * scale,
  };
}

/**
 * 将一次“拖出印章”手势转换为可持久化的印章变换。
 *
 * 拖动距离代表成品最长边，印章中心落在起终点中点，拖动方向映射为
 * 旋转角度；点击或极短拖动仍保持工具栏设定的默认尺寸与 0 度角。所有
 * 限制集中在这里，使放置预览、编辑器提交和导出使用同一套数学规则。
 */
export function mapArtworkStampPlacementTransform(input: {
  readonly anchor: MapScenePoint;
  readonly defaultScale: number;
  readonly variant: Pick<MapArtworkAssetVariant, "height" | "width">;
  readonly gesture?: MapArtworkStampPlacementGesture;
}): MapArtworkStampTransform {
  const defaultScale = clamp(
    input.defaultScale,
    MIN_STAMP_SCALE,
    MAX_STAMP_SCALE,
  );
  if (!input.gesture) {
    return {
      x: input.anchor.x,
      y: input.anchor.y,
      scale: defaultScale,
      rotation: 0,
    };
  }
  const { start, end } = input.gesture;
  const dragDistance = distance(start, end);
  if (
    !Number.isFinite(dragDistance) ||
    dragDistance < PLACEMENT_DRAG_THRESHOLD
  ) {
    return {
      x: input.anchor.x,
      y: input.anchor.y,
      scale: defaultScale,
      rotation: 0,
    };
  }
  const baseSize = mapArtworkStampRenderSize(
    { scale: defaultScale },
    input.variant,
  );
  const baseLongestEdge = Math.max(baseSize.width, baseSize.height);
  const scale =
    baseLongestEdge > 0
      ? clamp(
          defaultScale * (dragDistance / baseLongestEdge),
          MIN_STAMP_SCALE,
          MAX_STAMP_SCALE,
        )
      : defaultScale;
  return {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
    scale,
    rotation: normalizeRotation(
      (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI,
    ),
  };
}

export function mapArtworkTransformHandles(
  stamp: MapArtworkStampTransform,
  size: MapArtworkStampSize,
  cameraZoom: number,
): readonly MapArtworkTransformHandle[] {
  const halfWidth = size.width / 2;
  const halfHeight = size.height / 2;
  const center = { x: stamp.x, y: stamp.y };
  const corners = [
    { id: "scale-north-west", point: { x: -halfWidth, y: -halfHeight } },
    { id: "scale-north-east", point: { x: halfWidth, y: -halfHeight } },
    { id: "scale-south-east", point: { x: halfWidth, y: halfHeight } },
    { id: "scale-south-west", point: { x: -halfWidth, y: halfHeight } },
  ] as const;
  return [
    ...corners.map((handle) => ({
      id: handle.id,
      point: rotateLocalPoint(handle.point, center, stamp.rotation),
    })),
    {
      id: "rotate" as const,
      point: rotateLocalPoint(
        {
          x: 0,
          y: -halfHeight - ROTATE_HANDLE_OFFSET_PX / Math.max(0.08, cameraZoom),
        },
        center,
        stamp.rotation,
      ),
    },
  ];
}

export function hitMapArtworkTransformHandle(
  point: MapScenePoint,
  handles: readonly MapArtworkTransformHandle[],
  cameraZoom: number,
): MapArtworkTransformHandleId | null {
  const radius = HANDLE_HIT_RADIUS_PX / Math.max(0.08, cameraZoom);
  const rotateHandle = handles.find((handle) => handle.id === "rotate");
  if (rotateHandle && distance(point, rotateHandle.point) <= radius) {
    return rotateHandle.id;
  }
  return (
    handles.find((handle) => distance(point, handle.point) <= radius)?.id ??
    null
  );
}

export function scaleMapArtworkStampFromPointer(
  initial: MapArtworkStampTransform,
  start: MapScenePoint,
  current: MapScenePoint,
): number {
  const center = { x: initial.x, y: initial.y };
  const initialDistance = distance(center, start);
  if (initialDistance < 0.001) return initial.scale;
  return clamp(
    initial.scale * (distance(center, current) / initialDistance),
    MIN_STAMP_SCALE,
    MAX_STAMP_SCALE,
  );
}

export function rotateMapArtworkStampFromPointer(
  initial: MapArtworkStampTransform,
  start: MapScenePoint,
  current: MapScenePoint,
): number {
  const startAngle = Math.atan2(start.y - initial.y, start.x - initial.x);
  const currentAngle = Math.atan2(current.y - initial.y, current.x - initial.x);
  return normalizeRotation(
    initial.rotation + ((currentAngle - startAngle) * 180) / Math.PI,
  );
}
