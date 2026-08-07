import { useRef, useState } from 'react';

import { Popover, type PopoverPlacement } from './ui/Popover';

/** Lightweight portaled tooltip — appears instantly on hover, no timers.
 *  The bubble is mounted only while visible and uses the shared Popover owner,
 *  so scroll containers cannot clip it and Floating UI can flip/shift it at
 *  viewport edges. `position="top"` (default) shows above; `"bottom"` shows
 *  below; `"right"` vertically centers beside rail controls.
 *  `align="center"` (default) centers; `"end"` aligns to the right edge.
 *  `disabled` suppresses the tooltip while the trigger owns an open Popover.
 *  `shortcut` adds a muted second line (e.g. "⌘ + Enter") rendered below
 *  the main label. Use for actions with a keyboard accelerator worth
 *  teaching — keep it to a short inline string, no raw JSX. */

function tipPlacement(
  position: 'top' | 'bottom' | 'right',
  align: 'center' | 'end',
): PopoverPlacement {
  if (position === 'right') return 'right';
  if (align === 'end') return `${position}-end`;
  return position;
}

export default function Tip({
  label,
  shortcut,
  children,
  position = 'top',
  align = 'center',
  disabled = false,
  className = '',
}: {
  label: string;
  shortcut?: string;
  children: React.ReactNode;
  position?: 'top' | 'bottom' | 'right';
  align?: 'center' | 'end';
  disabled?: boolean;
  className?: string;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focusedWithin, setFocusedWithin] = useState(false);
  const visible = (hovered || focusedWithin) && !disabled;

  return (
    <span
      ref={anchorRef}
      className={`relative inline-flex ${className}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocusedWithin(true)}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setFocusedWithin(false);
        }
      }}
    >
      {children}
      {visible && (
        <Popover
          open
          onClose={() => {
            setHovered(false);
            setFocusedWithin(false);
          }}
          anchorRef={anchorRef}
          placement={tipPlacement(position, align)}
          offset={position === 'right' ? 12 : 6}
          closeOnOutsideClick={false}
          closeOnEscape={false}
          zIndex={280}
          unstyled
          className="pointer-events-none"
        >
          <span
            role="tooltip"
            className="block whitespace-nowrap rounded-md bg-[var(--button-dark-bg)]/90 px-2.5 py-1.5 text-xs leading-tight text-[var(--button-dark-text)]"
          >
            {label}
            {shortcut && (
              <span className="mt-0.5 block text-xs text-[var(--button-dark-text)]/70">
                {shortcut}
              </span>
            )}
          </span>
        </Popover>
      )}
    </span>
  );
}
