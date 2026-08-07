/**
 * Shared zoom primitive for the page-based rich-doc viewers (pdf / docx / pptx).
 *
 * `useZoom` owns the zoom level + the trackpad pinch gesture; each viewer decides
 * how to APPLY the level (docx/pdf: CSS `zoom` on the content — stays crisp up to
 * ~2× given the dpr≤2 canvas backing store; pptx: the renderer's native
 * `setZoom`, which re-renders crisply). `ZoomControls` is the floating bottom-right
 * +/− pill shared by all three.
 *
 * Pinch detection covers both engines Tauri ships:
 *  - Chromium (WebView2) + modern WebKit synthesize `wheel` with `ctrlKey` for
 *    trackpad pinch. The listener must be non-passive to `preventDefault` the
 *    browser's own page zoom, so it's attached imperatively (React `onWheel` is
 *    passive).
 *  - WebKit (WKWebView on macOS) also fires non-standard `gesturestart/change`.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Minus, Plus } from 'lucide-react';

import { bindZoomGestureListeners } from '@/utils/zoomGesture';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const STEP = 0.1;

const clamp = (zoom: number) => (
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 100) / 100))
);

export function useZoom(scrollRef: RefObject<HTMLElement | null>) {
  const [zoom, setZoomState] = useState(1);

  const setZoom = useCallback((next: number | ((z: number) => number)) => {
    setZoomState((curr) => clamp(typeof next === 'function' ? next(curr) : next));
  }, []);

  // Mirror the level into a ref via an effect (never written during render) so the
  // gesturestart handler can capture the base zoom without an in-render ref write.
  const zoomRef = useRef(1);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  const zoomIn = useCallback(() => setZoom((z) => z + STEP), [setZoom]);
  const zoomOut = useCallback(() => setZoom((z) => z - STEP), [setZoom]);
  const reset = useCallback(() => setZoom(1), [setZoom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    return bindZoomGestureListeners(el, {
      getZoom: () => zoomRef.current,
      setZoom,
    });
  }, [scrollRef, setZoom]);

  return { zoom, zoomIn, zoomOut, reset, setZoom };
}

/** Floating bottom-right zoom control. Click the percentage to reset to 100%. */
export function ZoomControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onReset,
}: {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation('app');
  const btn =
    'flex h-6 w-6 items-center justify-center rounded-full text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <div className="absolute bottom-4 right-4 z-10 flex items-center gap-0.5 rounded-full border border-[var(--line)] bg-[var(--paper-elevated)] px-1 py-1 shadow-md">
      <button type="button" onClick={onZoomOut} disabled={zoom <= MIN_ZOOM} className={btn} title={t('imagePreview.zoomOut')}>
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onReset}
        className="min-w-[44px] rounded-full px-1 text-center text-xs font-medium tabular-nums text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
        title={t('richDoc.resetZoom')}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" onClick={onZoomIn} disabled={zoom >= MAX_ZOOM} className={btn} title={t('imagePreview.zoomIn')}>
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
