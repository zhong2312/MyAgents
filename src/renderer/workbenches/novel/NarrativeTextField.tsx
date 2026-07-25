import { useLayoutEffect, useRef } from "react";

type NarrativeTextFieldSize = "short" | "medium" | "long";

interface NarrativeTextFieldProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly size?: NarrativeTextFieldSize;
  readonly wide?: boolean;
  readonly disabled?: boolean;
}

const MIN_HEIGHTS: Readonly<Record<NarrativeTextFieldSize, number>> = {
  short: 96,
  medium: 132,
  long: 180,
};
const MAX_INLINE_HEIGHT = 360;

export default function NarrativeTextField({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
  size = "medium",
  wide = false,
  disabled = false,
}: NarrativeTextFieldProps) {
  const inlineRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const textarea = inlineRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    const nextHeight = Math.min(
      MAX_INLINE_HEIGHT,
      Math.max(MIN_HEIGHTS[size], textarea.scrollHeight),
    );
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > MAX_INLINE_HEIGHT ? "auto" : "hidden";
  }, [size, value]);

  const labelId = `${id}-label`;
  return (
    <div className={wide ? "col-span-full min-w-0" : "min-w-0"}>
      <div className="mb-1.5 flex min-h-7 items-center justify-between gap-2">
        <span
          id={labelId}
          className="text-xs font-medium text-[var(--ink-muted)]"
        >
          {label}
        </span>
        {hint && (
          <span className="truncate text-xs text-[var(--ink-subtle)]">
            {hint}
          </span>
        )}
      </div>
      <textarea
        ref={inlineRef}
        id={id}
        aria-labelledby={labelId}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck
        onChange={(event) => onChange(event.target.value)}
        className="block w-full resize-none rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm leading-6 text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)] disabled:cursor-not-allowed disabled:opacity-50"
      />
    </div>
  );
}
