import {
  BookOpenText,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  GripVertical,
  Plus,
  Trash2,
} from "lucide-react";
import { pinyin } from "pinyin-pro";
import { useMemo, useState } from "react";

import { ConfirmDialog } from "@/workbench-sdk";

import type { CharacterRecord } from "./characterLibrarySchema";
import NarrativeDirectoryTree, {
  type NarrativeDirectorySelection,
} from "./NarrativeDirectoryTree";
import {
  NarrativeEntityMultiSelect,
  NarrativeEntitySelect,
  type NarrativeEntityOption,
} from "./NarrativeEntityPicker";
import type {
  NarrativeChapterPlan,
  NarrativeEngineering,
  NarrativeKeyNodeLocation,
  NarrativeParagraphPlan,
  NarrativeSectionPlan,
  PlotLine,
  StoryArc,
} from "./narrativeEngineeringSchema";
import {
  narrativeDirectoryDescendantIds,
  narrativeDirectoryPath,
  narrativeDirectoryRows,
  nextNarrativeOrder,
  orderedNarrativeChapters,
} from "./narrativePlanningModel";
import NarrativeSelect from "./NarrativeSelect";
import NarrativeTextField from "./NarrativeTextField";
import type { LoadedNovelChapter } from "./repository";

interface NarrativeChaptersProps {
  readonly library: NarrativeEngineering;
  readonly manuscriptChapters: readonly LoadedNovelChapter[];
  readonly characters: readonly CharacterRecord[];
  readonly selectedDirectory: NarrativeDirectorySelection;
  readonly selectedChapterId: string;
  readonly onSelectDirectory: (id: NarrativeDirectorySelection) => void;
  readonly onSelectChapter: (id: string) => void;
  readonly onChange: (library: NarrativeEngineering) => void;
}

const STATUS_LABELS: Readonly<Record<NarrativeChapterPlan["status"], string>> =
  {
    idea: "构思",
    planned: "已规划",
    drafting: "写作中",
    complete: "已完成",
  };

function createId(prefix: string): string {
  const token = globalThis.crypto?.randomUUID?.().slice(0, 8);
  return `${prefix}-${token ?? Date.now().toString(36)}`;
}

function characterOption(character: CharacterRecord): NarrativeEntityOption {
  const names = [character.name, character.alias].filter(Boolean);
  const pinyinKeywords = names.flatMap((name) => {
    const value = pinyin(name, { toneType: "none" });
    return [value, value.replace(/\s+/gu, "")];
  });
  return {
    id: character.id,
    label: character.name,
    description:
      [character.alias, character.archetype].filter(Boolean).join(" · ") ||
      "人物库角色",
    keywords: [character.alias, character.archetype, ...pinyinKeywords],
  };
}

function reorderById<T extends { readonly id: string; readonly order: number }>(
  records: readonly T[],
  sourceId: string,
  targetId: string,
): T[] {
  const ordered = [...records].sort((left, right) => left.order - right.order);
  const sourceIndex = ordered.findIndex((record) => record.id === sourceId);
  const targetIndex = ordered.findIndex((record) => record.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return [...records];
  }
  const [source] = ordered.splice(sourceIndex, 1);
  ordered.splice(targetIndex, 0, source);
  return ordered.map((record, order) => ({ ...record, order }));
}

function createSection(chapter: NarrativeChapterPlan): NarrativeSectionPlan {
  return {
    id: createId("section"),
    order: nextNarrativeOrder(chapter.sections),
    title: "",
    description: "",
    povCharacterId: null,
    lineIds: [],
    arcIds: [],
    paragraphs: [],
  };
}

function createParagraph(
  section: NarrativeSectionPlan,
): NarrativeParagraphPlan {
  return {
    id: createId("paragraph"),
    order: nextNarrativeOrder(section.paragraphs),
    content: "",
  };
}

function withoutKeyNodeLocations(
  library: NarrativeEngineering,
  shouldRemove: (location: NarrativeKeyNodeLocation) => boolean,
): NarrativeEngineering {
  const trimNodes = <T extends PlotLine | StoryArc>(owner: T): T => ({
    ...owner,
    keyNodes: owner.keyNodes.map((node) => ({
      ...node,
      locations: node.locations.filter((location) => !shouldRemove(location)),
    })),
  });
  return {
    ...library,
    lines: library.lines.map(trimNodes),
    arcs: library.arcs.map(trimNodes),
  };
}

