import type {
  MapScene,
  MapBrushPointCurve,
  MapScenePoint,
  MapSceneStroke,
} from "../entities/mapSchema";
import { mapBrushCurvePoints } from "./mapFeatureShapes";

export type MapSceneEraserInput = {
  /** 当前绘图层。橡皮不能跨层修改场景内容。 */
  readonly layerId: string;
  readonly points: readonly MapScenePoint[];
  /** 橡皮轨迹与画布显示保持同一条直线/弧线中心线。 */
  readonly curve?: MapBrushPointCurve;
  readonly width: number;
};

function distanceToSegment(
  point: MapScenePoint,
  start: MapScenePoint,
  end: MapScenePoint,
): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared <= Number.EPSILON) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const ratio = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) /
        lengthSquared,
    ),
  );
  return Math.hypot(
    point.x - (start.x + deltaX * ratio),
    point.y - (start.y + deltaY * ratio),
  );
}

function distanceToPath(
  point: MapScenePoint,
  path: readonly MapScenePoint[],
): number {
  if (path.length === 0) return Number.POSITIVE_INFINITY;
  if (path.length === 1)
    return Math.hypot(point.x - path[0]!.x, point.y - path[0]!.y);
  return path
    .slice(1)
    .reduce(
      (nearest, end, index) =>
        Math.min(nearest, distanceToSegment(point, path[index]!, end)),
      Number.POSITIVE_INFINITY,
    );
}

function sampledStrokePoints(
  stroke: MapSceneStroke,
  spacing: number,
): MapScenePoint[] {
  if (stroke.points.length <= 1)
    return stroke.points.map((point) => ({ ...point }));
  const samples: MapScenePoint[] = [{ ...stroke.points[0]! }];
  for (let index = 1; index < stroke.points.length; index += 1) {
    const start = stroke.points[index - 1]!;
    const end = stroke.points[index]!;
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / spacing),
    );
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      samples.push({
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio,
      });
    }
  }
  return samples;
}

function clippedStrokeFragments(
  stroke: MapSceneStroke,
  eraserPoints: readonly MapScenePoint[],
  eraserWidth: number,
  allocateId: (sourceId: string, fragmentIndex: number) => string,
): readonly MapSceneStroke[] {
  if (stroke.tool === "erase" || eraserPoints.length === 0) return [stroke];
  const samples = sampledStrokePoints(
    {
      ...stroke,
      points: mapBrushCurvePoints(stroke.points, stroke.curve),
    },
    Math.max(6, Math.min(stroke.spacing * 0.45, eraserWidth * 0.24)),
  );
  const coverage = eraserWidth / 2 + stroke.width / 2;
  const retained = samples.map(
    (point) => distanceToPath(point, eraserPoints) > coverage,
  );
  if (retained.every(Boolean)) return [stroke];

  const fragments: MapScenePoint[][] = [];
  let current: MapScenePoint[] = [];
  samples.forEach((point, index) => {
    if (retained[index]) {
      current.push(point);
      return;
    }
    if (current.length > 0) fragments.push(current);
    current = [];
  });
  if (current.length > 0) fragments.push(current);
  return fragments.map((points, index) => ({
    ...stroke,
    id: index === 0 ? stroke.id : allocateId(stroke.id, index + 1),
    points,
  }));
}

/**
 * 真正擦除当前绘图层内命中的笔触事实。旧版的 `erase` 笔触只用于兼容
 * 读取；新的橡皮不会创建覆盖笔触、水域区域，或改写其他绘图层。
 */
export function eraseMapSceneContent(
  scene: MapScene,
  input: MapSceneEraserInput,
): MapScene {
  if (input.points.length === 0) return scene;
  const eraserPoints = mapBrushCurvePoints(
    input.points,
    input.curve,
  );
  const occupiedIds = new Set(
    scene.layers.flatMap((layer) => layer.strokes.map((stroke) => stroke.id)),
  );
  const allocateId = (sourceId: string, fragmentIndex: number) => {
    const base = `${sourceId}-cut-${fragmentIndex}`;
    let id = base;
    let suffix = 2;
    while (occupiedIds.has(id)) id = `${base}-${suffix++}`;
    occupiedIds.add(id);
    return id;
  };
  const erasedStrokes: MapScene = {
    ...scene,
    layers: scene.layers.map((layer) =>
      layer.id === input.layerId
        ? {
            ...layer,
            strokes: layer.strokes.flatMap((stroke) =>
              clippedStrokeFragments(
                stroke,
                eraserPoints,
                input.width,
                allocateId,
              ),
            ),
          }
        : layer,
    ),
  };
  return erasedStrokes;
}
