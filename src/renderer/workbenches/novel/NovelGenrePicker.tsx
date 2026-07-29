import { Check, ChevronDown, X } from "lucide-react";
import { useRef } from "react";

import { Popover } from "@/workbench-sdk";

import { NOVEL_GENRE_GROUPS } from "./novelGenres";

interface NovelGenrePickerProps {
  readonly id: string;
  readonly genres: readonly string[];
  readonly open: boolean;
  readonly disabled?: boolean;
  onChange(genres: string[]): void;
  onOpenChange(open: boolean): void;
}

export default function NovelGenrePicker({
  id,
  genres,
  open,
  disabled = false,
  onChange,
  onOpenChange,
}: NovelGenrePickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const labelId = `${id}-label`;
  const genreSummary =
    genres.length <= 2
      ? genres.join("、")
      : `${genres.slice(0, 2).join("、")} 等 ${genres.length} 项`;

  const toggleGenre = (genre: string) => {
    onChange(
      genres.includes(genre)
        ? genres.filter((item) => item !== genre)
        : [...genres, genre],
    );
  };

  return (
    <div>
      <span
        id={labelId}
        className="mb-2 block text-sm font-medium text-[var(--ink)]"
      >
        题材
      </span>
      <button
        ref={triggerRef}
        type="button"
        aria-labelledby={labelId}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
        className="flex h-10 w-full items-center justify-between rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-left text-sm text-[var(--ink)] outline-none transition-colors hover:border-[var(--line-strong)] focus:border-[var(--accent-warm)] disabled:opacity-50"
      >
        <span
          className={
            genres.length > 0 ? "truncate" : "truncate text-[var(--ink-subtle)]"
          }
        >
          {genreSummary || "请选择题材"}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-[var(--ink-muted)] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      <Popover
        open={open}
        onClose={() => onOpenChange(false)}
        anchorRef={triggerRef}
        placement="bottom-start"
        offset={6}
        className="w-[min(34rem,calc(100vw-2rem))]"
      >
        <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-2.5">
          <span className="text-sm font-medium text-[var(--ink)]">
            小说题材
          </span>
          <span className="text-xs text-[var(--ink-muted)]">
            已选 {genres.length} 项
          </span>
        </div>
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-labelledby={labelId}
          className="max-h-[min(28rem,calc(100vh-12rem))] overflow-y-auto"
        >
          {NOVEL_GENRE_GROUPS.map((group) => (
            <section key={group.label} aria-label={group.label}>
              <div className="border-b border-[var(--line-subtle)] bg-[var(--paper-elevated)] px-3 py-2 text-xs font-semibold text-[var(--ink-muted)]">
                {group.label}
              </div>
              <div className="flex flex-wrap gap-1.5 border-b border-[var(--line-subtle)] bg-[var(--paper-inset)]/55 px-3 py-2.5">
                {group.options.map((option) => {
                  const selected = genres.includes(option);
                  return (
                    <button
                      key={option}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => toggleGenre(option)}
                      className={`flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm transition-colors ${
                        selected
                          ? "border-[var(--accent-warm)] bg-[var(--accent-warm-muted)] font-medium text-[var(--accent-warm)]"
                          : "border-transparent bg-[var(--paper-elevated)] text-[var(--ink)] hover:bg-[var(--hover-bg)]"
                      }`}
                    >
                      <span
                        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
                          selected
                            ? "border-[var(--accent-warm)] bg-[var(--accent-warm)] text-[var(--on-accent)]"
                            : "border-[var(--line-strong)] text-transparent"
                        }`}
                      >
                        <Check className="h-3 w-3" />
                      </span>
                      {option}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2">
          <button
            type="button"
            onClick={() => onChange([])}
            disabled={genres.length === 0}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-40"
          >
            <X className="h-3.5 w-3.5" />
            清空
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="flex items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
          >
            <Check className="h-3.5 w-3.5" />
            完成
          </button>
        </div>
      </Popover>
    </div>
  );
}
