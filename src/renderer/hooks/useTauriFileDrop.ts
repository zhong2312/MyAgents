/**
 * Hook for handling file drag-and-drop in Tauri v2
 *
 * In Tauri, standard HTML5 drag-drop events from external files don't work.
 * Tauri intercepts OS drag events and emits its own:
 * - tauri://drag-enter
 * - tauri://drag-over
 * - tauri://drag-drop
 * - tauri://drag-leave
 *
 * This hook listens to those events and tracks which registered drop zone
 * the mouse is over by using element position and Tauri's drop position.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { listenWithCleanup } from '@/utils/tauriListen';
import { track } from '@/analytics';
import { isTauriEnvironment } from '@/utils/browserMock';
import { isDebugMode } from '@/utils/debug';
import {
  physicalPositionToCssPixels,
  type DragDropPosition,
} from './dragDropCoordinates';

interface DragDropPayload {
  type: 'enter' | 'over' | 'drop' | 'leave' | 'cancelled';
  /** Tauri DragDropEvent.position is a PhysicalPosition. */
  position?: DragDropPosition;
  paths?: string[];
}

interface DropZone {
  id: string;
  element: HTMLElement | null;
  onDrop: (paths: string[], position?: DragDropPosition) => void;
}

interface UseTauriFileDropOptions {
  /** Called when drag enters any zone */
  onDragEnter?: () => void;
  /** Called when drag leaves all zones */
  onDragLeave?: () => void;
  /** Called when files are dropped. `position` is the drop point in the same
   *  CSS-pixel space the zone hit-testing uses — consumers can resolve a
   *  finer-grained target (e.g. which tree row) via `elementFromPoint`. */
  onDrop?: (
    paths: string[],
    zoneId: string | null,
    position?: DragDropPosition,
  ) => void;
  /**
   * Whether this hook instance should respond to Tauri drag events. Default `true`.
   *
   * Tauri emits each drag event exactly once, but every mounted consumer's listener
   * receives it. In the multi-tab Chat app, inactive tabs are kept mounted with
   * `visibility:hidden` / `pointer-events-none` / `absolute inset-0` — their
   * `chatContentRef.current` element still reports the same bounding rect as the
   * active tab, so `findZoneAtPosition` matches for ALL tabs and each tab's
   * `onDrop` fires, causing a single file drop to land in every tab simultaneously.
   *
   * Pass `isActive` from the parent tab context so only the visible tab reacts.
   */
  enabled?: boolean;
}

interface UseTauriFileDropResult {
  /** Whether files are being dragged over the window */
  isDragging: boolean;
  /** The active drop zone ID based on last known position */
  activeZoneId: string | null;
  /** Register a drop zone element */
  registerZone: (id: string, element: HTMLElement | null, onDrop: (paths: string[]) => void) => void;
  /** Unregister a drop zone */
  unregisterZone: (id: string) => void;
}

/**
 * Check if a point is inside an element's bounding rect
 */