function SectionEditor({
  section,
  sectionNumber,
  collapsed,
  characters,
  lineOptions,
  arcOptions,
  draggedSectionId,
  onToggle,
  onDragSection,
  onDropSection,
  onChange,
  onDelete,
}: {
  readonly section: NarrativeSectionPlan;
  readonly sectionNumber: number;
  readonly collapsed: boolean;
  readonly characters: readonly CharacterRecord[];
  readonly lineOptions: readonly NarrativeEntityOption[];
  readonly arcOptions: readonly NarrativeEntityOption[];
  readonly draggedSectionId: string;
  readonly onToggle: () => void;
  readonly onDragSection: (id: string) => void;
  readonly onDropSection: (id: string) => void;
  readonly onChange: (section: NarrativeSectionPlan) => void;
  readonly onDelete: () => void;
}) {
  const [draggedParagraphId, setDraggedParagraphId] = useState("");
  const [deleteParagraphId, setDeleteParagraphId] = useState<string | null>(
    null,
  );
  const characterOptions = useMemo<NarrativeEntityOption[]>(
    () => [
      { id: "", label: "暂不指定视角" },
      ...characters.map(characterOption),
    ],
    [characters],
  );
  const paragraphs = [...section.paragraphs].sort(
    (left, right) => left.order - right.order,
  );
  const updateParagraph = (
    paragraphId: string,
    patch: Partial<NarrativeParagraphPlan>,
  ) =>
    onChange({
      ...section,
      paragraphs: section.paragraphs.map((paragraph) =>
        paragraph.id === paragraphId ? { ...paragraph, ...patch } : paragraph,
      ),
    });

  return (
    <section
      className={`border-b border-[var(--line)] ${
        draggedSectionId === section.id ? "opacity-50" : ""
      }`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={() => onDropSection(section.id)}
    >
      <div className="flex min-w-0 items-center gap-2 px-3 py-3 hover:bg-[var(--hover-bg)]">
        <button
          type="button"
          draggable
          className="flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded text-[var(--ink-subtle)] hover:bg-[var(--paper-inset)] active:cursor-grabbing"
          title="拖动节排序"
          aria-label={`拖动第 ${sectionNumber} 节排序`}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            onDragSection(section.id);
          }}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
          aria-label={collapsed ? "展开节" : "折叠节"}
          onClick={onToggle}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </button>
        <span className="w-12 shrink-0 text-xs font-semibold tabular-nums text-[var(--accent-cool)]">
          {String(sectionNumber).padStart(2, "0")}节
        </span>
        <input
          value={section.title}
          onChange={(event) =>
            onChange({ ...section, title: event.target.value })
          }
          placeholder="可选节标题"
          aria-label={`第 ${sectionNumber} 节标题`}
          className="min-w-0 flex-1 border-0 bg-transparent px-1 py-1 text-sm font-medium text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)]"
        />
        <span className="shrink-0 text-xs text-[var(--ink-muted)]">
          {section.paragraphs.length} 段
        </span>
        <button
          type="button"
          className="ns-icon-button h-7 w-7 shrink-0 border-0 text-[var(--ink-muted)] hover:text-[var(--error)]"
          title="删除本节"
          aria-label={`删除第 ${sectionNumber} 节`}
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {!collapsed && (
        <div className="border-t border-[var(--line-subtle)] bg-[var(--paper-elevated)] px-5 py-5">
          <div className="ne-field-grid">
            <NarrativeTextField
              id={`section-${section.id}-description`}
              label="本节简述"
              value={section.description}
              onChange={(description) => onChange({ ...section, description })}
              placeholder="本节发生在哪里、由谁行动、状态如何变化？"
              size="long"
              wide
            />
            <div>
              <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                视角人物
              </span>
              <NarrativeEntitySelect
                value={section.povCharacterId ?? ""}
                options={characterOptions}
                placeholder="搜索人物库"
                ariaLabel="本节视角人物"
                onChange={(value) =>
                  onChange({ ...section, povCharacterId: value || null })
                }
              />
            </div>
            <div>
              <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                关联线路
              </span>
              <NarrativeEntityMultiSelect
                values={section.lineIds}
                options={lineOptions}
                placeholder="选择本节线路"
                ariaLabel="本节关联线路"
                disabled={lineOptions.length === 0}
                onChange={(lineIds) => onChange({ ...section, lineIds })}
              />
            </div>
            <div className="col-span-full">
              <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                关联故事弧
              </span>
              <NarrativeEntityMultiSelect
                values={section.arcIds}
                options={arcOptions}
                placeholder="选择本节故事弧"
                ariaLabel="本节关联故事弧"
                disabled={arcOptions.length === 0}
                onChange={(arcIds) => onChange({ ...section, arcIds })}
              />
            </div>
          </div>

          <div className="mt-6 border-t border-[var(--line)] pt-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold">段落规划</h4>
                <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                  段只记录动作、话题或说话人变化，不关联线路与故事弧。
                </p>
              </div>
              <button
                type="button"
                className="ns-button"
                onClick={() =>
                  onChange({
                    ...section,
                    paragraphs: [
                      ...section.paragraphs,
                      createParagraph(section),
                    ],
                  })
                }
              >
                <Plus className="h-3.5 w-3.5" />
                添加段
              </button>
            </div>
            {paragraphs.length === 0 ? (
              <p className="mt-4 border-l-2 border-[var(--line-strong)] pl-3 text-xs leading-5 text-[var(--ink-muted)]">
                本节尚未拆分段落。
              </p>
            ) : (
              <div className="mt-4 divide-y divide-[var(--line-subtle)] border-y border-[var(--line)]">
                {paragraphs.map((paragraph, index) => (
                  <div
                    key={paragraph.id}
                    className={
                      draggedParagraphId === paragraph.id ? "opacity-50" : ""
                    }
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (!draggedParagraphId) return;
                      onChange({
                        ...section,
                        paragraphs: reorderById(
                          section.paragraphs,
                          draggedParagraphId,
                          paragraph.id,
                        ),
                      });
                      setDraggedParagraphId("");
                    }}
                  >
                    <div className="flex items-start gap-2 py-4">
                      <button
                        type="button"
                        draggable
                        className="mt-7 flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded text-[var(--ink-subtle)] hover:bg-[var(--paper-inset)]"
                        title="拖动段排序"
                        aria-label={`拖动第 ${index + 1} 段排序`}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          setDraggedParagraphId(paragraph.id);
                        }}
                      >
                        <GripVertical className="h-4 w-4" />
                      </button>
                      <div className="min-w-0 flex-1">
                        <NarrativeTextField
                          id={`paragraph-${paragraph.id}-content`}
                          label={`${String(index + 1).padStart(2, "0")}段`}
                          value={paragraph.content}
                          onChange={(content) =>
                            updateParagraph(paragraph.id, { content })
                          }
                          placeholder="这一段的动作、话题或说话人变化"
                          size="short"
                        />
                      </div>
                      <button
                        type="button"
                        className="mt-7 ns-icon-button h-7 w-7 shrink-0 border-0 text-[var(--ink-muted)] hover:text-[var(--error)]"
                        title="删除本段"
                        aria-label={`删除第 ${index + 1} 段`}
                        onClick={() => setDeleteParagraphId(paragraph.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {deleteParagraphId && (
        <ConfirmDialog
          title="删除段落规划"
          message="确认删除这一段规划？此操作会在保存后写入项目。"
          confirmText="删除"
          confirmVariant="danger"
          onConfirm={() => {
            onChange({
              ...section,
              paragraphs: section.paragraphs.filter(
                (paragraph) => paragraph.id !== deleteParagraphId,
              ),
            });
            setDeleteParagraphId(null);
          }}
          onCancel={() => setDeleteParagraphId(null)}
        />
      )}
    </section>
  );
}

function ChapterDetail({
  chapter,
  library,
  manuscriptChapters,
  characters,
  onChange,
  onDelete,
}: {
  readonly chapter: NarrativeChapterPlan;
  readonly library: NarrativeEngineering;
  readonly manuscriptChapters: readonly LoadedNovelChapter[];
  readonly characters: readonly CharacterRecord[];
  readonly onChange: (chapter: NarrativeChapterPlan) => void;
  readonly onDelete: () => void;
}) {
  const [collapsedSectionIds, setCollapsedSectionIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [draggedSectionId, setDraggedSectionId] = useState("");
  const [deleteSectionId, setDeleteSectionId] = useState<string | null>(null);
  const [deleteChapter, setDeleteChapter] = useState(false);
  const sections = [...chapter.sections].sort(
    (left, right) => left.order - right.order,
  );
  const lineOptions = useMemo<NarrativeEntityOption[]>(
    () =>
      library.lines.map((line) => ({
        id: line.id,
        label: line.title,
        description: line.kind === "main" ? "主线" : "剧情支线",
      })),
    [library.lines],
  );
  const arcOptions = useMemo<NarrativeEntityOption[]>(
    () =>
      library.arcs.map((arc) => ({
        id: arc.id,
        label: arc.title,
        description: arc.kind === "character" ? "角色弧" : "故事弧",
      })),
    [library.arcs],
  );
  const directoryOptions = useMemo<NarrativeEntityOption[]>(
    () => [
      { id: "", label: "未归类" },
      ...narrativeDirectoryRows(library.directories).map(({ directory }) => ({
        id: directory.id,
        label: directory.title,
        description: narrativeDirectoryPath(library.directories, directory.id),
      })),
    ],
    [library.directories],
  );
  const linkedByManuscript = useMemo(
    () =>
      new Map(
        library.chapters.flatMap((candidate) =>
          candidate.manuscriptChapterId && candidate.id !== chapter.id
            ? [[candidate.manuscriptChapterId, candidate.title] as const]
            : [],
        ),
      ),
    [chapter.id, library.chapters],
  );
  const manuscriptOptions = useMemo<NarrativeEntityOption[]>(
    () => [
      { id: "", label: "暂不关联正文" },
      ...manuscriptChapters.map((manuscript) => ({
        id: manuscript.id,
        label: `第 ${manuscript.number} 章 · ${manuscript.title}`,
        description: linkedByManuscript.has(manuscript.id)
          ? `已被“${linkedByManuscript.get(manuscript.id)}”关联`
          : `${manuscript.words.toLocaleString("zh-CN")} 字`,
        keywords: [String(manuscript.number), manuscript.title],
      })),
    ],
    [linkedByManuscript, manuscriptChapters],
  );
  const update = (patch: Partial<NarrativeChapterPlan>) =>
    onChange({ ...chapter, ...patch, updatedAt: new Date().toISOString() });

  return (
    <div className="ne-panel-scroll h-full bg-[var(--paper)]">
      <div className="mx-auto max-w-4xl p-6">
        <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] pb-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--paper-inset)] text-[var(--accent-warm)]">
              <FileText className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs text-[var(--ink-muted)]">
                {narrativeDirectoryPath(
                  library.directories,
                  chapter.directoryId,
                )}
              </p>
              <h2 className="mt-1 truncate text-lg font-semibold">
                {chapter.title}
              </h2>
            </div>
          </div>
          <button
            type="button"
            className="ns-button is-danger"
            onClick={() => setDeleteChapter(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除章节规划
          </button>
        </div>

        <div className="ne-field-grid mt-5">
          <label className="min-w-0">
            <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
              章节标题
            </span>
            <input
              value={chapter.title}
              onChange={(event) => update({ title: event.target.value })}
              className="ne-input"
            />
          </label>
          <label className="min-w-0">
            <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
              状态
            </span>
            <NarrativeSelect
              value={chapter.status}
              className="w-full"
              onChange={(event) =>
                update({
                  status: event.target.value as NarrativeChapterPlan["status"],
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
          <div>
            <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
              所属卷 / 篇 / 组
            </span>
            <NarrativeEntitySelect
              value={chapter.directoryId ?? ""}
              options={directoryOptions}
              placeholder="搜索目录"
              ariaLabel="章节所属目录"
              onChange={(value) => update({ directoryId: value || null })}
            />
          </div>
          <div>
            <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
              关联正文
            </span>
            <NarrativeEntitySelect
              value={chapter.manuscriptChapterId ?? ""}
              options={manuscriptOptions}
              placeholder="按序号或标题搜索正文"
              ariaLabel="关联正文章节"
              onChange={(value) =>
                update({ manuscriptChapterId: value || null })
              }
            />
          </div>
          <NarrativeTextField
            id={`chapter-${chapter.id}-description`}
            label="章节规划说明"
            value={chapter.description}
            onChange={(description) => update({ description })}
            placeholder="本章的阅读节奏、悬念钩子和主要变化"
            size="long"
            wide
          />
          <div>
            <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
              章级线路
            </span>
            <NarrativeEntityMultiSelect
              values={chapter.lineIds}
              options={lineOptions}
              placeholder="选择贯穿本章的线路"
              ariaLabel="章级关联线路"
              disabled={lineOptions.length === 0}
              onChange={(lineIds) => update({ lineIds })}
            />
          </div>
          <div>
            <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
              章级故事弧
            </span>
            <NarrativeEntityMultiSelect
              values={chapter.arcIds}
              options={arcOptions}
              placeholder="选择贯穿本章的故事弧"
              ariaLabel="章级关联故事弧"
              disabled={arcOptions.length === 0}
              onChange={(arcIds) => update({ arcIds })}
            />
          </div>
        </div>

        <section className="mt-8 border-t border-[var(--line)] pt-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">节与段</h3>
              <p className="mt-1 text-xs text-[var(--ink-muted)]">
                一章可拆成多个节；编号按当前顺序自动生成，拖动不会改变稳定 ID。
              </p>
            </div>
            <button
              type="button"
              className="ns-button is-primary"
              onClick={() =>
                update({
                  sections: [...chapter.sections, createSection(chapter)],
                })
              }
            >
              <Plus className="h-3.5 w-3.5" />
              添加节
            </button>
          </div>
          {sections.length === 0 ? (
            <div className="mt-5 border-y border-[var(--line)] py-10 text-center">
              <BookOpenText className="mx-auto h-7 w-7 text-[var(--ink-subtle)]" />
              <p className="mt-3 text-sm font-medium">本章还没有节规划</p>
              <p className="mt-1 text-xs text-[var(--ink-muted)]">
                可以先保留空章节，也可以从第一节开始拆解。
              </p>
            </div>
          ) : (
            <div className="mt-5 border-t border-[var(--line)]">
              {sections.map((section, index) => (
                <SectionEditor
                  key={section.id}
                  section={section}
                  sectionNumber={index + 1}
                  collapsed={collapsedSectionIds.has(section.id)}
                  characters={characters}
                  lineOptions={lineOptions}
                  arcOptions={arcOptions}
                  draggedSectionId={draggedSectionId}
                  onToggle={() =>
                    setCollapsedSectionIds((current) => {
                      const next = new Set(current);
                      if (next.has(section.id)) next.delete(section.id);
                      else next.add(section.id);
                      return next;
                    })
                  }
                  onDragSection={setDraggedSectionId}
                  onDropSection={(targetId) => {
                    if (!draggedSectionId) return;
                    update({
                      sections: reorderById(
                        chapter.sections,
                        draggedSectionId,
                        targetId,
                      ),
                    });
                    setDraggedSectionId("");
                  }}
                  onChange={(nextSection) =>
                    update({
                      sections: chapter.sections.map((candidate) =>
                        candidate.id === nextSection.id
                          ? nextSection
                          : candidate,
                      ),
                    })
                  }
                  onDelete={() => setDeleteSectionId(section.id)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
      {deleteSectionId && (
        <ConfirmDialog
          title="删除节规划"
          message="删除本节会同时删除其下所有段落规划。确认继续？"
          confirmText="删除"
          confirmVariant="danger"
          onConfirm={() => {
            update({
              sections: chapter.sections.filter(
                (section) => section.id !== deleteSectionId,
              ),
            });
            setDeleteSectionId(null);
          }}
          onCancel={() => setDeleteSectionId(null)}
        />
      )}
      {deleteChapter && (
        <ConfirmDialog
          title="删除章节规划"
          message="只会删除剧情工程中的章节、节和段规划，不会删除正文文件。确认继续？"
          confirmText="删除"
          confirmVariant="danger"
          onConfirm={onDelete}
          onCancel={() => setDeleteChapter(false)}
        />
      )}
    </div>
  );
}

export default function NarrativeChapters({
  library,
  manuscriptChapters,
  characters,
  selectedDirectory,
  selectedChapterId,
  onSelectDirectory,
  onSelectChapter,
  onChange,
}: NarrativeChaptersProps) {
  const [includeDescendants, setIncludeDescendants] = useState(true);
  const [draggedChapterId, setDraggedChapterId] = useState("");
  const chapterCounts = useMemo(() => {
    const counts = new Map<string | null, number>();
    library.chapters.forEach((chapter) =>
      counts.set(
        chapter.directoryId,
        (counts.get(chapter.directoryId) ?? 0) + 1,
      ),
    );
    return counts;
  }, [library.chapters]);
  const allChapters = useMemo(
    () => orderedNarrativeChapters(library.chapters),
    [library.chapters],
  );
  const visibleDirectoryIds = useMemo(() => {
    if (selectedDirectory === "all" || selectedDirectory === "unassigned") {
      return null;
    }
    return includeDescendants
      ? narrativeDirectoryDescendantIds(library.directories, selectedDirectory)
      : new Set([selectedDirectory]);
  }, [includeDescendants, library.directories, selectedDirectory]);
  const visibleChapters = allChapters.filter((chapter) => {
    if (selectedDirectory === "all") return true;
    if (selectedDirectory === "unassigned") return chapter.directoryId === null;
    return chapter.directoryId
      ? visibleDirectoryIds?.has(chapter.directoryId)
      : false;
  });
  const selectedChapter =
    library.chapters.find((chapter) => chapter.id === selectedChapterId) ??
    null;

  const selectDirectory = (id: NarrativeDirectorySelection) => {
    onSelectDirectory(id);
    const allowedIds =
      id === "all"
        ? null
        : id === "unassigned"
          ? new Set<string>()
          : includeDescendants
            ? narrativeDirectoryDescendantIds(library.directories, id)
            : new Set([id]);
    const first = allChapters.find((chapter) =>
      id === "all"
        ? true
        : id === "unassigned"
          ? chapter.directoryId === null
          : chapter.directoryId
            ? allowedIds?.has(chapter.directoryId)
            : false,
    );
    onSelectChapter(first?.id ?? "");
  };

  const addChapter = () => {
    const directoryId =
      selectedDirectory === "all" || selectedDirectory === "unassigned"
        ? null
        : selectedDirectory;
    const chapter: NarrativeChapterPlan = {
      id: createId("chapter-plan"),
      directoryId,
      manuscriptChapterId: null,
      title: "未命名章节",
      description: "",
      status: "idea",
      order: nextNarrativeOrder(library.chapters),
      updatedAt: new Date().toISOString(),
      lineIds: [],
      arcIds: [],
      sections: [],
    };
    onChange({ ...library, chapters: [...library.chapters, chapter] });
    onSelectChapter(chapter.id);
  };

  return (
    <div className="ne-chapter-workspace h-full min-h-0">
      <aside className="flex min-h-0 flex-col border-r border-[var(--line)] bg-[var(--paper-elevated)]">
        <div className="shrink-0 border-b border-[var(--line)] px-3 py-3">
          <h2 className="text-sm font-semibold">卷 / 篇 / 组</h2>
          <p className="mt-0.5 text-xs text-[var(--ink-muted)]">选择章节范围</p>
        </div>
        <div className="ne-panel-scroll flex-1 p-2">
          <NarrativeDirectoryTree
            directories={library.directories}
            selectedId={selectedDirectory}
            onSelect={selectDirectory}
            chapterCounts={chapterCounts}
            showAll
            showUnassigned
          />
        </div>
      </aside>

      <aside className="flex min-h-0 flex-col border-r border-[var(--line)] bg-[var(--paper-elevated)]">
        <div className="shrink-0 border-b border-[var(--line)] px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">章节</h2>
              <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                {visibleChapters.length} 章
              </p>
            </div>
            <button
              type="button"
              className="ns-icon-button"
              title="新建章节"
              aria-label="新建章节"
              onClick={addChapter}
            >
              <FilePlus2 className="h-4 w-4" />
            </button>
          </div>
          {selectedDirectory !== "all" &&
            selectedDirectory !== "unassigned" && (
              <label className="mt-3 flex items-center gap-2 text-xs text-[var(--ink-muted)]">
                <input
                  type="checkbox"
                  checked={includeDescendants}
                  onChange={(event) =>
                    setIncludeDescendants(event.target.checked)
                  }
                  className="h-4 w-4 accent-[var(--accent-warm)]"
                />
                包含子目录
              </label>
            )}
        </div>
        <div className="ne-panel-scroll flex-1">
          {visibleChapters.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <FileText className="mx-auto h-7 w-7 text-[var(--ink-subtle)]" />
              <p className="mt-3 text-sm text-[var(--ink-muted)]">
                当前目录没有章节
              </p>
              <button
                type="button"
                className="ns-button mx-auto mt-4"
                onClick={addChapter}
              >
                <Plus className="h-3.5 w-3.5" />
                新建章节
              </button>
            </div>
          ) : (
            <div className="py-1">
              {visibleChapters.map((chapter) => {
                const ordinal =
                  allChapters.findIndex((item) => item.id === chapter.id) + 1;
                return (
                  <div
                    key={chapter.id}
                    className={`group flex min-w-0 items-center border-b border-[var(--line-subtle)] pr-2 ${
                      selectedChapterId === chapter.id
                        ? "bg-[var(--accent-warm-muted)]"
                        : "hover:bg-[var(--hover-bg)]"
                    } ${draggedChapterId === chapter.id ? "opacity-50" : ""}`}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (!draggedChapterId) return;
                      onChange({
                        ...library,
                        chapters: reorderById(
                          library.chapters,
                          draggedChapterId,
                          chapter.id,
                        ),
                      });
                      setDraggedChapterId("");
                    }}
                  >
                    <button
                      type="button"
                      draggable
                      className="flex h-10 w-7 shrink-0 cursor-grab items-center justify-center text-[var(--ink-subtle)]"
                      title="拖动章节排序"
                      aria-label={`拖动第 ${ordinal} 章排序`}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        setDraggedChapterId(chapter.id);
                      }}
                    >
                      <GripVertical className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 py-3 text-left"
                      onClick={() => onSelectChapter(chapter.id)}
                    >
                      <span className="w-7 shrink-0 text-xs font-semibold tabular-nums text-[var(--accent-warm)]">
                        {String(ordinal).padStart(2, "0")}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-[var(--ink)]">
                          {chapter.title}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-[var(--ink-muted)]">
                          {chapter.sections.length} 节
                          {chapter.manuscriptChapterId ? " · 已关联正文" : ""}
                        </span>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      <main className="min-h-0 min-w-0">
        {selectedChapter ? (
          <ChapterDetail
            chapter={selectedChapter}
            library={library}
            manuscriptChapters={manuscriptChapters}
            characters={characters}
            onChange={(nextChapter) => {
              const previousSectionIds = new Set(
                selectedChapter.sections.map((section) => section.id),
              );
              const nextSectionIds = new Set(
                nextChapter.sections.map((section) => section.id),
              );
              const removedSectionIds = new Set(
                [...previousSectionIds].filter(
                  (sectionId) => !nextSectionIds.has(sectionId),
                ),
              );
              const nextLibrary = withoutKeyNodeLocations(
                library,
                (location) =>
                  location.chapterId === nextChapter.id &&
                  Boolean(
                    location.sectionId &&
                      removedSectionIds.has(location.sectionId),
                  ),
              );
              onChange({
                ...nextLibrary,
                chapters: library.chapters.map((chapter) =>
                  chapter.id === nextChapter.id ? nextChapter : chapter,
                ),
              });
            }}
            onDelete={() => {
              const nextChapters = library.chapters.filter(
                (chapter) => chapter.id !== selectedChapter.id,
              );
              const nextLibrary = withoutKeyNodeLocations(
                library,
                (location) => location.chapterId === selectedChapter.id,
              );
              onChange({ ...nextLibrary, chapters: nextChapters });
              onSelectChapter(
                orderedNarrativeChapters(nextChapters)[0]?.id ?? "",
              );
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center">
            <div className="max-w-sm">
              <BookOpenText className="mx-auto h-8 w-8 text-[var(--ink-subtle)]" />
              <h2 className="mt-4 text-sm font-semibold">选择一个章节</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
                在右侧管理章节详情、正文关联以及章内的节和段。
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
