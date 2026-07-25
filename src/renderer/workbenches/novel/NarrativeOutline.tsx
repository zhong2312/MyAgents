import {
  ArrowDown,
  ArrowUp,
  BookOpenText,
  FolderPlus,
  FolderTree,
  Layers3,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import type {
  NarrativeDirectory,
  NarrativeEngineering,
} from "./narrativeEngineeringSchema";
import NarrativeDirectoryTree from "./NarrativeDirectoryTree";
import NarrativeMarkdownField from "./NarrativeMarkdownField";
import {
  compareNarrativeOrder,
  narrativeDirectoryPath,
  nextNarrativeOrder,
  swapNarrativeOrder,
} from "./narrativePlanningModel";
import NarrativeSelect from "./NarrativeSelect";

interface NarrativeOutlineProps {
  readonly library: NarrativeEngineering;
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
  readonly onChange: (library: NarrativeEngineering) => void;
}

const KIND_LABELS: Readonly<Record<NarrativeDirectory["kind"], string>> = {
  volume: "卷",
  part: "篇",
  group: "组",
};

const STATUS_LABELS: Readonly<Record<NarrativeDirectory["status"], string>> = {
  idea: "构思",
  planned: "已规划",
  drafting: "整理中",
  complete: "已完成",
};

function createId(prefix: string): string {
  const token = globalThis.crypto?.randomUUID?.().slice(0, 8);
  return `${prefix}-${token ?? Date.now().toString(36)}`;
}

function createDirectory(
  kind: NarrativeDirectory["kind"],
  parentId: string | null,
  siblings: readonly NarrativeDirectory[],
): NarrativeDirectory {
  return {
    id: createId(kind),
    parentId,
    kind,
    title:
      kind === "volume"
        ? "未命名卷"
        : kind === "part"
          ? "未命名篇"
          : "未命名组",
    description: "",
    status: "idea",
    order: nextNarrativeOrder(siblings),
  };
}

export default function NarrativeOutline({
  library,
  selectedId,
  onSelect,
  onChange,
}: NarrativeOutlineProps) {
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const selected =
    library.directories.find((directory) => directory.id === selectedId) ??
    null;
  const selectedChildren = selected
    ? library.directories.filter(
        (directory) => directory.parentId === selected.id,
      )
    : [];
  const selectedChapters = selected
    ? library.chapters.filter((chapter) => chapter.directoryId === selected.id)
    : [];
  const siblings = useMemo(
    () =>
      selected
        ? library.directories
            .filter((directory) => directory.parentId === selected.parentId)
            .sort(compareNarrativeOrder)
        : [],
    [library.directories, selected],
  );
  const selectedIndex = selected
    ? siblings.findIndex((directory) => directory.id === selected.id)
    : -1;

  const addDirectory = (
    kind: NarrativeDirectory["kind"],
    parentId: string | null,
  ) => {
    const siblingDirectories = library.directories.filter(
      (directory) => directory.parentId === parentId,
    );
    const next = createDirectory(kind, parentId, siblingDirectories);
    onChange({ ...library, directories: [...library.directories, next] });
    onSelect(next.id);
    setIsCreateDialogOpen(false);
  };

  const updateSelected = (patch: Partial<NarrativeDirectory>) => {
    if (!selected) return;
    onChange({
      ...library,
      directories: library.directories.map((directory) =>
        directory.id === selected.id ? { ...directory, ...patch } : directory,
      ),
    });
  };

  const moveSelected = (offset: -1 | 1) => {
    if (!selected) return;
    const target = siblings[selectedIndex + offset];
    if (!target) return;
    onChange({
      ...library,
      directories: swapNarrativeOrder(
        library.directories,
        selected.id,
        target.id,
      ),
    });
  };

  const canDelete = Boolean(
    selected && selectedChildren.length === 0 && selectedChapters.length === 0,
  );

  return (
    <div className="ne-outline-grid h-full min-h-0">
      <aside className="ne-outline-sidebar flex min-h-0 flex-col border-r border-[var(--line)] bg-[var(--paper-elevated)]">
        <div className="ne-outline-sidebar-header flex shrink-0 items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="ne-outline-sidebar-mark" aria-hidden="true" />
              <div>
                <h2 className="text-sm font-semibold">卷 / 篇 / 组</h2>
                <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                  故事目录
                </p>
              </div>
            </div>
          </div>
          <button
            type="button"
            className="ns-button ne-outline-create-button"
            onClick={() => setIsCreateDialogOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            新建目录
          </button>
        </div>
        <div className="ne-panel-scroll ne-outline-sidebar-scroll flex-1 p-2">
          {library.directories.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-[var(--ink-muted)]">
              先创建第一卷，也可以先去章节页建立未归类章节。
            </div>
          ) : (
            <NarrativeDirectoryTree
              directories={library.directories}
              selectedId={selectedId}
              onSelect={(id) => typeof id === "string" && onSelect(id)}
            />
          )}
        </div>
      </aside>

      <main className="ne-panel-scroll ne-outline-detail bg-[var(--paper)]">
        {!selected ? (
          <div className="flex h-full min-h-72 items-center justify-center p-8 text-center">
            <div className="max-w-sm">
              <FolderTree className="mx-auto h-8 w-8 text-[var(--ink-subtle)]" />
              <h2 className="mt-4 text-sm font-semibold">选择一个目录</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
                卷、篇和组只负责组织章节；节和段在章节页内维护。
              </p>
            </div>
          </div>
        ) : (
          <div className="ne-outline-detail-inner mx-auto max-w-4xl p-6">
            <div className="ne-outline-detail-header flex items-start justify-between gap-4 border-b border-[var(--line)] pb-5">
              <div className="flex min-w-0 items-start gap-3">
                <span className="ne-outline-detail-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--paper-inset)] text-[var(--accent-cool)]">
                  {selected.kind === "volume" ? (
                    <Layers3 className="h-4 w-4" />
                  ) : selected.kind === "part" ? (
                    <BookOpenText className="h-4 w-4" />
                  ) : (
                    <FolderTree className="h-4 w-4" />
                  )}
                </span>
                <div className="min-w-0">
                  <p className="ne-outline-breadcrumb text-xs text-[var(--ink-muted)]">
                    {narrativeDirectoryPath(library.directories, selected.id)}
                  </p>
                  <h2 className="mt-1 truncate text-lg font-semibold">
                    {selected.title}
                  </h2>
                </div>
              </div>
              <div className="ne-outline-detail-actions flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className="ns-icon-button border-0"
                  title="上移"
                  aria-label="上移目录"
                  disabled={selectedIndex <= 0}
                  onClick={() => moveSelected(-1)}
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="ns-icon-button border-0"
                  title="下移"
                  aria-label="下移目录"
                  disabled={
                    selectedIndex < 0 || selectedIndex >= siblings.length - 1
                  }
                  onClick={() => moveSelected(1)}
                >
                  <ArrowDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="ns-icon-button border-0 text-[var(--ink-muted)] hover:text-[var(--error)]"
                  title={
                    canDelete
                      ? "删除空目录"
                      : "非空目录不能删除，请先移动子目录和章节"
                  }
                  aria-label="删除目录"
                  disabled={!canDelete}
                  onClick={() => {
                    if (!selected || !canDelete) return;
                    onChange({
                      ...library,
                      directories: library.directories.filter(
                        (directory) => directory.id !== selected.id,
                      ),
                    });
                    onSelect(selected.parentId ?? "");
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="ne-field-grid mt-5">
              <label className="min-w-0">
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  目录名称
                </span>
                <input
                  value={selected.title}
                  onChange={(event) =>
                    updateSelected({ title: event.target.value })
                  }
                  className="ne-input"
                />
              </label>
              <label className="min-w-0">
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  状态
                </span>
                <NarrativeSelect
                  value={selected.status}
                  className="w-full"
                  onChange={(event) =>
                    updateSelected({
                      status: event.target
                        .value as NarrativeDirectory["status"],
                    })
                  }
                >
                  {Object.entries(STATUS_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </NarrativeSelect>
              </label>
              <div className="col-span-full min-w-0">
                <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                  {KIND_LABELS[selected.kind]}规划说明
                </span>
                <NarrativeMarkdownField
                  pageId={`directory:${selected.id}:description`}
                  label={`${KIND_LABELS[selected.kind]}规划说明`}
                  value={selected.description}
                  onChange={(description) => updateSelected({ description })}
                  placeholder={
                    selected.kind === "volume"
                      ? "本卷的大阶段、主题或时空范围"
                      : selected.kind === "part"
                        ? "本篇的子主题、视角群或中时空"
                        : "这一组章节的组织意图"
                  }
                  className="ne-outline-markdown-field"
                />
              </div>
            </div>
          </div>
        )}
      </main>
      {isCreateDialogOpen && (
        <CreateDirectoryDialog
          selected={selected}
          onClose={() => setIsCreateDialogOpen(false)}
          onCreate={addDirectory}
        />
      )}
    </div>
  );
}

function CreateDirectoryDialog({
  selected,
  onClose,
  onCreate,
}: {
  readonly selected: NarrativeDirectory | null;
  readonly onClose: () => void;
  readonly onCreate: (
    kind: NarrativeDirectory["kind"],
    parentId: string | null,
  ) => void;
}) {
  const canCreatePart = selected?.kind === "volume";
  const canCreateGroup = selected !== null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="w-full max-w-md border border-[var(--line)] bg-[var(--paper)] shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="narrative-create-directory-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
          <div>
            <h2
              id="narrative-create-directory-title"
              className="text-base font-semibold"
            >
              新建目录
            </h2>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              选择要创建的目录类型。
            </p>
          </div>
          <button
            type="button"
            className="ns-icon-button border-0"
            aria-label="关闭新建目录面板"
            title="关闭"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="grid gap-2 p-4">
          <DirectoryCreateOption
            icon={<Layers3 className="h-4 w-4" />}
            title="卷"
            description="在根层创建一个新的大阶段。"
            onClick={() => onCreate("volume", null)}
          />
          <DirectoryCreateOption
            icon={<BookOpenText className="h-4 w-4" />}
            title="篇"
            description={
              canCreatePart
                ? `在“${selected.title}”下创建篇。`
                : "请先在目录树中选择一卷。"
            }
            disabled={!canCreatePart}
            onClick={() => selected && onCreate("part", selected.id)}
          />
          <DirectoryCreateOption
            icon={<FolderPlus className="h-4 w-4" />}
            title="组"
            description={
              canCreateGroup
                ? `在“${selected.title}”下创建组。`
                : "请先在目录树中选择一个目录。"
            }
            disabled={!canCreateGroup}
            onClick={() => selected && onCreate("group", selected.id)}
          />
        </div>

        <footer className="border-t border-[var(--line)] px-5 py-3 text-xs leading-5 text-[var(--ink-muted)]">
          卷位于根层；篇位于卷下；组可嵌套在任意目录下。
        </footer>
      </section>
    </div>
  );
}

function DirectoryCreateOption({
  icon,
  title,
  description,
  disabled = false,
  onClick,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex min-h-16 items-center gap-3 border border-[var(--line)] px-3 py-3 text-left transition-colors hover:border-[var(--accent-cool)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-45"
      disabled={disabled}
      onClick={onClick}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center bg-[var(--paper-inset)] text-[var(--accent-cool)]">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-[var(--ink)]">
          {title}
        </span>
        <span className="mt-0.5 block text-xs leading-5 text-[var(--ink-muted)]">
          {description}
        </span>
      </span>
    </button>
  );
}