function isPointInElement(x: number, y: number, element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function toCssPosition(position: DragDropPosition): DragDropPosition {
  // Read the current scale for every event: a window can move between displays
  // with different scaling while the app remains mounted.
  return physicalPositionToCssPixels(position, window.devicePixelRatio);
}

export function useTauriFileDrop(options: UseTauriFileDropOptions = {}): UseTauriFileDropResult {
  const { onDragEnter, onDragLeave, onDrop, enabled = true } = options;
  const [isDragging, setIsDragging] = useState(false);
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null);
  const [stateEnabled, setStateEnabled] = useState(enabled);

  // React's supported "adjust state when a prop changes" pattern. Reset in
  // render so re-enabling a mounted tab cannot expose drag state left behind
  // while its window-wide event listener was gated off.
  if (stateEnabled !== enabled) {
    setStateEnabled(enabled);
    setIsDragging(false);
    setActiveZoneId(null);
  }

  // Store registered drop zones
  const zonesRef = useRef<Map<string, DropZone>>(new Map());

  // Store stable refs for callbacks
  const onDragEnterRef = useRef(onDragEnter);
  const onDragLeaveRef = useRef(onDragLeave);
  const onDropRef = useRef(onDrop);
  // Track `enabled` via ref so the single listener setup (effect with [findZoneAtPosition]
  // deps, not [enabled]) always reads the current value without re-subscribing on every
  // tab switch — we want listeners stable, just gated per-fire.
  const enabledRef = useRef(enabled);

  // Native drag events are window-wide external events. Update their authority
  // in the same commit as the visible/hidden DOM change, before the browser can
  // dispatch another event; a passive effect leaves a post-commit race window.
  useLayoutEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    onDragEnterRef.current = onDragEnter;
    onDragLeaveRef.current = onDragLeave;
    onDropRef.current = onDrop;
  }, [onDragEnter, onDragLeave, onDrop]);

  /**
   * Find which drop zone contains the given position
   */
  const findZoneAtPosition = useCallback((x: number, y: number): string | null => {
    for (const [id, zone] of zonesRef.current) {
      if (zone.element && isPointInElement(x, y, zone.element)) {
        return id;
      }
    }
    return null;
  }, []);

  const registerZone = useCallback((id: string, element: HTMLElement | null, onDrop: (paths: string[]) => void) => {
    zonesRef.current.set(id, { id, element, onDrop });
  }, []);

  const unregisterZone = useCallback((id: string) => {
    zonesRef.current.delete(id);
  }, []);

  useEffect(() => {
    if (!isTauriEnvironment()) {
      return;
    }
    const ac = new AbortController();

    // ── Critical gate ──
    // Tauri broadcasts each drag event to ALL mounted listeners. In a multi-tab
    // app, every tab's hook instance would otherwise fire handlers + update its
    // own state (isDragging / activeZoneId / onDrop → attachment state), so a
    // single file drop leaks into every tab. Gate at the earliest point in each
    // handler using the enabledRef the caller wires to their tab's `isActive`.
    const enabledGate = () => enabledRef.current;

    void listenWithCleanup<DragDropPayload>('tauri://drag-enter', (event) => {
      if (!enabledGate()) return;
      if (isDebugMode()) {
        console.log('[useTauriFileDrop] drag-enter', event.payload);
      }
      setIsDragging(true);
      onDragEnterRef.current?.();
      if (event.payload.position) {
        const position = toCssPosition(event.payload.position);
        const zoneId = findZoneAtPosition(position.x, position.y);
        setActiveZoneId(zoneId);
      }
    }, ac.signal);

    void listenWithCleanup<DragDropPayload>('tauri://drag-over', (event) => {
      if (!enabledGate()) return;
      if (event.payload.position) {
        // A surface can become enabled while an OS drag is already in progress;
        // in that case its first observable event is often `drag-over`, not enter.
        setIsDragging(true);
        const position = toCssPosition(event.payload.position);
        const zoneId = findZoneAtPosition(position.x, position.y);
        setActiveZoneId(zoneId);
      }
    }, ac.signal);

    void listenWithCleanup<DragDropPayload>('tauri://drag-drop', (event) => {
      if (!enabledGate()) return;
      if (isDebugMode()) {
        console.log('[useTauriFileDrop] drag-drop', event.payload);
      }
      setIsDragging(false);

      const paths = event.payload.paths || [];
      if (paths.length === 0) {
        setActiveZoneId(null);
        return;
      }

      const position = event.payload.position
        ? toCssPosition(event.payload.position)
        : undefined;
      let zoneId: string | null = null;
      if (position) {
        zoneId = findZoneAtPosition(position.x, position.y);
      }

      if (isDebugMode()) {
        console.log('[useTauriFileDrop] Drop on zone:', zoneId, 'paths:', paths);
      }

      track('file_drop', { file_count: paths.length });

      if (zoneId) {
        const zone = zonesRef.current.get(zoneId);
        zone?.onDrop(paths, position);
      }
      onDropRef.current?.(paths, zoneId, position);

      setActiveZoneId(null);
    }, ac.signal);

    void listenWithCleanup<DragDropPayload>('tauri://drag-leave', () => {
      if (!enabledGate()) return;
      setIsDragging(false);
      setActiveZoneId(null);
      onDragLeaveRef.current?.();
    }, ac.signal);

    // Also listen to cancelled event (renamed in Tauri v2)
    void listenWithCleanup<DragDropPayload>('tauri://drag-cancelled', () => {
      if (!enabledGate()) return;
      setIsDragging(false);
      setActiveZoneId(null);
      onDragLeaveRef.current?.();
    }, ac.signal);

    return () => ac.abort();
  }, [findZoneAtPosition]);

  return {
    isDragging,
    activeZoneId,
    registerZone,
    unregisterZone,
  };
}
