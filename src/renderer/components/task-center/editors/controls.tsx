// Shared form controls used by the task-center editors (DispatchTaskDialog,
// TaskDetailOverlay edit mode). Extracted so every surface that touches a
// Task stays pixel-aligned — input widths, pill shape, toggle animation.

import { Check } from 'lucide-react';

/** Shared input class for every text/number/datetime field in the task dialogs. */
export const INPUT_CLS =
  'w-full rounded-lg border border-[var(--line)] bg-transparent px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--accent)] focus:outline-none transition-colors';

export function ToggleSwitch({
  enabled,
  onChange,
  disabled,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
      } ${disabled ? '' : 'cursor-pointer'}`}
    >
      <span
        className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm transition-transform ${
          enabled ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className="flex items-center gap-2.5 text-sm text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
          checked
            ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)]'
            : 'border-[var(--line-strong)] bg-transparent'
        }`}
      >
        {checked && <Check className="h-2.5 w-2.5" />}
      </span>
      {label}
    </button>
  );
}

export function PillButton({
  selected,
  onClick,
  disabled,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
        selected
          ? 'bg-[var(--accent)] text-[var(--on-accent)]'
          : 'bg-[var(--paper)] text-[var(--ink)] hover:bg-[var(--paper-inset)]'
      }`}
    >
      {children}
    </button>
  );
}

/** Timezone-aware YYYY-MM-DDTHH:MM suitable for <input type="datetime-local">. */
export function toLocalDateTimeString(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
