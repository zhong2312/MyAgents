import type { MapScenePoint } from "../entities/mapSchema";

export type MapSceneCamera = {
  x: number;
  y: number;
  zoom: number;
  fitted: boolean;
};

export type MapSceneViewport = {
  readonly width: number;
  readonly height: number;
};

/** 地图世界中的可见内容范围；相机适配不关心对象的具体类型。 */
export type MapSceneBounds = {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * 平移必须以屏幕坐标的相邻采样计算。若用地图坐标，上一帧更新相机后，
 * 下一帧的坐标反算会抵消刚发生的平移，造成只能拖动一下的假象。
 */
export function panMapSceneCamera(
  camera: MapSceneCamera,
  previousScreenPoint: MapScenePoint,
  nextScreenPoint: MapScenePoint,
): MapSceneCamera {
  return {
    ...camera,
    x: camera.x + nextScreenPoint.x - previousScreenPoint.x,
    y: camera.y + nextScreenPoint.y - previousScreenPoint.y,
  };
}

/**
 * 拖动内容到视口边沿时自动向对应方向平移相机。
 *
 * 位移以屏幕像素计算，不受当前缩放等级影响；因此无论作者放大还是缩小，
 * 指针留在边沿时都能以稳定的手感把世界坐标继续带出原有画布。持久化的
 * 画布扩展仍由提交手势时的 MapDocument 边界计算统一完成。
 */
export function autoPanMapSceneCameraAtEdge(
  camera: MapSceneCamera,
  screenPoint: MapScenePoint,
  viewport: MapSceneViewport,
  edgeSize = 56,
  maximumStep = 24,
): MapSceneCamera {
  const width = Number.isFinite(viewport.width) ? viewport.width : 0;
  const height = Number.isFinite(viewport.height) ? viewport.height : 0;
  if (width <= 0 || height <= 0) return camera;

  const edge = Math.max(
    1,
    Math.min(Math.round(edgeSize), width / 2, height / 2),
  );
  const step = Math.max(0, Number.isFinite(maximumStep) ? maximumStep : 0);
  if (step === 0) return camera;

  const edgeStrength = (value: number, size: number): number => {
    if (value < edge) return -Math.min(1, (edge - value) / edge);
    if (value > size - edge) return Math.min(1, (value - (size - edge)) / edge);
    return 0;
  };
  const horizontal = edgeStrength(screenPoint.x, width);
  const vertical = edgeStrength(screenPoint.y, height);
  if (horizontal === 0 && vertical === 0) return camera;

  return {
    ...camera,
    // 右/下边沿需要把世界向左/上推，才能让指针继续抵达更大的地图坐标。
    x: camera.x - horizontal * step,
    y: camera.y - vertical * step,
  };
}

/**
 * 左、上方向扩展画布时，MapDocument 会把全部坐标向正方向重定位。
 * 相机反向补偿同一段屏幕距离，避免作者松开鼠标后看到内容跳动。
 */
export function rebaseMapSceneCamera(
  camera: MapSceneCamera,
  translation: MapScenePoint,
): MapSceneCamera {
  return {
    ...camera,
    x: camera.x - translation.x * camera.zoom,
    y: camera.y - translation.y * camera.zoom,
  };
}

/**
 * 将视口适配到实际内容范围。它只更新相机，不修改 MapDocument 中的画布
 * 尺寸或任何要素坐标，因此可以安全用于“定位到素材”和生成后的构图预览。
 */
export function fitMapSceneCameraToBounds(
  camera: MapSceneCamera,
  bounds: MapSceneBounds,
  viewport: MapSceneViewport,
  padding = 48,
  minimumZoom = 0.08,
  maximumZoom = 8,
): MapSceneCamera {
  const width = Number.isFinite(viewport.width) ? viewport.width : 0;
  const height = Number.isFinite(viewport.height) ? viewport.height : 0;
  const hasFiniteBounds = [
    bounds.left,
    bounds.right,
    bounds.top,
    bounds.bottom,
  ].every(Number.isFinite);
  if (
    width <= 0 ||
    height <= 0 ||
    !hasFiniteBounds ||
    bounds.right < bounds.left ||
    bounds.bottom < bounds.top
  ) {
    return camera;
  }

  const safePadding = Math.max(
    0,
    Math.min(Number.isFinite(padding) ? padding : 48, width / 2, height / 2),
  );
  // 单点和极短线段仍应以可操作的尺寸进入视口，而不是被无限放大。
  const contentWidth = Math.max(48, bounds.right - bounds.left);
  const contentHeight = Math.max(48, bounds.bottom - bounds.top);
  const zoom = clamp(
    Math.min(
      Math.max(1, width - safePadding * 2) / contentWidth,
      Math.max(1, height - safePadding * 2) / contentHeight,
    ),
    minimumZoom,
    maximumZoom,
  );
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  return {
    x: width / 2 - centerX * zoom,
    y: height / 2 - centerY * zoom,
    zoom,
    fitted: true,
  };
}

/** 缩放围绕屏幕锚点进行，锚点下的地图坐标在缩放前后保持不变。 */
export function zoomMapSceneCameraAt(
  camera: MapSceneCamera,
  screenAnchor: MapScenePoint,
  factor: number,
  minimumZoom = 0.08,
  maximumZoom = 8,
): MapSceneCamera {
  const safeFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const zoom = clamp(camera.zoom * safeFactor, minimumZoom, maximumZoom);
  if (zoom === camera.zoom) return { ...camera, zoom };
  const ratio = zoom / camera.zoom;
  return {
    ...camera,
    zoom,
    x: screenAnchor.x - (screenAnchor.x - camera.x) * ratio,
    y: screenAnchor.y - (screenAnchor.y - camera.y) * ratio,
  };
}
