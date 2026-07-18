import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

interface Point {
  readonly x: number;
  readonly y: number;
}

interface DragState {
  readonly pointerId: number;
  readonly startPointer: Point;
  readonly startOffset: Point;
  readonly bounds: {
    readonly minX: number;
    readonly maxX: number;
    readonly minY: number;
    readonly maxY: number;
  };
}

export interface DraggableDialogFrameProps {
  readonly ariaLabel: string;
  readonly header: ReactNode;
  readonly children: ReactNode;
  readonly maximized?: boolean;
  readonly positioning?: "viewport" | "container";
  readonly className?: string;
  readonly headerClassName?: string;
  readonly overlayClassName?: string;
}

const VIEWPORT_MARGIN = 12;
const DIALOG_Z_INDEX_BASE = 210;
const DIALOG_Z_INDEX_MAX = 279;

interface DialogLayer {
  readonly id: symbol;
  readonly update: (zIndex: number) => void;
}

const dialogLayers: DialogLayer[] = [];

function updateDialogLayers(): void {
  dialogLayers.forEach((layer, index) => {
    layer.update(Math.min(DIALOG_Z_INDEX_BASE + index, DIALOG_Z_INDEX_MAX));
  });
}

function registerDialogLayer(layer: DialogLayer): () => void {
  dialogLayers.push(layer);
  updateDialogLayers();
  return () => {
    const index = dialogLayers.findIndex((item) => item.id === layer.id);
    if (index >= 0) dialogLayers.splice(index, 1);
    updateDialogLayers();
  };
}

function bringDialogLayerToFront(id: symbol): void {
  const index = dialogLayers.findIndex((layer) => layer.id === id);
  if (index < 0 || index === dialogLayers.length - 1) return;
  const [layer] = dialogLayers.splice(index, 1);
  dialogLayers.push(layer);
  updateDialogLayers();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "button, a, input, textarea, select, [role='button'], [data-no-dialog-drag]",
    ) !== null
  );
}

/** Shared finite workbench window with a viewport-constrained title-bar drag. */
export default function DraggableDialogFrame({
  ariaLabel,
  header,
  children,
  maximized = false,
  positioning = "viewport",
  className = "",
  headerClassName = "",
  overlayClassName = "",
}: DraggableDialogFrameProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const layerIdRef = useRef(Symbol("workbench-dialog"));
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [zIndex, setZIndex] = useState(DIALOG_Z_INDEX_BASE);

  const getBoundaryRect = useCallback(() => {
    if (positioning === "container") {
      return overlayRef.current?.getBoundingClientRect() ?? null;
    }
    return {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }, [positioning]);

  useEffect(
    () =>
      registerDialogLayer({
        id: layerIdRef.current,
        update: setZIndex,
      }),
    [],
  );

  const keepInsideViewport = useCallback(() => {
    if (maximized) return;
    const frame = frameRef.current;
    const boundary = getBoundaryRect();
    if (!frame || !boundary) return;
    const rect = frame.getBoundingClientRect();
    const margin = Math.min(
      VIEWPORT_MARGIN,
      Math.max(0, (boundary.width - rect.width) / 2),
      Math.max(0, (boundary.height - rect.height) / 2),
    );
    let correctionX = 0;
    let correctionY = 0;

    if (rect.left < boundary.left + margin) {
      correctionX = boundary.left + margin - rect.left;
    } else if (rect.right > boundary.right - margin) {
      correctionX = boundary.right - margin - rect.right;
    }
    if (rect.top < boundary.top + margin) {
      correctionY = boundary.top + margin - rect.top;
    } else if (rect.bottom > boundary.bottom - margin) {
      correctionY = boundary.bottom - margin - rect.bottom;
    }

    if (correctionX !== 0 || correctionY !== 0) {
      setOffset((current) => ({
        x: current.x + correctionX,
        y: current.y + correctionY,
      }));
    }
  }, [getBoundaryRect, maximized]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(keepInsideViewport);
    observer.observe(frame);
    if (positioning === "container" && overlayRef.current) {
      observer.observe(overlayRef.current);
    }
    window.addEventListener("resize", keepInsideViewport);
    keepInsideViewport();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", keepInsideViewport);
    };
  }, [keepInsideViewport, positioning]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (maximized || event.button !== 0 || isInteractiveTarget(event.target)) {
      return;
    }
    const frame = frameRef.current;
    const boundary = getBoundaryRect();
    if (!frame || !boundary) return;
    const rect = frame.getBoundingClientRect();
    const margin = Math.min(
      VIEWPORT_MARGIN,
      Math.max(0, (boundary.width - rect.width) / 2),
      Math.max(0, (boundary.height - rect.height) / 2),
    );
    dragRef.current = {
      pointerId: event.pointerId,
      startPointer: { x: event.clientX, y: event.clientY },
      startOffset: offset,
      bounds: {
        minX: offset.x + boundary.left + margin - rect.left,
        maxX: offset.x + boundary.right - margin - rect.right,
        minY: offset.y + boundary.top + margin - rect.top,
        maxY: offset.y + boundary.bottom - margin - rect.bottom,
      },
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
    event.preventDefault();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOffset({
      x: clamp(
        drag.startOffset.x + event.clientX - drag.startPointer.x,
        drag.bounds.minX,
        drag.bounds.maxX,
      ),
      y: clamp(
        drag.startOffset.y + event.clientY - drag.startPointer.y,
        drag.bounds.minY,
        drag.bounds.maxY,
      ),
    });
  };

  const finishDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      ref={overlayRef}
      style={{ zIndex }}
      onPointerDownCapture={() => bringDialogLayerToFront(layerIdRef.current)}
      onFocusCapture={() => bringDialogLayerToFront(layerIdRef.current)}
      className={`pointer-events-none ${positioning === "container" ? "absolute" : "fixed"} inset-0 flex items-center justify-center ${
        maximized ? "p-0" : "p-3"
      } ${overlayClassName}`}
    >
      <section
        ref={frameRef}
        role="dialog"
        aria-label={ariaLabel}
        style={
          maximized
            ? { width: "100%", height: "100%", transform: "none" }
            : { transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` }
        }
        className={`pointer-events-auto flex min-h-0 flex-col overflow-hidden bg-[var(--paper)] text-[var(--ink)] shadow-2xl ${
          maximized
            ? "rounded-none border-0"
            : "rounded-md border border-[var(--line-strong)]"
        } ${className}`}
      >
        <header
          data-dialog-drag-handle
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          className={`shrink-0 touch-none select-none [&_button]:cursor-pointer ${
            maximized
              ? "cursor-default"
              : isDragging
                ? "cursor-grabbing"
                : "cursor-grab"
          } ${headerClassName}`}
        >
          {header}
        </header>
        {children}
      </section>
    </div>
  );
}
