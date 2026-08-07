import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  size,
  useFloating,
} from "@floating-ui/react";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
} from "react";

const VIEWPORT_PADDING = 8;
const MAX_TOOLTIP_WIDTH = 520;

interface OverflowNameTooltipProps
  extends Omit<
    HTMLAttributes<HTMLSpanElement>,
    | "children"
    | "onBlur"
    | "onPointerDown"
    | "onPointerEnter"
    | "onPointerLeave"
  > {
  label: string;
  tooltipLabel?: string;
  contentIsTruncated?: boolean;
  delayMs?: number;
}

function isTruncated(element: HTMLElement): boolean {
  return (
    element.scrollWidth > element.clientWidth ||
    element.scrollHeight > element.clientHeight
  );
}

/**
 * Portaled tooltip for truncated workspace tree names, with an optional delay.
 * The tree viewport clips overflow by design, so the tooltip must escape to
 * body and let floating-ui keep it inside the visible window.
 */
export const OverflowNameTooltip = memo(function OverflowNameTooltip({
  label,
  tooltipLabel,
  contentIsTruncated = false,
  className = "",
  delayMs = 0,
  ...spanProps
}: OverflowNameTooltipProps) {
  const resolvedTooltipLabel = tooltipLabel ?? label;
  const [openLabel, setOpenLabel] = useState<string | null>(null);
  const open = openLabel === resolvedTooltipLabel;
  const referenceRef = useRef<HTMLSpanElement | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current === null) return;
    clearTimeout(showTimerRef.current);
    showTimerRef.current = null;
  }, []);

  useEffect(
    () => clearShowTimer,
    [clearShowTimer, contentIsTruncated, delayMs, resolvedTooltipLabel],
  );

  const shouldShowTooltip = useCallback(() => {
    const element = referenceRef.current;
    return Boolean(
      element && (contentIsTruncated || isTruncated(element)),
    );
  }, [contentIsTruncated]);

  useEffect(() => {
    const element = referenceRef.current;
    if (!open || !element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!shouldShowTooltip()) setOpenLabel(null);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, shouldShowTooltip]);

  const showIfTruncated = useCallback(() => {
    clearShowTimer();
    if (!shouldShowTooltip()) {
      setOpenLabel(null);
      return;
    }
    if (delayMs <= 0) {
      setOpenLabel(resolvedTooltipLabel);
      void update();
      return;
    }
    showTimerRef.current = setTimeout(() => {
      showTimerRef.current = null;
      if (!shouldShowTooltip()) {
        setOpenLabel(null);
        return;
      }
      setOpenLabel(resolvedTooltipLabel);
      void update();
    }, delayMs);
  }, [clearShowTimer, delayMs, resolvedTooltipLabel, shouldShowTooltip, update]);

  const hide = useCallback(() => {
    clearShowTimer();
    setOpenLabel(null);
  }, [clearShowTimer]);

  return (
    <>
      <span
        {...spanProps}
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
            {resolvedTooltipLabel}
          </div>
        </FloatingPortal>
      )}
    </>
  );
});
