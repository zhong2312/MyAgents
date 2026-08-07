export type ZoomUpdater = number | ((zoom: number) => number);

export interface ZoomGestureOrigin {
  clientX: number;
  clientY: number;
}

interface ZoomGestureBinding {
  getZoom: () => number;
  setZoom: (next: ZoomUpdater, origin?: ZoomGestureOrigin) => void;
}

/**
 * Attach the one cross-WebView trackpad-pinch protocol used by preview surfaces.
 * The consumer remains the zoom-state owner and decides how scale is applied.
 */
export function bindZoomGestureListeners(
  element: HTMLElement,
  binding: ZoomGestureBinding,
): () => void {
  const originOf = (event: Event): ZoomGestureOrigin | undefined => {
    const candidate = event as Event & { clientX?: number; clientY?: number };
    return Number.isFinite(candidate.clientX) && Number.isFinite(candidate.clientY)
      ? { clientX: candidate.clientX as number, clientY: candidate.clientY as number }
      : undefined;
  };

  // Chromium/WebView2 and modern WebKit synthesize ctrl+wheel for pinch.
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    binding.setZoom((zoom) => zoom - event.deltaY * 0.01, originOf(event));
  };

  // macOS WKWebView also exposes Safari's relative gesture events.
  let gestureBase = 1;
  const onGestureStart = (event: Event) => {
    event.preventDefault();
    gestureBase = binding.getZoom();
  };
  const onGestureChange = (event: Event) => {
    event.preventDefault();
    const scale = (event as Event & { scale?: number }).scale;
    if (typeof scale === 'number' && Number.isFinite(scale) && scale > 0) {
      binding.setZoom(gestureBase * scale, originOf(event));
    }
  };

  element.addEventListener('wheel', onWheel, { passive: false });
  element.addEventListener('gesturestart', onGestureStart as EventListener, { passive: false });
  element.addEventListener('gesturechange', onGestureChange as EventListener, { passive: false });
  return () => {
    element.removeEventListener('wheel', onWheel);
    element.removeEventListener('gesturestart', onGestureStart as EventListener);
    element.removeEventListener('gesturechange', onGestureChange as EventListener);
  };
}
