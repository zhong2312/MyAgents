import {
  BookOpenText,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderTree,
  Layers3,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { NarrativeDirectory } from "./narrativeEngineeringSchema";
import { narrativeDirectoryChildren } from "./narrativePlanningModel";

export type NarrativeDirectorySelection = "all" | "unassigned" | string;

interface NarrativeDirectoryTreeProps {
  readonly directories: readonly NarrativeDirectory[];
  readonly selectedId: NarrativeDirectorySelection;
  readonly onSelect: (id: NarrativeDirectorySelection) => void;
  readonly chapterCounts?: ReadonlyMap<string | null, number>;
  readonly showAll?: boolean;
  readonly showUnassigned?: boolean;
}

const KIND_LABELS: Readonly<Record<NarrativeDirectory["kind"], string>> = {
  volume: "卷",
  part: "篇",
  group: "组",
};

export default function NarrativeDirectoryTree({
  directories,
  selectedId,
  onSelect,
  chapterCounts,
  showAll = false,
  showUnassigned = false,
}: NarrativeDirectoryTreeProps) {
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const children = useMemo(
    () => narrativeDirectoryChildren(directories),
    [directories],
  );
  const countForDirectory = (directoryId: string): number => {
    if (!chapterCounts) return 0;
    let total = chapterCounts.get(directoryId) ?? 0;
    (children.get(directoryId) ?? []).forEach((child) => {
      total += countForDirectory(child.id);
    });
    return total;
  };
  const renderDirectories = (parentId: string | null, depth: number) =>
    (children.get(parentId) ?? []).map((directory) => {
      const childDirectories = children.get(directory.id) ?? [];
      const collapsed = collapsedIds.has(directory.id);
      const Icon =
        directory.kind === "volume"
          ? Layers3
          : directory.kind === "part"
            ? BookOpenText
            : Folder;
      return (
        <div key={directory.id}>
          <div
            className={`ne-directory-row group flex h-9 min-w-0 items-center gap-1 rounded px-1.5 text-sm ${
              selectedId === directory.id
                ? "is-selected bg-[var(--accent-warm-muted)] text-[var(--ink)]"
                : "text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)]"
            }`}
            style={{ paddingLeft: `${depth * 16 + 6}px` }}
          >
            <button
              type="button"
              className="ne-directory-toggle flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
              aria-label={collapsed ? "展开目录" : "折叠目录"}
              disabled={childDirectories.length === 0}
              onClick={() =>
                setCollapsedIds((current) => {
                  const next = new Set(current);
                  if (next.has(directory.id)) next.delete(directory.id);
                  else next.add(directory.id);
                  return next;
                })
              }
            >
              {childDirectories.length === 0 ? null : collapsed ? (
                <ChevronRight className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              className="ne-directory-select flex min-w-0 flex-1 items-center gap-2 text-left"
              onClick={() => onSelect(directory.id)}
            >
              <Icon className="ne-directory-icon h-3.5 w-3.5 shrink-0 text-[var(--accent-cool)]" />
              <span className="min-w-0 flex-1 truncate">{directory.title}</span>
              <span className="ne-directory-kind shrink-0 text-xs text-[var(--ink-subtle)]">
                {KIND_LABELS[directory.kind]}
                {chapterCounts ? ` · ${countForDirectory(directory.id)}` : ""}
              </span>
            </button>
          </div>
          {!collapsed && renderDirectories(directory.id, depth + 1)}
        </div>
      );
    });

  return (
    <div className="ne-directory-tree space-y-1">
      {showAll && (
        <button
          type="button"
          className={`ne-directory-row flex h-9 w-full items-center gap-2 rounded px-3 text-left text-sm ${
            selectedId === "all"
              ? "is-selected bg-[var(--accent-warm-muted)] text-[var(--ink)]"
              : "text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)]"
          }`}
          onClick={() => onSelect("all")}
        >
          <FolderTree className="h-3.5 w-3.5 text-[var(--accent-warm)]" />
          <span className="min-w-0 flex-1 truncate">全部章节</span>
          {chapterCounts && (
            <span className="text-xs text-[var(--ink-subtle)]">
              {[...chapterCounts.values()].reduce(
                (sum, count) => sum + count,
                0,
              )}
            </span>
          )}
        </button>
      )}
      {renderDirectories(null, 0)}
      {showUnassigned && (
        <button
          type="button"
          className={`ne-directory-row flex h-9 w-full items-center gap-2 rounded px-3 text-left text-sm ${
            selectedId === "unassigned"
              ? "is-selected bg-[var(--accent-warm-muted)] text-[var(--ink)]"
              : "text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)]"
          }`}
          onClick={() => onSelect("unassigned")}
        >
          <Folder className="h-3.5 w-3.5 text-[var(--ink-subtle)]" />
          <span className="min-w-0 flex-1 truncate">未归类</span>
          {chapterCounts && (
            <span className="text-xs text-[var(--ink-subtle)]">
              {chapterCounts.get(null) ?? 0}
            </span>
          )}
        </button>
      )}
    </div>
  );
}
