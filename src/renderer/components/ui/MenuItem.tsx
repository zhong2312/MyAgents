// MenuItem — the dropdown-menu ROW primitive for menus that compose their own
// trigger + Popover (rather than letting a component own both).
//
// One icon + label + optional trailing affordance, with `default`/`danger`
// tones and an `active` (submenu-open) highlight, and forwardRef so a row can
// anchor a side submenu. Used by the session-domain menus that DropdownMenu
// can't serve:
//   - SessionMenuButton — needs a SessionID header row + a "在聊天机器人继续此对话 ›"
//     submenu (active state + ref-anchored Popover).
//   - SessionHistoryDropdown — per-row "更多" lives inside a hover-reveal
//     toolbar, so it owns its own trigger styling/sizing + open-state coupling
//     to keep the toolbar visible while open.
//
// NOTE: this is intentionally NOT `ui/DropdownMenu.tsx`. DropdownMenu is the
// higher-level "…" overflow primitive that bundles its own MoreHorizontal
// trigger + Popover + flat `sections`, tuned for always-visible triggers on
// card/list rows. The two menus above need control DropdownMenu doesn't expose
// (submenus, header rows, a caller-owned trigger), so they compose the base
// `Popover` with this row instead. Keep simple card/header overflow menus on
// DropdownMenu; reach for this only when you own the trigger.

import { forwardRef } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';

export interface MenuItemProps {
    icon: React.ReactNode;
    label: string;
    trailing?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    active?: boolean;
    tone?: 'default' | 'danger';
    /** Native browser tooltip for contextual action hints. */
    title?: string;
}

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
    { icon, label, trailing, onClick, disabled = false, active = false, tone = 'default', title },
    ref,
) {
    const toneClass = tone === 'danger'
        ? 'text-[var(--error)] hover:bg-[var(--error-bg)]'
        : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]';
    return (
        <button
            ref={ref}
            type="button"
            disabled={disabled}
            onMouseDown={(event: MouseEvent<HTMLButtonElement>) => {
                event.stopPropagation();
            }}
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
                event.stopPropagation();
                onClick?.();
            }}
            onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.stopPropagation();
                }
            }}
            title={title}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${toneClass} ${
                active ? 'bg-[var(--paper-inset)]' : ''
            }`}
        >
            <span className={tone === 'danger' ? 'text-[var(--error)]' : 'text-[var(--ink-muted)]'}>{icon}</span>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {trailing}
        </button>
    );
});

export default MenuItem;
