/** Lightweight CSS-only tooltip — appears instantly on hover, no JS timers.
 *  `position="top"` (default) shows above; `position="bottom"` shows below.
 *  `align="center"` (default) centers; `"end"` aligns to the right edge.
 *  `disabled` suppresses the tooltip while the trigger owns an open Popover.
 *  `shortcut` adds a muted second line (e.g. "⌘ + Enter") rendered below
 *  the main label. Use for actions with a keyboard accelerator worth
 *  teaching — keep it to a short inline string, no raw JSX. */
export default function Tip({
  label,
  shortcut,
  children,
  position = 'top',
  align = 'center',
  disabled = false,
}: {
  label: string;
  shortcut?: string;
  children: React.ReactNode;
  position?: 'top' | 'bottom';
  align?: 'center' | 'end';
  disabled?: boolean;
}) {
  const posClass = position === 'bottom'
    ? 'top-full mt-1.5'
    : 'bottom-full mb-1.5';
  const alignClass = align === 'end'
    ? 'right-0'
    : 'left-1/2 -translate-x-1/2';
  return (
    <span className="group/tip relative inline-flex">
      {children}
      {!disabled && (
        <span
          className={`pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-[var(--button-dark-bg)]/90 px-2.5 py-1.5 text-xs leading-tight text-[var(--button-dark-text)] opacity-0 transition-opacity group-hover/tip:opacity-100 ${posClass} ${alignClass}`}
        >
          {label}
          {shortcut && (
            <span className="mt-0.5 block text-xs text-[var(--button-dark-text)]/70">
              {shortcut}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
