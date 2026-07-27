export interface DragDropPosition {
  x: number;
  y: number;
}

/** Convert Tauri's physical-pixel drag position into the CSS-pixel space used by the DOM. */
export function physicalPositionToCssPixels(
  position: DragDropPosition,
  devicePixelRatio: number,
): DragDropPosition {
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;

  return {
    x: position.x / scale,
    y: position.y / scale,
  };
}
