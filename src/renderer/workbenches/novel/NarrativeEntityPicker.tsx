import { Check, ChevronDown, ListFilter, Search, X } from "lucide-react";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

import { Popover } from "@/workbench-sdk";

export interface NarrativeEntityOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly keywords?: readonly string[];
}

interface SharedPickerProps {
  readonly options: readonly NarrativeEntityOption[];
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

interface NarrativeEntitySelectProps extends SharedPickerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
}

interface NarrativeEntityMultiSelectProps extends SharedPickerProps {
  readonly values: readonly string[];
  readonly onChange: (values: string[]) => void;
}

function normalizedText(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function matchesQuery(option: NarrativeEntityOption, query: string): boolean {
  const needle = normalizedText(query);
  if (!needle) return true;
  return normalizedText(
    [option.label, option.description, ...(option.keywords ?? [])]
      .filter(Boolean)
      .join(" "),
  ).includes(needle);
}

function resultHeight(count: number): number {
  return Math.min(320, Math.max(56, count * 46));
}

function PickerSearch({
  value,
  onChange,
  onKeyDown,
  listId,
  activeDescendant,
  expanded,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  readonly listId: string;
  readonly activeDescendant?: string;
  readonly expanded: boolean;
}) {
  return (
    <div className="border-b border-[var(--line)] p-2.5">
      <div className="flex items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 focus-within:border-[var(--accent-warm)]">
        <Search className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        <input
          type="search"
          autoFocus
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={activeDescendant}
          aria-expanded={expanded}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="搜索名称、别名或编号"
          className="h-9 min-w-0 flex-1 bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)]"
        />
        {value && (
          <button
            type="button"
            className="ns-icon-button h-7 w-7 shrink-0 border-0"
            title="清除搜索"
            aria-label="清除搜索"
            onClick={() => onChange("")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function PickerOptionRow({
  option,
  selected,
  active,
  onActivate,
  onSelect,
  optionId,
}: {
  readonly option: NarrativeEntityOption;
  readonly selected: boolean;
  readonly active: boolean;
  readonly onActivate: () => void;
  readonly onSelect: () => void;
  readonly optionId: string;
}) {
  return (
    <button
      type="button"
      id={optionId}
      role="option"
      aria-selected={selected}
      className={`flex h-11 w-full items-center gap-2.5 px-3 text-left transition-colors ${
        active
          ? "bg-[var(--hover-bg)]"
          : "bg-[var(--paper-elevated)] hover:bg-[var(--hover-bg)]"
      }`}
      onMouseEnter={onActivate}
      onClick={onSelect}
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${
          selected
            ? "border-[var(--accent-warm)] bg-[var(--accent-warm)] text-white"
            : "border-[var(--line-strong)] bg-[var(--paper)] text-transparent"
        }`}
      >
        <Check className="h-3 w-3" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-[var(--ink)]">
          {option.label}
        </span>
        {option.description && (
          <span className="mt-0.5 block truncate text-xs text-[var(--ink-muted)]">
            {option.description}
          </span>
        )}
      </span>
    </button>
  );
}

function usePickerKeyboard({
  open,
  setOpen,
  count,
  activeIndex,
  setActiveIndex,
  onSelectActive,
  virtuosoRef,
}: {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly count: number;
  readonly activeIndex: number;
  readonly setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  readonly onSelectActive: () => void;
  readonly virtuosoRef: React.RefObject<VirtuosoHandle | null>;
}) {
  return useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (count === 0) return;
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const next = Math.min(count - 1, Math.max(0, activeIndex + direction));
        setActiveIndex(next);
        virtuosoRef.current?.scrollToIndex({ index: next, align: "center" });
      } else if (event.key === "Enter") {
        event.preventDefault();
        onSelectActive();
      } else if (event.key === "Escape" && open) {
        event.preventDefault();
        setOpen(false);
      }
    },
    [
      activeIndex,
      count,
      onSelectActive,
      open,
      setActiveIndex,
      setOpen,
      virtuosoRef,
    ],
  );
}

export function NarrativeEntitySelect({
  value,
  options,
  placeholder,
  ariaLabel,
  disabled = false,
  className = "",
  onChange,
}: NarrativeEntitySelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const listId = useId();
  const filtered = useMemo(() => {
    const matching = options.filter((option) => matchesQuery(option, query));
    if (query || !value) return matching;
    return [...matching].sort(
      (left, right) => Number(right.id === value) - Number(left.id === value),
    );
  }, [options, query, value]);
  const selected = options.find((option) => option.id === value) ?? null;

  const resolvedActiveIndex = Math.min(
    Math.max(0, activeIndex),
    Math.max(0, filtered.length - 1),
  );

  const choose = useCallback(
    (option: NarrativeEntityOption) => {
      onChange(option.id);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [onChange],
  );
  const selectActive = useCallback(() => {
    const option = filtered[resolvedActiveIndex];
    if (option) choose(option);
  }, [choose, filtered, resolvedActiveIndex]);
  const handleKeyDown = usePickerKeyboard({
    open,
    setOpen,
    count: filtered.length,
    activeIndex: resolvedActiveIndex,
    setActiveIndex,
    onSelectActive: selectActive,
    virtuosoRef,
  });

  return (
    <div className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        className="flex w-full min-w-0 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-left text-sm transition-colors hover:border-[var(--line-strong)] disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          setQuery("");
          setActiveIndex(0);
          setOpen(true);
        }}
      >
        <span
          className={`min-w-0 flex-1 truncate ${selected ? "text-[var(--ink)]" : "text-[var(--ink-muted)]"}`}
        >
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      <Popover
        open={open && !disabled}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        placement="bottom-start"
        matchAnchorWidth
        className="min-w-72 shadow-md"
      >
        <PickerSearch
          value={query}
          onChange={(nextQuery) => {
            setQuery(nextQuery);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          listId={listId}
          activeDescendant={
            filtered[resolvedActiveIndex]
              ? `${listId}-${filtered[resolvedActiveIndex].id}`
              : undefined
          }
          expanded={open}
        />
        <div className="flex items-center justify-between border-b border-[var(--line-subtle)] px-3 py-2 text-xs text-[var(--ink-muted)]">
          <span>{filtered.length.toLocaleString("zh-CN")} 个结果</span>
          {selected && <span className="truncate">当前：{selected.label}</span>}
        </div>
        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-[var(--ink-muted)]">
            没有匹配的对象
          </div>
        ) : (
          <div id={listId} role="listbox">
            <Virtuoso
              ref={virtuosoRef}
              data={filtered}
              style={{ height: resultHeight(filtered.length) }}
              computeItemKey={(_index, option) => option.id}
              itemContent={(index, option) => (
                <PickerOptionRow
                  option={option}
                  selected={option.id === value}
                  active={index === resolvedActiveIndex}
                  onActivate={() => setActiveIndex(index)}
                  onSelect={() => choose(option)}
                  optionId={`${listId}-${option.id}`}
                />
              )}
            />
          </div>
        )}
      </Popover>
    </div>
  );
}

export function NarrativeEntityMultiSelect({
  values,
  options,
  placeholder,
  ariaLabel,
  disabled = false,
  className = "",
  onChange,
}: NarrativeEntityMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const listId = useId();
  const selectedIds = useMemo(() => new Set(values), [values]);
  const selectedOptions = useMemo(
    () => options.filter((option) => selectedIds.has(option.id)),
    [options, selectedIds],
  );
  const filtered = useMemo(() => {
    const matching = options.filter(
      (option) =>
        (!onlySelected || selectedIds.has(option.id)) &&
        matchesQuery(option, query),
    );
    if (query || onlySelected) return matching;
    return [...matching].sort(
      (left, right) =>
        Number(selectedIds.has(right.id)) - Number(selectedIds.has(left.id)),
    );
  }, [onlySelected, options, query, selectedIds]);

  const resolvedActiveIndex = Math.min(
    Math.max(0, activeIndex),
    Math.max(0, filtered.length - 1),
  );

  const toggle = useCallback(
    (option: NarrativeEntityOption) => {
      onChange(
        selectedIds.has(option.id)
          ? values.filter((id) => id !== option.id)
          : [...values, option.id],
      );
    },
    [onChange, selectedIds, values],
  );
  const selectActive = useCallback(() => {
    const option = filtered[resolvedActiveIndex];
    if (option) toggle(option);
  }, [filtered, resolvedActiveIndex, toggle]);
  const handleKeyDown = usePickerKeyboard({
    open,
    setOpen,
    count: filtered.length,
    activeIndex: resolvedActiveIndex,
    setActiveIndex,
    onSelectActive: selectActive,
    virtuosoRef,
  });
  const summary =
    selectedOptions.length === 0
      ? placeholder
      : selectedOptions.length <= 2
        ? selectedOptions.map((option) => option.label).join("、")
        : `${selectedOptions
            .slice(0, 2)
            .map((option) => option.label)
            .join("、")}等 ${selectedOptions.length} 项`;

  return (
    <div className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        className="flex w-full min-w-0 items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-left text-sm transition-colors hover:border-[var(--line-strong)] disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          setQuery("");
          setOnlySelected(false);
          setActiveIndex(0);
          setOpen(true);
        }}
      >
        <span
          className={`min-w-0 flex-1 truncate ${selectedOptions.length > 0 ? "text-[var(--ink)]" : "text-[var(--ink-muted)]"}`}
        >
          {summary}
        </span>
        {selectedOptions.length > 0 && (
          <span className="shrink-0 rounded-sm bg-[var(--accent-cool-subtle)] px-1.5 py-0.5 text-xs text-[var(--accent-cool)]">
            {selectedOptions.length}
          </span>
        )}
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      <Popover
        open={open && !disabled}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        placement="bottom-start"
        matchAnchorWidth
        closeOnOutsideClick
        className="min-w-80 shadow-md"
      >
        <PickerSearch
          value={query}
          onChange={(nextQuery) => {
            setQuery(nextQuery);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          listId={listId}
          activeDescendant={
            filtered[resolvedActiveIndex]
              ? `${listId}-${filtered[resolvedActiveIndex].id}`
              : undefined
          }
          expanded={open}
        />
        <div className="flex items-center justify-between gap-2 border-b border-[var(--line-subtle)] px-2.5 py-2">
          <button
            type="button"
            className={`ns-button ${onlySelected ? "is-primary" : ""}`}
            onClick={() => {
              setOnlySelected((current) => !current);
              setActiveIndex(0);
            }}
          >
            <ListFilter className="h-3.5 w-3.5" />
            仅看已选
          </button>
          <button
            type="button"
            className="ns-button"
            disabled={values.length === 0}
            onClick={() => onChange([])}
          >
            清空
          </button>
        </div>
        <div className="flex items-center justify-between border-b border-[var(--line-subtle)] px-3 py-2 text-xs text-[var(--ink-muted)]">
          <span>{filtered.length.toLocaleString("zh-CN")} 个结果</span>
          <span>已选 {values.length.toLocaleString("zh-CN")}</span>
        </div>
        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-[var(--ink-muted)]">
            没有匹配的对象
          </div>
        ) : (
          <div id={listId} role="listbox" aria-multiselectable="true">
            <Virtuoso
              ref={virtuosoRef}
              data={filtered}
              style={{ height: resultHeight(filtered.length) }}
              computeItemKey={(_index, option) => option.id}
              itemContent={(index, option) => (
                <PickerOptionRow
                  option={option}
                  selected={selectedIds.has(option.id)}
                  active={index === resolvedActiveIndex}
                  onActivate={() => setActiveIndex(index)}
                  onSelect={() => toggle(option)}
                  optionId={`${listId}-${option.id}`}
                />
              )}
            />
          </div>
        )}
        <div className="flex items-center justify-between border-t border-[var(--line)] px-3 py-2.5">
          <span className="text-xs text-[var(--ink-muted)]">
            {values.length === 0 ? "尚未选择" : `已关联 ${values.length} 项`}
          </span>
          <button
            type="button"
            className="ns-button is-primary"
            onClick={() => {
              setOpen(false);
              triggerRef.current?.focus();
            }}
          >
            完成
          </button>
        </div>
      </Popover>
    </div>
  );
}
