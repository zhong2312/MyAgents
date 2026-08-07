// SearchPill — panel-header search input that grows on focus.
//
// Two width regimes:
//   • collapsed — compact pill (default 150px), visually lives as a
//     quiet "search available" affordance in the row
//   • expanded — wider input (default 320px, caller can override) that
//     appears when the user focuses the field or has a non-empty query
//
// The transition is a CSS `width` animation so the pill visibly "opens
// out" into a proper search box the moment the user commits to typing,
// then contracts back when blurred with nothing entered. This keeps the
// resting state scan-friendly without hiding the affordance behind an
// icon-button toggle (which was the PR1 pattern — it required a click
// just to reveal the input).

import { useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { CSSProperties, RefObject } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  /** Imperative ref so parents can focus the input via shortcut. */
  inputRef?: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (next: string) => void;
  onClear?: () => void;
  placeholder?: string;
  /** Width when resting (empty + blurred). */
  collapsedPx?: number;
  /** Width when focused or when `value` is non-empty. */
  expandedPx?: number;
  /** When `true`, the expanded state takes the full width of its flex
   *  container instead of the `expandedPx` pixel value. Used by panel
   *  headers that collapse sibling content on focus so the search field
   *  can claim the whole row. The parent is responsible for hiding the
   *  sibling (e.g. the "想法" label). */
  expandedFull?: boolean;
  /**
   * Collapse the resting search field to a search icon while its nearest
   * container is narrower than 720px. Focusing the icon expands the input;
   * at 720px and above the ordinary collapsed/expanded widths apply.
   */
  collapseWhenNarrow?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}

export function SearchPill({
  inputRef,
  value,
  onChange,
  onClear,
  placeholder,
  collapsedPx = 150,
  expandedPx = 320,
  expandedFull = false,
  collapseWhenNarrow = false,
  onFocus,
  onBlur,
}: Props) {
  const { t } = useTranslation('task');
  const [focused, setFocused] = useState(false);
  const localInputRef = useRef<HTMLInputElement>(null);
  // Focus OR a non-empty query both keep the pill expanded — so a
  // search-in-progress doesn't collapse and clip the query the moment
  // the user clicks a result.
  const expanded = focused || value.length > 0;
  const width = expanded
    ? expandedFull
      ? '100%'
      : `${expandedPx}px`
    : `${collapsedPx}px`;
  const responsiveWidthClass = collapseWhenNarrow
    ? expanded
      ? expandedFull
        ? 'w-full'
        : 'w-full @[720px]:w-[var(--search-pill-expanded-width)]'
      : 'w-7 @[720px]:w-[var(--search-pill-collapsed-width)]'
    : '';
  const responsiveStyle = collapseWhenNarrow
    ? ({
        '--search-pill-collapsed-width': `${collapsedPx}px`,
        '--search-pill-expanded-width': `${expandedPx}px`,
      } as CSSProperties)
    : {
        width,
      };
  const compactResting = collapseWhenNarrow && !expanded;
  return (
    <div
      className={`relative inline-flex h-7 items-center gap-1.5 overflow-hidden rounded-full bg-[var(--paper-inset)] text-[var(--ink-muted)] ${responsiveWidthClass} ${
        compactResting
          ? 'cursor-text justify-center px-0 @[720px]:justify-start @[720px]:px-3'
          : 'px-3'
      }`}
      style={{
        ...responsiveStyle,
        transition: 'width 200ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      {compactResting && (
        <button
          type="button"
          aria-label={placeholder ?? t('search.placeholder')}
          onClick={() => localInputRef.current?.focus()}
          className="absolute inset-0 flex items-center justify-center rounded-full transition-colors hover:bg-[var(--hover-bg)] active:scale-[0.97] @[720px]:hidden"
        >
          <Search className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
        </button>
      )}
      <Search
        className={`h-3 w-3 shrink-0 ${compactResting ? 'hidden @[720px]:block' : ''}`}
        strokeWidth={1.5}
        aria-hidden
      />
      <input
        ref={(node) => {
          localInputRef.current = node;
          if (inputRef) inputRef.current = node;
        }}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          setFocused(true);
          onFocus?.();
        }}
        onBlur={() => {
          setFocused(false);
          onBlur?.();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value && onClear) {
            e.preventDefault();
            onClear();
          }
        }}
        placeholder={placeholder ?? t('search.placeholder')}
        className={`bg-transparent text-xs text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:outline-none ${
          compactResting
            ? 'w-0 flex-none opacity-0 @[720px]:min-w-0 @[720px]:flex-1 @[720px]:opacity-100'
            : 'min-w-0 flex-1'
        }`}
      />
      {value && onClear && (
        <button
          type="button"
          // mousedown, not click — the input's onBlur fires before click,
          // and the blur would collapse the pill AND hide the X button,
          // canceling the click. mousedown fires first and keeps focus
          // via preventDefault below.
          onMouseDown={(e) => {
            e.preventDefault();
            onClear();
          }}
          aria-label={t('search.clear')}
          className="shrink-0 rounded-full p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)]"
        >
          <X className="h-3 w-3" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}

export default SearchPill;
