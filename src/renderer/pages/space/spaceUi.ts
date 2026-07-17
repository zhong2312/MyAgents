import type { CSSProperties } from "react";
import { currentSupportedLocale } from "@/i18n/format";
import { isClosedIssue } from "./spaceHelpers";

export const PAPER_GRID_STYLE: CSSProperties = {
  backgroundImage:
    "linear-gradient(var(--line-subtle) 1px, var(--paper-a0) 1px), linear-gradient(90deg, var(--line-subtle) 1px, var(--paper-a0) 1px)",
  backgroundSize: "24px 24px, 24px 24px",
  maskImage:
    "linear-gradient(to bottom, rgb(0 0 0 / 0) 0, #000 120px, #000 calc(100% - 120px), rgb(0 0 0 / 0) 100%)",
};

export const SPACE_BACKGROUND_STYLE: CSSProperties = {
  background:
    "linear-gradient(180deg, var(--paper-elevated), var(--paper) 48%, color-mix(in srgb, var(--paper) 86%, var(--paper-inset)) 100%), var(--paper)",
};

export const SPACE_LIST_FRAME_CLASS = "mx-auto max-w-4xl";
export const SPACE_COLLECTION_FRAME_CLASS = "mx-auto max-w-6xl";
export const SPACE_NARRATIVE_INSET_CLASS = "px-3 max-sm:px-2";
export const SPACE_TWO_COLUMN_GRID_CLASS =
  "grid grid-cols-2 gap-3 max-lg:grid-cols-1";
export const SPACE_PRIMARY_TOOL_BUTTON_CLASS =
  "flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-[var(--button-primary-bg)] px-4 text-sm font-semibold text-[var(--button-primary-text)] shadow-sm transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70";
export const SPACE_REFRESH_TOOL_BUTTON_CLASS =
  "grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-transparent text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-70";

export function formatTime(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(currentSupportedLocale(), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatFullTime(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(currentSupportedLocale(), {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDate(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(currentSupportedLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatBytes(value?: number | null): string {
  if (!value || value <= 0) return "0 KB";
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function statusPillClass(status: string): string {
  if (status === "todo") return "bg-[var(--warning-bg)] text-[var(--warning)]";
  if (status === "doing") return "bg-[var(--error-bg)] text-[var(--error)]";
  if (status === "done") return "bg-[var(--success-bg)] text-[var(--success)]";
  if (isClosedIssue(status))
    return "bg-[var(--paper-inset)] text-[var(--ink-muted)]";
  return "bg-[var(--paper-inset)] text-[var(--ink)]";
}

export function statusTextClass(status: string): string {
  if (status === "todo") return "text-[var(--warning)]";
  if (status === "doing") return "text-[var(--error)]";
  if (status === "done") return "text-[var(--success)]";
  if (isClosedIssue(status)) return "text-[var(--ink-muted)]";
  return "text-[var(--ink)]";
}
