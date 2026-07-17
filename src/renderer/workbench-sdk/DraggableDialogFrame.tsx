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
  readonly className?: string;
  readonly headerClassName?: string;
  readonly overlayClassName?: string;
}

const VIEWPORT_MARGIN = 12;

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
  className = "",
  headerClassName = "",
  overlayClassName = "",
}: DraggableDialogFrameProps) {
  const frameRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  const keepInsideViewport = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const margin = Math.min(
      VIEWPORT_MARGIN,
      Math.max(0, (window.innerWidth - rect.width) / 2),
      Math.max(0, (window.innerHeight - rect.height) / 2),
    );
    let correctionX = 0;
    let correctionY = 0;

    if (rect.left < margin) correctionX = margin - rect.left;
    else if (rect.right > window.innerWidth - margin) {
      correctionX = window.innerWidth - margin - rect.right;
    }
    if (rect.top < margin) correctionY = margin - rect.top;
    else if (rect.bottom > window.innerHeight - margin) {
      correctionY = window.innerHeight - margin - rect.bottom;
    }

    if (correctionX !== 0 || correctionY !== 0) {
      setOffset((current) => ({
        x: current.x + correctionX,
        y: current.y + correctionY,
      }));
    }
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(keepInsideViewport);
    observer.observe(frame);
    window.addEventListener("resize", keepInsideViewport);
    keepInsideViewport();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", keepInsideViewport);
    };
  }, [keepInsideViewport]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || isInteractiveTarget(event.target)) return;
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const margin = Math.min(
      VIEWPORT_MARGIN,
      Math.max(0, (window.innerWidth - rect.width) / 2),
      Math.max(0, (window.innerHeight - rect.height) / 2),
    );
    dragRef.current = {
      pointerId: event.pointerId,
      startPointer: { x: event.clientX, y: event.clientY },
      startOffset: offset,
      bounds: {
        minX: offset.x + margin - rect.left,
        maxX: offset.x + window.innerWidth - margin - rect.right,
        minY: offset.y + margin - rect.top,
        maxY: offset.y + window.innerHeight - margin - rect.bottom,
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
      className={`pointer-events-none fixed inset-0 flex items-center justify-center p-3 ${overlayClassName}`}
    >
      <section
        ref={frameRef}
        role="dialog"
        aria-label={ariaLabel}
        style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` }}
        className={`pointer-events-auto flex min-h-0 flex-col overflow-hidden rounded-md border border-[var(--line-strong)] bg-[var(--paper)] text-[var(--ink)] shadow-2xl ${className}`}
      >
        <header
          data-dialog-drag-handle
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          className={`shrink-0 touch-none select-none [&_button]:cursor-pointer ${
            isDragging ? "cursor-grabbing" : "cursor-grab"
          } ${headerClassName}`}
        >
          {header}
        </header>
        {children}
      </section>
    </div>
  );
}
