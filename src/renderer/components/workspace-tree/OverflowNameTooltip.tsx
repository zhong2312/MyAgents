import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  size,
  useFloating,
} from "@floating-ui/react";
import { memo, useCallback, useRef, useState } from "react";

const VIEWPORT_PADDING = 8;
const MAX_TOOLTIP_WIDTH = 520;

interface OverflowNameTooltipProps {
  label: string;
  className?: string;
}

function isTruncated(element: HTMLElement): boolean {
  return (
    element.scrollWidth > element.clientWidth ||
    element.scrollHeight > element.clientHeight
  );
}

/**
 * Instant, portaled tooltip for truncated workspace tree names.
 * The tree viewport clips overflow by design, so the tooltip must escape to
 * body and let floating-ui keep it inside the visible window.
 */
export const OverflowNameTooltip = memo(function OverflowNameTooltip({
  label,
  className = "",
}: OverflowNameTooltipProps) {
  const [openLabel, setOpenLabel] = useState<string | null>(null);
  const open = openLabel === label;
  const referenceRef = useRef<HTMLSpanElement | null>(null);
  const { refs, floatingStyles, update } = useFloating({
    open,
    placement: "bottom-start",
    middleware: [
      offset(6),
      flip({
        padding: VIEWPORT_PADDING,
        fallbackPlacements: ["top-start", "bottom-end", "top-end"],
      }),
      shift({ padding: VIEWPORT_PADDING, crossAxis: true }),
      size({
        padding: VIEWPORT_PADDING,
        apply({ availableWidth, availableHeight, elements }) {
          const safeWidth = Number.isFinite(availableWidth)
            ? Math.max(0, availableWidth)
            : MAX_TOOLTIP_WIDTH;
          const safeHeight = Number.isFinite(availableHeight)
            ? Math.max(0, availableHeight)
            : 0;
          elements.floating.style.maxWidth = `${Math.min(
            MAX_TOOLTIP_WIDTH,
            safeWidth,
          )}px`;
          elements.floating.style.maxHeight = `${safeHeight}px`;
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const setReference = useCallback(
    (node: HTMLSpanElement | null) => {
      referenceRef.current = node;
      refs.setReference(node);
    },
    [refs],
  );

  const setFloating = useCallback(
    (node: HTMLDivElement | null) => {
      refs.setFloating(node);
    },
    [refs],
  );

  const showIfTruncated = useCallback(() => {
    const element = referenceRef.current;
    if (!element || !isTruncated(element)) {
      setOpenLabel(null);
      return;
    }
    setOpenLabel(label);
    void update();
  }, [label, update]);

  const hide = useCallback(() => {
    setOpenLabel(null);
  }, []);

  return (
    <>
      <span
        ref={setReference}
        className={className}
        onPointerEnter={showIfTruncated}
        onPointerLeave={hide}
        onPointerDown={hide}
        onBlur={hide}
      >
        {label}
      </span>
      {open && (
        <FloatingPortal>
          <div
            ref={setFloating}
            role="tooltip"
            className="pointer-events-none z-[280] overflow-auto rounded-md bg-[var(--button-dark-bg)]/95 px-2.5 py-1.5 text-xs leading-snug text-[var(--button-dark-text)] shadow-lg"
            style={{
              ...floatingStyles,
              maxWidth: `min(${MAX_TOOLTIP_WIDTH}px, calc(100vw - ${
                VIEWPORT_PADDING * 2
              }px))`,
              maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
              overflowWrap: "anywhere",
              wordBreak: "break-word",
            }}
          >
            {label}
          </div>
        </FloatingPortal>
      )}
    </>
  );
});
